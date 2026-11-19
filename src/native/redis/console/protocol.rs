//! Bounded RESP framing for a CLI socket, including unsolicited MONITOR/PubSub frames.
use super::*;
use std::{future::Future, pin::Pin};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

pub(super) type Stream = Box<dyn redis::aio::AsyncStream + Send + Unpin>;
pub(super) type Reader = tokio::io::BufReader<tokio::io::ReadHalf<Stream>>;

pub(super) async fn read(reader: &mut Reader, budget: usize) -> Result<redis::Value, JsError> {
    let mut bytes = Vec::new();
    frame(reader, &mut bytes, budget, 0).await?;
    redis::parse_redis_value(&bytes).map_err(|_| invalid())
}

fn invalid() -> JsError {
    error("PROTOCOL_ERROR", "Invalid Redis CLI response")
}
fn oversized() -> JsError {
    error(
        "PAYLOAD_TOO_LARGE",
        "Redis CLI response exceeds the limit; the command may have executed",
    )
}
fn io(_: std::io::Error) -> JsError {
    error("CONNECTION_FAILED", "Redis CLI connection was lost")
}

fn frame<'a>(
    reader: &'a mut Reader,
    bytes: &'a mut Vec<u8>,
    budget: usize,
    depth: usize,
) -> Pin<Box<dyn Future<Output = Result<(), JsError>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 32 {
            return Err(oversized());
        }
        let remaining = budget.saturating_sub(bytes.len());
        if remaining < 3 {
            return Err(oversized());
        }
        let mut header = Vec::new();
        (&mut *reader)
            .take(remaining as u64)
            .read_until(b'\n', &mut header)
            .await
            .map_err(io)?;
        if header.is_empty() {
            return Err(io(std::io::ErrorKind::UnexpectedEof.into()));
        }
        if !header.ends_with(b"\r\n") {
            return Err(if header.len() == remaining {
                oversized()
            } else {
                invalid()
            });
        }
        let marker = header[0];
        let count = || {
            std::str::from_utf8(&header[1..header.len() - 2])
                .ok()
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or_else(invalid)
        };
        bytes.extend_from_slice(&header);
        match marker {
            b'+' | b'-' | b':' | b',' | b'_' | b'#' | b'(' => {}
            b'$' | b'!' | b'=' => {
                let length = count()?;
                if length == -1 && marker == b'$' {
                    return Ok(());
                }
                let length = usize::try_from(length).map_err(|_| invalid())?;
                let length = length.checked_add(2).ok_or_else(oversized)?;
                if length > budget.saturating_sub(bytes.len()) {
                    return Err(oversized());
                }
                let start = bytes.len();
                bytes.resize(start + length, 0);
                reader.read_exact(&mut bytes[start..]).await.map_err(io)?;
                if !bytes.ends_with(b"\r\n") {
                    return Err(invalid());
                }
            }
            b'*' | b'~' | b'>' | b'%' | b'|' => {
                let length = count()?;
                if length == -1 && marker == b'*' {
                    return Ok(());
                }
                let mut length = usize::try_from(length).map_err(|_| invalid())?;
                if marker == b'%' || marker == b'|' {
                    length = length.checked_mul(2).ok_or_else(oversized)?;
                }
                if marker == b'|' {
                    length = length.checked_add(1).ok_or_else(oversized)?;
                }
                if length > budget.saturating_sub(bytes.len()) / 3 {
                    return Err(oversized());
                }
                for _ in 0..length {
                    frame(reader, bytes, budget, depth + 1).await?;
                }
            }
            _ => return Err(invalid()),
        }
        Ok(())
    })
}

