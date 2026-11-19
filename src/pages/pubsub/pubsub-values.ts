export const encode = (value: string) => new TextEncoder().encode(value);
export const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
export function text(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      value,
    );
  } catch {
    return undefined;
  }
}
export const display = (value: Uint8Array) => text(value) ?? `0x${hex(value)}`;
export const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
export function unhex(value: string): Uint8Array | undefined {
  const compact = value.replace(/^0x/i, "").replace(/\s/g, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(compact)) return undefined;
  return new Uint8Array(
    compact.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [],
  );
}
export function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
export function json(value: string, compact = false): string | undefined {
  if (!isJson(value)) return undefined;
  // Reflow lexical tokens to preserve large numbers, duplicate keys and escapes exactly.
  const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)!;
  if (compact) return tokens.join("");
  let result = "",
    depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      result += token;
      depth++;
      if (tokens[index + 1] !== (token === "{" ? "}" : "]"))
        result += `\n${"  ".repeat(depth)}`;
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== (token === "}" ? "{" : "["))
        result += `\n${"  ".repeat(depth)}`;
      result += token;
    } else if (token === ",") result += `,\n${"  ".repeat(depth)}`;
    else if (token === ":") result += ": ";
    else result += token;
    if (result.length > 4 * 1024 * 1024) return undefined;
  }
  return result;
}
