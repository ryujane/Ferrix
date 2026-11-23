import { cleanup, computed, effect, signal, untracked } from "nsh";
import { KeyInventory } from "ferrix/native";
import type {
  CreateKeyOptions,
  KeyScanOptions,
  RedisDatabase,
  RedisKeyInfo,
  RedisKeyScan,
  RedisSession,
  StreamAppendOptions,
} from "ferrix/native";
import type { ToastController } from "../../components/toast";
import { defaultPreferences, type Preferences } from "../../data/preferences";
import type { WorkspaceSnapshot } from "../../data/workspace-history";
import { safeError } from "../../utils/errors";
import { createVisibleKeyTypes } from "./visible-key-types";
import {
  decode,
  displayBytes,
  encode,
  formatJson,
  isJson,
  keyFromId,
  keyId,
  keyPrefixPattern,
  type ValueFormat,
} from "./workspace-values";
import { workspaceT as w } from "./workspace-text";
import {
  collectionRowTarget,
  collectionText,
  isCollection,
  orderCollectionRows,
  readCollectionPage,
  rowDirty,
  rowEditable,
  rowIdentityBytes,
  rowValue,
  writeCollectionRow,
  type CollectionCursor,
  type CollectionData,
  type CollectionRow,
} from "./collection-values";
import {
  orderStreamEntries,
  streamText,
  type StreamData,
} from "./stream-values";
import {
  decodeValuePreview,
  encodeValuePreview,
  valueCodecError,
  valueCodecEncodeError,
  valuePreviewDirty,
  valuePreviewEditable,
  valueDecodingNeedsJson,
  type ValueDecoding,
  type ValueDecompression,
  type ValuePreview,
} from "./value-codecs";
import {
  jsonError,
  newJsonData,
  validJsonPath,
  type JsonData,
} from "./json-values";

export type WorkspaceSession = Pick<
  RedisSession,
  | "getInfo"
  | "ping"
  | "openConsole"
  | "readConsoleCommands"
  | "listDatabases"
  | "selectDatabase"
  | "startKeyScan"
  | "getKeyInfoBatch"
  | "getKeyInfo"
  | "readStringRange"
  | "readJson"
  | "setJson"
  | "deleteJsonPath"
  | "setString"
  | "scanHash"
  | "scanSet"
  | "readListRange"
  | "readZSetRange"
  | "readStreamRange"
  | "appendStreamEntry"
  | "deleteStreamEntry"
  | "setHashFields"
  | "replaceHashField"
  | "setListItem"
  | "addZSetMembers"
  | "replaceZSetMember"
  | "replaceSetMember"
  | "insertCollectionRow"
  | "readCollectionRow"
  | "deleteCollectionRow"
  | "renameKey"
  | "deleteKey"
  | "createKey"
  | "setExpiry"
  | "persistKey"
>;
export type KeyTab = {
  id: string;
  key: Uint8Array;
  name: string;
  info?: RedisKeyInfo;
  value: string;
  saved: string;
  bytes: Uint8Array;
  format: ValueFormat;
  loading: boolean;
  editable: boolean;
  partial: boolean;
  binary: boolean;
  error: string;
  uncertain: boolean;
  collection?: CollectionData;
  stream?: StreamData;
  preview?: ValuePreview;
  json?: JsonData;
};
export const dirty = (tab?: KeyTab) =>
  !!tab &&
  (tab.collection
    ? tab.collection.rows.some(rowDirty)
    : tab.value !== tab.saved || valuePreviewDirty(tab.preview));
const previewBytes = 65536;
const keyBrowserBatchSize = 10_000;

