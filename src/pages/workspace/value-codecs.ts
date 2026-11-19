import { ValueCodec } from "ferrix/native";
import {
  decode,
  displayBytes,
  formatJson,
  type ValueFormat,
} from "./workspace-values";
import { workspaceT as w } from "./workspace-text";

export const valueDecodings = [
  "none",
  "msgpack",
  "pickle",
  "base64",
  "base64url",
  "hex",
  "url",
] as const;
export const valueDecompressions = [
  "none",
  "gzip",
  "zstd",
  "lz4",
  "lz4-size-prefixed",
  "zlib",
  "deflate",
  "snappy",
] as const;
export type ValueDecoding = (typeof valueDecodings)[number];
export type ValueDecompression = (typeof valueDecompressions)[number];
export const valueDecodingNeedsJson = (decoding?: ValueDecoding) =>
  decoding === "msgpack" || decoding === "pickle";
export type ValuePreview = {
  decoding: ValueDecoding;
  decompression: ValueDecompression;
  loading: boolean;
  error: string;
  bytes: Uint8Array;
  value: string;
  saved: string;
  source: Uint8Array;
  binary: boolean;
  format: ValueFormat;
};
export const valuePreviewDirty = (preview?: ValuePreview) =>
  !!preview && preview.value !== preview.saved;
export const valuePreviewEditable = (preview: ValuePreview) =>
  !preview.loading && !preview.error && !preview.binary;

export const encodeValuePreview = (preview: ValuePreview) =>
  ValueCodec.encode(
    preview.value,
    preview.source,
    preview.decoding,
    preview.decompression,
  );

export async function decodeValuePreview(
  bytes: Uint8Array,
  decoding: ValueDecoding,
  decompression: ValueDecompression,
) {
  const result = await ValueCodec.decode(bytes, decoding, decompression);
  const text = decode(result);
  const formatted = text === undefined ? undefined : formatJson(text);
  const value = formatted ?? text ?? displayBytes(result);
  return {
    bytes: result,
    binary: text === undefined,
    value,
    saved: value,
    source: bytes,
    format: (
      text === undefined ? "hex" : formatted === undefined ? "text" : "json"
    ) as ValueFormat,
  };
}

export function valueCodecEncodeError(cause: unknown) {
  switch ((cause as { code?: string })?.code) {
    case "VALUE_CODEC_PICKLE_UNSUPPORTED":
      return w("valueCodecPickleUnsupported");
    case "VALUE_CODEC_TOO_LARGE":
      return w("valueCodecEncodeTooLarge");
    case "VALUE_CODEC_BUSY":
      return w("valueCodecBusy");
    default:
      return w("valueCodecEncodeInvalid");
  }
}

export function valueCodecError(cause: unknown) {
  switch ((cause as { code?: string })?.code) {
    case "VALUE_CODEC_PICKLE_UNSUPPORTED":
      return w("valueCodecPickleUnsupported");
    case "VALUE_CODEC_TOO_LARGE":
      return w("valueCodecTooLarge");
    case "VALUE_CODEC_BUSY":
      return w("valueCodecBusy");
    case "VALUE_CODEC_INVALID":
      return w("valueCodecInvalid");
    default:
      return w("valueCodecFailed");
  }
}
