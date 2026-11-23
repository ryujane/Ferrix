import {
  cleanup,
  effect,
  keymap,
  signal,
  Scroll,
  Text,
  token,
  View,
  windowSize,
  type InputRef,
} from "nsh";
import { Button, Input, ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { useToast } from "../../components/toast";
import { Tooltip } from "../../components/tooltip";
import type {
  ConnectionHub,
  LiveConnection,
} from "../../data/connections/connection-state";
import { address, endpoints } from "../../data/connections/connection-model";
import { defaultPreferences, type Preferences } from "../../data/preferences";
import type { WorkspaceHistory } from "../../data/workspace-history";
import { KeyBrowser } from "./key-browser";
import { CreateKeyDialog } from "./create-key-dialog";
import { KeyExpiryDialog } from "./key-expiry-dialog";
import { CollectionRowDialog } from "./collection-row-dialog";
import { StreamMessageDialog } from "./stream-message-dialog";
import { JsonPathDialog } from "./json-path-dialog";
import { KeyTabMenu, type TabCloseAction } from "./key-tab-menu";
import { KeyInspector, type InspectorAction } from "./key-inspector";
import { Terminal, createConsoleState } from "./terminal";
import { KeyBadge, WorkspaceDialog } from "./workspace-controls";
import {
  createWorkspaceState,
  dirty,
  type WorkspaceSession,
} from "./workspace-state";
import { workspaceT as w } from "./workspace-text";
import { rowIdentity } from "./collection-values";
import { privateCommand } from "./console-values";

export type WorkspaceKeyTarget = {
  session: WorkspaceSession;
  database: number;
  key: Uint8Array;
};

type WorkspaceOptions = {
  preferences?: () => Readonly<Preferences>;
  preferencesReady?: () => boolean;
  history?: WorkspaceHistory;
  registerOperation?: (running: () => boolean) => () => void;
};

export function ConnectedWorkspace(props: WorkspaceOptions & {
  hub: ConnectionHub;
  onConnections: () => void;
  showConsole?: boolean;
  consoleFullscreen?: boolean;
  onConsoleChange?: (show: boolean) => void;
  active?: boolean;
  keyTarget?: WorkspaceKeyTarget;
  onKeyTargetHandled?: (target: WorkspaceKeyTarget) => void;
}) {
  return (
    <View
      testID="connected-workspace"
      class="flex-1 min-w-0 min-h-0 bg-workspace"
    >
      <If when={!props.hub.live().length}>
        <View class="flex-1 justify-center items-center gap-4 p-6">
          <Icon name="database" size={40} />
          <Text class="text-(--text-size-18)/(--line-height-28) text-foreground">{w("noSession")}</Text>
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
            {w("noSessionHint")}
          </Text>
          <Action
            label={w("connections")}
            primary
            onPress={props.onConnections}
          />
        </View>
      </If>
      <If when={props.hub.live().length > 1}>
        <View class="h-9 flex-row items-center px-2 gap-1 border-b border-border/60">
          <Scroll
            horizontal
            class="flex-1 min-w-0 h-9"
            contentClass="flex-row items-center gap-1"
          >
            {props.hub.live().map((live) => (
              <Action
                testID={`workspace-session-${live.id}`}
                label={live.name}
                icon="server"
                compact
                selected={props.hub.activeId() === live.id}
                onPress={() => props.hub.activeId.set(live.id)}
              />
            ))}
          </Scroll>
          <Action
            label={w("connections")}
            icon="network"
            compact
            onPress={props.onConnections}
          />
        </View>
      </If>
      <Each of={props.hub.live()} key={(live) => live.session}>
        {(live) => (
          <View
            class={`flex-1 min-w-0 min-h-0 ${props.hub.activeId() === live().id ? "flex" : "hidden"}`}
          >
            <SessionWorkspace
              live={live()}
              preferences={props.preferences}
              preferencesReady={props.preferencesReady}
              history={props.history}
              registerOperation={props.registerOperation}
              active={
                props.active !== false && props.hub.activeId() === live().id
              }
              showConsole={props.showConsole}
              consoleFullscreen={props.consoleFullscreen}
              onConsoleChange={props.onConsoleChange}
              onDisconnect={() => props.hub.disconnect(live().id)}
              keyTarget={
                props.keyTarget?.session === live().session
                  ? props.keyTarget
                  : undefined
              }
              onKeyTargetHandled={props.onKeyTargetHandled}
            />
          </View>
        )}
      </Each>
    </View>
  );
}

type Pending = {
  kind:
    | Exclude<InspectorAction, "expiry">
    | TabCloseAction
    | "database"
    | "disconnect"
    | "deleteFolder";
  id: string;
  value: string;
  name: string;
  tabIds?: string[];
  keyToOpen?: Uint8Array;
};
export function SessionWorkspace(props: WorkspaceOptions & {
  live: Omit<LiveConnection, "session"> & { session: WorkspaceSession };
  active: boolean;
  showConsole?: boolean;
  consoleFullscreen?: boolean;
  onConsoleChange?: (show: boolean) => void;
  onDisconnect: () => void;
  keyTarget?: WorkspaceKeyTarget;
  onKeyTargetHandled?: (target: WorkspaceKeyTarget) => void;
}) {
  const preferences = props.preferences ?? (() => defaultPreferences);
  const state = createWorkspaceState(props.live.session, useToast(), preferences);
  const console = createConsoleState(state);
  const unregister = props.registerOperation?.(() =>
    console.busy() || console.streaming() || state.mutating(),
  );
  if (unregister) cleanup(unregister);
  const terminalSelected = signal(false),
    sidebarOpen = signal(windowSize().width >= 760),
    pending = signal<Pending>(),
    newKeyPrefix = signal<string>(),
    expiryTabId = signal<string>(),
    rowEditor = signal<{ tabId: string; rowId: string }>(),
    streamCreator = signal<string>(),
    jsonPathAction = signal<{ tabId: string; path: string; remove: boolean }>(),
    bulkFinished = signal(false),
    dialogValue = signal(""),
    dialogError = signal("");
  let search: InputRef | undefined;
  const narrow = () => windowSize().width < 760;
  const endpoint = () =>
    endpoints(props.live.configuration.config).map(address).join(", ");
  const separator = () => props.live.keySeparator();
  const terminalActive = () => props.showConsole ?? terminalSelected();
  const keyBrowserVisible = () =>
    !props.consoleFullscreen && sidebarOpen() && (!narrow() || !terminalActive());
  const initialized = signal(!props.history);
  let initializing = false,
    disposed = false;
  cleanup(() => {
    disposed = true;
  });
  effect(() => {
    if (
      initialized() || initializing || !props.history?.ready() ||
      props.preferencesReady?.() === false
    ) return;
    initializing = true;
    const previous = preferences().restoreTabs
      ? props.history.get(props.live.id)
      : undefined;
    if (!previous) {
      initialized.set(true);
      return;
    }
    void state.restoreWorkspace(previous).finally(() => {
      if (disposed) return;
      if (preferences().restoreTabs) {
        console.restoreDraft(previous.command, previous.consoleDatabase ?? previous.database);
        terminalSelected.set(previous.terminal);
      }
      initialized.set(true);
    });
  });
  effect(() => {
    if (!initialized() || !preferences().restoreTabs || !props.history) return;
    const input = console.input();
    const command = privateCommand(input) ? "" : input;
    props.history.save(props.live.id, {
      database: state.database(),
      tabs: state.tabs().map((tab) => tab.id),
      selected: state.activeId(),
      command,
      consoleDatabase: command ? console.targetDatabase() : undefined,
      terminal: (props.active && props.showConsole === true) || terminalSelected(),
    });
  });
  effect(() => {
    if (
      initialized() &&
      props.active &&
      !props.consoleFullscreen &&
      !state.switching() &&
      !props.keyTarget
    )
      state.startBrowsing();
  });
  function selectTerminal(show: boolean) {
    terminalSelected.set(show);
    props.onConsoleChange?.(show);
  }
  effect(() => {
    if (
      !props.active ||
      terminalActive() ||
      !state.activeId() ||
      state.switching()
    )
      return;
    const timer = setInterval(() => void state.refreshTtl(), 1000);
    return () => clearInterval(timer);
  });
  function toggleConsole() {
    selectTerminal(!terminalActive());
  }
  const dialogOpen = () =>
    pending() !== undefined ||
    newKeyPrefix() !== undefined ||
    expiryTabId() !== undefined ||
    rowEditor() !== undefined ||
    streamCreator() !== undefined ||
    jsonPathAction() !== undefined;
  const pendingUncertain = () =>
    ["rename", "delete", "deleteRow", "deleteStreamMessage"].includes(
      pending()?.kind ?? "",
    ) &&
    !!(
      state.tabs().find((tab) => tab.id === pending()?.id)?.uncertain ||
      state.keyById(pending()?.id ?? "")?.uncertain
    );
  function newKey(prefix: string) {
    if (!dialogOpen() && !state.mutating() && !state.switching()) {
      selectTerminal(false);
      newKeyPrefix.set(prefix);
    }
  }
  effect(() => {
    if (!props.active) return;
    return keymap.bind(
      {
        "mod+j": () => {
          if (!dialogOpen()) toggleConsole();
        },
        "mod+k": () => {
          if (!dialogOpen()) {
            selectTerminal(false);
            sidebarOpen.set(true);
            search?.focus();
          }
        },
        "mod+s": () => {
          if (!dialogOpen() && !terminalActive()) void state.save();
        },
      },
      { when: "always" },
    );
  });
  function request(kind: Pending["kind"] | "expiry", id = "", value = "") {
    if (!initialized() || state.mutating() || state.switching()) return;
    const tab = state.tabs().find((tab) => tab.id === id);
    if (kind === "expiry") {
      if (!dialogOpen() && tab && !tab.loading && !tab.uncertain)
        expiryTabId.set(id);
      return;
    }
    if (kind === "editJsonPath" || kind === "deleteJsonPath") {
      const json = tab?.json;
      if (
        !dialogOpen() &&
        json?.query &&
        !json.loading &&
        !json.error &&
        !dirty(tab) &&
        !tab?.uncertain &&
        json.query.path === json.pathInput.trim()
      )
        jsonPathAction.set({
          tabId: id,
          path: json.query.path,
          remove: kind === "deleteJsonPath",
        });
      return;
    }
    if (kind === "addStreamMessage") {
      if (
        !dialogOpen() &&
        tab?.stream &&
        tab.info?.exists &&
        !tab.stream.loading &&
        !tab.uncertain
      )
        streamCreator.set(id);
      return;
    }
    if (
      kind === "deleteStreamMessage" &&
      (!tab?.stream ||
        tab.stream.loading ||
        tab.uncertain ||
        !tab.stream.entries.some((entry) => entry.id === value))
    )
      return;
    if (kind === "editRow") {
      if (
        !dialogOpen() &&
        tab?.collection?.rows.some((row) => row.id === value)
      )
        rowEditor.set({ tabId: id, rowId: value });
      return;
    }
    const target = tab ?? state.keyById(id);
    if (kind === "reload" && !dirty(tab)) {
      void state.reload(id);
      return;
    }
    let tabIds: string[] | undefined;
    if (kind === "close" || kind === "closeOthers" || kind === "closeAll") {
      if (!tab) return;
      tabIds = state
        .tabs()
        .filter(
          (item) =>
            kind === "closeAll" ||
            (kind === "close" ? item.id === id : item.id !== id),
        )
        .map((item) => item.id);
      if (state.closeTabs(tabIds)) return;
    }
    if (kind === "database" && !state.hasDrafts()) {
      void state.switchDatabase(value);
      return;
    }
    if (kind === "disconnect" && !state.hasDrafts()) {
      props.onDisconnect();
      return;
    }
    dialogValue.set(kind === "rename" ? (target?.name ?? "") : value);
    dialogError.set("");
    bulkFinished.set(false);
    if (kind === "deleteFolder") state.bulkDeleted.set("0");
    const row =
      kind === "deleteRow"
        ? tab?.collection?.rows.find((item) => item.id === value)
        : undefined;
    pending.set({
      kind,
      id,
      value,
      tabIds,
      name:
        kind === "deleteFolder"
          ? id
          : row
            ? `${tab!.name} / ${rowIdentity(row) || "∅"}`
            : (target?.name ?? ""),
    });
  }
  let handledKeyTarget: WorkspaceKeyTarget | undefined;
  effect(() => {
    const target = props.keyTarget;
    if (
      !props.active ||
      !initialized() ||
      !target ||
      target === handledKeyTarget ||
      target.session !== props.live.session ||
      state.switching() ||
      state.mutating() ||
      dialogOpen()
    )
      return;
    handledKeyTarget = target;
    selectTerminal(false);
    if (narrow()) sidebarOpen.set(false);
    const next = String(target.database);
    if (target.database !== state.database() && state.hasDrafts()) {
      dialogValue.set(next);
      dialogError.set("");
      pending.set({
        kind: "database",
        id: "",
        value: next,
        name: "",
        keyToOpen: target.key,
      });
    } else void state.switchDatabase(next, false, target.key);
    props.onKeyTargetHandled?.(target);
  });
  async function confirm() {
    const action = pending();
    if (!action || state.mutating() || state.switching()) return;
    if (action.kind === "deleteFolder" && bulkFinished()) return;
    let ok = false;
    if (action.kind === "rename")
      ok = await state.changeKey(action.id, "rename", dialogValue());
    else if (action.kind === "deleteRow")
      ok = await state.deleteCollectionRow(action.id, action.value);
    else if (action.kind === "deleteStreamMessage")
      ok = await state.deleteStreamMessage(action.id, action.value);
    else if (action.kind === "delete")
      ok = await state.changeKey(action.id, "delete");
    else if (action.kind === "deleteFolder") {
      ok = await state.deleteFolder(action.id);
      bulkFinished.set(true);
    } else if (action.kind === "reload")
      ok = await state.reload(action.id, true);
    else if (action.tabIds) ok = state.closeTabs(action.tabIds, true);
    else if (action.kind === "database")
      ok = await state.switchDatabase(action.value, true, action.keyToOpen);
    else if (action.kind === "disconnect") {
      props.onDisconnect();
      return;
    }
    if (ok) pending.set(undefined);
    else dialogError.set(state.error() || w("operationFailed"));
  }
  return (
    <View
      testID="session-workspace"
      class="flex-1 min-w-0 min-h-0 bg-workspace"
    >
      <View class="h-9 px-2 flex-row items-center gap-2 border-b border-border/50">
        {!props.consoleFullscreen && (
          <IconButton
            testID="workspace-toggle-sidebar"
            label={w("keyBrowser")}
            icon="sidebar"
            size={26}
            selected={sidebarOpen() && (!narrow() || !terminalActive())}
            onPress={() => {
              if (narrow() && terminalActive()) {
                selectTerminal(false);
                sidebarOpen.set(true);
              } else sidebarOpen.set(!sidebarOpen());
            }}
          />
        )}
        <Dot color={token(state.error() ? "destructive" : "success")} />
        <Text class="flex-1 min-w-0 text-(--text-size-11) font-mono text-muted-foreground line-clamp-1">
          {props.live.name} · {endpoint()} · DB{state.database()}
        </Text>
        {!narrow() && (
          <Text class="text-(--text-size-10) text-success font-mono">
            {state.latency() !== undefined ? `${state.latency()} ms` : ""}
          </Text>
        )}
        <IconButton
          label={w("ping")}
          icon="refresh"
          size={26}
          onPress={() => void state.ping()}
        />
        <IconButton
          testID="workspace-toggle-console"
          label={w(terminalActive() ? "showKeyDetails" : "showTerminal")}
          icon="terminal"
          size={26}
          selected={terminalActive()}
          onPress={toggleConsole}
        />
        <Action
          testID="workspace-disconnect"
          label={w("disconnect")}
          compact
          disabled={state.mutating()}
          onPress={() => request("disconnect")}
        />
      </View>
      <ResizablePanelGroup
        class="flex-1 min-w-0 min-h-0"
        handleClass="bg-border/50 group-hover:bg-primary/60"
        handleAccessibilityLabel={w("resizeKeys")}
      >
        <ResizablePanel
          size={288}
          minSize={200}
          maxSize={460}
          fixed={!narrow()}
          visible={keyBrowserVisible()}
        >
          <KeyBrowser
            active={props.active && keyBrowserVisible()}
            state={state}
            separator={separator()}
            searchRef={(ref) => {
              search = ref;
            }}
            onDatabase={(value) => request("database", "", value)}
            onKeyAction={(action, id) => request(action, id)}
            onDeleteFolder={(prefix) => request("deleteFolder", prefix)}
            onNewKey={newKey}
            onOpenKey={(key) => {
              selectTerminal(false);
              void state.openKey(key);
              if (narrow()) sidebarOpen.set(false);
            }}
          />
        </ResizablePanel>
        <ResizablePanel
          minSize={narrow() ? 180 : 360}
          visible={!narrow() || !sidebarOpen() || terminalActive()}
        >
          <View class="flex-1 min-w-0 min-h-0">
            <Scroll
              horizontal
              class={`h-9 shrink-0 border-b border-border/50 ${props.consoleFullscreen ? "hidden" : ""}`}
              contentClass="flex-row items-center"
            >
              <Each of={state.tabs()} key={(tab) => tab.id}>
                {(tab) => (
                  <KeyTabMenu
                    state={state}
                    tabId={tab().id}
                    disabled={dialogOpen() || !props.active}
                    onAction={request}
                  >
                    <View
                      class={`h-9 shrink-0 flex-row items-center gap-1 pl-2 pr-1 border-r border-border/30 ${!terminalActive() && state.activeId() === tab().id ? "bg-selected border-t-2 border-t-primary" : ""}`}
                      style={{ maxWidth: 180 }}
                    >
                      <Button
                        testID={`workspace-tab-${tab().id}`}
                        accessibilityLabel={w("openTab", { name: tab().name })}
                        tooltip={
                          <Tooltip label={tab().name || w("emptyKey")} />
                        }
                        onPress={() => {
                          state.activeId.set(tab().id);
                          selectTerminal(false);
                        }}
                        class="h-8 flex-1 min-w-0 flex-row items-center gap-1.5 focus:ring-1 focus:ring-ring"
                      >
                        <KeyBadge type={tab().info?.type} />
                        <Text
                          class="flex-1 min-w-0 text-(--text-size-11) font-mono text-foreground line-clamp-1"
                          style={{ maxWidth: 100 }}
                        >
                          {tab().name || w("emptyKey")}
                        </Text>
                        {dirty(tab()) && (
                          <Text class="shrink-0 text-(--text-size-11) text-foreground">
                            •
                          </Text>
                        )}
                      </Button>
                      <IconButton
                        testID={`workspace-close-${tab().id}`}
                        label={w("closeTab", { name: tab().name })}
                        icon="close"
                        size={24}
                        onPress={() => request("close", tab().id)}
                      />
                    </View>
                  </KeyTabMenu>
                )}
              </Each>
              <Action
                testID="workspace-terminal-tab"
                label={`Terminal (DB${state.database()})`}
                icon="terminal"
                compact
                selected={terminalActive()}
                onPress={() => selectTerminal(true)}
              />
            </Scroll>
            <View
              class={`flex-1 min-w-0 min-h-0 ${terminalActive() ? "hidden" : "flex"}`}
            >
              <KeyInspector
                state={state}
                onAction={request}
                active={props.active && !terminalActive() && !dialogOpen()}
              />
            </View>
            <View
              class={`flex-1 min-w-0 min-h-0 ${terminalActive() ? "flex" : "hidden"}`}
            >
              <Terminal
                state={state}
                console={console}
                endpoint={endpoint()}
                active={props.active && initialized() && terminalActive() && !dialogOpen()}
              />
            </View>
          </View>
        </ResizablePanel>
      </ResizablePanelGroup>
      <If when={newKeyPrefix() !== undefined}>
        <CreateKeyDialog
          state={state}
          prefix={newKeyPrefix()!}
          separator={separator()}
          onClose={() => newKeyPrefix.set(undefined)}
        />
      </If>
      <If when={expiryTabId() !== undefined}>
        <KeyExpiryDialog
          state={state}
          tabId={expiryTabId()!}
          onClose={() => expiryTabId.set(undefined)}
        />
      </If>
      <If when={rowEditor()}>
        <CollectionRowDialog
          state={state}
          tabId={rowEditor()!.tabId}
          rowId={rowEditor()!.rowId}
          onClose={() => rowEditor.set(undefined)}
        />
      </If>
      <If when={jsonPathAction()}>
        <JsonPathDialog
          state={state}
          tabId={jsonPathAction()!.tabId}
          path={jsonPathAction()!.path}
          remove={jsonPathAction()!.remove}
          onClose={() => jsonPathAction.set(undefined)}
        />
      </If>
      <If when={streamCreator() !== undefined}>
        <StreamMessageDialog
          state={state}
          tabId={streamCreator()!}
          onClose={() => streamCreator.set(undefined)}
        />
      </If>
      {pending() && (
        <WorkspaceDialog
          title={w(
            pending()!.kind === "rename"
              ? "renameTitle"
              : pending()!.kind === "deleteFolder"
                ? "deleteFolderTitle"
                : pending()!.kind === "deleteRow"
                  ? "collectionDeleteRowTitle"
                  : pending()!.kind === "deleteStreamMessage"
                    ? "streamDeleteTitle"
                    : pending()!.kind === "delete"
                      ? "deleteTitle"
                      : "discardTitle",
          )}
          description={w(
            pending()!.kind === "rename"
              ? "renameHint"
              : pending()!.kind === "deleteFolder"
                ? "deleteFolderHint"
                : pending()!.kind === "deleteRow"
                  ? "collectionDeleteRowHint"
                  : pending()!.kind === "deleteStreamMessage"
                    ? "streamDeleteHint"
                    : pending()!.kind === "delete"
                      ? "deleteHint"
                      : "discardHint",
            {
              name: pending()!.name,
              database: state.database(),
              id: pending()!.value,
            },
          )}
          alert={pending()!.kind !== "rename"}
          onClose={() => {
            if (!state.mutating() && !state.switching()) pending.set(undefined);
          }}
        >
          {pending()!.kind === "deleteFolder" && (
            <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">
              {w("bulkDeleteProgress", { count: state.bulkDeleted() })}
            </Text>
          )}
          {pending()!.kind === "rename" && (
            <Input
              testID="workspace-dialog-input"
              accessibilityLabel={w("keyName")}
              value={dialogValue()}
              onChange={({ value }) => dialogValue.set(value)}
              onSubmit={() => void confirm()}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              class="h-9 px-3 text-(--text-size-12)/(--line-height-16) font-mono text-foreground border border-border-strong bg-chrome rounded"
            />
          )}
          {!!dialogError() && (
            <Text class="text-(--text-size-12)/(--line-height-16) text-destructive">{dialogError()}</Text>
          )}
          <View class="flex-row justify-end gap-2">
            <Action
              testID="workspace-dialog-cancel"
              label={w(
                pending()!.kind === "deleteFolder" && state.mutating()
                  ? "stop"
                  : "cancel",
              )}
              disabled={
                state.switching() ||
                (state.mutating() && pending()!.kind !== "deleteFolder")
              }
              onPress={() => {
                if (state.mutating()) state.cancelFolderDelete();
                else pending.set(undefined);
              }}
            />
            <Action
              testID="workspace-dialog-confirm"
              label={w(
                ["delete", "deleteFolder", "deleteStreamMessage"].includes(
                  pending()!.kind,
                )
                  ? "delete"
                  : [
                        "reload",
                        "close",
                        "closeOthers",
                        "closeAll",
                        "database",
                        "disconnect",
                      ].includes(pending()!.kind)
                    ? "discard"
                    : "confirm",
              )}
              primary
              disabled={
                state.mutating() ||
                state.switching() ||
                pendingUncertain() ||
                (pending()!.kind === "deleteFolder" && bulkFinished())
              }
              onPress={() => void confirm()}
            />
          </View>
        </WorkspaceDialog>
      )}
    </View>
  );
}
