//! Dedicated RESP3 subscriptions with bounded delivery, independent of command lanes.
use super::*;
use std::collections::{HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

const MAX_MESSAGES: usize = 500;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(JsObject)]
pub struct RedisPublish {
    /// Acknowledged recipients, not an application-level delivery acknowledgement.
    /// Redis Cluster reports recipients on the publishing node only.
    pub receivers: String,
    pub database: u32,
    pub generation: String,
}

#[derive(JsObject)]
pub struct RedisPubSubMessage {
    pub id: String,
    pub timestamp_ms: String,
    pub channel: Vec<u8>,
    pub pattern: Option<Vec<u8>>,
    pub payload: Vec<u8>,
}

impl RedisPubSubMessage {
    fn bytes(&self) -> usize {
        self.channel.len() + self.pattern.as_ref().map_or(0, Vec::len) + self.payload.len()
    }
}

#[derive(JsObject)]
pub struct RedisPubSubBatch {
    pub messages: Vec<RedisPubSubMessage>,
    pub queued: u32,
    pub received: String,
    /// Messages evicted or rejected by native count/byte limits, including oversized payloads.
    pub dropped: String,
    pub closed: bool,
    pub error_code: Option<String>,
}

#[derive(JsObject)]
pub struct RedisPubSubInfo {
    pub queued: u32,
    pub received: String,
    pub dropped: String,
    pub closed: bool,
    pub error_code: Option<String>,
}

#[derive(Default)]
struct Buffer {
    messages: VecDeque<RedisPubSubMessage>,
    bytes: usize,
    received: u64,
    dropped: u64,
    closed: bool,
    error_code: Option<String>,
}

impl Buffer {
    fn push(&mut self, info: redis::PushInfo, budget: usize) {
        if self.closed {
            return;
        }
        if !matches!(
            info.kind,
            redis::PushKind::Message | redis::PushKind::PMessage | redis::PushKind::SMessage
        ) {
            return;
        }
        self.received += 1;
        // Reject from borrowed lengths before cloning channel, pattern or payload bytes.
        let bytes = info.data.iter().fold(0usize, |size, value| {
            size.saturating_add(match value {
                redis::Value::BulkString(bytes) => bytes.len(),
                redis::Value::SimpleString(value) => value.len(),
                _ => budget.saturating_add(1),
            })
        });
        if bytes > budget {
            self.dropped += 1;
            return;
        }
        let Some(message) = redis::Msg::from_push_info(info) else {
            return;
        };
        let Ok(channel) = message.get_channel::<Vec<u8>>() else {
            return;
        };
        let message = RedisPubSubMessage {
            id: self.received.to_string(),
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
            channel,
            pattern: if message.from_pattern() {
                message.get_pattern().ok()
            } else {
                None
            },
            payload: message.get_payload_bytes().to_vec(),
        };
        let bytes = message.bytes();
        if bytes > budget {
            self.dropped += 1;
            return;
        }
        while self.messages.len() >= MAX_MESSAGES || self.bytes + bytes > MAX_BYTES {
            if let Some(old) = self.messages.pop_front() {
                self.bytes -= old.bytes();
                self.dropped += 1;
            }
        }
        self.bytes += bytes;
        self.messages.push_back(message);
    }
}

fn deliver(
    buffer: &StdMutex<Buffer>,
    disconnections: &Notify,
    info: redis::PushInfo,
    budget: usize,
) {
    if info.kind == redis::PushKind::Disconnection {
        // A failed discovery candidate may emit this after a later candidate
        // succeeds. Verify the worker's committed transport before closing.
        disconnections.notify_one();
    } else {
        buffer.lock().unwrap().push(info, budget);
    }
}

struct Change {
    channel: Vec<u8>,
    pattern: bool,
    remove: bool,
    reply: oneshot::Sender<Result<(), JsError>>,
    deadline: tokio::time::Instant,
}

/// One owned receiver per Session, with at most 64 subscriptions and 500 messages / 4 MiB.
/// Closing, disposal or Session close drops its dedicated transport. Delivery is at-most-once;
/// a lost connection closes the receiver and requires explicitly reopening/resubscribing.
#[class]
pub struct RedisPubSub {
    state: Arc<SessionState>,
    buffer: Arc<StdMutex<Buffer>>,
    changes: mpsc::Sender<Change>,
    cancel: CancellationToken,
    finished: CancellationToken,
}

