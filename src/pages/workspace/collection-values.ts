import type {
  CollectionRowTarget,
  RedisHashScan,
  RedisSession,
  RedisSetScan,
} from "ferrix/native";
import { decode, displayBytes, encode, keyId } from "./workspace-values";

export type CollectionKind = "hash" | "list" | "set" | "zset";
export type CollectionRow = {
  id: string;
  value: Uint8Array;
  field?: Uint8Array;
  index?: string;
  score?: number;
  draft?: string;
  identityDraft?: string;
  isNew?: boolean;
};
export type CollectionData = {
  kind: CollectionKind;
  rows: CollectionRow[];
  complete: boolean;
  loading: boolean;
  nextOffset: number;
};
export type CollectionCursor =
  | { kind: "hash"; scan: RedisHashScan }
  | { kind: "set"; scan: RedisSetScan };
type CollectionSession = Pick<
  RedisSession,
  | "readListRange"
  | "readZSetRange"
  | "setHashFields"
  | "replaceHashField"
  | "setListItem"
  | "addZSetMembers"
  | "replaceZSetMember"
  | "replaceSetMember"
  | "insertCollectionRow"
>;
export const isCollection = (type: string): type is CollectionKind =>
  ["hash", "list", "set", "zset"].includes(type);
export const rowValue = (kind: CollectionKind, row: CollectionRow) =>
  row.draft ?? (kind === "zset" ? String(row.score) : displayBytes(row.value));
export const rowEditable = (kind: CollectionKind, row: CollectionRow) =>
  kind === "zset" || decode(row.value) !== undefined;
export const rowIdentity = (row: CollectionRow) =>
  row.identityDraft ??
  (row.field
    ? displayBytes(row.field)
    : (row.index ?? displayBytes(row.value)));
export const rowDirty = (row: CollectionRow) =>
  !!row.isNew || row.draft !== undefined || row.identityDraft !== undefined;
export const rowIdentityBytes = (kind: CollectionKind, row: CollectionRow) =>
  row.identityDraft !== undefined
    ? encode(row.identityDraft)
    : kind === "hash"
      ? row.field!
      : row.value;
export function collectionRowTarget(
  kind: CollectionKind,
  row: CollectionRow,
  deleting = false,
): CollectionRowTarget {
  return {
    keyType: kind,
    field: kind === "hash" ? row.field : undefined,
    index: kind === "list" ? row.index : undefined,
    member: kind === "set" || kind === "zset" ? row.value : undefined,
    expectedValue: deleting && kind === "list" ? row.value : undefined,
  };
}
export function orderCollectionRows(
  kind: CollectionKind,
  rows: CollectionRow[],
) {
  if (kind !== "list" && kind !== "zset") return rows;
  return [...rows].sort((a, b) => {
    if (a.isNew || b.isNew) return Number(!!a.isNew) - Number(!!b.isNew);
    return kind === "list"
      ? BigInt(a.index!) < BigInt(b.index!)
        ? -1
        : BigInt(a.index!) > BigInt(b.index!)
          ? 1
          : 0
      : a.score! - b.score! ||
          (keyId(a.value) < keyId(b.value)
            ? -1
            : keyId(a.value) > keyId(b.value)
              ? 1
              : 0);
  });
}
export function collectionText(
  kind: CollectionKind,
  rows: CollectionRow[],
): string {
  return JSON.stringify(
    rows.map((row) =>
      kind === "hash"
        ? { field: rowIdentity(row), value: rowValue(kind, row) }
        : kind === "list"
          ? { index: row.index, value: rowValue(kind, row) }
          : kind === "zset"
            ? {
                member: rowIdentity(row),
                score:
                  row.draft === undefined
                    ? row.score
                    : row.draft.trim() && Number.isFinite(Number(row.draft))
                      ? Number(row.draft)
                      : row.draft,
              }
            : rowValue(kind, row),
    ),
    null,
    2,
  );
}
export async function readCollectionPage(
  session: CollectionSession,
  key: Uint8Array,
  kind: CollectionKind,
  offset: number,
  cursor?: CollectionCursor,
) {
  if (kind === "hash" && cursor?.kind === "hash") {
    const page = await cursor.scan.nextPage();
    return {
      ...page,
      rows: page.fields.map((item) => ({
        id: keyId(item.field),
        field: item.field,
        value: item.value,
      })) as CollectionRow[],
    };
  }
  if (kind === "set" && cursor?.kind === "set") {
    const page = await cursor.scan.nextPage();
    return {
      ...page,
      rows: page.members.map((value) => ({
        id: keyId(value),
        value,
      })) as CollectionRow[],
    };
  }
  if (kind === "list") {
    const page = await session.readListRange(key, {
      offset: String(offset),
      length: "200",
    });
    return {
      ...page,
      complete: BigInt(offset + page.items.length) >= BigInt(page.length),
      rows: page.items.map((item) => ({
        id: item.index,
        index: item.index,
        value: item.value,
      })) as CollectionRow[],
    };
  }
  if (kind === "zset") {
    const page = await session.readZSetRange(key, {
      offset: String(offset),
      length: "200",
    });
    return {
      ...page,
      complete: BigInt(offset + page.items.length) >= BigInt(page.length),
      rows: page.items.map((item) => ({
        id: keyId(item.member),
        value: item.member,
        score: item.score,
      })) as CollectionRow[],
    };
  }
  throw { code: "CURSOR_INVALIDATED" };
}
export async function writeCollectionRow(
  session: CollectionSession,
  key: Uint8Array,
  kind: CollectionKind,
  row: CollectionRow,
) {
  const draft = rowValue(kind, row);
  if (row.isNew) {
    const result = await session.insertCollectionRow(key, {
      keyType: kind,
      value: kind === "zset" ? row.value : encode(draft),
      field: kind === "hash" ? row.field : undefined,
      score: kind === "zset" ? Number(draft) : undefined,
    });
    const value = kind === "zset" ? row.value : encode(draft),
      index = result.index ?? row.index;
    return {
      ...row,
      value,
      index,
      id:
        kind === "list"
          ? index!
          : kind === "hash"
            ? keyId(row.field!)
            : keyId(value),
      score: kind === "zset" ? Number(draft) : row.score,
      draft: undefined,
      isNew: false,
    };
  }
  const identity = rowIdentityBytes(kind, row);
  if (kind === "hash" && row.identityDraft !== undefined)
    await session.replaceHashField(key, row.field!, {
      field: identity,
      value: encode(draft),
    });
  else if (kind === "hash")
    await session.setHashFields(key, [
      { field: row.field!, value: encode(draft) },
    ]);
  else if (kind === "list")
    await session.setListItem(key, row.index!, encode(draft));
  else if (kind === "zset" && row.identityDraft !== undefined)
    await session.replaceZSetMember(key, row.value, {
      member: identity,
      score: Number(draft),
    });
  else if (kind === "zset")
    await session.addZSetMembers(key, [
      { member: row.value, score: Number(draft) },
    ]);
  else await session.replaceSetMember(key, row.value, encode(draft));
  const value = kind === "zset" ? identity : encode(draft),
    field = kind === "hash" ? identity : row.field;
  return {
    ...row,
    id:
      kind === "hash"
        ? keyId(field!)
        : kind === "set" || kind === "zset"
          ? keyId(value)
          : row.id,
    field,
    value,
    score: kind === "zset" ? Number(draft) : row.score,
    draft: undefined,
    identityDraft: undefined,
  };
}
