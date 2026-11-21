//! Owned progressive Key Scan state; Redis work stays on the Session worker.

use super::*;
use std::sync::{Mutex, Weak};

/// Collection scans can register the same lifecycle without a separate cursor store.
pub(super) trait ContinuationControl: Send + Sync {
    fn invalidate(&self);
    fn active(&self) -> bool;
    fn validate(&self) -> Result<(), JsError>;
    fn cancellation(&self) -> watch::Receiver<bool>;
}

/// One Session-wide continuation quota, shared by Key, Hash and Set scans.
pub(super) struct ContinuationPool {
    slots: Arc<Semaphore>,
    retention: Arc<Mutex<RetentionUsage>>,
    active: Mutex<Vec<Weak<dyn ContinuationControl>>>,
}

/// One shared registration across every Session and continuation kind.
pub(super) struct ContinuationSlot {
    _session: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

#[derive(Default)]
struct RetentionUsage {
    items: usize,
    bytes: usize,
}

/// A conservative charge for a complete Redis reply, shared across continuations.
pub(super) struct RetainedBatch {
    usage: Arc<Mutex<RetentionUsage>>,
    global: Arc<Mutex<RetentionUsage>>,
    items: usize,
    bytes: usize,
}

impl Drop for RetainedBatch {
    fn drop(&mut self) {
        let mut usage = self.usage.lock().unwrap();
        usage.items -= self.items;
        usage.bytes -= self.bytes;
        let mut global = self.global.lock().unwrap();
        global.items -= self.items;
        global.bytes -= self.bytes;
    }
}

impl ContinuationPool {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(16)),
            retention: Arc::new(Mutex::new(RetentionUsage::default())),
            active: Mutex::new(Vec::new()),
        }
    }

    pub(super) fn acquire(&self) -> Result<ContinuationSlot, JsError> {
        static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let global = GLOBAL
            .get_or_init(|| Arc::new(Semaphore::new(64)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Global continuation capacity is exhausted"))?;
        let session = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Session continuation capacity is exhausted"))?;
        Ok(ContinuationSlot {
            _session: session,
            _global: global,
        })
    }

    pub(super) fn retain(&self, items: usize, bytes: usize) -> Result<RetainedBatch, JsError> {
        static GLOBAL: OnceLock<Arc<Mutex<RetentionUsage>>> = OnceLock::new();
        let global = GLOBAL.get_or_init(|| Arc::new(Mutex::new(RetentionUsage::default())));
        let mut usage = self.retention.lock().unwrap();
        let mut total = global.lock().unwrap();
        if items > 16384 - usage.items || bytes > 4 * 1024 * 1024 - usage.bytes {
            return Err(error(
                "RETENTION_LIMIT",
                "Session scan reply retention capacity is exhausted",
            ));
        }
        if items > 65536 - total.items || bytes > 16 * 1024 * 1024 - total.bytes {
            return Err(error(
                "RETENTION_LIMIT",
                "Global scan reply retention capacity is exhausted",
            ));
        }
        usage.items += items;
        usage.bytes += bytes;
        total.items += items;
        total.bytes += bytes;
        Ok(RetainedBatch {
            usage: self.retention.clone(),
            global: global.clone(),
            items,
            bytes,
        })
    }

    pub(super) fn register(&self, state: Arc<dyn ContinuationControl>) {
        let mut active = self.active.lock().unwrap();
        active.retain(|entry| entry.upgrade().is_some_and(|state| state.active()));
        active.push(Arc::downgrade(&state));
    }

    pub(super) fn invalidate(&self) {
        for state in self
            .active
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|entry| entry.upgrade())
        {
            state.invalidate();
        }
    }
}

/// Filters copied when a scan starts. Omitted pattern matches every binary Key.
#[derive(JsObject)]
pub struct KeyScanOptions {
    pub pattern: Option<Vec<u8>>,
    /// Redis TYPE name, for example `string`, `hash` or `stream`.
    pub key_type: Option<String>,
    /// Redis SCAN COUNT hint (100–10,000). Does not change the page payload limit.
    pub count: Option<u32>,
}

/// One bounded progressive result. An empty nonterminal page still represents progress.
#[derive(JsObject)]
pub struct RedisKeyPage {
    pub keys: Vec<Vec<u8>>,
    pub complete: bool,
    /// Opaque continuation marker, not a count or percentage. Null when complete.
    pub continuation: Option<String>,
    pub database: u32,
    pub generation: String,
}

