import { computed, keymap, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon } from "../../components/icon";
import { Tooltip } from "../../components/tooltip";
import {
  rowEditable,
  rowIdentity,
  rowIdentityBytes,
  rowValue,
} from "./collection-values";
import { byteLabel, decode, encode, formatJson, keyId } from "./workspace-values";
import { KeyBadge } from "./workspace-controls";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";
import { WorkspaceWriteDialog } from "./workspace-write-dialog";

export function CollectionRowDialog(props: {
  state: WorkspaceState;
  tabId: string;
  rowId: string;
  onClose: () => void;
}) {
  const state = props.state;
  const tab = () => state.tabs().find((item) => item.id === props.tabId);
  const row = () =>
    tab()?.collection?.rows.find((item) => item.id === props.rowId);
  const kind = tab()!.collection!.kind,
    initial = row()!;
  const rawValue = rowValue(kind, initial);
  const initialValue = kind === "hash" && state.formatter() === "json"
    ? formatJson(rawValue) ?? rawValue
    : rawValue;
  const identity = signal(rowIdentity(initial)),
    value = signal(initialValue),
    error = signal("");
  const identityEditable =
    kind === "hash"
      ? decode(initial.field!) !== undefined
      : kind === "zset" && decode(initial.value) !== undefined;
  const available = () =>
    !!row() &&
    !!tab()?.info?.exists &&
    !tab()?.loading &&
    !tab()?.error &&
    !tab()?.uncertain &&
    !tab()?.collection?.loading &&
    !state.mutating() &&
    !state.switching();
  const count = () =>
    state.databases().find((item) => item.database === state.database())
      ?.keyCount;
  const dataSize = computed(() => {
    let bytes = tab()?.key.length ?? 0;
    if (kind === "hash")
      bytes += identityEditable
        ? encode(identity()).length
        : initial.field!.length;
    if (kind === "zset")
      bytes += identityEditable
        ? encode(identity()).length
        : initial.value.length;
    return (
      bytes +
      (rowEditable(kind, initial)
        ? encode(value()).length
        : initial.value.length)
    );
  });
  function apply() {
    const current = row(),
      collection = tab()?.collection;
    if (!available() || !current || !collection || !rowEditable(kind, current))
      return;
    if (
      kind === "zset" &&
      (!value().trim() || !Number.isFinite(Number(value())))
    ) {
      error.set(w("invalidScore"));
      return;
    }
    if (kind !== "list") {
      const next =
        kind === "set"
          ? encode(value())
          : identityEditable
            ? encode(identity())
            : rowIdentityBytes(kind, current);
      const duplicate = collection.rows.some(
        (item) =>
          item.id !== current.id &&
          keyId(
            kind === "set"
              ? encode(rowValue(kind, item))
              : rowIdentityBytes(kind, item),
          ) === keyId(next),
      );
      if (duplicate) {
        error.set(w("collectionRowExists"));
        return;
      }
    }
    if (identityEditable)
      state.editCollectionIdentity(props.tabId, props.rowId, identity());
    if (value() !== initialValue)
      state.editCollectionCell(props.tabId, props.rowId, value());
    props.onClose();
  }
  keymap.bind("mod+enter", apply, { when: "always" });
  const inputClass =
    "h-9 px-3 text-(--text-size-12)/(--line-height-16) font-mono text-foreground border border-border bg-chrome rounded focus:border-ring";
  const valueClass =
    "h-[220px] px-3 py-2 text-(--editor-text-size) font-mono text-foreground border border-border bg-chrome rounded focus:border-ring";
  return (
    <WorkspaceWriteDialog
      title={w("collectionEditRow")}
      icon="pencil"
      description={w("collectionEditRowHint")}
      database={state.database()}
      keyCount={count()}
      busy={false}
      onClose={props.onClose}
      testIDPrefix="workspace-collection-dialog"
      formTestID="workspace-collection-dialog-form"
      footer={
        <View class="gap-2">
          <If when={!!error()}>
            <Text
              testID="workspace-collection-dialog-error"
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
                  testID="workspace-collection-dialog-size"
                  class="text-(--text-size-11) font-mono text-foreground"
                >
                  {byteLabel(dataSize())}
                </Text>
              </View>
              <Text class="text-(--text-size-10) text-faint font-mono">
                Esc · {keymap.label("mod+enter")} {w("confirm")}
              </Text>
            </View>
            <Action
              testID="workspace-collection-dialog-cancel"
              label={w("cancel")}
              onPress={props.onClose}
            />
            <Action
              testID="workspace-collection-dialog-confirm"
              label={w("confirm")}
              icon="check"
              primary
              disabled={!available()}
              onPress={apply}
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
            testID="workspace-collection-dialog-key"
            accessibilityLabel={w("keyName")}
            value={tab()?.name ?? ""}
            readonly
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-chrome"
          />
          <KeyBadge type={kind} />
        </View>
        <Text class="text-(--text-size-11) text-faint leading-(--line-height-20)">
          {w("collectionEditRowHint")}
        </Text>
      </View>
      <If when={kind === "hash"}>
        <View class="gap-1.5">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("collectionField")}
          </Text>
          <Input
            testID="workspace-collection-dialog-field"
            accessibilityLabel={w("collectionField")}
            value={identity()}
            onChange={({ value }) => {
              identity.set(value);
              error.set("");
            }}
            readonly={!available() || !identityEditable}
            autoFocus={identityEditable}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={65536}
            class={inputClass}
          />
        </View>
      </If>
      <If when={kind === "list"}>
        <View class="gap-1.5">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("collectionIndex")}
          </Text>
          <View class="h-9 justify-center px-3 rounded border border-border bg-chrome">
            <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">
              {initial.index ?? w("collectionAppend")}
            </Text>
          </View>
        </View>
      </If>
      <View class="gap-1.5">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {w(
            kind === "set" || kind === "zset"
              ? "collectionMember"
              : "collectionValue",
          )}
        </Text>
        <Input
          testID="workspace-collection-dialog-value"
          accessibilityLabel={w(
            kind === "set" || kind === "zset"
              ? "collectionMember"
              : "collectionValue",
          )}
          value={kind === "zset" ? identity() : value()}
          onChange={({ value: next }) => {
            if (kind === "zset") identity.set(next);
            else value.set(next);
            error.set("");
          }}
          readonly={!available() || (kind === "zset" && !identityEditable)}
          multiline
          submitBehavior="newline"
          autoFocus={kind !== "hash"}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={65536}
          class={valueClass}
        />
      </View>
      <If when={kind === "zset"}>
        <View class="gap-1.5">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("memberScore")}
          </Text>
          <Input
            testID="workspace-collection-dialog-score"
            accessibilityLabel={w("memberScore")}
            value={value()}
            onChange={({ value: next }) => {
              value.set(next);
              error.set("");
            }}
            readonly={!available()}
            autoCapitalize="none"
            autoCorrect={false}
            class={inputClass}
          />
        </View>
      </If>
      <If when={(kind === "hash" || kind === "zset") && !identityEditable}>
        <Text class="text-(--text-size-11) text-faint">
          {w("collectionBinaryIdentity")}
        </Text>
      </If>
    </WorkspaceWriteDialog>
  );
}
