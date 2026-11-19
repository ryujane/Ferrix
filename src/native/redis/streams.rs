//! Bounded binary Stream history and explicit message append/delete operations.

use super::*;

#[derive(JsObject)]
pub struct StreamRangeOptions {
    /// Read entries strictly after this full `milliseconds-sequence` ID, or from the start.
    pub after: Option<String>,
    /// From 1 to 200 entries; defaults to 200. The byte budget can shorten a page.
    pub count: Option<u32>,
}

#[derive(JsObject)]
pub struct RedisStreamEntry {
    /// Exact decimal ID; never converted to a floating-point number.
    pub id: String,
    /// Ordered binary field/value pairs, including repeated field names.
    pub fields: Vec<RedisHashField>,
}

#[derive(JsObject)]
pub struct RedisStreamRange {
    pub exists: bool,
    pub entries: Vec<RedisStreamEntry>,
    /// Exact XLEN observed with this range and expiration.
    pub length: String,
    pub complete: bool,
    /// Pass this as `after` for the next page, null when complete.
    pub next_after: Option<String>,
    pub expiration: String,
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

#[derive(JsObject)]
pub struct StreamAppendOptions {
    /// `*` (the default) generates an ID; otherwise an exact full decimal Stream ID.
    pub id: Option<String>,
    /// From 1 to 200 ordered binary field/value pairs. Duplicate names are preserved.
    pub fields: Vec<RedisHashField>,
}

#[derive(JsObject)]
pub struct RedisStreamAppend {
    /// The exact ID acknowledged by XADD.
    pub id: String,
    pub database: u32,
    pub generation: String,
}

fn valid_id(id: &str) -> bool {
    id.split_once('-').is_some_and(|(ms, seq)| {
        [ms, seq].into_iter().all(|part| {
            !part.is_empty()
                && part.len() <= 20
                && (part == "0" || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u64>().is_ok()
        })
    })
}

pub(super) fn validate_append(
    key: &[u8],
    options: &StreamAppendOptions,
    budget: usize,
) -> Result<(), JsError> {
    let id = options.id.as_deref().unwrap_or("*");
    if (id != "*" && (!valid_id(id) || id == "0-0"))
        || options.fields.is_empty()
        || options.fields.len() > 200
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "Stream messages require a valid ID and 1 to 200 field/value pairs",
        ));
    }
    let bytes = options
        .fields
        .iter()
        .fold(key.len().saturating_add(id.len()), |n, pair| {
            n.saturating_add(pair.field.len())
                .saturating_add(pair.value.len())
        });
    strings::check_payload(bytes, budget)
}

pub(super) fn validate_delete(key: &[u8], id: &str, budget: usize) -> Result<(), JsError> {
    if !valid_id(id) {
        return Err(error(
            "INVALID_ARGUMENT",
            "Expected a full unsigned 64-bit Stream ID",
        ));
    }
    strings::check_payload(key.len().saturating_add(id.len()), budget)
}

pub(super) async fn append(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: StreamAppendOptions,
    dispatched: &AtomicBool,
) -> Result<RedisStreamAppend, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = redis::cmd("XADD");
    command.arg(&key).arg(options.id.as_deref().unwrap_or("*"));
    for pair in options.fields {
        command.arg(pair.field).arg(pair.value);
    }
    match connection
        .as_mut()
        .unwrap()
        .query::<String>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(id) => Ok(RedisStreamAppend {
            id,
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause)
            if cause.detail().is_some_and(|detail| {
                detail.contains("equal or smaller than the target stream top item")
            }) =>
        {
            Err(error(
                "STREAM_ID_ORDER",
                "The Stream ID must be greater than the last generated ID",
            ))
        }
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) async fn delete(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    id: String,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(
            state,
            Some(&key),
            redis::cmd("XDEL").arg(&key).arg(id),
            Some(dispatched),
        )
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

pub(super) fn validate(
    key: &[u8],
    options: &StreamRangeOptions,
    budget: usize,
) -> Result<(), JsError> {
    strings::check_payload(key.len(), budget)?;
    if !(1..=200).contains(&options.count.unwrap_or(200)) {
        return Err(error(
            "INVALID_ARGUMENT",
            "Stream ranges require 1 to 200 entries",
        ));
    }
    if let Some(after) = &options.after {
        if !valid_id(after) {
            return Err(error(
                "INVALID_ARGUMENT",
                "Expected a full unsigned 64-bit Stream ID",
            ));
        }
    }
    Ok(())
}

type RawEntries = Vec<(String, Vec<Vec<u8>>)>;

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: StreamRangeOptions,
) -> Result<RedisStreamRange, JsError> {
    let count = options.count.unwrap_or(200) as usize;
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let mut pipeline = redis::pipe();
        // Inclusive XRANGE plus dropping `after` works before Redis 6.2 too,
        // including a deleted boundary ID and the maximum 64-bit Stream ID.
        // Fetch space for that boundary and one entry of lookahead.
        pipeline
            .atomic()
            .cmd("TYPE")
            .arg(&key)
            .cmd("XLEN")
            .arg(&key)
            .cmd("XRANGE")
            .arg(&key)
            .arg(options.after.as_deref().unwrap_or("-"))
            .arg("+")
            .arg("COUNT")
            .arg(count + 2)
            .cmd("PTTL")
            .arg(&key);
        let result: Result<(String, u64, RawEntries, i64), RequestError> = connection
            .as_mut()
            .unwrap()
            .query_pipeline(state, &key, &pipeline)
            .await;
        match result {
            Ok((kind, length, values, ttl)) => {
                let budget =
                    (state.options.max_response_bytes.unwrap_or(262_144) as usize).min(262_144);
                let mut used = 0usize;
                let mut entries = Vec::new();
                let mut complete = true;
                for (id, fields) in values {
                    if options.after.as_deref() == Some(id.as_str()) {
                        continue;
                    }
                    if entries.len() == count {
                        complete = false;
                        break;
                    }
                    let bytes = fields
                        .iter()
                        .fold(id.len(), |n, value| n.saturating_add(value.len()));
                    if bytes > budget && entries.is_empty() {
                        return Err(error(
                            "PAYLOAD_TOO_LARGE",
                            "Stream entry exceeds the configured byte budget",
                        )
                        .with("entryId", id));
                    }
                    if used.saturating_add(bytes) > budget {
                        complete = false;
                        break;
                    }
                    if fields.len() % 2 != 0 {
                        return Err(error(
                            "SERVER_ERROR",
                            "Redis returned an incomplete Stream field/value pair",
                        ));
                    }
                    used += bytes;
                    let mut pairs = fields.into_iter();
                    let mut fields = Vec::new();
                    while let Some(field) = pairs.next() {
                        fields.push(RedisHashField {
                            field,
                            value: pairs.next().unwrap(),
                        });
                    }
                    entries.push(RedisStreamEntry { id, fields });
                }
                let next_after = if complete {
                    None
                } else {
                    entries.last().map(|entry| entry.id.clone())
                };
                return Ok(RedisStreamRange {
                    exists: kind != "none",
                    entries,
                    length: length.to_string(),
                    complete,
                    next_after,
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
    unreachable!()
}
