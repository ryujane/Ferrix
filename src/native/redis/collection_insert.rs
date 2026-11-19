//! Insert one collection row without overwriting an existing field or member.

use super::*;

#[derive(JsObject)]
pub struct CollectionRowInsertOptions {
    /// `hash`, `list`, `set` or `zset`.
    pub key_type: String,
    /// Binary value, or the member for Set and ZSet.
    pub value: Vec<u8>,
    /// Hash field, including an empty field.
    pub field: Option<Vec<u8>>,
    /// Required finite score for ZSet.
    pub score: Option<f64>,
}

/// Acknowledged insertion, with the actual zero-based index when appending to a List.
#[derive(JsObject)]
pub struct RedisCollectionRowInsert {
    pub index: Option<String>,
    pub database: u32,
    pub generation: String,
}

pub(super) fn validate(
    key: &[u8],
    options: &CollectionRowInsertOptions,
    budget: usize,
) -> Result<(), JsError> {
    strings::check_payload(
        key.len()
            .saturating_add(options.value.len())
            .saturating_add(options.field.as_ref().map_or(0, Vec::len)),
        budget,
    )?;
    match options.key_type.as_str() {
        "list" | "set" => Ok(()),
        "hash" if options.field.is_some() => Ok(()),
        "zset" if options.score.is_some_and(f64::is_finite) => Ok(()),
        _ => Err(error(
            "INVALID_ARGUMENT",
            "Choose a supported collection type and row",
        )),
    }
}

pub(super) async fn insert(
    state: &SessionState,
    connection: &mut Option<Connection>,
    key: Vec<u8>,
    options: CollectionRowInsertOptions,
    dispatched: &AtomicBool,
) -> Result<RedisCollectionRowInsert, JsError> {
    if connection.is_none() {
        *connection = Some(state.connect().await?);
        state.advance_connection_generation(connection);
    }
    let command = match options.key_type.as_str() {
        "hash" => {
            let mut command = redis::cmd("HSETNX");
            command
                .arg(&key)
                .arg(options.field.unwrap())
                .arg(options.value);
            command
        }
        "list" => {
            let mut command = redis::cmd("RPUSH");
            command.arg(&key).arg(options.value);
            command
        }
        "set" => {
            let mut command = redis::cmd("SADD");
            command.arg(&key).arg(options.value);
            command
        }
        "zset" => {
            let mut command = redis::cmd("ZADD");
            command
                .arg(&key)
                .arg("NX")
                .arg(options.score.unwrap())
                .arg(options.value);
            command
        }
        _ => unreachable!("validated at admission"),
    };
    match connection
        .as_mut()
        .unwrap()
        .query::<u64>(state, Some(&key), &command, Some(dispatched))
        .await
    {
        Ok(0) => Err(error(
            "ROW_CONFLICT",
            "Redis field or member already exists",
        )),
        Ok(count) => Ok(RedisCollectionRowInsert {
            index: (options.key_type == "list").then(|| (count - 1).to_string()),
            database: state.database(),
            generation: state.generation.load(Ordering::Acquire).to_string(),
        }),
        Err(cause) => Err(settle_mutation_error(connection, dispatched, cause)),
    }
}
