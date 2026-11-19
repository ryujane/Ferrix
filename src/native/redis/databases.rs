//! Database discovery without SELECT or scanning the key space.

use std::collections::BTreeMap;

use super::*;

/// One database and its observed total Key count, or null when unavailable.
#[derive(JsObject)]
pub struct RedisDatabase {
    pub database: u32,
    pub key_count: Option<String>,
}

/// Configured databases, including empty ones when CONFIG GET is permitted.
#[derive(JsObject)]
pub struct RedisDatabases {
    pub items: Vec<RedisDatabase>,
    /// False when configuration is unavailable and only observed/current databases are known.
    pub complete: bool,
    pub database: u32,
    pub generation: String,
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
) -> Result<RedisDatabases, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        match observe(state, connection.as_mut().unwrap()).await {
            Ok(result) => return Ok(result),
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

// ACL denials and commands disabled by a managed server are optional capabilities.
fn optional<T>(result: Result<T, RequestError>) -> Result<Option<T>, RequestError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(cause) if matches!(cause.code(), Some("NOPERM" | "ERR")) => Ok(None),
        Err(cause) => Err(cause),
    }
}

async fn observe(
    state: &SessionState,
    connection: &mut Connection,
) -> Result<RedisDatabases, RequestError> {
    let budget = state.options.max_response_bytes.unwrap_or(262_144) as usize;
    let (items, complete) = if let Connection::Cluster(cluster) = connection {
        let count = optional(cluster.database_key_count(state).await)?;
        (
            vec![RedisDatabase {
                database: 0,
                key_count: count.map(|n| n.to_string()),
            }],
            true,
        )
    } else {
        let info = optional(
            connection
                .query::<String>(state, None, redis::cmd("INFO").arg("keyspace"), None)
                .await,
        )?;
        if let Some(info) = &info {
            strings::check_payload(info.len(), budget)?;
        }
        let config = optional(
            connection
                .query::<Vec<String>>(
                    state,
                    None,
                    redis::cmd("CONFIG").arg("GET").arg("databases"),
                    None,
                )
                .await,
        )?;
        let configured = config
            .as_ref()
            .and_then(|values| values.chunks_exact(2).find(|pair| pair[0] == "databases"))
            .and_then(|pair| pair[1].parse::<u32>().ok())
            .filter(|n| *n > 0);
        let mut counts = parse_keyspace(info.as_deref().unwrap_or(""));
        // Bound bridge allocation independently of the server's configured database count.
        let maximum = (budget / 64).min(4096);
        if configured.is_some_and(|count| count as usize > maximum) || counts.len() > maximum {
            return Err(error(
                "RESPONSE_TOO_LARGE",
                "Database list exceeds the response budget",
            )
            .into());
        }
        let mut indices = std::collections::BTreeSet::from([0, state.database()]);
        indices.extend(counts.keys().copied());
        if let Some(count) = configured {
            indices.extend(0..count);
        }
        let items = indices
            .into_iter()
            .map(|database| RedisDatabase {
                database,
                key_count: counts
                    .remove(&database)
                    .or_else(|| info.as_ref().map(|_| "0".into())),
            })
            .collect();
        (items, configured.is_some())
    };
    Ok(RedisDatabases {
        items,
        complete,
        database: state.database(),
        generation: state.generation.load(Ordering::Acquire).to_string(),
    })
}

fn parse_keyspace(info: &str) -> BTreeMap<u32, String> {
    info.lines()
        .filter_map(|line| {
            let (name, fields) = line.trim().split_once(':')?;
            let database = name.strip_prefix("db")?.parse().ok()?;
            let count = fields
                .split(',')
                .find_map(|field| field.strip_prefix("keys="))?
                .parse::<u64>()
                .ok()?;
            Some((database, count.to_string()))
        })
        .collect()
}
