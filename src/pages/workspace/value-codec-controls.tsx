import { Text, View } from "nsh";
import { Select } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { WorkspaceHintButton } from "./workspace-controls";
import type { KeyTab, WorkspaceState } from "./workspace-state";
import {
  valueDecodings,
  valueDecompressions,
  valuePreviewDirty,
  type ValueDecoding,
  type ValueDecompression,
} from "./value-codecs";
import { workspaceT as w } from "./workspace-text";

export function ValueCodecControls(props: {
  state: WorkspaceState;
  tab: KeyTab;
}) {
  const decoding = () => props.tab.preview?.decoding ?? "none";
  const decompression = () => props.tab.preview?.decompression ?? "none";
  const disabled = () =>
    props.tab.loading ||
    props.tab.partial ||
    !!props.tab.error ||
    props.tab.uncertain ||
    props.state.mutating() ||
    props.state.switching();
  return (
    <View
      testID="workspace-value-codecs"
      class="px-3 py-1.5 flex-row flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border/50"
    >
      {(["decoding", "decompression"] as const).map((kind) => {
        const items = () =>
          (kind === "decoding" ? valueDecodings : valueDecompressions).map(
            (value) => ({
              value,
              title: w(
                `value${kind === "decoding" ? "Decoding" : "Decompression"}.${value}`,
              ),
            }),
          );
        const selected = () =>
          kind === "decoding" ? decoding() : decompression();
        return (
          <View class="flex-row items-center gap-2">
            <Text class="text-(--text-size-11) text-faint">{w(kind)}</Text>
            <Select
              testID={`workspace-${kind}`}
              accessibilityLabel={w(kind)}
              value={selected()}
              items={items()}
              disabled={disabled() || valuePreviewDirty(props.tab.preview)}
              onChange={({ value }) => {
                if (value === null) return;
                void props.state.setValuePreview(
                  props.tab.id,
                  kind === "decoding"
                    ? (value as ValueDecoding)
                    : decoding(),
                  kind === "decompression"
                    ? (value as ValueDecompression)
                    : decompression(),
                );
              }}
              popupClass="rounded-md border border-border-strong bg-elevated p-1 shadow-xl"
              listClass="max-h-72"
              itemClass="h-8 px-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent selected:bg-selected"
              trigger={
                <View
                  testID={`workspace-${kind}-trigger`}
                  class="h-7 px-2 flex-row items-center gap-2 rounded border border-border bg-inset hover:bg-accent active:opacity-70 disabled:opacity-35"
                  style={{ minWidth: kind === "decoding" ? 126 : 142 }}
                >
                  <Text class="flex-1 text-(--text-size-11) text-foreground">
                    {items().find((item) => item.value === selected())?.title}
                  </Text>
                  <Icon name="down" size={11} />
                </View>
              }
              renderItem={(entry) => (
                <View
                  testID={`workspace-${kind}-option-${entry.value}`}
                  class="h-8 justify-center"
                >
                  <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">{entry.title}</Text>
                </View>
              )}
            />
          </View>
        );
      })}
      <If when={!!props.tab.preview}>
        <Action
          testID="workspace-value-codec-reset"
          label={w("valueCodecReset")}
          compact
          disabled={disabled() || valuePreviewDirty(props.tab.preview)}
          onPress={() =>
            void props.state.setValuePreview(props.tab.id, "none", "none")
          }
        />
      </If>
      <If when={valuePreviewDirty(props.tab.preview)}>
        <Action
          testID="workspace-value-codec-revert"
          label={w("valueCodecRevert")}
          compact
          disabled={disabled()}
          onPress={() => props.state.revertValuePreview(props.tab.id)}
        />
        <WorkspaceHintButton message={w("valueCodecSaveBeforeSwitch")} />
      </If>
    </View>
  );
}
