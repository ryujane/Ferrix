import { keymap, signal, Text, View } from "nsh";
import { Action } from "../../components/action";
import { NewKeyPayloadEditor } from "./new-key-payload-editor";
import { WorkspaceWriteDialog } from "./workspace-write-dialog";
import { isJson } from "./workspace-values";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

export function JsonPathDialog(props: {
  state: WorkspaceState;
  tabId: string;
  path: string;
  remove: boolean;
  onClose: () => void;
}) {
  const state = props.state;
  const tab = state.tabs().find((item) => item.id === props.tabId)!;
  const query = tab.json!.query!;
  // Unwrap the single match lexically to retain integer literals exactly.
  const value = signal(
    query.matches === "1" ? query.value.trim().slice(1, -1).trim() : "null",
  );
  const error = signal("");
  const locked = () =>
    state.mutating() ||
    state.switching() ||
    !!state.tabs().find((item) => item.id === props.tabId)?.uncertain;
  const close = () => {
    if (!state.mutating()) props.onClose();
  };
  async function submit() {
    if (locked()) return;
    if (!props.remove && !isJson(value())) {
      error.set(w("invalidJson"));
      return;
    }
    error.set("");
    if (
      await state.mutateJsonPath(
        props.tabId,
        props.path,
        props.remove ? undefined : value(),
      )
    )
      props.onClose();
    else error.set(state.error() || w("operationFailed"));
  }
  keymap.bind("mod+enter", () => void submit(), { when: "always" });
  return (
    <WorkspaceWriteDialog
      title={w(props.remove ? "jsonPathDelete" : "jsonPathSet")}
      icon={props.remove ? "trash" : "braces"}
      description={w("jsonPathWriteHint")}
      database={state.database()}
      testIDPrefix="workspace-json-path-dialog"
      formTestID="workspace-json-path-form"
      busy={state.mutating()}
      onClose={close}
      footer={
        <View class="gap-2">
          <If when={!!error()}>
            <Text
              testID="workspace-json-path-write-error"
              class="text-(--text-size-12)/(--line-height-16) text-destructive"
            >
              {error()}
            </Text>
          </If>
          <View class="flex-row justify-end gap-2">
            <Action
              testID="workspace-json-path-cancel"
              label={w("cancel")}
              disabled={state.mutating()}
              onPress={close}
            />
            <Action
              testID="workspace-json-path-confirm"
              label={w(props.remove ? "delete" : "save")}
              primary
              disabled={locked() || (!props.remove && !isJson(value()))}
              onPress={() => void submit()}
            />
          </View>
        </View>
      }
    >
      <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">{tab.name}</Text>
      <Text
        testID="workspace-json-path-target"
        class="text-(--text-size-14)/(--line-height-20) font-mono text-foreground"
      >
        {props.path}
      </Text>
      <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
        {w("jsonMatches", { count: query.matches })}
      </Text>
      <Text
        class={
          props.remove
            ? "text-(--text-size-12)/(--line-height-16) text-destructive"
            : "text-(--text-size-12)/(--line-height-16) text-muted-foreground"
        }
      >
        {w(
          props.remove
            ? props.path === "$"
              ? "jsonDeleteDocumentHint"
              : "jsonDeletePathHint"
            : "jsonSetPathHint",
        )}
      </Text>
      <If when={!props.remove}>
        <NewKeyPayloadEditor
          value={value()}
          disabled={locked()}
          label={w("jsonReplacementValue")}
          testIDPrefix="workspace-json-path"
          onChange={(next) => {
            value.set(next);
            error.set("");
          }}
        />
      </If>
    </WorkspaceWriteDialog>
  );
}