pub(super) fn format(value: &redis::Value) -> String {
    let mut output = Output {
        text: String::new(),
        truncated: false,
    };
    display(value, 0, &mut output);
    if output.truncated {
        output.text.push_str("\n(output truncated)");
    }
    output.text
}
struct Output {
    text: String,
    truncated: bool,
}
impl Output {
    fn push(&mut self, value: &str) {
        const LIMIT: usize = 1024 * 1024 - 32;
        let remaining = LIMIT.saturating_sub(self.text.len());
        if value.len() <= remaining {
            self.text.push_str(value);
        } else {
            let mut end = remaining;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            self.text.push_str(&value[..end]);
            self.truncated = true;
        }
    }
    fn row(&mut self, index: usize, depth: usize) {
        if index > 0 {
            self.push("\n");
            self.push(&" ".repeat(depth * 3));
        }
        self.push(&format!("{}) ", index + 1));
    }
}
fn string(bytes: &[u8], nested: bool) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        if !nested
            && !text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return if text.is_empty() {
                "(empty string)".into()
            } else {
                text.into()
            };
        }
        return serde_json::to_string(text).unwrap_or_default();
    }
    format!(
        "\"{}\"",
        bytes
            .iter()
            .flat_map(|b| std::ascii::escape_default(*b))
            .map(char::from)
            .collect::<String>()
    )
}
fn display(value: &redis::Value, depth: usize, output: &mut Output) {
    if output.truncated {
        return;
    }
    use redis::Value::*;
    match value {
        Nil => output.push("(nil)"),
        Okay => output.push("OK"),
        Int(n) => output.push(&format!("(integer) {n}")),
        BulkString(bytes) => output.push(&string(bytes, depth > 0)),
        SimpleString(text) | VerbatimString { text, .. } => output.push(text),
        ServerError(cause) => output.push(&format!(
            "(error) {} {}",
            cause.code(),
            cause.details().unwrap_or_default()
        )),
        Double(n) => output.push(&format!("(double) {n}")),
        Boolean(value) => output.push(&format!("(boolean) {value}")),
        BigNumber(number) => output.push(&format!("(bignum) {number}")),
        Attribute { data, .. } => display(data, depth, output),
        Array(items) | Set(items) => list(items, depth, output),
        Map(items) => {
            if items.is_empty() {
                output.push("(empty map)");
            }
            for (i, (key, value)) in items.iter().enumerate() {
                if output.truncated {
                    break;
                }
                output.row(i, depth);
                display(key, depth + 1, output);
                output.push(" => ");
                display(value, depth + 1, output);
            }
        }
        Push { kind, data } => {
            output.push(&format!("{kind:?}\n"));
            list(data, depth, output);
        }
        _ => output.push("(unrecognized RESP value)"),
    }
}
fn list(items: &[redis::Value], depth: usize, output: &mut Output) {
    if items.is_empty() {
        output.push("(empty array)");
    }
    for (i, item) in items.iter().enumerate() {
        if output.truncated {
            break;
        }
        output.row(i, depth);
        display(item, depth + 1, output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frames_nested_binary_and_resp3_without_reading_the_next_reply() {
        let (mut tx, rx) = tokio::io::duplex(1024);
        use tokio::io::AsyncWriteExt;
        tx.write_all(b"*3\r\n:9007199254740993\r\n$2\r\n\xff\0\r\n-ERR nested\r\n+OK\r\n")
            .await
            .unwrap();
        let mut reader = Reader::new(tokio::io::split(Box::new(rx) as Stream).0);
        let value = read(&mut reader, 1024).await.unwrap();
        let text = format(&value);
        assert!(
            text.contains("9007199254740993")
                && text.contains("\\xff\\x00")
                && text.contains("nested"),
            "{text}"
        );
        assert_eq!(format(&read(&mut reader, 1024).await.unwrap()), "OK");
    }
    #[tokio::test]
    async fn rejects_oversized_lengths_before_allocating_or_waiting_for_payloads() {
        let (mut tx, rx) = tokio::io::duplex(1024);
        use tokio::io::AsyncWriteExt;
        tx.write_all(b"$999999999\r\n").await.unwrap();
        assert_eq!(
            read(
                &mut Reader::new(tokio::io::split(Box::new(rx) as Stream).0),
                1024
            )
            .await
            .unwrap_err()
            .code(),
            Some("PAYLOAD_TOO_LARGE")
        );
    }
    #[test]
    fn formatting_nested_aggregates_stops_at_the_output_budget() {
        let mut value = redis::Value::Array(vec![redis::Value::Nil; 20000]);
        for _ in 0..31 {
            value = redis::Value::Array(vec![value]);
        }
        let text = format(&value);
        assert!(text.len() <= 1024 * 1024 && text.ends_with("(output truncated)"));
    }
}