#[class]
impl RedisPubSub {
    /// Read receiver status without consuming messages, including while display is paused.
    pub fn get_info(&self) -> RedisPubSubInfo {
        let buffer = self.buffer.lock().unwrap();
        RedisPubSubInfo {
            queued: buffer.messages.len() as u32,
            received: buffer.received.to_string(),
            dropped: buffer.dropped.to_string(),
            closed: buffer.closed || self.state.closed.load(Ordering::Acquire),
            error_code: buffer.error_code.clone(),
        }
    }

    /// Clear buffered messages explicitly, keeping lifetime received/dropped totals.
    pub fn clear(&self) {
        let mut buffer = self.buffer.lock().unwrap();
        buffer.messages.clear();
        buffer.bytes = 0;
    }

    /// Subscribe to a binary channel, or a Redis glob when pattern is true. Waits for Redis's acknowledgement.
    pub fn subscribe(&self, channel: Vec<u8>, pattern: bool) -> Result<Later<()>, JsError> {
        self.change(channel, pattern, false)
    }

    /// Unsubscribe exactly this channel or pattern. Previously buffered messages remain readable.
    pub fn unsubscribe(&self, channel: Vec<u8>, pattern: bool) -> Result<Later<()>, JsError> {
        self.change(channel, pattern, true)
    }

    /// Drain up to 100 complete binary messages within the Session response budget.
    /// Totals are lifetime counts; closed/errorCode expose a lost receiver without reconnecting silently.
    pub fn drain(&self) -> RedisPubSubBatch {
        let mut buffer = self.buffer.lock().unwrap();
        let mut messages = Vec::new();
        let mut bytes = 0;
        let budget = self.state.options.max_response_bytes.unwrap_or(262_144) as usize;
        while messages.len() < 100
            && buffer
                .messages
                .front()
                .is_some_and(|message| bytes + message.bytes() <= budget)
        {
            let message = buffer.messages.pop_front().unwrap();
            bytes += message.bytes();
            buffer.bytes -= message.bytes();
            messages.push(message);
        }
        RedisPubSubBatch {
            messages,
            queued: buffer.messages.len() as u32,
            received: buffer.received.to_string(),
            dropped: buffer.dropped.to_string(),
            closed: buffer.closed || self.state.closed.load(Ordering::Acquire),
            error_code: buffer.error_code.clone(),
        }
    }

    /// Stop receiving and release the dedicated connection, including pending subscription commands.
    pub fn close(&self) {
        self.cancel.cancel();
        self.buffer.lock().unwrap().closed = true;
    }

    /// Close and wait until the worker has released its transport and receiver capacity.
    pub fn close_and_wait(&self) -> Later<()> {
        self.close();
        let finished = self.finished.clone();
        Later::new(async move {
            finished.cancelled().await;
            Ok::<(), JsError>(())
        })
    }
}

impl Drop for RedisPubSub {
    fn drop(&mut self) {
        self.close();
    }
}

