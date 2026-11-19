import { computed, keymap, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon } from "../../components/icon";
import { Tooltip } from "../../components/tooltip";
import {
  createCollectionSeeds,
  CollectionSeedEditor,
} from "./collection-seed-editor";
import { validStreamId } from "./stream-values";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";
import { byteLabel, encode } from "./workspace-values";
import { WorkspaceWriteDialog } from "./workspace-write-dialog";

export function StreamMessageDialog(props: {
  state: WorkspaceState;
  tabId: string;
  onClose: () => void;
}) {
  const state = props.state;
  const id = signal("*"),
    fields = createCollectionSeeds(),
    error = signal("");
  const tab = () => state.tabs().find((item) => item.id === props.tabId);
  const available = () =>
    !!tab()?.stream &&
    !!tab()?.info?.exists &&
    !tab()?.loading &&
    !tab()?.uncertain &&
    !tab()?.stream?.loading &&
    !state.mutating() &&
    !state.switching();
  const close = () => {
    if (!state.mutating()) props.onClose();
  };
  const count = () =>
    state.databases().find((item) => item.database === state.database())
      ?.keyCount;
  const dataSize = computed(() =>
    fields
      .items()
      .reduce(
        (bytes, field) =>
          bytes + encode(field.field).length + encode(field.value).length,
        tab()?.key.length ?? 0,
      ),
  );
  async function add() {
    if (!available()) return;
    if (!fields.items().length) {
      error.set(w("newKeyCollectionRequired"));
      return;
    }
    const messageId = id().trim() || "*";
    if (
      messageId !== "*" &&
      (!validStreamId(messageId) || messageId === "0-0")
    ) {
      error.set(w("streamInvalidId"));
      return;
    }
    error.set("");
    const ok = await state.addStreamMessage(props.tabId, {
      id: messageId,
      fields: fields.toFields(),
    });
    if (ok) props.onClose();
    else error.set(state.error() || w("operationFailed"));
  }
  keymap.bind("mod+enter", () => void add(), { when: "always" });
  const inputClass =
    "h-9 px-3 text-(--text-size-12)/(--line-height-16) font-mono text-foreground border border-border bg-chrome rounded focus:border-ring";
  return (
    <WorkspaceWriteDialog
      title={w("streamAddMessage")}
      description={w("streamAddHint")}
      database={state.database()}
      keyCount={count()}
      busy={state.mutating()}
      onClose={close}
      testIDPrefix="workspace-stream-new"
      formTestID="workspace-stream-new-fields"
      footer={
        <View class="gap-2">
          <If when={!!error()}>
            <Text
              testID="workspace-stream-new-error"
              class="text-(--text-size-12)/(--line-height-16) text-destructive"
            >
              {error()}
            </Text>
          </If>
          <View class="flex-row flex-wrap items-center gap-3">
            <View class="flex-1 min-w-[140px] gap-1">
              <View
                class="flex-row items-center gap-1.5"
                tooltip={<Tooltip label={w("newKeyDataSizeHint")} />}
              >
                <Dot color={token("primary")} />
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {w("newKeyDataSize")}
                </Text>
                <Text
                  testID="workspace-stream-new-size"
                  class="text-(--text-size-11) font-mono text-foreground"
                >
                  {byteLabel(dataSize())}
                </Text>
              </View>
              <Text class="text-(--text-size-10) text-faint font-mono">
                Esc · {keymap.label("mod+enter")} {w("newKeySubmit")}
              </Text>
            </View>
            <Action
              testID="workspace-stream-new-cancel"
              label={w("cancel")}
              disabled={state.mutating()}
              onPress={close}
            />
            <Action
              testID="workspace-stream-new-confirm"
              label={w(state.mutating() ? "loading" : "streamAddMessage")}
              icon="zap"
              primary
              disabled={!available() || !fields.items().length}
              onPress={() => void add()}
            />
          </View>
        </View>
      }
    >
      <View class="gap-1.5">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {w("keyName")}
        </Text>
        <View class="flex-row items-center gap-2 h-9 px-3 rounded border border-border bg-chrome">
          <Icon name="key" size={15} color={token("primary")} />
          <Input
            testID="workspace-stream-new-key"
            accessibilityLabel={w("keyName")}
            value={tab()?.name ?? ""}
            readonly
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-chrome"
          />
          <Text class="text-(--text-size-9) font-mono font-semibold text-type-stream rounded-sm bg-type-stream/15 px-1.5 py-0.5">
            STRM
          </Text>
        </View>
      </View>
      <View class="gap-1.5">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {w("streamId")}
        </Text>
        <Input
          testID="workspace-stream-new-id"
          accessibilityLabel={w("streamId")}
          value={id()}
          placeholder="*"
          onChange={({ value }) => {
            id.set(value);
            error.set("");
          }}
          readonly={!available()}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={41}
          class={inputClass}
        />
        <Text class="text-(--text-size-11) text-faint">{w("streamIdHint")}</Text>
      </View>
      <View class="gap-2">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {w("streamMessageFields")}
        </Text>
        <CollectionSeedEditor
          kind="stream"
          state={fields}
          testIDPrefix="workspace-stream"
          disabled={!available()}
          autoFocus
          onChange={() => error.set("")}
        />
        <Text class="text-(--text-size-11) text-faint">{w("streamAddHint")}</Text>
      </View>
    </WorkspaceWriteDialog>
  );
}
