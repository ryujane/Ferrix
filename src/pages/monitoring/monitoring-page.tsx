import {
  computed,
  effect,
  List,
  Scroll,
  signal,
  Text,
  token,
  View,
  windowSize,
  type JSX,
} from "nsh";
import { Button, Input, Select } from "nsh/base";
import { Area, Grid, Line, Pie, Plot, PlotAxis } from "nsh/base/plot";
import { Redis, type RedisServerMetrics } from "ferrix/native";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon, type IconName } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import type {
  ConnectionHub,
  LiveConnection,
} from "../../data/connections/connection-state";
import { address, endpoints } from "../../data/connections/connection-model";
import { safeError } from "../../utils/errors";
import { ClientsDialog } from "./clients-dialog";
import { AnalysisDialog } from "./analysis-dialog";
import {
  createMonitoringState,
  type MonitoringSession,
  type MonitoringState,
} from "./monitoring-state";
import {
  averageLatency,
  bytes,
  commandId,
  count,
  curves,
  decimal,
  duration,
  field,
  formatMetric,
  hasMetric,
  hitRatio,
  latency,
  m,
  memoryParts,
  metric,
  metricGroups,
  metricUnit,
  plotSamples,
  shortCount,
  time,
  type MetricColor,
  type Sample,
} from "./monitoring-values";

type MonitoringHub = {
  live: () => (Pick<LiveConnection, "id" | "name" | "configuration"> & {
    session: MonitoringSession;
  })[];
  activeId: ConnectionHub["activeId"];
};

export function MonitoringPage(props: {
  hub: MonitoringHub;
  active: boolean;
  onConnections: () => void;
  onOpenKey?: (connectionId: string, database: number, key: Uint8Array) => void;
}) {
  return (
    <View testID="monitoring-page" class="flex-1 min-w-0 min-h-0 bg-workspace">
      {!props.hub.live().length ? (
        <View class="flex-1 items-center justify-center gap-4 p-6">
          <Icon name="chart" size={40} />
          <Text class="text-(--text-size-18)/(--line-height-28) text-foreground">{m("noSession")}</Text>
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
            {m("noSessionHint")}
          </Text>
          <Action
            testID="monitoring-connect"
            label={m("connections")}
            primary
            onPress={props.onConnections}
          />
        </View>
      ) : (
        <Each of={props.hub.live()} key={(live) => live.session}>
          {(live) => (
            <View
              class={`flex-1 min-w-0 min-h-0 ${props.hub.activeId() === live().id ? "flex" : "hidden"}`}
            >
              <MonitoringPanel
                session={live().session}
                name={live().name}
                endpoint={endpoints(live().configuration.config)
                  .map(address)
                  .join(", ")}
                active={props.active && props.hub.activeId() === live().id}
                onOpenKey={
                  props.onOpenKey
                    ? (database, key) =>
                        props.onOpenKey?.(live().id, database, key)
                    : undefined
                }
                connectionControl={
                  <Select
                    accessibilityLabel={m("connection")}
                    value={props.hub.activeId()}
                    items={props.hub
                      .live()
                      .map((item) => ({ value: item.id, title: item.name }))}
                    onChange={({ value }) => {
                      if (value) props.hub.activeId.set(value);
                    }}
                    trigger={
                      <View
                        testID="monitoring-connection"
                        class="h-8 w-52 flex-row items-center gap-2 px-2 rounded bg-inset hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring"
                      >
                        <Text
                          class="flex-1 min-w-0 text-(--text-size-12)/(--line-height-16) font-mono text-foreground"
                          style={{ numberOfLines: 1 }}
                        >
                          {live().name}
                        </Text>
                        <Icon name="down" size={12} />
                      </View>
                    }
                    popupClass="bg-popover border border-border rounded p-1"
                    itemClass="px-3 py-2 text-(--text-size-12)/(--line-height-16) text-popover-foreground rounded focus:bg-accent selected:bg-accent"
                  />
                }
              />
            </View>
          )}
        </Each>
      )}
    </View>
  );
}

