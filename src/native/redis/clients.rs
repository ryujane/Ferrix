//! On-demand, read-only CLIENT LIST on the same node as server monitoring.
use super::*;
use std::collections::HashSet;

#[derive(JsObject)]
pub struct RedisClientField {
    pub name: String,
    pub value: Vec<u8>,
}
#[derive(JsObject)]
pub struct RedisClientInfo {
    /// Exact 64-bit client ID, without JavaScript number conversion.
    pub id: String,
    /// Version-dependent CLIENT LIST fields, including unknown/new fields.
    pub fields: Vec<RedisClientField>,
}
#[derive(JsObject)]
pub struct RedisClientList {
    /// All returned connections. A reply exceeding the budget fails without truncation.
    pub clients: Vec<RedisClientInfo>,
    pub sampled_at_ms: String,
    pub scope: String,
    pub node_address: Option<String>,
    pub database: u32,
    pub generation: String,
}

pub(super) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
) -> Result<RedisClientList, JsError> {
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
    unreachable!("bounded read attempts")
}

async fn observe(
    state: &SessionState,
    connection: &mut Connection,
) -> Result<RedisClientList, RequestError> {
    let raw = connection
        .query::<Vec<u8>>(state, None, redis::cmd("CLIENT").arg("LIST"), None)
        .await?;
    let clients = parse(
        &raw,
        state.options.max_response_bytes.unwrap_or(262_144) as usize,
    )?;
    Ok(RedisClientList {
        clients,
        sampled_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string(),
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
    error("SERVER_ERROR", "Redis returned an invalid client list")
}
fn parse(raw: &[u8], budget: usize) -> Result<Vec<RedisClientInfo>, JsError> {
    strings::check_payload(raw.len(), budget)?;
    let mut clients = Vec::new();
    let mut ids = HashSet::new();
    for line in raw.split(|&value| value == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let mut fields = Vec::new();
        let mut names = HashSet::new();
        let mut id = None;
        for field in line
            .split(|&value| value == b' ')
            .filter(|field| !field.is_empty())
        {
            let separator = field
                .iter()
                .position(|&value| value == b'=')
                .ok_or_else(invalid)?;
            let name = std::str::from_utf8(&field[..separator]).map_err(|_| invalid())?;
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|value| value.is_ascii_alphanumeric() || value == b'-')
                || !names.insert(name)
            {
                return Err(invalid());
            }
            let value = &field[separator + 1..];
            if name == "id" {
                id = Some(
                    std::str::from_utf8(value)
                        .map_err(|_| invalid())?
                        .parse::<u64>()
                        .map_err(|_| invalid())?
                        .to_string(),
                );
            }
            fields.push(RedisClientField {
                name: name.into(),
                value: value.into(),
            });
        }
        let id = id.ok_or_else(invalid)?;
        if !ids.insert(id.clone()) {
            return Err(invalid());
        }
        clients.push(RedisClientInfo { id, fields });
    }
    Ok(clients)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_all_types_exact_ids_and_version_dependent_binary_fields() {
        let clients = parse(b"id=9007199254740993 addr=[::1]:1234 name= flags=N db=3 cmd=get future=a=b\r\nid=2 flags=P sub=1\nid=3 flags=S name=\xff\n", 4096).unwrap();
        assert_eq!(clients.len(), 3);
        assert_eq!(clients[0].id, "9007199254740993");
        assert_eq!(clients[0].fields[2].value, b"");
        assert_eq!(clients[0].fields.last().unwrap().value, b"a=b");
        assert_eq!(clients[2].fields.last().unwrap().value, [255]);
    }
    #[test]
    fn rejects_oversized_or_malformed_lists_without_partial_results() {
        assert!(parse(b"", 1).unwrap().is_empty());
        assert!(parse(b"id=1\nid=2\n", 8).is_err());
        for raw in [
            b"name=missing-id".as_slice(),
            b"id=-1",
            b"id=1 invalid",
            b"id=1 id=2",
            b"id=1\nid=1",
            b"id=1 =value",
        ] {
            assert!(parse(raw, 4096).is_err());
        }
    }
}
