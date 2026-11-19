import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { WorkspaceHintButton } from "./workspace-controls";
import { dirty, type KeyTab, type WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

export function JsonPathBar(props: {
  state: WorkspaceState;
  tab: KeyTab;
  onSet: () => void;
  onDelete: () => void;
}) {
  const state = props.state,
    json = () => props.tab.json!;
  const busy = () =>
    state.mutating() ||
    state.switching() ||
    props.tab.loading ||
    props.tab.uncertain;
  const writable = () =>
    !busy() &&
    !json().loading &&
    !json().error &&
    !dirty(props.tab) &&
    !!json().query &&
    json().query!.path === json().pathInput.trim();
  return (
    <View class="px-3 py-2 gap-1.5 border-b border-border/50">
      <View class="flex-row flex-wrap items-center gap-1.5">
        <Text class="text-(--text-size-11) text-muted-foreground">JSONPath</Text>
        <Input
          testID="workspace-json-path"
          accessibilityLabel="JSONPath"
          value={json().pathInput}
          placeholder="$.items[*].price"
          readonly={busy()}
          onChange={({ value }) => state.setJsonPathInput(props.tab.id, value)}
          onSubmit={() => void state.queryJson(props.tab.id)}
          class="flex-1 min-w-[160px] h-7 px-2 font-mono text-(--text-size-12)/(--line-height-16) text-foreground border border-border rounded bg-inset focus:border-ring"
        />
        <Action
          testID="workspace-json-query"
          label={w(json().loading ? "loading" : "jsonQuery")}
          compact
          disabled={busy() || json().loading}
          onPress={() => void state.queryJson(props.tab.id)}
        />
        <Action
          testID="workspace-json-set"
          label={w("jsonPathSet")}
          compact
          disabled={!writable()}
          onPress={props.onSet}
        />
        <Action
          testID="workspace-json-delete"
          label={w("jsonPathDelete")}
          compact
          disabled={!writable()}
          onPress={props.onDelete}
        />
        <If when={!!json().query}>
          <Action
            testID="workspace-json-document"
            label={w("jsonDocument")}
            compact
            disabled={busy()}
            onPress={() => state.showJsonDocument(props.tab.id)}
          />
        </If>
        <If when={dirty(props.tab)}>
          <WorkspaceHintButton message={w("jsonSaveBeforePathWrite")} />
        </If>
      </View>
      <If when={!!json().query}>
        <Text
          testID="workspace-json-matches"
          class="text-(--text-size-11) font-mono text-muted-foreground"
        >
          {json().query?.path} ·{" "}
          {w("jsonMatches", { count: json().query?.matches })}
        </Text>
      </If>
    </View>
  );
}
