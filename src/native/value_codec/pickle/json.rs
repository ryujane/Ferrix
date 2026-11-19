use super::*;
use deser::ext::Number;
use deser_value::{Map, Seq};

fn tagged(name: &str, value: Value) -> Value {
    let mut map = Map::new();
    map.insert(name, value);
    Value::from(map)
}
fn sequence(values: Vec<Value>) -> Value {
    Value::from(Seq::from(values))
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}
fn unhex(value: &Value) -> Result<Vec<u8>, JsError> {
    let text = value.as_str().ok_or_else(invalid)?;
    if text.len() % 2 != 0 {
        return Err(invalid());
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).ok_or_else(invalid)?;
            let low = (pair[1] as char).to_digit(16).ok_or_else(invalid)?;
            Ok(((high << 4) | low) as u8)
        })
        .collect()
}

pub(super) fn render(value: &Value, depth: usize) -> Result<Value, JsError> {
    if depth > 64 {
        return Err(invalid());
    }
    let result = match value.kind() {
        Kind::Bytes(bytes) => tagged(
            if python_kind(value) == Some(PythonKind::ByteArray) {
                "$bytearray"
            } else {
                "$bytes"
            },
            Value::from(hex(bytes.data())),
        ),
        Kind::F64(value) if !value.is_finite() => tagged("$float", Value::from(value.to_string())),
        Kind::Seq(values) => {
            let items = values
                .iter()
                .map(|value| render(value, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            match python_kind(value) {
                Some(PythonKind::Tuple) => tagged("$tuple", sequence(items)),
                Some(PythonKind::Set) => tagged("$set", sequence(items)),
                Some(PythonKind::FrozenSet) => tagged("$frozenset", sequence(items)),
                _ => sequence(items),
            }
        }
        Kind::Map(values) if values.keys().all(|key| key.as_str().is_some()) => {
            let mut result = Map::new();
            for (key, value) in values.iter() {
                result.insert(key.as_str().unwrap(), render(value, depth + 1)?);
            }
            Value::from(result)
        }
        Kind::Map(values) => {
            let pairs = values
                .iter()
                .map(|(key, value)| {
                    Ok(sequence(vec![
                        render(key, depth + 1)?,
                        render(value, depth + 1)?,
                    ]))
                })
                .collect::<Result<Vec<_>, JsError>>()?;
            tagged("$dict", sequence(pairs))
        }
        _ => {
            let mut result = value.clone();
            result.take_meta();
            result
        }
    };
    Ok(result)
}

pub(super) fn restore(
    value: Value,
    original: Option<&Value>,
    depth: usize,
) -> Result<Value, JsError> {
    if depth > 64 {
        return Err(invalid());
    }
    let literal_map = original
        .and_then(|value| value.as_map())
        .is_some_and(|map| map.keys().all(|key| key.as_str().is_some()));
    match value.into_kind() {
        Kind::Map(map) if map.len() == 1 && !literal_map => {
            let (key, content) = map.iter().next().unwrap();
            match key.as_str() {
                Some("$bytes" | "$bytearray") => {
                    let mut bytes = Value::bytes(unhex(content)?);
                    if key.as_str() == Some("$bytearray") {
                        set_kind(&mut bytes, PythonKind::ByteArray);
                    }
                    Ok(bytes)
                }
                Some("$tuple" | "$set" | "$frozenset") => {
                    let kind = match key.as_str().unwrap() {
                        "$tuple" => PythonKind::Tuple,
                        "$set" => PythonKind::Set,
                        _ => PythonKind::FrozenSet,
                    };
                    let values = content.as_seq().ok_or_else(invalid)?;
                    let old = original.and_then(|value| value.as_seq());
                    let mut result = sequence(
                        values
                            .iter()
                            .enumerate()
                            .map(|(index, value)| {
                                restore(
                                    value.clone(),
                                    old.and_then(|values| values.get(index)),
                                    depth + 1,
                                )
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                    set_kind(&mut result, kind);
                    Ok(result)
                }
                Some("$dict") => {
                    let pairs = content.as_seq().ok_or_else(invalid)?;
                    let old = original.and_then(|value| value.as_map());
                    let mut result = Map::new();
                    for pair in pairs.iter() {
                        let pair = pair.as_seq().ok_or_else(invalid)?;
                        if pair.len() != 2 {
                            return Err(invalid());
                        }
                        let key = restore(pair[0].clone(), None, depth + 1)?;
                        let value = restore(
                            pair[1].clone(),
                            old.and_then(|map| map.get(&key)),
                            depth + 1,
                        )?;
                        if result.insert(key, value).is_some() {
                            return Err(invalid());
                        }
                    }
                    Ok(Value::from(result))
                }
                Some("$float") => {
                    let float = match content.as_str() {
                        Some("NaN") => f64::NAN,
                        Some("inf" | "Infinity") => f64::INFINITY,
                        Some("-inf" | "-Infinity") => f64::NEG_INFINITY,
                        _ => return Err(invalid()),
                    };
                    if let Some(previous) = original.and_then(|value| value.as_f64()) {
                        if previous.to_string() == float.to_string() {
                            return Ok(Value::from(previous));
                        }
                    }
                    Ok(Value::from(float))
                }
                _ => restore_map(map, original, depth),
            }
        }
        Kind::Map(map) => restore_map(map, original, depth),
        Kind::Seq(values) => {
            let old = original.and_then(|value| value.as_seq());
            Ok(sequence(
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        restore(
                            value.clone(),
                            old.and_then(|values| values.get(index)),
                            depth + 1,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        kind => {
            let value = Value::new(kind);
            let value = if let Some(number) = value.downcast_ext_value::<Number>() {
                if number.is_integer() {
                    Value::ext(number.as_str().parse::<BigInt>().map_err(|_| invalid())?)
                } else {
                    if !number.value().is_finite() {
                        return Err(invalid());
                    }
                    Value::from(number.value())
                }
            } else {
                value
            };
            if original.is_some_and(|value| matches!(value.kind(), Kind::F64(_)))
                && number_text(&value).is_some()
            {
                let float = deser_json::to_string(&value)
                    .map_err(|_| invalid())?
                    .parse::<f64>()
                    .map_err(|_| invalid())?;
                if !float.is_finite() {
                    return Err(invalid());
                }
                Ok(Value::from(float))
            } else {
                Ok(value)
            }
        }
    }
}

fn restore_map(map: Map, original: Option<&Value>, depth: usize) -> Result<Value, JsError> {
    let old = original.and_then(|value| value.as_map());
    let mut result = Map::new();
    for (key, value) in map {
        let key = key.as_str().ok_or_else(invalid)?;
        result.insert(
            key,
            restore(value, old.and_then(|map| map.get(key)), depth + 1)?,
        );
    }
    Ok(Value::from(result))
}
