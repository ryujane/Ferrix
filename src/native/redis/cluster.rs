//! Explicit primary routing over direct, non-replaying connections.
//! The Session worker is the sole owner, including exclusive ASKING exchanges.
use super::*;

const MAX_NODES: usize = 256;
const MAX_REDIRECTS: usize = 4;

/// A DNS name or IP address and TCP port, without URL syntax or credentials.
#[derive(Clone, PartialEq, Eq, JsObject)]
pub struct RedisEndpoint {
    pub host: String,
    pub port: u32,
}

/// Seed discovery and common security settings for all Cluster primaries and redirects.
#[derive(Clone, JsObject)]
pub struct ClusterOptions {
    /// Between one and 32 seed endpoints. Later seeds can recover a failed seed.
    pub seeds: Vec<RedisEndpoint>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub tls: Option<RedisTlsOptions>,
    /// Pinned SSH gateway for seeds, discovered nodes and redirects.
    pub ssh: Option<RedisSshOptions>,
    /// Network proxy for seeds, discovered nodes, redirects or the SSH gateway.
    pub proxy: Option<RedisProxyOptions>,
    /// Omit or use zero. Redis Cluster does not support other databases.
    pub database: Option<u32>,
    pub connect_timeout_ms: Option<u32>,
    pub operation_timeout_ms: Option<u32>,
    pub max_response_bytes: Option<u32>,
}
impl ClusterOptions {
    pub(super) fn validate(&self) -> Result<StandaloneOptions, JsError> {
        if self.database.unwrap_or(0) != 0 {
            return Err(error(
                "CLUSTER_DATABASE_UNSUPPORTED",
                "Redis Cluster supports only database zero",
            ));
        }
        if self.seeds.is_empty() || self.seeds.len() > 32 {
            return Err(error(
                "INVALID_CONFIGURATION",
                "Supply between one and 32 Cluster seeds",
            ));
        }
        let common = StandaloneOptions {
            host: self.seeds[0].host.clone(),
            port: self.seeds[0].port,
            username: self.username.clone(),
            password: self.password.clone(),
            tls: self.tls.clone(),
            ssh: self.ssh.clone(),
            proxy: self.proxy.clone(),
            database: Some(0),
            connect_timeout_ms: self.connect_timeout_ms,
            operation_timeout_ms: self.operation_timeout_ms,
            max_response_bytes: self.max_response_bytes,
        };
        for endpoint in &self.seeds {
            at_endpoint(&common, endpoint).validate()?;
        }
        Ok(common)
    }
}

