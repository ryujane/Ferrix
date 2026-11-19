//! Bounded binary Set scans and membership edits on the Session worker.

use super::*;
use continuation::CollectionProgress;

/// A bounded Set page and metadata observed atomically with its source SSCAN reply.
#[derive(JsObject)]
pub struct RedisSetPage {
    pub exists: bool,
    pub members: Vec<Vec<u8>>,
    /// Exact member count, not a count of unique entries visited by the scan.
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

pub(super) enum Mutation {
    Add(Vec<Vec<u8>>),
    Remove(Vec<Vec<u8>>),
    Replace(Vec<u8>, Vec<u8>),
}

pub(super) fn validate_mutation(
    key: &[u8],
    mutation: &Mutation,
    budget: usize,
) -> Result<(), JsError> {
    if let Mutation::Replace(previous, next) = mutation {
        return strings::check_payload(
            key.len()
                .saturating_add(previous.len())
                .saturating_add(next.len()),
            budget,
        );
    }
    let (Mutation::Add(members) | Mutation::Remove(members)) = mutation else {
        unreachable!()
    };
    if members.is_empty() || members.len() > 200 {
        return Err(error(
            "INVALID_ARGUMENT",
            "Set mutations require from 1 to 200 members",
        ));
    }
    let bytes = members
        .iter()
        .fold(key.len(), |n, member| n.saturating_add(member.len()));
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
    let adding = matches!(&mutation, Mutation::Add(_));
    let command = match mutation {
        Mutation::Replace(previous, next) => {
            let mut command = redis::cmd("EVAL");
            // Add before removing so replacing the last member preserves the TTL.
            // The absent destination also lets SREM permissions fail before any write.
            command
                .arg(
                    r#"
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return -1 end
if ARGV[1] == ARGV[2] then return 0 end
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) ~= 0 then return -2 end
redis.call('SREM', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[1], ARGV[1])
return 1
"#,
                )
                .arg(1)
                .arg(&key)
                .arg(previous)
                .arg(next);
            command
        }
        Mutation::Add(members) | Mutation::Remove(members) => {
            let mut command = redis::cmd(if adding { "SADD" } else { "SREM" });
            command.arg(&key);
            for member in members {
                command.arg(member);
            }
            command
        }
    };
    match connection
        .as_mut()
        .unwrap()
        .query::<i64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(-1) => Err(error(
            "MEMBER_NOT_FOUND",
            "Redis source member no longer exists",
        )),
        Ok(-2) => Err(error(
            "MEMBER_CONFLICT",
            "Redis destination member already exists",
        )),
        Ok(count) => Ok(RedisMutation {
            affected: count.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

/// An owned Set scan. Each page reads at most one SSCAN reply or drains its remainder.
#[class]
pub struct RedisSetScan {
    state: Arc<SetState>,
}

pub(super) type SetState = continuation::State<CollectionProgress<Vec<u8>>>;
pub(super) type NextPage = continuation::NextPage<CollectionProgress<Vec<u8>>>;

impl RedisSetScan {
    pub(super) fn start(session: Arc<SessionState>, key: Vec<u8>) -> Result<Self, JsError> {
        let state = SetState::collection(session, key, "Set")?;
        Ok(Self { state })
    }
}

#[class]
impl RedisSetScan {
    /// Deliver at most 200 members and 256 KiB (or the lower Session byte budget).
    /// Concurrent calls reject BUSY; stale generations reject CURSOR_INVALIDATED.
    pub fn next_page(&self) -> Result<Later<RedisSetPage>, JsError> {
        let page = self.state.next_page()?;
        self.state
            .session
            .submit(Operation::SetScan(page), |result| match result {
                OperationResult::SetPage(page) => page,
                _ => unreachable!(),
            })
    }

    /// Cancel local work and release retained members and shared continuation capacity.
    pub fn cancel(&self) {
        self.state.fail("CANCELLED");
    }
}
impl Drop for RedisSetScan {
    fn drop(&mut self) {
        self.state.fail("CANCELLED");
    }
}
pub(super) async fn next(
    state: &SessionState,
    connection: &mut Option<Connection>,
    page: NextPage,
) -> Result<RedisSetPage, JsError> {
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
                .cmd("SCARD")
                .arg(key)
                .cmd("SSCAN")
                .arg(key)
                .arg(p.cursor)
                .arg("COUNT")
                .arg(200)
                .cmd("PTTL")
                .arg(key);
            key.clone()
        };
        type Reply = (String, u64, (u64, Vec<Vec<u8>>), i64);
        let reply: Result<Reply, RequestError> = connection
            .as_mut()
            .unwrap()
            .query_continuation_pipeline(state, &key, &commands)
            .await;
        let (kind, length, (cursor, members), ttl) = match reply {
            Ok(reply) => reply,
            Err(cause) => {
                if cause.recoverable() {
                    discard_transports(connection);
                    state.advance_generation();
                    scan.fail("CURSOR_INVALIDATED");
                    return Err(error(
                        "CURSOR_INVALIDATED",
                        "Redis Set scan connection was lost",
                    ));
                }
                return Err(cause.into_js());
            }
        };
        let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
        if members.iter().any(|member| member.len() > budget) {
            scan.fail("PAYLOAD_TOO_LARGE");
            return Err(error(
                "PAYLOAD_TOO_LARGE",
                "One Set member exceeds the page budget",
            ));
        }
        let bytes = members
            .iter()
            .fold(0usize, |n, member| n.saturating_add(member.len()));
        let retained = match state.continuations.retain(members.len(), bytes) {
            Ok(retained) => retained,
            Err(cause) => {
                scan.fail("RETENTION_LIMIT");
                return Err(cause);
            }
        };
        let mut p = scan.progress.lock().unwrap();
        if let Some(code) = p.buffer.failure {
            return Err(error(code, "Redis Set scan is no longer active"));
        }
        p.started = true;
        p.cursor = cursor;
        p.exists = kind != "none";
        p.length = length;
        p.ttl = ttl;
        p.buffer.pending = members.into();
        p.buffer.retained = Some(retained);
    }
    scan.validate()?;
    let budget = (state.options.max_response_bytes.unwrap_or(262144) as usize).min(262144);
    let mut p = scan.progress.lock().unwrap();
    let (members, complete) = p.drain(budget, Vec::len);
    Ok(RedisSetPage {
        exists: p.exists,
        members,
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
