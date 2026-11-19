import type { RedisServerMetrics } from "ferrix/native";
import { t } from "../../i18n";

export const m = (key: string, values?: Record<string, unknown>) =>
  t(`monitoring.${key}`, values);
export const field = (value: RedisServerMetrics | undefined, name: string) =>
  value?.fields.find((item) => item.name === name)?.value;
export function metric(
  value: RedisServerMetrics | undefined,
  name: string,
): number | undefined {
  const raw = field(value, name);
  if (raw === undefined || !raw.length) return undefined;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
export const decimal = (value: number | undefined, digits = 1) =>
  value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits);
export function count(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "–";
  return (
    typeof value === "number" ? Math.round(value).toString() : value
  ).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function bytes(value: string | number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(Number(value)))
    return "–";
  let size = Number(value),
    unit = 0;
  while (size >= 1024 && unit < 4) {
    size /= 1024;
    unit++;
  }
  const digits = () => (unit ? (size >= 100 ? 0 : size >= 10 ? 1 : 2) : 0);
  if (Number(size.toFixed(digits())) >= 1024 && unit < 4) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(digits())} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
export function shortCount(value: string): string {
  const full = count(value);
  return full.length <= 13 ? full : Number(value).toExponential(3);
}
export const latency = (microseconds: number | undefined | null) =>
  microseconds == null ? "–" : `${decimal(microseconds / 1000, 3)} ms`;
export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "–";
  if (seconds >= 86400)
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60)
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}
export function time(milliseconds: number): string {
  const date = new Date(milliseconds);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}
export function hitRatio(snapshot?: RedisServerMetrics): number | undefined {
  const hits = metric(snapshot, "keyspace_hits"),
    misses = metric(snapshot, "keyspace_misses");
  return hits === undefined || misses === undefined || hits + misses === 0
    ? undefined
    : (hits / (hits + misses)) * 100;
}
export function averageLatency(
  snapshot?: RedisServerMetrics,
): number | undefined {
  if (!snapshot?.commands.length) return undefined;
  const calls = snapshot.commands.reduce(
    (total, item) => total + BigInt(item.calls),
    0n,
  );
  return calls === 0n
    ? undefined
    : Number(
        snapshot.commands.reduce(
          (total, item) => total + BigInt(item.microseconds),
          0n,
        ),
      ) / Number(calls);
}
export type MetricColor =
  | "primary"
  | "code-string"
  | "steel"
  | "success"
  | "chart-3"
  | "chart-4"
  | "chart-5";
export function memoryParts(
  snapshot?: RedisServerMetrics,
): { name: string; value: number; color: MetricColor }[] {
  const used = metric(snapshot, "used_memory"),
    dataset = metric(snapshot, "used_memory_dataset");
  if (!used || dataset === undefined) return [];
  const data = Math.min(used, dataset);
  const backlog = metric(snapshot, "mem_replication_backlog"),
    replicas = metric(snapshot, "mem_clients_slaves");
  const replication =
    metric(snapshot, "mem_total_replication_buffers") ??
    (backlog === undefined || replicas === undefined
      ? undefined
      : backlog + replicas);
  const clients = metric(snapshot, "mem_clients_normal");
  if (replication === undefined || clients === undefined)
    return [
      { name: m("dataset"), value: data, color: "code-string" },
      { name: m("overhead"), value: used - data, color: "success" },
    ];
  const buffers = Math.min(used - data, replication + clients);
  return [
    { name: m("dataset"), value: data, color: "code-string" },
    { name: m("buffers"), value: buffers, color: "steel" },
    { name: m("overhead"), value: used - data - buffers, color: "success" },
  ];
}

export type MetricGroup =
  | "commands"
  | "memory"
  | "clients"
  | "hitRatio"
  | "network"
  | "cpu"
  | "keys";