export function MonitoringPanel(props: {
  session: MonitoringSession;
  name: string;
  endpoint: string;
  active: boolean;
  onOpenKey?: (database: number, key: Uint8Array) => void;
  connectionControl?: JSX.Element;
  exportReport?: (content: string) => Promise<string | null>;
}) {
  const state = createMonitoringState(props.session, () => props.active);
  const settings = signal(false),
    clientsOpen = signal(false),
    analysisOpen = signal(false),
    exporting = signal(false),
    saved = signal(false),
    exportError = signal("");
  const commandFilter = signal("");
  effect(() => {
    if (!props.active) {
      clientsOpen.set(false);
      analysisOpen.set(false);
    }
  });
  const observedCommands = computed(
    () => new Set(state.snapshot()?.commands.map((item) => item.name) ?? []),
  );
  const commandOptions = computed(() =>
    [...new Set([...observedCommands(), ...state.commands()])]
      .filter((name) =>
        name
          .toLocaleLowerCase()
          .includes(commandFilter().trim().toLocaleLowerCase()),
      )
      .sort((a, b) => a.localeCompare(b)),
  );
  const wide = () => windowSize().width >= 1160;
  async function exportReport() {
    if (exporting() || !state.snapshot()) return;
    exporting.set(true);
    saved.set(false);
    exportError.set("");
    try {
      if (
        await (props.exportReport ?? Redis.exportMetricsReport)(
          state.report(props.name),
        )
      )
        saved.set(true);
    } catch (cause) {
      exportError.set(safeError(cause));
    } finally {
      exporting.set(false);
    }
  }
  return (
    <View testID="monitoring-panel" class="flex-1 min-w-0 min-h-0 bg-workspace">
      <View class="shrink-0 flex-row flex-wrap items-center gap-2 px-3 py-2 border-b border-border/40">
        <Icon name="network" color={token("code-string")} />
        {props.connectionControl ?? (
          <Text class="text-(--text-size-12)/(--line-height-16) font-mono font-semibold text-foreground">
            {props.name}
          </Text>
        )}
        {windowSize().width >= 760 && (
          <Badge
            label={field(state.snapshot(), "role")?.toUpperCase() ?? "REDIS"}
          />
        )}
        <View class="flex-row items-center gap-1.5 px-2 h-8">
          <Dot
            color={token(
              state.error()
                ? "destructive"
                : state.paused()
                  ? "faint"
                  : "success",
            )}
          />
          <Text
            testID="monitoring-status"
            class={`text-(--text-size-11) font-mono ${state.error() ? "text-destructive" : state.paused() ? "text-muted-foreground" : "text-success"}`}
          >
            {m(
              state.error()
                ? "stale"
                : state.paused()
                  ? "paused"
                  : state.snapshot()
                    ? "live"
                    : "loading",
            )}
          </Text>
          {state.snapshot() && windowSize().width >= 960 && (
            <Text class="text-(--text-size-10) font-mono text-muted-foreground">
              {m("collectionTime")} {decimal(state.snapshot()!.collectionMs, 0)}{" "}
              ms
            </Text>
          )}
        </View>
        <View class="flex-1" />
        <View class="flex-row items-center gap-0.5 bg-inset p-0.5 rounded">
          <Text class="px-1 text-(--text-size-10) font-mono text-muted-foreground">
            {m("poll")}
          </Text>
          {[1000, 5000, 10000].map((value) => (
            <Action
              testID={`monitoring-interval-${value}`}
              label={`${value / 1000}s`}
              compact
              selected={state.interval() === value}
              onPress={() => state.interval.set(value)}
            />
          ))}
          <IconButton
            testID="monitoring-pause"
            label={m(state.paused() ? "resume" : "pause")}
            icon={state.paused() ? "play" : "pause"}
            onPress={() => state.paused.set(!state.paused())}
          />
        </View>
        <View class="flex-row gap-0.5 bg-inset p-0.5 rounded">
          {[
            { seconds: 900, label: "15m" },
            { seconds: 3600, label: "1h" },
            { seconds: 21600, label: "6h" },
            { seconds: 86400, label: "24h" },
          ].map((value) => (
            <Action
              testID={`monitoring-window-${value.seconds}`}
              label={value.label}
              compact
              selected={state.window() === value.seconds}
              onPress={() => state.window.set(value.seconds)}
            />
          ))}
        </View>
        <IconButton
          testID="monitoring-refresh"
          label={m("refresh")}
          icon="refresh"
          disabled={state.busy()}
          onPress={() => void state.refresh()}
        />
        <View class="shrink-0 flex-row items-center gap-0.5">
          <Action
            testID="monitoring-config"
            label={m("configure")}
            icon="sliders"
            compact
            selected={settings()}
            onPress={() => settings.set(!settings())}
          />
          <Action
            testID="monitoring-analysis"
            label={m("analysisTitle")}
            icon="chart"
            compact
            onPress={() => analysisOpen.set(true)}
          />
        </View>
        <Action
          testID="monitoring-export"
          label={m(exporting() ? "exporting" : "export")}
          icon="download"
          primary
          compact
          disabled={exporting() || !state.snapshot()}
          onPress={() => void exportReport()}
        />
      </View>
      {settings() && (
        <View
          testID="monitoring-settings"
          class="shrink-0 px-4 py-3 gap-2 border-b border-border/40"
        >
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
              {m("commandSeries")}
            </Text>
            <Action
              testID="monitoring-series-total"
              label={m("totalQps")}
              compact
              selected={state.showTotal()}
              disabled={!state.commands().length}
              onPress={() => state.showTotal.set(!state.showTotal())}
            />
            <Text class="text-(--text-size-10) text-muted-foreground">
              {m("commandSelectionHint", { count: state.commands().length })}
            </Text>
            <View class="flex-1" />
            <Input
              testID="monitoring-command-filter"
              accessibilityLabel={m("filterCommands")}
              value={commandFilter()}
              onChange={({ value }) => commandFilter.set(value)}
              placeholder={m("filterCommands")}
              class="h-7 w-52 px-2 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-inset rounded focus:ring-1 focus:ring-ring"
            />
          </View>
          <Scroll class="max-h-20" contentClass="flex-row flex-wrap gap-1">
            <Each of={commandOptions()} key={(name) => name}>
              {(name) => (
                <Action
                  testID={`monitoring-command-${name()}`}
                  label={
                    observedCommands().has(name())
                      ? name()
                      : `${name()} (${m("noCurrentStats")})`
                  }
                  compact
                  selected={state.commands().includes(name())}
                  disabled={
                    state.commands().length >= 6 &&
                    !state.commands().includes(name())
                  }
                  onPress={() => state.toggleCommand(name())}
                />
              )}
            </Each>
          </Scroll>
          {!commandOptions().length && (
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {m(
                state.snapshot()?.commands.length
                  ? "noMatchingCommands"
                  : "noCommands",
              )}
            </Text>
          )}
          <Text class="text-(--text-size-11) text-muted-foreground">
            {m("historyHint")}
          </Text>
        </View>
      )}
      {(!!state.error() || !!exportError() || saved()) && (
        <View
          role="alert"
          class="shrink-0 px-4 py-2 gap-1 border-b border-border/30"
        >
          <Text
            testID="monitoring-feedback"
            class={`text-(--text-size-12)/(--line-height-16) ${state.error() || exportError() ? "text-destructive" : "text-success"}`}
          >
            {state.error()
              ? `${m("refreshFailed")} ${state.error()}`
              : exportError() || m("exported")}
          </Text>
        </View>
      )}
      <Scroll
        testID="monitoring-scroll"
        class="flex-1 min-h-0"
        contentClass="p-3 gap-2"
      >
        <View class="flex-row flex-wrap items-center gap-2 px-1 pb-1">
          <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
            {m("title")}
          </Text>
          <Text class="text-(--text-size-10) font-mono text-muted-foreground">
            {state.snapshot()?.nodeAddress ?? props.endpoint}
          </Text>
          <View class="flex-1" />
          <Text
            testID="monitoring-scope"
            class="text-(--text-size-10) text-muted-foreground"
          >
            {m(
              !state.snapshot()
                ? "loading"
                : state.snapshot()!.scope === "node"
                  ? "nodeScope"
                  : "serverScope",
            )}
          </Text>
        </View>
        <Summary state={state} onClients={() => clientsOpen.set(true)} />
        <View class={`min-w-0 gap-2 ${wide() ? "flex-row" : "flex-col"}`}>
          <View class="min-w-0" style={{ flex: wide() ? 2 : undefined }}>
            <Trends state={state} />
          </View>
          <View class="min-w-0" style={{ flex: wide() ? 1 : undefined }}>
            <Memory snapshot={state.snapshot()} />
          </View>
        </View>
        <View class={`min-w-0 gap-2 ${wide() ? "flex-row" : "flex-col"}`}>
          <View class="min-w-0" style={{ flex: wide() ? 1.4 : undefined }}>
            <Commands state={state} />
          </View>
          <View class="min-w-0 gap-2" style={{ flex: wide() ? 1 : undefined }}>
            <Persistence snapshot={state.snapshot()} />
            <Replication snapshot={state.snapshot()} />
          </View>
        </View>
      </Scroll>
      <If when={analysisOpen() && props.active}>
        <AnalysisDialog
          session={props.session}
          name={props.name}
          endpoint={props.endpoint}
          onClose={() => analysisOpen.set(false)}
          onOpenKey={props.onOpenKey}
        />
      </If>
      <If when={clientsOpen() && props.active}>
        <ClientsDialog
          session={props.session}
          name={props.name}
          endpoint={props.endpoint}
          onClose={() => clientsOpen.set(false)}
        />
      </If>
      <View class="shrink-0 flex-row flex-wrap items-center gap-3 px-3 py-1.5 border-t border-border/40">
        <Dot
          color={token(
            state.error()
              ? "destructive"
              : state.paused()
                ? "faint"
                : "success",
          )}
        />
        <Text
          testID="monitoring-sampled-at"
          class="text-(--text-size-10) font-mono text-muted-foreground"
        >
          {m("sampledAt")}{" "}
          {state.snapshot() ? time(Number(state.snapshot()!.sampledAtMs)) : "–"}
        </Text>
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          Redis {field(state.snapshot(), "redis_version") ?? "–"}
        </Text>
        <View class="flex-1" />
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {m("uptime")}{" "}
          {duration(metric(state.snapshot(), "uptime_in_seconds"))}
        </Text>
      </View>
    </View>
  );
}

