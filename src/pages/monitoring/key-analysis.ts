import type {
  RedisKeyMetadata,
  RedisKeyScan,
  RedisSession,
} from "ferrix/native";

export type AnalysisScan = Pick<
  RedisKeyScan,
  "nextPage" | "cancel" | "dispose"
>;
export type AnalysisSession = Pick<
  RedisSession,
  "getInfo" | "getKeyInfoBatch"
> & {
  startKeyScan: (options: {}) => AnalysisScan;
};
export type AnalysisStatus =
  | "running"
  | "complete"
  | "limited"
  | "cancelled"
  | "error";
export type AnalysisKey = {
  database: number;
  id: string;
  key: Uint8Array;
  type: string;
  memoryBytes: string;
  expiration: string | null;
  ttlMs: string | null;
};
export type AnalysisType = {
  type: string;
  keys: number;
  measuredKeys: number;
  memoryBytes: string;
};
export type AnalysisSnapshot = {
  status: AnalysisStatus;
  reason?: "keys" | "capacity" | "time";
  database: number;
  generation: string;
  scope: "database" | "cluster" | "databases";
  limit: number;
  visited: number;
  duplicates: number;
  missing: number;
  measured: number;
  typeUnavailable: number;
  memoryUnavailable: number;
  ttlUnavailable: number;
  memoryBytes: string;
  expiring: number;
  persistent: number;
  types: AnalysisType[];
  sizes: number[];
  top: AnalysisKey[];
  pages: number;
  elapsedMs: number;
};
const hex = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);
export const analysisKeyId = (key: Uint8Array) =>
  Array.from(key, (byte) => hex[byte]).join("");
export function analysisKeyText(key: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(key)
      .replace(/[\\\x00-\x1f\x7f]/g, (value) =>
        value === "\\"
          ? "\\\\"
          : "\\x" + value.charCodeAt(0).toString(16).padStart(2, "0"),
      );
  } catch {
    return Array.from(key, (byte) =>
      byte >= 32 && byte < 127 && byte !== 92
        ? String.fromCharCode(byte)
        : "\\x" + byte.toString(16).padStart(2, "0"),
    ).join("");
  }
}
export const analysisKeyPreview = (key: Uint8Array) =>
  analysisKeyText(key.subarray(0, 256)) + (key.byteLength > 256 ? "…" : "");

export function analysisBytes(value?: string | null) {
  if (value == null) return "-";
  const amount = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let unit = 0,
    divisor = 1n;
  while (amount >= divisor * 1024n && unit < units.length - 1) {
    divisor *= 1024n;
    ++unit;
  }
  if (!unit) return amount + " B";
  return (
    String(amount / divisor) +
    "." +
    String(((amount % divisor) * 100n) / divisor).padStart(2, "0") +
    " " +
    units[unit]
  );
}

