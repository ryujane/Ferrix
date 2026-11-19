//! Data-only Pickle values. Python classes, callbacks and object graphs are
//! rejected rather than executed or flattened into different data.
use super::{MAX_OUTPUT, error, invalid, too_large};
use deser::{Context, State, de::Limits, ext::BigInt};
use deser_pickle::{Kind as PythonKind, take_class, take_kind, take_shared_id};
use deser_value::{Kind, Value};
use nsh_core::prelude::JsError;
use std::collections::HashSet;

mod json;
mod legacy;

pub(super) fn unsupported() -> JsError {
    error(
        "VALUE_CODEC_PICKLE_UNSUPPORTED",
        "Unsupported Pickle object or reference",
    )
}

fn context() -> Context {
    Context::with(
        Limits::builder()
            .max_depth(64)
            .max_events(200_000)
            .max_items(65_536)
            .max_len(MAX_OUTPUT)
            .build(),
    )
}

fn read(bytes: &[u8]) -> Result<Value, JsError> {
    let value = deser_pickle::DeserializerConfig::builder()
        .context(context())
        .max_shared_events(4096)
        .build()
        .from_slice(bytes)
        .map_err(|_| invalid())?;
    validate(&value, 0)?;
    Ok(value)
}

pub(super) fn to_json(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    let value = json::render(&read(bytes)?, 0)?;
    let output = deser_json::to_string(&value)
        .map_err(|_| invalid())?
        .into_bytes();
    if output.len() > MAX_OUTPUT {
        return Err(too_large());
    }
    Ok(output)
}

pub(super) fn from_json(text: &str, original: &[u8]) -> Result<Vec<u8>, JsError> {
    let original_value = read(original)?;
    let edited = deser_json::DeserializerConfig::builder()
        .context(context())
        .build()
        .from_str(text)
        .map_err(|_| invalid())?;
    let value = json::restore(edited, Some(&original_value), 0)?;
    validate(&value, 0)?;
    let bytes = if original.first() == Some(&0x80) {
        let protocol = *original.get(1).ok_or_else(invalid)?;
        if !(2..=5).contains(&protocol) {
            return Err(unsupported());
        }
        deser_pickle::SerializerConfig::builder()
            .protocol(protocol)
            .build()
            .to_vec(&value)
            .map_err(|_| invalid())?
    } else {
        // Protocols 0 and 1 have no version header. Continue using the legacy,
        // text-compatible opcode set so the same Python versions can read it.
        legacy::encode(&value)?
    };
    if bytes.len() > MAX_OUTPUT {
        return Err(too_large());
    }
    // Keep the write contract consistent with the decoder and its limits.
    to_json(&bytes)?;
    Ok(bytes)
}

fn metadata(value: &Value) -> State {
    let mut state = State::new();
    if let Some(data) = value.event_data() {
        state.attach_event_data(data);
    }
    state
}

fn python_kind(value: &Value) -> Option<PythonKind> {
    take_kind(&mut metadata(value))
}

fn set_kind(value: &mut Value, kind: PythonKind) {
    let mut state = State::new();
    deser_pickle::set_kind(&mut state, kind);
    *value.meta_mut().event_data_mut() = state.capture_event_data();
}

fn number_text(value: &Value) -> Option<String> {
    match value.kind() {
        Kind::U64(value) => Some(value.to_string()),
        Kind::I64(value) => Some(value.to_string()),
        Kind::Ext(ext) => {
            if let Some(value) = ext.downcast_ref::<u128>() {
                Some(value.to_string())
            } else if let Some(value) = ext.downcast_ref::<i128>() {
                Some(value.to_string())
            } else {
                ext.downcast_ref::<BigInt>().map(ToString::to_string)
            }
        }
        _ => None,
    }
}

fn validate(value: &Value, depth: usize) -> Result<(), JsError> {
    if depth > 64 {
        return Err(invalid());
    }
    let mut state = metadata(value);
    if take_class(&mut state).is_some() {
        return Err(unsupported());
    }
    if take_shared_id(&mut state).is_some()
        && (value.is_seq() || value.is_map() || python_kind(value) == Some(PythonKind::ByteArray))
    {
        return Err(unsupported());
    }
    match value.kind() {
        Kind::Null
        | Kind::Bool(_)
        | Kind::U64(_)
        | Kind::I64(_)
        | Kind::F64(_)
        | Kind::Str(_)
        | Kind::Bytes(_) => {}
        Kind::Ext(_) if number_text(value).is_some() => {}
        Kind::Seq(values) => {
            let set = matches!(
                python_kind(value),
                Some(PythonKind::Set | PythonKind::FrozenSet)
            );
            let mut keys = HashSet::new();
            for item in values.iter() {
                validate(item, depth + 1)?;
                if set && !keys.insert(hash_key(item)?) {
                    return Err(invalid());
                }
            }
        }
        Kind::Map(values) => {
            let mut keys = HashSet::new();
            for (key, value) in values.iter() {
                if !keys.insert(hash_key(key)?) {
                    return Err(invalid());
                }
                validate(key, depth + 1)?;
                validate(value, depth + 1)?;
            }
        }
        _ => return Err(unsupported()),
    }
    Ok(())
}

// Python equates numeric map/set keys such as True, 1 and 1.0. Reject ambiguous
// duplicate keys instead of allowing Python to silently merge edited entries.
fn hash_key(value: &Value) -> Result<String, JsError> {
    if let Some(number) = number_text(value) {
        return Ok(format!("i{number}"));
    }
    match value.kind() {
        Kind::Null => Ok("none".into()),
        Kind::Bool(value) => Ok(format!("i{}", u8::from(*value))),
        Kind::F64(value) if value.is_finite() => {
            if value.fract() == 0.0 {
                Ok(format!("i{:.0}", if *value == 0.0 { 0.0 } else { *value }))
            } else {
                Ok(format!("f{value:?}"))
            }
        }
        Kind::Str(value) => Ok(format!("s{value:?}")),
        Kind::Bytes(bytes) if python_kind(value) != Some(PythonKind::ByteArray) => {
            Ok(format!("b{:?}", bytes.data()))
        }
        Kind::Seq(values)
            if matches!(
                python_kind(value),
                Some(PythonKind::Tuple | PythonKind::FrozenSet)
            ) =>
        {
            let mut keys = values.iter().map(hash_key).collect::<Result<Vec<_>, _>>()?;
            if python_kind(value) == Some(PythonKind::FrozenSet) {
                keys.sort();
            }
            Ok(format!("{:?}{keys:?}", python_kind(value)))
        }
        _ => Err(unsupported()),
    }
}