struct Node {
    id: Option<String>,
    endpoint: RedisEndpoint,
    connection: Option<Transport>,
    connected_before: bool,
}
pub(super) struct ClusterConnection {
    nodes: Vec<Node>,
    slots: Vec<usize>,
    migrations: Vec<String>,
    observation: Option<Observation>,
    pub(super) generation: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Primary {
    pub(super) id: String,
    pub(super) endpoint: RedisEndpoint,
}

/// Canonical observed identity, independent of response ordering/range splitting.
#[derive(PartialEq, Eq)]
pub(super) struct ScanTopology {
    pub(super) primaries: Vec<Primary>,
    owners: Vec<usize>,
    migrations: Vec<String>,
}

#[derive(Clone)]
pub(super) struct Observation {
    pub(super) topology: Arc<ScanTopology>,
    observed: tokio::time::Instant,
    pub(super) epoch: u64,
}

pub(super) async fn connect(
    common: &StandaloneOptions,
    options: &ClusterOptions,
) -> Result<ClusterConnection, JsError> {
    tokio::time::timeout(
        Duration::from_millis(common.connect_timeout_ms.unwrap_or(3000).into()),
        async { discover(common, options.seeds.clone()).await },
    )
    .await
    .map_err(|_| error("TIMEOUT", "Cluster setup exceeded its deadline"))?
}

async fn discover(
    common: &StandaloneOptions,
    endpoints: Vec<RedisEndpoint>,
) -> Result<ClusterConnection, JsError> {
    let mut last = error("CONNECTION_FAILED", "No Cluster seed is reachable");
    let count = endpoints.len().max(1) as u32;
    for endpoint in endpoints {
        let mut options = at_endpoint(common, &endpoint);
        options.connect_timeout_ms =
            Some((common.connect_timeout_ms.unwrap_or(3000) / count).max(10));
        let attempt = async {
            let mut connection = super::connect(&options).await?;
            let response: redis::Value = redis::cmd("CLUSTER")
                .arg("SLOTS")
                .query_async(&mut connection)
                .await
                .map_err(classify)?;
            let mut topology = parse_slots(response, &endpoint)?;
            let nodes: String = redis::cmd("CLUSTER")
                .arg("NODES")
                .query_async(&mut connection)
                .await
                .map_err(classify)?;
            topology.include_primaries(&nodes, &endpoint)?;
            topology.observation = Some(Observation {
                topology: topology.scan_topology()?,
                observed: tokio::time::Instant::now(),
                epoch: 1,
            });
            if let Some(node) = topology
                .nodes
                .iter_mut()
                .find(|node| node.endpoint == endpoint)
            {
                node.connection = Some(connection);
                node.connected_before = true;
            }
            Ok(topology)
        };
        match tokio::time::timeout(
            Duration::from_millis(options.connect_timeout_ms.unwrap().into()),
            attempt,
        )
        .await
        {
            Ok(Ok(connection)) => return Ok(connection),
            // All nodes share this gateway identity and authentication. Trying
            // another seed cannot repair its rejection and could hide it behind a timeout.
            Ok(Err(cause))
                if ssh::is_security_error(&cause) || proxy::is_terminal_error(&cause) =>
            {
                return Err(cause);
            }
            Ok(Err(cause)) => last = cause,
            Err(_) => last = error("TIMEOUT", "Cluster seed setup exceeded its deadline"),
        }
    }
    Err(last)
}

impl ClusterConnection {
    pub(super) fn console_endpoint(&self) -> RedisEndpoint {
        self.nodes[0].endpoint.clone()
    }
    pub(super) fn metrics_address(&self) -> String {
        let endpoint = &self.nodes[0].endpoint;
        let host = if endpoint.host.contains(':') {
            format!("[{}]", endpoint.host)
        } else {
            endpoint.host.clone()
        };
        format!("{host}:{}", endpoint.port)
    }

    pub(super) fn observation(&self) -> Observation {
        self.observation.as_ref().unwrap().clone()
    }

    pub(super) fn set_observation_epoch(&mut self, epoch: u64) {
        self.observation.as_mut().unwrap().epoch = epoch;
    }

    /// One shared refresh at a time, at most once per second in an unchanged epoch.
    /// Recovery and definite routing events require a new observation sooner.
    pub(super) async fn refresh_scan_topology(
        &mut self,
        state: &SessionState,
    ) -> Result<(), JsError> {
        let _refresh = state.cluster_refresh.lock().await;
        let own = self.observation();
        let cached = state
            .cluster_observation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        if own.observed > cached.observed && own.epoch == state.generation.load(Ordering::Acquire) {
            publish_observation(state, own);
        }
        let cached = state
            .cluster_observation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let epoch = state.generation.load(Ordering::Acquire);
        if cached.epoch == epoch
            && cached.observed.elapsed() < Duration::from_secs(1)
            && !state.cluster_refresh_due.swap(false, Ordering::AcqRel)
        {
            return Ok(());
        }
        state.cluster_refresh_due.store(false, Ordering::Release);
        let mut candidates = self.endpoints();
        for seed in &state.cluster_options.as_ref().unwrap().seeds {
            if !candidates.contains(seed) {
                candidates.push(seed.clone());
            }
        }
        let mut fresh = match discover(&state.options, candidates).await {
            Ok(fresh) => fresh,
            Err(_) => {
                self.generation = state.advance_generation();
                return Err(error(
                    "CURSOR_INVALIDATED",
                    "Cluster scan topology could not be verified",
                ));
            }
        };
        fresh.set_observation_epoch(epoch);
        publish_observation(state, fresh.observation());
        // Identical observations do not replace a cursor's actual transport.
        for node in &mut fresh.nodes {
            if let Some(old) = self
                .nodes
                .iter_mut()
                .find(|old| old.id == node.id && old.endpoint == node.endpoint)
            {
                if old.connected_before {
                    node.connection = old.connection.take();
                }
                node.connected_before |= old.connected_before;
            }
        }
        fresh.generation = state.generation.load(Ordering::Acquire);
        *self = fresh;
        Ok(())
    }

