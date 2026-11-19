//! Small server-owned command metadata for CLI completion, never an execution allowlist.
use super::*;

#[derive(JsObject)]
pub struct RedisConsoleCommand {
    pub name: String,
    pub summary: Option<String>,
    /// Bounded Redis COMMAND DOCS argument schema. Null in the names-only catalog.
    pub arguments_json: Option<String>,
}
#[derive(JsObject)]
pub struct RedisCommandCatalog {
    pub commands: Vec<RedisConsoleCommand>,
    pub generation: String,
}
pub(in crate::native::redis) fn validate(name: Option<&str>) -> Result<(), JsError> {
    if name.is_some_and(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_control)) {
        return Err(error("INVALID_ARGUMENT", "Expected a Redis command name"));
    }
    Ok(())
}
pub(in crate::native::redis) async fn read(
    state: &SessionState,
    connection: &mut Option<Connection>,
    name: Option<String>,
) -> Result<RedisCommandCatalog, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        let mut command = redis::cmd("COMMAND");
        if let Some(name) = &name {
            command
                .arg("DOCS")
                .arg(name.split_whitespace().collect::<Vec<_>>().join("|"));
        }
        let result = connection
            .as_mut()
            .unwrap()
            .query::<redis::Value>(state, None, &command, None)
            .await;
        match result {
            Ok(value) => {
                strings::check_payload(
                    size(&value, 0),
                    state.options.max_response_bytes.unwrap_or(262144) as usize,
                )?;
                let mut commands = Vec::new();
                if name.is_some() {
                    docs(&value, &mut commands, 0)?;
                } else if let redis::Value::Array(entries) = value {
                    for entry in entries {
                        names(&entry, &mut commands, 0)?;
                    }
                }
                commands.sort_by(|a, b| a.name.cmp(&b.name));
                commands.dedup_by(|a, b| a.name == b.name);
                return Ok(RedisCommandCatalog {
                    commands,
                    generation: String::new(),
                });
            }
            Err(cause) => {
                let retry = cause.recoverable();
                if retry {
                    discard_transports(connection);
                }
                if !retry || attempt == 1 {
                    return Err(cause.into_js());
                }
            }
        }
    }
    unreachable!()
}
fn size(value: &redis::Value, depth: usize) -> usize {
    if depth > 32 {
        return usize::MAX;
    }
    use redis::Value::*;
    match value {
        BulkString(b) => b.len().saturating_add(8),
        BigNumber(n) => n.to_string().len().saturating_add(8),
        SimpleString(s) | VerbatimString { text: s, .. } => s.len().saturating_add(8),
        Array(v) | Set(v) | Push { data: v, .. } => v
            .iter()
            .fold(8usize, |n, v| n.saturating_add(size(v, depth + 1))),
        Map(v) => v.iter().fold(8usize, |n, (k, v)| {
            n.saturating_add(size(k, depth + 1))
                .saturating_add(size(v, depth + 1))
        }),
        Attribute { data, attributes } => {
            attributes.iter().fold(size(data, depth + 1), |n, (k, v)| {
                n.saturating_add(size(k, depth + 1))
                    .saturating_add(size(v, depth + 1))
            })
        }
        _ => 32,
    }
}
fn text(value: &redis::Value) -> Option<String> {
    match value {
        redis::Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        redis::Value::SimpleString(s) => Some(s.clone()),
        _ => None,
    }
}
fn pairs(value: &redis::Value) -> Vec<(&redis::Value, &redis::Value)> {
    match value {
        redis::Value::Map(items) => items.iter().map(|(k, v)| (k, v)).collect(),
        redis::Value::Array(items) => items.chunks_exact(2).map(|a| (&a[0], &a[1])).collect(),
        _ => Vec::new(),
    }
}
fn get<'a>(value: &'a redis::Value, key: &str) -> Option<&'a redis::Value> {
    pairs(value)
        .into_iter()
        .find_map(|(k, v)| (text(k).as_deref() == Some(key)).then_some(v))
}
fn names(
    value: &redis::Value,
    result: &mut Vec<RedisConsoleCommand>,
    depth: usize,
) -> Result<(), JsError> {
    if depth > 8 || result.len() >= 8192 {
        return Err(error(
            "PAYLOAD_TOO_LARGE",
            "Redis command catalog exceeds the limit",
        ));
    }
    if let redis::Value::Array(fields) = value {
        if let Some(name) = fields.first().and_then(text).filter(|s| s.len() <= 128) {
            result.push(RedisConsoleCommand {
                name: name.replace('|', " ").to_uppercase(),
                summary: None,
                arguments_json: None,
            });
        }
        if let Some(redis::Value::Array(children)) = fields.get(9) {
            for child in children {
                names(child, result, depth + 1)?;
            }
        }
    }
    Ok(())
}
fn docs(
    value: &redis::Value,
    result: &mut Vec<RedisConsoleCommand>,
    depth: usize,
) -> Result<(), JsError> {
    if depth > 8 || result.len() >= 8192 {
        return Err(error(
            "PAYLOAD_TOO_LARGE",
            "Redis command documentation exceeds the limit",
        ));
    }
    for (key, value) in pairs(value) {
        if let Some(name) = text(key).filter(|s| s.len() <= 128) {
            let mut count = 0;
            let arguments = get(value, "arguments")
                .map(|v| arguments(v, 0, &mut count))
                .transpose()?
                .unwrap_or_else(|| serde_json::json!([]));
            result.push(RedisConsoleCommand {
                name: name.replace('|', " ").to_uppercase(),
                summary: get(value, "summary")
                    .and_then(text)
                    .filter(|s| s.len() <= 1024),
                arguments_json: Some(arguments.to_string()),
            });
            if let Some(children) = get(value, "subcommands") {
                docs(children, result, depth + 1)?;
            }
        }
    }
    Ok(())
}
fn arguments(
    value: &redis::Value,
    depth: usize,
    count: &mut usize,
) -> Result<serde_json::Value, JsError> {
    if depth > 12 || *count > 512 {
        return Err(error(
            "PAYLOAD_TOO_LARGE",
            "Redis command argument schema exceeds the limit",
        ));
    }
    let mut output = Vec::new();
    if let redis::Value::Array(items) = value {
        for item in items {
            *count += 1;
            if *count > 512 {
                return Err(error(
                    "PAYLOAD_TOO_LARGE",
                    "Redis command argument schema exceeds the limit",
                ));
            }
            let mut argument = serde_json::Map::new();
            for key in ["name", "type", "display_text", "token"] {
                if let Some(value) = get(item, key).and_then(text).filter(|s| s.len() <= 256) {
                    argument.insert(key.into(), value.into());
                }
            }
            if let Some(redis::Value::Array(flags)) = get(item, "flags") {
                for flag in flags.iter().filter_map(text) {
                    if matches!(flag.as_str(), "optional" | "multiple" | "multiple_token") {
                        argument.insert(flag, true.into());
                    }
                }
            }
            if let Some(children) = get(item, "arguments") {
                argument.insert("arguments".into(), arguments(children, depth + 1, count)?);
            }
            output.push(serde_json::Value::Object(argument));
        }
    }
    Ok(output.into())
}
