use super::{MAX_OUTPUT, invalid, too_large};
use nsh_core::prelude::*;
use rmpv::ValueRef;
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use std::io::{self, Write};

mod encoding;
pub(super) use encoding::from_json;

pub(super) fn to_json(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut remaining = bytes;
    let value =
        rmpv::decode::read_value_ref_with_max_depth(&mut remaining, 64).map_err(|_| invalid())?;
    if !remaining.is_empty() {
        return Err(invalid());
    }
    validate_markers(&value, &mut bytes.as_ref())?;
    let mut output = LimitedOutput(Vec::new());
    serde_json::to_writer(&mut output, &Json(&value)).map_err(|cause| {
        if cause.is_io() {
            too_large()
        } else {
            invalid()
        }
    })?;
    Ok(output.0)
}

// rmpv treats the reserved 0xc1 marker as nil. Walk the parsed structure and
// source together so invalid markers cannot silently become JSON null.
fn validate_markers(value: &ValueRef<'_>, bytes: &mut &[u8]) -> Result<(), JsError> {
    let marker = *bytes.first().ok_or_else(invalid)?;
    if marker == 0xc1 {
        return Err(invalid());
    }
    let header = match marker {
        0xcc | 0xd0 | 0xc4 | 0xc7 | 0xd9 => 2,
        0xcd | 0xd1 | 0xc5 | 0xc8 | 0xda | 0xdc | 0xde => 3,
        0xce | 0xd2 | 0xca | 0xc6 | 0xc9 | 0xdb | 0xdd | 0xdf => 5,
        0xcf | 0xd3 | 0xcb => 9,
        _ => 1,
    };
    let payload = match value {
        ValueRef::String(value) => value.as_bytes().len(),
        ValueRef::Binary(value) => value.len(),
        ValueRef::Ext(_, value) => value.len() + 1,
        _ => 0,
    };
    *bytes = bytes.get(header + payload..).ok_or_else(invalid)?;
    match value {
        ValueRef::Array(values) => {
            for value in values {
                validate_markers(value, bytes)?;
            }
        }
        ValueRef::Map(entries) => {
            for (key, value) in entries {
                validate_markers(key, bytes)?;
                validate_markers(value, bytes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

struct LimitedOutput(Vec<u8>);
impl Write for LimitedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_OUTPUT - self.0.len() {
            return Err(io::Error::other("Value preview size limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Tagged JSON retains values JSON cannot directly represent. Maps with ordinary
// string keys keep their original order and duplicate entries.
struct Json<'a, 'b>(&'a ValueRef<'b>);
impl Serialize for Json<'_, '_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            ValueRef::Nil => serializer.serialize_none(),
            ValueRef::Boolean(value) => serializer.serialize_bool(*value),
            ValueRef::Integer(value) => {
                if let Some(value) = value.as_u64() {
                    serializer.serialize_u64(value)
                } else {
                    serializer.serialize_i64(value.as_i64().unwrap())
                }
            }
            ValueRef::F32(value) if value.is_finite() => serializer.serialize_f32(*value),
            ValueRef::F64(value) if value.is_finite() => serializer.serialize_f64(*value),
            ValueRef::F32(value) => tagged(serializer, "$float", &value.to_string()),
            ValueRef::F64(value) => tagged(serializer, "$float", &value.to_string()),
            ValueRef::String(value) => match value.as_str() {
                Some(text) => serializer.serialize_str(text),
                None => tagged(serializer, "$invalidUtf8", &hex(value.as_bytes())),
            },
            ValueRef::Binary(value) => tagged(serializer, "$binary", &hex(value)),
            ValueRef::Ext(kind, value) => {
                #[derive(Serialize)]
                struct Extension {
                    r#type: i8,
                    data: String,
                }
                tagged(
                    serializer,
                    "$ext",
                    &Extension {
                        r#type: *kind,
                        data: hex(value),
                    },
                )
            }
            ValueRef::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&Json(value))?;
                }
                sequence.end()
            }
            ValueRef::Map(entries) if entries.iter().all(|(key, _)| string_key(key).is_some()) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(string_key(key).unwrap(), &Json(value))?;
                }
                map.end()
            }
            ValueRef::Map(entries) => {
                struct Pairs<'a, 'b>(&'a [(ValueRef<'b>, ValueRef<'b>)]);
                impl Serialize for Pairs<'_, '_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
                        for (key, value) in self.0 {
                            sequence.serialize_element(&(Json(key), Json(value)))?;
                        }
                        sequence.end()
                    }
                }
                tagged(serializer, "$map", &Pairs(entries))
            }
        }
    }
}

fn string_key<'a>(value: &'a ValueRef<'_>) -> Option<&'a str> {
    match value {
        ValueRef::String(value) => value.as_str(),
        _ => None,
    }
}

fn tagged<S: Serializer>(
    serializer: S,
    name: &str,
    value: &impl Serialize,
) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(1))?;
    map.serialize_entry(name, value)?;
    map.end()
}
fn hex(value: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 15) as usize] as char);
    }
    output
}
