//! Bounded binary Hash scans and field edits on the Session worker.

use super::*;
use continuation::CollectionProgress;

/// One binary Hash field and its binary value. Empty fields and values are valid.
#[derive(JsObject)]
pub struct RedisHashField {
    pub field: Vec<u8>,
    pub value: Vec<u8>,
}

/// A bounded Hash page and metadata observed atomically with its source HSCAN reply.
#[derive(JsObject)]
pub struct RedisHashPage {
    pub exists: bool,
    pub fields: Vec<RedisHashField>,
    /// Exact field count, not a count of unique entries visited by the scan.
    pub length: String,
    pub complete: bool,
    /// Opaque generation-bound progress marker; null when complete.
    pub continuation: Option<String>,
    /// `missing`, `persistent` or `expiring` at the source reply's observation.
    pub expiration: String,
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

/// An owned Hash scan. Each page reads at most one HSCAN reply or drains its remainder.
#[class]
pub struct RedisHashScan {
    state: Arc<HashState>,
}

pub(super) type HashState = continuation::State<CollectionProgress<RedisHashField>>;
pub(super) type NextPage = continuation::NextPage<CollectionProgress<RedisHashField>>;

impl RedisHashScan {
    pub(super) fn start(session: Arc<SessionState>, key: Vec<u8>) -> Result<Self, JsError> {
        let state = HashState::collection(session, key, "Hash")?;
        Ok(Self { state })
    }
}

#[class]
impl RedisHashScan {
    /// Deliver at most 200 fields and 256 KiB (or the lower Session byte budget).
    /// Concurrent calls reject BUSY; stale generations reject CURSOR_INVALIDATED.
    pub fn next_page(&self) -> Result<Later<RedisHashPage>, JsError> {
        let page = self.state.next_page()?;
        self.state
            .session
            .submit(Operation::HashScan(page), |result| match result {
                OperationResult::HashPage(page) => page,
                _ => unreachable!(),
            })
    }

    /// Cancel local work and release retained fields and shared continuation capacity.
    pub fn cancel(&self) {
        self.state.fail("CANCELLED");
    }
}
impl Drop for RedisHashScan {
    fn drop(&mut self) {
        self.state.fail("CANCELLED");
    }
}
pub(super) async fn next(
    state: &SessionState,
    connection: &mut Option<Connection>,
    page: NextPage,
) -> Result<RedisHashPage, JsError> {
    let scan = &page.state;
    scan.validate()?;
    let needs_read = scan.progress.lock().unwrap().needs_read();
    if needs_read {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
            scan.validate()?;
        }
        let mut commands = redis::pipe();
        let key = {
            let p = scan.progress.lock().unwrap();
            let key = p.key.as_ref().ok_or_else(scan::cancelled_error)?;
            commands
                .atomic()
                .cmd("TYPE")
                .arg(key)
                .cmd("HLEN")
                .arg(key)
                .cmd("HSCAN")
                .arg(key)
                .arg(p.cursor)
                .arg("COUNT")
                .arg(200)
                .cmd("PTTL")
                .arg(key);
            key.clone()
        };
        type Reply = (String, u64, (u64, Vec<(Vec<u8>, Vec<u8>)>), i64);
        let reply: Result<Reply, RequestError> = connection
            .as_mut()
            .unwrap()
            .query_continuation_pipeline(state, &key, &commands)
            .await;
        let (kind, length, (cursor, fields), ttl) = match reply {
            Ok(reply) => reply,
            Err(cause) => {
                if cause.recoverable() {
                    discard_transports(connection);
                    state.advance_generation();
                    scan.fail("CURSOR_INVALIDATED");
                    return Err(error(
                        "CURSOR_INVALIDATED",
                        "Redis Hash scan connection was lost",
                    ));
                }
                return Err(cause.into_js());
            }
        };
        let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
        if fields
            .iter()
            .any(|(field, value)| field.len().saturating_add(value.len()) > budget)
        {
            scan.fail("PAYLOAD_TOO_LARGE");
            return Err(error(
                "PAYLOAD_TOO_LARGE",
                "One Hash field/value exceeds the page budget",
            ));
        }
        let bytes = fields.iter().fold(0usize, |n, (f, v)| {
            n.saturating_add(f.len()).saturating_add(v.len())
        });
        let retained = match state.continuations.retain(fields.len(), bytes) {
            Ok(retained) => retained,
            Err(cause) => {
                scan.fail("RETENTION_LIMIT");
                return Err(cause);
            }
        };
        let mut p = scan.progress.lock().unwrap();
        if let Some(code) = p.buffer.failure {
            return Err(error(code, "Redis Hash scan is no longer active"));
        }
        p.started = true;
        p.cursor = cursor;
        p.exists = kind != "none";
        p.length = length;
        p.ttl = ttl;
        p.buffer.pending = fields
            .into_iter()
            .map(|(field, value)| RedisHashField { field, value })
            .collect();
        p.buffer.retained = Some(retained);
    }
    scan.validate()?;
    let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
    let mut p = scan.progress.lock().unwrap();
    let (fields, complete) = p.drain(budget, |item| item.field.len() + item.value.len());
    Ok(RedisHashPage {
        exists: p.exists,
        fields,
        length: p.length.to_string(),
        complete,
        continuation: (!complete).then(|| p.buffer.sequence.to_string()),
        expiration: match p.ttl {
            -2 => "missing",
            -1 => "persistent",
            _ => "expiring",
        }
        .into(),
        ttl_ms: (p.ttl >= 0).then(|| p.ttl.to_string()),
        database: scan.database,
        generation: scan.generation.to_string(),
    })
}

