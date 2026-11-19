use super::*;
use std::io::Write;

pub(super) fn compress(bytes: &[u8], format: &str) -> Vec<u8> {
    match format {
        "gzip" => {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Default::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }
        "zlib" => {
            let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), Default::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }
        "deflate" => {
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), Default::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }
        "zstd" => zstd::stream::encode_all(bytes, 1).unwrap(),
        "lz4" => {
            let mut encoder = lz4_flex::frame::FrameEncoder::new(Vec::new());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }
        "lz4-size-prefixed" => lz4_flex::compress_prepend_size(bytes),
        "snappy" => snap::raw::Encoder::new().compress_vec(bytes).unwrap(),
        _ => panic!("unknown test compression"),
    }
}
const COMPRESSIONS: &[&str] = &[
    "gzip",
    "zlib",
    "deflate",
    "zstd",
    "lz4",
    "lz4-size-prefixed",
    "snappy",
];

#[test]
fn value_codec_decompresses_all_formats_and_compressed_messagepack() {
    // {"name":"Ferrix","id":9007199254740993,"ok":true}
    let packed = b"\x83\xa4name\xa6Ferrix\xa2id\xcf\x00\x20\x00\x00\x00\x00\x00\x01\xa2ok\xc3";
    let expected = br#"{"name":"Ferrix","id":9007199254740993,"ok":true}"#;
    assert_eq!(
        transform(packed.to_vec(), "msgpack", "none").unwrap(),
        expected
    );
    for format in COMPRESSIONS {
        let bytes = compress(packed, format);
        assert_eq!(transform(bytes.clone(), "none", format).unwrap(), packed);
        assert_eq!(transform(bytes, "msgpack", format).unwrap(), expected);
    }
}

#[test]
fn value_codec_decodes_binary_text_before_decompression() {
    let gzip = compress("值：Ferrix".as_bytes(), "gzip");
    let encoded = general_purpose::STANDARD.encode(gzip);
    assert_eq!(
        transform(format!(" \n{encoded}\r\n").into_bytes(), "base64", "gzip").unwrap(),
        "值：Ferrix".as_bytes()
    );
    assert_eq!(
        transform(b"-_8".to_vec(), "base64url", "none").unwrap(),
        [251, 255]
    );
    assert_eq!(
        transform(b"0x ff 00 fe".to_vec(), "hex", "none").unwrap(),
        [255, 0, 254]
    );
    assert_eq!(
        transform(b"%E5%80%BC%00+".to_vec(), "url", "none").unwrap(),
        "值\0+".as_bytes()
    );
    for (value, encoding) in [
        ("?", "base64"),
        ("a", "base64"),
        ("aa?", "base64url"),
        ("abc", "hex"),
        ("gg", "hex"),
        ("%0", "url"),
        ("%zz", "url"),
    ] {
        assert!(transform(value.as_bytes().to_vec(), encoding, "none").is_err());
    }
}

#[test]
fn value_codec_rejects_truncated_or_mismatched_data() {
    for format in COMPRESSIONS {
        assert!(
            transform(b"not compressed".to_vec(), "none", format).is_err(),
            "{format}"
        );
        let bytes = compress(b"a complete compressed value", format);
        for length in 0..bytes.len() {
            assert!(
                transform(bytes[..length].to_vec(), "none", format).is_err(),
                "{format}: truncated at {length}/{}",
                bytes.len()
            );
        }
    }
    for bytes in [
        vec![0xc1],
        vec![0x91],
        vec![0xc0, 0xc0],
        vec![0xdd, 255, 255, 255, 255],
    ] {
        assert!(
            transform(bytes.clone(), "msgpack", "none").is_err(),
            "invalid MessagePack: {bytes:?}"
        );
    }
    assert!(transform(vec![0x91; 65], "msgpack", "none").is_err());
    assert!(transform(vec![], "unknown", "none").is_err());
    assert!(transform(vec![], "none", "unknown").is_err());
}

#[test]
fn value_codec_enforces_input_and_expansion_limits() {
    assert!(transform(vec![0; MAX_INPUT + 1], "none", "none").is_err());
    let bytes = vec![b'x'; MAX_OUTPUT + 1];
    for format in COMPRESSIONS {
        let compressed = compress(&bytes, format);
        assert!(compressed.len() <= MAX_INPUT);
        assert!(transform(compressed, "none", format).is_err(), "{format}");
    }
    // MessagePack's control characters expand while producing valid JSON.
    let mut packed = vec![0xdb, 0, 0x04, 0, 0];
    packed.resize(5 + 262144, 0);
    assert!(transform(compress(&packed, "gzip"), "msgpack", "gzip").is_err());
}

#[test]
fn value_codec_retains_messagepack_binary_extensions_and_unusual_maps() {
    let bytes = [
        0x94, 0xc4, 2, 0xff, 0x00, 0xd4, 7, 0xfe, 0x81, 1, 0xa1, b'v', 0x82, 0xa1, b'x', 1, 0xa1,
        b'x', 2,
    ];
    assert_eq!(
        transform(bytes.to_vec(), "msgpack", "none").unwrap(),
        br#"[{"$binary":"ff00"},{"$ext":{"type":7,"data":"fe"}},{"$map":[[1,"v"]]},{"x":1,"x":2}]"#
    );
}