export const metricGroups: { id: MetricGroup; label: string }[] = [
  { id: "commands", label: "commands" },
  { id: "memory", label: "memoryUsage" },
  { id: "clients", label: "clientsLabel" },
  { id: "hitRatio", label: "hitRatio" },
  { id: "network", label: "network" },
  { id: "cpu", label: "cpu" },
  { id: "keys", label: "keyEvents" },
];
export type Sample = {
  at: number;
  span: number;
  peak?: number;
  values: Record<string, number>;
  weights?: Record<string, number>;
};
export type Curve = { id: string; label: string; color: MetricColor };
export const commandId = (name: string) => `command:${name}`;
const commandColors: MetricColor[] = [
  "steel",
  "success",
  "code-string",
  "chart-3",
  "chart-4",
  "chart-5",
];
export function commandColor(name: string): MetricColor {
  if (name === "GET") return "steel";
  if (name === "SET" || name === "SETEX" || name === "PSETEX") return "success";
  if (name === "HGETALL") return "code-string";
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return commandColors[hash % commandColors.length];
}
export function defaultCommands(snapshot: RedisServerMetrics): string[] {
  const commands = [...snapshot.commands].sort((a, b) =>
    BigInt(a.calls) > BigInt(b.calls)
      ? -1
      : BigInt(a.calls) < BigInt(b.calls)
        ? 1
        : 0,
  );
  const preferred = commands.filter(
    (item) =>
      ![
        "INFO",
        "SLOWLOG|LEN",
        "AUTH",
        "HELLO",
        "CLIENT|SETINFO",
        "CLIENT|SETNAME",
      ].includes(item.name),
  );
  return (preferred.length ? preferred : commands)
    .slice(0, 3)
    .map((item) => item.name);
}
export function curves(
  group: MetricGroup,
  commands: string[],
  total = true,
): Curve[] {
  if (group === "commands") {
    const used = new Set<MetricColor>();
    return [
      ...(total
        ? [{ id: "total", label: m("totalQps"), color: "primary" as const }]
        : []),
      ...commands.slice(0, 6).map((name) => {
        const preferred = commandColor(name),
          color = used.has(preferred)
            ? commandColors.find((candidate) => !used.has(candidate))!
            : preferred;
        used.add(color);
        return { id: commandId(name), label: name, color };
      }),
    ];
  }
  const definitions: Record<
    Exclude<MetricGroup, "commands">,
    [string, string, MetricColor][]
  > = {
    memory: [
      ["memoryUsed", "usedMemory", "primary"],
      ["memoryRss", "rss", "steel"],
      ["memoryDataset", "dataset", "code-string"],
      ["memoryLimit", "memoryLimit", "chart-3"],
    ],
    clients: [
      ["clients", "activeClients", "steel"],
      ["blocked", "blocked", "code-string"],
      ["tracking", "tracking", "success"],
    ],
    hitRatio: [["hitRatio", "hitRatio", "success"]],
    network: [
      ["netIn", "networkIn", "success"],
      ["netOut", "networkOut", "steel"],
    ],
    cpu: [
      ["cpuTotal", "cpuTotal", "primary"],
      ["cpuUser", "cpuUser", "steel"],
      ["cpuSystem", "cpuSystem", "success"],
    ],
    keys: [
      ["expiredRate", "expired", "steel"],
      ["evictedRate", "evicted", "code-string"],
    ],
  };
  return definitions[group].map(([id, label, color]) => ({
    id,
    label: m(label),
    color,
  }));
}
export function metricUnit(group: MetricGroup): string {
  return group === "memory"
    ? "B"
    : group === "network"
      ? "B/s"
      : group === "cpu" || group === "hitRatio"
        ? "%"
        : group === "commands"
          ? "ops/s"
          : group === "keys"
            ? m("keysPerSecond")
            : m("clientsLabel");
}
export function hasMetric(
  snapshot: RedisServerMetrics | undefined,
  group: MetricGroup,
): boolean {
  if (!snapshot) return false;
  if (group === "commands")
    return (
      metric(snapshot, "instantaneous_ops_per_sec") !== undefined ||
      snapshot.commands.length > 0
    );
  if (group === "hitRatio")
    return (
      metric(snapshot, "keyspace_hits") !== undefined &&
      metric(snapshot, "keyspace_misses") !== undefined
    );
  const fields: Record<
    Exclude<MetricGroup, "commands" | "hitRatio">,
    string[]
  > = {
    memory: ["used_memory", "used_memory_rss", "used_memory_dataset"],
    clients: ["connected_clients", "blocked_clients", "tracking_clients"],
    network: ["instantaneous_input_kbps", "instantaneous_output_kbps"],
    cpu: ["used_cpu_user", "used_cpu_sys"],
    keys: ["expired_keys", "evicted_keys"],
  };
  return fields[group].some((name) => metric(snapshot, name) !== undefined);
}
export function formatMetric(
  group: MetricGroup,
  value: number | undefined,
  axis = false,
): string {
  if (value === undefined || !Number.isFinite(value)) return "–";
  if (group === "memory") return bytes(value);
  if (group === "network") return `${bytes(value)}/s`;
  if (group === "hitRatio" || group === "cpu")
    return `${decimal(value, axis ? 0 : 2)}%`;
  const number = Number.isInteger(value) ? count(value) : decimal(value);
  return axis || group === "clients"
    ? number
    : `${number} ${metricUnit(group)}`;
}
function rate(
  current: string | undefined,
  previous: string | undefined,
  seconds: number,
): number | undefined {
  if (
    current === undefined ||
    previous === undefined ||
    seconds <= 0 ||
    !/^\d+$/.test(current) ||
    !/^\d+$/.test(previous)
  )
    return undefined;
  const change = BigInt(current) - BigInt(previous);
  return change < 0n ? undefined : Number(change) / seconds;
}
export const identity = (snapshot: RedisServerMetrics) =>
  `${field(snapshot, "run_id") ?? "unknown"}:${snapshot.generation}`;
