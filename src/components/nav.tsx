import { signal, View } from "nsh";
import { Tabs } from "nsh/base";
import type { IconName } from "./icon";
import { NavigationItem } from "./navigation-item";
import { t } from "../i18n";

export type NavigationId =
  | "keys"
  | "connections"
  | "overview"
  | "console"
  | "pubsub"
  | "settings"
  | "help";
type NavigationEntry = { id: NavigationId; icon: IconName };

const primaryItems: readonly NavigationEntry[] = [
  { id: "keys", icon: "database" },
  { id: "connections", icon: "network" },
  { id: "overview", icon: "chart" },
  { id: "console", icon: "terminal" },
  { id: "pubsub", icon: "broadcast" },
];

const utilityItems: readonly NavigationEntry[] = [
  { id: "settings", icon: "settings" },
  { id: "help", icon: "help" },
];

export function Nav(props: {
  selected?: NavigationId;
  onSelect?: (id: NavigationId) => void;
}) {
  const selected = signal<NavigationId>("keys");
  const item = (entry: NavigationEntry) => (
    <NavigationItem
      testID={`nav-${entry.id}`}
      label={t(`navigation.${entry.id}`)}
      icon={entry.icon}
      selected={(props.selected ?? selected()) === entry.id}
      onPress={() => {
        selected.set(entry.id);
        props.onSelect?.(entry.id);
      }}
    />
  );

  return (
    <View
      testID="left-navigation"
      accessibilityLabel={t("navigation.label")}
      class="w-14 shrink-0 bg-chrome"
    >
      <Tabs
        class="relative flex-1 items-center py-2"
        indicatorClass="left-1.5 my-3 w-0.5 rounded-full bg-sidebar-primary"
      >
        <View class="items-center gap-2">{primaryItems.map(item)}</View>
        <View class="flex-1" />
        <View class="my-2 h-px w-8 shrink-0 bg-sidebar-border" />
        <View class="items-center gap-2">{utilityItems.map(item)}</View>
      </Tabs>
    </View>
  );
}
