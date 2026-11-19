import { List, Scroll, signal, Text, token, View, windowSize } from "nsh";
import { Button, Select } from "nsh/base";
import { Modal } from "../../components/modal";
import { Action } from "../../components/action";
import { useClipboardCopy } from "../../utils/clipboard";
import { createAnalysisState } from "./analysis-state";
import {
  analysisBytes,
  analysisKeyPreview,
  analysisKeyText,
} from "./key-analysis";
import type { DatabaseAnalysisSession } from "./database-analysis";
import { safeError } from "../../utils/errors";
import { count, m } from "./monitoring-values";

const a = (key: string, values?: Record<string, unknown>) =>
  m("analysis." + key, values);
const palette = [
  "steel",
  "success",
  "chart-3",
  "chart-4",
  "code-string",
  "chart-5",
] as const;
const percent = (part: string, total: string) =>
  BigInt(total) === 0n
    ? 0
    : Number((BigInt(part) * 10000n) / BigInt(total)) / 100;

export function AnalysisDialog(props: {
  session: DatabaseAnalysisSession;
  name: string;
  endpoint: string;
  onClose: () => void;
  onOpenKey?: (database: number, key: Uint8Array) => void;
}) {
  const state = createAnalysisState(props.session),
    tab = signal("databases"),
    copy = useClipboardCopy();
  const result = () => state.snapshot();
  const present = () => (result()?.visited ?? 0) - (result()?.missing ?? 0);
  const processedDatabases = () =>
    result()?.databases.filter(
      (database) =>
        !["pending", "running", "cancelled"].includes(database.status),
    ).length ?? 0;
  const knownMemory = () =>
    !!result()?.measured ||
    (!!result()?.databases.length &&
      result()!.databases.every((database) => database.memoryAvailable));
  void state.start();
  return (
    <Modal
      id="monitoring-analysis-dialog"
      title={m("analysisTitle")}
      description={props.name + " · " + props.endpoint}
      width={1100}
      height={760}
      headerHeight={80}
      onClose={props.onClose}
    >
      <View class="shrink-0 px-6 pb-3 gap-2 border-b border-border">
        <View class="flex-row flex-wrap items-center gap-2">
          <Text
            testID="analysis-scope"
            class="flex-1 text-(--text-size-11) font-mono text-muted-foreground"
          >
            {result()?.databases.length
              ? a(
                  result()!.scope === "cluster"
                    ? "clusterScope"
                    : "allDatabaseScope",
                  {
                    database: result()!.database,
                    count: result()!.databases.length,
                  },
                )
              : a("discovering")}
          </Text>
          <Select
            testID="analysis-limit"
            accessibilityLabel={a("limit")}
            value={String(state.limit())}
            disabled={state.busy()}
            items={[1000, 10000, 50000].map((value) => ({
              value: String(value),
              title: a("limitOption", { count: count(value) }),
            }))}
            onChange={({ value }) => {
              if (value !== null) state.limit.set(Number(value));
            }}
            popupClass="rounded border border-border bg-popover p-1 shadow-xl"
            itemClass="h-8 px-2 text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent"
            trigger={
              <View
                testID="analysis-limit-trigger"
                class="h-8 px-3 justify-center rounded border border-border bg-background"
              >
                <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">
                  {a("limitOption", { count: count(state.limit()) })}
                </Text>
              </View>
            }
            renderItem={(item) => (
              <Text
                testID={"analysis-limit-" + item.value}
                class="text-(--text-size-12)/(--line-height-16) text-foreground"
              >
                {item.title}
              </Text>
            )}
          />
          <Action
            testID="analysis-stop"
            label={a("stop")}
            disabled={!state.busy()}
            onPress={state.stop}
          />
          <Action
            testID="analysis-start"
            label={a("restart")}
            icon="refresh"
            primary
            disabled={state.busy()}
            onPress={() => void state.start()}
          />
        </View>
        <Text
          testID="analysis-progress"
          class="text-(--text-size-11) font-mono text-muted-foreground"
        >
          {a(
            "status." +
              (state.error() ? "error" : (result()?.status ?? "running")),
          )}
          {" · "}
          {a("databaseProgress", {
            count: count(result()?.visited ?? 0),
            pages: count(result()?.pages ?? 0),
            done: processedDatabases(),
            total: result()?.databases.length ?? 0,
            seconds: ((result()?.elapsedMs ?? 0) / 1000).toFixed(1),
          })}
          {result()?.status === "running" && result()?.currentDatabase != null
            ? " · DB " + result()!.currentDatabase
            : ""}
        </Text>
        <If when={!!result()?.databases.length && !result()!.catalogComplete}>
          <Text
            testID="analysis-catalog-incomplete"
            class="text-(--text-size-12)/(--line-height-16) text-code-string"
          >
            {a("catalogIncomplete")}
          </Text>
        </If>
        <If
          when={
            result()?.status === "limited" && result()?.reason !== "catalog"
          }
        >
          <Text testID="analysis-limited" class="text-(--text-size-12)/(--line-height-16) text-code-string">
            {a("limited." + result()!.reason)}
          </Text>
        </If>
        <If when={!!state.error()}>
          <Text testID="analysis-error" class="text-(--text-size-12)/(--line-height-16) text-destructive">
            {state.error()}
          </Text>
        </If>
      </View>
      <Scroll
        testID="analysis-scroll"
        class="flex-1 min-h-0"
        contentClass="p-4 gap-3"
      >
        <View class="flex-row flex-wrap gap-2">
          <Summary
            label={a("observedKeys")}
            value={count(present())}
            caption={a("attempted", { count: count(result()?.visited ?? 0) })}
          />
          <Summary
            label={a("memoryTotal")}
            value={analysisBytes(
              knownMemory() ? result()!.memoryBytes : undefined,
            )}
            caption={a("measured", { count: count(result()?.measured ?? 0) })}
          />
          <Summary
            label={a("memoryAverage")}
            value={analysisBytes(
              result()?.measured
                ? (
                    BigInt(result()!.memoryBytes) / BigInt(result()!.measured)
                  ).toString()
                : undefined,
            )}
            caption={a("sampledMemory")}
          />
        </View>
        <If
          when={
            !!result() &&
            result()!.missing +
              result()!.duplicates +
              result()!.typeUnavailable +
              result()!.memoryUnavailable +
              result()!.ttlUnavailable >
              0
          }
        >
          <Text
            testID="analysis-availability"
            class="text-(--text-size-11) text-muted-foreground"
          >
            {a("availability", {
              missing: count(result()!.missing),
              duplicates: count(result()!.duplicates),
              types: count(result()!.typeUnavailable),
              memory: count(result()!.memoryUnavailable),
              ttl: count(result()!.ttlUnavailable),
            })}
          </Text>
        </If>
        <View class="flex-row items-center gap-1 p-1 rounded bg-background">
          <Action
            testID="analysis-tab-databases"
            label={a("databasesTitle")}
            selected={tab() === "databases"}
            onPress={() => tab.set("databases")}
          />
          <Action
            testID="analysis-tab-types"
            label={a("typesTitle")}
            selected={tab() === "types"}
            onPress={() => tab.set("types")}
          />
          <Action
            testID="analysis-tab-keys"
            label={a("topTitle")}
            selected={tab() === "keys"}
            onPress={() => tab.set("keys")}
          />
        </View>
        <If when={tab() === "databases"}>
          <Text class="text-(--text-size-11) text-muted-foreground">
            {a(
              windowSize().height < 620
                ? "databasesCompactHint"
                : "databasesHint",
            )}
          </Text>
          <List
            testID="analysis-database-list"
            each={result()?.databases ?? []}
            keyExtractor={(database) => String(database.database)}
            estimatedItemSize={86}
            class="h-80"
            contentClass="gap-2"
          >
            {(database) => (
              <View
                testID={"analysis-database-" + database().database}
                class="p-3 gap-2 rounded bg-background"
              >
                <View class="flex-row items-center gap-3">
                  <Text class="w-14 text-(--text-size-12)/(--line-height-16) font-mono font-semibold text-foreground">
                    DB {database().database}
                  </Text>
                  <View class="flex-1 h-1.5 rounded bg-selected overflow-hidden">
                    <View
                      class="h-full rounded bg-steel"
                      style={{
                        width: `${database().memoryAvailable ? percent(database().memoryBytes, result()!.memoryBytes) : 0}%`,
                      }}
                    />
                  </View>
                  <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">
                    {analysisBytes(
                      database().memoryAvailable
                        ? database().memoryBytes
                        : undefined,
                    )}
                  </Text>
                  <Text class="w-14 text-right text-(--text-size-11) font-mono text-muted-foreground">
                    {database().memoryAvailable
                      ? percent(
                          database().memoryBytes,
                          result()!.memoryBytes,
                        ).toFixed(1) + "%"
                      : "-"}
                  </Text>
                </View>
                <Text
                  class={`text-(--text-size-11) ${database().status === "error" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {a("databaseState." + database().status)}
                  {" · "}
                  {a("databaseCoverage", {
                    count: count(database().visited),
                    total: count(database().keyCount),
                    measured: count(database().measured),
                  })}
                  {database().errorCode
                    ? " · " + safeError({ code: database().errorCode })
                    : ""}
                </Text>
              </View>
            )}
          </List>
        </If>
        <If when={tab() === "types"}>
          <View
            class={`gap-3 ${windowSize().width >= 1000 ? "flex-row" : "flex-col"}`}
          >
            <View
              class="min-w-0"
              style={{ flex: windowSize().width >= 1000 ? 1.3 : undefined }}
            >
              <View class="p-3 gap-3 rounded bg-background">
                <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
                  {a("typesTitle")}
                </Text>
                <Each of={result()?.types ?? []} key={(type) => type.type}>
                  {(type, index) => (
                    <View
                      testID={"analysis-type-" + type().type}
                      class="gap-1.5"
                    >
                      <View class="flex-row flex-wrap items-center gap-x-4 gap-y-1">
                        <Text class="flex-1 text-(--text-size-12)/(--line-height-16) font-mono font-semibold text-foreground">
                          {type().type === "unknown"
                            ? a("unknown")
                            : type().type === "other"
                              ? a("other")
                              : type().type.toUpperCase()}
                        </Text>
                        <Text class="text-(--text-size-11) font-mono text-foreground">
                          {a("typeCount", {
                            count: count(type().keys),
                            percent: present()
                              ? ((100 * type().keys) / present()).toFixed(1)
                              : "0.0",
                          })}
                        </Text>
                        <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                          {analysisBytes(
                            type().measuredKeys
                              ? type().memoryBytes
                              : undefined,
                          )}
                          {" · "}
                          {type().measuredKeys && result()?.measured
                            ? percent(
                                type().memoryBytes,
                                result()!.memoryBytes,
                              ).toFixed(1) + "%"
                            : "-"}
                        </Text>
                      </View>
                      <View class="h-1.5 rounded bg-selected overflow-hidden">
                        <View
                          class="h-full rounded"
                          style={{
                            width: `${present() ? (100 * type().keys) / present() : 0}%`,
                            backgroundColor: token(
                              palette[index() % palette.length],
                            ),
                          }}
                        />
                      </View>
                    </View>
                  )}
                </Each>
                <If when={!result()?.types.length}>
                  <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                    {a(
                      result()?.status === "complete" && !result()?.visited
                        ? "empty"
                        : "noResults",
                    )}
                  </Text>
                </If>
              </View>
            </View>
            <View
              class="min-w-0 gap-3"
              style={{ flex: windowSize().width >= 1000 ? 1 : undefined }}
            >
              <View class="p-3 gap-3 rounded bg-background">
                <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
                  {a("sizesTitle")}
                </Text>
                <Each of={result()?.sizes ?? []}>
                  {(amount, index) => (
                    <View class="flex-row items-center gap-4">
                      <Text class="w-28 text-(--text-size-11) font-mono text-muted-foreground">
                        {
                          [
                            "< 1 KiB",
                            "1–10 KiB",
                            "10–100 KiB",
                            "100 KiB–1 MiB",
                            "≥ 1 MiB",
                          ][index()]
                        }
                      </Text>
                      <View class="flex-1 h-1.5 rounded bg-selected overflow-hidden">
                        <View
                          class="h-full bg-steel rounded"
                          style={{
                            width: `${result()?.measured ? (amount() / result()!.measured) * 100 : 0}%`,
                          }}
                        />
                      </View>
                      <Text class="w-16 text-right text-(--text-size-11) font-mono text-foreground">
                        {count(amount())}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
              <View class="p-3 gap-2 rounded bg-background">
                <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
                  {a("ttlTitle")}
                </Text>
                <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                  {a("ttlCounts", {
                    expiring: count(result()?.expiring ?? 0),
                    persistent: count(result()?.persistent ?? 0),
                    unavailable: count(result()?.ttlUnavailable ?? 0),
                  })}
                </Text>
              </View>
            </View>
          </View>
        </If>
        <If when={tab() === "keys"}>
          <Text class="text-(--text-size-11) text-muted-foreground">{a("topHint")}</Text>
          <Each of={result()?.top ?? []} key={(key) => key.id}>
            {(key, index) => (
              <View class="flex-row items-center pr-3 rounded bg-background">
                <Button
                  testID={"analysis-top-" + index()}
                  accessibilityLabel={a("openKey", {
                    database: key().database,
                    key: analysisKeyPreview(key().key) || a("emptyKey"),
                  })}
                  disabled={!props.onOpenKey}
                  class="flex-1 min-w-0 p-3 gap-2 rounded hover:bg-accent/50 active:opacity-70 focus-visible:ring-1 focus-visible:ring-ring"
                  onPress={() => {
                    const target = key(),
                      open = props.onOpenKey;
                    if (!open) return;
                    const bytes = new Uint8Array(target.key);
                    state.stop();
                    props.onClose();
                    open(target.database, bytes);
                  }}
                >
                  <View class="flex-row items-center gap-3">
                    <Text class="text-(--text-size-11) font-mono text-faint">
                      #{index() + 1}
                    </Text>
                    <Text class="flex-1 min-w-0 text-(--text-size-12)/(--line-height-16) font-mono text-foreground line-clamp-2">
                      {analysisKeyPreview(key().key) || a("emptyKey")}
                    </Text>
                  </View>
                  <View class="flex-row flex-wrap gap-x-5 gap-y-1">
                    <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                      DB {key().database}
                      {" · "}
                      {key().type === "unknown"
                        ? a("unknown")
                        : key().type.toUpperCase()}
                    </Text>
                    <Text class="text-(--text-size-11) font-mono text-steel">
                      {analysisBytes(key().memoryBytes)}
                    </Text>
                    <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                      TTL:{" "}
                      {key().expiration === "persistent"
                        ? a("persistent")
                        : key().expiration === "expiring" && key().ttlMs != null
                          ? key().ttlMs + " ms"
                          : "-"}
                    </Text>
                  </View>
                </Button>
                <Action
                  testID={"analysis-copy-" + index()}
                  label={a("copyKey")}
                  icon="copy"
                  compact
                  onPress={() => void copy(analysisKeyText(key().key))}
                />
              </View>
            )}
          </Each>
          <If when={!result()?.top.length}>
            <Text class="p-3 text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {a("noMemory")}
            </Text>
          </If>
        </If>
      </Scroll>
      <View class="shrink-0 px-6 py-3 border-t border-border">
        <Text class="text-(--text-size-10) text-muted-foreground">{a("hint")}</Text>
      </View>
    </Modal>
  );
}

function Summary(props: { label: string; value: string; caption: string }) {
  return (
    <View
      class={`flex-1 min-w-[150px] rounded bg-background ${windowSize().height < 620 ? "p-2 gap-1" : "p-3 gap-2"}`}
    >
      <Text class="text-(--text-size-11) text-muted-foreground">{props.label}</Text>
      <Text
        class={`${windowSize().height < 620 ? "text-(--text-size-16)/(--line-height-24)" : "text-(--text-size-20)/(--line-height-28)"} font-mono font-semibold text-foreground`}
      >
        {props.value}
      </Text>
      <If when={windowSize().height >= 620}>
        <Text class="text-(--text-size-10) text-faint">{props.caption}</Text>
      </If>
    </View>
  );
}
