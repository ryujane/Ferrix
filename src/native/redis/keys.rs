//! Individual Key details and mutations, executed exclusively by the Session worker.

use super::*;

/// Detail options. Omit memorySamples to avoid profiling.
#[derive(JsObject)]
pub struct KeyInfoOptions {
    /// MEMORY USAGE sample count; zero asks Redis to sample all nested values.
    pub memory_samples: Option<u32>,
}

/// Exact Key metadata and the immutable context of this read.
#[derive(JsObject)]
pub struct RedisKeyInfo {
    pub exists: bool,
    pub r#type: String,
    pub length: Option<String>,
    /// `available`, `missing`, `unsupported` or `unavailable`.
    pub length_status: String,
    pub length_error_code: Option<String>,
    /// `missing`, `persistent` or `expiring`.
    pub expiration: String,
    pub ttl_ms: Option<String>,
    pub memory_bytes: Option<String>,
    pub memory_status: String,
    /// Safe Redis error token only; never Redis's diagnostic text.
    pub memory_error_code: Option<String>,
    pub memory_samples: Option<u32>,
    pub database: u32,
    pub generation: String,
}

/// An acknowledged mutation's exact affected count and immutable Session context.
#[derive(JsObject)]
pub struct RedisMutation {
    pub affected: String,
    pub database: u32,
    pub generation: String,
}

/// Rename intent. Omitted overwrite preserves an existing destination.
#[derive(JsObject)]
pub struct RenameKeyOptions {
    pub overwrite: Option<bool>,
}

pub(super) enum KeyMutation {
    Delete,
    Expire(String),
    Persist,
    Rename(Vec<u8>, RenameKeyOptions),
}

pub(super) fn validate_mutation(mutation: &KeyMutation, budget: usize) -> Result<(), JsError> {
    if let KeyMutation::Expire(ttl) = mutation {
        strings::expiry(&SetStringOptions {
            ttl_ms: Some(ttl.clone()),
            persist: None,
        })?;
    }
    if let KeyMutation::Rename(destination, _) = mutation {
        strings::check_payload(destination.len(), budget)?;
    }
    Ok(())
}