pub(super) enum Mutation {
    Set(Vec<RedisHashField>),
    Delete(Vec<Vec<u8>>),
    Replace(Vec<u8>, RedisHashField),
}

pub(super) fn validate_mutation(
    key: &[u8],
    mutation: &Mutation,
    budget: usize,
) -> Result<(), JsError> {
    let items = match mutation {
        Mutation::Set(fields) => fields.len(),
        Mutation::Delete(fields) => fields.len(),
        Mutation::Replace(..) => 1,
    };
    if items == 0 || items > 200 {
        return Err(error(
            "INVALID_ARGUMENT",
            "Hash mutations require from 1 to 200 fields",
        ));
    }
    let bytes = match mutation {
        Mutation::Set(fields) => fields.iter().fold(key.len(), |n, item| {
            n.saturating_add(item.field.len())
                .saturating_add(item.value.len())
        }),
        Mutation::Delete(fields) => fields
            .iter()
            .fold(key.len(), |n, field| n.saturating_add(field.len())),
        Mutation::Replace(previous, next) => key
            .len()
            .saturating_add(previous.len())
            .saturating_add(next.field.len())
            .saturating_add(next.value.len()),
    };
    strings::check_payload(bytes, budget)
}

pub(super) async fn mutate(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    mutation: Mutation,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd(match &mutation {
        Mutation::Set(_) => "HSET",
        Mutation::Delete(_) => "HDEL",
        Mutation::Replace(..) => "EVAL",
    });
    if !matches!(&mutation, Mutation::Replace(..)) {
        command.arg(&key);
    }
    match mutation {
        Mutation::Set(fields) => {
            for item in fields {
                command.arg(item.field).arg(item.value);
            }
        }
        Mutation::Delete(fields) => {
            for field in fields {
                command.arg(field);
            }
        }
        Mutation::Replace(previous, next) => {
            // Probe HDEL on the absent destination before writing. Add first so
            // renaming the final field never removes the Key or its TTL.
            command
                .arg(
                    r#"
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
if ARGV[1] ~= ARGV[2] then
    if redis.call('HEXISTS', KEYS[1], ARGV[2]) ~= 0 then return -2 end
    redis.call('HDEL', KEYS[1], ARGV[2])
end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
if ARGV[1] ~= ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) end
return 1
"#,
                )
                .arg(1)
                .arg(&key)
                .arg(previous)
                .arg(next.field)
                .arg(next.value);
        }
    }
    match connection
        .as_mut()
        .unwrap()
        .query::<i64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(-1) => Err(error(
            "ROW_NOT_FOUND",
            "Redis source field no longer exists",
        )),
        Ok(-2) => Err(error(
            "ROW_CONFLICT",
            "Redis destination field already exists",
        )),
        Ok(count) => Ok(RedisMutation {
            affected: count.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}
