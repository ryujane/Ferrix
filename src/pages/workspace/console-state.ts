import { cleanup, signal } from "nsh";
import type { RedisConsole } from "ferrix/native";
import { safeError } from "../../utils/errors";
import {
  consoleCommand,
  consoleDisplayCommand,
  fallbackCommands,
  parseConsoleCommand,
  privateCommand,
  type ConsoleCommand,
} from "./console-values";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

type HistoryRow = {
  id: number;
  command: string;
  output: string;
  failed: boolean;
  database: number;
  endpoint?: string;
};
const locals: ConsoleCommand[] = [
  { name: "CLEAR", arguments: [] },
  { name: "HELP", arguments: [] },
];
export function createConsoleState(state: WorkspaceState) {
  const input = signal(""),
    busy = signal(false),
    stopping = signal(false),
    history = signal<HistoryRow[]>([]);
  const connection = signal<RedisConsole>(),
    database = signal(state.database()),
    restoredDatabase = signal<number>(),
    endpoint = signal("");
  const targetDatabase = () => connection() ? database() : restoredDatabase() ?? state.database();
  const streaming = signal(false),
    monitoring = signal(false),
    commands = signal<ConsoleCommand[]>([...fallbackCommands, ...locals]);
  const catalogSource = signal<"loading" | "server" | "fallback">("loading");
  const descriptionStatus = signal<
    Record<string, "loading" | "ready" | "unavailable">
  >({});
  let disposed = false,
    sequence = 0,
    opening: Promise<RedisConsole> | undefined,
    catalogPending: Promise<void> | undefined;
  let loadedGeneration = "",
    past: string[] = [],
    historyAt = -1,
    draft = "",
    dropped = "0";
  const descriptions = new Set<string>();
  cleanup(() => {
    disposed = true;
    connection()?.close();
    connection()?.dispose();
  });
  function append(row: Omit<HistoryRow, "id">) {
    if (disposed) return;
    const next = [
      ...history(),
      { ...row, endpoint: endpoint(), id: ++sequence },
    ].slice(-100);
    let bytes = next.reduce(
      (n, row) => n + row.command.length * 2 + row.output.length * 2,
      0,
    );
    while (bytes > 1024 * 1024 && next.length > 1) {
      const old = next.shift()!;
      bytes -= (old.command.length + old.output.length) * 2;
    }
    if (next.length && bytes > 1024 * 1024)
      next[0].output =
        next[0].output.slice(0, Math.max(0, 524200 - next[0].command.length)) +
        "\n" +
        w("consoleOutputLimit");
    history.set(next);
  }
  async function loadCatalog(force = false) {
    const generation = state.session.getInfo().generation;
    if (catalogPending || (!force && loadedGeneration === generation))
      return catalogPending;
    catalogSource.set("loading");
    catalogPending = (async () => {
      try {
        const result = await state.session.readConsoleCommands(null);
        if (disposed) return;
        const fallback = new Map(
          fallbackCommands.map((command) => [command.name, command]),
        );
        if (!result.commands.length) throw new Error("Empty command catalog");
        const resolved: ConsoleCommand[] = result.commands.map((command) => ({
          name: command.name,
          arguments: fallback.get(command.name)?.arguments,
        }));
        if (!resolved.some((command) => command.name.includes(" "))) {
          // Older COMMAND replies expose only containers; retain their bundled subcommand schemas.
          const roots = new Set(resolved.map((command) => command.name));
          resolved.push(
            ...fallbackCommands.filter(
              (command) =>
                command.name.includes(" ") &&
                roots.has(command.name.split(" ")[0]),
            ),
          );
        }
        commands.set([...resolved, ...locals]);
        descriptions.clear();
        descriptionStatus.set({});
        catalogSource.set("server");
      } catch {
        if (!disposed) {
          commands.set([...fallbackCommands, ...locals]);
          catalogSource.set("fallback");
        }
      } finally {
        loadedGeneration = generation;
        catalogPending = undefined;
      }
    })();
    return catalogPending;
  }
  async function describe(value: string) {
    const command = consoleCommand(value, commands());
    if (
      !command ||
      locals.some((local) => local.name === command.name) ||
      descriptions.has(command.name)
    )
      return;
    descriptions.add(command.name);
    descriptionStatus.set({
      ...descriptionStatus(),
      [command.name]: "loading",
    });
    try {
      const result = await state.session.readConsoleCommands(command.name);
      if (disposed) return;
      const docs = new Map(result.commands.map((item) => [item.name, item]));
      commands.set(
        commands().map((item) => {
          const doc = docs.get(item.name);
          if (!doc) return item;
          return {
            ...item,
            summary: doc.summary ?? undefined,
            arguments: doc.argumentsJson
              ? JSON.parse(doc.argumentsJson)
              : item.arguments,
          };
        }),
      );
      descriptionStatus.set({
        ...descriptionStatus(),
        [command.name]: docs.get(command.name)?.argumentsJson
          ? "ready"
          : "unavailable",
      });
    } catch {
      if (!disposed)
        descriptionStatus.set({
          ...descriptionStatus(),
          [command.name]: "unavailable",
        });
    }
  }
  async function connect() {
    const current = connection();
    if (current) return current;
    if (!opening) opening = state.session.openConsole(restoredDatabase());
    try {
      const next = await opening;
      if (disposed) {
        next.close();
        next.dispose();
        throw new Error("Console disposed");
      }
      connection.set(next);
      const info = next.drain();
      database.set(info.database);
      restoredDatabase.set(undefined);
      endpoint.set(info.endpoint);
      dropped = info.dropped;
      return next;
    } finally {
      opening = undefined;
    }
  }
  function drain() {
    const handle = connection();
    if (!handle || disposed) return;
    const batch = handle.drain();
    database.set(batch.database);
    endpoint.set(batch.endpoint);
    streaming.set(batch.streaming && !batch.closed);
    monitoring.set(batch.monitoring && !batch.closed);
    for (const output of batch.output)
      append({ command: "", output, failed: false, database: batch.database });
    if (batch.dropped !== dropped) {
      dropped = batch.dropped;
      append({
        command: "",
        output: w("consoleDropped", { count: dropped }),
        failed: true,
        database: batch.database,
      });
    }
    if (batch.closed && !busy() && !stopping()) {
      if (batch.errorCode)
        append({
          command: "",
          output: consoleError({ code: batch.errorCode }),
          failed: true,
          database: batch.database,
        });
      handle.dispose();
      connection.set(undefined);
    }
  }
  async function execute() {
    if (
      busy() ||
      stopping() ||
      monitoring() ||
      state.switching() ||
      !input().trim()
    )
      return;
    const command = input(),
      display = consoleDisplayCommand(command);
    let args: Uint8Array[];
    try {
      args = parseConsoleCommand(command);
    } catch {
      append({
        command: display,
        output: w("commandQuotes"),
        failed: true,
        database: database(),
      });
      return;
    }
    if (!args.length) return;
    const verb = new TextDecoder().decode(args[0]).toUpperCase();
    input.set("");
    historyAt = -1;
    const secret = privateCommand(command);
    if (!secret) {
      past = [...past.filter((item) => item !== command), command].slice(-100);
      while (past.reduce((n, item) => n + item.length, 0) > 131072)
        past.shift();
    }
    if (verb === "CLEAR" && args.length === 1) {
      history.set([]);
      return;
    }
    if (verb === "HELP" && args.length === 1) {
      append({
        command,
        output: w("consoleHelp"),
        failed: false,
        database: database(),
      });
      return;
    }
    busy.set(true);
    let fromDatabase = database();
    try {
      const handle = await connect();
      fromDatabase = database();
      if (stopping() || disposed) return;
      const result = await handle.execute(args);
      if (disposed) return;
      database.set(result.database);
      streaming.set(result.streaming && !result.closed);
      monitoring.set(result.monitoring && !result.closed);
      append({
        command: display,
        output: result.output,
        failed: result.failed,
        database: fromDatabase,
      });
      if (!result.failed && verb === "MODULE") void loadCatalog(true);
      if (result.closed) {
        await handle.closeAndWait();
        handle.dispose();
        connection.set(undefined);
      }
    } catch (cause) {
      if (!disposed) {
        append({
          command: display,
          output: consoleError(cause),
          failed: true,
          database: fromDatabase,
        });
        streaming.set(false);
      }
    } finally {
      if (!disposed) {
        busy.set(false);
        drain();
      }
    }
  }
  async function stop() {
    if (stopping()) return;
    const wasBusy = busy();
    stopping.set(true);
    try {
      const current = connection() ?? (await opening);
      if (current) {
        await current.closeAndWait();
        if (connection() === current) connection.set(undefined);
        current.dispose();
      }
      if (!wasBusy)
        append({
          command: "",
          output: w("consoleStopped"),
          failed: false,
          database: database(),
        });
    } catch {
      /* A setup failure is reported by the command that initiated it. */
    } finally {
      if (!disposed) {
        streaming.set(false);
        monitoring.set(false);
        stopping.set(false);
      }
    }
  }
  function recall(direction: -1 | 1) {
    if (!past.length || busy()) return;
    if (historyAt === -1) {
      if (direction === 1) return;
      draft = input();
      historyAt = past.length;
    }
    historyAt = Math.max(0, Math.min(past.length, historyAt + direction));
    input.set(historyAt === past.length ? draft : past[historyAt]);
  }
  return {
    input,
    busy,
    stopping,
    history,
    connection,
    database,
    targetDatabase,
    restoreDraft(command: string, database: number) {
      if (!command || privateCommand(command) || input()) return;
      restoredDatabase.set(database);
      input.set(command);
    },
    endpoint,
    streaming,
    monitoring,
    commands,
    catalogSource,
    descriptionStatus,
    execute,
    stop,
    drain,
    loadCatalog,
    describe,
    recall,
  };
}
export type ConsoleState = ReturnType<typeof createConsoleState>;
function consoleError(cause: unknown): string {
  const code = (cause as { code?: string })?.code;
  if (code === "WRITE_OUTCOME_UNKNOWN") return w("consoleOutcomeUnknown");
  if (code === "PAYLOAD_TOO_LARGE") return w("consoleReplyLimit");
  if (code === "SESSION_CLOSED") return w("consoleConnectionClosed");
  return safeError(cause);
}
