import type { RedisStreamEntry } from "ferrix/native";
import { displayBytes } from "./workspace-values";

export type StreamData = {
  entries: RedisStreamEntry[];
  complete: boolean;
  loading: boolean;
  nextAfter?: string | null;
};

export function validStreamId(id: string): boolean {
  if (!/^(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})$/.test(id)) return false;
  return id.split("-").every((part) => BigInt(part) <= 18446744073709551615n);
}

export function compareStreamIds(a: string, b: string): number {
  const left = a.split("-").map(BigInt),
    right = b.split("-").map(BigInt);
  return left[0] < right[0]
    ? -1
    : left[0] > right[0]
      ? 1
      : left[1] < right[1]
        ? -1
        : left[1] > right[1]
          ? 1
          : 0;
}

export const orderStreamEntries = (entries: RedisStreamEntry[]) =>
  [...entries].sort((a, b) => compareStreamIds(a.id, b.id));

export const streamText = (entries: RedisStreamEntry[]) =>
  JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      fields: entry.fields.map((pair) => ({
        field: displayBytes(pair.field),
        value: displayBytes(pair.value),
      })),
    })),
    null,
    2,
  );