    pub(super) fn scan_topology(&self) -> Result<Arc<ScanTopology>, JsError> {
        let mut primaries = self
            .nodes
            .iter()
            .filter_map(|node| {
                node.id.as_ref().map(|id| Primary {
                    id: id.clone(),
                    endpoint: node.endpoint.clone(),
                })
            })
            .collect::<Vec<_>>();
        primaries.sort_by(|a, b| a.id.cmp(&b.id));
        if primaries.windows(2).any(|pair| pair[0].id == pair[1].id) {
            return Err(topology_error());
        }
        let owners = self
            .slots
            .iter()
            .map(|&index| {
                let id = self.nodes[index].id.as_ref().ok_or_else(topology_error)?;
                primaries
                    .iter()
                    .position(|primary| &primary.id == id)
                    .ok_or_else(topology_error)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut migrations = self.migrations.clone();
        migrations.sort();
        Ok(Arc::new(ScanTopology {
            primaries,
            owners,
            migrations,
        }))
    }

    fn include_primaries(&mut self, text: &str, origin: &RedisEndpoint) -> Result<(), JsError> {
        if text.len() > 4 * 1024 * 1024 || text.lines().count() > MAX_NODES {
            return Err(topology_error());
        }
        for line in text.lines() {
            let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
            if fields.len() < 8 {
                return Err(topology_error());
            }
            let flags = fields[2].split(',').collect::<Vec<_>>();
            if !flags.contains(&"master")
                || flags
                    .iter()
                    .any(|flag| matches!(*flag, "fail" | "fail?" | "handshake" | "noaddr"))
            {
                continue;
            }
            validate_id(fields[0])?;
            let address = fields[1].split('@').next().ok_or_else(topology_error)?;
            let endpoint = parse_endpoint(address, &origin.host)?;
            let index = self.node_index(endpoint)?;
            if self.nodes[index]
                .id
                .as_deref()
                .is_some_and(|id| id != fields[0])
            {
                return Err(topology_error());
            }
            self.nodes[index].id = Some(fields[0].into());
            for marker in fields[8..].iter().filter(|field| field.starts_with('[')) {
                if marker.len() > 128 || self.migrations.len() == 32768 {
                    return Err(topology_error());
                }
                self.migrations.push(format!("{}:{marker}", fields[0]));
            }
        }
        Ok(())
    }

    /// Private one-attempt node SCAN. Never route a cursor by a random node or retry it.
    pub(super) async fn scan_primary(
        &mut self,
        state: &SessionState,
        primary: &Primary,
        command: &redis::Cmd,
    ) -> Result<(u64, Vec<Vec<u8>>), JsError> {
        let index = self.node_index(primary.endpoint.clone())?;
        if self.nodes[index].connection.is_none() {
            let connection =
                super::connect(&at_endpoint(&state.options, &primary.endpoint)).await?;
            if self.nodes[index].connected_before {
                self.generation = state.advance_generation();
                return Err(error(
                    "CURSOR_INVALIDATED",
                    "Cluster scan transport was replaced",
                ));
            }
            self.nodes[index].connection = Some(connection);
            self.nodes[index].connected_before = true;
        }
        match command
            .query_async(self.nodes[index].connection.as_mut().unwrap())
            .await
        {
            Ok(reply) => Ok(reply),
            Err(cause)
                if cause.is_io_error()
                    || cause.is_timeout()
                    || matches!(
                        cause.code(),
                        Some(
                            "MOVED"
                                | "ASK"
                                | "READONLY"
                                | "CLUSTERDOWN"
                                | "MASTERDOWN"
                                | "TRYAGAIN"
                        )
                    ) =>
            {
                self.nodes[index].connection = None;
                self.generation = state.advance_generation();
                Err(error(
                    "CURSOR_INVALIDATED",
                    "Cluster scan transport or topology changed",
                ))
            }
            Err(cause) => Err(classify(cause)),
        }
    }

    /// Sum DBSIZE on each discovered primary, including primaries without slots.
    pub(super) async fn database_key_count(
        &mut self,
        state: &SessionState,
    ) -> Result<u64, RequestError> {
        self.refresh_scan_topology(state).await?;
        let topology = self.scan_topology()?;
        let mut total = 0u64;
        for primary in &topology.primaries {
            let index = self.node_index(primary.endpoint.clone())?;
            if self.nodes[index].connection.is_none() {
                let connection =
                    super::connect(&at_endpoint(&state.options, &primary.endpoint)).await?;
                if self.nodes[index].connected_before {
                    self.generation = state.advance_generation();
                }
                self.nodes[index].connection = Some(connection);
                self.nodes[index].connected_before = true;
            }
            let count: u64 = redis::cmd("DBSIZE")
                .query_async(self.nodes[index].connection.as_mut().unwrap())
                .await?;
            total = total
                .checked_add(count)
                .ok_or_else(|| error("RESPONSE_TOO_LARGE", "Cluster Key count overflowed"))?;
        }
        Ok(total)
    }

    pub(super) fn endpoints(&self) -> Vec<RedisEndpoint> {
        self.nodes
            .iter()
            .map(|node| node.endpoint.clone())
            .collect()
    }

    /// Nontransactional read-only metadata, grouped by observed primary and
    /// capped at 64 commands per wire pipeline. Never use this for mutations or
    /// generation-bound cursor commands.
    pub(super) async fn query_readonly_fields(
        &mut self,
        state: &SessionState,
        pipeline: &redis::Pipeline,
        routes: &[&[u8]],
    ) -> Result<Vec<redis::RedisResult<redis::Value>>, RequestError> {
        let commands = pipeline.cmd_iter().collect::<Vec<_>>();
        let mut remaining = (0..commands.len()).collect::<Vec<_>>();
        let mut values = vec![None; commands.len()];
        while let Some(&first) = remaining.first() {
            let node = self.slots[slot_for_key(routes[first]) as usize];
            let indices = remaining
                .iter()
                .copied()
                .filter(|&index| self.slots[slot_for_key(routes[index]) as usize] == node)
                .take(64)
                .collect::<Vec<_>>();
            let endpoint = self.nodes[node].endpoint.clone();
            if self.nodes[node].connection.is_none() {
                match super::connect(&at_endpoint(&state.options, &endpoint)).await {
                    Ok(connection) => {
                        if self.nodes[node].connected_before {
                            self.generation = state.advance_generation();
                        }
                        self.nodes[node].connection = Some(connection);
                        self.nodes[node].connected_before = true;
                    }
                    Err(cause) if matches!(cause.code(), Some("CONNECTION_FAILED" | "TIMEOUT")) => {
                    }
                    Err(cause) => return Err(cause.into()),
                }
            }
            let mut group = redis::pipe();
            group.ignore_errors();
            for &index in &indices {
                group.add_command(commands[index].clone());
            }
            let replies: Option<Vec<redis::RedisResult<redis::Value>>> =
                if let Some(connection) = self.nodes[node].connection.as_mut() {
                    match group.query_async(connection).await {
                        Ok(values) => Some(values),
                        Err(cause) if cause.is_io_error() || cause.is_timeout() => {
                            self.nodes[node].connection = None;
                            None
                        }
                        Err(cause) => return Err(cause.into()),
                    }
                } else {
                    None
                };
            for (position, &index) in indices.iter().enumerate() {
                let reply = replies.as_ref().map(|values| values[position].clone());
                let route_again = reply.as_ref().is_none_or(|reply| {
                    reply.as_ref().is_err_and(|cause| {
                        redirect(cause).is_some()
                            || matches!(
                                cause.code(),
                                Some("READONLY" | "CLUSTERDOWN" | "MASTERDOWN" | "TRYAGAIN")
                            )
                    })
                });
                let reply = if route_again {
                    // A retained MOVED/ASK is routing information, never a
                    // nullable field. ASKING remains exclusive per command.
                    // Lost read-only replies may use the existing one-recovery
                    // adapter; metadata::read then restarts the entire batch
                    // once if that recovery changes the Session generation.
                    match self
                        .query(
                            state,
                            Some(routes[index]),
                            Command::Single(commands[index]),
                            None,
                            true,
                        )
                        .await
                    {
                        Ok(value) => Ok(value),
                        Err(RequestError::Redis(cause))
                            if !cause.is_io_error() && !cause.is_timeout() =>
                        {
                            Err(cause)
                        }
                        Err(cause) => return Err(cause),
                    }
                } else {
                    reply.unwrap()
                };
                values[index] = Some(reply);
            }
            remaining.retain(|index| !indices.contains(index));
        }
        Ok(values.into_iter().map(Option::unwrap).collect())
    }

    pub(super) async fn query<T: redis::FromRedisValue>(
        &mut self,
        state: &SessionState,
        key: Option<&[u8]>,
        command: Command<'_>,
        dispatched: Option<&AtomicBool>,
        recover_read: bool,
    ) -> Result<T, RequestError> {
        let generation = state.generation.load(Ordering::Acquire);
        let slot = key.map(slot_for_key);
        let mut target = self.nodes[slot.map_or(0, |slot| self.slots[slot as usize])]
            .endpoint
            .clone();
        let mut asking = false;
        let mut redirects = 0;
        let mut recovered = false;
        loop {
            // ASK must never share a connection with another request. No clones escape this worker.
            let result = if asking {
                let mut exclusive = super::connect(&at_endpoint(&state.options, &target)).await?;
                redis::cmd("ASKING")
                    .query_async::<()>(&mut exclusive)
                    .await?;
                if let Some(dispatched) = dispatched {
                    dispatched.store(true, Ordering::Release);
                }
                command.query(&mut exclusive).await
            } else {
                let index = self.node_index(target.clone())?;
                if self.nodes[index].connection.is_none() {
                    match super::connect(&at_endpoint(&state.options, &target)).await {
                        Ok(connection) => {
                            if self.nodes[index].connected_before {
                                self.generation = state.advance_generation();
                            }
                            self.nodes[index].connection = Some(connection);
                            self.nodes[index].connected_before = true;
                        }
                        Err(cause)
                            if dispatched.is_none()
                                && recover_read
                                && !recovered
                                && matches!(
                                    cause.code(),
                                    Some("CONNECTION_FAILED" | "TIMEOUT")
                                ) =>
                        {
                            recovered = true;
                            self.refresh(state, &target).await?;
                            target = self.nodes[slot.map_or(0, |slot| self.slots[slot as usize])]
                                .endpoint
                                .clone();
                            continue;
                        }
                        Err(cause) => return Err(cause.into()),
                    }
                }
                if !recover_read && state.generation.load(Ordering::Acquire) != generation {
                    return Err(error(
                        "CURSOR_INVALIDATED",
                        "Redis continuation connection was replaced",
                    )
                    .into());
                }
                if let Some(dispatched) = dispatched {
                    dispatched.store(true, Ordering::Release);
                }
                command
                    .query(self.nodes[index].connection.as_mut().unwrap())
                    .await
            };
            match result {
                Ok(value) => return Ok(value),
                Err(cause) => {
                    let transport = cause.is_io_error() || cause.is_timeout();
                    if !transport {
                        if let Some(dispatched) = dispatched {
                            dispatched.store(false, Ordering::Release);
                        }
                    }
                    if let Some((is_ask, redirect_slot, address)) = redirect(&cause) {
                        state.cluster_refresh_due.store(true, Ordering::Release);
                        if is_ask {
                            state.continuations.invalidate();
                        }
                        if redirects == MAX_REDIRECTS || Some(redirect_slot) != slot {
                            return Err(error(
                                "CLUSTER_ROUTING_FAILED",
                                "Cluster redirection budget or slot validation failed",
                            )
                            .into());
                        }
                        redirects += 1;
                        target = parse_endpoint(&address, &target.host)?;
                        asking = is_ask;
                        if !is_ask {
                            let index = self.node_index(target.clone())?;
                            if self.slots[redirect_slot as usize] != index {
                                self.slots[redirect_slot as usize] = index;
                                self.generation = state.advance_generation();
                            }
                        }
                        if !recover_read {
                            if state.generation.load(Ordering::Acquire) == generation {
                                self.generation = state.advance_generation();
                            }
                            return Err(error(
                                "CURSOR_INVALIDATED",
                                "Redis continuation routing changed",
                            )
                            .into());
                        }
                        continue;
                    }
                    if transport {
                        if let Some(node) =
                            self.nodes.iter_mut().find(|node| node.endpoint == target)
                        {
                            node.connection = None;
                        }
                        // A submitted mutation is settled by the caller as unknown, never retried.
                        if dispatched.is_some() || !recover_read {
                            return Err(cause.into());
                        }
                    }
                    let stale = transport
                        || matches!(
                            cause.code(),
                            Some("READONLY" | "CLUSTERDOWN" | "MASTERDOWN" | "TRYAGAIN")
                        );
                    if stale && !recover_read {
                        self.generation = state.advance_generation();
                        return Err(error(
                            "CURSOR_INVALIDATED",
                            "Redis continuation routing became unavailable",
                        )
                        .into());
                    }
                    if stale && !recovered {
                        recovered = true;
                        self.refresh(state, &target).await?;
                        target = self.nodes[slot.map_or(0, |slot| self.slots[slot as usize])]
                            .endpoint
                            .clone();
                        asking = false;
                        continue;
                    }
                    // Cluster owns its one read recovery; prevent the Standalone adapter retrying again.
                    return Err(if transport {
                        RequestError::Native(classify(cause))
                    } else {
                        RequestError::Redis(cause)
                    });
                }
            }
        }
    }

    async fn refresh(
        &mut self,
        state: &SessionState,
        failed: &RedisEndpoint,
    ) -> Result<(), JsError> {
        let mut candidates = self
            .nodes
            .iter()
            .filter(|node| &node.endpoint != failed)
            .map(|node| node.endpoint.clone())
            .collect::<Vec<_>>();
        for seed in &state.cluster_options.as_ref().unwrap().seeds {
            if !candidates.contains(seed) {
                candidates.push(seed.clone());
            }
        }
        *self = discover(&state.options, candidates).await?;
        self.generation = state.advance_generation();
        self.set_observation_epoch(self.generation);
        publish_observation(state, self.observation());
        self.generation = state.generation.load(Ordering::Acquire);
        Ok(())
    }

    pub(super) fn discard_transports(&mut self) {
        for node in &mut self.nodes {
            node.connection = None;
        }
    }

    fn node_index(&mut self, endpoint: RedisEndpoint) -> Result<usize, JsError> {
        if let Some(index) = self.nodes.iter().position(|node| node.endpoint == endpoint) {
            return Ok(index);
        }
        if self.nodes.len() == MAX_NODES {
            return Err(topology_error());
        }
        self.nodes.push(Node {
            id: None,
            endpoint,
            connection: None,
            connected_before: false,
        });
        Ok(self.nodes.len() - 1)
    }
}

fn publish_observation(state: &SessionState, mut observation: Observation) {
    let changed = state
        .cluster_observation
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|previous| {
            previous.epoch == observation.epoch && previous.topology != observation.topology
        });
    if changed {
        observation.epoch = state.advance_generation();
    }
    *state.cluster_observation.lock().unwrap() = Some(observation);
}

fn at_endpoint(common: &StandaloneOptions, endpoint: &RedisEndpoint) -> StandaloneOptions {
    StandaloneOptions {
        host: endpoint.host.clone(),
        port: endpoint.port,
        ..common.clone()
    }
}
fn topology_error() -> JsError {
    error(
        "CLUSTER_TOPOLOGY_INVALID",
        "Cluster returned an unsupported or incomplete topology",
    )
}

fn parse_slots(
    response: redis::Value,
    origin: &RedisEndpoint,
) -> Result<ClusterConnection, JsError> {
    let redis::Value::Array(ranges) = response else {
        return Err(topology_error());
    };
    if ranges.len() > 16384 {
        return Err(topology_error());
    }
    let mut result = ClusterConnection {
        nodes: Vec::new(),
        slots: vec![usize::MAX; 16384],
        migrations: Vec::new(),
        observation: None,
        generation: 1,
    };
    for range in ranges {
        let redis::Value::Array(values) = range else {
            return Err(topology_error());
        };
        if values.len() < 3 {
            return Err(topology_error());
        }
        let start: u16 =
            redis::from_redis_value(values[0].clone()).map_err(|_| topology_error())?;
        let end: u16 = redis::from_redis_value(values[1].clone()).map_err(|_| topology_error())?;
        if start > end || end >= 16384 {
            return Err(topology_error());
        }
        let redis::Value::Array(master) = &values[2] else {
            return Err(topology_error());
        };
        if master.len() < 3 {
            return Err(topology_error());
        }
        let host: Option<String> =
            redis::from_redis_value(master[0].clone()).map_err(|_| topology_error())?;
        let port: u16 = redis::from_redis_value(master[1].clone()).map_err(|_| topology_error())?;
        let endpoint = RedisEndpoint {
            host: host
                .filter(|host| !host.is_empty())
                .unwrap_or_else(|| origin.host.clone()),
            port: port.into(),
        };
        validate_endpoint(&endpoint)?;
        let index = result.node_index(endpoint)?;
        let id: String =
            redis::from_redis_value(master[2].clone()).map_err(|_| topology_error())?;
        validate_id(&id)?;
        if result.nodes[index]
            .id
            .as_ref()
            .is_some_and(|known| known != &id)
        {
            return Err(topology_error());
        }
        result.nodes[index].id = Some(id);
        for slot in &mut result.slots[start as usize..=end as usize] {
            if *slot != usize::MAX {
                return Err(topology_error());
            }
            *slot = index;
        }
    }
    if result.slots.contains(&usize::MAX) {
        return Err(topology_error());
    }
    Ok(result)
}

fn validate_id(id: &str) -> Result<(), JsError> {
    if id.len() != 40 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(topology_error());
    }
    Ok(())
}

fn validate_endpoint(endpoint: &RedisEndpoint) -> Result<(), JsError> {
    if endpoint.host.is_empty()
        || endpoint
            .host
            .chars()
            .any(|c| c.is_whitespace() || "/@?#\0".contains(c))
        || !(1..=65535).contains(&endpoint.port)
    {
        return Err(topology_error());
    }
    Ok(())
}
pub(super) fn parse_endpoint(address: &str, origin_host: &str) -> Result<RedisEndpoint, JsError> {
    let (host, port) = address.rsplit_once(':').ok_or_else(topology_error)?;
    let endpoint = RedisEndpoint {
        host: if host.is_empty() {
            origin_host
        } else {
            host.trim_start_matches('[').trim_end_matches(']')
        }
        .into(),
        port: port.parse().map_err(|_| topology_error())?,
    };
    validate_endpoint(&endpoint)?;
    Ok(endpoint)
}
fn redirect(cause: &redis::RedisError) -> Option<(bool, u16, String)> {
    if let Some((address, slot)) = cause.redirect_node() {
        return Some((cause.code() == Some("ASK"), slot, address.into()));
    }
    // MULTI/EXEC can report redirects on queued commands followed by EXECABORT.
    cause
        .clone()
        .into_server_errors()?
        .into_iter()
        .find_map(|(_, cause)| {
            if !matches!(cause.code(), "MOVED" | "ASK") {
                return None;
            }
            let mut parts = cause.details()?.split_ascii_whitespace();
            Some((
                cause.code() == "ASK",
                parts.next()?.parse().ok()?,
                parts.next()?.into(),
            ))
        })
}

pub(super) fn slot_for_key(key: &[u8]) -> u16 {
    let hashed = key
        .iter()
        .position(|byte| *byte == b'{')
        .and_then(|start| {
            let rest = &key[start + 1..];
            rest.iter()
                .position(|byte| *byte == b'}')
                .filter(|end| *end > 0)
                .map(|end| &rest[..end])
        })
        .unwrap_or(key);
    let mut crc = 0u16;
    for byte in hashed {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc & 0x3fff
}
