//! Bounded value decoding and encoding, independent of Redis transports.

use base64::{Engine, engine::general_purpose};
use nsh_core::prelude::*;
use std::io::Read;
use tokio::sync::{Semaphore, oneshot};

mod encoding;
mod messagepack;
mod pickle;
#[cfg(test)]
mod tests;

const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;
static WORKERS: Semaphore = Semaphore::const_new(4);

/// Decode values for editing and restore their encoding before saving.
#[module]
pub struct ValueCodec;

#[module]
impl ValueCodec {
    /// Binary text encodings are removed before decompression. MessagePack/Pickle is
    /// parsed after decompression, preserving binary and extension values in JSON.
    /// Input is limited to 64 KiB and the resulting preview to 1 MiB.
    pub fn decode(
        value: Vec<u8>,
        decoding: String,
        decompression: String,
    ) -> Result<Later<Vec<u8>>, JsError> {
        if value.len() > MAX_INPUT {
            return Err(too_large());
        }
        task(move || transform(value, &decoding, &decompression))
    }

    /// Re-encode edited text using the original bytes as format/type hints.
    /// MessagePack/Pickle is serialized before compression; binary text encodings are
    /// reapplied last. Edited text is limited to 1 MiB and stored bytes to 64 KiB.
    /// This only prepares bytes; the caller performs the existing Redis write.
    pub fn encode(
        value: String,
        original: Vec<u8>,
        decoding: String,
        decompression: String,
    ) -> Result<Later<Vec<u8>>, JsError> {
        if value.len() > MAX_OUTPUT || original.len() > MAX_INPUT {
            return Err(too_large());
        }
        task(move || encoding::encode(&value, &original, &decoding, &decompression))
    }
}

fn task(
    work: impl FnOnce() -> Result<Vec<u8>, JsError> + Send + 'static,
) -> Result<Later<Vec<u8>>, JsError> {
    let permit = WORKERS
        .try_acquire()
        .map_err(|_| error("VALUE_CODEC_BUSY", "Value codec workers are busy"))?;
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("ferrix-value-codec".into())
        .spawn(move || {
            let _permit = permit;
            let _ = tx.send(work());
        })
        .map_err(|_| unavailable())?;
    Ok(Later::new(
        async move { rx.await.map_err(|_| unavailable())? },
    ))
}

fn error(code: &str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}
fn invalid() -> JsError {
    error(
        "VALUE_CODEC_INVALID",
        "Value does not match the selected format",
    )
}
fn too_large() -> JsError {
    error(
        "VALUE_CODEC_TOO_LARGE",
        "Value preview exceeds the size limit",
    )
}
fn unavailable() -> JsError {
    error(
        "VALUE_CODEC_UNAVAILABLE",
        "Value preview worker is unavailable",
    )
}

fn transform(value: Vec<u8>, decoding: &str, decompression: &str) -> Result<Vec<u8>, JsError> {
    let bytes = decode_payload(value, decoding, decompression)?;
    match decoding {
        "msgpack" => messagepack::to_json(&bytes),
        "pickle" => pickle::to_json(&bytes),
        _ => Ok(bytes),
    }
}

