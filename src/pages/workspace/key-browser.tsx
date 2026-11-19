import {
  computed,
  effect,
  signal,
  Text,
  token,
  untracked,
  View,
  type InputRef,
} from "nsh";
import { Input, Select } from "nsh/base";
import { KeyRows } from "ferrix/native";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { useClipboardCopy } from "../../utils/clipboard";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

export function KeyBrowser(props: {
  state: WorkspaceState;
  separator: string;
  onOpenKey: (key: Uint8Array) => void;
  onDatabase: (value: string) => void;
  onKeyAction: (action: "rename" | "delete", id: string) => void;
  onDeleteFolder: (prefix: string) => void;
  onNewKey: (prefix: string) => void;
  searchRef: (value: InputRef) => void;
}) {
  const state = props.state;
  const grouped = signal(true);
  const copy = useClipboardCopy();

  effect(() => {
    const separator = props.separator;
    const nested = grouped();
    untracked(() => state.configureKeys(separator, nested));
  });
  const databaseLabel = (database: number, count?: string | null) =>
    `DB${database} · ${count != null ? w("databaseKeys", { count }) : w("unknownCount")}`;
  const databaseItems = computed(() =>
    state.databases().map((item) => ({
      value: String(item.database),
      title: databaseLabel(item.database, item.keyCount),
    })),
  );
  return (
    <View class="flex-1 min-h-0 bg-workspace">
      <View class="h-10 px-3 flex-row items-center gap-2 border-b border-border/50">
        <Icon name="server" size={15} color={token("primary")} />
        <Text class="flex-1 text-(--text-size-12)/(--line-height-16) font-semibold text-foreground">
          {w("keyBrowser")}
        </Text>
        <IconButton
          testID="workspace-new-key"
          label={w("newKey")}
          icon="plus"
          disabled={state.switching() || state.mutating()}
          onPress={() => props.onNewKey("")}
          size={26}
        />
        <IconButton
          testID="workspace-refresh-keys"
          label={w("refresh")}
          icon="refresh"
          disabled={state.switching()}
          onPress={state.refresh}
          size={26}
        />
      </View>
      <View class="p-2 gap-2">
        <View class="h-8 flex-row items-center gap-2 px-2 rounded border border-border-strong bg-inset focus-within:border-ring">
          <Icon name="filter" size={13} />
          <Input
            ref={props.searchRef}
            testID="live-key-filter"
            accessibilityLabel={w("filter")}
            placeholder={w("filterPlaceholder")}
            value={state.pattern()}
            onChange={({ value }) => state.pattern.set(value)}
            onSubmit={state.refresh}
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-11) font-mono text-foreground"
          />
          <Action
            testID="workspace-apply-filter"
            label={w("filter")}
            compact
            onPress={state.refresh}
          />
        </View>
        <View class="h-6 px-1 flex-row items-center gap-1">
          <Text class="flex-1 text-(--text-size-10) text-faint">
            {w("delimiter")}{" "}
            <Text testID="workspace-key-separator" class="text-steel font-mono">
              {props.separator}
            </Text>
          </Text>
          <IconButton
            label={w("collapseAll")}
            icon="collapse"
            size={24}
            onPress={() => state.expandKeyFolders(false)}
          />
          <IconButton
            label={w("expandAll")}
            icon="expand"
            size={24}
            onPress={() => state.expandKeyFolders(true)}
          />
          <IconButton
            testID="workspace-tree-mode"
            label={w(grouped() ? "flat" : "tree")}
            icon="network"
            size={24}
            selected={grouped()}
            onPress={() => grouped.set(!grouped())}
          />
        </View>
      </View>
      <KeyRows
        inventory={state.keyTreeInventory()}
        onOpenKey={({ key }) => props.onOpenKey(key)}
        onCopyName={({ name }) => void copy(name)}
        onRenameKey={({ id }) => props.onKeyAction("rename", id)}
        onDeleteKey={({ id }) => props.onKeyAction("delete", id)}
        onCreateKey={({ prefix }) => props.onNewKey(prefix)}
        onDeleteFolder={({ prefix }) => props.onDeleteFolder(prefix)}
      />
      <View class="px-2 py-1.5 border-t border-border/60 gap-1">
        <View class="h-8 flex-row items-center gap-1">
          <Icon name="database" size={13} color={token("success")} />
          <Text class="text-(--text-size-11) font-mono text-foreground">
            DB{state.database()}
          </Text>
          <Text class="flex-1 text-(--text-size-10) text-faint">
            {w("loadedKeys", { count: state.keys().length })}
          </Text>
          {state.scanActive() && (
            <Action
              testID="workspace-load-more"
              label={w(state.scanBusy() ? "loading" : "loadMore")}
              compact
              disabled={state.scanBusy()}
              onPress={() => void state.nextPage()}
            />
          )}
          {state.scanStopped() && (
            <Action
              testID="workspace-restart-scan"
              label={w("restartScan")}
              compact
              disabled={state.switching() || state.mutating()}
              onPress={state.refresh}
            />
          )}
        </View>
        <View class="h-8 flex-row items-center gap-1.5">
          <Text class="text-(--text-size-10) text-faint">{w("database")}</Text>
          <Select
            testID="workspace-database"
            accessibilityLabel={w("database")}
            value={String(state.database())}
            items={databaseItems()}
            class="flex-1 min-w-0"
            disabled={state.switching() || state.mutating()}
            placement="top"
            onOpen={() => void state.loadDatabases()}
            onChange={({ value }) => {
              if (value !== null) props.onDatabase(value);
            }}
            popupClass="rounded-md border border-border-strong bg-elevated p-1 shadow-xl"
            listClass="max-h-72"
            itemClass="h-8 px-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent selected:bg-selected"
            trigger={
              <View
                testID="workspace-database-trigger"
                class="h-7 px-2 flex-row items-center gap-2 rounded border border-border bg-workspace hover:bg-accent"
              >
                <Icon name="database" size={12} />
                <Text class="flex-1 min-w-0 text-(--text-size-11) font-mono text-foreground">
                  {databaseLabel(
                    state.database(),
                    state
                      .databases()
                      .find((item) => item.database === state.database())
                      ?.keyCount,
                  )}
                </Text>
                <Icon name="down" size={11} />
              </View>
            }
            renderItem={(entry) => (
              <View
                testID={`workspace-database-option-${entry.value}`}
                class="h-8 flex-row items-center gap-4"
              >
                <Text class="flex-1 text-(--text-size-11) font-mono text-foreground">
                  DB{entry.value}
                </Text>
                <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                  {state
                    .databases()
                    .find((item) => String(item.database) === entry.value)
                    ?.keyCount != null
                    ? w("databaseKeys", {
                        count: state
                          .databases()
                          .find(
                            (item) => String(item.database) === entry.value,
                          )!.keyCount,
                      })
                    : w("unknownCount")}
                </Text>
                {entry.value === String(state.database()) && (
                  <Icon name="check" size={12} color={token("success")} />
                )}
              </View>
            )}
          />
        </View>
        {state.databasesBusy() && (
          <Text class="text-(--text-size-10) text-faint">{w("loadingDatabases")}</Text>
        )}
        {!!state.databasesError() && (
          <Text
            testID="workspace-databases-error"
            class="text-(--text-size-10) text-destructive"
          >
            {w("databaseCountsFailed")}
          </Text>
        )}
        {!state.databasesBusy() && !state.databasesComplete() && (
          <Text class="text-(--text-size-10) text-faint">{w("databaseListPartial")}</Text>
        )}
      </View>
      {(!state.scanStopped() || !!state.keys().length) && (
        <View class="h-7 px-2 flex-row items-center justify-between border-t border-border/50">
          <Text class={`text-(--text-size-9) ${state.complete() ? "text-success" : "text-faint"}`}>
            {w(state.scanStopped() ? "scanStopped" : state.complete() ? "scanComplete" : "scanProgress")}
          </Text>
          {state.scanActive() && (
            <Action
              testID="workspace-stop-scan"
              label={w("stopLoading")}
              compact
              onPress={state.stopScan}
            />
          )}
        </View>
      )}
    </View>
  );
}
