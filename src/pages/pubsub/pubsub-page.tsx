import {
  computed,
  effect,
  keymap,
  List,
  Scroll,
  signal,
  Text,
  token,
  View,
  windowSize,
  type InputRef,
  type ListRef,
} from "nsh";
import { Button, Input, Select, type EditorRef } from "nsh/base";
import { Redis } from "ferrix/native";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import type { ConnectionHub } from "../../data/connections/connection-state";
import { address, endpoints } from "../../data/connections/connection-model";
import { useClipboardCopy } from "../../utils/clipboard";
import { safeError } from "../../utils/errors";
import {
  createPubSubState,
  p,
  type Message,
  type PubSubSession,
  type PubSubState,
} from "./pubsub-state";
import { encode, isJson, json, size, text, unhex } from "./pubsub-values";
import { PubSubPayload } from "./pubsub-payload";

export function PubSubPage(props: {
  hub: ConnectionHub;
  active: boolean;
  onConnections: () => void;
}) {
  return (
    <View testID="pubsub-page" class="flex-1 min-w-0 min-h-0 bg-workspace">
      {!props.hub.live().length ? (
        <View class="flex-1 items-center justify-center gap-4 p-6">
          <Icon name="broadcast" size={40} />
          <Text class="text-(--text-size-18)/(--line-height-28) text-foreground">{p("noSession")}</Text>
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
            {p("noSessionHint")}
          </Text>
          <Action
            label={p("connections")}
            primary
            onPress={props.onConnections}
          />
        </View>
      ) : (
        <>
          {props.hub.live().length > 1 && (
            <Scroll
              horizontal
              class="h-9 shrink-0 border-b border-border/40"
              contentClass="flex-row items-center px-2 gap-1"
            >
              {props.hub.live().map((live) => (
                <Action
                  label={live.name}
                  icon="server"
                  compact
                  selected={live.id === props.hub.activeId()}
                  onPress={() => props.hub.activeId.set(live.id)}
                />
              ))}
            </Scroll>
          )}
          <Each of={props.hub.live()} key={(live) => live.session}>
            {(live) => (
              <View
                class={`flex-1 min-w-0 min-h-0 ${props.hub.activeId() === live().id ? "flex" : "hidden"}`}
              >
                <PubSubPanel
                  session={live().session}
                  name={live().name}
                  endpoint={endpoints(live().configuration.config)
                    .map(address)
                    .join(", ")}
                  active={props.active && props.hub.activeId() === live().id}
                />
              </View>
            )}
          </Each>
        </>
      )}
    </View>
  );
}

