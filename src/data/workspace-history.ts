import { signal, Storage } from "nsh";

export type WorkspaceSnapshot = {
  database: number;
  tabs: string[];
  selected?: string;
  command: string;
  consoleDatabase?: number;
  terminal: boolean;
};

type History = {
  lastConnection?: string;
  workspaces: [string, WorkspaceSnapshot][];
};

const storageKey = "ferrix.workspace-history";
const maxWorkspaces = 16;
const maxTabs = 32;
const maxKeyLength = 4096;
const maxCommandLength = 65536;
const validKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= maxKeyLength &&
  value.length % 2 === 0 &&
  /^[0-9a-f]*$/.test(value);

function snapshot(value: Partial<WorkspaceSnapshot>): WorkspaceSnapshot | undefined {
  const { database, tabs, selected, command, consoleDatabase, terminal } = value;
  if (
    typeof database !== "number" ||
    !Number.isInteger(database) ||
    database < 0 || database > 2147483647 ||
    !Array.isArray(tabs)
  ) return;
  const keys = [...new Set(tabs.filter(validKey))].slice(-maxTabs);
  if (validKey(selected) && tabs.includes(selected) && !keys.includes(selected))
    keys.unshift(selected);
  return {
    database,
    tabs: keys,
    selected: keys.includes(selected ?? "!") ? selected : undefined,
    command: typeof command === "string" && command.length <= maxCommandLength
      ? command
      : "",
    consoleDatabase: typeof consoleDatabase === "number" && Number.isInteger(consoleDatabase) &&
      consoleDatabase >= 0 && consoleDatabase <= 2147483647 ? consoleDatabase : undefined,
    terminal: terminal === true,
  };
}

export function createWorkspaceHistory(onError: () => void) {
  const ready = signal(false);
  let history: History = { workspaces: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saved = "";
  let write: Promise<void> = Promise.resolve();
  let errorReported = false;

  async function load() {
    try {
      const text = await Storage.getItem(storageKey);
      if (!text) return;
      const document: Partial<History> = JSON.parse(text);
      const workspaces: History["workspaces"] = [];
      if (Array.isArray(document.workspaces)) {
        for (const entry of document.workspaces.slice(0, maxWorkspaces)) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
          const restored = snapshot(entry[1]);
          if (restored) workspaces.push([entry[0], restored]);
        }
      }
      history = {
        lastConnection: typeof document.lastConnection === "string"
          ? document.lastConnection
          : undefined,
        workspaces,
      };
      saved = JSON.stringify(history);
    } catch {
      onError();
    } finally {
      ready.set(true);
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!ready()) return write;
    write = write.then(async () => {
      const text = JSON.stringify(history);
      if (saved === text) return;
      try {
        await Storage.setItem(storageKey, text);
        saved = text;
        errorReported = false;
      } catch {
        if (!errorReported) onError();
        errorReported = true;
      }
    });
    return write;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 200);
  }

  void load();
  return {
    ready,
    flush,
    lastConnection: () => history.lastConnection,
    setLastConnection(id?: string) {
      if (!ready() || history.lastConnection === id) return;
      history.lastConnection = id;
      schedule();
    },
    get: (id: string) => history.workspaces.find(([key]) => key === id)?.[1],
    save(id: string, value: WorkspaceSnapshot) {
      if (!ready()) return;
      const next = snapshot(value);
      if (!next) return;
      const current = history.workspaces.find(([key]) => key === id)?.[1];
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      const recent = history.workspaces.filter(([key]) => key !== id);
      recent.unshift([id, next]);
      history.workspaces = recent.slice(0, maxWorkspaces);
      while (JSON.stringify(history.workspaces).length > 1024 * 1024)
        history.workspaces.pop();
      schedule();
    },
    clearWorkspaces() {
      if (!ready() || !history.workspaces.length) return;
      history.workspaces = [];
      void flush();
    },
  };
}

export type WorkspaceHistory = ReturnType<typeof createWorkspaceHistory>;
