import { cleanup, signal, type Signal } from "nsh";
import { AppStore, type RedisSession } from "ferrix/native";
import {
  connectionKeySeparator,
  copyConnection,
  redactConnection,
  emptyDocument,
  newId,
  organizationError,
  type Config,
  type ConnectionDocument,
  type SavedConnection,
  type TagColor,
} from "./connection-model";
import { hubT } from "../../i18n";
import { openConnection } from "./connection-client";
import { safeError } from "../../utils/errors";

type ConnectionStorage = Pick<
  typeof AppStore,
  "loadConnections" | "saveConnections"
>;
export type LiveConnection = {
  id: string;
  name: string;
  session: RedisSession;
  configuration: SavedConnection;
  keySeparator: Signal<string>;
};

function transportOptions(config: Config): string {
  // The store can round-trip object properties in a different order.
  return JSON.stringify(
    { ...config, keySeparator: undefined },
    (_name, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, value[key]]),
          )
        : value,
  );
}

export function createConnectionHub(store: ConnectionStorage = AppStore) {
  const data = signal<ConnectionDocument>(emptyDocument()),
    loading = signal(true),
    saving = signal(false),
    error = signal<unknown>("");
  const live = signal<LiveConnection[]>([]),
    connecting = signal<string[]>([]),
    activeId = signal<string>();
  const ready = signal(false);
  let credentialEpoch = 0;
  let disposed = false,
    queue: Promise<unknown> = Promise.resolve();
  cleanup(() => {
    disposed = true;
    for (const item of live()) {
      item.session.close();
      item.session.dispose();
    }
  });
  function applyDocument(next: ConnectionDocument) {
    // Older saved connections may still include the retired flag.
    for (const { config } of next.connections)
      delete (config as Config & { production?: boolean }).production;
    data.set(next);
    const current = live();
    if (!current.length) return;
    const saved = new Map(next.connections.map((item) => [item.id, item.config]));
    for (const item of current) {
      const config = saved.get(item.id);
      if (config) item.keySeparator.set(connectionKeySeparator(config));
    }
  }
  function reload(): Promise<void> {
    const result = queue.then(async () => {
      loading.set(true);
      error.set("");
      ready.set(false);
      try {
        const result = await store.loadConnections();
        if (!disposed) {
          applyDocument(JSON.parse(result));
          ready.set(true);
        }
      } catch (cause) {
        if (!disposed) error.set(cause);
      } finally {
        if (!disposed) loading.set(false);
      }
    });
    queue = result;
    return result;
  }
  function mutate(
    change: (draft: ConnectionDocument) => void,
  ): Promise<boolean> {
    const result = queue.then(async () => {
      if (disposed) return false;
      if (loading() || !ready()) {
        error.set(hubT("reloadRequired"));
        return false;
      }
      saving.set(true);
      error.set("");
      try {
        const next: ConnectionDocument = JSON.parse(JSON.stringify(data()));
        change(next);
        const saved = await store.saveConnections(JSON.stringify(next));
        if (!disposed) applyDocument(JSON.parse(saved));
        return true;
      } catch (cause) {
        if ((cause as { code?: string })?.code === "STORE_CONFLICT")
          ready.set(false);
        if (!disposed)
          error.set(
            cause instanceof Error && cause.message.startsWith("FORM:")
              ? cause.message.slice(5)
              : cause,
          );
        return false;
      } finally {
        if (!disposed) saving.set(false);
      }
    });
    queue = result;
    return result;
  }
  async function createOrganization(
    kind: "group" | "tag",
    name: string,
    color: TagColor = "coral",
  ) {
    const id = newId();
    const ok = await mutate((d) => {
      const items = kind === "group" ? d.groups : d.tags,
        issue = organizationError(name, items);
      if (issue) throw new Error(`FORM:${issue}`);
      if (kind === "group") d.groups.push({ id, name: name.trim() });
      else d.tags.push({ id, name: name.trim(), color });
    });
    return ok ? id : undefined;
  }
  async function connect(
    value: SavedConnection,
    stillWanted = () => true,
  ): Promise<boolean> {
    if (!ready()) {
      error.set(hubT("reloadRequired"));
      return false;
    }
    const epoch = credentialEpoch;
    const configuration = copyConnection(value);
    const existing = live().find((item) => item.id === value.id);
    if (
      existing &&
      transportOptions(existing.configuration.config) ===
        transportOptions(configuration.config)
    ) {
      activeId.set(existing.id);
      return true;
    }
    if (connecting().includes(value.id)) return false;
    connecting.set([...connecting(), value.id]);
    error.set("");
    let session: RedisSession | undefined;
    try {
      session = await openConnection(value.config);
      await session.ping();
      if (disposed || epoch !== credentialEpoch || !stillWanted()) {
        session.close();
        session.dispose();
        return false;
      }
      if (existing) {
        existing.session.close();
        existing.session.dispose();
      }
      const saved = data().connections.find((item) => item.id === value.id);
      live.set([
        ...live().filter((item) => item.id !== value.id),
        {
          id: value.id,
          name: value.name,
          session,
          configuration,
          keySeparator: signal(
            connectionKeySeparator(saved?.config ?? configuration.config),
          ),
        },
      ]);
      activeId.set(value.id);
      return true;
    } catch (cause) {
      if (session) {
        session.close();
        session.dispose();
      }
      if (!disposed && stillWanted()) error.set(cause);
      return false;
    } finally {
      if (!disposed)
        connecting.set(connecting().filter((id) => id !== value.id));
    }
  }
  function disconnect(id: string) {
    const item = live().find((v) => v.id === id);
    if (!item) return;
    item.session.close();
    item.session.dispose();
    live.set(live().filter((v) => v.id !== id));
    if (activeId() === id) activeId.set(live()[0]?.id);
  }
  void reload();
  return {
    data,
    loading,
    saving,
    error: () =>
      typeof error() === "string"
        ? (error() as string)
        : error()
          ? safeError(error())
          : "",
    live,
    connecting,
    activeId,
    reload,
    mutate,
    createOrganization,
    connect,
    disconnect,
    credentialsChanged: async () => {
      ++credentialEpoch;
      data.set(emptyDocument());
      ready.set(false);
      live.set(
        live().map((item) => ({
          ...item,
          configuration: redactConnection(item.configuration),
        })),
      );
      await reload();
    },
    save: (value: SavedConnection) =>
      mutate((d) => {
        const normalized = {
          ...copyConnection(value),
          name: value.name.trim(),
        };
        const index = d.connections.findIndex((c) => c.id === value.id);
        if (index < 0) d.connections.push(normalized);
        else d.connections[index] = normalized;
      }),
    update: (id: string, change: Partial<SavedConnection>) =>
      mutate((d) => {
        const item = d.connections.find((c) => c.id === id);
        if (item) Object.assign(item, change);
      }),
    toggleFavorite: (id: string) =>
      mutate((d) => {
        const item = d.connections.find((c) => c.id === id);
        if (item) item.favorite = !item.favorite;
      }),
    remove: (id: string) =>
      mutate((d) => {
        d.connections = d.connections.filter((c) => c.id !== id);
      }),
    available: ready,
    clearError: () => {
      if (ready()) error.set("");
    },
  };
}
export type ConnectionHub = ReturnType<typeof createConnectionHub>;
