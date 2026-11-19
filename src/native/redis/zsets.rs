//! Bounded ranked binary ZSet values on the Session worker.

use super::*;

/// A binary member and finite score for an in-place addition or score update.
#[derive(JsObject)]
pub struct RedisZSetMember {
    pub member: Vec<u8>,
    pub score: f64,
}

pub(super) enum Mutation {
    Add(Vec<RedisZSetMember>),
    Remove(Vec<Vec<u8>>),
    Replace(Vec<u8>, RedisZSetMember),
}

pub(super) fn validate_mutation(
    key: &[u8],
    mutation: &Mutation,
    budget: usize,
) -> Result<(), JsError> {
    let count = match mutation {
        Mutation::Add(members) => members.len(),
        Mutation::Remove(members) => members.len(),
        Mutation::Replace(..) => 1,
    };
    if count == 0 || count > 200 {
        return Err(error(
            "INVALID_ARGUMENT",
            "ZSet mutations require 1 to 200 members",
        ));
    }
    let bytes = match mutation {
        Mutation::Add(members) => {
            if members.iter().any(|value| !value.score.is_finite()) {
                return Err(error(
                    "INVALID_ARGUMENT",
                    "ZSet input scores must be finite numbers",
                ));
            }
            members
                .iter()
                .fold(key.len(), |n, value| n.saturating_add(value.member.len()))
        }
        Mutation::Remove(members) => members
            .iter()
            .fold(key.len(), |n, member| n.saturating_add(member.len())),
        Mutation::Replace(previous, next) => {
            if !next.score.is_finite() {
                return Err(error(
                    "INVALID_ARGUMENT",
                    "ZSet input scores must be finite numbers",
                ));
            }
            key.len()
                .saturating_add(previous.len())
                .saturating_add(next.member.len())
        }
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
        Mutation::Add(_) => "ZADD",
        Mutation::Remove(_) => "ZREM",
        Mutation::Replace(..) => "EVAL",
    });
    if !matches!(&mutation, Mutation::Replace(..)) {
        command.arg(&key);
    }
    match mutation {
        Mutation::Add(members) => {
            command.arg("CH");
            for value in members {
                command.arg(value.score).arg(value.member);
            }
        }
        Mutation::Remove(members) => {
            for member in members {
                command.arg(member);
            }
        }
        Mutation::Replace(previous, next) => {
            // Check destination and ZREM permission before adding; insert before
            // removing the source so a singleton ZSet keeps its original TTL.
            command
                .arg(
                    r#"
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return -1 end
if ARGV[1] ~= ARGV[2] then
    if redis.call('ZSCORE', KEYS[1], ARGV[2]) then return -2 end
    redis.call('ZREM', KEYS[1], ARGV[2])
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
if ARGV[1] ~= ARGV[2] then redis.call('ZREM', KEYS[1], ARGV[1]) end
return 1
"#,
                )
                .arg(1)
                .arg(&key)
                .arg(previous)
                .arg(next.member)
                .arg(next.score);
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
            "Redis source member no longer exists",
        )),
        Ok(-2) => Err(error(
            "ROW_CONFLICT",
            "Redis destination member already exists",
        )),
        Ok(affected) => Ok(RedisMutation {
            affected: affected.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

/// Nonnegative decimal rank offset and positive decimal count (at most 200).
#[derive(JsObject)]
pub struct ZSetRangeOptions {
    pub offset: String,
    pub length: String,
}

/// One binary ZSet member, its floating-point score and exact zero-based rank.
#[derive(JsObject)]
pub struct RedisZSetItem {
    pub member: Vec<u8>,
    pub score: f64,
    pub rank: String,
}

/// An ascending rank page with atomically observed cardinality and expiration.
#[derive(JsObject)]
pub struct RedisZSetRange {
    pub exists: bool,
    pub items: Vec<RedisZSetItem>,
    pub offset: String,
    /// Exact total ZSet cardinality, not the returned item count.
    pub length: String,
    /// `missing`, `persistent` or `expiring`.
    pub expiration: String,
    /// Remaining exact milliseconds for expiring ZSets; otherwise null.
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    range: ZSetRangeOptions,
) -> Result<RedisZSetRange, JsError> {
    let (offset, count) = lists::range_bounds(&range.offset, &range.length)?;
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let mut pipeline = redis::pipe();
        pipeline
            .atomic()
            .cmd("TYPE")
            .arg(&key)
            .cmd("ZCARD")
            .arg(&key)
            .cmd("ZRANGE")
            .arg(&key)
            .arg(offset)
            .arg(offset + (count - 1))
            .arg("WITHSCORES")
            .cmd("PTTL")
            .arg(&key);
        let result: Result<(String, u64, Vec<(Vec<u8>, f64)>, i64), RequestError> = connection
            .as_mut()
            .unwrap()
            .query_pipeline(state, &key, &pipeline)
            .await;
        match result {
            Ok((kind, length, values, ttl)) => {
                let budget = state.options.max_response_bytes.unwrap_or(262144) as usize;
                if let Some((index, (member, _))) = values
                    .iter()
                    .enumerate()
                    .find(|(_, (member, _))| member.len() > budget)
                {
                    return Err(error(
                        "PAYLOAD_TOO_LARGE",
                        "ZSet member exceeds the configured byte budget",
                    )
                    .with("itemRank", (offset + index as i64).to_string())
                    .with("memberBytes", member.len().to_string()));
                }
                strings::check_payload(
                    values
                        .iter()
                        .fold(0usize, |n, (member, _)| n.saturating_add(member.len())),
                    budget,
                )?;
                return Ok(RedisZSetRange {
                    exists: kind != "none",
                    items: values
                        .into_iter()
                        .enumerate()
                        .map(|(n, (member, score))| RedisZSetItem {
                            member,
                            score,
                            rank: (offset + n as i64).to_string(),
                        })
                        .collect(),
                    offset: range.offset,
                    length: length.to_string(),
                    expiration: match ttl {
                        -2 => "missing",
                        -1 => "persistent",
                        _ => "expiring",
                    }
                    .into(),
                    ttl_ms: (ttl >= 0).then(|| ttl.to_string()),
                    database: state.database(),
                    generation: state.generation.load(Ordering::Acquire).to_string(),
                });
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
    unreachable!("the final read attempt always returns")
}