impl RedisPubSub {
    pub(super) fn open(state: Arc<SessionState>) -> Result<Later<Self>, JsError> {
        let gate = state.admit()?;
        let permit = state
            .pubsub_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "This Session already has a Pub/Sub receiver"))?;
        static RECEIVERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let global = RECEIVERS
            .get_or_init(|| Arc::new(Semaphore::new(32)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Pub/Sub receiver capacity is exhausted"))?;
        drop(gate);
        let (mut reply, receive) = oneshot::channel();
        runtime()?.spawn(async move {
            let buffer = Arc::new(StdMutex::new(Buffer::default()));
            let pushed = buffer.clone();
            let disconnections = Arc::new(Notify::new());
            let disconnected = disconnections.clone();
            let budget = state.options.max_response_bytes.unwrap_or(262_144) as usize;
            let config = redis::AsyncConnectionConfig::new().set_push_sender(
                move |info: redis::PushInfo| {
                    deliver(&pushed, &disconnected, info, budget);
                    Ok::<(), ()>(())
                },
            );
            let connection = tokio::select! {
                biased;
                _ = closed_signal(&state) => Err(closed()),
                _ = reply.closed() => return,
                connection = connect_receiver(&state, config) => connection,
            };
            match connection {
                Ok(connection) => {
                    let (changes, requests) = mpsc::channel(16);
                    let cancel = CancellationToken::new();
                    let finished = CancellationToken::new();
                    let receiver = Self {
                        state: state.clone(),
                        buffer: buffer.clone(),
                        changes,
                        cancel: cancel.clone(),
                        finished: finished.clone(),
                    };
                    tokio::spawn(async move {
                        run(
                            state,
                            buffer,
                            connection,
                            requests,
                            cancel,
                            disconnections,
                            permit,
                            global,
                        )
                        .await;
                        finished.cancel();
                    });
                    let _ = reply.send(Ok(receiver));
                }
                Err(cause) => {
                    let _ = reply.send(Err(cause));
                }
            }
        });
        Ok(Later::new(
            async move { receive.await.map_err(|_| closed())? },
        ))
    }

    fn change(&self, channel: Vec<u8>, pattern: bool, remove: bool) -> Result<Later<()>, JsError> {
        if channel.is_empty() {
            return Err(error("INVALID_ARGUMENT", "Supply a channel or pattern"));
        }
        strings::check_payload(
            channel.len(),
            self.state.options.max_response_bytes.unwrap_or(262_144) as usize,
        )?;
        if self.cancel.is_cancelled()
            || self.buffer.lock().unwrap().closed
            || self.state.closed.load(Ordering::Acquire)
        {
            return Err(closed());
        }
        let (reply, receive) = oneshot::channel();
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(
                self.state
                    .options
                    .operation_timeout_ms
                    .unwrap_or(5000)
                    .into(),
            );
        self.changes
            .try_send(Change {
                channel,
                pattern,
                remove,
                reply,
                deadline,
            })
            .map_err(|_| error("BUSY", "Pub/Sub command queue is full or closed"))?;
        Ok(Later::new(
            async move { receive.await.map_err(|_| closed())? },
        ))
    }
}

async fn connect_receiver(
    state: &SessionState,
    config: redis::AsyncConnectionConfig,
) -> Result<Transport, JsError> {
    let mut options = state.options.clone();
    // Pub/Sub is database-independent, so do not require SELECT permission on this transport.
    options.database = Some(0);
    if let Some(sentinel) = &state.sentinel_options {
        return sentinel::connect_configured(&options, sentinel, Some(config)).await;
    }
    if state.cluster_options.is_some() {
        let endpoints = state.cluster_discovery.lock().unwrap().clone();
        let mut last = error("CONNECTION_FAILED", "No Cluster endpoint is available");
        return tokio::time::timeout(
            Duration::from_millis(options.connect_timeout_ms.unwrap_or(3000).into()),
            async {
                for endpoint in endpoints {
                    options.host = endpoint.host;
                    options.port = endpoint.port;
                    match connect_configured(&options, Some(config.clone())).await {
                        Ok(connection) => return Ok(connection),
                        Err(cause) => last = cause,
                    }
                }
                Err(last)
            },
        )
        .await
        .map_err(|_| error("TIMEOUT", "Pub/Sub setup exceeded its deadline"))?;
    }
    connect_configured(&options, Some(config)).await
}