/// Session-owned progressive Key Scan. Dispose the handle when finished.
#[class]
pub struct RedisKeyScan {
    state: Arc<ScanState>,
}

pub(super) struct Progress {
    buffer: continuation::Buffer<Vec<u8>>,
    options: Option<KeyScanOptions>,
    cursor: u64,
    started: bool,
    cluster: Option<ClusterProgress>,
}

impl continuation::Progress for Progress {
    type Item = Vec<u8>;
    fn buffer(&mut self) -> &mut continuation::Buffer<Vec<u8>> {
        &mut self.buffer
    }
    fn release(&mut self) {
        self.cluster.take();
        self.options.take();
    }
}

struct ClusterProgress {
    topology: Arc<cluster::ScanTopology>,
    cursors: Vec<u64>,
    primary: usize,
}

pub(super) type ScanState = continuation::State<Progress>;
pub(super) type NextPage = continuation::NextPage<Progress>;

impl RedisKeyScan {
    pub(super) fn start(
        session: Arc<SessionState>,
        options: KeyScanOptions,
    ) -> Result<Self, JsError> {
        let _gate = session.admit()?;
        strings::check_payload(
            options.pattern.as_ref().map_or(0, Vec::len),
            session.options.max_response_bytes.unwrap_or(262144) as usize,
        )?;
        if options
            .count
            .is_some_and(|count| !(100..=10000).contains(&count))
        {
            return Err(error(
                "INVALID_ARGUMENT",
                "Expected SCAN COUNT between 100 and 10000",
            ));
        }
        if options.key_type.as_ref().is_some_and(|kind| {
            kind.is_empty()
                || kind.len() > 64
                || !kind
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }) {
            return Err(error("INVALID_ARGUMENT", "Expected a Redis type name"));
        }
        let state = ScanState::new(session.clone(), "Key", |generation, slot| {
            let cluster = session
                .cluster_observation
                .lock()
                .unwrap()
                .as_ref()
                .filter(|observation| observation.epoch == generation)
                .map(|observation| ClusterProgress {
                    cursors: vec![0; observation.topology.primaries.len()],
                    topology: observation.topology.clone(),
                    primary: 0,
                });
            Progress {
                buffer: continuation::Buffer::new(slot),
                options: Some(options),
                cursor: 0,
                started: false,
                cluster,
            }
        })?;
        Ok(Self { state })
    }
}

#[class]
impl RedisKeyScan {
    /// Advance by at most one Redis SCAN command. A positive limit can shrink the page below its 200-key cap.
    /// Concurrent calls reject BUSY.
    pub fn next_page(&self, limit: Option<u32>) -> Result<Later<RedisKeyPage>, JsError> {
        if limit == Some(0) {
            return Err(error(
                "INVALID_ARGUMENT",
                "Expected a positive key page limit",
            ));
        }
        let limit = limit.map_or(continuation::MAX_PAGE_ITEMS, |limit| {
            (limit as usize).min(continuation::MAX_PAGE_ITEMS)
        });
        let page = self.state.next_page()?;
        self.state
            .session
            .submit(Operation::KeyScan(page, limit), |result| match result {
                OperationResult::KeyPage(page) => page,
                _ => unreachable!(),
            })
    }

    /// Stop local work and release retained names. Idempotent; does not undo Redis work.
    pub fn cancel(&self) {
        #[cfg(feature = "redis-observer")]
        let timing = crate::redis_observer::Span::new("key_cancel");
        self.state.fail("CANCELLED");
        #[cfg(feature = "redis-observer")]
        timing.finish(None, true);
    }
}

impl Drop for RedisKeyScan {
    fn drop(&mut self) {
        self.state.fail("CANCELLED");
    }
}

pub(super) fn cancelled_error() -> JsError {
    error("CANCELLED", "Redis scan was cancelled")
}

pub(super) async fn cancelled(scan: &Option<Arc<dyn ContinuationControl>>) {
    if let Some(scan) = scan {
        let mut cancellation = scan.cancellation();
        if !*cancellation.borrow_and_update() {
            let _ = cancellation.changed().await;
        }
    } else {
        std::future::pending::<()>().await;
    }
}

