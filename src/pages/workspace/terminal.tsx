import {
  computed,
  effect,
  keymap,
  signal,
  Scroll,
  List,
  Text,
  token,
  View,
  windowSize,
  type InputRef,
  type ListRef,
  type ScrollRef,
} from "nsh";
import { Button, Input } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { createConsoleState, type ConsoleState } from "./console-state";
import {
  consoleCompletions,
  consoleParameterHint,
  insertCompletion,
  type Completion,
} from "./console-values";
import { ConsoleParameterHint } from "./console-parameter-hint";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";
export { createConsoleState };

export function Terminal(props: {
  state: WorkspaceState;
  console: ConsoleState;
  endpoint: string;
  active: boolean;
}) {
  const state = props.state,
    console = props.console;
  const input = signal<InputRef>(),
    output = signal<ScrollRef>(),
    list = signal<ListRef>();
  const focused = signal(false),
    composing = signal(false),
    cursor = signal(0),
    selected = signal(0),
    dismissed = signal(false),
    forced = signal(false);
  const suggestions = computed(() =>
    focused() &&
    !composing() &&
    !console.busy() &&
    !dismissed() &&
    (console.input().length > 0 || forced())
      ? consoleCompletions(console.input(), cursor(), console.commands())
      : [],
  );
  const parameterHint = computed(() =>
    consoleParameterHint(console.input(), cursor(), console.commands()),
  );
  const parameterLoading = () => {
    const hint = parameterHint();
    return (
      !!hint &&
      (console.descriptionStatus()[hint.commandName] ?? "loading") === "loading"
    );
  };
  const candidate = () =>
    suggestions()[Math.min(selected(), suggestions().length - 1)];
  effect(() => {
    const ref = input();
    if (props.active && ref) ref.focus();
  });
  effect(() => {
    if (!props.active) return;
    void console.loadCatalog();
    console.drain();
    const timer = setInterval(() => console.drain(), 200);
    return () => clearInterval(timer);
  });
  effect(() => {
    const value = console.input();
    // A refreshed catalog can replace a module's schema while its draft stays open.
    console.commands();
    if (!props.active || composing()) return;
    const timer = setTimeout(() => void console.describe(value), 150);
    return () => clearTimeout(timer);
  });
  function changed(value: string) {
    console.input.set(value);
    cursor.set(value.length);
    selected.set(0);
    dismissed.set(false);
    forced.set(false);
  }
  function complete(item = candidate()) {
    if (!item) {
      forced.set(true);
      return;
    }
    const next = insertCompletion(console.input(), item);
    console.input.set(next.value);
    cursor.set(next.cursor);
    selected.set(0);
    dismissed.set(true);
    forced.set(false);
    input()?.focus();
    setTimeout(() => input()?.setSelection(next.cursor), 0);
  }
  function move(direction: -1 | 1) {
    if (suggestions().length) {
      selected.set(
        (selected() + direction + suggestions().length) % suggestions().length,
      );
      list()?.scrollToIndex({ index: selected(), animated: false });
    } else {
      console.recall(direction);
      cursor.set(console.input().length);
      input()?.setSelection(cursor());
      dismissed.set(true);
    }
  }
  async function run() {
    dismissed.set(true);
    forced.set(false);
    await console.execute();
    output()?.scrollToEnd({ animated: false });
    input()?.focus();
  }
  effect(() => {
    if (!props.active || !focused() || composing()) return;
    if (console.busy() || console.streaming())
      return keymap.bind("ctrl+c", () => void console.stop(), {
        when: "always",
        forFocus: true,
      });
  });
  effect(() => {
    if (
      !props.active ||
      !focused() ||
      composing() ||
      console.busy() ||
      console.monitoring()
    )
      return;
    return keymap.bind(
      { tab: () => complete(), up: () => move(-1), down: () => move(1) },
      { when: "always", forFocus: true, repeat: true },
    );
  });
  effect(() => {
    if (!props.active || !focused() || composing() || !suggestions().length)
      return;
    return keymap.bind(
      "escape",
      () => {
        dismissed.set(true);
        forced.set(false);
      },
      { when: "always", forFocus: true },
    );
  });
  return (
    <View testID="workspace-console" class="flex-1 min-h-0 bg-workspace">
      <View class="min-h-8 px-3 py-1 flex-row items-center gap-2 border-b border-border">
        <Icon name="terminal" size={14} color={token("success")} />
        <Text class="text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
          {w("consoleTitle")}
        </Text>
        <Text
          testID="workspace-console-database"
          class="text-(--text-size-10) font-mono text-success"
        >
          CLI DB{console.targetDatabase()}
        </Text>
        <View class="flex-1" />
        <Action
          testID="workspace-console-reload-commands"
          label={w("consoleReloadCommands")}
          icon="refresh"
          compact
          disabled={console.catalogSource() === "loading"}
          onPress={() => void console.loadCatalog(true)}
        />
        {(console.busy() || console.connection()) && (
          <Action
            testID="workspace-console-stop"
            label={w(console.stopping() ? "loading" : "consoleStop")}
            compact
            disabled={console.stopping()}
            onPress={() => void console.stop()}
          />
        )}
        <Action
          label={w("clear")}
          compact
          onPress={() => console.history.set([])}
        />
      </View>
      <Scroll
        ref={(ref) => output.set(ref)}
        class="flex-1 min-h-0"
        contentClass="p-3 gap-3"
      >
        <Text class="text-(--text-size-10) text-faint">{w("consoleHelp")}</Text>
        {console.history().map((row) => (
          <View
            testID={`workspace-console-row-${row.id}`}
            selectable
            class="gap-1"
          >
            {!!row.command && (
              <Text class="text-(--text-size-11) font-mono text-foreground">
                <Text class="text-success">
                  {row.endpoint || props.endpoint}[{row.database}]&gt;{" "}
                </Text>
                {row.command}
              </Text>
            )}
            <Text
              class={`text-(--text-size-11) font-mono leading-(--line-height-16) ${row.failed ? "text-destructive" : "text-steel"}`}
            >
              {row.output}
            </Text>
          </View>
        ))}
      </Scroll>
      {suggestions().length > 0 && (
        <View
          testID="workspace-console-completions"
          class="shrink-0 border-t border-border"
        >
          <View class="h-6 px-3 flex-row items-center gap-2">
            <Text class="text-(--text-size-10) text-faint">{w("consoleComplete")}</Text>
            <View class="flex-1" />
            <Text class="text-(--text-size-10) text-faint">↑↓ · Tab · Esc</Text>
          </View>
          <List
            ref={(ref) => list.set(ref)}
            each={suggestions()}
            keyExtractor={(item: Completion) => item.id}
            style={{
              height:
                Math.min(
                  suggestions().length,
                  windowSize().height < 600 ? 3 : 5,
                ) * 28,
            }}
            estimatedItemSize={28}
          >
            {(item: () => Completion) => (
              <Button
                testID={`workspace-console-completion-${item().label.replace(/\W/g, "-")}`}
                accessibilityLabel={`${w("consoleComplete")} ${item().label}`}
                onPress={() => complete(item())}
                class={`h-7 px-3 flex-row items-center gap-3 active:opacity-70 focus:ring-1 focus:ring-ring ${item().id === candidate()?.id ? "bg-selected" : "hover:bg-accent"}`}
              >
                <Text class="text-(--text-size-11) font-mono text-foreground">
                  {item().label}
                </Text>
                <Text
                  style={{ numberOfLines: 1 }}
                  class="flex-1 min-w-0 text-right text-(--text-size-10) text-faint"
                >
                  {item().kind === "keyword"
                    ? item().detail || w("consoleOption")
                    : item().detail}
                </Text>
              </Button>
            )}
          </List>
        </View>
      )}
      <View class="shrink-0 px-3 py-1 gap-1 border-t border-border">
        <ConsoleParameterHint
          hint={parameterHint()}
          loading={
            parameterHint()?.mode === "unavailable" && parameterLoading()
          }
        />
        <View class="h-8 flex-row items-center gap-2">
          <Text class="text-(--text-size-10) text-success font-mono">
            DB{console.targetDatabase()}&gt;
          </Text>
          <Input
            ref={(ref) => input.set(ref)}
            testID="workspace-console-command"
            accessibilityLabel={w("consoleTitle")}
            value={console.input()}
            readonly={
              console.busy() ||
              console.stopping() ||
              console.monitoring() ||
              state.switching()
            }
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            onCompositionChange={({ composing: value }) => composing.set(value)}
            onSelectionChange={({ start }) => {
              cursor.set(start);
              selected.set(0);
            }}
            onChange={({ value }) => changed(value)}
            onSubmit={() => void run()}
            placeholder={w("consolePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={65536}
            submitBehavior="submit"
            class="flex-1 min-w-0 h-8 rounded bg-inset px-2 text-(--text-size-11) font-mono text-foreground"
          />
          <Action
            testID="workspace-console-run"
            label={w(console.busy() ? "loading" : "run")}
            compact
            disabled={
              console.busy() ||
              console.stopping() ||
              console.monitoring() ||
              state.switching()
            }
            onPress={() => void run()}
          />
        </View>
        <Text class="text-(--text-size-10) text-faint">
          {w(
            console.catalogSource() === "server"
              ? "consoleServerCatalog"
              : console.catalogSource() === "loading"
                ? "consoleCatalogLoading"
                : "consoleOfflineCatalog",
          )}
        </Text>
      </View>
    </View>
  );
}