function Badge(props: { label: string; color?: MetricColor }) {
  return (
    <View class="rounded px-1.5 py-0.5 bg-selected">
      <Text
        class="text-(--text-size-10) font-mono font-semibold"
        style={{ color: token(props.color ?? "success") }}
      >
        {props.label}
      </Text>
    </View>
  );
}
function Heading(props: {
  title: string;
  icon: IconName;
  color?: MetricColor;
  children?: JSX.Element;
}) {
  return (
    <View class="flex-row items-center gap-2">
      <Icon
        name={props.icon}
        size={17}
        color={token(props.color ?? "code-string")}
      />
      <Text class="flex-1 text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}
const card =
  "min-w-0 rounded-lg bg-monitoring-card border border-border/25 p-3 gap-2";
const small = "text-(--text-size-10) font-mono text-muted-foreground";
function Summary(props: { state: MonitoringState; onClients: () => void }) {
  const snapshot = () => props.state.snapshot(),
    value = (key: string) => metric(snapshot(), key);
  const allocation = () =>
    value("used_memory") !== undefined && (value("maxmemory") ?? 0) > 0
      ? (value("used_memory")! / value("maxmemory")!) * 100
      : undefined;
  const width = () => (windowSize().width >= 1080 ? "24%" : "48%");
  return (
    <View class="flex-row flex-wrap gap-2">
      <View
        testID="monitoring-memory-card"
        class={card}
        style={{ flexBasis: width(), flexGrow: 1 }}
      >
        <Heading title={m("memoryUsage")} icon="database">
          <Badge
            label={`FRAG ${decimal(value("mem_fragmentation_ratio"), 2)}x`}
            color="steel"
          />
        </Heading>
        <View class="flex-row items-end gap-2 pt-1">
          <Text
            testID="monitoring-memory-value"
            class="text-(--text-size-26) font-mono font-semibold text-foreground"
          >
            {bytes(value("used_memory"))}
          </Text>
        </View>
        <Text class="text-(--text-size-11) font-mono text-code-string">
          {allocation() === undefined
            ? m(value("maxmemory") === 0 ? "unlimited" : "unavailable")
            : `${decimal(allocation())}% ${m("allocated")}`}{" "}
          · {bytes(value("maxmemory"))}
        </Text>
        <View class="flex-row justify-between gap-2">
          <Text class={small}>
            {m("peak")} {bytes(value("used_memory_peak"))}
          </Text>
          <Text class={small}>RSS {bytes(value("used_memory_rss"))}</Text>
        </View>
        <View class="h-1.5 rounded-full bg-selected overflow-hidden">
          <View
            class="h-full rounded-full bg-code-string"
            style={{ width: `${Math.min(100, allocation() ?? 0)}%` }}
          />
        </View>
      </View>
      <View class={card} style={{ flexBasis: width(), flexGrow: 1 }}>
        <Heading title={m("throughput")} icon="zap" color="steel">
          <Badge label="OPS / SEC" color="steel" />
        </Heading>
        <View class="flex-row items-end gap-2 pt-1">
          <Text
            testID="monitoring-throughput-value"
            class="text-(--text-size-26) font-mono font-semibold text-foreground"
          >
            {count(value("instantaneous_ops_per_sec"))}
          </Text>
          <Text class="text-(--text-size-11) font-mono text-muted-foreground pb-1">
            ops/s
          </Text>
        </View>
        <Text
          class={`text-(--text-size-11) font-mono ${averageLatency(snapshot()) === undefined ? "text-muted-foreground" : "text-success"}`}
        >
          {latency(averageLatency(snapshot()))} {m("averageExecution")}
        </Text>
        <View class="flex-1" />
        <View class="flex-row flex-wrap justify-between gap-2 p-2 bg-workspace rounded">
          <Text class={small}>
            ↓{" "}
            {bytes(
              value("instantaneous_input_kbps") === undefined
                ? undefined
                : value("instantaneous_input_kbps")! * 1024,
            )}
            /s
          </Text>
          <Text class={small}>
            ↑{" "}
            {bytes(
              value("instantaneous_output_kbps") === undefined
                ? undefined
                : value("instantaneous_output_kbps")! * 1024,
            )}
            /s
          </Text>
        </View>
      </View>
      <View class={card} style={{ flexBasis: width(), flexGrow: 1 }}>
        <Heading title={m("hitRatio")} icon="chart" color="success">
          <Badge label={m("lifetime")} />
        </Heading>
        <Text
          testID="monitoring-hit-value"
          class={`text-(--text-size-26) font-mono font-semibold pt-1 ${hitRatio(snapshot()) === undefined ? "text-muted-foreground" : "text-success"}`}
        >
          {decimal(hitRatio(snapshot()), 2)}
          {hitRatio(snapshot()) === undefined ? "" : "%"}
        </Text>
        <Text class="text-(--text-size-11) font-mono text-muted-foreground">
          {m("hits")} {count(field(snapshot(), "keyspace_hits"))} ·{" "}
          {m("misses")} {count(field(snapshot(), "keyspace_misses"))}
        </Text>
        <View class="flex-1" />
        <View class="flex-row flex-wrap justify-between gap-2 p-2 bg-workspace rounded">
          <Text class={small}>
            {m("expired")} {count(field(snapshot(), "expired_keys"))}
          </Text>
          <Text class={small}>
            {m("evicted")} {count(field(snapshot(), "evicted_keys"))}
          </Text>
        </View>
      </View>
      <View class={card} style={{ flexBasis: width(), flexGrow: 1 }}>
        <Heading title={m("clientTopology")} icon="network" color="steel">
          <Badge label={m("clients")} color="steel" />
        </Heading>
        <View class="flex-row items-end gap-2 pt-1">
          <Button
            testID="monitoring-clients-open"
            accessibilityLabel={m("viewClients")}
            onPress={props.onClients}
            disabled={!snapshot()}
            class="min-h-10 px-1 -ml-1 rounded hover:bg-selected active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-50"
          >
            <Text
              testID="monitoring-clients-value"
              class="text-(--text-size-26) font-mono font-semibold text-foreground"
            >
              {count(field(snapshot(), "connected_clients"))}
            </Text>
          </Button>
          <Text class="text-(--text-size-11) text-muted-foreground pb-1">
            {m("active")}
          </Text>
        </View>
        <Text class="text-(--text-size-11) font-mono text-muted-foreground">
          {m("maxClients")} {count(field(snapshot(), "maxclients"))}
        </Text>
        <View class="flex-1" />
        <View class="flex-row flex-wrap justify-between gap-2 p-2 bg-workspace rounded">
          <Text class={small}>
            {m("tracking")} {count(field(snapshot(), "tracking_clients"))}
          </Text>
          <Text
            class={`text-(--text-size-10) font-mono ${value("blocked_clients") === undefined ? "text-muted-foreground" : value("blocked_clients") ? "text-code-string" : "text-success"}`}
          >
            {m("blocked")} {count(field(snapshot(), "blocked_clients"))}
          </Text>
        </View>
      </View>
    </View>
  );
}

function Trends(props: { state: MonitoringState }) {
  const hover = signal<number | null>(null);
  const points = computed(() =>
    plotSamples(props.state.history(), props.state.window()),
  );
  const activeCurves = computed(() =>
    curves(
      props.state.group(),
      props.state.commands(),
      props.state.showTotal(),
    ),
  );
  const hovered = computed(() =>
    hover() === null ? undefined : points()[hover()!],
  );
  const maximum = computed(() =>
    props.state.group() === "hitRatio"
      ? 100
      : Math.max(
          props.state.group() === "cpu" ? 100 : 1,
          ...points().flatMap((point) =>
            activeCurves().map((curve) => point.values[curve.id] ?? 0),
          ),
        ) * 1.12,
  );
  // A stable boolean lets <If> retain the native plot across samples.
  const ready = computed(
    () =>
      points().filter((point) =>
        activeCurves().some((curve) => point.values[curve.id] !== undefined),
      ).length >= 2,
  );
  const emptyMessage = () =>
    !props.state.snapshot()
      ? "waitingSamples"
      : !hasMetric(props.state.snapshot(), props.state.group())
        ? "metricUnavailable"
        : props.state.group() === "hitRatio" &&
            hitRatio(props.state.snapshot()) === undefined
          ? "noLookups"
          : "waitingSamples";
  const peak = computed(() => {
    const history = props.state.history(),
      latest = history[history.length - 1]?.at ?? 0;
    const values = history
      .filter((point) => point.at >= latest - props.state.window() * 1000)
      .flatMap((point) => (point.peak === undefined ? [] : [point.peak]));
    return values.length ? Math.max(...values) : undefined;
  });
  return (
    <View testID="monitoring-throughput" class={card}>
      <Heading title={m("metricTrends")} icon="chart">
        <Badge
          label={
            props.state.window() < 3600
              ? "15m"
              : `${props.state.window() / 3600}h`
          }
          color="code-string"
        />
      </Heading>
      <View class="flex-row flex-wrap gap-0.5">
        {metricGroups.map((group) => (
          <Action
            testID={`monitoring-group-${group.id}`}
            label={m(group.label)}
            compact
            selected={props.state.group() === group.id}
            onPress={() => {
              hover.set(null);
              props.state.group.set(group.id);
            }}
          />
        ))}
      </View>
      <View class="flex-row flex-wrap items-center gap-3">
        <Each of={activeCurves()} key={(curve) => curve.id}>
          {(curve) => (
            <View class="flex-row items-center gap-1.5 py-1">
              <Dot color={token(curve().color)} />
              <Text class={small}>{curve().label}</Text>
            </View>
          )}
        </Each>
        <View class="flex-1" />
        <Text testID="monitoring-chart-unit" class={small}>
          {metricUnit(props.state.group())}
        </Text>
      </View>
      <If
        when={ready()}
        else={
          <View
            testID="monitoring-chart-waiting"
            class="h-44 items-center justify-center gap-2 rounded bg-workspace"
          >
            <Icon name="chart" size={26} />
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {m(emptyMessage())}
            </Text>
          </View>
        }
      >
        <Plot
          testID="monitoring-plot"
          data={points()}
          x="at"
          xScale={{ type: "linear" }}
          yScale={{ type: "linear", domain: [0, maximum()] }}
          class="h-44 min-w-0 bg-workspace rounded focus:ring-1 focus:ring-ring"
          accessibilityLabel={`${m("metricTrends")}: ${m(metricGroups.find((group) => group.id === props.state.group())!.label)}`}
          onHoverChange={(event) => hover.set(event.index)}
          crossLineClass="w-px bg-border-strong"
          tooltipPlacement="pointer"
          tooltipOffset={10}
          tooltipContent={
            hovered() && (
              <View
                testID="monitoring-chart-tooltip"
                class="p-2 gap-1 rounded bg-popover border border-border"
              >
                <Text class="text-(--text-size-10) font-mono text-popover-foreground">
                  {time(hovered()!.at)}
                </Text>
                {activeCurves().map((curve) => (
                  <Text
                    class="text-(--text-size-10) font-mono"
                    style={{ color: token(curve.color) }}
                  >
                    {curve.label} ·{" "}
                    {formatMetric(
                      props.state.group(),
                      hovered()?.values[curve.id],
                    )}
                  </Text>
                ))}
              </View>
            )
          }
        >
          <Grid ticks={4} class="stroke-border/35 stroke-1" />
          <Each of={activeCurves()} key={(curve) => curve.id}>
            {(curve) => {
              const id = curve().id;
              return (
                <>
                  <Area
                    y1={(point: Sample) => point.values[id] ?? NaN}
                    y0={0}
                    curve="linear"
                    style={{ fill: token(curve().color), opacity: 0.07 }}
                    hoverDotClass="hidden"
                  />
                  <Line
                    y={(point: Sample) => point.values[id] ?? NaN}
                    curve="linear"
                    style={{ stroke: token(curve().color), strokeWidth: 2 }}
                    hoverDotStyle={{
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: token(curve().color),
                    }}
                  />
                </>
              );
            }}
          </Each>
          <PlotAxis
            placement="left"
            ticks={4}
            labelPlacement="inside"
            format={(value) =>
              value === 0 ? "" : formatMetric(props.state.group(), value, true)
            }
            labelClass="text-(--text-size-9) font-mono text-muted-foreground px-2"
          />
          <PlotAxis
            placement="bottom"
            ticks={4}
            labelPlacement="inside"
            format={(value) => time(value)}
            labelClass="text-(--text-size-9) font-mono text-muted-foreground pb-1"
          />
        </Plot>
      </If>
      <View class="flex-row flex-wrap justify-between gap-2">
        <Text class={small}>{m("localHistory")}</Text>
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {props.state.group() === "commands"
            ? `${m("observedPeak")} ${count(peak())} ops/s`
            : props.state.group() === "cpu"
              ? m("cpuHint")
              : m("sampleCount", { count: points().length })}
        </Text>
      </View>
    </View>
  );
}

function Memory(props: { snapshot?: RedisServerMetrics }) {
  const parts = computed(() => memoryParts(props.snapshot)),
    used = computed(() => metric(props.snapshot, "used_memory"));
  return (
    <View testID="monitoring-composition" class={card}>
      <Heading title={m("memoryComposition")} icon="database" color="steel">
        <Text class={small}>
          RSS {bytes(metric(props.snapshot, "used_memory_rss"))}
        </Text>
      </Heading>
      <Plot
        data={parts()}
        interactive={false}
        colorScale={{
          type: "ordinal",
          domain: parts().map((item) => item.name),
          range: parts().map((item) => token(item.color)),
        }}
        class="h-32"
        accessibilityLabel={m("memoryComposition")}
      >
        <Pie value="value" color="name" innerRadius="73%" outerRadius="95%" />
        <View class="absolute inset-0 items-center justify-center pointer-events-none">
          <Text class="text-(--text-size-18)/(--line-height-28) font-mono font-semibold text-foreground">
            {bytes(used())}
          </Text>
          <Text class="text-(--text-size-9) text-muted-foreground">
            {m("usedMemory")}
          </Text>
        </View>
      </Plot>
      <View class="gap-1.5">
        <Each of={parts()} key={(part) => part.color}>
          {(part) => (
            <View class="flex-row items-center gap-2 p-1.5 rounded bg-workspace">
              <Dot color={token(part().color)} />
              <Text class="flex-1 text-(--text-size-10) text-foreground">
                {part().name}
              </Text>
              <Text class="text-(--text-size-10) font-mono font-semibold text-foreground">
                {bytes(part().value)}
              </Text>
              <Text
                class="w-11 text-(--text-size-10) font-mono text-right"
                style={{ color: token(part().color) }}
              >
                {decimal((part().value / used()!) * 100)}%
              </Text>
            </View>
          )}
        </Each>
        <If when={!parts().length}>
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground py-4">
            {m("unavailable")}
          </Text>
        </If>
      </View>
      <Text class={small}>
        {m("evictionPolicy")} {field(props.snapshot, "maxmemory_policy") ?? "–"}
      </Text>
    </View>
  );
}

function Commands(props: { state: MonitoringState }) {
  const search = signal("");
  const commands = computed(() =>
    [...(props.state.snapshot()?.commands ?? [])]
      .filter((command) =>
        command.name
          .toLocaleLowerCase()
          .includes(search().trim().toLocaleLowerCase()),
      )
      .sort((a, b) =>
        BigInt(a.calls) > BigInt(b.calls)
          ? -1
          : BigInt(a.calls) < BigInt(b.calls)
            ? 1
            : a.name.localeCompare(b.name),
      ),
  );
  const total = computed(
    () =>
      props.state
        .snapshot()
        ?.commands.reduce(
          (sum, command) => sum + Number(command.microseconds),
          0,
        ) ?? 0,
  );
  const compact = () => windowSize().width < 760;
  return (
    <View testID="monitoring-commands" class={card}>
      <Heading title={m("commandProfile")} icon="timer">
        <Badge
          label={m("commandCount", {
            count: props.state.snapshot()?.commands.length ?? 0,
          })}
          color="code-string"
        />
      </Heading>
      <Input
        testID="monitoring-table-filter"
        accessibilityLabel={m("filterCommands")}
        value={search()}
        onChange={({ value }) => search.set(value)}
        placeholder={m("filterCommands")}
        class="h-7 px-2 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-inset rounded focus:ring-1 focus:ring-ring"
      />
      <View role="table" accessibilityLabel={m("commandProfile")}>
        <View
          role="row"
          class="flex-row items-center gap-2 py-2 px-1 bg-workspace"
        >
          <Text class={`flex-1 ${small}`}>CMD</Text>
          <Text class={`w-24 text-right ${small}`}>{m("calls")}</Text>
          <Text class={`w-16 text-right ${small}`}>ops/s</Text>
          <Text class={`w-20 text-right ${small}`}>{m("averageLatency")}</Text>
          <Text class={`w-20 text-right ${small}`}>p99</Text>
          {!compact() && (
            <Text class={`w-20 text-right ${small}`}>{m("timeShare")}</Text>
          )}
        </View>
        <List
          testID="monitoring-command-list"
          each={commands()}
          keyExtractor={(command) => command.name}
          estimatedItemSize={36}
          class="h-40"
          empty={() => (
            <View class="p-4">
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {m(search() ? "noMatchingCommands" : "noCommands")}
              </Text>
            </View>
          )}
        >
          {(command) => (
            <View
              role="row"
              class="flex-row items-center gap-2 py-2 px-1 border-b border-border/30"
            >
              <Button
                testID={`monitoring-plot-command-${command().name}`}
                accessibilityLabel={m("plotCommand", { name: command().name })}
                disabled={
                  props.state.commands().length >= 6 &&
                  !props.state.commands().includes(command().name)
                }
                onPress={() => {
                  props.state.toggleCommand(command().name);
                  props.state.group.set("commands");
                }}
                class="flex-1 min-w-0 flex-row items-center gap-1 rounded py-1 hover:bg-selected active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                <Icon
                  name="chart"
                  size={11}
                  color={token(
                    props.state.commands().includes(command().name)
                      ? "success"
                      : "faint",
                  )}
                />
                <Text
                  class="flex-1 text-(--text-size-11) font-mono font-semibold text-code-string"
                  style={{ numberOfLines: 1 }}
                >
                  {command().name}
                </Text>
              </Button>
              <Text class="w-24 text-right text-(--text-size-11) font-mono text-foreground">
                {shortCount(command().calls)}
              </Text>
              <Text class="w-16 text-right text-(--text-size-11) font-mono text-steel">
                {formatMetric(
                  "commands",
                  props.state.rates()[commandId(command().name)],
                  true,
                )}
              </Text>
              <Text class="w-20 text-right text-(--text-size-11) font-mono text-success">
                {latency(command().averageMicroseconds)}
              </Text>
              <Text class="w-20 text-right text-(--text-size-11) font-mono text-foreground">
                {latency(command().p99Microseconds)}
              </Text>
              {!compact() && (
                <View class="w-20 gap-1">
                  <Text class={`text-right ${small}`}>
                    {total() > 0
                      ? `${decimal((Number(command().microseconds) / total()) * 100)}%`
                      : "–"}
                  </Text>
                  <View class="h-1 rounded bg-selected overflow-hidden">
                    <View
                      class="h-1 rounded bg-success"
                      style={{
                        width: `${total() ? (Number(command().microseconds) / total()) * 100 : 0}%`,
                      }}
                    />
                  </View>
                </View>
              )}
            </View>
          )}
        </List>
      </View>
      <Text class={small}>{m("plotCommandHint")}</Text>
      <View class="flex-row flex-wrap justify-between gap-2">
        <Text class={small}>{m("statisticsLifetime")}</Text>
        <Text class={small}>
          Slowlog {count(props.state.snapshot()?.slowlogLength)} {m("entries")}
        </Text>
      </View>
    </View>
  );
}

function Persistence(props: { snapshot?: RedisServerMetrics }) {
  const value = (name: string) => field(props.snapshot, name);
  const saving = () => value("rdb_bgsave_in_progress") === "1",
    aof = () => value("aof_enabled");
  const status = (value: string | undefined) =>
    value === "ok" ? m("ok") : value === "err" ? m("failed") : m("unavailable");
  return (
    <View testID="monitoring-persistence" class={card}>
      <Heading title={m("persistence")} icon="save" />
      <View class="flex-row gap-2">
        <View class="flex-1 min-w-0 p-2 gap-2 bg-workspace rounded">
          <Text class={small}>RDB {m("snapshot")}</Text>
          <Text
            class={`text-(--text-size-12)/(--line-height-16) font-mono font-semibold ${value("rdb_last_bgsave_status") === "err" ? "text-destructive" : value("rdb_last_bgsave_status") === "ok" ? "text-success" : "text-muted-foreground"}`}
          >
            {saving() ? m("saving") : status(value("rdb_last_bgsave_status"))}
          </Text>
          <Text class={small}>
            {m("changes")} {count(value("rdb_changes_since_last_save"))}
          </Text>
          <Text class={small}>
            {m("lastSave")}{" "}
            {metric(props.snapshot, "rdb_last_save_time")
              ? new Date(
                  metric(props.snapshot, "rdb_last_save_time")! * 1000,
                ).toLocaleString()
              : "–"}
          </Text>
        </View>
        <View class="flex-1 min-w-0 p-2 gap-2 bg-workspace rounded">
          <Text class={small}>AOF {m("appendOnly")}</Text>
          <Text
            class={`text-(--text-size-12)/(--line-height-16) font-mono font-semibold ${aof() !== "1" || !value("aof_last_write_status") ? "text-muted-foreground" : value("aof_last_write_status") === "err" ? "text-destructive" : "text-steel"}`}
          >
            {aof() === "0"
              ? m("disabled")
              : aof() === "1"
                ? status(value("aof_last_write_status"))
                : m("unavailable")}
          </Text>
          <Text class={small}>
            {m("buffer")} {bytes(metric(props.snapshot, "aof_buffer_length"))}
          </Text>
          <Text class={small}>
            {m("pendingFsync")} {count(value("aof_pending_bio_fsync"))}
          </Text>
        </View>
      </View>
    </View>
  );
}

function Replication(props: { snapshot?: RedisServerMetrics }) {
  const replica = computed(() => field(props.snapshot, "role") === "slave");
  return (
    <View testID="monitoring-replication" class={card}>
      <Heading title={m("replication")} icon="network" color="steel">
        <Text class={small}>
          {field(props.snapshot, "role")?.toUpperCase() ?? "–"}
        </Text>
      </Heading>
      {replica() ? (
        <View class="p-2 gap-2 bg-workspace rounded">
          <Text class="text-(--text-size-11) font-mono text-foreground">
            {field(props.snapshot, "master_host")}:
            {field(props.snapshot, "master_port")}
          </Text>
          <Text
            class={`text-(--text-size-11) font-mono ${field(props.snapshot, "master_link_status") === "up" ? "text-success" : "text-destructive"}`}
          >
            {m("primaryLink")}{" "}
            {field(props.snapshot, "master_link_status") ?? "–"}
          </Text>
        </View>
      ) : (
        <Scroll class="max-h-28" contentClass="gap-1.5">
          <Each
            of={props.snapshot?.replicas ?? []}
            key={(item) => item.address}
          >
            {(item) => (
              <View class="flex-row flex-wrap items-center gap-2 p-2 bg-workspace rounded">
                <Dot
                  color={token(
                    item().state === "online" ? "success" : "code-string",
                  )}
                />
                <Text class="flex-1 text-(--text-size-11) font-mono text-foreground">
                  {item().address}
                </Text>
                <Text class="text-(--text-size-10) font-mono text-muted-foreground">
                  {item().state}
                </Text>
                <Text class="text-(--text-size-10) font-mono text-success">
                  {item().lagSeconds == null ? "–" : `${item().lagSeconds}s`}{" "}
                  {m("lag")}
                </Text>
              </View>
            )}
          </Each>
          {!props.snapshot?.replicas.length && (
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground py-2">
              {m(
                metric(props.snapshot, "connected_slaves") === 0
                  ? "noReplicas"
                  : "unavailable",
              )}
            </Text>
          )}
        </Scroll>
      )}
      <Text class={small}>
        {m("replicationOffset")}{" "}
        {count(
          field(
            props.snapshot,
            replica() ? "slave_repl_offset" : "master_repl_offset",
          ),
        )}
      </Text>
    </View>
  );
}