fn decode_payload(value: Vec<u8>, decoding: &str, decompression: &str) -> Result<Vec<u8>, JsError> {
    if value.len() > MAX_INPUT {
        return Err(too_large());
    }
    let bytes = match decoding {
        "none" | "msgpack" | "pickle" => value,
        "base64" | "base64url" => {
            let compact: Vec<_> = value
                .into_iter()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect();
            let engines = if decoding == "base64" {
                [
                    &general_purpose::STANDARD,
                    &general_purpose::STANDARD_NO_PAD,
                ]
            } else {
                [
                    &general_purpose::URL_SAFE,
                    &general_purpose::URL_SAFE_NO_PAD,
                ]
            };
            engines[0]
                .decode(&compact)
                .or_else(|_| engines[1].decode(&compact))
                .map_err(|_| invalid())?
        }
        "hex" => {
            let compact: Vec<_> = value
                .into_iter()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect();
            let hex = compact.strip_prefix(b"0x").unwrap_or(&compact);
            if hex.len() % 2 != 0 {
                return Err(invalid());
            }
            hex.chunks_exact(2)
                .map(|pair| {
                    let high = (pair[0] as char).to_digit(16).ok_or_else(invalid)?;
                    let low = (pair[1] as char).to_digit(16).ok_or_else(invalid)?;
                    Ok(((high << 4) | low) as u8)
                })
                .collect::<Result<Vec<_>, JsError>>()?
        }
        "url" => {
            let mut index = 0;
            while index < value.len() {
                if value[index] == b'%' {
                    if index + 2 >= value.len()
                        || !value[index + 1..index + 3]
                            .iter()
                            .all(u8::is_ascii_hexdigit)
                    {
                        return Err(invalid());
                    }
                    index += 2;
                }
                index += 1;
            }
            percent_encoding::percent_decode(&value).collect()
        }
        _ => return Err(invalid()),
    };
    let bytes = match decompression {
        "none" => bytes,
        "gzip" => read_bounded(flate2::read::MultiGzDecoder::new(bytes.as_slice()))?,
        "zlib" | "deflate" => inflate(&bytes, decompression == "zlib")?,
        "zstd" => {
            let mut decoder = zstd::stream::read::Decoder::with_buffer(bytes.as_slice())
                .map_err(|_| invalid())?;
            decoder.window_log_max(23).map_err(|_| invalid())?;
            read_bounded(decoder)?
        }
        "lz4" => {
            validate_lz4_frame(&bytes)?;
            read_bounded(lz4_flex::frame::FrameDecoder::new(bytes.as_slice()))?
        }
        "lz4-size-prefixed" => {
            let length = bytes.get(..4).ok_or_else(invalid)?;
            let length = u32::from_le_bytes(length.try_into().unwrap()) as usize;
            if length > MAX_OUTPUT {
                return Err(too_large());
            }
            let mut output = vec![0; length];
            let written =
                lz4_flex::decompress_into(&bytes[4..], &mut output).map_err(|_| invalid())?;
            if written != length {
                return Err(invalid());
            }
            output
        }
        "snappy" => {
            if bytes.starts_with(b"\xff\x06\x00\x00sNaPpY") {
                read_bounded(snap::read::FrameDecoder::new(bytes.as_slice()))?
            } else {
                if snap::raw::decompress_len(&bytes).map_err(|_| invalid())? > MAX_OUTPUT {
                    return Err(too_large());
                }
                snap::raw::Decoder::new()
                    .decompress_vec(&bytes)
                    .map_err(|_| invalid())?
            }
        }
        _ => return Err(invalid()),
    };
    Ok(bytes)
}

// FrameDecoder treats an EOF before the end marker as a finished stream.
// Verify the complete frame boundary before accepting its decoded output.
fn validate_lz4_frame(bytes: &[u8]) -> Result<(), JsError> {
    if !bytes.starts_with(&[4, 34, 77, 24]) || bytes.len() < 7 {
        return Err(invalid());
    }
    let flags = bytes[4];
    let mut offset = 7 + usize::from(flags & 8 != 0) * 8 + usize::from(flags & 1 != 0) * 4;
    loop {
        let length = bytes.get(offset..offset + 4).ok_or_else(invalid)?;
        let length = u32::from_le_bytes(length.try_into().unwrap()) & 0x7fff_ffff;
        offset += 4;
        if length == 0 {
            offset += usize::from(flags & 4 != 0) * 4;
            return if offset == bytes.len() {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        offset += length as usize + usize::from(flags & 16 != 0) * 4;
        if offset > bytes.len() {
            return Err(invalid());
        }
    }
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>, JsError> {
    let mut output = Vec::new();
    reader
        .take(MAX_OUTPUT as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| invalid())?;
    if output.len() > MAX_OUTPUT {
        return Err(too_large());
    }
    Ok(output)
}

fn inflate(input: &[u8], zlib: bool) -> Result<Vec<u8>, JsError> {
    let mut decoder = flate2::Decompress::new(zlib);
    let mut output = Vec::new();
    loop {
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let mut buffer = [0; 8192];
        let status = decoder
            .decompress(
                &input[before_in as usize..],
                &mut buffer,
                flate2::FlushDecompress::Finish,
            )
            .map_err(|_| invalid())?;
        let written = (decoder.total_out() - before_out) as usize;
        if output.len() + written > MAX_OUTPUT {
            return Err(too_large());
        }
        output.extend_from_slice(&buffer[..written]);
        if status == flate2::Status::StreamEnd {
            return if decoder.total_in() as usize == input.len() {
                Ok(output)
            } else {
                Err(invalid())
            };
        }
        if decoder.total_in() == before_in && written == 0 {
            return Err(invalid());
        }
    }
}
