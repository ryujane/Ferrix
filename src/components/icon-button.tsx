import { token } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "./icon";
import { Tooltip } from "./tooltip";

export function IconButton(props: {
  label: string;
  icon: IconName;
  onPress: () => void;
  selected?: boolean;
  size?: number;
  color?: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      selected={props.selected}
      tooltip={<Tooltip label={props.label} />}
      class={`items-center justify-center rounded hover:bg-accent active:opacity-60 focus:ring-1 focus:ring-ring disabled:opacity-35 ${props.selected ? "bg-primary/15" : "bg-transparent"}`}
      style={{ width: props.size ?? 32, height: props.size ?? 32 }}
    >
      <Icon
        name={props.icon}
        size={props.size && props.size > 36 ? 20 : 16}
        color={props.color ?? (props.selected ? token("primary") : undefined)}
      />
    </Button>
  );
}
