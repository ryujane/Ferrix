//! Read-only slow-log observations on the bounded Session background lane.
use super::*;

#[derive(JsObject)]
pub struct RedisSlowlogEntry {
    pub id: String,
    pub timestamp_seconds: String,
    pub duration_microseconds: String,
    pub arguments: Vec<Vec<u8>>,
    pub client_address: Option<Vec<u8>>,
    pub client_name: Option<Vec<u8>>,
    /// Original argument count, when supplied by newer Redis versions.
    pub argument_count: Option<String>,
}
#[derive(JsObject)]
pub struct RedisSlowlog {
    pub entries: Vec<RedisSlowlogEntry>,
    pub requested_count: u32,
    /// Separately observed SLOWLOG LEN; null if unavailable.
    pub total: Option<String>,
    pub sampled_at_ms: String,
    pub scope: String,
    pub node_address: Option<String>,
    pub database: u32,
    pub generation: String,
}
pub(super) fn validate(count: u32) -> Result<(), JsError> {
    if (1..=200).contains(&count) {
        Ok(())
    } else {
        Err(error(
            "INVALID_ARGUMENT",
            "Slow log count must be from 1 to 200",
        ))
    }
}
pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    count: u32,
) -> Result<RedisSlowlog, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        match observe(state, connection.as_mut().unwrap(), count).await {
            Ok(value) => return Ok(value),
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
    unreachable!("bounded read attempts")
}
async fn observe(
    state: &SessionState,
    connection: &mut Connection,
    count: u32,
) -> Result<RedisSlowlog, RequestError> {
    let raw = connection
        .query::<redis::Value>(
            state,
            None,
            redis::cmd("SLOWLOG").arg("GET").arg(count),
            None,
        )
        .await?;
    let sampled_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let generation = connection.generation();
    let entries = parse(
        raw,
        count,
        state.options.max_response_bytes.unwrap_or(262_144) as usize,
    )?;
    let total = match connection
        .query::<u64>(state, None, redis::cmd("SLOWLOG").arg("LEN"), None)
        .await
    {
        Ok(value) => Some(value.to_string()),
        Err(cause) if matches!(cause.code(), Some("NOPERM" | "ERR")) => None,
        Err(cause) => return Err(cause),
    };
    if generation != connection.generation() {
        return Err(context_changed().into());
    }
    Ok(RedisSlowlog {
        entries,
        requested_count: count,
        total,
        sampled_at_ms,
        scope: if state.cluster_options.is_some() {
            "node"
        } else {
            "server"
        }
        .into(),
        node_address: match connection {
            Connection::Cluster(cluster) => Some(cluster.metrics_address()),
            Connection::Standalone(..) => None,
        },
        database: state.database(),
        generation: state.generation.load(Ordering::Acquire).to_string(),
    })
}
fn invalid() -> JsError {
    error("SERVER_ERROR", "Redis returned an invalid slow log")
}
fn number(value: redis::Value) -> Result<String, JsError> {
    redis::from_redis_value::<u64>(value)
        .map(|value| value.to_string())
        .map_err(|_| invalid())
}
fn optional_bytes(value: Option<redis::Value>) -> Result<Option<Vec<u8>>, JsError> {
    match value {
        None | Some(redis::Value::Nil) => Ok(None),
        Some(value) => redis::from_redis_value(value)
            .map(Some)
            .map_err(|_| invalid()),
    }
}
fn parse(raw: redis::Value, count: u32, budget: usize) -> Result<Vec<RedisSlowlogEntry>, JsError> {
    let rows: Vec<redis::Value> = redis::from_redis_value(raw).map_err(|_| invalid())?;
    if rows.len() > count as usize {
        return Err(invalid());
    }
    let mut size = 0usize;
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let fields: Vec<redis::Value> = redis::from_redis_value(row).map_err(|_| invalid())?;
        if fields.len() < 4 {
            return Err(invalid());
        }
        let mut fields = fields.into_iter();
        let id = number(fields.next().unwrap())?;
        let timestamp_seconds = number(fields.next().unwrap())?;
        let duration_microseconds = number(fields.next().unwrap())?;
        let arguments: Vec<Vec<u8>> =
            redis::from_redis_value(fields.next().unwrap()).map_err(|_| invalid())?;
        let client_address = optional_bytes(fields.next())?;
        let client_name = optional_bytes(fields.next())?;
        let argument_count = fields.next().map(number).transpose()?;
        size = size
            .saturating_add(id.len())
            .saturating_add(timestamp_seconds.len())
            .saturating_add(duration_microseconds.len())
            .saturating_add(arguments.iter().fold(0usize, |total, argument| {
                total.saturating_add(argument.len())
            }))
            .saturating_add(client_address.as_ref().map_or(0, Vec::len))
            .saturating_add(client_name.as_ref().map_or(0, Vec::len))
            .saturating_add(argument_count.as_ref().map_or(0, String::len));
        strings::check_payload(size, budget)?;
        entries.push(RedisSlowlogEntry {
            id,
            timestamp_seconds,
            duration_microseconds,
            arguments,
            client_address,
            client_name,
            argument_count,
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::Value::{Array, BulkString, Int};
    fn row(extra: Vec<redis::Value>) -> redis::Value {
        let mut value = vec![
            Int(9_007_199_254_740_993),
            Int(1_700_000_000),
            Int(9_007_199_254_740_993),
            Array(vec![
                BulkString(b"GET".to_vec()),
                BulkString(vec![0xff, 0, 34]),
            ]),
        ];
        value.extend(extra);
        Array(value)
    }
    #[test]
    fn preserves_binary_arguments_exact_counters_and_optional_version_fields() {
        for extra in [
            vec![],
            vec![
                BulkString(b"127.0.0.1:1234".to_vec()),
                BulkString(b"worker".to_vec()),
            ],
            vec![BulkString(vec![]), BulkString(vec![]), Int(40)],
        ] {
            let latest = extra.len() == 3;
            let rows = parse(Array(vec![row(extra)]), 10, 4096).unwrap();
            assert_eq!(rows[0].id, "9007199254740993");
            assert_eq!(rows[0].duration_microseconds, "9007199254740993");
            assert_eq!(rows[0].arguments[1], [0xff, 0, 34]);
            assert_eq!(rows[0].argument_count.as_deref(), latest.then_some("40"));
        }
    }
    #[test]
    fn rejects_unbounded_counts_malformed_replies_and_oversized_payloads() {
        assert!(validate(0).is_err());
        assert!(validate(201).is_err());
        assert!(validate(50).is_ok());
        assert!(parse(Array(vec![Array(vec![Int(1)])]), 1, 4096).is_err());
        assert!(parse(Array(vec![row(vec![])]), 1, 2).is_err());
        assert!(parse(Array(vec![row(vec![]), row(vec![])]), 1, 4096).is_err());
    }
}
