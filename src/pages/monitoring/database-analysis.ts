import type { RedisSession } from "ferrix/native";
import {
  createKeyAnalysisJob,
  type AnalysisSession,
  type AnalysisSnapshot,
} from "./key-analysis";

export type AnalysisDatabaseSession = AnalysisSession &
  Pick<RedisSession, "selectDatabase" | "close" | "dispose">;
export type DatabaseAnalysisSession = AnalysisSession &
  Pick<RedisSession, "listDatabases"> & {
    openDatabaseSession: (database: number) => Promise<AnalysisDatabaseSession>;
  };
export type DatabaseObservation = {
  database: number;
  keyCount: string | null;
  status:
    | "pending"
    | "running"
    | "complete"
    | "limited"
    | "cancelled"
    | "error"
    | "empty";
  visited: number;
  measured: number;
  missing: number;
  memoryUnavailable: number;
  memoryBytes: string;
  memoryAvailable: boolean;
  errorCode?: string;
};
export type DatabaseAnalysisSnapshot = Omit<AnalysisSnapshot, "reason"> & {
  reason?: AnalysisSnapshot["reason"] | "databases" | "catalog";
  databases: DatabaseObservation[];
  catalogComplete: boolean;
  currentDatabase: number | null;
};

function merge(
  left: AnalysisSnapshot,
  right: AnalysisSnapshot,
): AnalysisSnapshot {
  const types = new Map(left.types.map((type) => [type.type, { ...type }]));
  for (const item of right.types) {
    const name =
      !types.has(item.type) && types.size >= 63 ? "other" : item.type;
    const value = types.get(name) ?? {
      type: name,
      keys: 0,
      measuredKeys: 0,
      memoryBytes: "0",
    };
    types.set(name, {
      type: name,
      keys: value.keys + item.keys,
      measuredKeys: value.measuredKeys + item.measuredKeys,
      memoryBytes: (
        BigInt(value.memoryBytes) + BigInt(item.memoryBytes)
      ).toString(),
    });
  }
  const top = [
    ...left.top,
    ...right.top.map((key) => ({ ...key, id: key.database + ":" + key.id })),
  ]
    .sort((a, b) =>
      BigInt(a.memoryBytes) > BigInt(b.memoryBytes)
        ? -1
        : BigInt(a.memoryBytes) < BigInt(b.memoryBytes)
          ? 1
          : a.id.localeCompare(b.id),
    )
    .slice(0, 20);
  return {
    ...left,
    visited: left.visited + right.visited,
    duplicates: left.duplicates + right.duplicates,
    missing: left.missing + right.missing,
    measured: left.measured + right.measured,
    typeUnavailable: left.typeUnavailable + right.typeUnavailable,
    memoryUnavailable: left.memoryUnavailable + right.memoryUnavailable,
    ttlUnavailable: left.ttlUnavailable + right.ttlUnavailable,
    expiring: left.expiring + right.expiring,
    persistent: left.persistent + right.persistent,
    pages: left.pages + right.pages,
    memoryBytes: (
      BigInt(left.memoryBytes) + BigInt(right.memoryBytes)
    ).toString(),
    types: [...types.values()].sort(
      (a, b) => b.keys - a.keys || a.type.localeCompare(b.type),
    ),
    sizes: left.sizes.map((value, index) => value + right.sizes[index]),
    top,
  };
}

