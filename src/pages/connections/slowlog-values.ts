import { t } from "../../i18n";
import type { RedisSlowlogEntry } from "ferrix/native";

export const slowlogT = (key: string, values?: Record<string, unknown>) =>
  t("slowlog." + key, values);
export function slowlogBytes(bytes?: Uint8Array | null) {
  if (!bytes?.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return Array.from(
      bytes,
      (value) => "\\x" + value.toString(16).padStart(2, "0"),
    ).join("");
  }
}
export function slowlogArgument(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return (
      '"' +
      Array.from(bytes, (value) =>
        value >= 32 && value < 127 && value !== 34 && value !== 92
          ? String.fromCharCode(value)
          : "\\x" + value.toString(16).padStart(2, "0"),
      ).join("") +
      '"'
    );
  }
  if (/^[A-Za-z0-9_:./@%+=,-]+$/.test(value)) return value;
  return (
    '"' +
    value.replace(/[\\"\x00-\x1f\x7f]/g, (character) =>
      character === '"' || character === "\\"
        ? "\\" + character
        : "\\x" + character.charCodeAt(0).toString(16).padStart(2, "0"),
    ) +
    '"'
  );
}
export const slowlogCommand = (entry: RedisSlowlogEntry) =>
  entry.arguments.map(slowlogArgument).join(" ");
export function slowlogDuration(value: string): string {
  const micros = BigInt(value);
  if (micros < 1000n) return value + " µs";
  const fraction = String(micros % 1000n)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return String(micros / 1000n) + (fraction ? "." + fraction : "") + " ms";
}
export function slowlogTime(value: string): string {
  const milliseconds = BigInt(value) * 1000n;
  if (milliseconds > 8640000000000000n) return value + " s";
  return new Date(Number(milliseconds)).toLocaleString();
}
