import {
  computed,
  effect,
  keymap,
  List,
  Scroll,
  signal,
  Text,
  View,
  type JSX,
  type ListRef,
  type ScrollRef,
  type ViewRef,
  type WheelEvent,
} from "nsh";
import type { ScrollbarTheme } from "nsh/base";
import { fonts } from "../../fonts";
import { useClipboardCopy } from "../../utils/clipboard";
import { workspaceT as w } from "./workspace-text";

const ROW_HEIGHT = 42;
const ROW_NUMBER_WIDTH = 40;
const MIN_SCROLLABLE_WIDTH = 80;
const MAX_COLUMN_WIDTH = 1200;

const horizontalScrollbar: ScrollbarTheme = {
  mode: "always",
  horizontal: {
    class: "absolute inset-x-0 bottom-0 h-3 px-1 py-0.5 bg-chrome",
    thumbClass:
      "h-full rounded-full bg-border-strong hover:bg-muted-foreground active:bg-primary",
  },
};

export type CollectionGridColumn<Key extends string> = {
  key: Key;
  title: string;
  width: number;
  minWidth: number;
  fixed?: true;
  fill?: true;
  textClass?: string;
};

type PlacedColumn<Key extends string> = CollectionGridColumn<Key> & {
  offset: number;
};

type GridLayout<Key extends string> = {
  fixed: PlacedColumn<Key>[];
  scrolling: PlacedColumn<Key>[];
  fixedWidth: number;
  actionsFixed: boolean;
  viewportWidth: number;
  contentWidth: number;
};

function placeColumns<Key extends string>(
  columns: readonly CollectionGridColumn<Key>[],
  widths: Partial<Record<Key, number>>,
  viewport: number,
  actionsWidth: number,
): GridLayout<Key> {
  const fixed: PlacedColumn<Key>[] = [];
  const scrolling: PlacedColumn<Key>[] = [];
  const center: CollectionGridColumn<Key>[] = [];
  // At the pane's minimum width all columns are reachable through the scroller.
  const actionsFixed =
    viewport >= ROW_NUMBER_WIDTH + actionsWidth + MIN_SCROLLABLE_WIDTH;
  const fixedActionsWidth = actionsFixed ? actionsWidth : 0;
  const fixedLimit = Math.max(
    ROW_NUMBER_WIDTH,
    viewport - fixedActionsWidth - MIN_SCROLLABLE_WIDTH,
  );
  let fixedWidth = ROW_NUMBER_WIDTH;
  for (const column of columns) {
    const available = fixedLimit - fixedWidth;
    if (!column.fixed || available < column.minWidth) {
      center.push(column);
      continue;
    }
    const width = Math.min(widths[column.key] ?? column.width, available);
    fixed.push({ ...column, width, offset: fixedWidth });
    fixedWidth += width;
  }
  const viewportWidth = Math.max(0, viewport - fixedWidth - fixedActionsWidth);
  const scrollingActionsWidth = actionsFixed ? 0 : actionsWidth;
  const naturalWidth = center.reduce(
    (sum, column) => sum + (widths[column.key] ?? column.width),
    scrollingActionsWidth,
  );
  const fill = center.find(
    (column) => column.fill && widths[column.key] === undefined,
  );
  let offset = 0;
  for (const column of center) {
    const base = widths[column.key] ?? column.width;
    const width =
      column === fill ? base + Math.max(0, viewportWidth - naturalWidth) : base;
    scrolling.push({ ...column, width, offset });
    offset += width;
  }
  return {
    fixed,
    scrolling,
    fixedWidth,
    actionsFixed,
    viewportWidth,
    contentWidth: Math.max(viewportWidth, offset + scrollingActionsWidth),
  };
}

function GridColumns<Key extends string>(props: {
  layout: GridLayout<Key>;
  scrollLeft: number;
  render: (column: () => PlacedColumn<Key>) => JSX.Element;
  actions: JSX.Element;
}) {
  const key = (column: PlacedColumn<Key>) => column.key;
  return (
    <>
      <Each of={props.layout.fixed} key={key}>
        {(column) => props.render(column)}
      </Each>
      <View class="relative flex-1 min-w-0 overflow-hidden">
        <View
          class="absolute inset-y-0 flex-row"
          style={{
            width: props.layout.contentWidth,
            left: -props.scrollLeft,
          }}
        >
          <Each of={props.layout.scrolling} key={key}>
            {(column) => props.render(column)}
          </Each>
          <If when={!props.layout.actionsFixed}>{props.actions}</If>
        </View>
      </View>
      <If when={props.layout.actionsFixed}>{props.actions}</If>
    </>
  );
}

