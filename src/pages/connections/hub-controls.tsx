import { Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { fonts } from "../../fonts";
import { Icon, type IconName } from "../../components/icon";

export function HubAction(props: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  primary?: boolean;
  disabled?: boolean;
  testID?: string;
  height?: number;
  full?: boolean;
  ghost?: boolean;
}) {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ height: props.height ?? 36 }}
      class={`shrink-0 flex-row items-center justify-center gap-1.5 rounded px-4 active:opacity-70 focus:ring-1 focus:ring-ring disabled:opacity-35 ${props.full ? "w-full" : ""} ${props.primary ? "bg-primary hover:bg-primary/85" : "bg-transparent hover:bg-accent"}`}
    >
      {props.icon && (
        <Icon
          name={props.icon}
          size={14}
          color={token(
            props.primary ? "primary-foreground" : "muted-foreground",
          )}
        />
      )}
      <Text
        style={{
          fontFamily: fonts.ui,
          fontSize: token("text-size-12"),
          color: token(props.primary ? "primary-foreground" : "foreground"),
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}
export function HubCount(props: { count: number }) {
  return (
    <View class="rounded bg-selected px-1.5 py-0.5">
      <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">{props.count}</Text>
    </View>
  );
}
export { Modal } from "../../components/modal";
