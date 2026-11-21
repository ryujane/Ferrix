import { mount, signal, Text, View } from "nsh";
import { setLocale } from "nsh/i18n";
import { Action } from "../src/components/action";
import { ToastProvider } from "../src/components/toast";
import { KeyBrowser } from "../src/pages/workspace/key-browser";
import { createWorkspaceState, type WorkspaceSession } from "../src/pages/workspace/workspace-state";
import { decode, encode } from "../src/pages/workspace/workspace-values";

function Fixture() {
  setLocale("en");
  const selected = signal("");
  const action = signal("");
  const scanPattern = signal("");
  const pageHeld = signal(false);
  const cancelled = signal(0);
  const disposed = signal(0);
  let holdNextPage = false;
  let releasePage: (() => void) | undefined;
  let large = false;
  const session = {
    getInfo: () => ({ database: 0 }),
    getKeyInfo: async () => ({ exists: false }),
    getKeyInfoBatch: async () => ({ items: [] }),
    startKeyScan({ pattern }: { pattern?: Uint8Array }) {
      const match = pattern ? decode(pattern) ?? "" : "";
      scanPattern.set(match);
      let page = 0;
      return {
        async nextPage() {
          if (match === "*sparse*") {
            const current = page++;
            const complete = current === 26;
            return {
              keys: current % 2
                ? Array.from({ length: 9 }, (_, index) =>
                    encode(`sparse:key-${current}-${index}`),
                  )
                : [],
              complete,
              continuation: complete ? null : String(current + 1),
            };
          }
          if (large) {
            const first = page++ * 8_000;
            const end = Math.min(first + 8_000, 215_000);
            return {
              keys: Array.from({ length: end - first }, (_, i) =>
                encode(`bucket:${String(first + i).padStart(6, "0")}`),
              ),
              complete: end === 215_000,
            };
          }
          const first = page++ === 0;
          if (holdNextPage) {
            holdNextPage = false;
            await new Promise<void>(resolve => {
              releasePage = resolve;
              pageHeld.set(true);
            });
          }
          return {
            keys: (first
              ? ["bucket:alpha", "bucket:child:beta"]
              : ["bucket:alpha", "bucket:gamma", "plain"]
            ).map(encode),
            complete: !first,
            continuation: first ? "next" : null,
          };
        },
        cancel() { cancelled.update(count => count + 1); },
        dispose() { disposed.update(count => count + 1); },
      };
    },
  } as unknown as WorkspaceSession;
  const state = createWorkspaceState(session, {
    success: () => "", error: () => "", info: () => "",
  });
  async function loadLarge() {
    large = true;
    await state.refresh();
    while (state.scanActive() && !state.error()) await state.nextPage();
  }
  return (
    <View class="flex-1 min-h-0">
      <Action testID="load-small" label="Load small fixture" onPress={() => {
        large = false;
        void state.refresh();
      }} />
      <Action testID="load-large" label="Load large fixture" onPress={() => void loadLarge()} />
      <Action testID="hold-page" label="Hold next page" onPress={() => { holdNextPage = true; }} />
      {pageHeld() && (
        <Action testID="release-page" label="Release page" onPress={() => {
          releasePage?.();
          releasePage = undefined;
          pageHeld.set(false);
        }} />
      )}
      <Text>{`Selected ${selected()}`}</Text>
      <Text>{action()}</Text>
      <Text>{`Keys ${state.keys().length}`}</Text>
      <Text>{`SCAN MATCH ${scanPattern() || "(all keys)"}`}</Text>
      <Text>{`Cancelled ${cancelled()} / disposed ${disposed()}`}</Text>
      <KeyBrowser
        state={state}
        separator=":"
        onOpenKey={key => selected.set(decode(key) ?? "")}
        onDatabase={() => {}}
        onKeyAction={(kind, id) => action.set(`${kind} ${id}`)}
        onDeleteFolder={prefix => action.set(`Delete folder ${prefix}`)}
        onNewKey={prefix => action.set(`New key in ${prefix || "root"}`)}
        searchRef={() => {}}
      />
    </View>
  );
}

mount(() => <ToastProvider><Fixture /></ToastProvider>);
