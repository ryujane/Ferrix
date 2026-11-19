import { token } from "nsh";
import { Tab } from "nsh/base";
import { Icon, type IconName } from "./icon";
import { Tooltip } from "./tooltip";

export function NavigationItem(props: {
  label: string;
  icon: IconName;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Tab
      testID={props.testID}
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      tooltip={<Tooltip label={props.label} />}
      class={`relative h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent active:opacity-70 focus:ring-1 focus:ring-sidebar-ring ${props.selected ? "bg-sidebar-accent" : "bg-transparent"}`}
    >
      <Icon
        name={props.icon}
        size={20}
        color={
          props.selected ? token("sidebar-primary") : token("muted-foreground")
        }
      />
    </Tab>
  );
}
