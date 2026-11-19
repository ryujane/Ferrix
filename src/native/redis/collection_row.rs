//! Targeted collection row reads and deletions on the Session worker.

use super::*;

#[derive(JsObject)]
pub struct CollectionRowTarget {
    /// `hash`, `list`, `set` or `zset`.
    pub key_type: String,
    pub field: Option<Vec<u8>>,
    /// Exact nonnegative List index.
    pub index: Option<String>,
    pub member: Option<Vec<u8>>,
    /// Required for List deletion: reject ROW_CHANGED if the indexed value changed.
    pub expected_value: Option<Vec<u8>>,
}

#[derive(JsObject)]
pub struct RedisCollectionRow {
    pub exists: bool,
    /// Binary field value, List value or member. Empty and missing are distinct.
    pub value: Option<Vec<u8>>,
    pub score: Option<f64>,
    pub database: u32,
    pub generation: String,
}

pub(super) fn validate(
    key: &[u8],
    target: &CollectionRowTarget,
    budget: usize,
    deleting: bool,
) -> Result<(), JsError> {
    strings::check_payload(
        key.len()
            .saturating_add(target.field.as_ref().map_or(0, Vec::len))
            .saturating_add(target.member.as_ref().map_or(0, Vec::len))
            .saturating_add(target.expected_value.as_ref().map_or(0, Vec::len)),
        budget,
    )?;
    match target.key_type.as_str() {
        "hash" if target.field.is_some() => Ok(()),
        "set" | "zset" if target.member.is_some() => Ok(()),
        "list" if target.index.is_some() && (!deleting || target.expected_value.is_some()) => {
            nonnegative_decimal(target.index.as_deref().unwrap()).map(|_| ())
        }
        _ => Err(error(
            "INVALID_ARGUMENT",
            "Choose a supported collection row",
        )),
    }
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    target: CollectionRowTarget,
) -> Result<RedisCollectionRow, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let connection_ref = connection.as_mut().unwrap();
        let result: Result<(Option<Vec<u8>>, Option<f64>), RequestError> =
            match target.key_type.as_str() {
                "hash" => connection_ref
                    .query::<Option<Vec<u8>>>(
                        state,
                        Some(&key),
                        redis::cmd("HGET")
                            .arg(&key)
                            .arg(target.field.as_ref().unwrap()),
                        None,
                    )
                    .await
                    .map(|value| (value, None)),
                "list" => connection_ref
                    .query::<Option<Vec<u8>>>(
                        state,
                        Some(&key),
                        redis::cmd("LINDEX")
                            .arg(&key)
                            .arg(target.index.as_ref().unwrap()),
                        None,
                    )
                    .await
                    .map(|value| (value, None)),
                "set" => connection_ref
                    .query::<bool>(
                        state,
                        Some(&key),
                        redis::cmd("SISMEMBER")
                            .arg(&key)
                            .arg(target.member.as_ref().unwrap()),
                        None,
                    )
                    .await
                    .map(|exists| (exists.then(|| target.member.clone().unwrap()), None)),
                "zset" => connection_ref
                    .query::<Option<f64>>(
                        state,
                        Some(&key),
                        redis::cmd("ZSCORE")
                            .arg(&key)
                            .arg(target.member.as_ref().unwrap()),
                        None,
                    )
                    .await
                    .map(|score| (score.map(|_| target.member.clone().unwrap()), score)),
                _ => unreachable!("validated at admission"),
            };
        match result {
            Ok((value, score)) => {
                strings::check_payload(
                    value.as_ref().map_or(0, Vec::len),
                    state.options.max_response_bytes.unwrap_or(262_144) as usize,
                )?;
                return Ok(RedisCollectionRow {
                    exists: value.is_some(),
                    value,
                    score,
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
    unreachable!()
}

pub(super) async fn delete(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    target: CollectionRowTarget,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let command = match target.key_type.as_str() {
        "hash" => {
            let mut command = redis::cmd("HDEL");
            command.arg(&key).arg(target.field.unwrap());
            command
        }
        "set" => {
            let mut command = redis::cmd("SREM");
            command.arg(&key).arg(target.member.unwrap());
            command
        }
        "zset" => {
            let mut command = redis::cmd("ZREM");
            command.arg(&key).arg(target.member.unwrap());
            command
        }
        "list" => {
            let mut command = redis::cmd("EVAL");
            // A collision-checked marker removes this position only, including when
            // several entries have the same value. Check permissions before LSET.
            let marker = format!("\0ferrix:list-row:{}", uuid::Uuid::new_v4()).into_bytes();
            command
                .arg(
                    r#"
local current = redis.call('LINDEX', KEYS[1], ARGV[1])
if not current then return 0 end
if current ~= ARGV[2] then return -1 end
if redis.call('LPOS', KEYS[1], ARGV[3]) then return -1 end
redis.call('LREM', KEYS[1], 1, ARGV[3])
redis.call('LSET', KEYS[1], ARGV[1], ARGV[3])
return redis.call('LREM', KEYS[1], 1, ARGV[3])
"#,
                )
                .arg(1)
                .arg(&key)
                .arg(target.index.unwrap())
                .arg(target.expected_value.unwrap())
                .arg(marker);
            command
        }
        _ => unreachable!("validated at admission"),
    };
    match connection
        .as_mut()
        .unwrap()
        .query::<i64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(-1) => Err(error(
            "ROW_CHANGED",
            "The indexed List value changed; reload it before deleting",
        )),
        Ok(count) => Ok(RedisMutation {
            affected: count.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}
