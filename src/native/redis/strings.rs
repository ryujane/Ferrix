//! Binary String commands and response preparation on the Session worker.

use super::*;

/// Nonnegative decimal byte offset and positive decimal byte count.
#[derive(JsObject)]
pub struct StringRangeOptions {
    pub offset: String,
    pub length: String,
}

/// String replacement settings. Omitted settings preserve the current TTL.
#[derive(JsObject)]
pub struct SetStringOptions {
    /// Positive decimal milliseconds; replaces expiration explicitly.
    pub ttl_ms: Option<String>,
    /// Explicitly remove expiration. Cannot be combined with ttlMs.
    pub persist: Option<bool>,
}

/// A byte range and the exact total String length. Missing and empty are distinct.
#[derive(JsObject)]
pub struct RedisStringRange {
    pub exists: bool,
    pub value: Vec<u8>,
    pub offset: String,
    pub length: String,
    /// `missing`, `persistent` or `expiring`.
    pub expiration: String,
    /// Remaining exact milliseconds for an expiring String; otherwise null.
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

/// An acknowledged mutation and the Session context in which it completed.
#[derive(JsObject)]
pub struct RedisWrite {
    pub database: u32,
    pub generation: String,
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    range: StringRangeOptions,
) -> Result<RedisStringRange, JsError> {
    let offset = nonnegative_decimal(&range.offset)?;
    let count = nonnegative_decimal(&range.length)?;
    let end = offset + (count - 1); // Admission validated the inclusive end without overflow.
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
            .cmd("STRLEN")
            .arg(&key)
            .cmd("GETRANGE")
            .arg(&key)
            .arg(offset)
            .arg(end)
            .cmd("PTTL")
            .arg(&key);
        let result: Result<(String, u64, Vec<u8>, i64), RequestError> = connection
            .as_mut()
            .unwrap()
            .query_pipeline(state, &key, &pipeline)
            .await;
        match result {
            Ok((kind, length, value, ttl)) => {
                check_payload(
                    value.len(),
                    state.options.max_response_bytes.unwrap_or(262_144) as usize,
                )?;
                return Ok(RedisStringRange {
                    exists: kind != "none",
                    value,
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

pub(super) async fn set(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    value: Vec<u8>,
    options: SetStringOptions,
    dispatched: &AtomicBool,
) -> Result<RedisWrite, JsError> {
    let ttl = expiry(&options)?;
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd("SET");
    command.arg(&key).arg(value);
    if let Some(ttl) = ttl {
        command.arg("PX").arg(ttl);
    } else if !options.persist.unwrap_or(false) {
        command.arg("KEEPTTL");
    }
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
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) fn expiry(options: &SetStringOptions) -> Result<Option<i64>, JsError> {
    if options.persist.unwrap_or(false) && options.ttl_ms.is_some() {
        return Err(error(
            "INVALID_ARGUMENT",
            "Choose either persistence or a TTL",
        ));
    }
    options
        .ttl_ms
        .as_deref()
        .map(|ttl| {
            let value = nonnegative_decimal(ttl)?;
            if value == 0 {
                return Err(error("INVALID_ARGUMENT", "TTL must be positive"));
            }
            Ok(value)
        })
        .transpose()
}

pub(super) fn check_payload(bytes: usize, budget: usize) -> Result<(), JsError> {
    if bytes > budget {
        Err(error(
            "PAYLOAD_TOO_LARGE",
            "Binary payload exceeds the configured byte budget",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn validate_range(range: &StringRangeOptions, budget: usize) -> Result<(), JsError> {
    let offset = nonnegative_decimal(&range.offset)?;
    let length = nonnegative_decimal(&range.length)?;
    if length == 0 || offset.checked_add(length - 1).is_none() {
        return Err(error(
            "INVALID_ARGUMENT",
            "String range must have a positive length and a signed 64-bit inclusive end",
        ));
    }
    if length as u64 > budget as u64 {
        return Err(error(
            "PAYLOAD_TOO_LARGE",
            "Requested String range exceeds the configured byte budget",
        ));
    }
    Ok(())
}