pub(super) async fn next(
    state: &SessionState,
    connection: &mut Option<Connection>,
    page: NextPage,
    limit: usize,
) -> Result<RedisKeyPage, JsError> {
    let scan = &page.state;
    scan.validate()?;
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
        scan.validate()?;
    }
    if let Some(Connection::Cluster(connection)) = connection {
        connection.refresh_scan_topology(state).await?;
        scan.validate()?;
        let mut progress = scan.progress.lock().unwrap();
        if progress.cluster.is_none() && !progress.started {
            let topology = state
                .cluster_observation
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .topology
                .clone();
            progress.cluster = Some(ClusterProgress {
                cursors: vec![0; topology.primaries.len()],
                topology,
                primary: 0,
            });
        }
    }
    let needs_read = {
        let progress = scan.progress.lock().unwrap();
        progress.buffer.pending.is_empty()
            && progress
                .cluster
                .as_ref()
                .map_or(!progress.started || progress.cursor != 0, |cluster| {
                    cluster.primary < cluster.cursors.len()
                })
    };
    if needs_read {
        let (cursor, primary) = {
            let progress = scan.progress.lock().unwrap();
            match &progress.cluster {
                Some(cluster) => (
                    cluster.cursors[cluster.primary],
                    Some(cluster.topology.primaries[cluster.primary].clone()),
                ),
                None => (progress.cursor, None),
            }
        };
        let mut command = redis::cmd("SCAN");
        command.arg(cursor).arg("COUNT");
        {
            let progress = scan.progress.lock().unwrap();
            let options = progress.options.as_ref().ok_or_else(cancelled_error)?;
            command.arg(options.count.unwrap_or(200));
            if let Some(pattern) = &options.pattern {
                command.arg("MATCH").arg(pattern);
            }
            if let Some(kind) = &options.key_type {
                command
                    .arg("TYPE")
                    .arg(if kind.eq_ignore_ascii_case("json") {
                        "ReJSON-RL"
                    } else {
                        kind
                    });
            }
        }
        let result = match connection.as_mut().unwrap() {
            Connection::Cluster(connection) => {
                connection
                    .scan_primary(state, primary.as_ref().unwrap(), &command)
                    .await
            }
            Connection::Standalone(connection, _) => command
                .query_async::<(u64, Vec<Vec<u8>>)>(connection)
                .await
                .map_err(classify),
        };
        let (cursor, keys) = match result {
            Ok(reply) => reply,
            Err(cause) => {
                if matches!(
                    cause.code(),
                    Some("CONNECTION_FAILED" | "TIMEOUT" | "CURSOR_INVALIDATED")
                ) {
                    discard_transports(connection);
                    state.advance_generation();
                    scan.fail("CURSOR_INVALIDATED");
                    return Err(error(
                        "CURSOR_INVALIDATED",
                        "Redis scan connection was lost",
                    ));
                }
                return Err(cause);
            }
        };
        let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
        if keys.iter().any(|key| key.len() > budget) {
            scan.fail("PAYLOAD_TOO_LARGE");
            return Err(error(
                "PAYLOAD_TOO_LARGE",
                "One Key exceeds the page payload budget",
            ));
        }
        let retained = match state.continuations.retain(
            keys.len(),
            keys.iter()
                .fold(0usize, |bytes, key| bytes.saturating_add(key.len())),
        ) {
            Ok(retained) => retained,
            Err(cause) => {
                scan.fail("RETENTION_LIMIT");
                return Err(cause);
            }
        };
        let mut progress = scan.progress.lock().unwrap();
        if let Some(code) = progress.buffer.failure {
            return Err(error(code, "Redis scan is no longer active"));
        }
        progress.cursor = cursor;
        if let Some(cluster) = &mut progress.cluster {
            cluster.cursors[cluster.primary] = cursor;
            if cursor == 0 {
                cluster.primary += 1;
            }
        }
        progress.started = true;
        progress.buffer.pending = keys.into();
        progress.buffer.retained = Some(retained);
    }
    let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
    let mut progress = scan.progress.lock().unwrap();
    let keys = progress.buffer.drain(budget, limit, Vec::len);
    let complete = progress.buffer.pending.is_empty()
        && progress
            .cluster
            .as_ref()
            .map_or(progress.started && progress.cursor == 0, |cluster| {
                cluster.primary == cluster.cursors.len()
            });
    if complete {
        progress.buffer.slot.take();
        progress.options.take();
        progress.cluster.take();
    }
    Ok(RedisKeyPage {
        keys,
        complete,
        continuation: (!complete).then(|| progress.buffer.sequence.to_string()),
        database: scan.database,
        generation: scan.generation.to_string(),
    })
}