/** Sequential database analysis owns one temporary Session and never switches the parent. */
export function createDatabaseAnalysisJob(
  parent: DatabaseAnalysisSession,
  limit: number,
  onProgress: (snapshot: DatabaseAnalysisSnapshot) => void = () => {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000)
    throw { code: "INVALID_ARGUMENT" };
  const context = parent.getInfo(),
    started = Date.now();
  if (context.closed) throw { code: "SESSION_CLOSED" };
  let aggregate: AnalysisSnapshot = {
    status: "running",
    scope: context.mode.toLowerCase() === "cluster" ? "cluster" : "databases",
    database: context.database,
    generation: context.generation,
    limit,
    visited: 0,
    duplicates: 0,
    missing: 0,
    measured: 0,
    typeUnavailable: 0,
    memoryUnavailable: 0,
    ttlUnavailable: 0,
    memoryBytes: "0",
    expiring: 0,
    persistent: 0,
    types: [],
    sizes: [0, 0, 0, 0, 0],
    top: [],
    pages: 0,
    elapsedMs: 0,
  };
  let child: AnalysisDatabaseSession | undefined,
    job: ReturnType<typeof createKeyAnalysisJob> | undefined;
  let active: AnalysisSnapshot | undefined,
    rows: DatabaseObservation[] = [],
    index = -1;
  let cancelled = false,
    ran = false,
    catalogComplete = false,
    finished: number | undefined;
  let status: AnalysisSnapshot["status"] = "running",
    reason: DatabaseAnalysisSnapshot["reason"];
  function contextMatches() {
    const info = parent.getInfo();
    if (info.closed) throw { code: "SESSION_CLOSED" };
    if (
      info.database !== context.database ||
      info.generation !== context.generation
    )
      throw { code: "CONTEXT_CHANGED" };
  }
  function snapshot(): DatabaseAnalysisSnapshot {
    return {
      ...(active ? merge(aggregate, active) : aggregate),
      status,
      reason,
      databases: rows,
      catalogComplete,
      currentDatabase: index >= 0 ? (rows[index]?.database ?? null) : null,
      elapsedMs: Math.max(0, (finished ?? Date.now()) - started),
    };
  }
  function update(value: Partial<DatabaseObservation>) {
    if (index < 0) return;
    rows = rows.slice();
    rows[index] = { ...rows[index], ...value };
  }
  function release() {
    const owned = child;
    child = undefined;
    if (owned) {
      owned.close();
      owned.dispose();
    }
  }
  function finish(
    next: AnalysisSnapshot["status"],
    why?: DatabaseAnalysisSnapshot["reason"],
  ) {
    status = next;
    reason = why;
    finished = Date.now();
    onProgress(snapshot());
    return snapshot();
  }
  async function run() {
    if (ran) throw { code: "INVALID_ARGUMENT" };
    ran = true;
    try {
      if (cancelled) return finish("cancelled");
      const catalog = await parent.listDatabases();
      if (cancelled) return finish("cancelled");
      contextMatches();
      if (
        catalog.database !== context.database ||
        catalog.generation !== context.generation
      )
        throw { code: "CONTEXT_CHANGED" };
      catalogComplete = catalog.complete;
      const databases = [
        ...new Map(catalog.items.map((item) => [item.database, item])).values(),
      ].sort((a, b) => a.database - b.database);
      if (!databases.length) {
        databases.push({ database: context.database, keyCount: null });
        catalogComplete = false;
      }
      rows = databases.map((item) => ({
        database: item.database,
        keyCount: item.keyCount ?? null,
        status: item.keyCount === "0" ? "empty" : "pending",
        visited: 0,
        measured: 0,
        missing: 0,
        memoryUnavailable: 0,
        memoryBytes: "0",
        memoryAvailable: item.keyCount === "0",
      }));
      onProgress(snapshot());
      let failure: unknown, partial: DatabaseAnalysisSnapshot["reason"];
      for (let current = 0; current < rows.length; ++current) {
        if (cancelled) return finish("cancelled");
        if (rows[current].status === "empty") continue;
        index = current;
        active = undefined;
        update({ status: "running" });
        onProgress(snapshot());
        try {
          contextMatches();
          const database = rows[index].database;
          if (!child) {
            const opened = await parent.openDatabaseSession(database);
            if (cancelled) {
              opened.close();
              opened.dispose();
              return finish("cancelled");
            }
            child = opened;
          } else if (child.getInfo().database !== database)
            await child.selectDatabase(database);
          if (cancelled) return finish("cancelled");
          contextMatches();
          if (child.getInfo().database !== database)
            throw { code: "CONTEXT_CHANGED" };
          job = createKeyAnalysisJob(child, limit, (value) => {
            if (cancelled) return;
            contextMatches();
            active = value;
            update({
              status: value.status,
              visited: value.visited,
              measured: value.measured,
              missing: value.missing,
              memoryUnavailable: value.memoryUnavailable,
              memoryBytes: value.memoryBytes,
              memoryAvailable:
                value.measured > 0 ||
                (value.status === "complete" && value.visited === 0),
            });
            onProgress(snapshot());
          });
          active = await job.run();
          job = undefined;
          if (cancelled) return finish("cancelled");
          contextMatches();
          if (active.status === "limited") partial ??= active.reason;
          aggregate = merge(aggregate, active);
          active = undefined;
        } catch (cause) {
          if (cancelled) return finish("cancelled");
          contextMatches();
          if ((cause as { code?: string })?.code === "CONTEXT_CHANGED")
            throw cause;
          if (active) {
            aggregate = merge(aggregate, active);
            active = undefined;
          }
          job?.cancel();
          job = undefined;
          update({
            status: "error",
            errorCode: (cause as { code?: string })?.code ?? "SERVER_ERROR",
          });
          failure = cause;
          release();
        }
        onProgress(snapshot());
      }
      index = -1;
      if (
        failure &&
        !rows.some(
          (row) =>
            row.status === "complete" ||
            row.status === "limited" ||
            row.status === "empty",
        )
      )
        throw failure;
      return finish(
        failure || partial || !catalogComplete ? "limited" : "complete",
        failure
          ? "databases"
          : (partial ?? (!catalogComplete ? "catalog" : undefined)),
      );
    } catch (cause) {
      if (cancelled) return finish("cancelled");
      update({
        status: "error",
        errorCode: (cause as { code?: string })?.code ?? "SERVER_ERROR",
      });
      finish("error");
      throw cause;
    } finally {
      job?.cancel();
      job = undefined;
      release();
    }
  }
  return {
    run,
    snapshot,
    cancel: () => {
      cancelled = true;
      status = "cancelled";
      finished = Date.now();
      job?.cancel();
      if (job) active = job.snapshot();
      if (index >= 0 && rows[index].status === "running")
        update({ status: "cancelled" });
      job = undefined;
      release();
    },
  };
}
