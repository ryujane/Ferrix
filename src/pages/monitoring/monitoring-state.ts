import { cleanup, effect, signal } from "nsh";
import type { RedisServerMetrics, RedisSession } from "ferrix/native";
import { safeError } from "../../utils/errors";
import type { DatabaseAnalysisSession } from "./database-analysis";
import {
  appendHistory,
  commandId,
  commandRates,
  defaultCommands,
  identity,
  sample,
  type MetricGroup,
  type Sample,
} from "./monitoring-values";

export type MonitoringSession = DatabaseAnalysisSession &
  Pick<RedisSession, "readServerMetrics" | "readClients" | "getInfo">;

export function createMonitoringState(
  session: MonitoringSession,
  active: () => boolean,
) {
  const snapshot = signal<RedisServerMetrics>(),
    history = signal<Sample[]>([]);
  const interval = signal(5000),
    window = signal(900),
    paused = signal(false),
    busy = signal(false),
    error = signal("");
  const group = signal<MetricGroup>("commands"),
    commands = signal<string[]>([]),
    showTotal = signal(true),
    rates = signal<Record<string, number>>({});
  let previous: RedisServerMetrics | undefined,
    pending: Promise<void> | undefined,
    disposed = false,
    revision = 0;
  let selected = false;
  cleanup(() => {
    disposed = true;
    revision++;
  });

  function selectCommands(next: string[]) {
    const retained = new Set(next.map(commandId));
    const keep = (name: string) =>
      !name.startsWith("command:") || retained.has(name);
    history.set(
      history().map((point) => ({
        ...point,
        values: Object.fromEntries(
          Object.entries(point.values).filter(([name]) => keep(name)),
        ),
        weights: point.weights
          ? Object.fromEntries(
              Object.entries(point.weights).filter(([name]) => keep(name)),
            )
          : undefined,
      })),
    );
    commands.set(next);
  }

  function refresh(): Promise<void> {
    if (pending) return pending;
    if (disposed || !active()) return Promise.resolve();
    const request = revision;
    busy.set(true);
    pending = (async () => {
      await Promise.resolve();
      try {
        const next = await session.readServerMetrics();
        if (disposed || request !== revision || !active()) return;
        const last = snapshot();
        const changed = last && identity(last) !== identity(next);
        if (!selected && next.commands.length) {
          const defaults = defaultCommands(next);
          if (defaults.join("\0") !== commands().join("\0"))
            selectCommands(defaults);
        }
        const baseline = changed ? undefined : previous;
        const point = sample(next, baseline, commands());
        if (!Number.isFinite(point.at))
          throw new Error("Invalid monitoring timestamp");
        history.set(appendHistory(changed ? [] : history(), point));
        rates.set(commandRates(next, baseline));
        previous = next;
        snapshot.set(next);
        error.set("");
      } catch (cause) {
        if (!disposed && request === revision && active()) {
          error.set(safeError(cause));
          previous = undefined;
          rates.set({});
        }
      } finally {
        pending = undefined;
        if (!disposed) busy.set(false);
      }
    })();
    return pending;
  }

  effect(() => {
    const enabled = active() && !paused(),
      delay = interval();
    revision++;
    previous = undefined;
    if (!enabled) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      await refresh();
      if (!stopped && !disposed) timer = setTimeout(() => void tick(), delay);
    }
    void tick();
    return () => {
      stopped = true;
      revision++;
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  function report(name: string) {
    return JSON.stringify(
      {
        format: "ferrix-health-report",
        version: 2,
        connection: name,
        exportedAt: new Date().toISOString(),
        intervalMs: interval(),
        windowSeconds: window(),
        metricGroup: group(),
        commandSeries: commands(),
        showTotal: showTotal(),
        snapshot: snapshot() ?? null,
        history: history(),
      },
      null,
      2,
    );
  }
  function toggleCommand(name: string) {
    const current = commands();
    if (!current.includes(name) && current.length >= 6) return;
    const next = current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name];
    selected = true;
    selectCommands(next);
    if (!next.length) showTotal.set(true);
  }
  return {
    snapshot,
    history,
    interval,
    window,
    paused,
    busy,
    error,
    group,
    commands,
    showTotal,
    rates,
    toggleCommand,
    refresh,
    report,
  };
}
export type MonitoringState = ReturnType<typeof createMonitoringState>;
