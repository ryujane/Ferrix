//! A Session-owned CLI socket with isolated connection state and no command allowlist.
use super::*;
use std::collections::{HashSet, VecDeque};
use tokio::{io::AsyncWriteExt, sync::mpsc};
use tokio_util::sync::CancellationToken;
pub(super) mod catalog;
mod protocol;

#[derive(JsObject)]
pub struct RedisConsoleReply {
    pub output: String,
    pub failed: bool,
    pub database: u32,
    pub streaming: bool,
    pub monitoring: bool,
    pub closed: bool,
}
#[derive(JsObject)]
pub struct RedisConsoleBatch {
    pub output: Vec<String>,
    pub dropped: String,
    pub database: u32,
    pub streaming: bool,
    pub monitoring: bool,
    pub closed: bool,
    pub endpoint: String,
    pub error_code: Option<String>,
}
#[derive(Default)]
struct Buffer {
    output: VecDeque<String>,
    bytes: usize,
    dropped: u64,
    database: u32,
    streaming: bool,
    monitoring: bool,
    closed: bool,
    endpoint: String,
    error_code: Option<String>,
}
impl Buffer {
    fn push(&mut self, value: redis::Value) {
        let text = output(&value);
        while self.output.len() >= 128 || self.bytes + text.len() > 1024 * 1024 {
            let Some(old) = self.output.pop_front() else {
                self.dropped += 1;
                return;
            };
            self.bytes -= old.len();
            self.dropped += 1;
        }
        self.bytes += text.len();
        self.output.push_back(text);
    }
}
struct Request {
    args: Vec<Vec<u8>>,
    reply: oneshot::Sender<Result<RedisConsoleReply, JsError>>,
}

