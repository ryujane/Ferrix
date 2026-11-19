//! Atomic creation of one typed Key without replacing an existing value.

use super::*;

/// Initial value for a new String, RedisJSON document, Hash, List, Set, ZSet or Stream.
#[derive(JsObject)]
pub struct CreateKeyOptions {
    /// Target database. Omit to use the Session's selected database.
    /// When present, creation uses a dedicated connection without selecting a database
    /// on the Session or invalidating its scans. Cluster accepts only database zero.
    pub database: Option<u32>,
    /// One of `string`, `hash`, `list`, `set`, `zset`, `stream` or `json`.
    pub key_type: String,
    /// String/JSON contents or a single initial collection value/member when no batch is provided.
    pub value: Vec<u8>,
    /// Single initial Hash or Stream field when `fields` is omitted.
    pub field: Option<Vec<u8>>,
    /// Hash fields or Stream's first message: 1 to 200 ordered binary pairs.
    /// Hash duplicate fields use the last value; Stream preserves duplicate field names.
    pub fields: Option<Vec<RedisHashField>>,
    /// From 1 to 200 List values or Set members. Lists retain order and duplicates;
    /// Sets deduplicate members according to Redis semantics.
    pub values: Option<Vec<Vec<u8>>>,
    /// From 1 to 200 ZSet member/score pairs. Scores must be finite;
    /// a repeated member uses its last score.
    pub members: Option<Vec<RedisZSetMember>>,
    /// Finite score for a single ZSet member when `members` is omitted.
    pub score: Option<f64>,
    /// Positive decimal milliseconds. Omit to create a persistent Key.
    pub ttl_ms: Option<String>,
}

pub(super) fn validate(
    key: &[u8],
    options: &CreateKeyOptions,
    budget: usize,
) -> Result<(), JsError> {
    if options
        .database
        .is_some_and(|database| database > i32::MAX as u32)
    {
        return Err(error("INVALID_ARGUMENT", "Redis database is out of range"));
    }
    if let Some(fields) = &options.fields {
        if !matches!(options.key_type.as_str(), "hash" | "stream")
            || fields.is_empty()
            || fields.len() > 200
        {
            return Err(error(
                "INVALID_ARGUMENT",
                "Hash and Stream creation require 1 to 200 field/value pairs",
            ));
        }
    }
    if let Some(values) = &options.values {
        if !matches!(options.key_type.as_str(), "list" | "set")
            || values.is_empty()
            || values.len() > 200
        {
            return Err(error(
                "INVALID_ARGUMENT",
                "List and Set creation require 1 to 200 values",
            ));
        }
    }
    if let Some(members) = &options.members {
        if options.key_type != "zset"
            || members.is_empty()
            || members.len() > 200
            || members.iter().any(|member| !member.score.is_finite())
        {
            return Err(error(
                "INVALID_ARGUMENT",
                "ZSet creation requires 1 to 200 members with finite scores",
            ));
        }
    }
    let field_bytes = options.fields.as_ref().map_or(0usize, |fields| {
        fields.iter().fold(0usize, |n, pair| {
            n.saturating_add(pair.field.len())
                .saturating_add(pair.value.len())
        })
    });
    let value_bytes = options.values.as_ref().map_or(0usize, |values| {
        values
            .iter()
            .fold(0usize, |n, value| n.saturating_add(value.len()))
    });
    let member_bytes = options.members.as_ref().map_or(0usize, |members| {
        members
            .iter()
            .fold(0usize, |n, member| n.saturating_add(member.member.len()))
    });
    strings::check_payload(
        key.len()
            .saturating_add(options.value.len())
            .saturating_add(options.field.as_ref().map_or(0, Vec::len))
            .saturating_add(field_bytes)
            .saturating_add(value_bytes)
            .saturating_add(member_bytes),
        budget,
    )?;
    if let Some(ttl) = options.ttl_ms.as_deref() {
        if nonnegative_decimal(ttl)? == 0 {
            return Err(error("INVALID_ARGUMENT", "TTL must be positive"));
        }
    }
    match options.key_type.as_str() {
        "json" => {
            let value = std::str::from_utf8(&options.value)
                .map_err(|_| error("INVALID_JSON", "Enter valid JSON"))?;
            json::validate(key, &json::JsonOptions { path: None }, Some(value), budget)
        }
        "string" | "list" | "set" => Ok(()),
        "hash" | "stream" if options.fields.is_some() || options.field.is_some() => Ok(()),
        "zset" if options.members.is_some() || options.score.is_some_and(f64::is_finite) => Ok(()),
        _ => Err(error(
            "INVALID_ARGUMENT",
            "Choose a supported Key type and its initial value",
        )),
    }
}

