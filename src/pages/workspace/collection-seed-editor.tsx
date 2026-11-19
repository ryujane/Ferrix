import { computed, effect, signal, Text, token, View } from "nsh";
import {
  DataTable,
  Input,
  type DataTableColumn,
  type DataTableRef,
} from "nsh/base";
import { Action } from "../../components/action";
import { IconButton } from "../../components/icon-button";
import { fonts } from "../../fonts";
import { encode } from "./workspace-values";
import { workspaceT as w } from "./workspace-text";

type SeedDraft = { id: number; field: string; value: string; score: string };
type SeedColumn = "field" | "value" | "score";

export function createCollectionSeeds(initialField = "") {
  const items = signal<SeedDraft[]>([
    { id: 1, field: initialField, value: "", score: "0" },
  ]);
  let sequence = 1;
  return {
    items: () => items(),
    change: (id: number, key: SeedColumn, value: string) =>
      items.set(
        items().map((item) =>
          item.id === id ? { ...item, [key]: value } : item,
        ),
      ),
    add: () => {
      if (items().length >= 200) return;
      const id = ++sequence;
      items.set([...items(), { id, field: "", value: "", score: "0" }]);
      return id;
    },
    remove: (id: number) => items.set(items().filter((item) => item.id !== id)),
    validScores: () =>
      items().every(
        (item) => !!item.score.trim() && Number.isFinite(Number(item.score)),
      ),
    toValues: () => items().map((item) => encode(item.value)),
    toFields: () =>
      items().map((item) => ({
        field: encode(item.field),
        value: encode(item.value),
      })),
    toMembers: () =>
      items().map((item) => ({
        member: encode(item.value),
        score: Number(item.score),
      })),
  };
}