#[test]
fn value_codec_reads_concatenated_gzip_and_framed_snappy() {
    let mut gzip = compress(b"first", "gzip");
    gzip.extend(compress(b"second", "gzip"));
    assert_eq!(transform(gzip, "none", "gzip").unwrap(), b"firstsecond");
    let mut snappy = snap::write::FrameEncoder::new(Vec::new());
    snappy.write_all(b"framed snappy").unwrap();
    let snappy = snappy.into_inner().unwrap();
    assert_eq!(
        transform(snappy, "none", "snappy").unwrap(),
        b"framed snappy"
    );
}

#[test]
fn value_codec_reencodes_edits_in_every_compression_format() {
    let packed = b"\x83\xa4name\xa6Ferrix\xa2id\xcf\x00\x20\x00\x00\x00\x00\x00\x01\xa2ok\xc3";
    let edited = r#"{"name":"updated","id":18446744073709551615,"ok":false}"#;
    for compression in COMPRESSIONS.iter().copied().chain(["none"]) {
        let original = if compression == "none" {
            packed.to_vec()
        } else {
            compress(packed, compression)
        };
        let encoded = encoding::encode(edited, &original, "msgpack", compression).unwrap();
        assert_eq!(
            transform(encoded, "msgpack", compression).unwrap(),
            edited.as_bytes()
        );
    }
    for decoding in ["base64", "base64url", "hex", "url", "none"] {
        for compression in ["gzip", "zstd", "lz4", "none"] {
            let original = if compression == "none" {
                b"before".to_vec()
            } else {
                compress(b"before", compression)
            };
            let wrapped = match decoding {
                "base64" => general_purpose::STANDARD.encode(&original).into_bytes(),
                "base64url" => general_purpose::URL_SAFE_NO_PAD
                    .encode(&original)
                    .into_bytes(),
                "hex" => original
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
                    .into_bytes(),
                "url" => {
                    percent_encoding::percent_encode(&original, percent_encoding::NON_ALPHANUMERIC)
                        .to_string()
                        .into_bytes()
                }
                _ => original,
            };
            let encoded =
                encoding::encode("修改后的内容", &wrapped, decoding, compression).unwrap();
            assert_eq!(
                transform(encoded, decoding, compression).unwrap(),
                "修改后的内容".as_bytes()
            );
        }
    }
}

#[test]
fn value_codec_messagepack_edits_preserve_opaque_types_duplicate_keys_and_numeric_precision() {
    use rmpv::Value;
    let invalid_string = rmpv::decode::read_value(&mut b"\xa2\xff\xc1".as_slice()).unwrap();
    let mut entries = vec![
        (Value::from("edit"), Value::from("before")),
        (Value::from("max"), Value::from(u64::MAX)),
        (Value::from("min"), Value::from(i64::MIN)),
        (Value::from("single"), Value::F32(1.25)),
        (Value::from("double"), Value::F64(1.0)),
        (
            Value::from("nan"),
            Value::F64(f64::from_bits(0x7ff8000000000009)),
        ),
        (Value::from("binary"), Value::Binary(vec![0xff, 0xc1, 0])),
        (Value::from("ext"), Value::Ext(-1, vec![1, 2, 3, 4])),
        (Value::from("invalid"), invalid_string),
        (
            Value::from("literal"),
            Value::Map(vec![(Value::from("$binary"), Value::from("aa"))]),
        ),
        (Value::from("repeat"), Value::from(1)),
        (Value::from("repeat"), Value::F32(2.0)),
        (
            Value::from("pairs"),
            Value::Map(vec![(Value::from(7), Value::Binary(vec![9]))]),
        ),
    ];
    let mut original = Vec::new();
    rmpv::encode::write_value(&mut original, &Value::Map(entries.clone())).unwrap();
    let json = String::from_utf8(transform(original.clone(), "msgpack", "none").unwrap()).unwrap();
    let encoded = encoding::encode(
        &json.replace("before", "after"),
        &original,
        "msgpack",
        "none",
    )
    .unwrap();
    entries[0].1 = Value::from("after");
    let mut expected = Vec::new();
    rmpv::encode::write_value(&mut expected, &Value::Map(entries)).unwrap();
    assert_eq!(encoded, expected);
}

#[test]
fn value_codec_encoder_rejects_invalid_edits_without_producing_stored_bytes() {
    for text in [
        "{",
        "18446744073709551616",
        "-9223372036854775809",
        r#"{"$binary":"0g"}"#,
        r#"{"$binary":"a"}"#,
        r#"{"$ext":{"type":128,"data":"ff"}}"#,
        r#"{"$map":[[1,2,3]]}"#,
    ] {
        assert!(
            encoding::encode(text, &[0xc0], "msgpack", "none").is_err(),
            "{text}"
        );
    }
    assert!(encoding::encode(&"x".repeat(MAX_INPUT + 1), b"before", "none", "none").is_err());
    assert!(encoding::encode(&"x".repeat(MAX_OUTPUT + 1), b"before", "none", "none").is_err());
    let mut framed = snap::write::FrameEncoder::new(Vec::new());
    framed.write_all(b"before").unwrap();
    let encoded =
        encoding::encode("after", &framed.into_inner().unwrap(), "none", "snappy").unwrap();
    assert!(encoded.starts_with(b"\xff\x06\x00\x00sNaPpY"));
    assert_eq!(transform(encoded, "none", "snappy").unwrap(), b"after");
    assert_eq!(
        encoding::encode("a", b"Yg==", "base64", "none").unwrap(),
        b"YQ=="
    );
    assert_eq!(
        encoding::encode("a", b"Yg", "base64url", "none").unwrap(),
        b"YQ"
    );
}