export function PubSubPanel(props: {
  session: PubSubSession;
  name: string;
  endpoint: string;
  active: boolean;
}) {
  const state = createPubSubState(props.session),
    search = signal(""),
    channelSearch = signal(""),
    regex = signal(false),
    autoScroll = signal(true),
    sidebar = signal(false),
    newChannel = signal(""),
    pattern = signal(false),
    exporting = signal(false),
    saved = signal(false);
  let channelInput: InputRef | undefined, stream: ListRef | undefined;
  const narrow = () => windowSize().width < 900;
  const matcher = computed(() => {
    if (!regex()) return undefined;
    try {
      return new RegExp(search(), "i");
    } catch {
      return null;
    }
  });
  const filtered = computed(() =>
    state
      .messages()
      .filter((message) => {
        const selectedChannel = state
          .subscriptions()
          .find((item) => item.id === state.channel());
        if (
          selectedChannel &&
          (selectedChannel.pattern
            ? text(message.pattern ?? new Uint8Array()) !== selectedChannel.name
            : message.channelName !== selectedChannel.name)
        )
          return false;
        if (!search()) return true;
        const haystack = `${message.channelName}\n${message.payloadText}`;
        return regex()
          ? matcher()?.test(haystack) === true
          : haystack.toLocaleLowerCase().includes(search().toLocaleLowerCase());
      })
      .reverse(),
  );
  effect(() => {
    state.messages();
    if (props.active && autoScroll())
      stream?.scrollToOffset({ offset: 0, animated: false });
  });
  async function subscribe() {
    const name = newChannel(),
      mode = pattern();
    if (
      (await state.subscribe(name, mode)) &&
      newChannel() === name &&
      pattern() === mode
    ) {
      newChannel.set("");
      sidebar.set(false);
    }
  }
  function focusSubscribe() {
    sidebar.set(true);
    channelInput?.focus();
  }
  effect(() => {
    if (!props.active) return;
    return keymap.bind(
      { "mod+n": focusSubscribe, "mod+enter": () => void state.publish() },
      { when: "always" },
    );
  });
  async function exportLogs() {
    if (exporting()) return;
    exporting.set(true);
    saved.set(false);
    state.error.set("");
    try {
      if (await Redis.exportPubSubLogs(state.exportData())) saved.set(true);
    } catch (cause) {
      state.error.set(safeError(cause));
    } finally {
      exporting.set(false);
    }
  }
  return (
    <View testID="pubsub-panel" class="flex-1 min-w-0 min-h-0 bg-workspace">
      <View class="shrink-0 flex-row flex-wrap items-center gap-2 px-3 py-2 border-b border-border/40">
        <Icon name="broadcast" color={token("code-string")} size={21} />
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">{p("title")}</Text>
        {!narrow() && (
          <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-muted-foreground">
            / Publish & Subscribe Hub
          </Text>
        )}
        <View class="flex-1" />
        {narrow() && (
          <Action
            testID="pubsub-toggle-channels"
            label={p("channels")}
            icon="sidebar"
            compact
            selected={sidebar()}
            onPress={() => sidebar.set(!sidebar())}
          />
        )}
        <Action
          testID="pubsub-autoscroll"
          label={p(autoScroll() ? "autoOn" : "autoOff")}
          icon="download"
          compact
          selected={autoScroll()}
          onPress={() => autoScroll.set(!autoScroll())}
        />
        <Action
          testID="pubsub-clear"
          label={p("clear")}
          icon="trash"
          compact
          disabled={!state.messages().length && !state.queued()}
          onPress={state.clear}
        />
        {!narrow() && (
          <Action
            testID="pubsub-export"
            label={p(exporting() ? "exporting" : "export")}
            icon="download"
            compact
            disabled={exporting() || !state.messages().length}
            onPress={() => void exportLogs()}
          />
        )}
      </View>
      <View class="shrink-0 h-8 flex-row items-center px-3 gap-2 border-b border-border/30">
        <Dot color={token(state.closed() ? "destructive" : "success")} />
        <Text
          class={`text-(--text-size-11) font-mono ${state.closed() ? "text-destructive" : "text-success"}`}
        >
          {p(
            state.closed()
              ? "disconnected"
              : state.paused()
                ? "paused"
                : state.subscriptions().length
                  ? "streaming"
                  : "ready",
          )}
        </Text>
        <Text class="text-(--text-size-11) font-mono text-muted-foreground">
          {state.subscriptions().length} {p("activeChannels")}
        </Text>
        <View class="flex-1" />
        <Text
          class="text-(--text-size-11) font-mono text-muted-foreground"
          style={{ numberOfLines: 1 }}
        >
          {props.name} · {props.endpoint}
        </Text>
        {state.closed() && (
          <Action
            testID="pubsub-reconnect"
            label={p("reconnect")}
            icon="refresh"
            compact
            disabled={state.busy()}
            onPress={() => void state.reconnect()}
          />
        )}
      </View>
      {(state.uncertain() ||
        !!state.error() ||
        saved() ||
        matcher() === null) && (
        <View class="shrink-0 flex-row items-center px-3 py-2 gap-2 border-b border-border/40">
          <Text
            testID="pubsub-feedback"
            class={`flex-1 text-(--text-size-12)/(--line-height-16) ${state.uncertain() || state.error() || matcher() === null ? "text-destructive" : "text-success"}`}
          >
            {state.uncertain()
              ? p("unknownWrite")
              : state.error() ||
                (matcher() === null ? p("invalidRegex") : p("exported"))}
          </Text>
          {state.uncertain() && (
            <Action
              testID="pubsub-acknowledge"
              label={p("allowNewPublish")}
              compact
              onPress={() => {
                state.uncertain.set(false);
                state.error.set("");
              }}
            />
          )}
        </View>
      )}
      <View class="flex-1 min-h-0 min-w-0 flex-row gap-1 p-1">
        <View
          testID="pubsub-channels"
          class={`shrink-0 rounded border border-border/40 overflow-hidden ${narrow() && !sidebar() ? "hidden" : "flex flex-col"}`}
          style={{ width: narrow() ? "100%" : 270 }}
        >
          <View class="px-3 pt-3 pb-2 gap-2">
            <View class="flex-row items-center justify-between">
              <Text class="text-(--text-size-11) font-semibold text-muted-foreground">
                {p("subscribed")} ({state.subscriptions().length})
              </Text>
              <Text class="text-(--text-size-11) font-mono text-success">
                {state.rate()} msg/s
              </Text>
            </View>
            <Input
              testID="pubsub-channel-filter"
              accessibilityLabel={p("channelFilter")}
              value={channelSearch()}
              onChange={({ value }) => channelSearch.set(value)}
              placeholder={p("channelFilter")}
              class="h-8 rounded px-2 text-(--text-size-12)/(--line-height-16) text-foreground bg-inset focus:ring-1 focus:ring-ring"
            />
          </View>
          <Scroll class="flex-1 min-h-0" contentClass="p-1 gap-1">
            <Button
              testID="pubsub-channel-all"
              accessibilityLabel={p("allChannels")}
              onPress={() => state.channel.set(undefined)}
              class={`h-8 flex-row items-center px-2 rounded hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring ${!state.channel() ? "bg-selected" : "bg-transparent"}`}
            >
              <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">{p("allChannels")}</Text>
            </Button>
            <Each
              of={state
                .subscriptions()
                .filter((item) =>
                  item.name
                    .toLocaleLowerCase()
                    .includes(channelSearch().toLocaleLowerCase()),
                )}
              key={(item) => item.id}
            >
              {(item) => (
                <View
                  class={`rounded ${state.channel() === item().id ? "bg-selected" : ""}`}
                >
                  <View class="flex-row items-center pl-2">
                    <Button
                      testID={`pubsub-channel-${item().name}`}
                      accessibilityLabel={item().name}
                      onPress={() => {
                        state.channel.set(item().id);
                        if (!item().pattern) state.target.set(item().name);
                      }}
                      class="flex-1 min-w-0 py-3 gap-2 hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring rounded"
                    >
                      <View class="flex-row items-center gap-2">
                        <Dot
                          color={token(state.closed() ? "faint" : "success")}
                        />
                        <Text
                          class="flex-1 text-(--text-size-12)/(--line-height-16) font-mono font-semibold text-foreground"
                          style={{ numberOfLines: 1 }}
                        >
                          {item().name}
                        </Text>
                      </View>
                      <View class="flex-row items-center gap-2 pl-3.5">
                        <Text
                          class={`text-(--text-size-10) font-mono ${item().pattern ? "text-steel" : "text-code-string"}`}
                        >
                          {item().pattern ? "PSUB" : "SUB"}
                        </Text>
                        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
                          {item().count} {p("messages")}
                        </Text>
                      </View>
                    </Button>
                    <IconButton
                      testID={`pubsub-unsubscribe-${item().name}`}
                      label={p("unsubscribe", { name: item().name })}
                      icon="close"
                      disabled={state.busy() || state.closed()}
                      onPress={() => void state.unsubscribe(item())}
                    />
                  </View>
                </View>
              )}
            </Each>
            {!state.subscriptions().length && (
              <View class="p-4 gap-2">
                <Icon name="broadcast" size={24} />
                <Text class="text-(--text-size-12) text-muted-foreground leading-(--line-height-20)">
                  {p("emptySubscriptions")}
                </Text>
              </View>
            )}
          </Scroll>
          <View class="shrink-0 p-3 gap-2 border-t border-border/40">
            <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
              {p("quickSubscribe")}
            </Text>
            <View class="flex-row gap-1">
              <Action
                testID="pubsub-mode-sub"
                label="SUB"
                compact
                selected={!pattern()}
                onPress={() => pattern.set(false)}
              />
              <Action
                testID="pubsub-mode-psub"
                label="PSUB"
                compact
                selected={pattern()}
                onPress={() => pattern.set(true)}
              />
              <View class="flex-1" />
              {narrow() && (
                <IconButton
                  testID="pubsub-export"
                  label={p("export")}
                  icon="download"
                  disabled={exporting() || !state.messages().length}
                  onPress={() => void exportLogs()}
                />
              )}
            </View>
            <Input
              ref={(ref) => {
                channelInput = ref;
              }}
              testID="pubsub-new-channel"
              accessibilityLabel={p("channelName")}
              value={newChannel()}
              onChange={({ value }) => newChannel.set(value)}
              onSubmit={() => void subscribe()}
              placeholder={pattern() ? "events:*" : "events:order:created"}
              class="h-9 rounded px-2 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-inset focus:ring-1 focus:ring-ring"
            />
            <Action
              testID="pubsub-subscribe"
              label={p(state.busy() ? "subscribing" : "subscribe")}
              icon="plus"
              primary
              disabled={state.busy() || state.closed() || !newChannel().length}
              onPress={() => void subscribe()}
            />
          </View>
        </View>
        <View
          class={`flex-1 min-w-0 min-h-0 ${narrow() && sidebar() ? "hidden" : "flex flex-col"}`}
        >
          <View class="shrink-0 flex-row flex-wrap items-center gap-2 p-2">
            <Icon name="search" size={15} />
            <Input
              testID="pubsub-search"
              accessibilityLabel={p("search")}
              value={search()}
              onChange={({ value }) => search.set(value)}
              placeholder={p("search")}
              class="flex-1 min-w-0 h-8 px-2 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-inset rounded focus:ring-1 focus:ring-ring"
            />
            <Action
              testID="pubsub-regex"
              label=".*"
              compact
              selected={regex()}
              onPress={() => regex.set(!regex())}
            />
            <Text
              testID="pubsub-received"
              class="text-(--text-size-10) font-mono text-muted-foreground"
            >
              {p("received", { count: state.received() })}
            </Text>
            <Action
              testID="pubsub-pause"
              label={p(state.paused() ? "resume" : "pause")}
              icon={state.paused() ? "play" : "pause"}
              compact
              selected={state.paused()}
              onPress={() => state.paused.set(!state.paused())}
            />
          </View>
          <View class="shrink-0 h-7 flex-row items-center px-2 gap-3 border-b border-border/40">
            {!narrow() && (
              <Text class="w-24 text-(--text-size-10) font-mono text-muted-foreground">
                {p("time")}
              </Text>
            )}
            {windowSize().width >= 1100 && (
              <Text class="w-24 text-(--text-size-10) font-mono text-muted-foreground">
                TYPE
              </Text>
            )}
            <Text
              class={`${narrow() ? "w-32" : "w-44"} text-(--text-size-10) font-mono text-muted-foreground`}
            >
              {p("channel")}
            </Text>
            <Text class="flex-1 text-(--text-size-10) font-mono text-muted-foreground">
              {p("payload")}
            </Text>
            <Text class="w-14 text-(--text-size-10) font-mono text-muted-foreground text-right">
              {p("size")}
            </Text>
          </View>
          <List
            ref={(ref) => {
              stream = ref;
            }}
            testID="pubsub-messages"
            each={filtered()}
            keyExtractor={(item) => item.id}
            estimatedItemSize={36}
            class="flex-1 min-h-0 bg-workspace"
            empty={() => (
              <View class="items-center justify-center gap-3 p-8">
                <Icon name="broadcast" size={30} />
                <Text class="text-(--text-size-14)/(--line-height-20) text-foreground">
                  {p(state.messages().length ? "noMatches" : "waiting")}
                </Text>
                <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                  {p("waitingHint")}
                </Text>
              </View>
            )}
          >
            {(item) => (
              <View>
                <Button
                  testID={`pubsub-message-${item().id}`}
                  accessibilityLabel={`${item().channelName}, ${item().id}`}
                  onPress={() => {
                    state.selected.set(
                      state.selected() === item().id ? undefined : item().id,
                    );
                    autoScroll.set(false);
                  }}
                  class={`h-9 flex-row items-center px-2 gap-3 hover:bg-selected active:opacity-70 focus:ring-1 focus:ring-ring ${state.selected() === item().id ? "bg-selected" : "bg-transparent"}`}
                >
                  {!narrow() && (
                    <Text class="w-24 text-(--text-size-10) font-mono text-muted-foreground">
                      {timestamp(item().timestampMs)}
                    </Text>
                  )}
                  {windowSize().width >= 1100 && (
                    <Text
                      class={`w-24 text-(--text-size-10) font-mono ${item().pattern ? "text-steel" : "text-code-string"}`}
                    >
                      {item().pattern ? "PMESSAGE" : "MESSAGE"}
                    </Text>
                  )}
                  <Text
                    class={`${narrow() ? "w-32" : "w-44"} text-(--text-size-11) font-mono font-semibold text-foreground`}
                    style={{ numberOfLines: 1 }}
                  >
                    {item().channelName}
                  </Text>
                  <Text
                    class={`flex-1 min-w-0 text-(--text-size-11) font-mono ${isJson(item().payloadText) ? "text-steel" : "text-muted-foreground"}`}
                    style={{ numberOfLines: 1 }}
                  >
                    {item().binary
                      ? `0x${item().payloadText}`
                      : item().payloadText.replace(/\s+/g, " ")}
                  </Text>
                  <Text class="w-14 text-(--text-size-10) font-mono text-muted-foreground text-right">
                    {size(item().payload.length)}
                  </Text>
                </Button>
                {state.selected() === item().id && (
                  <MessageDetail message={item()} state={state} />
                )}
              </View>
            )}
          </List>
          <Publisher state={state} />
        </View>
      </View>
      <View class="shrink-0 flex-row flex-wrap items-center px-3 py-1 gap-3 border-t border-border/40">
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {p("buffer", { count: state.messages().length })}
        </Text>
        <Text
          testID="pubsub-dropped"
          class={`text-(--text-size-10) font-mono ${Number(state.dropped()) ? "text-destructive" : "text-muted-foreground"}`}
        >
          {p("dropped", { count: state.dropped() })}
        </Text>
        {!!state.evicted() && (
          <Text class="text-(--text-size-10) font-mono text-muted-foreground">
            {p("evicted", { count: state.evicted() })}
          </Text>
        )}
        <View class="flex-1" />
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {p("databaseIndependent")}
        </Text>
      </View>
    </View>
  );
}