/** A finite, cancellable observation. Redis I/O stays on the existing native Session lanes. */
export function createKeyAnalysisJob(
  session: AnalysisSession,
  limit: number,
  onProgress: (snapshot: AnalysisSnapshot) => void = () => {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000)
    throw { code: "INVALID_ARGUMENT" };
  const context = session.getInfo();
  if (context.closed) throw { code: "SESSION_CLOSED" };
  const started = Date.now(),
    seen = new Set<string>();
  const groups = new Map<
    string,
    { keys: number; measuredKeys: number; memory: bigint }
  >();
  const sizes = [0, 0, 0, 0, 0];
  let scan: AnalysisScan | undefined,
    cancelled = false,
    ran = false,
    finished: number | undefined;
  let identityBytes = 0,
    visited = 0,
    duplicates = 0,
    missing = 0,
    measured = 0;
  let typeUnavailable = 0,
    memoryUnavailable = 0,
    ttlUnavailable = 0,
    expiring = 0,
    persistent = 0,
    pages = 0;
  let totalMemory = 0n,
    top: AnalysisKey[] = [],
    status: AnalysisStatus = "running";
  let reason: AnalysisSnapshot["reason"];
  function snapshot(): AnalysisSnapshot {
    return {
      status,
      reason,
      database: context.database,
      generation: context.generation,
      scope: context.mode.toLowerCase() === "cluster" ? "cluster" : "database",
      limit,
      visited,
      duplicates,
      missing,
      measured,
      typeUnavailable,
      memoryUnavailable,
      ttlUnavailable,
      memoryBytes: totalMemory.toString(),
      expiring,
      persistent,
      types: Array.from(groups, ([type, group]) => ({
        type,
        keys: group.keys,
        measuredKeys: group.measuredKeys,
        memoryBytes: group.memory.toString(),
      })).sort((a, b) => b.keys - a.keys || a.type.localeCompare(b.type)),
      sizes: [...sizes],
      top: [...top],
      pages,
      elapsedMs: Math.max(0, (finished ?? Date.now()) - started),
    };
  }
  function contextMatches(value: { database: number; generation: string }) {
    const info = session.getInfo();
    if (info.closed) throw { code: "SESSION_CLOSED" };
    if (
      value.database !== context.database ||
      value.generation !== context.generation ||
      info.database !== context.database ||
      info.generation !== context.generation
    )
      throw { code: "CONTEXT_CHANGED" };
  }
  function release(cancel: boolean) {
    const owned = scan;
    scan = undefined;
    if (owned) {
      if (cancel) owned.cancel();
      owned.dispose();
    }
  }
  function finish(next: AnalysisStatus, why?: AnalysisSnapshot["reason"]) {
    status = next;
    reason = why;
    finished = Date.now();
    onProgress(snapshot());
    return snapshot();
  }
  function collect(item: RedisKeyMetadata) {
    ++visited;
    if (item.exists === false || item.typeStatus === "missing") {
      ++missing;
      return;
    }
    const keyType =
      item.typeStatus === "available" && item.type && item.type !== "none"
        ? item.type
        : "unknown";
    let type = keyType;
    if (type === "unknown") ++typeUnavailable;
    if (!groups.has(type) && groups.size >= 63) type = "other";
    const group = groups.get(type) ?? { keys: 0, measuredKeys: 0, memory: 0n };
    ++group.keys;
    groups.set(type, group);
    if (item.ttlStatus === "available" && item.expiration === "expiring")
      ++expiring;
    else if (item.ttlStatus === "available" && item.expiration === "persistent")
      ++persistent;
    else ++ttlUnavailable;
    if (item.memoryStatus !== "available" || item.memoryBytes == null) {
      ++memoryUnavailable;
      return;
    }
    const memory = BigInt(item.memoryBytes);
    totalMemory += memory;
    ++measured;
    ++group.measuredKeys;
    group.memory += memory;
    ++sizes[
      memory < 1024n
        ? 0
        : memory < 10240n
          ? 1
          : memory < 102400n
            ? 2
            : memory < 1048576n
              ? 3
              : 4
    ];
    top.push({
      database: context.database,
      id: analysisKeyId(item.key),
      key: item.key,
      type: keyType,
      memoryBytes: memory.toString(),
      expiration:
        item.ttlStatus === "available" ? (item.expiration ?? null) : null,
      ttlMs: item.ttlMs ?? null,
    });
    top.sort((a, b) =>
      BigInt(a.memoryBytes) > BigInt(b.memoryBytes)
        ? -1
        : BigInt(a.memoryBytes) < BigInt(b.memoryBytes)
          ? 1
          : a.id.localeCompare(b.id),
    );
    top = top.slice(0, 20);
  }
  async function run() {
    if (ran) throw { code: "INVALID_ARGUMENT" };
    ran = true;
    try {
      if (cancelled) return finish("cancelled");
      scan = session.startKeyScan({});
      onProgress(snapshot());
      for (;;) {
        if (cancelled) return finish("cancelled");
        if (Date.now() - started >= 120_000) return finish("limited", "time");
        const page = await scan!.nextPage();
        if (cancelled) return finish("cancelled");
        contextMatches(page);
        ++pages;
        const keys: Uint8Array[] = [];
        let limited: AnalysisSnapshot["reason"];
        for (const key of page.keys) {
          const id = analysisKeyId(key);
          if (seen.has(id)) {
            ++duplicates;
            continue;
          }
          if (seen.size >= limit) {
            limited = "keys";
            break;
          }
          if (identityBytes + key.byteLength > 4 * 1024 * 1024) {
            limited = "capacity";
            break;
          }
          seen.add(id);
          identityBytes += key.byteLength;
          keys.push(key);
        }
        for (let offset = 0; offset < keys.length; offset += 50) {
          if (cancelled) return finish("cancelled");
          if (Date.now() - started >= 120_000) return finish("limited", "time");
          const batch = await session.getKeyInfoBatch(
            keys.slice(offset, offset + 50),
            { keyType: true, ttl: true, memorySamples: 5 },
          );
          if (cancelled) return finish("cancelled");
          contextMatches(batch);
          for (const item of batch.items) collect(item);
          onProgress(snapshot());
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        if (cancelled) return finish("cancelled");
        if (limited) return finish("limited", limited);
        if (page.complete) return finish("complete");
        if (seen.size >= limit) return finish("limited", "keys");
        onProgress(snapshot());
        if (!keys.length)
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    } catch (cause) {
      if (cancelled) return finish("cancelled");
      finish("error");
      throw cause;
    } finally {
      release(status !== "complete");
      seen.clear();
    }
  }
  return {
    run,
    snapshot,
    cancel: () => {
      cancelled = true;
      status = "cancelled";
      finished = Date.now();
      release(true);
    },
  };
}