export function CollectionSeedEditor(props: {
  kind: "hash" | "list" | "set" | "zset" | "stream";
  state: ReturnType<typeof createCollectionSeeds>;
  disabled?: boolean;
  autoFocus?: boolean;
  testIDPrefix: string;
  onChange?: () => void;
}) {
  const state = props.state,
    width = signal(590),
    grid = signal<DataTableRef>();
  const focusRow = signal<number | undefined>(
    props.autoFocus ? state.items()[0]?.id : undefined,
  );
  const hasFields = props.kind === "hash" || props.kind === "stream";
  const primaryColumn = hasFields ? "field" : "value";
  const columns = computed<DataTableColumn[]>(() => {
    const available = Math.max(280, width() - 48 - 56 - 12);
    return [
      ...(hasFields
        ? [
            {
              key: "field",
              title: w("collectionField"),
              width: Math.max(120, available * 0.4),
              minWidth: 100,
            },
          ]
        : []),
      {
        key: "value",
        title: w(
          props.kind === "set" || props.kind === "zset"
            ? "collectionMember"
            : "collectionValue",
        ),
        width: hasFields
          ? available * 0.6
          : props.kind === "zset"
            ? available - 120
            : available,
        minWidth: 140,
      },
      ...(props.kind === "zset"
        ? [{ key: "score", title: w("memberScore"), width: 120, minWidth: 90 }]
        : []),
      {
        key: "actions",
        title: w("collectionActions"),
        width: 56,
        minWidth: 56,
        resizable: false,
        movable: false,
        selectable: false,
        fixed: "right",
      },
    ];
  });
  type TableRow = {
    field: string;
    value: string;
    score: string;
    actions: string;
  };
  const data = computed<TableRow[]>((previous) => {
    const items = state.items();
    // Native cell text identifies the row and stays fixed while typing. Updating
    // it with every draft edit would remount renderCell's Input and lose focus.
    if (
      previous?.length === items.length &&
      previous.every((row, index) => row.value === String(items[index].id))
    )
      return previous;
    return items.map((item) => ({
      field: String(item.id),
      value: String(item.id),
      score: String(item.id),
      actions: String(item.id),
    }));
  });
  effect(() => {
    const id = focusRow(),
      table = grid();
    const index = state.items().findIndex((item) => item.id === id);
    if (table && index >= 0) table.scrollToRow(index, false);
  });
  function add() {
    if (props.disabled) return;
    const id = state.add();
    if (id !== undefined) {
      focusRow.set(id);
      props.onChange?.();
    }
  }
  function remove(id: number) {
    if (props.disabled) return;
    if (focusRow() === id) focusRow.set(undefined);
    state.remove(id);
    props.onChange?.();
  }
  return (
    <View
      testID={`${props.testIDPrefix}-table`}
      class="rounded-lg overflow-hidden border border-border bg-chrome"
      onLayout={({ bounds }) => width.set(bounds.size.width)}
    >
      <DataTable
        ref={(ref) => grid.set(ref)}
        testID={`${props.testIDPrefix}-grid`}
        accessibilityLabel={w("initialValue")}
        columns={columns()}
        data={data()}
        rowHeader
        rowSelectable={false}
        cellSelectable={false}
        columnSelectable={false}
        movableColumns={false}
        rowHeight={40}
        headerHeight={32}
        fontFamily={fonts.mono}
        fontSize={token("text-size-11")}
        stripe
        class="min-w-0 bg-workspace"
        style={{
          height: Math.min(232, 32 + Math.max(2, state.items().length) * 40),
        }}
        classes={{
          root: "border-0 bg-workspace",
          header: "bg-background border-b border-border",
          headerCell: "px-2 text-(--text-size-11) font-semibold text-muted-foreground",
          cell: "p-0 border-b border-r border-border/30",
          row: "bg-workspace",
          rowOdd: "bg-background/40",
          rowHeader: "text-(--text-size-10) text-faint bg-chrome/50",
          empty: "bg-workspace text-muted-foreground",
        }}
        empty={
          <View class="flex-1 items-center justify-center p-3">
            <Text class="text-(--text-size-12)/(--line-height-16) text-faint">
              {w("newKeyCollectionRequired")}
            </Text>
          </View>
        }
        renderCell={(cell) => {
          const id = Number(cell.text),
            column = cell.key as SeedColumn;
          const row = () => state.items().find((item) => item.id === id);
          const testID = hasFields
            ? `${props.testIDPrefix}-new-${column}-${id}`
            : `${props.testIDPrefix}-${column}-${id}`;
          return (
            <View class="flex-1 h-full px-1 flex-row items-center justify-center">
              <If when={cell.key === "actions"}>
                <IconButton
                  testID={`${props.testIDPrefix}-remove-${hasFields ? "field" : "entry"}-${id}`}
                  label={w("collectionRemoveSeed")}
                  icon="trash"
                  size={26}
                  disabled={props.disabled || !row()}
                  onPress={() => remove(id)}
                />
              </If>
              <If when={cell.key !== "actions"}>
                <Input
                  testID={testID}
                  accessibilityLabel={w(
                    column === "field"
                      ? "collectionField"
                      : column === "score"
                        ? "memberScore"
                        : props.kind === "set" || props.kind === "zset"
                          ? "collectionMember"
                          : "collectionValue",
                  )}
                  value={row()?.[column] ?? ""}
                  onChange={({ value }) => {
                    if (!props.disabled && row()) {
                      state.change(id, column, value);
                      props.onChange?.();
                    }
                  }}
                  readonly={props.disabled || !row()}
                  autoFocus={focusRow() === id && cell.key === primaryColumn}
                  onFocus={() => {
                    if (focusRow() === id) focusRow.set(undefined);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={65536}
                  multiline={column === "value"}
                  submitBehavior="submit"
                  class={`flex-1 min-w-0 h-8 px-2 rounded font-mono text-foreground bg-transparent focus:bg-chrome disabled:opacity-35 ${column === "field" ? "text-(--text-size-12)/(--line-height-16)" : "text-(--editor-text-size)"}`}
                />
              </If>
            </View>
          );
        }}
      />
      <View class="flex-row items-center gap-2 px-2 py-2 bg-background border-t border-border/50">
        <Action
          testID={`${props.testIDPrefix}-add-${hasFields ? "field" : "entry"}`}
          label={w("collectionAddRow")}
          icon="plus"
          compact
          disabled={props.disabled || state.items().length >= 200}
          onPress={add}
        />
        <View class="flex-1" />
        <Text class="text-(--text-size-11) font-mono text-faint">
          {w("collectionSeedCount", { count: state.items().length })}
        </Text>
      </View>
    </View>
  );
}