/// An isolated CLI connection. Arbitrary binary arguments are sent once in order.
/// Transactions, authentication and SELECT affect this connection only. Closing or
/// Session disposal interrupts blocking/streaming commands; uncertain commands never replay.
#[class]
pub struct RedisConsole {
    state: Arc<SessionState>,
    requests: mpsc::Sender<Request>,
    buffer: Arc<StdMutex<Buffer>>,
    busy: Arc<AtomicBool>,
    cancel: CancellationToken,
    finished: CancellationToken,
}
#[class]
impl RedisConsole {
    /// Send any Redis command, including module commands. Waits for a reply or explicit
    /// close, so blocking commands can wait indefinitely without occupying browser lanes.
    pub fn execute(&self, args: Vec<Vec<u8>>) -> Result<Later<RedisConsoleReply>, JsError> {
        if self.cancel.is_cancelled() || self.state.closed.load(Ordering::Acquire) {
            return Err(closed());
        }
        if args.is_empty() || args[0].is_empty() || args.len() > 4096 {
            return Err(error(
                "INVALID_ARGUMENT",
                "Supply a Redis command and at most 4095 arguments",
            ));
        }
        strings::check_payload(
            args.iter()
                .fold(0usize, |n, a| n.saturating_add(a.len()).saturating_add(16)),
            self.state.options.max_response_bytes.unwrap_or(262144) as usize,
        )?;
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(error("BUSY", "A Redis CLI command is already running"));
        }
        let (reply, receive) = oneshot::channel();
        if self.requests.try_send(Request { args, reply }).is_err() {
            self.busy.store(false, Ordering::Release);
            return Err(closed());
        }
        Ok(Later::new(
            async move { receive.await.map_err(|_| closed())? },
        ))
    }
    /// Drain bounded unsolicited responses from MONITOR, Pub/Sub or RESP3 pushes.
    pub fn drain(&self) -> RedisConsoleBatch {
        let mut buffer = self.buffer.lock().unwrap();
        let mut output = Vec::new();
        let mut bytes = 0;
        while output.len() < 32
            && buffer
                .output
                .front()
                .is_some_and(|s| bytes + s.len() <= 1024 * 1024)
        {
            let text = buffer.output.pop_front().unwrap();
            bytes += text.len();
            buffer.bytes -= text.len();
            output.push(text);
        }
        RedisConsoleBatch {
            output,
            dropped: buffer.dropped.to_string(),
            database: buffer.database,
            streaming: buffer.streaming,
            monitoring: buffer.monitoring,
            closed: buffer.closed || self.state.closed.load(Ordering::Acquire),
            endpoint: buffer.endpoint.clone(),
            error_code: buffer.error_code.clone(),
        }
    }
    /// Interrupt this CLI connection, including an unanswered command. Does not close the Session.
    pub fn close(&self) {
        self.cancel.cancel();
        self.buffer.lock().unwrap().closed = true;
    }
    /// Stop and wait until the socket and per-Session capacity have been released.
    pub fn close_and_wait(&self) -> Later<()> {
        self.close();
        let finished = self.finished.clone();
        Later::new(async move {
            finished.cancelled().await;
            Ok::<(), JsError>(())
        })
    }
}
impl Drop for RedisConsole {
    fn drop(&mut self) {
        self.close();
    }
}
impl RedisConsole {
    pub(super) fn open(
        state: Arc<SessionState>,
        database: Option<u32>,
    ) -> Result<Later<Self>, JsError> {
        let gate = state.admit()?;
        let database = database.unwrap_or_else(|| state.database());
        if state.cluster_options.is_some() && database != 0 {
            return Err(error(
                "CLUSTER_DATABASE_UNSUPPORTED",
                "Redis Cluster supports only database zero",
            ));
        }
        if database > i32::MAX as u32 {
            return Err(error("INVALID_ARGUMENT", "Redis database is out of range"));
        }
        let permit = state
            .console_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "This Session already has a CLI connection"))?;
        static CONSOLES: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let global = CONSOLES
            .get_or_init(|| Arc::new(Semaphore::new(16)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Redis CLI connection capacity is exhausted"))?;
        drop(gate);
        let (mut reply, receive) = oneshot::channel();
        runtime()?.spawn(async move {
            let setup = async {
                let probe = state.connect_for_database(database).await?;
                let targets = probe.cluster_endpoints();
                let endpoint = match probe { Connection::Standalone(ref t, _) => t.endpoint.clone().ok_or_else(closed)?, Connection::Cluster(ref c) => c.console_endpoint() };
                drop(probe);
                let mut options = state.options.clone(); options.host = endpoint.host; options.port = endpoint.port; options.database = Some(database);
                let auth = credentials(&options);
                let mut socket = Socket::open(options, auth, 2).await?;
                socket.targets = targets;
                Ok::<_, JsError>(socket)
            };
            let socket = tokio::select! { biased;
                _ = closed_signal(&state) => Err(closed()),
                _ = reply.closed() => return,
                result = tokio::time::timeout(Duration::from_millis(state.options.connect_timeout_ms.unwrap_or(3000) as u64), setup) => result.unwrap_or_else(|_| Err(error("TIMEOUT", "Redis CLI setup exceeded its deadline"))),
            };
            let socket = match socket { Ok(value) => value, Err(cause) => { let _ = reply.send(Err(cause)); return; } };
            let buffer = Arc::new(StdMutex::new(Buffer { database, endpoint: socket.endpoint(), ..Default::default() }));
            let cancel = CancellationToken::new(); let finished = CancellationToken::new(); let busy = Arc::new(AtomicBool::new(false));
            let (requests, receiver) = mpsc::channel(1);
            let console = Self { state: state.clone(), requests, buffer: buffer.clone(), busy: busy.clone(), cancel: cancel.clone(), finished: finished.clone() };
            tokio::spawn(async move {
                run(state, socket, receiver, &buffer, &busy, &cancel).await;
                buffer.lock().unwrap().closed = true; busy.store(false, Ordering::Release);
                drop(permit); drop(global); finished.cancel();
            });
            let _ = reply.send(Ok(console));
        });
        Ok(Later::new(
            async move { receive.await.map_err(|_| closed())? },
        ))
    }
}

