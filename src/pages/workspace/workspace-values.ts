import type { EditorFoldRange } from "nsh/base";

export type ValueFormat = "json" | "text" | "table" | "hex";

export const encode = (value: string) => new TextEncoder().encode(value);
export const keyId = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
export function keyFromId(id: string): Uint8Array | undefined {
  if (id.length % 2 || /[^0-9a-f]/.test(id)) return undefined;
  return Uint8Array.from(id.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}
export function keyPrefixPattern(prefix: Uint8Array): Uint8Array {
  const pattern: number[] = [];
  for (const byte of prefix) {
    if ([42, 63, 91, 93, 92].includes(byte)) pattern.push(92);
    pattern.push(byte);
  }
  pattern.push(42);
  return new Uint8Array(pattern);
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decode(value: Uint8Array): string | undefined {
  try {
    return utf8.decode(value);
  } catch {
    return undefined;
  }
}
export const displayBytes = (value: Uint8Array) =>
  decode(value) ?? `0x${keyId(value)}`;
export function byteLabel(value: number | string): string {
  const count = Number(value);
  if (!Number.isSafeInteger(count)) return `${value} B`;
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(2)} KB`;
  return `${(count / 1024 / 1024).toFixed(2)} MB`;
}
export function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
export function formatJson(value: string, compact = false): string | undefined {
  if (!isJson(value)) return undefined;
  // Preserve number literals, duplicate properties and string escapes while changing whitespace.
  const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)!;
  if (compact) return tokens.join("");
  let result = "",
    depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      result += token;
      ++depth;
      if (tokens[index + 1] !== (token === "{" ? "}" : "]"))
        result += `\n${"  ".repeat(depth)}`;
    } else if (token === "}" || token === "]") {
      --depth;
      if (tokens[index - 1] !== (token === "}" ? "{" : "["))
        result += `\n${"  ".repeat(depth)}`;
      result += token;
    } else if (token === ",") result += `,\n${"  ".repeat(depth)}`;
    else if (token === ":") result += ": ";
    else result += token;
  }
  return result;
}
export function hexView(value: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < value.length; offset += 16) {
    const row = Array.from(value.slice(offset, offset + 16));
    rows.push(
      `${offset.toString(16).padStart(8, "0")}  ${row
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(
          47,
        )}  ${row.map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("")}`,
    );
  }
  return rows.join("\n");
}
export function tableView(value: string): string {
  try {
    const parsed = JSON.parse(value);
    const entries =
      parsed !== null && typeof parsed === "object"
        ? Object.entries(parsed)
        : [["value", parsed]];
    return entries
      .map(([field, item]) => `${field.padEnd(24)}  ${JSON.stringify(item)}`)
      .join("\n");
  } catch {
    return value;
  }
}
export function jsonFolds(value: string): EditorFoldRange[] {
  const stack: number[] = [],
    ranges: EditorFoldRange[] = [];
  value.split("\n").forEach((line, index) => {
    if (/^\s*[}\]]/.test(line)) {
      const start = stack.pop();
      if (start !== undefined && index > start)
        ranges.push({ startLine: start, endLine: index });
    }
    if (/[{[]\s*$/.test(line)) stack.push(index);
  });
  return ranges.sort((a, b) => a.startLine - b.startLine);
}

export function commandArgs(input: string): string[] {
  const args: string[] = [];
  let value = "",
    quote = "",
    started = false,
    escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
    } else if (character === "\\") escaped = true;
    else if (quote) {
      if (character === quote) quote = "";
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      value += character;
      started = true;
    }
  }
  if (quote || escaped) throw new Error("Unclosed command argument");
  if (started) args.push(value);
  return args;
}