async fn run(
    state: Arc<SessionState>,
    buffer: Arc<StdMutex<Buffer>>,
    mut connection: Transport,
    mut changes: mpsc::Receiver<Change>,
    cancel: CancellationToken,
    disconnections: Arc<Notify>,
    _permit: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
) {
    let mut subscriptions = HashSet::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    loop {
        let result: Result<(), JsError> = tokio::select! {
            biased;
            _ = closed_signal(&state) => break,
            _ = cancel.cancelled() => break,
            request = changes.recv() => {
                let Some(Change { channel, pattern, remove, mut reply, deadline }) = request else { break; };
                if reply.is_closed() { continue; }
                let key = (channel, pattern);
                if !remove && !subscriptions.contains(&key) && subscriptions.len() >= 64 {
                    let _ = reply.send(Err(error("BUSY", "At most 64 Pub/Sub subscriptions are allowed")));
                    continue;
                }
                let name = match (pattern, remove) { (false, false) => "SUBSCRIBE", (true, false) => "PSUBSCRIBE", (false, true) => "UNSUBSCRIBE", (true, true) => "PUNSUBSCRIBE" };
                let mut command = redis::cmd(name);
                command.arg(&key.0);
                let outcome = tokio::select! {
                    biased;
                    _ = closed_signal(&state) => Err(closed()),
                    _ = cancel.cancelled() => Err(closed()),
                    _ = reply.closed() => Err(error("CANCELLED", "Subscription change cancelled")),
                    result = tokio::time::timeout_at(deadline, command.query_async::<()>(&mut connection)) => result.map_err(|_| error("TIMEOUT", "Pub/Sub command exceeded its deadline")).and_then(|r| r.map_err(classify)),
                };
                let terminal = outcome.as_ref().err().is_some_and(|cause| matches!(cause.code(), Some("TIMEOUT" | "CONNECTION_FAILED" | "SESSION_CLOSED" | "CANCELLED")));
                if outcome.is_ok() { if remove { subscriptions.remove(&key); } else { subscriptions.insert(key); } }
                let failure = outcome.as_ref().err().cloned();
                let _ = reply.send(outcome);
                if terminal { Err(failure.unwrap()) } else { Ok(()) }
            }
            _ = async { tokio::select! { _ = heartbeat.tick() => {}, _ = disconnections.notified() => {} } } => {
                let command = redis::cmd("PING");
                tokio::select! {
                    biased;
                    _ = closed_signal(&state) => Err(closed()),
                    _ = cancel.cancelled() => Err(closed()),
                    result = command.query_async::<String>(&mut connection) => result.map(|_| ()).map_err(classify),
                }
            },
        };
        if let Err(cause) = result {
            buffer.lock().unwrap().error_code = cause.code().map(str::to_owned);
            break;
        }
    }
    let mut buffer = buffer.lock().unwrap();
    buffer.closed = true;
}

pub(super) fn validate(channel: &[u8], payload: &[u8], budget: usize) -> Result<(), JsError> {
    if channel.is_empty() {
        return Err(error("INVALID_ARGUMENT", "Supply a publication channel"));
    }
    strings::check_payload(channel.len().saturating_add(payload.len()), budget)
}

pub(super) async fn publish(
    state: &SessionState,
    connection: &mut Option<Connection>,
    channel: Vec<u8>,
    payload: Vec<u8>,
    dispatched: &AtomicBool,
) -> Result<RedisPublish, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let command = redis::cmd("PUBLISH").arg(&channel).arg(payload).to_owned();
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(state, None, &command, Some(dispatched))
        .await
    {
        Ok(receivers) => Ok(RedisPublish {
            receivers: receivers.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) async fn export_logs(content: String) -> Result<Option<String>, JsError> {
    export::json(content, "ferrix-pubsub.json", 32 * 1024 * 1024).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;

    #[test]
    fn stale_candidate_disconnect_requests_health_check_without_poisoning_delivery() {
        let buffer = StdMutex::new(Buffer::default());
        let health = Notify::new();
        deliver(
            &buffer,
            &health,
            redis::PushInfo {
                kind: redis::PushKind::Disconnection,
                data: vec![],
            },
            32,
        );
        let mut notification = std::pin::pin!(health.notified());
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(notification.as_mut().poll(&mut context).is_ready());
        assert!(!buffer.lock().unwrap().closed);
        deliver(
            &buffer,
            &health,
            redis::PushInfo {
                kind: redis::PushKind::Message,
                data: vec![
                    redis::Value::BulkString(b"channel".to_vec()),
                    redis::Value::BulkString(b"payload".to_vec()),
                ],
            },
            32,
        );
        let buffer = buffer.lock().unwrap();
        assert_eq!(buffer.received, 1);
        assert_eq!(buffer.messages.front().unwrap().payload, b"payload");
    }
}
