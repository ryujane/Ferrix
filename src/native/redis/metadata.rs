//! Bounded selected metadata, prepared on the Session worker with finite pipelines.

use super::*;

/// Select only the visible metadata needed. Omitted/false fields are not delivered.
#[derive(JsObject)]
pub struct KeyInfoFields {
    pub key_type: Option<bool>,
    pub length: Option<bool>,
    pub ttl: Option<bool>,
    /// Explicit MEMORY USAGE samples, from 0 (all nested values) through 10000.
    pub memory_samples: Option<u32>,
}

/// One requested binary Key, including per-field availability and safe server tokens.
#[derive(JsObject)]
pub struct RedisKeyMetadata {
    pub key: Vec<u8>,
    /// Null when TYPE could not establish existence; fields are separate observations.
    pub exists: Option<bool>,
    pub r#type: Option<String>,
    pub type_status: String,
    pub type_error_code: Option<String>,
    pub length: Option<String>,
    pub length_status: String,
    pub length_error_code: Option<String>,
    pub expiration: Option<String>,
    pub ttl_ms: Option<String>,
    pub ttl_status: String,
    pub ttl_error_code: Option<String>,
    pub memory_bytes: Option<String>,
    pub memory_status: String,
    pub memory_error_code: Option<String>,
    pub memory_samples: Option<u32>,
}

/// Input order and duplicates are preserved. No metadata cache or snapshot is retained.
#[derive(JsObject)]
pub struct RedisKeyInfoBatch {
    pub items: Vec<RedisKeyMetadata>,
    pub database: u32,
    pub generation: String,
}