function ColumnResize(props: {
  testID: string;
  width: number;
  onResize: (width: number) => void;
}) {
  const dragging = signal(false);
  let start: { x: number; width: number } | undefined;
  const move = (x: number) => {
    if (!start) return;
    const delta = x - start.x;
    if (!dragging() && Math.abs(delta) < 2) return;
    dragging.set(true);
    props.onResize(start.width + delta);
  };
  const finish = () => {
    start = undefined;
    dragging.set(false);
  };
  return (
    <View
      testID={props.testID}
      focusable={false}
      class={`absolute inset-y-0 right-0 w-2 items-end cursor-col-resize group ${dragging() ? "bg-primary/10" : ""}`}
      onStartShouldSetResponder={() => true}
      onResponderGrant={({ pageX }) => {
        start = { x: pageX, width: props.width };
        return true;
      }}
      onResponderMove={({ pageX }) => move(pageX)}
      onResponderRelease={({ pageX }) => {
        move(pageX);
        finish();
      }}
      onResponderTerminationRequest={() => false}
      onResponderTerminate={finish}
    >
      <View
        class={`w-px h-full group-hover:bg-primary ${dragging() ? "bg-primary" : "bg-border/50"}`}
      />
    </View>
  );
}

type Selection<Key extends string> = { row: string; column?: Key };
type Move =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageup"
  | "pagedown"
  | "home"
  | "end";