pub(super) async fn mutate(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    mutation: KeyMutation,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let mut command = match &mutation {
        KeyMutation::Delete => redis::cmd("DEL"),
        KeyMutation::Persist => redis::cmd("PERSIST"),
        KeyMutation::Expire(_) => redis::cmd("PEXPIRE"),
        KeyMutation::Rename(_, options) => redis::cmd(if options.overwrite.unwrap_or(false) {
            "RENAME"
        } else {
            "RENAMENX"
        }),
    };
    command.arg(&key);
    match &mutation {
        KeyMutation::Expire(ttl) => {
            command.arg(ttl);
        }
        KeyMutation::Rename(destination, _) => {
            command.arg(destination);
        }
        _ => {}
    }
    let result = connection
        .as_mut()
        .unwrap()
        .query::<redis::Value>(state, Some(&key), &command, Some(dispatched))
        .await;
    match result {
        Ok(value) => {
            let affected = if matches!(&mutation, KeyMutation::Rename(_, options) if options.overwrite.unwrap_or(false))
            {
                1
            } else {
                redis::from_redis_value::<u64>(value).map_err(|_| {
                    error("SERVER_ERROR", "Redis returned an invalid mutation count")
                })?
            };
            if matches!(mutation, KeyMutation::Rename(..)) && affected == 0 {
                return Err(error(
                    "KEY_CONFLICT",
                    "Redis destination Key already exists",
                ));
            }
            Ok(RedisMutation {
                affected: affected.to_string(),
                database: state.database(),
                generation: state.generation.load(Ordering::Acquire).to_string(),
            })
        }
        Err(cause)
            if matches!(mutation, KeyMutation::Rename(..))
                && cause.detail() == Some("no such key") =>
        {
            Err(error("KEY_NOT_FOUND", "Redis source Key does not exist").with("serverCode", "ERR"))
        }
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}

pub(super) async fn info(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: KeyInfoOptions,
) -> Result<RedisKeyInfo, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let observed = read_info(state, connection.as_mut().unwrap(), &key).await;
        match observed {
            Ok((kind, length, ttl, length_error_code)) => {
                let (memory_bytes, memory_status, memory_error_code) =
                    if let Some(samples) = options.memory_samples {
                        match connection
                            .as_mut()
                            .unwrap()
                            .query::<Option<u64>>(
                                state,
                                Some(&key),
                                redis::cmd("MEMORY")
                                    .arg("USAGE")
                                    .arg(&key)
                                    .arg("SAMPLES")
                                    .arg(samples),
                                None,
                            )
                            .await
                        {
                            Ok(Some(bytes)) => (Some(bytes.to_string()), "available", None),
                            Ok(None) => (None, "missing", None),
                            Err(cause) if cause.recoverable() => {
                                discard_transports(connection);
                                if attempt == 0 {
                                    continue;
                                }
                                return Err(cause.into_js());
                            }
                            Err(cause @ RequestError::Native(_)) => return Err(cause.into_js()),
                            Err(cause) => {
                                let status = if cause.code() == Some("NOPERM") {
                                    "permission-denied"
                                } else if cause
                                    .detail()
                                    .is_some_and(|detail| detail.starts_with("unknown command"))
                                {
                                    "unavailable"
                                } else {
                                    "server-error"
                                };
                                (None, status, cause.server_code())
                            }
                        }
                    } else {
                        (None, "not-requested", None)
                    };
                return Ok(RedisKeyInfo {
                    exists: kind != "none",
                    length_status: if kind == "none" {
                        "missing"
                    } else if length.is_some() {
                        "available"
                    } else if size_command(&kind).is_some() {
                        "unavailable"
                    } else {
                        "unsupported"
                    }
                    .into(),
                    length_error_code,
                    r#type: json::key_type(&kind),
                    length: length.map(|value| value.to_string()),
                    expiration: match ttl {
                        -2 => "missing",
                        -1 => "persistent",
                        _ => "expiring",
                    }
                    .into(),
                    ttl_ms: (ttl >= 0).then(|| ttl.to_string()),
                    memory_bytes,
                    memory_status: memory_status.into(),
                    memory_error_code,
                    memory_samples: options.memory_samples,
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

pub(super) fn validate_info(options: &KeyInfoOptions) -> Result<(), JsError> {
    if options
        .memory_samples
        .is_some_and(|samples| samples > 10_000)
    {
        Err(error(
            "INVALID_ARGUMENT",
            "Memory samples must be from 0 to 10000",
        ))
    } else {
        Ok(())
    }
}

// Redis diagnostic text may contain user data. Only a bounded token crosses the bridge.
pub(super) fn server_code(cause: &redis::RedisError) -> Option<String> {
    let nested = cause.clone().into_server_errors();
    // redis-rs retains queue-time ACL errors inside TransactionAborted even
    // though its outer code is EXECABORT. Preserve that actionable identity.
    let code = nested
        .as_ref()
        .and_then(|errors| errors.iter().find(|(_, cause)| cause.code() == "NOPERM"))
        .map(|(_, cause)| cause.code())
        .or_else(|| cause.code())
        .or_else(|| {
            nested
                .as_ref()
                .and_then(|errors| errors.first().map(|(_, cause)| cause.code()))
        })?;
    (code.len() <= 64
        && !code.is_empty()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
    .then(|| code.to_owned())
}

async fn read_info(
    state: &SessionState,
    connection: &mut Connection,
    key: &[u8],
) -> Result<(String, Option<u64>, i64, Option<String>), RequestError> {
    // The preliminary TYPE only chooses the length command. Recheck TYPE atomically
    // with the integer response and TTL; type races receive bounded retries.
    for _ in 0..3 {
        let expected: String = connection
            .query(state, Some(key), redis::cmd("TYPE").arg(key), None)
            .await?;
        let mut pipeline = redis::pipe();
        pipeline.atomic().cmd("TYPE").arg(key).cmd("PTTL").arg(key);
        let size_command = size_command(&expected);
        if let Some(command) = size_command {
            pipeline.cmd(command).arg(key);
        }
        if size_command.is_none() {
            let (kind, ttl): (String, i64) =
                connection.query_pipeline(state, key, &pipeline).await?;
            if kind == expected {
                return Ok((kind, None, ttl, None));
            }
        } else {
            match connection
                .query_pipeline::<(String, i64, u64)>(state, key, &pipeline)
                .await
            {
                Ok((kind, ttl, length)) if kind == expected => {
                    return Ok((kind, Some(length), ttl, None));
                }
                Ok(_) => {}
                Err(cause)
                    if cause
                        .redis_cause()
                        .and_then(|cause| cause.clone().into_server_errors())
                        .is_some_and(|errors| {
                            errors.iter().any(|(_, cause)| cause.code() == "WRONGTYPE")
                        }) => {}
                Err(cause) if cause.recoverable() => return Err(cause),
                Err(cause @ RequestError::Native(_)) => return Err(cause),
                Err(cause) => {
                    let field_error = cause.server_code();
                    let mut pipeline = redis::pipe();
                    pipeline.atomic().cmd("TYPE").arg(key).cmd("PTTL").arg(key);
                    let (kind, ttl): (String, i64) =
                        connection.query_pipeline(state, key, &pipeline).await?;
                    return Ok((kind, None, ttl, field_error));
                }
            }
        }
    }
    // A hot changing value remains inspectable; the caller receives unavailable size.
    let mut pipeline = redis::pipe();
    pipeline.atomic().cmd("TYPE").arg(key).cmd("PTTL").arg(key);
    let (kind, ttl): (String, i64) = connection.query_pipeline(state, key, &pipeline).await?;
    Ok((kind, None, ttl, None))
}

pub(super) fn size_command(kind: &str) -> Option<&'static str> {
    match kind {
        "string" => Some("STRLEN"),
        "hash" => Some("HLEN"),
        "list" => Some("LLEN"),
        "set" => Some("SCARD"),
        "zset" => Some("ZCARD"),
        "stream" => Some("XLEN"),
        _ => None,
    }
}
