import { signal, Text, View } from "nsh";
import { Input, Select } from "nsh/base";
import { Action } from "../../components/action";
import { compactInputClass } from "../../components/form-controls";
import { Icon } from "../../components/icon";
import { WorkspaceDialog } from "./workspace-controls";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

const millisecondsPerUnit = {
  seconds: 1000n,
  minutes: 60000n,
  hours: 3600000n,
  days: 86400000n,
};
type Unit = keyof typeof millisecondsPerUnit;
const maxTtlMs = 9_223_372_036_854_775_807n;

const presets = [
  { amount: "10", unit: "minutes", label: "durationMinutes" },
  { amount: "1", unit: "hours", label: "durationHours" },
  { amount: "1", unit: "days", label: "durationDays" },
] as const;

export function KeyExpiryDialog(props: {
  state: WorkspaceState;
  tabId: string;
  onClose: () => void;
}) {
  const state = props.state;
  const tab = () => state.tabs().find((item) => item.id === props.tabId);
  const name = tab()?.name ?? "";
  const info = tab()?.info;
  const seconds =
    info?.ttlMs != null ? (BigInt(info.ttlMs) + 999n) / 1000n : undefined;
  const amount = signal<string | null>(
    info?.expiration === "persistent"
      ? null
      : seconds !== undefined
        ? String(seconds || 1n)
        : "",
  );
  const unit = signal<Unit>("seconds");
  const error = signal("");
  const busy = () => state.mutating() || state.switching();
  const locked = () => {
    const current = tab();
    return busy() || !current || current.loading || current.uncertain;
  };

  function update(next: string | null, nextUnit = unit()) {
    amount.set(next);
    unit.set(nextUnit);
    error.set("");
  }

  async function submit() {
    if (locked()) return;
    const value = amount()?.trim() ?? null;
    const ttlMs =
      value && /^\d+$/.test(value)
        ? BigInt(value) * millisecondsPerUnit[unit()]
        : 0n;
    if (value !== null && (ttlMs < 1n || ttlMs > maxTtlMs)) {
      error.set(w("invalidTtl"));
      return;
    }
    error.set("");
    const ok =
      value === null
        ? await state.changeKey(props.tabId, "persist")
        : await state.changeKey(props.tabId, "expiry", String(ttlMs));
    if (ok) props.onClose();
    else error.set(state.error() || w("operationFailed"));
  }

  function close() {
    if (!busy()) props.onClose();
  }

  return (
    <WorkspaceDialog
      title={w("ttlTitle")}
      description={w("ttlHint", { name })}
      onClose={close}
    >
      <View class="gap-2">
        <View class="flex-row items-center gap-2">
          <Input
            testID="workspace-dialog-input"
            accessibilityLabel={w("ttlAmount")}
            value={amount() ?? ""}
            placeholder={amount() === null ? w("persistent") : undefined}
            onChange={({ value }) => update(value)}
            onSubmit={() => void submit()}
            readonly={locked()}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            class={`flex-1 font-mono ${compactInputClass}`}
          />
          <Select
            testID="workspace-ttl-unit"
            accessibilityLabel={w("ttlUnit")}
            value={unit()}
            items={Object.keys(millisecondsPerUnit).map((value) => ({
              value,
              title: w(`ttlUnits.${value}`),
            }))}
            disabled={locked()}
            onChange={({ value }) => {
              if (value !== null) update(amount(), value as Unit);
            }}
            popupClass="rounded-md border border-border bg-panel p-1 shadow-xl"
            itemClass="min-h-9 px-3 py-2 text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-selected selected:bg-selected"
            trigger={
              <View
                class={`w-28 shrink-0 flex-row items-center gap-2 ${compactInputClass}`}
              >
                <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">
                  {w(`ttlUnits.${unit()}`)}
                </Text>
                <Icon name="down" size={12} />
              </View>
            }
          />
        </View>
        <View class="flex-row flex-wrap gap-1">
          <Action
            testID="workspace-ttl-preset-persistent"
            label={w("persistent")}
            compact
            selected={amount() === null}
            disabled={locked()}
            onPress={() => update(null)}
          />
          {presets.map((preset) => (
            <Action
              testID={`workspace-ttl-preset-${preset.unit}`}
              label={w(preset.label, { count: preset.amount })}
              compact
              selected={amount() === preset.amount && unit() === preset.unit}
              disabled={locked()}
              onPress={() => update(preset.amount, preset.unit)}
            />
          ))}
        </View>
      </View>
      {!!error() && <Text class="text-(--text-size-12)/(--line-height-16) text-destructive">{error()}</Text>}
      <View class="flex-row justify-end gap-2">
        <Action
          testID="workspace-dialog-cancel"
          label={w("cancel")}
          disabled={busy()}
          onPress={close}
        />
        <Action
          testID="workspace-dialog-confirm"
          label={w("confirm")}
          primary
          disabled={locked()}
          onPress={() => void submit()}
        />
      </View>
    </WorkspaceDialog>
  );
}
