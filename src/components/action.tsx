import { Text, token, type JSX } from "nsh";
import { Button } from "nsh/base";
import { fonts } from "../fonts";
import { Icon, type IconName } from "./icon";

export function Action(props: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  selected?: boolean;
  primary?: boolean;
  disabled?: boolean;
  compact?: boolean;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={props.onPress}
      class={`flex-row items-center justify-center gap-1.5 rounded px-2 hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-35 ${props.compact ? "h-7" : "h-8"} ${props.primary ? "bg-primary hover:bg-primary/85" : props.selected ? "bg-selected" : "bg-transparent"}`}
    >
      {props.icon && (
        <Icon
          name={props.icon}
          size={14}
          color={
            props.primary
              ? token("primary-foreground")
              : props.selected
                ? token("foreground")
                : undefined
          }
        />
      )}
      {props.children ?? (
        <Text
          style={{
            fontFamily: fonts.ui,
            fontSize: token("text-size-12"),
            color: props.primary
              ? token("primary-foreground")
              : token("foreground"),
          }}
        >
          {props.label}
        </Text>
      )}
    </Button>
  );
}
