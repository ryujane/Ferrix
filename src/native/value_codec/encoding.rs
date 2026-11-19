use super::{
    MAX_INPUT, MAX_OUTPUT, decode_payload, general_purpose, invalid, messagepack, pickle, too_large,
};
use base64::Engine;
use nsh_core::prelude::*;
use std::io::Write;

pub(super) fn encode(
    text: &str,
    original: &[u8],
    decoding: &str,
    compression: &str,
) -> Result<Vec<u8>, JsError> {
    if text.len() > MAX_OUTPUT || original.len() > MAX_INPUT {
        return Err(too_large());
    }
    let original_payload = decode_payload(original.to_vec(), decoding, compression)?;
    let payload = match decoding {
        "msgpack" => messagepack::from_json(text, &original_payload)?,
        "pickle" => pickle::from_json(text, &original_payload)?,
        _ => text.as_bytes().to_vec(),
    };
    let bytes = match compression {
        "none" => payload,
        "gzip" => {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Default::default());
            encoder.write_all(&payload).map_err(|_| invalid())?;
            encoder.finish().map_err(|_| invalid())?
        }
        "zlib" => {
            let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), Default::default());
            encoder.write_all(&payload).map_err(|_| invalid())?;
            encoder.finish().map_err(|_| invalid())?
        }
        "deflate" => {
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), Default::default());
            encoder.write_all(&payload).map_err(|_| invalid())?;
            encoder.finish().map_err(|_| invalid())?
        }
        "zstd" => zstd::stream::encode_all(payload.as_slice(), 1).map_err(|_| invalid())?,
        "lz4" => {
            let mut encoder = lz4_flex::frame::FrameEncoder::new(Vec::new());
            encoder.write_all(&payload).map_err(|_| invalid())?;
            encoder.finish().map_err(|_| invalid())?
        }
        "lz4-size-prefixed" => lz4_flex::compress_prepend_size(&payload),
        "snappy" => {
            let wrapped = decode_payload(original.to_vec(), decoding, "none")?;
            if wrapped.starts_with(b"\xff\x06\x00\x00sNaPpY") {
                let mut encoder = snap::write::FrameEncoder::new(Vec::new());
                encoder.write_all(&payload).map_err(|_| invalid())?;
                encoder.into_inner().map_err(|_| invalid())?
            } else {
                snap::raw::Encoder::new()
                    .compress_vec(&payload)
                    .map_err(|_| invalid())?
            }
        }
        _ => return Err(invalid()),
    };
    if bytes.len() > MAX_INPUT {
        return Err(too_large());
    }
    let bytes = match decoding {
        "none" | "msgpack" | "pickle" => bytes,
        "base64" | "base64url" => {
            let padded = original.iter().rfind(|byte| !byte.is_ascii_whitespace()) == Some(&b'=');
            let engine = match (decoding, padded) {
                ("base64", true) => &general_purpose::STANDARD,
                ("base64", false) => &general_purpose::STANDARD_NO_PAD,
                (_, true) => &general_purpose::URL_SAFE,
                (_, false) => &general_purpose::URL_SAFE_NO_PAD,
            };
            engine.encode(bytes).into_bytes()
        }
        "hex" => {
            let upper = original.iter().any(|byte| matches!(byte, b'A'..=b'F'))
                && !original.iter().any(|byte| matches!(byte, b'a'..=b'f'));
            let digits = if upper {
                b"0123456789ABCDEF"
            } else {
                b"0123456789abcdef"
            };
            let mut hex = Vec::with_capacity(bytes.len() * 2 + 2);
            if original.trim_ascii_start().starts_with(b"0x") {
                hex.extend_from_slice(b"0x");
            }
            for byte in bytes {
                hex.push(digits[(byte >> 4) as usize]);
                hex.push(digits[(byte & 15) as usize]);
            }
            hex
        }
        "url" => {
            const ESCAPE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
                .remove(b'-')
                .remove(b'_')
                .remove(b'.')
                .remove(b'~');
            percent_encoding::percent_encode(&bytes, ESCAPE)
                .to_string()
                .into_bytes()
        }
        _ => return Err(invalid()),
    };
    if bytes.len() > MAX_INPUT {
        return Err(too_large());
    }
    Ok(bytes)
}