export function createWorkspaceState(
  session: WorkspaceSession,
  toast: Pick<ToastController, "success" | "error" | "info">,
  preferences: () => Readonly<Preferences> = () => defaultPreferences,
) {
  const keys = signal(new KeyInventory(), { equals: false }),
    tabs = signal<KeyTab[]>([]),
    activeId = signal<string>();
  const pattern = signal(""),
    scan = signal<RedisKeyScan>(),
    scanBusy = signal(false),
    scanStopped = signal(false),
    complete = signal(false),
    continuation = signal<string | null>(null);
  const database = signal(session.getInfo().database),
    switching = signal(false),
    mutating = signal(false);
  // SCAN and TYPE share the Session's background transport. Give a name batch priority.
  const typeReadBlocked = () => scanBusy() || switching() || mutating();
  const { load: loadVisibleTypes, setVisibleKeys } = createVisibleKeyTypes(
    session,
    keys,
    entries => keys.set(entries),
    typeReadBlocked,
  );
  effect(() => {
    if (!typeReadBlocked()) untracked(() => void loadVisibleTypes());
  });
  const databases = signal<RedisDatabase[]>([
    { database: database(), keyCount: null },
  ]);
  const databasesBusy = signal(false),
    databasesComplete = signal(true),
    databasesError = signal("");
  const error = signal(""),
    latency = signal<number>();
  const active = computed(() => tabs().find((tab) => tab.id === activeId()));
  const hasDrafts = computed(() => tabs().some(dirty));
  const scanActive = computed(() => !!scan());
  const lockedKeys = computed(() =>
    tabs().filter((tab) => tab.loading || tab.uncertain).map((tab) => tab.id),
  );
  const keyTreeInventory = computed(() => {
    const inventory = keys();
    return {
      keys: inventory,
      revision: inventory.revision,
      selected: activeId() ?? null,
      menuDisabled: switching() || mutating(),
      lockedKeys: lockedKeys(),
      searching: !scanStopped() && (scanBusy() || !complete()),
      stopped: scanStopped(),
    };
  });
  function configureKeys(separator: string, grouped: boolean) {
    const inventory = keys();
    const revision = inventory.revision;
    inventory.configure(separator, grouped);
    if (inventory.revision !== revision) keys.set(inventory);
  }
  function expandKeyFolders(expanded: boolean) {
    const inventory = keys();
    inventory.expandAll(expanded);
    keys.set(inventory);
  }
  const bulkDeleted = signal("0"),
    creationUncertain = signal(false);
  let scanRevision = 0,
    catalogRevision = 0,
    loadSequence = 0,
    newRowSequence = 0,
    epoch = 0,
    disposed = false,
    ttlBusy = false;
  let autoOpenPending = true;
  let keyScanOptions: KeyScanOptions = {};
  let bulkJob: { cancelled: boolean; scan?: RedisKeyScan } | undefined;
  const loads = new Map<string, number>();
  const previewLoads = new Map<string, number>();
  let previewSequence = 0;
  const jsonLoads = new Map<string, number>();
  let jsonSequence = 0;
  const collectionCursors = new Map<string, CollectionCursor>();
  function clearKeys() {
    const entries = keys();
    entries.clear();
    keys.set(entries);
  }
  function keyById(id: string) {
    const key = keyFromId(id);
    const entries = keys();
    return key ? entries.lookup(key) ?? undefined : undefined;
  }
  function removeKey(id: string) {
    const key = keyFromId(id);
    const entries = keys();
    if (key && entries.remove(key)) keys.set(entries);
  }
  function setKeyUncertain(id: string, uncertain: boolean) {
    const key = keyFromId(id);
    const entries = keys();
    if (key && entries.setUncertain(key, uncertain)) keys.set(entries);
  }
  const update = (id: string, change: Partial<KeyTab>) =>
    tabs.set(
      tabs().map((tab) => (tab.id === id ? { ...tab, ...change } : tab)),
    );
  const alive = (context: number) => !disposed && epoch === context;
  function reportError(message: string) {
    error.set(message);
    toast.error(message);
  }
  function cancelScan() {
    const handle = scan();
    if (!handle) return;
    scan.set(undefined);
    handle.cancel();
    handle.dispose();
  }
  function stopScan() {
    if (disposed || !scan()) return;
    ++scanRevision;
    cancelScan();
    continuation.set(null);
    scanBusy.set(false);
    scanStopped.set(true);
  }
  function cancelFolderDelete() {
    if (bulkJob) {
      bulkJob.cancelled = true;
      bulkJob.scan?.cancel();
    }
  }
  function releaseCollection(id: string) {
    const cursor = collectionCursors.get(id);
    if (cursor) {
      cursor.scan.cancel();
      cursor.scan.dispose();
      collectionCursors.delete(id);
    }
  }
  function cancelCollections() {
    for (const id of collectionCursors.keys()) releaseCollection(id);
  }
  function collectionCursor(
    id: string,
    key: Uint8Array,
    kind: CollectionData["kind"],
  ) {
    let cursor = collectionCursors.get(id);
    if (!cursor && (kind === "hash" || kind === "set")) {
      cursor =
        kind === "hash"
          ? { kind, scan: session.scanHash(key) }
          : { kind, scan: session.scanSet(key) };
      collectionCursors.set(id, cursor);
    }
    return cursor;
  }
  cleanup(() => {
    disposed = true;
    ++epoch;
    ++scanRevision;
    cancelScan();
    setVisibleKeys();
    cancelFolderDelete();
    cancelCollections();
  });

  async function loadDatabases() {
    if (disposed || switching() || databasesBusy()) return;
    const current = ++catalogRevision,
      context = epoch;
    databasesBusy.set(true);
    databasesError.set("");
    try {
      const result = await session.listDatabases();
      if (!alive(context) || current !== catalogRevision) return;
      databases.set(result.items);
      databasesComplete.set(result.complete);
    } catch (cause) {
      if (alive(context) && current === catalogRevision) {
        databases.set(databases().map((item) => ({ ...item, keyCount: null })));
        databasesError.set(safeError(cause));
      }
    } finally {
      if (!disposed && current === catalogRevision) databasesBusy.set(false);
    }
  }

  async function nextPage() {
    let handle = scan();
    if (!handle || scanBusy() || complete() || switching()) return;
    const current = scanRevision;
    const options = keyScanOptions;
    const filtered = !!options.pattern;
    const entries = keys();
    const requestedTotal = entries.length + keyBrowserBatchSize;
    let remaining = keyBrowserBatchSize;
    let restarted = false;
    let replaceResults = false;
    scanBusy.set(true);
    error.set("");
    try {
      for (;;) {
        let page;
        try {
          const limit = filtered ? undefined : Math.min(remaining, keyBrowserBatchSize);
          page = await handle.nextPage(limit);
        } catch (cause) {
          if (disposed || current !== scanRevision) return;
          if (
            (cause as { code?: string })?.code !== "CURSOR_INVALIDATED" ||
            restarted ||
            switching()
          )
            throw cause;
          cancelScan();
          continuation.set(null);
          handle = session.startKeyScan(options);
          scan.set(handle);
          restarted = true;
          replaceResults = true;
          remaining = requestedTotal;
          continue;
        }
        if (disposed || current !== scanRevision) return;
        if (replaceResults) {
          clearKeys();
          replaceResults = false;
        }
        complete.set(page.complete);
        continuation.set(page.continuation ?? null);
        if (page.complete) cancelScan();

        const added = page.keys.length ? entries.appendPage(page.keys).length : 0;
        if (added) {
          if (!filtered) remaining -= added;
          keys.set(entries);
        }
        if (autoOpenPending && !tabs().length && entries.length) {
          const first = entries.firstEntry();
          if (first) void openKey(first.key);
        }
        if (page.complete || switching() || (!filtered && remaining <= 0))
          break;
      }
    } catch (cause) {
      if (disposed || current !== scanRevision) return;
      const invalidated = (cause as { code?: string })?.code === "CURSOR_INVALIDATED";
      if (invalidated || !scan()) {
        cancelScan();
        continuation.set(null);
        scanStopped.set(true);
      }
      reportError(invalidated ? w("scanInvalidated") : safeError(cause));
    } finally {
      if (!disposed && current === scanRevision) scanBusy.set(false);
    }
  }
  function refresh() {
    if (switching() || mutating()) return;
    ++scanRevision;
    cancelScan();
    clearKeys();
    scanStopped.set(false);
    complete.set(false);
    continuation.set(null);
    scanBusy.set(false);
    error.set("");
    const filter = pattern(),
      match = /[*?\[\\]/.test(filter) ? filter : `*${filter}*`;
    keyScanOptions = {
      pattern: filter && match !== "*" ? encode(match) : undefined,
      count: preferences().scanCount,
    };
    try {
      scan.set(session.startKeyScan(keyScanOptions));
      return nextPage();
    } catch (cause) {
      reportError(safeError(cause));
    }
  }
  async function load(id: string, restoring = false) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab || switching()) return;
    const current = ++loadSequence,
      context = epoch;
    releaseCollection(id);
    loads.set(id, current);
    previewLoads.delete(id);
    jsonLoads.delete(id);
    update(id, {
      loading: true,
      error: "",
      preview: tab.preview ? { ...tab.preview, loading: false } : undefined,
    });
    const valid = () => alive(context) && loads.get(id) === current;
    try {
      const info = await session.getKeyInfo(tab.key, { memorySamples: 5 });
      if (!valid()) return;
      update(id, { info });
      let bytes: Uint8Array = new Uint8Array();
      let text = "",
        partial = false,
        binary = false,
        editable = false;
      let collection: CollectionData | undefined;
      let stream: StreamData | undefined;
      let json: JsonData | undefined;
      if (!info.exists) throw { code: "KEY_NOT_FOUND" };
      if (info.type === "string") {
        const part = await session.readStringRange(tab.key, {
          offset: "0",
          length: String(previewBytes),
        });
        if (!part.exists) throw { code: "KEY_NOT_FOUND" };
        bytes = part.value;
        partial = BigInt(part.length) > BigInt(bytes.length);
        const decoded = decode(bytes);
        binary = decoded === undefined;
        text = decoded ?? displayBytes(bytes);
        editable = !partial && !binary;
        info.length = part.length;
        info.expiration = part.expiration;
        info.ttlMs = part.ttlMs;
      } else if (info.type === "json") {
        json = newJsonData(tab.json);
        try {
          const document = await session.readJson(tab.key, {});
          if (!document.exists) throw { code: "KEY_NOT_FOUND" };
          bytes = encode(document.value);
          text = document.value;
          editable = true;
          info.expiration = document.expiration;
          info.ttlMs = document.ttlMs;
        } catch (cause) {
          if ((cause as { code?: string })?.code !== "PAYLOAD_TOO_LARGE")
            throw cause;
          partial = true;
        }
      } else if (isCollection(info.type)) {
        const cursor = collectionCursor(id, tab.key, info.type);
        let page = await readCollectionPage(
          session,
          tab.key,
          info.type,
          0,
          cursor,
        );
        while (valid() && !page.rows.length && !page.complete)
          page = await readCollectionPage(
            session,
            tab.key,
            info.type,
            0,
            cursor,
          );
        if (!valid()) return;
        if (!page.exists) throw { code: "KEY_NOT_FOUND" };
        const unique = new Map(page.rows.map((row) => [row.id, row]));
        collection = {
          kind: info.type,
          rows: [...unique.values()],
          complete: page.complete,
          loading: false,
          nextOffset: page.rows.length,
        };
        partial = !page.complete;
        text = collectionText(info.type, collection.rows);
        info.length = page.length;
        info.expiration = page.expiration;
        info.ttlMs = page.ttlMs;
        if (page.complete) releaseCollection(id);
      } else if (info.type === "stream") {
        const page = await session.readStreamRange(tab.key, { count: 200 });
        if (!valid()) return;
        if (!page.exists) throw { code: "KEY_NOT_FOUND" };
        stream = {
          entries: page.entries,
          complete: page.complete,
          nextAfter: page.nextAfter,
          loading: false,
        };
        partial = !page.complete;
        text = streamText(page.entries);
        info.length = page.length;
        info.expiration = page.expiration;
        info.ttlMs = page.ttlMs;
      } else text = w("unsupportedType", { type: info.type });
      if (!valid()) return;
      const formatter = info.type === "string" ? preferences().formatter : "auto";
      const formatted = binary || formatter === "raw" || formatter === "hex"
        ? undefined
        : formatJson(text),
        value = formatted ?? text;
      update(id, {
        info,
        bytes,
        value,
        saved: value,
        partial,
        binary,
        editable,
        collection,
        stream,
        json,
        format:
          collection || stream
            ? "table"
            : binary || formatter === "hex"
              ? "hex"
              : formatted !== undefined
                ? "json"
                : "text",
        loading: false,
        uncertain: false,
        preview: undefined,
      });
      if (json && tab.json?.query)
        await fetchJsonQuery(id, tab.json.query.path);
      else if (json && partial) toast.info(w("jsonDocumentTooLarge"));
      else if (info.type === "string") {
        if (partial) toast.info(w("partialWarning"));
        else if (binary && !tab.preview) toast.info(w("binaryWarning"));
      }
      if (tab.preview && info.type === "string" && !partial)
        await setValuePreview(
          id,
          tab.preview.decoding,
          tab.preview.decompression,
          false,
        );
      setKeyUncertain(id, false);
    } catch (cause) {
      if (valid()) {
        releaseCollection(id);
        if (restoring && (cause as { code?: string })?.code === "KEY_NOT_FOUND") {
          forgetKey(id);
          return;
        }
        const message =
          tabs().find((item) => item.id === id)?.info?.type === "json"
            ? jsonError(cause)
            : safeError(cause);
        update(id, {
          loading: false,
          error: message,
          editable: false,
        });
        if (!restoring) toast.error(message);
      }
    }
  }
  function keyTab(key: Uint8Array): KeyTab {
    return {
      id: keyId(key),
      key,
      name: displayBytes(key),
      value: "",
      saved: "",
      bytes: new Uint8Array(),
      format: "text",
      loading: true,
      editable: false,
      partial: false,
      binary: false,
      error: "",
      uncertain: false,
    };
  }
  async function openKey(key: Uint8Array) {
    if (switching()) return;
    autoOpenPending = false;
    const id = keyId(key);
    activeId.set(id);
    if (tabs().some((tab) => tab.id === id)) return;
    tabs.set([...tabs(), keyTab(key)]);
    await load(id);
  }
  async function restoreWorkspace(saved: WorkspaceSnapshot) {
    if (saved.database !== database() &&
        !await switchDatabase(String(saved.database), false, undefined, false)) return;
    if (disposed) return;
    const restored = saved.tabs.map((id) => keyTab(
      Uint8Array.from(id.match(/../g) ?? [], (byte) => parseInt(byte, 16)),
    ));
    autoOpenPending = false;
    tabs.set(restored);
    const selected = saved.selected ?? restored[0]?.id;
    activeId.set(selected);
    const context = epoch;
    void (async () => {
      if (selected !== undefined) await load(selected, true);
      for (const tab of restored) {
        if (!alive(context)) break;
        if (tab.id !== selected && tabs().find((item) => item.id === tab.id)?.loading)
          await load(tab.id, true);
      }
    })();
  }
  function setJsonPathInput(id: string, value: string) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab?.json || mutating() || switching()) return;
    jsonLoads.delete(id);
    update(id, {
      json: { ...tab.json, pathInput: value, loading: false, error: "" },
    });
  }
  async function fetchJsonQuery(id: string, path: string, showHint = false) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab?.json) return;
    const context = epoch,
      revision = loads.get(id),
      current = ++jsonSequence;
    jsonLoads.set(id, current);
    const valid = () =>
      alive(context) &&
      loads.get(id) === revision &&
      jsonLoads.get(id) === current;
    update(id, {
      json: { ...tab.json, pathInput: path, loading: true, error: "" },
    });
    try {
      const result = await session.readJson(tab.key, { path });
      if (!valid()) return;
      if (!result.exists) throw { code: "KEY_NOT_FOUND" };
      const json = tabs().find((item) => item.id === id)?.json;
      if (json) {
        update(id, {
          json: {
            ...json,
            loading: false,
            error: "",
            query: {
              path,
              value: formatJson(result.value) ?? result.value,
              matches: result.matches ?? "0",
            },
          },
          format: "json",
        });
        if (showHint) toast.info(w("jsonQueryReadonly"));
      }
    } catch (cause) {
      if (!valid()) return;
      const json = tabs().find((item) => item.id === id)?.json;
      if (json) {
        const message = jsonError(cause);
        update(id, {
          json: { ...json, loading: false, error: message },
        });
        toast.error(message);
      }
    }
  }
  async function queryJson(id: string) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab?.json || tab.loading || tab.uncertain || mutating() || switching())
      return;
    const path = tab.json.pathInput.trim();
    if (!validJsonPath(path)) {
      const message = w("jsonPathInvalid");
      update(id, { json: { ...tab.json, error: message } });
      toast.error(message);
      return;
    }
    await fetchJsonQuery(id, path, true);
  }
  function showJsonDocument(id: string) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab?.json || mutating() || switching()) return;
    jsonLoads.delete(id);
    update(id, {
      json: { ...tab.json, query: undefined, loading: false, error: "" },
      format: "json",
    });
  }
  async function mutateJsonPath(id: string, path: string, value?: string) {
    const tab = tabs().find((item) => item.id === id),
      json = tab?.json;
    if (
      !tab ||
      !json?.query ||
      json.query.path !== path ||
      json.pathInput.trim() !== path ||
      json.loading ||
      json.error ||
      tab.loading ||
      tab.error ||
      tab.uncertain ||
      dirty(tab) ||
      mutating() ||
      switching()
    )
      return false;
    if (value !== undefined && !isJson(value)) {
      error.set(w("invalidJson"));
      return false;
    }
    const context = epoch;
    mutating.set(true);
    error.set("");
    try {
      const result =
        value === undefined
          ? await session.deleteJsonPath(tab.key, path)
          : await session.setJson(tab.key, value, { path });
      if (!alive(context)) return false;
      // Refresh after acknowledgement. Read failure must not replay the write.
      await load(id);
      if (!alive(context)) return false;
      if (!tabs().find((item) => item.id === id)?.info?.exists) forgetKey(id);
      toast.success(
        value === undefined
          ? w("jsonPathDeleted", { count: result.affected })
          : w("jsonPathSaved"),
      );
      return true;
    } catch (cause) {
      if (alive(context)) {
        update(id, {
          uncertain:
            (cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN",
        });
        error.set(jsonError(cause));
      }
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  function closeTab(id: string, discard = false) {
    return closeTabs([id], discard);
  }
  function closeTabs(ids: string[], discard = false) {
    const closing = new Set(ids),
      targets = tabs().filter((tab) => closing.has(tab.id));
    if (mutating() || switching() || (!discard && targets.some(dirty)))
      return false;
    autoOpenPending = false;
    for (const tab of targets) {
      loads.delete(tab.id);
      previewLoads.delete(tab.id);
      jsonLoads.delete(tab.id);
      releaseCollection(tab.id);
    }
    tabs.set(tabs().filter((tab) => !closing.has(tab.id)));
    const selected = activeId();
    if (selected !== undefined && closing.has(selected))
      activeId.set(tabs().at(-1)?.id);
    return true;
  }
  async function refreshKeyInfo(id: string) {
    const tab = tabs().find((item) => item.id === id);
    if (!tab?.info) return;
    const context = epoch,
      revision = loads.get(id);
    const valid = () => alive(context) && loads.get(id) === revision;
    try {
      const info = await session.getKeyInfo(tab.key, { memorySamples: 5 });
      if (valid()) update(id, { info });
    } catch {
      // A failed metadata refresh must not turn an acknowledged write into a failure.
      const current = tabs().find((item) => item.id === id);
      if (valid() && current?.info)
        update(id, {
          info: {
            ...current.info,
            memoryBytes: undefined,
            memoryStatus: "unavailable",
          },
        });
    }
  }
  function updateStreamData(
    id: string,
    stream: StreamData,
    info?: RedisKeyInfo,
  ) {
    const value = streamText(stream.entries);
    update(id, {
      stream,
      value,
      saved: value,
      partial: !stream.complete,
      ...(info ? { info } : {}),
    });
  }
  function streamWritable(tab?: KeyTab) {
    return (
      !!tab?.stream &&
      !!tab.info?.exists &&
      !tab.loading &&
      !tab.error &&
      !tab.uncertain &&
      !tab.stream.loading &&
      !mutating() &&
      !switching()
    );
  }
  function streamMutationError(id: string, cause: unknown) {
    const code = (cause as { code?: string })?.code,
      uncertain = code === "WRITE_OUTCOME_UNKNOWN";
    const message = uncertain
      ? w("unknownWrite")
      : code === "STREAM_ID_ORDER"
        ? w("streamIdOrder")
        : code === "PAYLOAD_TOO_LARGE"
          ? w("streamMessageTooLarge")
          : safeError(cause);
    update(id, { uncertain });
    error.set(message);
  }
  async function addStreamMessage(id: string, options: StreamAppendOptions) {
    const tab = tabs().find((item) => item.id === id);
    if (!streamWritable(tab) || !tab?.stream) return false;
    const context = epoch;
    mutating.set(true);
    error.set("");
    try {
      const result = await session.appendStreamEntry(tab.key, options);
      if (!alive(context)) return false;
      const current = tabs().find((item) => item.id === id);
      if (!current?.stream) return false;
      const stream = current.stream,
        entries = orderStreamEntries([
          ...stream.entries,
          { id: result.id, fields: options.fields },
        ]);
      // Retain the boundary of the contiguous history, so adding at the tail
      // never skips the older messages that have not been loaded yet.
      const nextAfter = stream.complete
        ? stream.entries.at(-1)?.id
        : stream.nextAfter;
      const info = current.info
        ? {
            ...current.info,
            exists: true,
            length:
              current.info.length == null
                ? undefined
                : String(BigInt(current.info.length) + 1n),
          }
        : undefined;
      updateStreamData(
        id,
        {
          ...stream,
          entries,
          complete: false,
          nextAfter,
        },
        info,
      );
      await refreshKeyInfo(id);
      if (!alive(context)) return false;
      const refreshed = tabs().find((item) => item.id === id);
      if (
        stream.complete &&
        refreshed?.stream &&
        refreshed.info?.length != null &&
        BigInt(refreshed.info.length) <= BigInt(refreshed.stream.entries.length)
      ) {
        updateStreamData(id, {
          ...refreshed.stream,
          complete: true,
          nextAfter: undefined,
        });
      }
      toast.success(w("streamAdded", { id: result.id }));
      return true;
    } catch (cause) {
      if (alive(context)) streamMutationError(id, cause);
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  async function deleteStreamMessage(id: string, messageId: string) {
    const tab = tabs().find((item) => item.id === id);
    if (
      !streamWritable(tab) ||
      !tab?.stream ||
      !tab.stream.entries.some((entry) => entry.id === messageId)
    )
      return false;
    const context = epoch;
    mutating.set(true);
    error.set("");
    try {
      const result = await session.deleteStreamEntry(tab.key, messageId);
      if (!alive(context)) return false;
      const current = tabs().find((item) => item.id === id);
      if (!current?.stream) return false;
      const entries = current.stream.entries.filter(
        (entry) => entry.id !== messageId,
      );
      const count =
        current.info?.length == null
          ? undefined
          : BigInt(current.info.length) - BigInt(result.affected);
      const info = current.info
        ? {
            ...current.info,
            length: count == null ? undefined : String(count < 0n ? 0n : count),
          }
        : undefined;
      updateStreamData(id, { ...current.stream, entries }, info);
      await refreshKeyInfo(id);
      if (!alive(context)) return false;
      toast.success(w("streamDeleted", { id: messageId }));
      return true;
    } catch (cause) {
      if (alive(context)) streamMutationError(id, cause);
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  async function loadMoreStream(id: string) {
    const tab = tabs().find((item) => item.id === id),
      stream = tab?.stream;
    if (
      !tab ||
      !stream ||
      stream.complete ||
      stream.loading ||
      tab.loading ||
      tab.uncertain ||
      switching() ||
      mutating()
    )
      return;
    const context = epoch,
      revision = loads.get(id),
      valid = () => alive(context) && loads.get(id) === revision;
    update(id, { stream: { ...stream, loading: true } });
    try {
      const page = await session.readStreamRange(tab.key, {
        after: stream.nextAfter,
        count: 200,
      });
      if (!valid()) return;
      const seen = new Set(stream.entries.map((entry) => entry.id));
      const entries = page.exists
        ? orderStreamEntries([
            ...stream.entries,
            ...page.entries.filter((entry) => !seen.has(entry.id)),
          ])
        : [];
      const value = streamText(entries),
        info = tabs().find((item) => item.id === id)?.info;
      update(id, {
        stream: {
          entries,
          complete: page.complete,
          nextAfter: page.nextAfter,
          loading: false,
        },
        value,
        saved: value,
        partial: !page.complete,
        info: info
          ? {
              ...info,
              exists: page.exists,
              length: page.length,
              expiration: page.expiration,
              ttlMs: page.ttlMs,
            }
          : undefined,
      });
    } catch (cause) {
      if (valid()) {
        update(id, { stream: { ...stream, loading: false } });
        toast.error(safeError(cause));
      }
    }
  }
  async function loadMoreCollection(id: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection;
    if (
      !tab ||
      !collection ||
      collection.complete ||
      collection.loading ||
      tab.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    const context = epoch,
      revision = loads.get(id);
    const valid = () => alive(context) && loads.get(id) === revision;
    update(id, { collection: { ...collection, loading: true } });
    try {
      const cursor = collectionCursor(id, tab.key, collection.kind),
        seen = new Set(collection.rows.map((row) => row.id));
      let offset = collection.nextOffset;
      let page = await readCollectionPage(
        session,
        tab.key,
        collection.kind,
        offset,
        cursor,
      );
      offset += page.rows.length;
      while (
        valid() &&
        !page.complete &&
        !page.rows.some((row) => !seen.has(row.id))
      ) {
        page = await readCollectionPage(
          session,
          tab.key,
          collection.kind,
          offset,
          cursor,
        );
        offset += page.rows.length;
      }
      if (!valid()) return;
      const rows = [...collection.rows];
      for (const row of page.rows)
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      const next = {
        ...collection,
        rows: orderCollectionRows(collection.kind, [
          ...rows.filter((row) => !row.isNew),
          ...rows.filter((row) => row.isNew),
        ]),
        complete: page.complete,
        loading: false,
        nextOffset: offset,
      };
      const info = tabs().find((item) => item.id === id)?.info;
      update(id, {
        collection: next,
        partial: !page.complete,
        value: collectionText(next.kind, next.rows),
        info: info
          ? {
              ...info,
              exists: page.exists,
              length: page.length,
              expiration: page.expiration,
              ttlMs: page.ttlMs,
            }
          : undefined,
      });
      if (page.complete) releaseCollection(id);
    } catch (cause) {
      if (valid()) {
        releaseCollection(id);
        reportError(safeError(cause));
      }
    } finally {
      const current = tabs().find((item) => item.id === id)?.collection;
      if (valid() && current?.loading)
        update(id, { collection: { ...current, loading: false } });
    }
  }
  async function reloadCollectionRow(id: string, rowId: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection,
      row = collection?.rows.find((item) => item.id === rowId);
    if (
      !tab ||
      !collection ||
      !row ||
      row.isNew ||
      collection.loading ||
      tab.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return false;
    const context = epoch,
      revision = loads.get(id),
      valid = () => alive(context) && loads.get(id) === revision;
    update(id, { collection: { ...collection, loading: true } });
    error.set("");
    try {
      const result = await session.readCollectionRow(
        tab.key,
        collectionRowTarget(collection.kind, row),
      );
      if (!valid()) return false;
      const current = tabs().find((item) => item.id === id)?.collection;
      if (!current) return false;
      const refreshed = {
        ...row,
        value: result.value ?? row.value,
        score: result.score ?? row.score,
        draft: undefined,
        identityDraft: undefined,
      };
      const rows = orderCollectionRows(
        current.kind,
        result.exists
          ? current.rows.map((item) => (item.id === rowId ? refreshed : item))
          : current.rows.filter((item) => item.id !== rowId),
      );
      update(id, {
        collection: {
          ...current,
          rows,
          nextOffset:
            current.kind === "zset" && !current.complete
              ? 0
              : current.nextOffset,
        },
        value: collectionText(current.kind, rows),
        saved: collectionText(
          current.kind,
          rows
            .filter((item) => !item.isNew)
            .map((item) => ({
              ...item,
              draft: undefined,
              identityDraft: undefined,
            })),
        ),
      });
      await refreshKeyInfo(id);
      if (valid()) {
        if (tabs().find((item) => item.id === id)?.info?.exists === false) {
          releaseCollection(id);
          removeKey(id);
        }
        toast.success(w("collectionRowReloaded"));
      }
      return valid();
    } catch (cause) {
      if (valid()) reportError(safeError(cause));
      return false;
    } finally {
      const current = tabs().find((item) => item.id === id)?.collection;
      if (valid() && current?.loading)
        update(id, { collection: { ...current, loading: false } });
    }
  }
  async function deleteCollectionRow(id: string, rowId: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection,
      row = collection?.rows.find((item) => item.id === rowId);
    if (
      !tab ||
      !collection ||
      !row ||
      row.isNew ||
      collection.loading ||
      tab.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return false;
    const context = epoch;
    mutating.set(true);
    error.set("");
    try {
      const result = await session.deleteCollectionRow(
        tab.key,
        collectionRowTarget(collection.kind, row, true),
      );
      if (!alive(context)) return false;
      const current = tabs().find((item) => item.id === id)?.collection;
      if (!current) return false;
      const removed = result.affected !== "0",
        list = current.kind === "list" && removed;
      const rows = current.rows
        .filter((item) => item.id !== rowId)
        .map((item) => {
          if (!list || item.isNew || BigInt(item.index!) <= BigInt(row.index!))
            return item;
          const index = String(BigInt(item.index!) - 1n);
          return { ...item, id: index, index };
        });
      const nextOffset = list
        ? Math.max(
            0,
            current.nextOffset -
              (BigInt(row.index!) < BigInt(current.nextOffset) ? 1 : 0),
          )
        : current.kind === "zset" && !current.complete
          ? 0
          : current.nextOffset;
      update(id, {
        collection: { ...current, rows, nextOffset },
        value: collectionText(current.kind, rows),
        saved: collectionText(
          current.kind,
          rows
            .filter((item) => !item.isNew)
            .map((item) => ({
              ...item,
              draft: undefined,
              identityDraft: undefined,
            })),
        ),
      });
      await refreshKeyInfo(id);
      if (!alive(context)) return false;
      if (tabs().find((item) => item.id === id)?.info?.exists === false) {
        releaseCollection(id);
        removeKey(id);
      }
      toast.success(w("collectionRowDeleted"));
      return true;
    } catch (cause) {
      if (alive(context)) {
        const code = (cause as { code?: string })?.code,
          uncertain = code === "WRITE_OUTCOME_UNKNOWN";
        if (uncertain) update(id, { uncertain: true });
        error.set(
          uncertain
            ? w("unknownWrite")
            : code === "ROW_CHANGED"
              ? w("collectionRowChanged")
              : safeError(cause),
        );
      }
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  function editCollectionCell(
    id: string,
    rowId: string,
    draft: string | undefined,
  ) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection;
    if (
      !tab ||
      !collection ||
      !tab.info?.exists ||
      tab.loading ||
      tab.error ||
      collection.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    const row = collection.rows.find((item) => item.id === rowId);
    if (!row || !rowEditable(collection.kind, row)) return;
    const original = rowValue(collection.kind, { ...row, draft: undefined });
    const rows = collection.rows.map((item) =>
      item.id === rowId
        ? { ...item, draft: draft === original ? undefined : draft }
        : item,
    );
    update(id, {
      collection: { ...collection, rows },
      value: collectionText(collection.kind, rows),
    });
  }
  function addCollectionRow(id: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection;
    if (
      !tab ||
      !collection ||
      !tab.info?.exists ||
      tab.loading ||
      tab.error ||
      collection.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    const row: CollectionRow = {
      id: `new:${++newRowSequence}`,
      value: encode(""),
      isNew: true,
    };
    if (collection.kind === "hash") row.field = encode("");
    else if (collection.kind === "zset") row.score = 0;
    else if (collection.kind === "list")
      row.index = String(
        BigInt(tab.info.length ?? "0") +
          BigInt(collection.rows.filter((item) => item.isNew).length),
      );
    const rows = [...collection.rows, row];
    update(id, {
      collection: { ...collection, rows },
      value: collectionText(collection.kind, rows),
    });
    return row.id;
  }
  function editCollectionIdentity(id: string, rowId: string, value: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection;
    if (
      !tab ||
      !collection ||
      !tab.info?.exists ||
      tab.loading ||
      tab.error ||
      collection.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    const row = collection.rows.find((item) => item.id === rowId);
    if (!row || !["hash", "zset"].includes(collection.kind)) return;
    const original = collection.kind === "hash" ? row.field! : row.value;
    if (decode(original) === undefined) return;
    const change = row.isNew
      ? collection.kind === "hash"
        ? { field: encode(value) }
        : { value: encode(value) }
      : { identityDraft: value === displayBytes(original) ? undefined : value };
    const rows = collection.rows.map((item) =>
      item.id === rowId ? { ...item, ...change } : item,
    );
    update(id, {
      collection: { ...collection, rows },
      value: collectionText(collection.kind, rows),
    });
  }
  function removeNewCollectionRow(id: string, rowId: string) {
    const tab = tabs().find((item) => item.id === id),
      collection = tab?.collection;
    if (
      !tab ||
      !collection ||
      collection.loading ||
      tab.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    const rows = collection.rows.filter(
      (row) => row.id !== rowId || !row.isNew,
    );
    update(id, {
      collection: { ...collection, rows },
      value: collectionText(collection.kind, rows),
    });
  }
  async function saveCollection(tab: KeyTab) {
    const collection = tab.collection;
    if (
      !collection ||
      !tab.info?.exists ||
      tab.loading ||
      tab.error ||
      collection.loading ||
      tab.uncertain ||
      !dirty(tab) ||
      mutating() ||
      switching()
    )
      return false;
    const changed = collection.rows.filter(rowDirty);
    if (
      collection.kind === "zset" &&
      changed.some(
        (row) =>
          !rowValue("zset", row).trim() ||
          !Number.isFinite(Number(rowValue("zset", row))),
      )
    ) {
      toast.error(w("invalidScore"));
      return false;
    }
    if (collection.kind !== "list") {
      const identities = new Set<string>();
      for (const row of collection.rows) {
        const identity = keyId(
          collection.kind === "set" && row.draft !== undefined
            ? encode(row.draft)
            : rowIdentityBytes(collection.kind, row),
        );
        if (identities.has(identity)) {
          reportError(w("collectionRowExists"));
          return false;
        }
        identities.add(identity);
      }
    }
    const context = epoch;
    let acknowledged = false;
    mutating.set(true);
    error.set("");
    try {
      for (const row of changed) {
        const saved = await writeCollectionRow(
          session,
          tab.key,
          collection.kind,
          row,
        );
        if (!alive(context)) return false;
        acknowledged = true;
        const current = tabs().find((item) => item.id === tab.id)?.collection;
        if (!current) return false;
        const rows = orderCollectionRows(
          current.kind,
          current.rows
            .filter((item) => item.id === row.id || item.id !== saved.id)
            .map((item) => (item.id === row.id ? saved : item)),
        );
        update(tab.id, {
          collection: {
            ...current,
            rows,
            nextOffset:
              current.kind === "zset" && !current.complete
                ? 0
                : current.nextOffset,
          },
          value: collectionText(current.kind, rows),
          saved: collectionText(
            current.kind,
            rows
              .filter((item) => !item.isNew)
              .map((item) => ({
                ...item,
                draft: undefined,
                identityDraft: undefined,
              })),
          ),
        });
      }
      toast.success(w("saved"));
      return true;
    } catch (cause) {
      if (alive(context)) {
        const code = (cause as { code?: string })?.code,
          uncertain = code === "WRITE_OUTCOME_UNKNOWN";
        if (uncertain) update(tab.id, { uncertain: true });
        reportError(
          uncertain
            ? w("unknownWrite")
            : code === "ROW_CONFLICT"
              ? w("collectionRowExists")
              : code === "ROW_NOT_FOUND"
                ? w("collectionRowMissing")
                : code === "MEMBER_CONFLICT"
                  ? w("collectionMemberConflict")
                  : code === "MEMBER_NOT_FOUND"
                    ? w("collectionMemberMissing")
                    : safeError(cause),
        );
      }
      return false;
    } finally {
      if (alive(context)) {
        if (acknowledged) await refreshKeyInfo(tab.id);
        if (alive(context)) mutating.set(false);
      }
    }
  }
  async function save() {
    const tab = active();
    if (tab?.collection) return saveCollection(tab);
    if (
      !tab ||
      (tab.preview ? !valuePreviewEditable(tab.preview) : !tab.editable) ||
      tab.json?.query ||
      tab.json?.loading ||
      tab.loading ||
      !dirty(tab) ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return false;
    const preview = tab.preview,
      value = preview?.value ?? tab.value;
    if (
      (tab.info?.type === "json" ||
        (preview?.format ?? tab.format) === "json" ||
        valueDecodingNeedsJson(preview?.decoding)) &&
      !isJson(value)
    ) {
      toast.error(w("invalidJson"));
      return false;
    }
    const context = epoch;
    let dispatched = false;
    mutating.set(true);
    error.set("");
    try {
      const bytes = preview
        ? valuePreviewDirty(preview)
          ? await encodeValuePreview(preview)
          : preview.source
        : encode(value);
      const restored =
        preview && valuePreviewDirty(preview)
          ? await decodeValuePreview(
              bytes,
              preview.decoding,
              preview.decompression,
            )
          : undefined;
      if (!alive(context)) return false;
      dispatched = true;
      if (tab.info?.type === "json") await session.setJson(tab.key, value, {});
      else await session.setString(tab.key, bytes, {});
      if (!alive(context)) return false;
      const current = tabs().find((item) => item.id === tab.id);
      const savedValue = restored?.value ?? value;
      const raw = preview ? decode(bytes) : value;
      const formatted =
        preview && raw !== undefined ? formatJson(raw) : undefined;
      const stored = preview
        ? raw === undefined
          ? displayBytes(bytes)
          : (formatted ?? raw)
        : value;
      update(tab.id, {
        saved: stored,
        ...(preview
          ? {
              value: stored,
              binary: raw === undefined,
              editable: raw !== undefined,
              format:
                raw === undefined
                  ? "hex"
                  : formatted !== undefined
                    ? "json"
                    : "text",
              preview: {
                ...current!.preview!,
                source: bytes,
                value:
                  current!.preview!.value === value
                    ? savedValue
                    : current!.preview!.value,
                saved: savedValue,
                bytes: restored?.bytes ?? encode(value),
              },
            }
          : {}),
        bytes,
        info: tab.info
          ? { ...tab.info, length: String(bytes.length) }
          : undefined,
      });
      await refreshKeyInfo(tab.id);
      if (!alive(context)) return false;
      toast.success(w("saved"));
      return true;
    } catch (cause) {
      if (alive(context)) {
        const uncertain =
          dispatched &&
          (cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN";
        update(tab.id, { uncertain });
        reportError(
          uncertain
            ? w("unknownWrite")
            : dispatched
              ? tab.info?.type === "json"
                ? jsonError(cause)
                : safeError(cause)
              : valueCodecEncodeError(cause),
        );
      }
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  async function changeKey(
    id: string,
    operation: "rename" | "delete" | "expiry" | "persist",
    argument = "",
  ) {
    const opened = tabs().find((item) => item.id === id),
      tab = opened ?? keyById(id);
    if (
      !tab ||
      mutating() ||
      switching() ||
      opened?.loading ||
      (operation === "rename" &&
        (opened?.preview?.loading || opened?.json?.loading)) ||
      (operation === "rename" &&
        (opened?.collection?.loading || opened?.stream?.loading)) ||
      tab.uncertain
    )
      return false;
    const context = epoch;
    mutating.set(true);
    error.set("");
    try {
      if (operation === "rename") {
        const newKey = encode(argument),
          newId = keyId(newKey);
        if (tabs().some((item) => item.id === newId && item.id !== id)) {
          error.set(w("keyConflict"));
          return false;
        }
        await session.renameKey(tab.key, newKey, {});
        if (!alive(context)) return false;
        loads.delete(id);
        previewLoads.delete(id);
        jsonLoads.delete(id);
        releaseCollection(id);
        update(id, { id: newId, key: newKey, name: argument });
        const entries = keys();
        if (entries.rename(tab.key, newKey)) keys.set(entries);
        if (activeId() === id) activeId.set(newId);
        await refreshKeyInfo(newId);
      } else if (operation === "delete") {
        await session.deleteKey(tab.key);
        if (!alive(context)) return false;
        forgetKey(id);
      } else {
        if (operation === "expiry") await session.setExpiry(tab.key, argument);
        else await session.persistKey(tab.key);
        if (!alive(context)) return false;
        await refreshKeyInfo(id);
      }
      if (alive(context))
        toast.success(
          w(
            operation === "rename"
              ? "renamed"
              : operation === "delete"
                ? "deleted"
                : "expirySaved",
          ),
        );
      return true;
    } catch (cause) {
      if (alive(context)) {
        const uncertain =
          (cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN";
        if (uncertain) {
          update(id, { uncertain: true });
          setKeyUncertain(id, true);
        }
        error.set(uncertain ? w("unknownWrite") : safeError(cause));
      }
      return false;
    } finally {
      if (alive(context)) mutating.set(false);
    }
  }
  function forgetKey(id: string) {
    loads.delete(id);
    previewLoads.delete(id);
    jsonLoads.delete(id);
    releaseCollection(id);
    tabs.set(tabs().filter((item) => item.id !== id));
    removeKey(id);
    if (activeId() === id) activeId.set(tabs().at(-1)?.id);
  }
  async function createKey(name: string, options: CreateKeyOptions) {
    if (!name || disposed || switching() || mutating() || creationUncertain())
      return false;
    const targetDatabase = options.database ?? database(),
      inWorkspace = targetDatabase === database();
    const key = encode(name),
      id = keyId(key),
      opened = inWorkspace ? tabs().find((tab) => tab.id === id) : undefined;
    if (dirty(opened)) {
      error.set(w("keyConflict"));
      return false;
    }
    const context = epoch;
    let created = false;
    mutating.set(true);
    error.set("");
    try {
      await session.createKey(key, options);
      if (!alive(context)) return false;
      created = true;
      if (inWorkspace) {
        if (opened) {
          activeId.set(id);
          await load(id);
        } else await openKey(key);
      }
      if (alive(context))
        toast.success(
          inWorkspace
            ? w("keyCreated")
            : w("keyCreatedInDatabase", { database: targetDatabase }),
        );
      return true;
    } catch (cause) {
      if (alive(context)) {
        const unknown =
          (cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN";
        creationUncertain.set(unknown);
        error.set(
          unknown
            ? inWorkspace
              ? w("createUnknown")
              : w("createUnknownInDatabase", { database: targetDatabase })
            : (cause as { code?: string })?.code === "KEY_CONFLICT"
              ? w("keyExists")
              : options.keyType === "json"
                ? jsonError(cause)
                : safeError(cause),
        );
      }
      return false;
    } finally {
      if (alive(context)) {
        mutating.set(false);
        if (created) {
          if (inWorkspace) refresh();
          void loadDatabases();
        }
      }
    }
  }
  async function deleteFolder(prefix: string) {
    if (!prefix || disposed || switching() || mutating()) return false;
    const context = epoch,
      sessionContext = session.getInfo(),
      bytes = encode(prefix);
    const job: { cancelled: boolean; scan?: RedisKeyScan } = {
      cancelled: false,
    };
    let deleted = 0n;
    bulkJob = job;
    bulkDeleted.set("0");
    mutating.set(true);
    error.set("");
    ++scanRevision;
    cancelScan();
    scanBusy.set(false);
    try {
      job.scan = session.startKeyScan({
        pattern: keyPrefixPattern(bytes),
        count: preferences().scanCount,
      });
      while (!job.cancelled && alive(context)) {
        const page = await job.scan.nextPage();
        if (!alive(context)) return false;
        for (const key of page.keys) {
          if (job.cancelled) break;
          const current = session.getInfo();
          if (
            current.database !== sessionContext.database ||
            current.generation !== sessionContext.generation
          )
            throw { code: "CURSOR_INVALIDATED" };
          if (
            key.length < bytes.length ||
            !bytes.every((byte, index) => key[index] === byte)
          )
            continue;
          const result = await session.deleteKey(key);
          if (!alive(context)) return false;
          deleted += BigInt(result.affected);
          bulkDeleted.set(String(deleted));
          forgetKey(keyId(key));
        }
        if (page.complete) break;
      }
      if (!alive(context)) return false;
      if (job.cancelled)
        toast.info(w("bulkDeleteStopped", { count: String(deleted) }));
      else toast.success(w("bulkDeleteDone", { count: String(deleted) }));
      return true;
    } catch (cause) {
      if (!alive(context)) return false;
      if (job.cancelled && (cause as { code?: string })?.code === "CANCELLED") {
        toast.info(w("bulkDeleteStopped", { count: String(deleted) }));
        return true;
      }
      error.set(
        w("bulkDeleteFailed", { count: String(deleted) }) +
          " " +
          ((cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN"
            ? w("unknownWrite")
            : safeError(cause)),
      );
      return false;
    } finally {
      job.scan?.cancel();
      job.scan?.dispose();
      if (bulkJob === job) bulkJob = undefined;
      if (alive(context)) {
        mutating.set(false);
        const failure = error();
        refresh();
        if (failure) error.set(failure);
        void loadDatabases();
      }
    }
  }
  async function switchDatabase(
    next: string,
    discard = false,
    keyToOpen?: Uint8Array,
    browse = true,
  ) {
    if (disposed || switching() || mutating()) return false;
    function fail(message: string) {
      if (discard) error.set(message);
      else reportError(message);
      return false;
    }
    if (
      !/^\d+$/.test(next) ||
      !Number.isSafeInteger(Number(next)) ||
      Number(next) > 2147483647
    ) {
      return fail(w("invalidDatabase"));
    }
    if (
      session.getInfo().mode.toLowerCase() === "cluster" &&
      Number(next) !== 0
    ) {
      return fail(w("clusterDatabase"));
    }
    if (Number(next) === database()) {
      if (keyToOpen) await openKey(keyToOpen);
      return true;
    }
    if (hasDrafts() && !discard) {
      toast.info(w("unsavedDatabase"));
      return false;
    }
    switching.set(true);
    error.set("");
    const context = epoch;
    try {
      await session.selectDatabase(Number(next));
      if (!alive(context)) return false;
      ++epoch;
      ++scanRevision;
      cancelScan();
      cancelCollections();
      loads.clear();
      previewLoads.clear();
      jsonLoads.clear();
      ++catalogRevision;
      databasesBusy.set(false);
      database.set(Number(next));
      tabs.set([]);
      autoOpenPending = keyToOpen === undefined;
      activeId.set(undefined);
      clearKeys();
      scanStopped.set(false);
      complete.set(false);
      continuation.set(null);
      scanBusy.set(false);
      switching.set(false);
      if (browse) {
        refresh();
        void loadDatabases();
      }
      if (keyToOpen) await openKey(keyToOpen);
      return true;
    } catch (cause) {
      if (alive(context)) fail(safeError(cause));
      return false;
    } finally {
      if (!disposed) switching.set(false);
    }
  }
  async function ping() {
    const context = epoch,
      started = Date.now();
    try {
      await session.ping();
      if (alive(context)) latency.set(Date.now() - started);
    } catch (cause) {
      if (alive(context)) {
        latency.set(undefined);
        reportError(safeError(cause));
      }
    }
  }
  async function refreshTtl() {
    const tab = active();
    if (
      disposed ||
      ttlBusy ||
      switching() ||
      mutating() ||
      !tab?.info ||
      tab.loading ||
      tab.uncertain ||
      session.getInfo().closed
    )
      return;
    const context = epoch,
      info = tab.info;
    ttlBusy = true;
    try {
      const result = await session.getKeyInfoBatch([tab.key], { ttl: true });
      const current = active(),
        metadata = result.items[0];
      if (
        !alive(context) ||
        switching() ||
        mutating() ||
        !current ||
        current.id !== tab.id ||
        current.info !== info ||
        current.loading ||
        current.uncertain
      )
        return;
      if (
        result.database !== database() ||
        result.generation !== session.getInfo().generation ||
        !metadata?.expiration ||
        !["available", "missing"].includes(metadata.ttlStatus)
      )
        return;
      const exists = metadata.exists ?? info.exists;
      if (
        info.exists === exists &&
        info.expiration === metadata.expiration &&
        info.ttlMs === metadata.ttlMs
      )
        return;
      update(tab.id, {
        info: {
          ...info,
          exists,
          expiration: metadata.expiration,
          ttlMs: metadata.ttlMs,
        },
      });
    } catch {
      /* Keep the last observation and retry on the next refresh. */
    } finally {
      ttlBusy = false;
    }
  }
  function edit(value: string) {
    const tab = active();
    if (
      !tab ||
      tab.loading ||
      tab.uncertain ||
      tab.json?.query ||
      tab.json?.loading
    )
      return;
    if (tab.preview) {
      if (valuePreviewEditable(tab.preview))
        update(tab.id, { preview: { ...tab.preview, value } });
    } else if (tab.editable) update(tab.id, { value });
  }
  async function setValuePreview(
    id: string,
    decoding: ValueDecoding,
    decompression: ValueDecompression,
    showHint = true,
  ) {
    const tab = tabs().find((item) => item.id === id);
    if (
      !tab ||
      tab.info?.type !== "string" ||
      tab.partial ||
      tab.loading ||
      tab.error ||
      tab.uncertain ||
      switching() ||
      mutating()
    )
      return;
    if (valuePreviewDirty(tab.preview)) {
      toast.info(w("valueCodecSaveBeforeSwitch"));
      return;
    }
    const revision = ++previewSequence,
      context = epoch;
    previewLoads.set(id, revision);
    if (decoding === "none" && decompression === "none") {
      update(id, { preview: undefined });
      if (tab.preview && tab.binary) toast.info(w("binaryWarning"));
      return;
    }
    const preview: ValuePreview = {
      decoding,
      decompression,
      loading: true,
      error: "",
      bytes: new Uint8Array(),
      value: "",
      saved: "",
      source: tab.value !== tab.saved ? encode(tab.value) : tab.bytes,
      binary: false,
      format: "text",
    };
    update(id, { preview });
    const valid = () => alive(context) && previewLoads.get(id) === revision;
    try {
      const result = await decodeValuePreview(
        preview.source,
        decoding,
        decompression,
      );
      if (valid()) {
        update(id, { preview: { ...preview, ...result, loading: false } });
        if (showHint)
          toast.info(
            w(result.binary ? "valueCodecBinary" : "valueCodecEditable"),
          );
      }
    } catch (cause) {
      if (valid()) {
        const message = valueCodecError(cause);
        update(id, {
          preview: {
            ...preview,
            loading: false,
            error: message,
          },
        });
        toast.error(message);
      }
    }
  }
  function revertValuePreview(id: string) {
    const tab = tabs().find((item) => item.id === id);
    if (
      !tab?.preview ||
      tab.loading ||
      tab.uncertain ||
      mutating() ||
      switching()
    )
      return;
    update(id, { preview: { ...tab.preview, value: tab.preview.saved } });
    error.set("");
  }
  function setFormat(format: ValueFormat) {
    const tab = active();
    if (!tab) return;
    update(
      tab.id,
      tab.preview ? { preview: { ...tab.preview, format } } : { format },
    );
    if (tab.format === "table" && format !== "table") {
      if (tab.stream) toast.info(w("streamRawHint"));
      else if (tab.collection) toast.info(w("collectionRawHint"));
    }
  }
  function transform(compact: boolean) {
    const tab = active();
    if (
      !tab ||
      (tab.preview ? !valuePreviewEditable(tab.preview) : !tab.editable)
    )
      return;
    const formatted = formatJson(tab.preview?.value ?? tab.value, compact);
    if (formatted === undefined) {
      toast.error(w("invalidJson"));
      return;
    }
    edit(formatted);
    toast.info(w("draftChanged"));
  }
  let browsingStarted = false;
  function startBrowsing() {
    if (disposed || browsingStarted) return;
    browsingStarted = true;
    refresh();
    void loadDatabases();
    void ping();
  }
  return {
    session,
    formatter: () => preferences().formatter,
    restoreWorkspace,
    keys: () => keys(),
    keyTreeInventory,
    setVisibleKeys,
    configureKeys,
    expandKeyFolders,
    keyById,
    tabs,
    activeId,
    active,
    pattern,
    scanActive,
    scanBusy,
    scanStopped,
    complete,
    continuation,
    database,
    databases,
    databasesBusy,
    databasesComplete,
    databasesError,
    switching,
    mutating,
    error,
    latency,
    hasDrafts,
    bulkDeleted,
    creationUncertain,
    startBrowsing,
    nextPage,
    refresh,
    stopScan,
    loadDatabases,
    openKey,
    closeTab,
    closeTabs,
    save,
    changeKey,
    createKey,
    deleteFolder,
    cancelFolderDelete,
    switchDatabase,
    ping,
    refreshTtl,
    edit,
    editCollectionCell,
    editCollectionIdentity,
    addCollectionRow,
    removeNewCollectionRow,
    reloadCollectionRow,
    deleteCollectionRow,
    loadMoreCollection,
    loadMoreStream,
    addStreamMessage,
    deleteStreamMessage,
    setFormat,
    setJsonPathInput,
    queryJson,
    showJsonDocument,
    mutateJsonPath,
    setValuePreview,
    revertValuePreview,
    transform,
    reload: async (id: string, discard = false) => {
      const tab = tabs().find((item) => item.id === id);
      if (!tab || (!discard && dirty(tab))) return false;
      await load(id);
      return true;
    },
  };
}
export type WorkspaceState = ReturnType<typeof createWorkspaceState>;