fn credentials(options: &StandaloneOptions) -> Option<Vec<Vec<u8>>> {
    options.password.as_ref().map(|password| {
        let mut args = vec![b"AUTH".to_vec()];
        if let Some(username) = &options.username {
            args.push(username.as_bytes().to_vec());
        }
        args.push(password.as_bytes().to_vec());
        args
    })
}
struct Socket {
    writer: tokio::io::WriteHalf<protocol::Stream>,
    frames: mpsc::Receiver<Result<redis::Value, JsError>>,
    reader: tokio::task::JoinHandle<()>,
    options: StandaloneOptions,
    auth: Option<Vec<Vec<u8>>>,
    version: u8,
    targets: Vec<cluster::RedisEndpoint>,
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
impl Socket {
    fn endpoint(&self) -> String {
        format!("{}:{}", self.options.host, self.options.port)
    }
    async fn open(
        options: StandaloneOptions,
        auth: Option<Vec<Vec<u8>>>,
        version: u8,
    ) -> Result<Self, JsError> {
        let stream: protocol::Stream = if let Some(ssh) = &options.ssh {
            let stream = ssh::connect(
                ssh,
                &options.host,
                options.port as u16,
                options.proxy.as_ref(),
            )
            .await?;
            security::wrap_stream(stream, &options.host, options.tls.as_ref()).await?
        } else if let Some(proxy) = &options.proxy {
            let stream = proxy::connect(proxy, &options.host, options.port as u16).await?;
            security::wrap_stream(stream, &options.host, options.tls.as_ref()).await?
        } else {
            let stream =
                tokio::net::TcpStream::connect((options.host.as_str(), options.port as u16))
                    .await
                    .map_err(|_| error("CONNECTION_FAILED", "Redis CLI endpoint is unreachable"))?;
            let _ = stream.set_nodelay(true);
            security::wrap_stream(stream, &options.host, options.tls.as_ref()).await?
        };
        let (reader, mut writer) = tokio::io::split(stream);
        let mut reader = protocol::Reader::new(reader);
        let budget = options.max_response_bytes.unwrap_or(262144) as usize;
        let mut setup = Vec::new();
        if let Some(auth) = &auth {
            setup.push(auth.clone());
        }
        if version == 3 {
            setup.push(vec![b"HELLO".to_vec(), b"3".to_vec()]);
        }
        if options.database.unwrap_or(0) != 0 {
            setup.push(vec![
                b"SELECT".to_vec(),
                options.database.unwrap().to_string().into_bytes(),
            ]);
        }
        for args in setup {
            writer
                .write_all(&packet(&args))
                .await
                .map_err(|_| error("CONNECTION_FAILED", "Redis CLI setup was interrupted"))?;
            if let redis::Value::ServerError(cause) = protocol::read(&mut reader, budget).await? {
                return Err(classify(cause.into()));
            }
        }
        let (send, frames) = mpsc::channel(4);
        let task = tokio::spawn(async move {
            loop {
                let value = protocol::read(&mut reader, budget).await;
                let failed = value.is_err();
                if send.send(value).await.is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            writer,
            frames,
            reader: task,
            options,
            auth,
            version,
            targets: Vec::new(),
        })
    }
    async fn send(&mut self, args: &[Vec<u8>]) -> Result<(), JsError> {
        self.writer
            .write_all(&packet(args))
            .await
            .map_err(|_| unknown_write())
    }
    async fn next(&mut self) -> Result<redis::Value, JsError> {
        self.frames.recv().await.ok_or_else(closed)?
    }
    async fn redirect_target(
        &mut self,
        args: &[Vec<u8>],
        value: &redis::Value,
        buffer: &StdMutex<Buffer>,
    ) -> Result<Option<(cluster::RedisEndpoint, bool)>, JsError> {
        let redis::Value::ServerError(cause) = value else {
            return Ok(None);
        };
        if !matches!(cause.code(), "MOVED" | "ASK") {
            return Ok(None);
        }
        let parts: Vec<_> = cause
            .details()
            .unwrap_or_default()
            .split_whitespace()
            .collect();
        if parts.len() != 2 {
            return Ok(None);
        }
        let Ok(slot) = parts[0].parse::<u16>() else {
            return Ok(None);
        };
        let Ok(endpoint) = cluster::parse_endpoint(parts[1], &self.options.host) else {
            return Ok(None);
        };
        if slot >= 16384 || !self.targets.contains(&endpoint) {
            return Ok(None);
        }
        let deadline =
            Duration::from_millis(self.options.operation_timeout_ms.unwrap_or(3000) as u64);
        let metadata = async {
            self.send(&[b"COMMAND".to_vec(), b"INFO".to_vec(), args[0].clone()])
                .await?;
            loop {
                let frame = self.next().await?;
                if message(&frame, false) {
                    buffer.lock().unwrap().push(frame);
                } else {
                    break Ok::<_, JsError>(frame);
                }
            }
        };
        let metadata = tokio::time::timeout(deadline, metadata)
            .await
            .map_err(|_| {
                error(
                    "TIMEOUT",
                    "Redis CLI routing metadata exceeded its deadline",
                )
            })??;
        Ok((fixed_key_slot(&metadata, args) == Some(slot))
            .then_some((endpoint, cause.code() == "ASK")))
    }
}
fn packet(args: &[Vec<u8>]) -> Vec<u8> {
    let mut wire = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        wire.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        wire.extend_from_slice(arg);
        wire.extend_from_slice(b"\r\n");
    }
    wire
}
fn word(args: &[Vec<u8>], at: usize) -> String {
    args.get(at)
        .map(|b| String::from_utf8_lossy(b).to_ascii_uppercase())
        .unwrap_or_default()
}
// Only fixed-key built-ins establish that a routing error means non-execution.
// Scripts, functions and module commands can synthesize MOVED/ASK after writing.
fn fixed_key_slot(value: &redis::Value, args: &[Vec<u8>]) -> Option<u16> {
    let redis::Value::Array(entries) = value else {
        return None;
    };
    let redis::Value::Array(fields) = entries.first()? else {
        return None;
    };
    let flags = match fields.get(2)? {
        redis::Value::Array(flags) | redis::Value::Set(flags) => flags,
        _ => return None,
    };
    let flags = flags
        .iter()
        .map(|flag| redis::from_redis_value::<String>(flag.clone()))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if flags
        .iter()
        .any(|flag| matches!(flag.as_str(), "module" | "movablekeys"))
    {
        return None;
    }
    let redis::Value::Int(first) = fields.get(3)? else {
        return None;
    };
    (*first > 0).then_some(())?;
    Some(cluster::slot_for_key(args.get(*first as usize)?))
}
fn suppresses_reply(args: &[Vec<u8>]) -> bool {
    args.len() == 3
        && word(args, 0) == "CLIENT"
        && word(args, 1) == "REPLY"
        && matches!(word(args, 2).as_str(), "OFF" | "SKIP")
}
fn hello_auth(args: &[Vec<u8>]) -> Option<Vec<Vec<u8>>> {
    let mut at = 2;
    let mut auth = None;
    while at < args.len() {
        match word(args, at).as_str() {
            "AUTH" if args.len() > at + 2 => {
                auth = Some(vec![
                    b"AUTH".to_vec(),
                    args[at + 1].clone(),
                    args[at + 2].clone(),
                ]);
                at += 3;
            }
            "SETNAME" => at += 2,
            _ => break,
        }
    }
    auth
}
fn output(value: &redis::Value) -> String {
    let mut text = protocol::format(value);
    if text.len() > 1024 * 1024 {
        let mut end = 1024 * 1024 - 32;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n(output truncated)");
    }
    text
}
fn message(value: &redis::Value, subscribed_resp2: bool) -> bool {
    match value {
        redis::Value::Push { kind, .. } => !matches!(
            kind,
            redis::PushKind::Subscribe
                | redis::PushKind::PSubscribe
                | redis::PushKind::SSubscribe
                | redis::PushKind::Unsubscribe
                | redis::PushKind::PUnsubscribe
                | redis::PushKind::SUnsubscribe
        ),
        redis::Value::Array(items) if subscribed_resp2 => items
            .first()
            .and_then(|v| redis::from_redis_value::<String>(v.clone()).ok())
            .is_some_and(|s| matches!(s.as_str(), "message" | "pmessage" | "smessage")),
        _ => false,
    }
}
async fn run(
    state: Arc<SessionState>,
    mut socket: Socket,
    mut requests: mpsc::Receiver<Request>,
    buffer: &StdMutex<Buffer>,
    busy: &AtomicBool,
    cancel: &CancellationToken,
) {
    let mut transaction = false;
    let mut watched = false;
    let mut monitoring = false;
    let mut subscriptions: [HashSet<Vec<u8>>; 3] = Default::default();
    let mut queued_count = 0usize;
    let mut queued_databases: Vec<(usize, u32)> = Vec::new();
    let mut reset_after_exec = false;
    let mut suppresses_exec_reply = false;
    loop {
        tokio::select! { biased;
            _ = closed_signal(&state) => break,
            _ = cancel.cancelled() => break,
            request = requests.recv() => {
                let Some(Request { args, mut reply }) = request else { break; };
                let sent = AtomicBool::new(false);
                let operation = async {
                    if monitoring { return Err(error("BUSY", "Stop MONITOR before sending another command")); }
                    let verb = word(&args, 0);
                    for attempt in 0..=5 {
                        sent.store(true, Ordering::Release); socket.send(&args).await?;
                        if !transaction && suppresses_reply(&args) || transaction && verb == "EXEC" && args.len() == 1 && suppresses_exec_reply {
                            let b = buffer.lock().unwrap();
                            return Ok(RedisConsoleReply { output: "(reply suppressed; command outcome unconfirmed; CLI connection closed)".into(), failed: false, database: b.database, streaming: b.streaming, monitoring: b.monitoring, closed: true });
                        }
                        let subscription = match verb.as_str() { "SUBSCRIBE" | "UNSUBSCRIBE" => Some(0), "PSUBSCRIBE" | "PUNSUBSCRIBE" => Some(1), "SSUBSCRIBE" | "SUNSUBSCRIBE" => Some(2), _ => None };
                        let expected = subscription.map_or(1, |i| if args.len() > 1 { args.len() - 1 } else { subscriptions[i].len().max(1) });
                        let mut replies = Vec::new();
                        for _ in 0..expected {
                            let value = loop { let value = socket.next().await.map_err(|cause| if matches!(cause.code(), Some("PAYLOAD_TOO_LARGE" | "PROTOCOL_ERROR")) { cause } else { unknown_write() })?; if message(&value, socket.version == 2 && buffer.lock().unwrap().streaming) { buffer.lock().unwrap().push(value); } else { break value; } };
                            let failed = matches!(value, redis::Value::ServerError(_)) || matches!(&value, redis::Value::SimpleString(s) if s == "QUEUED"); replies.push(value); if failed { break; }
                        }
                        let value = if replies.len() == 1 { replies.pop().unwrap() } else { redis::Value::Array(replies) };
                        if state.cluster_options.is_some() && !transaction && !watched && !buffer.lock().unwrap().streaming && attempt < 5 {
                            if let Some((endpoint, asking)) = socket.redirect_target(&args, &value, buffer).await? {
                                sent.store(false, Ordering::Release);
                                let mut options = socket.options.clone(); options.host = endpoint.host; options.port = endpoint.port;
                                let targets = socket.targets.clone();
                                socket = tokio::time::timeout(Duration::from_millis(options.connect_timeout_ms.unwrap_or(3000) as u64), Socket::open(options, socket.auth.clone(), socket.version)).await.map_err(|_| error("TIMEOUT", "Redis CLI redirect setup exceeded its deadline"))??;
                                socket.targets = targets;
                                buffer.lock().unwrap().endpoint = socket.endpoint();
                                if asking { socket.send(&[b"ASKING".to_vec()]).await?; if let redis::Value::ServerError(cause) = socket.next().await? { return Err(classify(cause.into())); } }
                                continue;
                            }
                        }
                        let failed = matches!(value, redis::Value::ServerError(_));
                        let queued = matches!(&value, redis::Value::SimpleString(s) if s == "QUEUED");
                        if queued {
                            if suppresses_reply(&args) { suppresses_exec_reply = true; }
                            if verb == "SELECT" { if let Ok(database) = word(&args, 1).parse::<u32>() { if queued_databases.len() < 4096 { queued_databases.push((queued_count, database)); } else { reset_after_exec = true; } } }
                            if matches!(verb.as_str(), "AUTH" | "HELLO" | "RESET" | "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "UNSUBSCRIBE" | "PUNSUBSCRIBE" | "SUNSUBSCRIBE" | "MONITOR") { reset_after_exec = true; }
                            queued_count = queued_count.saturating_add(1);
                        }
                        if !failed && !queued {
                            match verb.as_str() {
                                "MULTI" => { transaction = true; queued_count = 0; queued_databases.clear(); reset_after_exec = false; suppresses_exec_reply = false; },
                                "EXEC" => { if let redis::Value::Array(results) = &value { for &(at, database) in &queued_databases { if results.get(at).is_some_and(|v| !matches!(v, redis::Value::ServerError(_))) { socket.options.database = Some(database); buffer.lock().unwrap().database = database; } } } },
                                "WATCH" => watched = true, "UNWATCH" => watched = false,
                                "AUTH" => socket.auth = Some(args.clone()),
                                "HELLO" => { if let Ok(version) = word(&args, 1).parse::<u8>() { socket.version = version; } if let Some(auth) = hello_auth(&args) { socket.auth = Some(auth); } },
                                "SELECT" => { if let Ok(database) = word(&args, 1).parse::<u32>() { socket.options.database = Some(database); buffer.lock().unwrap().database = database; } },
                                "MONITOR" => { monitoring = true; let mut b = buffer.lock().unwrap(); b.streaming = true; b.monitoring = true; },
                                "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" => { let entries = &mut subscriptions[subscription.unwrap()]; for channel in &args[1..] { entries.insert(channel.clone()); } buffer.lock().unwrap().streaming = true; },
                                "UNSUBSCRIBE" | "PUNSUBSCRIBE" | "SUNSUBSCRIBE" => { let entries = &mut subscriptions[subscription.unwrap()]; if args.len() == 1 { entries.clear(); } else { for channel in &args[1..] { entries.remove(channel); } } buffer.lock().unwrap().streaming = subscriptions.iter().any(|entries| !entries.is_empty()); },
                                "RESET" => { transaction = false; watched = false; socket.auth = None; socket.version = 2; socket.options.database = Some(0); subscriptions.iter_mut().for_each(HashSet::clear); let mut b = buffer.lock().unwrap(); b.database = 0; b.streaming = false; b.monitoring = false; },
                                _ => {},
                            }
                        }
                        if matches!(verb.as_str(), "EXEC" | "DISCARD") && (!failed && !queued || matches!(&value, redis::Value::ServerError(cause) if cause.code() == "EXECABORT")) { transaction = false; watched = false; suppresses_exec_reply = false; }
                        let closed = (verb == "QUIT" || verb == "EXEC" && reset_after_exec && matches!(value, redis::Value::Array(_))) && !failed && !queued;
                        let b = buffer.lock().unwrap();
                        return Ok(RedisConsoleReply { output: output(&value), failed, database: b.database, streaming: b.streaming, monitoring: b.monitoring, closed });
                    }
                    unreachable!()
                };
                let result = tokio::select! { biased;
                    _ = closed_signal(&state) => Err(if sent.load(Ordering::Acquire) { unknown_write() } else { closed() }),
                    _ = cancel.cancelled() => Err(if sent.load(Ordering::Acquire) { unknown_write() } else { closed() }),
                    _ = reply.closed() => break,
                    result = operation => result,
                };
                let terminal = result.as_ref().map_or(true, |r| r.closed);
                if let Err(cause) = &result { buffer.lock().unwrap().error_code = cause.code().map(str::to_owned); }
                let _ = reply.send(result); busy.store(false, Ordering::Release);
                if terminal { break; }
            },
            frame = socket.frames.recv() => match frame {
                Some(Ok(value)) => buffer.lock().unwrap().push(value),
                cause => { buffer.lock().unwrap().error_code = Some(cause.and_then(Result::err).and_then(|e| e.code().map(str::to_owned)).unwrap_or_else(|| "CONNECTION_FAILED".into())); break; },
            },
        }
    }
    socket.reader.abort();
    let _ = (&mut socket.reader).await;
}
