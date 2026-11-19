import { computed, effect, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { CollectionGrid, type CollectionGridColumn } from "./collection-grid";
import { useClipboardCopy } from "../../utils/clipboard";
import { WorkspaceHintButton } from "./workspace-controls";
import { displayBytes } from "./workspace-values";
import type { KeyTab, WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

type Column = "id" | "field" | "value";
type StreamRow = Record<Column, string> & { ordinal: number };

const rowKey = ({ id, ordinal }: StreamRow) => `${id}-${ordinal}`;

export function StreamTable(props: {
  state: WorkspaceState;
  tab: KeyTab;
  active: boolean;
  onAdd: () => void;
  onDelete: (messageId: string) => void;
}) {
  const query = signal("");
  const copy = useClipboardCopy();
  let previousTab: string | undefined;
  effect(() => {
    if (props.tab.id !== previousTab) {
      previousTab = props.tab.id;
      query.set("");
    }
  });
  const stream = () => props.tab.stream!;
  const writable = () =>
    props.active &&
    !!props.tab.info?.exists &&
    !props.tab.loading &&
    !props.tab.uncertain &&
    !stream().loading &&
    !props.state.mutating() &&
    !props.state.switching();
  const entries = computed(() => stream().entries);
  const fields = computed<StreamRow[]>(() =>
    entries().flatMap((entry) =>
      (entry.fields.length
        ? entry.fields
        : [{ field: new Uint8Array(), value: new Uint8Array() }]
      ).map((pair, ordinal) => ({
        id: entry.id,
        field: displayBytes(pair.field),
        value: displayBytes(pair.value),
        ordinal,
      })),
    ),
  );
  const rows = computed(() => {
    const filter = query().trim().toLowerCase();
    return filter
      ? fields().filter((row) =>
          [row.id, row.field, row.value].some((text) =>
            text.toLowerCase().includes(filter),
          ),
        )
      : fields();
  });
  const columns = computed<CollectionGridColumn<Column>[]>(() => [
    {
      key: "id",
      title: w("streamId"),
      width: 190,
      minWidth: 120,
      fixed: true,
      textClass: "text-steel",
    },
    {
      key: "field",
      title: w("collectionField"),
      width: 180,
      minWidth: 100,
      textClass: "text-steel",
    },
    {
      key: "value",
      title: w("collectionValue"),
      width: 220,
      minWidth: 160,
      fill: true,
      textClass: "text-(--editor-text-size) text-foreground",
    },
  ]);
  function renderActions(row: () => StreamRow) {
    return (
      <View
        testID={`workspace-stream-row-${rowKey(row())}`}
        class="h-full flex-row items-center"
      >
        <IconButton
          testID="workspace-stream-copy"
          label={w("copy")}
          icon="copy"
          size={26}
          onPress={() => void copy(row().value)}
        />
        <IconButton
          testID="workspace-stream-delete"
          label={w("streamDeleteMessage")}
          icon="trash"
          size={26}
          color={token("destructive")}
          disabled={!writable()}
          onPress={() => {
            if (writable()) props.onDelete(row().id);
          }}
        />
      </View>
    );
  }
  return (
    <View
      testID="workspace-stream-table"
      class="flex-1 min-w-0 min-h-0 bg-workspace"
    >
      <View class="px-3 py-2 flex-row items-center gap-2 border-b border-border/50">
        <View class="flex-1 min-w-0 h-8 px-2 flex-row items-center gap-2 border border-border-strong rounded bg-inset focus-within:border-ring">
          <Icon name="search" size={13} />
          <Input
            testID="workspace-stream-filter"
            accessibilityLabel={w("streamFilter")}
            placeholder={w("streamFilter")}
            value={query()}
            onChange={({ value }) => query.set(value)}
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-12)/(--line-height-16) text-foreground"
          />
        </View>
        <Action
          testID="workspace-stream-add-message"
          label={w("streamAddMessage")}
          icon="plus"
          compact
          disabled={!writable()}
          onPress={props.onAdd}
        />
        <WorkspaceHintButton message={w("streamHint")} />
      </View>
      <CollectionGrid
        testID="workspace-stream-grid"
        label={w("streamMessages")}
        active={props.active}
        tabId={props.tab.id}
        rows={rows()}
        columns={columns()}
        rowKey={rowKey}
        cellText={(row, column) => row[column]}
        actionsWidth={96}
        renderActions={renderActions}
        empty={
          <View class="flex-1 items-center justify-center p-6">
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {w(query().trim() ? "nothingFound" : "streamEmpty")}
            </Text>
          </View>
        }
      />
      <View class="min-h-8 px-3 py-1 flex-row flex-wrap items-center gap-2 border-t border-border/50">
        <Text
          testID="workspace-stream-count"
          class="flex-1 text-(--text-size-10) font-mono text-faint"
        >
          {w("streamLoaded", {
            loaded: stream().entries.length,
            total: props.tab.info?.length ?? "-",
          })}
        </Text>
        <If when={!stream().complete}>
          <Action
            testID="workspace-stream-load-more"
            label={w(stream().loading ? "loading" : "loadMore")}
            compact
            disabled={
              stream().loading ||
              props.tab.uncertain ||
              props.state.switching() ||
              props.state.mutating()
            }
            onPress={() => void props.state.loadMoreStream(props.tab.id)}
          />
        </If>
      </View>
    </View>
  );
}
