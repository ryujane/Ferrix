import { Text } from "nsh";
import { Tooltip as BaseTooltip } from "nsh/base";

export function Tooltip(props: { label: string }) {
  return (
    <BaseTooltip class="max-w-[360px] rounded-md border border-border-strong bg-popover px-2.5 py-1.5 shadow-md font-sans">
      <Text class="text-(--text-size-11) text-popover-foreground">{props.label}</Text>
    </BaseTooltip>
  );
}
