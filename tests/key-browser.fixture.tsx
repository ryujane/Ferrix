import { mount, signal, Text, View } from "nsh";
import { setLocale } from "nsh/i18n";
import { Action } from "../src/components/action";
import { ToastProvider } from "../src/components/toast";
import { defaultPreferences } from "../src/data/preferences";
import { KeyBrowser } from "../src/pages/workspace/key-browser";
import { createWorkspaceState, type WorkspaceSession } from "../src/pages/workspace/workspace-state";
import { decode, encode } from "../src/pages/workspace/workspace-values";

function Fixture() {
  setLocale("en");
  const selected = signal("");
  const action = signal("");
  const scanPattern = signal("");
  const scanCount = signal<number>();
  const pageHeld = signal(false);
  const cancelled = signal(0);
  const disposed = signal(0);
  let holdNextPage = false;
  let pendingInvalidations = 0;
  let releasePage: (() => void) | undefined;
  let mode: "small" | "large" | "batch" = "small";
  const customScanPreferences = { ...defaultPreferences, scanCount: 1_000 };
  const firstBrowseBatch = [
    "bucket:alpha",
    "bucket:child:beta",
    ...Array.from({ length: 9_998 }, (_, i) => `extras:key-${i}`),
  ];
  const session = {
    getInfo: () => ({ database: 0 }),
    getKeyInfo: async () => ({ exists: false }),
    getKeyInfoBatch: async () => ({ items: [] }),
    startKeyScan({ pattern, count }: { pattern?: Uint8Array; count?: number }) {
      const match = pattern ? decode(pattern) ?? "" : "";
      scanPattern.set(match);
      scanCount.set(count);
      let page = 0;
      let offset = 0;
      let invalidated = false;
      return {
        async nextPage(limit?: number) {
          if (pendingInvalidations) {
            pendingInvalidations--;
            invalidated = true;
          }
          if (invalidated) throw { code: "CURSOR_INVALIDATED" };
          if (match === "*sparse*") {
            const current = page++;
            const complete = current === 120;
            return {
              keys: current % 2
                ? Array.from({ length: 173 }, (_, index) =>
                    encode(`sparse:key-${current}-${index}`),
                  )
                : [],
              complete,
              continuation: complete ? null : String(current + 1),
            };
          }
          if (mode === "batch" && page++ === 0)
            return { keys: [], complete: false, continuation: String(page) };
          if (mode !== "small") {
            const total = mode === "large" ? 215_000 : 20_005;
            const size = Math.min(mode === "large" ? 8_000 : 173, limit ?? 200);
            // Repeat a key across pages so batches have to count distinct keys.
            const first = mode === "batch" && offset > 0 && size > 1
              ? offset - 1
              : offset;
            offset = Math.min(first + size, total);
            return {
              keys: Array.from({ length: offset - first }, (_, i) =>
                encode(`bucket:${String(first + i).padStart(6, "0")}`),
              ),
              complete: offset === total,
              continuation: offset === total ? null : String(offset),
            };
          }
          if (holdNextPage) {
            holdNextPage = false;
            await new Promise<void>(resolve => {
              releasePage = resolve;
              pageHeld.set(true);
            });
          }
          if (offset < firstBrowseBatch.length) {
            const first = offset;
            offset = Math.min(offset + Math.min(limit ?? 200, 200), firstBrowseBatch.length);
            return {
              keys: firstBrowseBatch.slice(first, offset).map(encode),
              complete: false,
              continuation: String(offset),
            };
          }
          return {
            keys: ["bucket:alpha", "bucket:gamma", "plain"].map(encode),
            complete: true,
            continuation: null,
          };
        },
        cancel() { cancelled.update(count => count + 1); },
        dispose() { disposed.update(count => count + 1); },
      };
    },
  } as unknown as WorkspaceSession;
  const state = createWorkspaceState(session, {
    success: () => "", error: () => "", info: () => "",
  }, () => mode === "batch" ? customScanPreferences : defaultPreferences);
  async function loadLarge() {
    mode = "large";
    await state.refresh();
    while (state.scanActive() && !state.error()) await state.nextPage();
  }
  return (
    <View class="flex-1 min-h-0">
      <Action testID="load-small" label="Load small fixture" onPress={() => {
        mode = "small";
        void state.refresh();
      }} />
      <Action testID="load-large" label="Load large fixture" onPress={() => void loadLarge()} />
      <Action testID="load-batch" label="Load default batch" onPress={() => {
        mode = "batch";
        void state.refresh();
      }} />
      <Action testID="hold-page" label="Hold next page" onPress={() => { holdNextPage = true; }} />
      <Action testID="invalidate-page" label="Invalidate next cursor" onPress={() => {
        pendingInvalidations++;
      }} />
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
      <Text>{`SCAN COUNT ${scanCount() ?? "-"}`}</Text>
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
