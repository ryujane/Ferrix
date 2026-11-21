import { computed, platform, signal, Scroll, Text, token, View } from "nsh";
import { Editor, Input, type EditorDecoration, type EditorRef } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { editorLineHeight, fonts } from "../../fonts";
import { KeyBadge } from "./workspace-controls";
import { dirty, type WorkspaceState } from "./workspace-state";
import {
  byteLabel,
  encode,
  hexView,
  isJson,
  jsonFolds,
  tableView,
  type ValueFormat,
} from "./workspace-values";
import { workspaceT as w } from "./workspace-text";
import { CollectionTable } from "./collection-table";
import { StreamTable } from "./stream-table";
import { useClipboardCopy } from "../../utils/clipboard";
import { ValueCodecControls } from "./value-codec-controls";
import { JsonPathBar } from "./json-path-bar";
import {
  valueDecodingNeedsJson,
  valuePreviewDirty,
  valuePreviewEditable,
} from "./value-codecs";

export type InspectorAction =
  | "rename"
  | "expiry"
  | "delete"
  | "reload"
  | "deleteRow"
  | "editRow"
  | "addStreamMessage"
  | "deleteStreamMessage"
  | "editJsonPath"
  | "deleteJsonPath";
function ttlLabel(milliseconds: string): string {
  let remaining = BigInt(milliseconds) / 1000n;
  if (remaining <= 0n) return w("durationSubsecond");
  const parts: string[] = [];
  const units = [
    ["durationDays", 86400n],
    ["durationHours", 3600n],
    ["durationMinutes", 60n],
    ["durationSeconds", 1n],
  ] as const;
  for (const [label, seconds] of units) {
    const count = remaining / seconds;
    remaining %= seconds;
    if (count > 0n) parts.push(w(label, { count: String(count) }));
  }
  return parts.join(" ");
}
export function KeyInspector(props: {
  state: WorkspaceState;
  onAction: (action: InspectorAction, id: string, value?: string) => void;
  active?: boolean;
}) {
  const state = props.state,
    wrap = signal(false);
  // AppKit's editor gutter adds substantial frame cost on long JSON scrolls.
  const jsonLineNumbers = signal(platform.os !== "macos");
  const copyToClipboard = useClipboardCopy();
  let editor: EditorRef | undefined;
  const tab = state.active;
  const preview = () => tab()?.preview;
  // TTL refreshes replace the tab while leaving the editor document intact.
  const format = computed(() => preview()?.format ?? tab()?.format);
  const value = computed(
    () => tab()?.json?.query?.value ?? preview()?.value ?? tab()?.value ?? "",
  );
  const validJson = computed(() => isJson(value()));
  const binary = () => preview()?.binary ?? tab()?.binary ?? false;
  const loading = () => !!tab()?.loading || !!preview()?.loading;
  const error = () => tab()?.error || preview()?.error;
  const previewFailed = () => !tab()?.error && !!preview()?.error;
  const editable = () =>
    !!tab() &&
    !tab()?.json?.query &&
    !tab()?.json?.loading &&
    (preview() ? valuePreviewEditable(preview()!) : !!tab()?.editable) &&
    ["json", "text"].includes(format()!) &&
    !tab()?.loading &&
    !tab()?.uncertain;
  const table = () =>
    !!(tab()?.collection || tab()?.stream) && tab()?.format === "table";
  const savable = () =>
    (editable() ||
      (!!tab()?.collection &&
        !!tab()?.info?.exists &&
        !tab()?.collection?.loading)) &&
    !tab()?.loading &&
    !tab()?.error &&
    !tab()?.uncertain;
  const shown = computed(() => {
    const current = tab();
    if (!current) return "";
    if (preview()?.loading || preview()?.error) return "";
    return format() === "hex"
      ? hexView(
          preview()
            ? valuePreviewDirty(preview())
              ? encode(preview()!.value)
              : preview()!.bytes
            : current.binary || !dirty(current)
              ? current.bytes
              : encode(current.value),
        )
      : format() === "table"
        ? tableView(value())
        : value();
  });
  const folds = computed(() => (format() === "json" ? jsonFolds(shown()) : []));
  const decorations = computed<EditorDecoration[]>(() =>
    format() !== "json"
      ? []
      : shown()
          .split("\n")
          .flatMap((line, index) =>
            Array.from(line.matchAll(/"(?:\\.|[^"\\])*"/g), (match) => ({
              range: {
                start: { line: index, column: match.index },
                end: { line: index, column: match.index + match[0].length },
              },
              class: /^\s*:/.test(line.slice(match.index + match[0].length))
                ? "text-steel"
                : "text-code-string",
            })),
          ),
  );
  async function copy() {
    await copyToClipboard(shown());
  }
  return (
    <View
      testID="workspace-inspector"
      class="flex-1 min-w-0 min-h-0 bg-workspace"
    >
      <If when={tab()}>
        <View class="px-3 py-2 gap-2 border-b border-border/50">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class="text-(--text-size-11) text-muted-foreground">
              {w("keyName")}
            </Text>
            <Input
              testID="workspace-key-name"
              accessibilityLabel={w("keyName")}
              value={tab()!.name || w("emptyKey")}
              readonly
              onPress={({ clickCount }) => {
                const current = tab();
                if (clickCount === 2 && current)
                  void copyToClipboard(current.name);
              }}
              // Keep clicks on the NSH host; the native text editor consumes them.
              style={{ pointerEvents: "box-only" }}
              class="flex-1 min-w-[160px] h-8 px-2 font-mono text-(--text-size-12)/(--line-height-16) text-foreground border border-border-strong bg-inset"
            />
            <IconButton
              testID="workspace-rename"
              label={w("rename")}
              icon="pencil"
              disabled={
                state.mutating() ||
                tab()!.loading ||
                tab()!.collection?.loading ||
                tab()!.stream?.loading ||
                tab()!.uncertain ||
                tab()!.json?.loading ||
                preview()?.loading
              }
              onPress={() => props.onAction("rename", tab()!.id)}
              size={28}
            />
            <Action
              testID="workspace-save"
              label={w("save")}
              icon="save"
              primary
              compact
              disabled={
                !savable() ||
                !dirty(tab()) ||
                state.mutating() ||
                ((tab()?.info?.type === "json" ||
                  format() === "json" ||
                  valueDecodingNeedsJson(preview()?.decoding)) &&
                  !validJson())
              }
              onPress={() => void state.save()}
            />
            <Action
              testID="workspace-reload"
              label={w("reload")}
              icon="refresh"
              compact
              disabled={state.mutating() || tab()!.loading}
              onPress={() => props.onAction("reload", tab()!.id)}
            />
            <Action
              testID="workspace-delete"
              label={w("delete")}
              icon="trash"
              compact
              disabled={state.mutating() || tab()!.loading || tab()!.uncertain}
              onPress={() => props.onAction("delete", tab()!.id)}
            />
          </View>
          <View class="flex-row flex-wrap items-center gap-x-4 gap-y-1">
            <View class="flex-row items-center gap-1">
              <Text class="text-(--text-size-10) text-muted-foreground">{w("type")}</Text>
              <KeyBadge type={tab()!.info?.type} />
            </View>
            <View class="flex-row items-center gap-1">
              <Text class="text-(--text-size-10) text-muted-foreground">TTL</Text>
              <Text
                testID="workspace-ttl"
                class="text-(--text-size-10) font-mono text-success"
              >
                {tab()!.info?.expiration === "missing"
                  ? w("keyMissing")
                  : tab()!.info?.expiration === "persistent"
                    ? w("persistent")
                    : tab()!.info?.ttlMs != null
                      ? ttlLabel(tab()!.info!.ttlMs!)
                      : "-"}
              </Text>
              <Action
                testID="workspace-edit-ttl"
                label={w("modify")}
                compact
                disabled={
                  state.mutating() || tab()!.loading || tab()!.uncertain
                }
                onPress={() => props.onAction("expiry", tab()!.id)}
              />
            </View>
            <Text class="text-(--text-size-10) text-muted-foreground">
              {w(
                ["string", "json"].includes(tab()!.info?.type ?? "")
                  ? "size"
                  : "entries",
              )}
              :{" "}
              <Text class="font-mono text-foreground">
                {tab()!.info?.type === "json" && !tab()!.partial
                  ? byteLabel(tab()!.bytes.length)
                  : tab()!.info?.length != null
                    ? tab()!.info?.type === "string"
                      ? byteLabel(tab()!.info!.length!)
                      : tab()!.info!.length
                    : "-"}
              </Text>
            </Text>
            <Text class="text-(--text-size-10) text-muted-foreground">
              {w("memoryUsage")}:{" "}
              <Text
                testID="workspace-memory-usage"
                class="font-mono text-foreground"
              >
                {tab()!.info?.exists &&
                tab()!.info?.memoryStatus === "available" &&
                tab()!.info?.memoryBytes != null
                  ? byteLabel(tab()!.info!.memoryBytes!)
                  : "-"}
              </Text>
            </Text>
            <View class="flex-1" />
            <Text class="text-(--text-size-10) font-mono text-faint">
              {w(dirty(tab()) ? "unsaved" : "upToDate")}
            </Text>
          </View>
        </View>
        <Scroll
          horizontal
          class="h-9 shrink-0 border-b border-border/50"
          contentClass="flex-row items-center px-3 gap-1"
        >
          <Text class="text-(--text-size-11) text-faint mr-2">{w("format")}</Text>
          <Each
            of={
              (tab()!.json
                ? ["json", "text"]
                : tab()!.collection || tab()!.stream
                  ? ["table", "json", "text"]
                  : preview()
                    ? ["json", "text", "hex"]
                    : ["json", "text", "table", "hex"]) as ValueFormat[]
            }
            key={(format) => format}
          >
            {(format) => (
              <Action
                testID={`workspace-format-${format()}`}
                label={w(format())}
                compact
                selected={(preview()?.format ?? tab()?.format) === format()}
                disabled={
                  loading() ||
                  !!error() ||
                  (binary() && format() !== "hex") ||
                  (format() === "hex" && tab()!.info?.type !== "string")
                }
                onPress={() => state.setFormat(format())}
              />
            )}
          </Each>
        </Scroll>
        <If when={tab()!.info?.type === "string"}>
          <ValueCodecControls state={state} tab={tab()!} />
        </If>
        <If when={!!tab()!.json}>
          <JsonPathBar
            state={state}
            tab={tab()!}
            onSet={() => props.onAction("editJsonPath", tab()!.id)}
            onDelete={() => props.onAction("deleteJsonPath", tab()!.id)}
          />
        </If>
        <If when={!table()}>
          <View class="h-9 px-2 flex-row items-center gap-1 border-b border-border/40">
            <IconButton
              testID="workspace-edit-value"
              label={w("editValue")}
              icon="pencil"
              size={26}
              disabled={!editable()}
              onPress={() => editor?.focus()}
            />
            <Action
              testID="workspace-pretty-json"
              label={w("formatJson")}
              icon="braces"
              compact
              disabled={!editable()}
              onPress={() => state.transform(false)}
            />
            <Action
              testID="workspace-compact-json"
              label={w("compact")}
              compact
              disabled={!editable()}
              onPress={() => state.transform(true)}
            />
            <IconButton
              testID="workspace-copy"
              label={w("copy")}
              icon="copy"
              size={26}
              disabled={loading() || !!error()}
              onPress={() => void copy()}
            />
            <View class="flex-1" />
            <IconButton
              label={w("collapseAll")}
              icon="collapse"
              size={26}
              disabled={!folds().length}
              onPress={() => editor?.run("foldAll")}
            />
            <IconButton
              label={w("expandAll")}
              icon="expand"
              size={26}
              onPress={() => editor?.run("unfoldAll")}
            />
            <If when={format() === "json"}>
              <Action
                testID="workspace-json-line-numbers"
                label={w("lineNumbers")}
                compact
                selected={jsonLineNumbers()}
                onPress={() => jsonLineNumbers.set(!jsonLineNumbers())}
              />
            </If>
            <IconButton
              label={w("wrap")}
              icon="wrap"
              size={26}
              selected={wrap()}
              onPress={() => wrap.set(!wrap())}
            />
          </View>
        </If>
        <If when={loading()}>
          <View class="flex-1 items-center justify-center gap-3">
            <Icon name="refresh" size={25} />
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">{w("loading")}</Text>
          </View>
        </If>
        <If when={!loading() && !!error()}>
          <View class="flex-1 p-6 gap-3">
            <Text
              testID="workspace-value-error"
              class="text-(--text-size-12)/(--line-height-16) text-destructive"
            >
              {w(previewFailed() ? "valueCodecErrorStatus" : "keyLoadFailed")}
            </Text>
            <Action
              label={w(previewFailed() ? "valueCodecRetry" : "reload")}
              onPress={() =>
                previewFailed()
                  ? void state.setValuePreview(
                      tab()!.id,
                      preview()!.decoding,
                      preview()!.decompression,
                    )
                  : props.onAction("reload", tab()!.id)
              }
            />
          </View>
        </If>
        <If when={!loading() && !error()}>
          <If when={table() && !!tab()!.collection}>
            <CollectionTable
              state={state}
              tab={tab()!}
              active={props.active !== false}
              onEditRow={(rowId) => props.onAction("editRow", tab()!.id, rowId)}
              onDeleteRow={(rowId) =>
                props.onAction("deleteRow", tab()!.id, rowId)
              }
            />
          </If>
          <If when={table() && !!tab()!.stream}>
            <StreamTable
              state={state}
              tab={tab()!}
              active={props.active !== false}
              onAdd={() => props.onAction("addStreamMessage", tab()!.id)}
              onDelete={(messageId) =>
                props.onAction("deleteStreamMessage", tab()!.id, messageId)
              }
            />
          </If>
          <If when={!table()}>
            <Editor
              ref={(ref) => {
                editor = ref;
              }}
              testID="workspace-value-editor"
              accessibilityLabel={w("valueEditor")}
              value={shown()}
              onChange={({ value }) => {
                if (editable()) state.edit(value);
              }}
              readOnly={!editable()}
              language={format() === "json" ? "json" : "text"}
              highlighting={false}
              decorations={decorations()}
              lineNumbers={format() !== "json" || jsonLineNumbers()}
              folding={format() === "json"}
              foldRanges={folds()}
              fontFamily={fonts.mono}
              fontSize={token("editor-text-size")}
              lineHeight={editorLineHeight()}
              softWrap={wrap()}
              scrollBeyondLastLine={false}
              class="flex-1 min-h-0 bg-workspace text-foreground"
              classes={{
                gutter: "bg-workspace text-faint border-r border-border/40",
                content: "bg-workspace px-3",
                lineNumber: "text-faint",
                foldMarker: "text-muted-foreground",
                activeLine: "bg-accent/20",
                indentGuide: "bg-border/30",
                foldPlaceholder: "text-steel",
              }}
            />
          </If>
        </If>
        <If when={!table() && !error()}>
          <View class="h-6 px-3 flex-row items-center gap-3 border-t border-border/50">
            <Text class="text-(--text-size-10) text-faint font-mono">
              {w("lines", { count: shown().split("\n").length })}
            </Text>
            <Text class="text-(--text-size-10) text-faint font-mono">
              {binary() ? "BINARY" : "UTF-8"}
            </Text>
            <View class="flex-1" />
            <Text
              testID="workspace-value-status"
              class={`text-(--text-size-10) ${format() === "json" && !validJson() ? "text-destructive" : "text-success"}`}
            >
              {loading()
                ? w("loading")
                : format() === "json"
                  ? w(validJson() ? "validJson" : "invalidJson")
                  : w(editable() ? "editable" : "readOnly")}
            </Text>
          </View>
        </If>
      </If>
      <If when={!tab()}>
        <View class="flex-1 items-center justify-center gap-3 p-6">
          <Icon name="braces" size={38} color={token("faint")} />
          <Text class="text-(--text-size-14)/(--line-height-20) text-muted-foreground">{w("selectKey")}</Text>
          <Text class="text-(--text-size-12)/(--line-height-16) text-faint">{w("selectKeyHint")}</Text>
        </View>
      </If>
    </View>
  );
}