function elapsed(
  snapshot: RedisServerMetrics,
  previous?: RedisServerMetrics,
): number {
  return previous && identity(previous) === identity(snapshot)
    ? (Number(snapshot.sampledAtMs) - Number(previous.sampledAtMs)) / 1000
    : 0;
}
export function commandRates(
  snapshot: RedisServerMetrics,
  previous?: RedisServerMetrics,
): Record<string, number> {
  const seconds = elapsed(snapshot, previous);
  if (!previous || seconds <= 0) return {};
  const currentTotal = field(snapshot, "total_commands_processed"),
    previousTotal = field(previous, "total_commands_processed");
  if (
    currentTotal &&
    previousTotal &&
    /^\d+$/.test(currentTotal) &&
    /^\d+$/.test(previousTotal) &&
    BigInt(currentTotal) < BigInt(previousTotal)
  )
    return {};
  const before = new Map(
    previous.commands.map((item) => [item.name, item.calls]),
  );
  const result: Record<string, number> = {};
  for (const command of snapshot.commands) {
    const value = rate(
      command.calls,
      before.get(command.name) ?? (previous.commands.length ? "0" : undefined),
      seconds,
    );
    if (value !== undefined) result[commandId(command.name)] = value;
  }
  return result;
}
export function sample(
  snapshot: RedisServerMetrics,
  previous?: RedisServerMetrics,
  tracked = defaultCommands(snapshot),
): Sample {
  const at = Number(snapshot.sampledAtMs);
  const seconds = elapsed(snapshot, previous),
    rates = commandRates(snapshot, previous),
    values: Record<string, number> = {};
  function add(key: string, value: number | undefined) {
    if (value !== undefined && Number.isFinite(value)) values[key] = value;
  }
  add("total", metric(snapshot, "instantaneous_ops_per_sec"));
  for (const name of tracked.slice(0, 6))
    add(commandId(name), rates[commandId(name)]);
  for (const [key, name] of [
    ["memoryUsed", "used_memory"],
    ["memoryRss", "used_memory_rss"],
    ["memoryDataset", "used_memory_dataset"],
    ["clients", "connected_clients"],
    ["blocked", "blocked_clients"],
    ["tracking", "tracking_clients"],
  ])
    add(key, metric(snapshot, name));
  const limit = metric(snapshot, "maxmemory");
  add("memoryLimit", limit && limit > 0 ? limit : undefined);
  add("hitRatio", hitRatio(snapshot));
  const input = metric(snapshot, "instantaneous_input_kbps"),
    output = metric(snapshot, "instantaneous_output_kbps");
  add("netIn", input === undefined ? undefined : input * 1024);
  add("netOut", output === undefined ? undefined : output * 1024);
  if (previous && seconds > 0) {
    const cpu = (name: string) => {
      const current = metric(snapshot, name),
        before = metric(previous, name);
      return current === undefined || before === undefined || current < before
        ? undefined
        : ((current - before) / seconds) * 100;
    };
    const user = cpu("used_cpu_user"),
      system = cpu("used_cpu_sys");
    add("cpuUser", user);
    add("cpuSystem", system);
    add(
      "cpuTotal",
      user === undefined || system === undefined ? undefined : user + system,
    );
    add(
      "expiredRate",
      rate(
        field(snapshot, "expired_keys"),
        field(previous, "expired_keys"),
        seconds,
      ),
    );
    add(
      "evictedRate",
      rate(
        field(snapshot, "evicted_keys"),
        field(previous, "evicted_keys"),
        seconds,
      ),
    );
  }
  return { at, span: seconds > 0 ? seconds : 1, peak: values.total, values };
}
function merge(a: Sample, b: Sample): Sample {
  const result: Sample = { at: b.at, span: a.span + b.span, values: {} };
  const weights: Record<string, number> = {};
  const peaks = [a.peak, b.peak].filter(
    (value): value is number => value !== undefined,
  );
  result.peak = peaks.length ? Math.max(...peaks) : undefined;
  for (const key of new Set([
    ...Object.keys(a.values),
    ...Object.keys(b.values),
  ])) {
    const left = a.values[key] === undefined ? 0 : (a.weights?.[key] ?? a.span);
    const right =
      b.values[key] === undefined ? 0 : (b.weights?.[key] ?? b.span);
    const weight = left + right;
    if (weight <= 0) continue;
    result.values[key] =
      ((a.values[key] ?? 0) * left + (b.values[key] ?? 0) * right) / weight;
    if (weight !== result.span) weights[key] = weight;
  }
  if (Object.keys(weights).length) result.weights = weights;
  return result;
}
/** Keep 15 minutes at sampling resolution, then one-minute averages, for at most 24 hours. */
export function appendHistory(history: Sample[], next: Sample): Sample[] {
  const buckets = new Map<number, Sample>();
  for (const point of [...history, next]) {
    if (point.at < next.at - 86400000) continue;
    const key =
      point.at < next.at - 900000
        ? Math.floor(point.at / 60000) * 60000
        : point.at;
    const previous = buckets.get(key);
    buckets.set(key, previous ? merge(previous, point) : point);
  }
  return [...buckets.values()].slice(-2400);
}
export function plotSamples(history: Sample[], seconds: number): Sample[] {
  const latest = history[history.length - 1]?.at ?? 0;
  const selected = history.filter(
    (point) => point.at >= latest - seconds * 1000,
  );
  const width = Math.max(1, Math.ceil(selected.length / 300));
  const result: Sample[] = [];
  for (let index = 0; index < selected.length; index += width)
    result.push(selected.slice(index, index + width).reduce(merge));
  return result;
}