export function CollectionGrid<Row, Key extends string>(props: {
  testID: string;
  label: string;
  active: boolean;
  tabId: string;
  rows: Row[];
  columns: CollectionGridColumn<Key>[];
  rowKey: (row: Row) => string;
  cellText: (row: Row, column: Key) => string;
  actionsWidth: number;
  renderActions: (row: () => Row) => JSX.Element;
  renderCell?: (row: () => Row, column: Key) => JSX.Element;
  onEditCell?: (row: Row, column: Key) => void;
  rowEditColumn?: Key;
  reveal?: { row: string; column: Key };
  dirtyRow?: (row: Row) => boolean;
  empty: JSX.Element;
}) {
  const viewport = signal(800);
  const listHeight = signal(0);
  const list = signal<ListRef>();
  const widths = signal<Partial<Record<Key, number>>>({});
  const selection = signal<Selection<Key>>();
  const focused = signal(false);
  const layout = computed(() =>
    placeColumns(props.columns, widths(), viewport(), props.actionsWidth),
  );
  const maxScroll = computed(
    () => layout().contentWidth - layout().viewportWidth,
  );
  const scrollLeft = signal(0);
  const copy = useClipboardCopy();
  let grid: ViewRef | undefined;
  let horizontal: ScrollRef | undefined;

  function scrollHorizontally(x: number) {
    const next = Math.max(0, Math.min(maxScroll(), x));
    if (next === scrollLeft()) return;
    scrollLeft.set(next);
    horizontal?.scrollTo({ x: next, animated: false });
  }

  function wheel({ delta, deltaMode, modifiers }: WheelEvent) {
    const distance = modifiers.shift
      ? delta.x || delta.y
      : Math.abs(delta.x) > Math.abs(delta.y)
        ? delta.x
        : 0;
    if (distance)
      scrollHorizontally(
        scrollLeft() + distance * (deltaMode === "lines" ? 24 : 1),
      );
  }

  effect(() => {
    const limit = maxScroll();
    if (limit === 0) {
      scrollLeft.set(0);
      horizontal = undefined;
    } else if (scrollLeft() > limit) scrollHorizontally(limit);
  });
  let tab = props.tabId;
  effect(() => {
    if (tab === props.tabId) return;
    tab = props.tabId;
    selection.set(undefined);
    widths.set({});
    scrollHorizontally(0);
    list()?.scrollToOffset({ offset: 0, animated: false });
  });
  effect(() => {
    const current = selection();
    if (current && !props.rows.some((row) => props.rowKey(row) === current.row))
      selection.set(undefined);
  });

  async function revealRow(next: Selection<Key>) {
    const view = list();
    const position = await view?.measureScrollPosition();
    if (
      !view ||
      view !== list() ||
      !position ||
      selection() !== next ||
      !props.active
    )
      return;
    const index = props.rows.findIndex((row) => props.rowKey(row) === next.row);
    if (index < 0) return;
    const height = listHeight();
    const top = position.index * ROW_HEIGHT + position.offset;
    const rowTop = index * ROW_HEIGHT;
    if (rowTop < top) view.scrollToIndex({ index, animated: false });
    else if (rowTop + ROW_HEIGHT > top + height)
      view.scrollToIndex({ index, viewPosition: 1, animated: false });
  }

  function revealColumn(key: Key | undefined) {
    const placed = layout();
    const column = placed.scrolling.find((item) => item.key === key);
    if (!column) return;
    const end = column.offset + column.width;
    if (column.offset < scrollLeft() || column.width > placed.viewportWidth)
      scrollHorizontally(column.offset);
    else if (end > scrollLeft() + placed.viewportWidth)
      scrollHorizontally(end - placed.viewportWidth);
  }
  let revealed: typeof props.reveal;
  effect(() => {
    const request = props.reveal;
    const view = list();
    if (!request || request === revealed || !view || !props.active) return;
    const index = props.rows.findIndex(
      (row) => props.rowKey(row) === request.row,
    );
    if (index < 0) return;
    revealed = request;
    view.scrollToIndex({ index, animated: false });
    revealColumn(request.column);
  });

  function resize(column: PlacedColumn<Key>, width: number) {
    const { key, minWidth } = column;
    const next = Math.round(
      Math.max(minWidth, Math.min(MAX_COLUMN_WIDTH, width)),
    );
    if (widths()[key] !== next) widths.set({ ...widths(), [key]: next });
    const placed = layout();
    const resized = placed.scrolling.find((item) => item.key === key);
    if (!resized) return;
    const end = resized.offset + resized.width;
    scrollHorizontally(
      Math.min(end - 8, Math.max(scrollLeft(), end - placed.viewportWidth)),
    );
  }

  function move(direction: Move) {
    const rows = props.rows;
    const columns = props.columns;
    if (!rows.length || !columns.length) return;
    const current = selection();
    let row = rows.findIndex((item) => props.rowKey(item) === current?.row);
    let column = current?.column;
    const lateral = direction === "left" || direction === "right";
    const edge = direction === "home" || direction === "end";
    if (row < 0) {
      row = 0;
      column = columns[0].key;
    } else if (lateral || (edge && column !== undefined)) {
      const at = columns.findIndex((item) => item.key === column);
      const last = columns.length - 1;
      const next = edge
        ? direction === "home"
          ? 0
          : last
        : at < 0
          ? 0
          : (at + (direction === "left" ? -1 : 1) + columns.length) %
            columns.length;
      column = columns[next].key;
    } else if (edge) {
      row = direction === "home" ? 0 : rows.length - 1;
    } else if (direction === "up" || direction === "down") {
      row = (row + (direction === "up" ? -1 : 1) + rows.length) % rows.length;
    } else {
      const page = Math.max(1, Math.floor(listHeight() / ROW_HEIGHT));
      row = Math.max(
        0,
        Math.min(
          rows.length - 1,
          row + (direction === "pageup" ? -page : page),
        ),
      );
    }
    const next = { row: props.rowKey(rows[row]), column };
    selection.set(next);
    revealColumn(column);
    void revealRow(next);
  }

  function copySelection() {
    const current = selection();
    if (!current) return;
    const row = props.rows.find((item) => props.rowKey(item) === current.row);
    if (!row) return;
    void copy(
      current.column === undefined
        ? props.columns
            .map((column) => props.cellText(row, column.key))
            .join("\t")
        : props.cellText(row, current.column),
    );
  }

  effect(() => {
    if (!props.active || !focused()) return;
    const stopMoves = keymap.bind(
      {
        up: () => move("up"),
        down: () => move("down"),
        left: () => move("left"),
        right: () => move("right"),
        pageup: () => move("pageup"),
        pagedown: () => move("pagedown"),
        home: () => move("home"),
        end: () => move("end"),
      },
      { when: "notEditing", repeat: true, forFocus: true },
    );
    const stopCommands = keymap.bind(
      {
        tab: () => move("right"),
        "shift+tab": () => move("left"),
        "mod+c": copySelection,
        escape: () => {
          if (selection()) selection.set(undefined);
          else grid?.blur();
        },
      },
      { when: "notEditing", forFocus: true },
    );
    return () => {
      stopMoves();
      stopCommands();
    };
  });

  function select(row: Row, clicks: number, column?: Key) {
    selection.set({ row: props.rowKey(row), column });
    grid?.focus();
    const editColumn = column ?? props.rowEditColumn;
    if (clicks === 2 && editColumn !== undefined && props.onEditCell) {
      revealColumn(editColumn);
      props.onEditCell(row, editColumn);
    }
  }

  const titleClass =
    "line-clamp-1 text-(--text-size-11) font-semibold text-muted-foreground";
  const fixedSizing = { width: ROW_NUMBER_WIDTH, flexShrink: 0 };
  const actionsSizing = () => ({ width: props.actionsWidth, flexShrink: 0 });
  return (
    <View
      ref={(ref) => {
        grid = ref;
      }}
      role="grid"
      accessibilityLabel={props.label}
      focusable={props.active}
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      onLayout={({ bounds }) => viewport.set(bounds.size.width)}
      class="flex-1 min-w-0 min-h-0"
    >
      <View
        role="row"
        onWheel={maxScroll() > 0 ? wheel : undefined}
        class="h-[34px] shrink-0 flex-row border-b border-border"
      >
        <View style={fixedSizing} />
        <GridColumns
          layout={layout()}
          scrollLeft={scrollLeft()}
          actions={
            <View
              role="columnheader"
              style={actionsSizing()}
              class="justify-center px-2"
            >
              <Text class={titleClass} style={{ fontFamily: fonts.mono }}>
                {w("collectionActions")}
              </Text>
            </View>
          }
          render={(column) => (
            <View
              role="columnheader"
              class="relative justify-center pl-2 pr-3 overflow-hidden"
              style={{ width: column().width, flexShrink: 0 }}
            >
              <Text class={titleClass} style={{ fontFamily: fonts.mono }}>
                {column().title}
              </Text>
              <ColumnResize
                testID={`${props.testID}-resize-${column().key}`}
                width={column().width}
                onResize={(width) => resize(column(), width)}
              />
            </View>
          )}
        />
      </View>
      <List
        ref={(ref) => list.set(ref)}
        testID={props.testID}
        class="flex-1 min-w-0 min-h-0 bg-workspace"
        each={props.rows}
        keyExtractor={props.rowKey}
        estimatedItemSize={ROW_HEIGHT}
        empty={props.empty}
        onLayout={({ bounds }) => listHeight.set(bounds.size.height)}
        onWheel={maxScroll() > 0 ? wheel : undefined}
      >
        {(row, index) => {
          const rowSelection = computed(() => {
            const current = selection();
            return current?.row === props.rowKey(row()) ? current : undefined;
          });
          const selected = () =>
            !!rowSelection() && rowSelection()?.column === undefined;
          return (
            <View
              role="row"
              accessibilityState={{ selected: selected() }}
              class={`flex-row items-stretch font-mono text-(--text-size-11) border-b border-border/30 ${selected() ? "bg-selected" : props.dirtyRow?.(row()) ? "bg-primary/5" : index() % 2 ? "bg-background/40" : "bg-workspace"}`}
              style={{ height: ROW_HEIGHT }}
            >
              <View
                role="cell"
                accessibilityState={{ selected: selected() }}
                focusable={false}
                style={fixedSizing}
                onPress={({ clickCount }) => select(row(), clickCount)}
                class="items-center justify-center bg-chrome/50"
              >
                <Text class="text-(--text-size-10) text-faint">{index() + 1}</Text>
              </View>
              <GridColumns
                layout={layout()}
                scrollLeft={scrollLeft()}
                actions={
                  <View
                    role="cell"
                    style={actionsSizing()}
                    class="px-2 justify-center overflow-hidden"
                  >
                    {props.renderActions(row)}
                  </View>
                }
                render={(column) => {
                  // Each preserves this cell while its column width and row change.
                  const key = column().key;
                  const cellSelected = () => rowSelection()?.column === key;
                  return (
                    <View
                      role="cell"
                      accessibilityState={{ selected: cellSelected() }}
                      focusable={false}
                      style={{ width: column().width, flexShrink: 0 }}
                      onPress={({ clickCount }) =>
                        select(row(), clickCount, key)
                      }
                      class={`px-2 justify-center overflow-hidden ${cellSelected() ? "bg-selected" : ""}`}
                    >
                      {props.renderCell?.(row, key) ?? (
                        <Text
                          class={`line-clamp-1 ${column().textClass ?? "text-foreground"}`}
                        >
                          {props.cellText(row(), key) || "∅"}
                        </Text>
                      )}
                    </View>
                  );
                }}
              />
            </View>
          );
        }}
      </List>
      <If when={maxScroll() > 0}>
        <View class="h-3 shrink-0 flex-row bg-chrome">
          <View style={{ width: layout().fixedWidth }} />
          <Scroll
            ref={(ref) => {
              horizontal = ref;
              if (scrollLeft())
                ref.scrollTo({ x: scrollLeft(), animated: false });
            }}
            testID={`${props.testID}-horizontal`}
            horizontal
            bounces={false}
            scrollbar={horizontalScrollbar}
            onScroll={({ offset }) =>
              scrollLeft.set(Math.min(maxScroll(), Math.max(0, offset.x)))
            }
            class="flex-1 min-w-0"
          >
            <View style={{ width: layout().contentWidth, height: 1 }} />
          </Scroll>
          <If when={layout().actionsFixed}>
            <View style={actionsSizing()} />
          </If>
        </View>
      </If>
    </View>
  );
}
