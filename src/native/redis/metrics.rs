//! Read-only server observations, with an explicit field allowlist and response budget.

use super::*;
use std::collections::BTreeMap;

/// One selected INFO field. Absent fields are unavailable, never implicit zeroes.
#[derive(JsObject)]
pub struct RedisMetricField {
    pub name: String,
    pub value: String,
}

/// Cumulative command statistics. Latency values are microseconds, not milliseconds.
#[derive(JsObject)]
pub struct RedisCommandMetrics {
    pub name: String,
    pub calls: String,
    pub microseconds: String,
    pub average_microseconds: Option<f64>,
    pub p99_microseconds: Option<f64>,
}

/// A replica observed by the monitored server, not an assertion about Cluster quorum.
#[derive(JsObject)]
pub struct RedisReplicaMetrics {
    pub address: String,
    pub state: String,
    pub offset: Option<String>,
    pub lag_seconds: Option<f64>,
}

/// One bounded server observation. Fields are selected by Ferrix, not arbitrary INFO output.
#[derive(JsObject)]
pub struct RedisServerMetrics {
    pub fields: Vec<RedisMetricField>,
    pub commands: Vec<RedisCommandMetrics>,
    pub replicas: Vec<RedisReplicaMetrics>,
    /// Null when SLOWLOG LEN is disabled or denied by ACL.
    pub slowlog_length: Option<String>,
    pub sampled_at_ms: String,
    /// Collection duration, including the optional SLOWLOG observation; not command execution latency.
    pub collection_ms: f64,
    /// "node" in Cluster mode, "server" otherwise. These observations are never Cluster totals.
    pub scope: String,
    /// The observed Cluster node's address; null for direct/Sentinel transports. Its INFO role can change.
    pub node_address: Option<String>,
    pub database: u32,
    pub generation: String,
}

const FIELDS: &[&str] = &[
    "redis_version",
    "redis_mode",
    "run_id",
    "tcp_port",
    "uptime_in_seconds",
    "connected_clients",
    "maxclients",
    "blocked_clients",
    "tracking_clients",
    "used_memory",
    "used_memory_rss",
    "used_memory_peak",
    "used_memory_dataset",
    "used_memory_overhead",
    "used_memory_lua",
    "maxmemory",
    "maxmemory_policy",
    "mem_fragmentation_ratio",
    "mem_replication_backlog",
    "mem_clients_normal",
    "mem_clients_slaves",
    "mem_total_replication_buffers",
    "used_memory_scripts",
    "instantaneous_ops_per_sec",
    "instantaneous_input_kbps",
    "instantaneous_output_kbps",
    "used_cpu_sys",
    "used_cpu_user",
    "total_commands_processed",
    "keyspace_hits",
    "keyspace_misses",
    "expired_keys",
    "evicted_keys",
    "rdb_last_bgsave_status",
    "rdb_last_save_time",
    "rdb_bgsave_in_progress",
    "rdb_changes_since_last_save",
    "rdb_last_cow_size",
    "loading",
    "aof_enabled",
    "aof_last_write_status",
    "aof_rewrite_in_progress",
    "aof_buffer_length",
    "aof_pending_bio_fsync",
    "aof_delayed_fsync",
    "role",
    "connected_slaves",
    "master_repl_offset",
    "slave_repl_offset",
    "master_host",
    "master_port",
    "master_link_status",
    "master_last_io_seconds_ago",
    "master_sync_in_progress",
];

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
) -> Result<RedisServerMetrics, JsError> {
    let start = std::time::Instant::now();
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        match observe(state, connection.as_mut().unwrap()).await {
            Ok(mut result) => {
                result.collection_ms = start.elapsed().as_secs_f64() * 1000.0;
                return Ok(result);
            }
            Err(cause) => {
                let recoverable = cause.recoverable();
                if recoverable {
                    discard_transports(connection);
                }
                if !recoverable || attempt == 1 {
                    return Err(cause.into_js());
                }
            }
        }
    }
    unreachable!()
}

