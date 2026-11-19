use super::*;
use std::io::Write;

pub(super) fn encode(value: &Value) -> Result<Vec<u8>, JsError> {
    let mut output = Vec::new();
    write(value, &mut output, 0)?;
    output.push(b'.');
    Ok(output)
}

fn unicode(text: impl Iterator<Item = char>, output: &mut Vec<u8>) {
    output.push(b'V');
    for ch in text {
        let code = ch as u32;
        if (' '..='~').contains(&ch) && ch != '\\' {
            output.push(ch as u8);
        } else if code <= 0xffff {
            write!(output, "\\u{code:04x}").unwrap();
        } else {
            write!(output, "\\U{code:08x}").unwrap();
        }
    }
    output.push(b'\n');
}

fn bytes(data: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(b"c_codecs\nencode\n(");
    unicode(data.iter().map(|byte| char::from(*byte)), output);
    unicode("latin1".chars(), output);
    output.extend_from_slice(b"tR");
}

fn write(value: &Value, output: &mut Vec<u8>, depth: usize) -> Result<(), JsError> {
    if depth > 64 {
        return Err(invalid());
    }
    if let Some(number) = number_text(value) {
        writeln!(output, "L{number}L").unwrap();
    } else {
        match value.kind() {
            Kind::Null => output.push(b'N'),
            Kind::Bool(value) => output.extend_from_slice(if *value { b"I01\n" } else { b"I00\n" }),
            Kind::F64(value) => {
                writeln!(output, "F{value}").unwrap();
            }
            Kind::Str(value) => unicode(value.chars(), output),
            Kind::Bytes(data) => {
                let bytearray = python_kind(value) == Some(PythonKind::ByteArray);
                if bytearray {
                    output.extend_from_slice(b"c__builtin__\nbytearray\n(");
                }
                bytes(data.data(), output);
                if bytearray {
                    output.extend_from_slice(b"tR");
                }
            }
            Kind::Seq(values) => {
                let kind = python_kind(value);
                let set = matches!(kind, Some(PythonKind::Set | PythonKind::FrozenSet));
                if set {
                    output.extend_from_slice(if kind == Some(PythonKind::Set) {
                        b"c__builtin__\nset\n("
                    } else {
                        b"c__builtin__\nfrozenset\n("
                    });
                }
                let tuple = kind == Some(PythonKind::Tuple);
                output.extend_from_slice(if tuple { b"(" } else { b"(l" });
                for value in values.iter() {
                    write(value, output, depth + 1)?;
                    if !tuple {
                        output.push(b'a');
                    }
                }
                if tuple {
                    output.push(b't');
                }
                if set {
                    output.extend_from_slice(b"tR");
                }
            }
            Kind::Map(values) => {
                output.extend_from_slice(b"(d");
                for (key, value) in values.iter() {
                    write(key, output, depth + 1)?;
                    write(value, output, depth + 1)?;
                    output.push(b's');
                }
            }
            _ => return Err(unsupported()),
        }
    }
    if output.len() > MAX_OUTPUT {
        return Err(too_large());
    }
    Ok(())
}
