use super::{LimitedOutput, invalid, string_key, to_json};
use nsh_core::prelude::*;
use rmpv::{Value, ValueRef};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;
use std::{
    collections::{HashMap, VecDeque},
    fmt,
};

pub(in super::super) fn from_json(text: &str, original: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut remaining = original;
    let original =
        rmpv::decode::read_value_ref_with_max_depth(&mut remaining, 64).map_err(|_| invalid())?;
    if !remaining.is_empty() {
        return Err(invalid());
    }
    let json: &RawValue = serde_json::from_str(text).map_err(|_| invalid())?;
    let value = parse(json, Some(&original), 0)?;
    let mut output = LimitedOutput(Vec::new());
    rmpv::encode::write_value(&mut output, &value).map_err(|_| invalid())?;
    // Apply the same nesting and displayed-output limits as the read path.
    to_json(&output.0)?;
    Ok(output.0)
}

// Raw JSON values retain exact number literals; this map visitor also preserves
// entry order and duplicate keys instead of collecting them into a JSON object.
struct Fields<'a>(Vec<(String, &'a RawValue)>);
impl<'de> Deserialize<'de> for Fields<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;
        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = Fields<'de>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(Fields(entries))
            }
        }
        deserializer.deserialize_map(FieldVisitor)
    }
}

fn parse(raw: &RawValue, original: Option<&ValueRef<'_>>, depth: usize) -> Result<Value, JsError> {
    if depth > 64 {
        return Err(invalid());
    }
    let text = raw.get();
    match text.as_bytes()[0] {
        b'n' => Ok(Value::Nil),
        b't' | b'f' => Ok(Value::Boolean(
            serde_json::from_str(text).map_err(|_| invalid())?,
        )),
        b'"' => {
            let text: String = serde_json::from_str(text).map_err(|_| invalid())?;
            Ok(Value::from(text))
        }
        b'[' => {
            let values: Vec<&RawValue> = serde_json::from_str(text).map_err(|_| invalid())?;
            let old = match original {
                Some(ValueRef::Array(values)) => Some(values),
                _ => None,
            };
            values
                .iter()
                .enumerate()
                .map(|(index, raw)| parse(raw, old.and_then(|values| values.get(index)), depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        b'{' => object(raw, original, depth + 1),
        _ => number(text, original),
    }
}

fn number(text: &str, original: Option<&ValueRef<'_>>) -> Result<Value, JsError> {
    if let Some(ValueRef::F32(_)) = original {
        let value = text.parse::<f32>().map_err(|_| invalid())?;
        return if value.is_finite() {
            Ok(Value::F32(value))
        } else {
            Err(invalid())
        };
    }
    if matches!(original, Some(ValueRef::F64(_))) || text.contains(['.', 'e', 'E']) {
        let value = text.parse::<f64>().map_err(|_| invalid())?;
        return if value.is_finite() {
            Ok(Value::F64(value))
        } else {
            Err(invalid())
        };
    }
    if text.starts_with('-') {
        text.parse::<i64>().map(Value::from).map_err(|_| invalid())
    } else {
        text.parse::<u64>().map(Value::from).map_err(|_| invalid())
    }
}

fn object(raw: &RawValue, original: Option<&ValueRef<'_>>, depth: usize) -> Result<Value, JsError> {
    let Fields(entries) = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
    let old_map = match original {
        Some(ValueRef::Map(entries)) => Some(entries),
        _ => None,
    };
    let literal_map =
        old_map.is_some_and(|entries| entries.iter().all(|(key, _)| string_key(key).is_some()));
    if entries.len() == 1 && !literal_map {
        let (name, raw) = &entries[0];
        match name.as_str() {
            "$binary" => return Ok(Value::Binary(hex(raw)?)),
            "$invalidUtf8" => {
                let bytes = hex(raw)?;
                let mut packed = vec![0xdb];
                packed.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                packed.extend_from_slice(&bytes);
                return rmpv::decode::read_value(&mut packed.as_slice()).map_err(|_| invalid());
            }
            "$ext" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Extension<'a> {
                    r#type: i8,
                    #[serde(borrow)]
                    data: &'a RawValue,
                }
                let extension: Extension =
                    serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                return Ok(Value::Ext(extension.r#type, hex(extension.data)?));
            }
            "$float" => {
                let value: String = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                let float = match value.as_str() {
                    "NaN" => f64::NAN,
                    "inf" | "Infinity" => f64::INFINITY,
                    "-inf" | "-Infinity" => f64::NEG_INFINITY,
                    _ => return Err(invalid()),
                };
                return Ok(match original {
                    Some(ValueRef::F32(previous)) => Value::F32(if previous.to_string() == value {
                        *previous
                    } else {
                        float as f32
                    }),
                    Some(ValueRef::F64(previous)) if previous.to_string() == value => {
                        Value::F64(*previous)
                    }
                    _ => Value::F64(float),
                });
            }
            "$map" => {
                let pairs: Vec<[&RawValue; 2]> =
                    serde_json::from_str(raw.get()).map_err(|_| invalid())?;
                let mut map = Vec::new();
                for (index, [key, value]) in pairs.into_iter().enumerate() {
                    let old = old_map.and_then(|entries| entries.get(index));
                    map.push((
                        parse(key, old.map(|entry| &entry.0), depth + 1)?,
                        parse(value, old.map(|entry| &entry.1), depth + 1)?,
                    ));
                }
                return Ok(Value::Map(map));
            }
            _ => {}
        }
    }
    let mut hints: HashMap<&str, VecDeque<&ValueRef<'_>>> = HashMap::new();
    if let Some(entries) = old_map {
        for (key, value) in entries {
            if let Some(key) = string_key(key) {
                hints.entry(key).or_default().push_back(value);
            }
        }
    }
    let mut map = Vec::new();
    for (key, value) in entries {
        let hint = hints.get_mut(key.as_str()).and_then(VecDeque::pop_front);
        map.push((Value::from(key), parse(value, hint, depth)?));
    }
    Ok(Value::Map(map))
}

fn hex(raw: &RawValue) -> Result<Vec<u8>, JsError> {
    let text: String = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
    let text = text.strip_prefix("0x").unwrap_or(&text);
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
