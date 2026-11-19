//! Bounded binary List ranges and in-place edits on the Session worker.

use super::*;

/// Nonnegative decimal item offset and positive decimal item count (at most 200).
#[derive(JsObject)]
pub struct ListRangeOptions {
    pub offset: String,
    pub length: String,
}

/// One binary List value and its exact nonnegative index at this observation.
#[derive(JsObject)]
pub struct RedisListItem {
    pub index: String,
    pub value: Vec<u8>,
}

/// A bounded ordered range with atomically observed total length and expiration.
#[derive(JsObject)]
pub struct RedisListRange {
    pub exists: bool,
    pub items: Vec<RedisListItem>,
    pub offset: String,
    /// Exact total List length, not the returned item count.
    pub length: String,
    /// `missing`, `persistent` or `expiring`.
    pub expiration: String,
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

/// An acknowledged push's exact new total List length and Session context.
#[derive(JsObject)]
pub struct RedisListPush {
    pub length: String,
    pub database: u32,
    pub generation: String,
}

pub(super) fn validate_push(
    key: &[u8],
    values: &[Vec<u8>],
    direction: &str,
    budget: usize,
) -> Result<(), JsError> {
    if values.is_empty() || values.len() > 200 || !matches!(direction, "left" | "right") {
        return Err(error(
            "INVALID_ARGUMENT",
            "List pushes require 1 to 200 values and an explicit left or right direction",
        ));
    }
    strings::check_payload(
        values
            .iter()
            .fold(key.len(), |n, value| n.saturating_add(value.len())),
        budget,
    )
}

pub(super) async fn push(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    values: Vec<Vec<u8>>,
    direction: String,
    dispatched: &AtomicBool,
) -> Result<RedisListPush, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd(if direction == "left" {
        "LPUSH"
    } else {
        "RPUSH"
    });
    command.arg(&key);
    for value in values {
        command.arg(value);
    }
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(length) => Ok(RedisListPush {
            length: length.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) fn validate_range(range: &ListRangeOptions) -> Result<(), JsError> {
    range_bounds(&range.offset, &range.length).map(|_| ())
}

pub(super) fn range_bounds(offset: &str, length: &str) -> Result<(i64, i64), JsError> {
    let offset = nonnegative_decimal(offset)?;
    let length = nonnegative_decimal(length)?;
    if !(1..=200).contains(&length) || offset.checked_add(length - 1).is_none() {
        return Err(error(
            "INVALID_ARGUMENT",
            "Ranges require 1 to 200 items and a signed 64-bit inclusive end",
        ));
    }
    Ok((offset, length))
}

pub(super) fn signed(value: &str) -> Result<i64, JsError> {
    if let Some(magnitude) = value.strip_prefix('-') {
        if magnitude.is_empty()
            || magnitude.starts_with('0')
            || magnitude.len() > 19
            || !magnitude.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(error(
                "INVALID_ARGUMENT",
                "Expected a canonical signed 64-bit decimal integer",
            ));
        }
        value.parse().map_err(|_| {
            error(
                "INVALID_ARGUMENT",
                "Decimal integer exceeds signed 64-bit range",
            )
        })
    } else {
        nonnegative_decimal(value)
    }
}

pub(super) fn removal_count(value: &str) -> Result<i64, JsError> {
    let count = signed(value)?;
    // Redis LREM accepts -LONG_MAX..LONG_MAX so the magnitude can be negated.
    if count == i64::MIN {
        return Err(error(
            "INVALID_ARGUMENT",
            "List removal count magnitude must not exceed signed 64-bit maximum",
        ));
    }
    Ok(count)
}

pub(super) async fn set(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    index: String,
    value: Vec<u8>,
    dispatched: &AtomicBool,
) -> Result<RedisWrite, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd("LSET");
    command.arg(&key).arg(signed(&index)?).arg(value);
    match connection
        .as_mut()
        .unwrap()
        .query::<()>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(()) => Ok(RedisWrite {
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) if cause.detail() == Some("no such key") => {
            Err(error("KEY_NOT_FOUND", "Redis List Key does not exist").with("serverCode", "ERR"))
        }
        Err(cause) if cause.detail() == Some("index out of range") => Err(error(
            "INDEX_OUT_OF_RANGE",
            "Redis List index is out of range",
        )
        .with("serverCode", "ERR")),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) async fn remove(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    value: Vec<u8>,
    count: String,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd("LREM");
    command.arg(&key).arg(removal_count(&count)?).arg(value);
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(affected) => Ok(RedisMutation {
            affected: affected.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    range: ListRangeOptions,
) -> Result<RedisListRange, JsError> {
    let offset = nonnegative_decimal(&range.offset)?;
    let count = nonnegative_decimal(&range.length)?;
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
            .cmd("LLEN")
            .arg(&key)
            .cmd("LRANGE")
            .arg(&key)
            .arg(offset)
            .arg(offset + (count - 1))
            .cmd("PTTL")
            .arg(&key);
        let result: Result<(String, u64, Vec<Vec<u8>>, i64), RequestError> = connection
            .as_mut()
            .unwrap()
            .query_pipeline(state, &key, &pipeline)
            .await;
        match result {
            Ok((kind, length, values, ttl)) => {
                let bytes = values
                    .iter()
                    .fold(0usize, |n, value| n.saturating_add(value.len()));
                strings::check_payload(
                    bytes,
                    state.options.max_response_bytes.unwrap_or(262144) as usize,
                )?;
                return Ok(RedisListRange {
                    exists: kind != "none",
                    items: values
                        .into_iter()
                        .enumerate()
                        .map(|(n, value)| RedisListItem {
                            index: (offset + n as i64).to_string(),
                            value,
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
