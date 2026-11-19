//! RedisJSON documents and JSONPath operations on the existing Session lanes.
use super::*;

#[derive(JsObject)]
pub struct JsonOptions {
    /// Omit to read/replace the complete document. Otherwise use JSONPath ($...).
    /// Query replies retain RedisJSON's outer array of matches.
    pub path: Option<String>,
}

#[derive(JsObject)]
pub struct RedisJson {
    pub exists: bool,
    /// A complete JSON document, or the array of JSONPath matches.
    pub value: String,
    pub path: Option<String>,
    /// Exact match count for JSONPath queries; null for a whole document.
    pub matches: Option<String>,
    pub expiration: String,
    pub ttl_ms: Option<String>,
    pub database: u32,
    pub generation: String,
}

pub(super) fn is_json(kind: &str) -> bool {
    kind.eq_ignore_ascii_case("rejson-rl") || kind.eq_ignore_ascii_case("json")
}
pub(super) fn key_type(kind: &str) -> String {
    if is_json(kind) {
        "json".into()
    } else {
        kind.into()
    }
}
pub(super) fn validate(
    key: &[u8],
    options: &JsonOptions,
    value: Option<&str>,
    budget: usize,
) -> Result<(), JsError> {
    if let Some(path) = &options.path {
        if !path.starts_with('$') || path.len() > 4096 || path.contains('\0') {
            return Err(error("JSON_PATH_INVALID", "Use a JSONPath starting with $"));
        }
    }
    strings::check_payload(
        key.len()
            .saturating_add(options.path.as_ref().map_or(0, String::len))
            .saturating_add(value.map_or(0, str::len)),
        budget,
    )?;
    if let Some(value) = value {
        serde_json::from_str::<&serde_json::value::RawValue>(value)
            .map_err(|_| error("INVALID_JSON", "Enter a valid JSON value"))?;
    }
    Ok(())
}

pub(super) fn mapped_error(cause: RequestError) -> JsError {
    if cause.server_code().as_deref() == Some("NOPERM") {
        return cause.into_js();
    }
    let nested = cause
        .redis_cause()
        .and_then(|cause| cause.clone().into_server_errors());
    let details = cause.detail().into_iter().chain(
        nested
            .as_ref()
            .into_iter()
            .flat_map(|errors| errors.iter().filter_map(|(_, cause)| cause.details())),
    );
    for detail in details {
        let detail = detail.to_ascii_lowercase();
        if (detail.contains("unknown command") && detail.contains("json."))
            || detail.contains("unknown redis command called from script")
        {
            return error(
                "JSON_UNAVAILABLE",
                "RedisJSON is not available on this server",
            );
        }
        if (detail.contains("at position") && detail.contains("expected"))
            || detail.contains("path")
                && (detail.contains("invalid")
                    || detail.contains("syntax")
                    || detail.contains("parse")
                    || detail.contains("expected"))
        {
            return error("JSON_PATH_INVALID", "RedisJSON rejected the JSONPath");
        }
    }
    cause.into_js()
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: JsonOptions,
) -> Result<RedisJson, JsError> {
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
            .cmd("JSON.GET")
            .arg(&key)
            .arg(options.path.as_deref().unwrap_or("."))
            .cmd("PTTL")
            .arg(&key);
        let result: Result<(String, Option<String>, i64), RequestError> = connection
            .as_mut()
            .unwrap()
            .query_pipeline(state, &key, &pipeline)
            .await;
        match result {
            Ok((kind, value, ttl)) => {
                let exists = kind != "none";
                if exists && !is_json(&kind) {
                    return Err(error("WRONG_TYPE", "Key is not a RedisJSON document"));
                }
                let value = match value {
                    Some(value) => value,
                    None if !exists || options.path.is_some() => "[]".into(),
                    None => return Err(error("SERVER_ERROR", "RedisJSON returned no document")),
                };
                strings::check_payload(
                    value.len(),
                    state.options.max_response_bytes.unwrap_or(262144) as usize,
                )?;
                let matches = if options.path.is_some() && exists {
                    Some(
                        serde_json::from_str::<Vec<&serde_json::value::RawValue>>(&value)
                            .map_err(|_| {
                                error("SERVER_ERROR", "RedisJSON returned invalid matches")
                            })?
                            .len()
                            .to_string(),
                    )
                } else if options.path.is_some() {
                    Some("0".into())
                } else {
                    None
                };
                return Ok(RedisJson {
                    exists,
                    value,
                    path: options.path,
                    matches,
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
                    return Err(mapped_error(cause));
                }
            }
        }
    }
    unreachable!("bounded read attempts")
}

pub(super) async fn mutate(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: JsonOptions,
    value: Option<String>,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    // Checking existence and type in the same operation prevents edits of an
    // expired/replaced key from recreating it. JSON.SET preserves the existing TTL.
    let script = r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return -1 end
if kind ~= 'ReJSON-RL' and kind ~= 'json' then return redis.error_reply('WRONGTYPE Key is not RedisJSON') end
if ARGV[1] == 'delete' then return redis.call('JSON.DEL', KEYS[1], ARGV[2]) end
local result = redis.call('JSON.SET', KEYS[1], ARGV[2], ARGV[3])
if not result then return -2 end
return 1
"#;
    let mut command = redis::cmd("EVAL");
    command
        .arg(script)
        .arg(1)
        .arg(&key)
        .arg(if value.is_some() { "set" } else { "delete" })
        .arg(options.path.as_deref().unwrap_or("."))
        .arg(value.as_deref().unwrap_or(""));
    match connection
        .as_mut()
        .unwrap()
        .query::<i64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(-1) => Err(error("KEY_NOT_FOUND", "RedisJSON Key no longer exists")),
        Ok(-2) => Err(error(
            "JSON_PATH_NOT_FOUND",
            "JSONPath could not be updated",
        )),
        Ok(affected) if affected >= 0 => Ok(RedisMutation {
            affected: affected.to_string(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Ok(_) => Err(error("SERVER_ERROR", "Invalid RedisJSON mutation result")),
        Err(cause) if !cause.recoverable() && cause.server_code().is_some() => {
            Err(mapped_error(cause))
        }
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}
