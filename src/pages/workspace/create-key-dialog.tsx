import { computed, keymap, signal, Text, token, View } from "nsh";
import { Button, Input, Select } from "nsh/base";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Icon } from "../../components/icon";
import { Tooltip } from "../../components/tooltip";
import {
  createCollectionSeeds,
  CollectionSeedEditor,
} from "./collection-seed-editor";
import { NewKeyPayloadEditor } from "./new-key-payload-editor";
import type { WorkspaceState } from "./workspace-state";
import { byteLabel, encode, isJson } from "./workspace-values";
import { workspaceT as w } from "./workspace-text";
import {
  WorkspaceWriteDialog,
  workspaceWriteDialogWidth,
} from "./workspace-write-dialog";

const types = [
  {
    value: "string",
    label: "String",
    badge: "STR",
    color: "bg-type-string/15 text-type-string",
    hint: "newKeyStringType",
  },
  {
    value: "hash",
    label: "Hash",
    badge: "HASH",
    color: "bg-type-hash/15 text-type-hash",
    hint: "newKeyHashType",
  },
  {
    value: "list",
    label: "List",
    badge: "LIST",
    color: "bg-type-list/15 text-type-list",
    hint: "newKeyListType",
  },
  {
    value: "set",
    label: "Set",
    badge: "SET",
    color: "bg-type-set/15 text-type-set",
    hint: "newKeySetType",
  },
  {
    value: "zset",
    label: "ZSet",
    badge: "ZSET",
    color: "bg-type-zset/15 text-type-zset",
    hint: "newKeyZsetType",
  },
  {
    value: "stream",
    label: "Stream",
    badge: "STRM",
    color: "bg-type-stream/15 text-type-stream",
    hint: "newKeyStreamType",
  },
  {
    value: "json",
    label: "RedisJSON",
    badge: "JSON",
    color: "bg-success/15 text-success",
    hint: "newKeyJsonType",
  },
];
const ttlPresets = [
  { value: "-1", label: "newKeyTtlNever" },
  { value: "3600", label: "durationHours", count: 1 },
  { value: "86400", label: "durationDays", count: 1 },
  { value: "604800", label: "durationDays", count: 7 },
  { value: "2592000", label: "durationDays", count: 30 },
];

function ttlSeconds(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (trimmed === "-1") return -1n;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = BigInt(trimmed);
  return seconds > 0n && seconds <= 9223372036854775n ? seconds : undefined;
}

function ttlSummary(seconds?: bigint): string {
  if (seconds === undefined) return w("newKeyInvalidTtl");
  if (seconds === -1n) return w("persistent");
  const parts: string[] = [];
  for (const [unit, label] of [
    [86400n, "durationDays"],
    [3600n, "durationHours"],
    [60n, "durationMinutes"],
    [1n, "durationSeconds"],
  ] as const) {
    const count = seconds / unit;
    if (count) parts.push(w(label, { count: count.toString() }));
    seconds %= unit;
    if (parts.length === 2) break;
  }
  return w("newKeyExpiresIn", { duration: parts.join(" ") });
}

