import { List, Text, View } from "nsh";
import { Button, Input, Select } from "nsh/base";
import type { SavedConnection } from "../../data/connections/connection-model";
import { address, endpoints } from "../../data/connections/connection-model";
import { Action } from "../../components/action";
import { useClipboardCopy } from "../../utils/clipboard";
import { Modal } from "./hub-controls";
import { createSlowlogState, type SlowlogSession } from "./slowlog-state";
import {
  slowlogArgument,
  slowlogBytes,
  slowlogCommand,
  slowlogDuration,
  slowlogTime,
  slowlogT as s,
} from "./slowlog-values";

export function SlowlogDialog(props: {
  connection: SavedConnection;
  openSession: (connectionId: string) => Promise<SlowlogSession>;
  onClose: () => void;
}) {
  const state = createSlowlogState(() =>
    props.openSession(props.connection.id),
  );
  const copy = useClipboardCopy();
  void state.refresh();
  return (
    <Modal
      id="slowlog-dialog"
      title={s("title")}
      description={
        props.connection.name +
        " · " +
        endpoints(props.connection.config).map(address).join(", ")
      }
      width={980}
      height={700}
      headerHeight={80}
      onClose={props.onClose}
    >
      <View class="px-6 pb-3 gap-2 border-b border-border">
        <View class="flex-row flex-wrap items-center gap-2">
          <Input
            testID="slowlog-filter"
            accessibilityLabel={s("filter")}
            value={state.query()}
            placeholder={s("filter")}
            onChange={({ value }) => state.query.set(value)}
            class="flex-1 min-w-[160px] h-8 px-2 text-(--text-size-12)/(--line-height-16) text-foreground border border-border rounded bg-background focus:border-ring"
          />
          <Select
            testID="slowlog-count"
            accessibilityLabel={s("count")}
            value={String(state.count())}
            disabled={state.busy()}
            items={[10, 50, 100, 200].map((value) => ({
              value: String(value),
              title: s("latest", { count: value }),
            }))}
            onChange={({ value }) => {
              if (value !== null) state.count.set(Number(value));
            }}
            popupClass="rounded-md border border-border-strong bg-popover p-1 shadow-xl"
            itemClass="h-8 px-2 text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent"
            trigger={
              <View
                testID="slowlog-count-trigger"
                class="h-8 px-3 justify-center rounded border border-border bg-background"
              >
                <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">
                  {s("latest", { count: state.count() })}
                </Text>
              </View>
            }
            renderItem={(item) => (
              <Text
                testID={"slowlog-count-" + item.value}
                class="text-(--text-size-12)/(--line-height-16) text-foreground"
              >
                {item.title}
              </Text>
            )}
          />
          <Action
            testID="slowlog-refresh"
            label={s(state.busy() ? "loading" : "refresh")}
            primary
            disabled={state.busy()}
            onPress={() => void state.refresh()}
          />
        </View>
        <Text class="text-(--text-size-11) text-muted-foreground">{s("hint")}</Text>
        <If when={!!state.snapshot()}>
          <Text
            testID="slowlog-summary"
            class="text-(--text-size-11) text-muted-foreground"
          >
            {s("summary", {
              shown: state.rows().length,
              fetched: state.snapshot()?.entries.length,
              total: state.snapshot()?.total ?? "-",
            })}
            {" · "}
            {state.snapshot()?.scope === "node"
              ? s("node", { address: state.snapshot()?.nodeAddress ?? "-" })
              : s("server")}
          </Text>
        </If>
        <If when={!!state.error()}>
          <Text testID="slowlog-error" class="text-(--text-size-12)/(--line-height-16) text-destructive">
            {state.error()}
          </Text>
        </If>
      </View>
      <If when={state.busy() && !state.rows().length}>
        <View class="flex-1 items-center justify-center">
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">{s("loading")}</Text>
        </View>
      </If>
      <If when={!state.busy() && !!state.snapshot() && !state.rows().length}>
        <View class="flex-1 items-center justify-center gap-2 px-6">
          <Text testID="slowlog-empty" class="text-(--text-size-14)/(--line-height-20) text-muted-foreground">
            {s(state.query().trim() ? "noMatches" : "empty")}
          </Text>
        </View>
      </If>
      <If when={!state.busy() && !state.snapshot() && !!state.error()}>
        <View class="flex-1 items-center justify-center px-6">
          <Text class="text-(--text-size-14)/(--line-height-20) text-muted-foreground">{s("unavailable")}</Text>
        </View>
      </If>
      <If when={!!state.rows().length}>
        <List
          each={state.rows()}
          keyExtractor={(entry) => entry.id}
          estimatedItemSize={84}
          class="flex-1 min-h-0"
          contentClass="px-6 py-2"
        >
          {(entry) => (
            <View
              testID={"slowlog-entry-" + entry().id}
              class="py-3 gap-2 border-b border-border/50"
            >
              <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
                <Text class="text-(--text-size-14)/(--line-height-20) font-semibold font-mono text-foreground">
                  {slowlogDuration(entry().durationMicroseconds)}
                </Text>
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {slowlogTime(entry().timestampSeconds)}
                </Text>
                <Text class="text-(--text-size-11) font-mono text-faint">
                  #{entry().id}
                </Text>
                <View class="flex-1" />
                <Action
                  testID={"slowlog-copy-" + entry().id}
                  label={s("copy")}
                  icon="copy"
                  compact
                  onPress={() => void copy(slowlogCommand(entry()))}
                />
              </View>
              <Button
                testID={"slowlog-toggle-" + entry().id}
                onPress={() =>
                  state.selected.set(
                    state.selected() === entry().id ? undefined : entry().id,
                  )
                }
                class="flex-row items-center gap-2 rounded hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring"
              >
                <Text class="flex-1 min-w-0 font-mono text-(--text-size-12)/(--line-height-16) text-foreground line-clamp-2">
                  {slowlogCommand(entry())}
                </Text>
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {s(state.selected() === entry().id ? "collapse" : "details")}
                </Text>
              </Button>
              <If when={state.selected() === entry().id}>
                <View class="p-3 gap-2 rounded bg-background">
                  <Text class="text-(--text-size-11) text-muted-foreground">
                    {s("clientAddress")}:{" "}
                    {slowlogBytes(entry().clientAddress) || "-"}
                  </Text>
                  <Text class="text-(--text-size-11) text-muted-foreground">
                    {s("clientName")}: {slowlogBytes(entry().clientName) || "-"}
                  </Text>
                  <Text class="text-(--text-size-11) text-muted-foreground">
                    {s("arguments")}
                    {entry().argumentCount
                      ? " · " +
                        entry().arguments.length +
                        "/" +
                        entry().argumentCount
                      : ""}
                  </Text>
                  <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">
                    {entry()
                      .arguments.map(
                        (argument, index) =>
                          String(index + 1) + ". " + slowlogArgument(argument),
                      )
                      .join("\n")}
                  </Text>
                </View>
              </If>
            </View>
          )}
        </List>
      </If>
      <View class="px-6 py-3 border-t border-border">
        <Text class="text-(--text-size-10) text-faint">{s("snapshotHint")}</Text>
      </View>
    </Modal>
  );
}