pub(super) fn validate(
    keys: &[Vec<u8>],
    fields: &KeyInfoFields,
    budget: usize,
) -> Result<(), JsError> {
    if !fields.key_type.unwrap_or(false)
        && !fields.length.unwrap_or(false)
        && !fields.ttl.unwrap_or(false)
        && fields.memory_samples.is_none()
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "Select at least one metadata field",
        ));
    }
    if keys.len() > 200 {
        return Err(error(
            "INVALID_ARGUMENT",
            "A metadata batch accepts at most 200 Keys",
        ));
    }
    strings::check_payload(
        keys.iter()
            .fold(0usize, |sum, key| sum.saturating_add(key.len())),
        budget,
    )?;
    keys::validate_info(&KeyInfoOptions {
        memory_samples: fields.memory_samples,
    })
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    keys: Vec<Vec<u8>>,
    fields: KeyInfoFields,
) -> Result<RedisKeyInfoBatch, JsError> {
    if keys.is_empty() {
        return Ok(RedisKeyInfoBatch {
            items: Vec::new(),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        });
    }
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let generation = state.generation.load(Ordering::Acquire);
        match read_fields(state, connection.as_mut().unwrap(), &keys, &fields).await {
            Ok(items) => {
                if state.generation.load(Ordering::Acquire) != generation {
                    if attempt == 0 {
                        continue;
                    }
                    return Err(error(
                        "CONTEXT_CHANGED",
                        "Redis batch context changed repeatedly; retry after recovery",
                    ));
                }
                return Ok(RedisKeyInfoBatch {
                    items,
                    database: state.database(),
                    generation: generation.to_string(),
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
    unreachable!("the final attempt always returns")
}

fn empty(key: Vec<u8>) -> RedisKeyMetadata {
    RedisKeyMetadata {
        key,
        exists: None,
        r#type: None,
        type_status: "not-requested".into(),
        type_error_code: None,
        length: None,
        length_status: "not-requested".into(),
        length_error_code: None,
        expiration: None,
        ttl_ms: None,
        ttl_status: "not-requested".into(),
        ttl_error_code: None,
        memory_bytes: None,
        memory_status: "not-requested".into(),
        memory_error_code: None,
        memory_samples: None,
    }
}

fn parse<T: redis::FromRedisValue>(
    value: redis::RedisResult<redis::Value>,
) -> redis::RedisResult<T> {
    value.and_then(|value| redis::from_redis_value(value).map_err(Into::into))
}

fn apply_type(item: &mut RedisKeyMetadata, kind: &redis::RedisResult<String>, selected: bool) {
    item.exists = kind.as_ref().ok().map(|kind| kind != "none");
    if selected {
        item.r#type = kind.as_ref().ok().map(|kind| json::key_type(kind));
        item.type_status = match kind {
            Ok(kind) if kind == "none" => "missing",
            Ok(_) => "available",
            Err(cause) if cause.code() == Some("NOPERM") => "permission-denied",
            Err(_) => "unavailable",
        }
        .into();
        item.type_error_code = kind.as_ref().err().and_then(keys::server_code);
    }
}

async fn read_fields(
    state: &SessionState,
    connection: &mut Connection,
    keys: &[Vec<u8>],
    fields: &KeyInfoFields,
) -> Result<Vec<RedisKeyMetadata>, RequestError> {
    let need_type = fields.key_type.unwrap_or(false) || fields.length.unwrap_or(false);
    let mut pipeline = redis::pipe();
    pipeline.ignore_errors();
    let mut routes = Vec::new();
    for key in keys {
        if need_type {
            pipeline.cmd("TYPE").arg(key);
            routes.push(key.as_slice());
        }
        if fields.ttl.unwrap_or(false) {
            pipeline.cmd("PTTL").arg(key);
            routes.push(key.as_slice());
        }
        if let Some(samples) = fields.memory_samples {
            pipeline
                .cmd("MEMORY")
                .arg("USAGE")
                .arg(key)
                .arg("SAMPLES")
                .arg(samples);
            routes.push(key.as_slice());
        }
    }
    let values = query_fields(state, connection, &pipeline, &routes).await?;
    let mut values = values.into_iter();
    let mut items = Vec::with_capacity(keys.len());
    let mut lengths = Vec::new();
    let mut size_pipeline = redis::pipe();
    size_pipeline.ignore_errors();
    let mut size_routes = Vec::new();
    for (index, key) in keys.iter().enumerate() {
        let mut item = empty(key.clone());
        let kind = need_type.then(|| parse::<String>(values.next().unwrap()));
        if let Some(kind) = &kind {
            apply_type(&mut item, kind, fields.key_type.unwrap_or(false));
        }
        if fields.ttl.unwrap_or(false) {
            match parse::<i64>(values.next().unwrap()) {
                Ok(ttl) => {
                    if !need_type {
                        item.exists = Some(ttl != -2);
                    }
                    item.expiration = Some(
                        match ttl {
                            -2 => "missing",
                            -1 => "persistent",
                            _ => "expiring",
                        }
                        .into(),
                    );
                    item.ttl_ms = (ttl >= 0).then(|| ttl.to_string());
                    item.ttl_status = if ttl == -2 { "missing" } else { "available" }.into();
                }
                Err(cause) => {
                    item.ttl_status = if cause.code() == Some("NOPERM") {
                        "permission-denied"
                    } else {
                        "unavailable"
                    }
                    .into();
                    item.ttl_error_code = keys::server_code(&cause);
                }
            }
        }
        if let Some(samples) = fields.memory_samples {
            item.memory_samples = Some(samples);
            match parse::<Option<u64>>(values.next().unwrap()) {
                Ok(bytes) => {
                    if !need_type && !fields.ttl.unwrap_or(false) {
                        item.exists = Some(bytes.is_some());
                    }
                    item.memory_status = if bytes.is_some() {
                        "available"
                    } else {
                        "missing"
                    }
                    .into();
                    item.memory_bytes = bytes.map(|bytes| bytes.to_string());
                }
                Err(cause) => {
                    item.memory_status = if cause.code() == Some("NOPERM") {
                        "permission-denied"
                    } else if cause
                        .detail()
                        .is_some_and(|detail| detail.starts_with("unknown command"))
                    {
                        "unavailable"
                    } else {
                        "server-error"
                    }
                    .into();
                    item.memory_error_code = keys::server_code(&cause);
                }
            }
        }
        if fields.length.unwrap_or(false) {
            item.length_status = match kind.as_ref().unwrap() {
                Ok(kind) if kind == "none" => "missing",
                Ok(kind) => match keys::size_command(kind) {
                    Some(command) => {
                        size_pipeline.cmd(command).arg(key).cmd("TYPE").arg(key);
                        size_routes.extend([key.as_slice(), key.as_slice()]);
                        lengths.push((index, kind.clone()));
                        "unavailable"
                    }
                    None => "unsupported",
                },
                Err(cause) => {
                    item.length_error_code = keys::server_code(cause);
                    "unavailable"
                }
            }
            .into();
        }
        items.push(item);
    }
    if !size_pipeline.is_empty() {
        let values = query_fields(state, connection, &size_pipeline, &size_routes).await?;
        let mut values = values.into_iter();
        for (index, expected) in lengths {
            let length = parse::<u64>(values.next().unwrap());
            let kind = parse::<String>(values.next().unwrap());
            let item = &mut items[index];
            apply_type(item, &kind, fields.key_type.unwrap_or(false));
            match (&kind, length) {
                (Ok(kind), _) if kind == "none" => item.length_status = "missing".into(),
                (Ok(kind), Ok(length)) if kind == &expected => {
                    item.length = Some(length.to_string());
                    item.length_status = "available".into();
                }
                (_, Err(cause)) => item.length_error_code = keys::server_code(&cause),
                (Err(cause), _) => item.length_error_code = keys::server_code(cause),
                _ => {}
            }
        }
    }
    Ok(items)
}

async fn query_fields(
    state: &SessionState,
    connection: &mut Connection,
    pipeline: &redis::Pipeline,
    routes: &[&[u8]],
) -> Result<Vec<redis::RedisResult<redis::Value>>, RequestError> {
    match connection {
        Connection::Standalone(connection, _) => {
            pipeline.query_async(connection).await.map_err(Into::into)
        }
        Connection::Cluster(connection) => {
            connection
                .query_readonly_fields(state, pipeline, routes)
                .await
        }
    }
}