async fn observe(
    state: &SessionState,
    connection: &mut Connection,
) -> Result<RedisServerMetrics, RequestError> {
    // A single section argument works with Redis 6 as well as newer releases.
    let raw = connection
        .query::<String>(state, None, redis::cmd("INFO").arg("all"), None)
        .await?;
    let sampled_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let budget = state.options.max_response_bytes.unwrap_or(262_144) as usize;
    strings::check_payload(raw.len(), budget)?;
    let generation = connection.generation();
    let mut result = parse(&raw)?;
    result.slowlog_length = match connection
        .query::<u64>(state, None, redis::cmd("SLOWLOG").arg("LEN"), None)
        .await
    {
        Ok(count) => Some(count.to_string()),
        Err(cause) if matches!(cause.code(), Some("NOPERM" | "ERR")) => None,
        Err(cause) => return Err(cause),
    };
    if generation != connection.generation() {
        return Err(context_changed().into());
    }
    result.sampled_at_ms = sampled_at_ms;
    result.scope = if state.cluster_options.is_some() {
        "node"
    } else {
        "server"
    }
    .into();
    result.node_address = match connection {
        Connection::Cluster(cluster) => Some(cluster.metrics_address()),
        Connection::Standalone(..) => None,
    };
    result.database = state.database();
    result.generation = generation.to_string();
    Ok(result)
}

fn fields(raw: &str) -> BTreeMap<&str, &str> {
    raw.split(',')
        .filter_map(|field| field.split_once('='))
        .collect()
}

fn number(value: Option<&&str>) -> Option<f64> {
    value?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn counter(value: Option<&&str>) -> Option<String> {
    Some(value?.parse::<u64>().ok()?.to_string())
}

fn parse(raw: &str) -> Result<RedisServerMetrics, JsError> {
    let info: BTreeMap<_, _> = raw
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') {
                None
            } else {
                line.split_once(':')
            }
        })
        .collect();
    let mut commands = Vec::new();
    let mut replicas = Vec::new();
    for (&name, &value) in &info {
        if let Some(command) = name.strip_prefix("cmdstat_") {
            let data = fields(value);
            if let (Some(calls), Some(microseconds)) =
                (counter(data.get("calls")), counter(data.get("usec")))
            {
                let latency = format!("latency_percentiles_usec_{command}");
                let percentiles = fields(info.get(latency.as_str()).copied().unwrap_or(""));
                commands.push(RedisCommandMetrics {
                    name: command.to_uppercase(),
                    calls,
                    microseconds,
                    average_microseconds: number(data.get("usec_per_call")),
                    p99_microseconds: number(
                        percentiles.get("p99").or_else(|| percentiles.get("p99.0")),
                    ),
                });
            }
        } else if name.strip_prefix("slave").is_some_and(|index| {
            !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            let data = fields(value);
            if let (Some(host), Some(port)) = (data.get("ip"), data.get("port")) {
                let host = if host.contains(':') {
                    format!("[{host}]")
                } else {
                    host.to_string()
                };
                replicas.push(RedisReplicaMetrics {
                    address: format!("{host}:{port}"),
                    state: data.get("state").copied().unwrap_or("unknown").into(),
                    offset: counter(data.get("offset")),
                    lag_seconds: number(data.get("lag")),
                });
            }
        }
    }
    if commands.len() > 512 || replicas.len() > 128 {
        return Err(error(
            "RESPONSE_TOO_LARGE",
            "Server metrics exceed the bounded item limit",
        ));
    }
    Ok(RedisServerMetrics {
        fields: FIELDS
            .iter()
            .filter_map(|name| {
                info.get(name).map(|value| RedisMetricField {
                    name: (*name).into(),
                    value: (*value).into(),
                })
            })
            .collect(),
        commands,
        replicas,
        slowlog_length: None,
        sampled_at_ms: String::new(),
        collection_ms: 0.0,
        scope: "server".into(),
        node_address: None,
        database: 0,
        generation: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_exact_counters_optional_percentiles_and_replica_addresses() {
        let result = parse("# Memory\r\nused_memory:1729\r\nsecret:never-export\r\ncmdstat_get:calls=9007199254740993,usec=18446744073709551615,usec_per_call=1.2\r\ncmdstat_set:calls=1,usec=3,usec_per_call=NaN\r\nlatency_percentiles_usec_get:p50=0.7,p99=2.5,p999=4\r\nslave0:ip=::1,port=6380,state=online,offset=9007199254740993,lag=0\r\n").unwrap();
        assert_eq!(result.fields.len(), 1);
        assert_eq!(result.commands[0].calls, "9007199254740993");
        assert_eq!(result.commands[0].microseconds, "18446744073709551615");
        assert_eq!(result.commands[0].p99_microseconds, Some(2.5));
        assert_eq!(result.commands[1].p99_microseconds, None);
        assert_eq!(result.commands[1].average_microseconds, None);
        assert_eq!(result.replicas[0].address, "[::1]:6380");
        assert_eq!(
            result.replicas[0].offset.as_deref(),
            Some("9007199254740993")
        );
    }
}
