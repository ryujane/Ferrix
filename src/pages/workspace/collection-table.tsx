import { computed, effect, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { useToast } from "../../components/toast";
import { useClipboardCopy } from "../../utils/clipboard";
import { CollectionGrid, type CollectionGridColumn } from "./collection-grid";
import {
  rowDirty,
  rowEditable,
  rowIdentity,
  rowValue,
  type CollectionRow,
} from "./collection-values";
import { decode, displayBytes, encode, formatJson, keyId } from "./workspace-values";
import { WorkspaceHintButton } from "./workspace-controls";
import type { KeyTab, WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

type Column = "identity" | "type" | "value";

export function CollectionTable(props: {
  state: WorkspaceState;
  tab: KeyTab;
  active: boolean;
  onEditRow: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
}) {
  const state = props.state,
    query = signal(""),
    focused = signal(false);
  const copyToClipboard = useClipboardCopy();
  const toast = useToast();
  const editing = signal<{
    tabId: string;
    rowId: string;
    column: "identity" | "value";
    before?: string;
  }>();
  const reveal = signal<{ row: string; column: Column }>();
  const collection = computed(() => props.tab.collection!);
  const kind = computed(() => collection().kind);
  const editable = () =>
    props.active &&
    !!props.tab.info?.exists &&
    !props.tab.loading &&
    !props.tab.error &&
    !props.tab.uncertain &&
    !collection().loading &&
    !state.mutating() &&
    !state.switching();
  let previousTab: string | undefined;
  effect(() => {
    if (props.tab.id !== previousTab) {
      previousTab = props.tab.id;
      query.set("");
      editing.set(undefined);
      focused.set(false);
      reveal.set(undefined);
    }
  });
  effect(() => {
    if (state.mutating()) {
      editing.set(undefined);
      focused.set(false);
    }
  });
  const rows = computed(() => {
    const filter = query().trim().toLowerCase(),
      data = collection();
    if (!filter) return data.rows;
    const target = editing();
    return data.rows.filter(
      (row) =>
        row.isNew ||
        (target?.tabId === props.tab.id && target.rowId === row.id) ||
        [
          rowIdentity(row),
          displayBytes(row.value),
          rowValue(data.kind, row),
        ].some((value) => value.toLowerCase().includes(filter)),
    );
  });
  const changed = () => collection().rows.filter(rowDirty).length;
  const editingRow = (row: CollectionRow, column: string) =>
    editing()?.tabId === props.tab.id &&
    editing()?.rowId === row.id &&
    editing()?.column === column;
  function begin(row: CollectionRow, column: "identity" | "value" = "value") {
    if (editingRow(row, column)) return;
    const allowed =
      column === "identity"
        ? row.isNew && ["hash", "zset"].includes(collection().kind)
        : rowEditable(collection().kind, row);
    if (editable() && allowed)
      editing.set({
        tabId: props.tab.id,
        rowId: row.id,
        column,
        before: column === "identity" ? rowIdentity(row) : row.draft,
      });
  }
  function add() {
    const rowId = state.addCollectionRow(props.tab.id);
    if (!rowId) return;
    const column = ["hash", "zset"].includes(collection().kind)
      ? "identity"
      : "value";
    query.set("");
    editing.set({
      tabId: props.tab.id,
      rowId,
      column,
      before: column === "identity" ? "" : undefined,
    });
    reveal.set({ row: rowId, column });
  }
  function confirm() {
    const target = editing(),
      row = collection().rows.find((item) => item.id === target?.rowId);
    if (
      target?.column === "value" &&
      collection().kind === "zset" &&
      row &&
      (!rowValue("zset", row).trim() ||
        !Number.isFinite(Number(rowValue("zset", row))))
    ) {
      toast.error(w("invalidScore"));
      return;
    }
    editing.set(undefined);
    focused.set(false);
  }
  function cancel() {
    const target = editing();
    if (target?.column === "identity")
      state.editCollectionIdentity(
        target.tabId,
        target.rowId,
        target.before ?? "",
      );
    else if (target)
      state.editCollectionCell(target.tabId, target.rowId, target.before);
    editing.set(undefined);
    focused.set(false);
  }
  effect(() => {
    if (props.active && focused() && editing()?.tabId === props.tab.id)
      return keymap.bind("escape", cancel, { when: "always" });
  });
  const columns = computed<CollectionGridColumn<Column>[]>(() => {
    const type = kind();
    const identity: CollectionGridColumn<Column> = {
      key: "identity",
      title: w(
        type === "hash"
          ? "collectionField"
          : type === "list"
            ? "collectionIndex"
            : "collectionMember",
      ),
      width: type === "list" ? 100 : 230,
      minWidth: 80,
      fixed: true,
    };
    return [
      ...(type === "set" ? [] : [identity]),
      { key: "type", title: w("type"), width: 90, minWidth: 70 },
      {
        key: "value",
        title: w(
          type === "zset"
            ? "memberScore"
            : type === "set"
              ? "collectionMember"
              : "collectionValue",
        ),
        width: 240,
        minWidth: 160,
        fill: true,
      },
    ];
  });
  // Rows are replaced when their drafts change. Cache formatting across recycled views.
  const formatted = new WeakMap<
    CollectionRow,
    {
      kind: ReturnType<typeof kind>;
      formatter: ReturnType<typeof state.formatter>;
      cells: Record<Column, string>;
      editable: boolean;
    }
  >();
  function presentation(row: CollectionRow) {
    const type = kind();
    const formatter = state.formatter();
    const previous = formatted.get(row);
    if (previous?.kind === type && previous.formatter === formatter) return previous;
    const value = rowValue(type, row);
    const shown = type !== "hash" ? value
      : formatter === "hex" ? `0x${keyId(row.draft === undefined ? row.value : encode(row.draft))}`
      : formatter === "json" ? formatJson(value, true) ?? value
      : value;
    const next = {
      kind: type,
      formatter,
      cells: {
        identity: rowIdentity(row),
        type:
          type === "zset"
            ? "NUMBER"
            : decode(row.value) === undefined
              ? "BINARY"
              : "STR",
        value: shown,
      },
      editable: rowEditable(type, row),
    };
    formatted.set(row, next);
    return next;
  }
  function cellText(row: CollectionRow, column: Column): string {
    if (column === "identity" && row.isNew && kind() === "list")
      return w("collectionAppend");
    return presentation(row).cells[column];
  }
  function cellColor(row: CollectionRow, column: Column) {
    if (column === "identity")
      return row.identityDraft === undefined
        ? "text-steel font-semibold"
        : "text-primary font-semibold";
    if (column === "type") return "text-(--text-size-9) text-muted-foreground";
    return row.draft === undefined ? "text-foreground" : "text-primary";
  }

  function renderActions(row: () => CollectionRow) {
    return (
      <View
        testID={`workspace-collection-row-${row().id}`}
        class="h-full flex-1 flex-row items-center gap-1"
      >
        <IconButton
          testID="workspace-collection-edit"
          label={w("collectionEditRow")}
          icon="pencil"
          size={26}
          disabled={!editable() || !presentation(row()).editable}
          onPress={() => {
            const item = row();
            if (!editable() || !presentation(item).editable) return;
            editing.set(undefined);
            focused.set(false);
            props.onEditRow(item.id);
          }}
        />
        <IconButton
          testID="workspace-collection-copy"
          label={w("copy")}
          icon="copy"
          size={26}
          onPress={() => void copyToClipboard(rowValue(kind(), row()))}
        />
        <If when={!row().isNew}>
          <IconButton
            testID="workspace-collection-reload"
            label={w("collectionReloadRow")}
            icon="refresh"
            size={26}
            disabled={!editable()}
            onPress={() => {
              const item = row();
              if (!editable() || item.isNew) return;
              if (editing()?.rowId === item.id) editing.set(undefined);
              void state.reloadCollectionRow(props.tab.id, item.id);
            }}
          />
        </If>
        <IconButton
          testID={
            row().isNew
              ? "workspace-collection-cancel-new"
              : "workspace-collection-delete"
          }
          label={w(row().isNew ? "collectionCancelNew" : "delete")}
          icon="trash"
          size={26}
          disabled={!editable()}
          onPress={() => {
            const item = row();
            if (!editable()) return;
            if (item.isNew) {
              state.removeNewCollectionRow(props.tab.id, item.id);
              editing.set(undefined);
            } else props.onDeleteRow(item.id);
          }}
        />
      </View>
    );
  }

  function renderCell(row: () => CollectionRow, column: Column) {
    const identity = column === "identity";
    const valueSize = column === "value" ? "text-(--editor-text-size)" : "";
    return (
      <If
        when={editingRow(row(), column)}
        else={
          <View class="flex-row items-center gap-1">
            <If when={column === "value" && row().isNew}>
              <Text class="shrink-0 text-(--text-size-9) text-primary">
                {w("collectionNewRow")}
              </Text>
            </If>
            <If
              when={
                !row().isNew &&
                (identity
                  ? row().identityDraft !== undefined
                  : column === "value" && row().draft !== undefined)
              }
            >
              <Text class="shrink-0 text-(--text-size-10) text-primary">•</Text>
            </If>
            <Text class={`min-w-0 line-clamp-1 ${valueSize} ${cellColor(row(), column)}`}>
              {cellText(row(), column) || "∅"}
            </Text>
          </View>
        }
      >
        <View class="h-full flex-row items-center gap-1">
          <Input
            testID="workspace-collection-cell-input"
            accessibilityLabel={w(
              identity
                ? kind() === "hash"
                  ? "collectionField"
                  : "collectionMember"
                : kind() === "zset"
                  ? "memberScore"
                  : "collectionValue",
            )}
            value={identity ? rowIdentity(row()) : rowValue(kind(), row())}
            onChange={({ value }) => {
              const item = row();
              if (identity)
                state.editCollectionIdentity(props.tab.id, item.id, value);
              else state.editCollectionCell(props.tab.id, item.id, value);
            }}
            onSubmit={confirm}
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            autoFocus
            readonly={!editable()}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={65536}
            submitBehavior="submit"
            class={`flex-1 min-w-0 h-8 px-2 border border-primary rounded font-mono text-foreground bg-inset focus:ring-1 focus:ring-primary ${valueSize || "text-(--text-size-12)/(--line-height-16)"}`}
          />
          <IconButton
            testID="workspace-collection-cell-confirm"
            label={w("confirm")}
            icon="check"
            size={24}
            disabled={!editable()}
            onPress={confirm}
          />
          <IconButton
            testID="workspace-collection-cell-cancel"
            label={w("cancel")}
            icon="close"
            size={24}
            disabled={!editable()}
            onPress={cancel}
          />
        </View>
      </If>
    );
  }

  return (
    <View
      testID="workspace-collection-table"
      class="flex-1 min-w-0 min-h-0 bg-workspace"
    >
      <View class="px-3 py-2 flex-row flex-wrap items-center gap-2 border-b border-border/50">
        <View class="flex-1 min-w-[180px] h-8 px-2 flex-row items-center gap-2 border border-border-strong rounded bg-inset focus-within:border-ring">
          <Icon name="search" size={13} />
          <Input
            testID="workspace-collection-filter"
            accessibilityLabel={w("collectionFilter")}
            placeholder={w("collectionFilter")}
            value={query()}
            onChange={({ value }) => query.set(value)}
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-12)/(--line-height-16) text-foreground"
          />
        </View>
        <Action
          testID="workspace-collection-add-row"
          label={w("collectionAddRow")}
          icon="plus"
          compact
          disabled={!editable()}
          onPress={add}
        />
        {changed() > 0 && (
          <Text
            testID="workspace-collection-changes"
            class="px-2 py-1 text-(--text-size-10) text-primary bg-primary/10 rounded"
          >
            {w("collectionChanges", { count: changed() })}
          </Text>
        )}
        <Text class="text-(--text-size-10) font-mono text-muted-foreground">
          {w("entries")}: {rows().length}
        </Text>
        <WorkspaceHintButton message={w("collectionEditHint")} />
      </View>
      <CollectionGrid
        testID="workspace-collection-grid"
        label={w("table")}
        active={props.active}
        tabId={props.tab.id}
        rows={rows()}
        columns={columns()}
        rowKey={(row) => row.id}
        cellText={cellText}
        actionsWidth={140}
        renderActions={renderActions}
        renderCell={renderCell}
        dirtyRow={rowDirty}
        reveal={reveal()}
        rowEditColumn="value"
        onEditCell={(row, column) => {
          if (column !== "type") begin(row, column);
        }}
        empty={
          <View class="flex-1 items-center justify-center p-6">
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {w(query().trim() ? "nothingFound" : "collectionEmpty")}
            </Text>
          </View>
        }
      />
      <View class="min-h-8 px-3 py-1 flex-row flex-wrap items-center gap-2 border-t border-border/50">
        <Text class="flex-1 text-(--text-size-10) font-mono text-faint">
          {w("collectionLoaded", {
            loaded: collection().rows.filter((row) => !row.isNew).length,
            total: props.tab.info?.length ?? "-",
          })}
        </Text>
        {props.tab.uncertain && (
          <Text class="text-(--text-size-10) text-destructive">{w("unknownWrite")}</Text>
        )}
        {!collection().complete && (
          <Action
            testID="workspace-collection-load-more"
            label={w(collection().loading ? "loading" : "loadMore")}
            compact
            disabled={!editable()}
            onPress={() => void state.loadMoreCollection(props.tab.id)}
          />
        )}
      </View>
    </View>
  );
}