function timestamp(value: string) {
  const date = new Date(Number(value));
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date.getMilliseconds().toString().padStart(3, "0")}`;
}

function MessageDetail(props: { message: Message; state: PubSubState }) {
  const copy = useClipboardCopy();
  const formatted = () =>
    !props.message.binary ? json(props.message.payloadText) : undefined;
  return (
    <View
      testID="pubsub-detail"
      class="m-2 p-2 gap-2 rounded border border-border/40"
      style={{
        height: Math.max(170, Math.min(300, windowSize().height * 0.33)),
      }}
    >
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="text-(--text-size-11) font-semibold text-muted-foreground">
          {props.message.binary
            ? "HEX PAYLOAD"
            : formatted() !== undefined
              ? "STRUCTURED JSON PAYLOAD"
              : "TEXT PAYLOAD"}
        </Text>
        {formatted() !== undefined && (
          <Text class="text-(--text-size-10) font-mono text-success">Valid JSON</Text>
        )}
        <View class="flex-1" />
        <Action
          testID="pubsub-copy-payload"
          label={p("copy")}
          icon="copy"
          compact
          onPress={() => void copy(formatted() ?? props.message.payloadText)}
        />
        <Action
          testID="pubsub-load-publisher"
          label={p("loadPublisher")}
          icon="back"
          compact
          disabled={
            props.state.publishing() ||
            text(props.message.channel) === undefined
          }
          onPress={() => props.state.load(props.message)}
        />
      </View>
      {!!props.message.pattern && (
        <Text class="text-(--text-size-10) font-mono text-steel">
          PSUB: {text(props.message.pattern) ?? "HEX"}
        </Text>
      )}
      <PubSubPayload
        testID="pubsub-payload"
        value={formatted() ?? props.message.payloadText}
        readOnly
        json={formatted() !== undefined}
      />
    </View>
  );
}

function Publisher(props: { state: PubSubState }) {
  const state = props.state;
  let editor: EditorRef | undefined;
  const template = signal("custom");
  const templates: Record<string, string> = {
    order:
      '{\n  "event": "order.created",\n  "order_id": "",\n  "amount": 0\n}',
    cache: '{\n  "event": "cache.invalidate",\n  "key": ""\n}',
    chat: '{\n  "sender": "",\n  "text": ""\n}',
  };
  const validJson = () => state.encoding() === "utf8" && isJson(state.draft());
  function transform(compact: boolean) {
    const next = json(state.draft(), compact);
    if (next !== undefined) state.draft.set(next);
  }
  return (
    <View
      testID="pubsub-publisher"
      class="shrink-0 p-2 gap-2 border-t border-border/50"
    >
      <View class="flex-row flex-wrap items-center gap-2">
        <Icon name="send" color={token("code-string")} size={16} />
        <Text class="text-(--text-size-11) font-semibold text-code-string">
          {p("publishConsole")}
        </Text>
        <Input
          testID="pubsub-target"
          accessibilityLabel={p("target")}
          value={state.target()}
          onChange={({ value }) => {
            state.target.set(value);
            state.published.set(undefined);
          }}
          placeholder={p("target")}
          class="h-8 flex-1 min-w-0 rounded px-2 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-inset focus:ring-1 focus:ring-ring"
        />
        <IconButton
          testID="pubsub-edit-draft"
          label={p("editPayload")}
          icon="pencil"
          disabled={state.publishing()}
          onPress={() => editor?.focus()}
        />
        {windowSize().width >= 1100 && (
          <Select
            testID="pubsub-template"
            accessibilityLabel={p("template")}
            value={template()}
            disabled={state.publishing()}
            items={[
              { value: "custom", title: p("custom") },
              { value: "order", title: p("orderTemplate") },
              { value: "cache", title: p("cacheTemplate") },
              { value: "chat", title: p("chatTemplate") },
            ]}
            onChange={({ value }) => {
              if (value) {
                template.set(value);
                if (templates[value]) {
                  state.encoding.set("utf8");
                  state.draft.set(templates[value]);
                  state.published.set(undefined);
                }
              }
            }}
            popupClass="bg-panel border border-border rounded p-1"
            itemClass="h-8 px-3 text-(--text-size-12)/(--line-height-16) text-foreground selected:bg-selected focus:bg-selected"
            trigger={
              <View class="h-8 flex-row items-center gap-2 px-2 rounded bg-inset">
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {p(
                    template() === "custom"
                      ? "template"
                      : `${template()}Template`,
                  )}
                </Text>
                <Icon name="down" size={12} />
              </View>
            }
          />
        )}
        <Action
          testID="pubsub-format"
          label={p("format")}
          icon="braces"
          compact
          disabled={!validJson() || state.publishing()}
          onPress={() => transform(false)}
        />
        <Action
          testID="pubsub-minify"
          label={p("minify")}
          compact
          disabled={!validJson() || state.publishing()}
          onPress={() => transform(true)}
        />
      </View>
      <View
        class="flex-row gap-2"
        style={{ height: windowSize().height < 650 ? 88 : 128 }}
      >
        <PubSubPayload
          testID="pubsub-draft"
          onReady={(ref) => {
            editor = ref;
          }}
          value={state.draft()}
          onChange={(value) => {
            state.draft.set(value);
            template.set("custom");
            state.published.set(undefined);
          }}
          readOnly={state.publishing()}
          json={validJson()}
        />
        <View class="w-36 justify-center gap-2">
          <Action
            testID="pubsub-publish"
            label={p(state.publishing() ? "publishing" : "publish")}
            icon="send"
            primary
            disabled={
              state.publishing() || state.uncertain() || !state.target().length
            }
            onPress={() => void state.publish()}
          />
          <Text class="text-(--text-size-10) font-mono text-muted-foreground text-center">
            {keymap.label("mod+enter")}
          </Text>
          {state.published() !== undefined && (
            <Text
              testID="pubsub-published"
              class="text-(--text-size-10) text-success text-center"
            >
              {p("published", { count: state.published() })}
            </Text>
          )}
        </View>
      </View>
      <View class="h-5 flex-row items-center gap-2">
        <Select
          testID="pubsub-encoding"
          accessibilityLabel={p("encoding")}
          value={state.encoding()}
          items={[
            { value: "utf8", title: "UTF-8" },
            { value: "hex", title: "HEX" },
          ]}
          onChange={({ value }) => {
            if (value && !state.publishing()) state.encoding.set(value);
          }}
          popupClass="bg-panel border border-border rounded p-1"
          itemClass="h-8 px-3 text-(--text-size-12)/(--line-height-16) text-foreground selected:bg-selected focus:bg-selected"
          trigger={
            <View class="flex-row items-center gap-1">
              <Text class="text-(--text-size-10) font-mono text-muted-foreground">
                {state.encoding() === "utf8" ? "UTF-8" : "HEX"}
              </Text>
              <Icon name="down" size={11} />
            </View>
          }
        />
        <View class="flex-1" />
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {size(
            state.encoding() === "hex"
              ? (unhex(state.draft())?.length ?? 0)
              : encode(state.draft()).length,
          )}{" "}
          · {state.draft().split("\n").length} {p("lines")}
        </Text>
      </View>
    </View>
  );
}