pub(super) async fn create(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: CreateKeyOptions,
    dispatched: &AtomicBool,
) -> Result<RedisMutation, JsError> {
    if let Some(database) = options.database {
        let mut dedicated = Some(state.connect_for_database(database).await?);
        dedicated
            .as_mut()
            .unwrap()
            .set_generation(state.generation.load(Ordering::Acquire));
        return write(state, &mut dedicated, key, options, dispatched, database).await;
    }
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    write(
        state,
        connection,
        key,
        options,
        dispatched,
        state.database(),
    )
    .await
}

async fn write(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: CreateKeyOptions,
    dispatched: &AtomicBool,
    database: u32,
) -> Result<RedisMutation, JsError> {
    // Existence, creation and expiration share one server-side operation.
    // Parameters stay binary and Cluster routing uses exactly one declared Key.
    let script = r#"
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
-- Validate the TTL and expiry permissions while the Key is still absent.
-- Lua errors do not roll back writes; an invalid expiry must fail before creation.
if ARGV[5] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[5]) end
local kind = ARGV[1]
if kind == 'string' then redis.call('SET', KEYS[1], ARGV[2])
elseif kind == 'json' then redis.call('JSON.SET', KEYS[1], '.', ARGV[2])
elseif kind == 'hash' then redis.call('HSET', KEYS[1], unpack(ARGV, 6))
elseif kind == 'list' then redis.call('RPUSH', KEYS[1], unpack(ARGV, 6))
elseif kind == 'set' then redis.call('SADD', KEYS[1], unpack(ARGV, 6))
elseif kind == 'stream' then redis.call('XADD', KEYS[1], '*', unpack(ARGV, 6))
elseif kind == 'zset' then redis.call('ZADD', KEYS[1], unpack(ARGV, 6)) end
if ARGV[5] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[5]) end
return 1
"#;
    let mut command = redis::cmd("EVAL");
    command
        .arg(script)
        .arg(1)
        .arg(&key)
        .arg(&options.key_type)
        .arg(&options.value)
        .arg(options.field.as_deref().unwrap_or_default())
        .arg(options.score.unwrap_or(0.0))
        .arg(options.ttl_ms.as_deref().unwrap_or_default());
    match options.key_type.as_str() {
        "hash" | "stream" => {
            if let Some(fields) = options.fields {
                for pair in fields {
                    command.arg(pair.field).arg(pair.value);
                }
            } else {
                command.arg(options.field.unwrap()).arg(options.value);
            }
        }
        "list" | "set" => {
            if let Some(values) = options.values {
                for value in values {
                    command.arg(value);
                }
            } else {
                command.arg(options.value);
            }
        }
        "zset" => {
            if let Some(members) = options.members {
                for member in members {
                    command.arg(member.score).arg(member.member);
                }
            } else {
                command.arg(options.score.unwrap()).arg(options.value);
            }
        }
        _ => {}
    }
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(0) => Err(error(
            "KEY_CONFLICT",
            "Redis destination Key already exists",
        )),
        Ok(1) => Ok(RedisMutation {
            affected: "1".into(),
            database,
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Ok(_) => Err(error(
            "SERVER_ERROR",
            "Redis returned an invalid creation result",
        )),
        Err(cause)
            if options.key_type == "json"
                && !cause.recoverable()
                && cause.server_code().is_some() =>
        {
            Err(json::mapped_error(cause))
        }
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}