export function CreateKeyDialog(props: {
  state: WorkspaceState;
  prefix: string;
  separator: string;
  onClose: () => void;
}) {
  const state = props.state;
  const targetDatabase = signal(state.database());
  const name = signal(props.prefix),
    type = signal("string"),
    value = signal(""),
    ttl = signal("-1"),
    error = signal("");
  const hashFields = createCollectionSeeds("field"),
    streamFields = createCollectionSeeds("field");
  const listItems = createCollectionSeeds(),
    setMembers = createCollectionSeeds(),
    zsetMembers = createCollectionSeeds();
  state.creationUncertain.set(false);
  const locked = () =>
    state.mutating() || state.creationUncertain() || state.switching();
  const close = () => {
    if (!state.mutating() && !state.switching()) props.onClose();
  };
  const width = workspaceWriteDialogWidth;
  const columns = () => (width() < 500 ? 3 : 4);
  const seconds = computed(() => ttlSeconds(ttl()));
  const count = () =>
    state.databases().find((item) => item.database === targetDatabase())
      ?.keyCount;
  const databaseItems = computed(() => {
    const cluster = state.session.getInfo().mode.toLowerCase() === "cluster";
    const databases = state
      .databases()
      .filter((item) => !cluster || item.database === 0);
    if (!databases.some((item) => item.database === targetDatabase()))
      databases.unshift({ database: targetDatabase(), keyCount: null });
    const items: { value: string; title: string; disabled?: boolean }[] =
      databases.map((item) => ({
        value: String(item.database),
        title: `DB${item.database} · ${item.keyCount != null ? w("databaseKeys", { count: item.keyCount }) : w("unknownCount")}`,
      }));
    const status = state.databasesBusy()
      ? w("loadingDatabases")
      : state.databasesError()
        ? w("databaseCountsFailed")
        : !state.databasesComplete()
          ? w("databaseListPartial")
          : undefined;
    if (status)
      items.push({ value: "catalog-status", title: status, disabled: true });
    return items;
  });
  function changeDatabase(next: string) {
    if (locked()) return;
    const database = Number(next);
    if (
      !/^\d+$/.test(next) ||
      !Number.isSafeInteger(database) ||
      database > 2147483647
    ) {
      error.set(w("invalidDatabase"));
      return;
    }
    if (
      state.session.getInfo().mode.toLowerCase() === "cluster" &&
      database !== 0
    ) {
      error.set(w("clusterDatabase"));
      return;
    }
    targetDatabase.set(database);
    error.set("");
  }
  const seedRows = () =>
    type() === "hash"
      ? hashFields.items()
      : type() === "stream"
        ? streamFields.items()
        : type() === "list"
          ? listItems.items()
          : type() === "set"
            ? setMembers.items()
            : type() === "zset"
              ? zsetMembers.items()
              : undefined;
  const dataSize = computed(() => {
    let bytes = encode(name()).length;
    if (type() === "string" || type() === "json")
      return bytes + encode(value()).length;
    for (const item of seedRows() ?? []) {
      bytes += encode(item.value).length;
      if (type() === "hash" || type() === "stream")
        bytes += encode(item.field).length;
      if (type() === "zset") bytes += encode(String(Number(item.score))).length;
    }
    return bytes;
  });
  async function create() {
    if (locked()) return;
    if (!name()) {
      error.set(w("keyNameRequired"));
      return;
    }
    if (seedRows()?.length === 0) {
      error.set(w("newKeyCollectionRequired"));
      return;
    }
    if (type() === "zset" && !zsetMembers.validScores()) {
      error.set(w("invalidScore"));
      return;
    }
    if (type() === "json" && !isJson(value())) {
      error.set(w("invalidJson"));
      return;
    }
    const expiration = seconds();
    if (expiration === undefined) {
      error.set(w("newKeyTtlHint"));
      return;
    }
    error.set("");
    const ok = await state.createKey(name(), {
      database: targetDatabase(),
      keyType: type(),
      value:
        type() === "string" || type() === "json"
          ? encode(value())
          : new Uint8Array(),
      fields:
        type() === "hash"
          ? hashFields.toFields()
          : type() === "stream"
            ? streamFields.toFields()
            : undefined,
      values:
        type() === "list"
          ? listItems.toValues()
          : type() === "set"
            ? setMembers.toValues()
            : undefined,
      members: type() === "zset" ? zsetMembers.toMembers() : undefined,
      ttlMs: expiration === -1n ? undefined : String(expiration * 1000n),
    });
    if (ok) props.onClose();
    else error.set(state.error() || w("operationFailed"));
  }
  keymap.bind("mod+enter", () => void create(), { when: "always" });
  const inputClass = "text-(--text-size-12)/(--line-height-16) font-mono text-foreground bg-chrome rounded";
  return (
    <WorkspaceWriteDialog
      title={w("newKeyTitle")}
      description={w("newKeyHint", { database: targetDatabase() })}
      database={targetDatabase()}
      keyCount={count()}
      busy={state.mutating() || state.switching()}
      onClose={close}
      testIDPrefix="workspace-new-key"
      formTestID="workspace-new-key-form"
      databaseControl={
        <Select
          testID="workspace-new-key-database"
          accessibilityLabel={w("database")}
          value={String(targetDatabase())}
          items={databaseItems()}
          disabled={locked()}
          placement="bottom"
          align="end"
          onOpen={() => void state.loadDatabases()}
          onChange={({ value }) => {
            if (value !== null && /^\d+$/.test(value)) changeDatabase(value);
          }}
          popupClass="rounded-md border border-border-strong bg-elevated p-1 shadow-xl"
          listClass="max-h-72"
          itemClass="h-8 px-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent selected:bg-selected disabled:opacity-50"
          trigger={
            <View
              testID="workspace-new-key-database-trigger"
              class="h-7 flex-row items-center gap-1.5 px-2 rounded bg-panel hover:bg-accent"
            >
              <Dot />
              <Text class="font-mono text-(--text-size-11) text-foreground">
                DB{targetDatabase()}
              </Text>
              <If when={count() != null}>
                <Text class="font-mono text-(--text-size-10) text-muted-foreground">
                  {w("databaseKeys", { count: count() })}
                </Text>
              </If>
              <Icon name="down" size={11} />
            </View>
          }
          renderItem={(entry) => (
            <View
              testID={`workspace-new-key-database-option-${entry.value}`}
              class="h-8 flex-row items-center gap-3"
            >
              <Text
                class={`flex-1 text-(--text-size-11) ${entry.value === "catalog-status" ? "text-faint" : "font-mono text-foreground"}`}
              >
                {entry.title}
              </Text>
              <If when={entry.value === String(targetDatabase())}>
                <Icon name="check" size={12} color={token("success")} />
              </If>
            </View>
          )}
        />
      }
      footer={
        <View class="gap-2">
          <If when={!!error()}>
            <Text
              testID="workspace-new-key-error"
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
                  testID="workspace-new-key-size"
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
              testID="workspace-new-key-cancel"
              label={w("cancel")}
              disabled={state.mutating() || state.switching()}
              onPress={close}
            />
            <Action
              testID="workspace-new-key-confirm"
              label={w(
                state.switching()
                  ? "switchingDatabase"
                  : state.mutating()
                    ? "loading"
                    : "newKeyCreate",
              )}
              icon="zap"
              primary
              disabled={locked() || seedRows()?.length === 0}
              onPress={() => void create()}
            />
          </View>
        </View>
      }
    >
      <View class="gap-1.5">
        <View class="flex-row flex-wrap items-center gap-2">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("keyName")} <Text class="text-primary">*</Text>
          </Text>
          <View class="flex-1" />
          <Text class="text-(--text-size-11) text-muted-foreground">
            {w("newKeyNamespaceHint", { separator: props.separator })}
          </Text>
        </View>
        <View class="flex-row items-center gap-2 h-9 px-3 rounded border border-border bg-chrome focus-within:border-ring">
          <Icon name="key" size={15} color={token("primary")} />
          <Input
            testID="workspace-new-key-name"
            accessibilityLabel={w("keyName")}
            value={name()}
            placeholder={w("newKeyPlaceholder", {
              example: ["cache", "config", "system"].join(props.separator),
            })}
            onChange={({ value }) => {
              name.set(value);
              error.set("");
            }}
            readonly={locked()}
            onSubmit={() => void create()}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            class={`flex-1 min-w-0 h-8 ${inputClass}`}
          />
          <Text class="text-(--text-size-9) font-mono font-semibold text-success rounded-sm bg-panel px-1.5 py-0.5">
            NEW
          </Text>
        </View>
      </View>
      <View class="gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("newKeyDataType")}
          </Text>
          <Text class="text-(--text-size-11) font-mono text-muted-foreground">
            {w("newKeyNativeTypes")}
          </Text>
        </View>
        <View
          testID="workspace-new-key-types"
          class="flex-row flex-wrap gap-1.5"
        >
          <Each of={types} key={(item) => item.value}>
            {(item) => (
              <Button
                testID={`workspace-new-key-type-${item().value}`}
                accessibilityLabel={item().label}
                selected={type() === item().value}
                disabled={locked()}
                onPress={() => {
                  type.set(item().value);
                  if (item().value === "json" && !value()) value.set("{}");
                  error.set("");
                }}
                class={`items-center justify-center gap-1 h-[72px] rounded border active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-35 ${type() === item().value ? "bg-selected border-border-strong" : "bg-background border-transparent hover:bg-accent"}`}
                style={{
                  width: (width() - 26 - 6 * (columns() - 1)) / columns(),
                }}
              >
                <Text
                  class={`font-mono font-semibold text-(--text-size-10) rounded-sm px-1.5 py-0.5 ${item().color}`}
                >
                  {item().badge}
                </Text>
                <Text
                  class={`text-(--text-size-12)/(--line-height-16) font-medium ${type() === item().value ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {item().label}
                </Text>
                <Text class="text-(--text-size-10) text-faint">{w(item().hint)}</Text>
              </Button>
            )}
          </Each>
        </View>
      </View>
      <View class="rounded-lg p-2 gap-2 bg-background">
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Icon name="timer" size={15} />
          <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("newKeyExpiration")}
          </Text>
          <Text
            testID="workspace-new-key-ttl-status"
            class={`text-(--text-size-11) font-mono ${seconds() === undefined ? "text-destructive" : seconds() === -1n ? "text-success" : "text-foreground"}`}
          >
            {ttlSummary(seconds())}
          </Text>
        </View>
        <View class="flex-row flex-wrap items-center gap-2">
          <View class="flex-1 min-w-[120px] h-8 px-2 flex-row items-center rounded border border-border bg-chrome focus-within:border-ring">
            <Input
              testID="workspace-new-key-ttl"
              accessibilityLabel={w("ttlSeconds")}
              value={ttl()}
              placeholder="-1"
              onChange={({ value }) => {
                ttl.set(value);
                error.set("");
              }}
              readonly={locked()}
              onSubmit={() => void create()}
              maxLength={20}
              autoCapitalize="none"
              autoCorrect={false}
              class={`flex-1 min-w-0 h-7 ${inputClass}`}
            />
            <Text class="text-(--text-size-11) font-mono text-muted-foreground">s</Text>
          </View>
          <View class="flex-row flex-wrap gap-1">
            <Each of={ttlPresets} key={(preset) => preset.value}>
              {(preset) => (
                <Button
                  testID={`workspace-new-key-ttl-preset-${preset().value}`}
                  accessibilityLabel={w(preset().label, {
                    count: preset().count,
                  })}
                  selected={ttl().trim() === preset().value}
                  disabled={locked()}
                  onPress={() => {
                    ttl.set(preset().value);
                    error.set("");
                  }}
                  class={`h-7 px-2 items-center justify-center rounded active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-35 ${ttl().trim() === preset().value ? "bg-selected" : "bg-panel hover:bg-accent"}`}
                >
                  <Text
                    class={`text-(--text-size-11) ${ttl().trim() === preset().value ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {w(preset().label, { count: preset().count })}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </View>
      </View>
      <If when={type() === "string" || type() === "json"}>
        <NewKeyPayloadEditor
          value={value()}
          disabled={locked()}
          onChange={(next) => {
            value.set(next);
            error.set("");
          }}
        />
      </If>
      <If when={type() !== "string" && type() !== "json"}>
        <View class="gap-2">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {w("initialValue")}
          </Text>
          <View class="gap-3">
            <If when={type() === "hash"}>
              <CollectionSeedEditor
                kind="hash"
                state={hashFields}
                testIDPrefix="workspace-new-key-hash"
                disabled={locked()}
                onChange={() => error.set("")}
              />
            </If>
            <If when={type() === "stream"}>
              <CollectionSeedEditor
                kind="stream"
                state={streamFields}
                testIDPrefix="workspace-new-key-stream"
                disabled={locked()}
                onChange={() => error.set("")}
              />
            </If>
            <If when={type() === "list"}>
              <CollectionSeedEditor
                kind="list"
                state={listItems}
                testIDPrefix="workspace-new-key-list"
                disabled={locked()}
                onChange={() => error.set("")}
              />
            </If>
            <If when={type() === "set"}>
              <CollectionSeedEditor
                kind="set"
                state={setMembers}
                testIDPrefix="workspace-new-key-set"
                disabled={locked()}
                onChange={() => error.set("")}
              />
            </If>
            <If when={type() === "zset"}>
              <CollectionSeedEditor
                kind="zset"
                state={zsetMembers}
                testIDPrefix="workspace-new-key-zset"
                disabled={locked()}
                onChange={() => error.set("")}
              />
            </If>
          </View>
          <Text class="text-(--text-size-11) text-faint">{w(`${type()}SeedHint`)}</Text>
        </View>
      </If>
    </WorkspaceWriteDialog>
  );
}
