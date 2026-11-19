import { List, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { Modal } from "../../components/modal";
import { Action } from "../../components/action";
import {
  clientField,
  clientText,
  createClientsState,
  type ClientsSession,
} from "./clients-state";
import { count, m, time } from "./monitoring-values";

export function ClientsDialog(props: {
  session: ClientsSession;
  name: string;
  endpoint: string;
  onClose: () => void;
}) {
  const state = createClientsState(props.session);
  void state.refresh();
  return (
    <Modal
      id="monitoring-clients-dialog"
      title={m("clientsTitle")}
      description={props.name + " · " + props.endpoint}
      width={1040}
      height={680}
      headerHeight={80}
      onClose={props.onClose}
    >
      <View class="shrink-0 px-6 pb-3 gap-2 border-b border-border">
        <View class="flex-row items-center gap-2">
          <Input
            testID="monitoring-clients-filter"
            accessibilityLabel={m("clientsFilter")}
            value={state.query()}
            onChange={({ value }) => state.query.set(value)}
            placeholder={m("clientsFilter")}
            class="flex-1 min-w-0 h-8 px-2 text-(--text-size-12)/(--line-height-16) text-foreground border border-border rounded bg-background focus:border-ring"
          />
          <Action
            testID="monitoring-clients-refresh"
            label={m(state.busy() ? "loading" : "refresh")}
            icon="refresh"
            disabled={state.busy()}
            onPress={() => void state.refresh()}
          />
        </View>
        <If when={!!state.snapshot()}>
          <Text
            testID="monitoring-clients-summary"
            class="text-(--text-size-11) font-mono text-muted-foreground"
          >
            {m("clientsCount", {
              shown: count(state.rows().length),
              total: count(state.snapshot()?.clients.length),
            })}
            {" · "}
            {m(
              state.snapshot()?.scope === "node"
                ? "clientsNodeScope"
                : "clientsServerScope",
            )}
            {state.snapshot()?.nodeAddress
              ? " · " + state.snapshot()!.nodeAddress
              : ""}
          </Text>
        </If>
        <If when={!!state.error()}>
          <Text
            testID="monitoring-clients-error"
            role="alert"
            class="text-(--text-size-12)/(--line-height-16) text-destructive"
          >
            {state.error()}
          </Text>
        </If>
      </View>
      <If when={state.busy() && !state.rows().length}>
        <View class="flex-1 items-center justify-center">
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">{m("loading")}</Text>
        </View>
      </If>
      <If when={!state.busy() && !state.rows().length}>
        <View class="flex-1 items-center justify-center px-6">
          <Text
            testID="monitoring-clients-empty"
            class="text-(--text-size-14)/(--line-height-20) text-muted-foreground"
          >
            {m(
              !state.snapshot()
                ? "clientsUnavailable"
                : state.query().trim()
                  ? "clientsNoMatches"
                  : "clientsEmpty",
            )}
          </Text>
        </View>
      </If>
      <If when={!!state.rows().length}>
        <List
          testID="monitoring-clients-list"
          each={state.rows()}
          keyExtractor={(client) => client.id}
          estimatedItemSize={100}
          class="flex-1 min-h-0"
          contentClass="px-6 py-1"
        >
          {(client) => (
            <View
              testID={"monitoring-client-" + client().id}
              class="py-3 gap-2 border-b border-border/50"
            >
              <Button
                testID={"monitoring-client-details-" + client().id}
                accessibilityLabel={m("clientsDetails", { id: client().id })}
                onPress={() =>
                  state.selected.set(
                    state.selected() === client().id ? undefined : client().id,
                  )
                }
                class="flex-row flex-wrap items-center gap-x-4 gap-y-1 min-h-8 rounded hover:bg-selected active:opacity-70 focus:ring-1 focus:ring-ring"
              >
                <Text class="text-(--text-size-11) font-mono text-faint">
                  #{client().id}
                </Text>
                <Text class="flex-1 min-w-[140px] text-(--text-size-12)/(--line-height-16) font-mono font-semibold text-foreground">
                  {clientField(client(), "addr") || "-"}
                </Text>
                <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">
                  {clientField(client(), "name") || m("clientsUnnamed")}
                </Text>
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {m(
                    state.selected() === client().id
                      ? "clientsCollapse"
                      : "clientsExpand",
                  )}
                </Text>
              </Button>
              <View class="flex-row flex-wrap gap-x-5 gap-y-1">
                {[
                  ["DB", "db"],
                  [m("clientsUser"), "user"],
                  [m("clientsAge"), "age"],
                  [m("clientsIdle"), "idle"],
                  [m("clientsFlags"), "flags"],
                  [m("clientsCommand"), "cmd"],
                ].map(([label, name]) => (
                  <Text class="text-(--text-size-11) font-mono text-muted-foreground">
                    {label}: {clientField(client(), name) || "-"}
                  </Text>
                ))}
              </View>
              <If when={state.selected() === client().id}>
                <View class="rounded bg-background p-3 gap-1.5">
                  <Each of={client().fields} key={(field) => field.name}>
                    {(field) => (
                      <View class="flex-row gap-4">
                        <Text class="w-24 text-(--text-size-11) font-mono text-muted-foreground">
                          {field().name}
                        </Text>
                        <Text class="flex-1 min-w-0 text-(--text-size-11) font-mono text-foreground">
                          {clientText(field().value) || "-"}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          )}
        </List>
      </If>
      <View class="shrink-0 px-6 py-3 gap-1 border-t border-border">
        <Text class="text-(--text-size-10) text-muted-foreground">
          {m("clientsHint")}
        </Text>
        <If when={!!state.snapshot()}>
          <Text
            testID="monitoring-clients-sampled-at"
            class="text-(--text-size-10) font-mono text-faint"
          >
            {m("sampledAt")} {time(Number(state.snapshot()!.sampledAtMs))}
          </Text>
        </If>
      </View>
    </Modal>
  );
}
