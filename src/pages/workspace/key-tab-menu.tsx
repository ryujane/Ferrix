import { Text, type JSX } from "nsh";
import { ContextMenu, MenuItem } from "nsh/base";
import type { WorkspaceState } from "./workspace-state";
import { workspaceT as w } from "./workspace-text";

export type TabCloseAction = "closeOthers" | "close" | "closeAll";
const actions = [
  { kind: "closeOthers", id: "close-others" },
  { kind: "close", id: "close" },
  { kind: "closeAll", id: "close-all" },
] as const;

export function KeyTabMenu(props: {
  state: WorkspaceState;
  tabId: string;
  disabled: boolean;
  children?: JSX.Element;
  onAction: (action: TabCloseAction, id: string) => void;
}) {
  const disabled = () =>
    props.disabled || props.state.mutating() || props.state.switching();
  return (
    <ContextMenu
      class="h-9 shrink-0"
      disabled={disabled()}
      popupClass="min-w-40 rounded-md border border-border-strong bg-popover p-1 shadow-xl font-sans"
      trigger={props.children}
    >
      {actions.map((action) => (
        <MenuItem
          testID={"workspace-tab-" + action.id}
          class="h-8 px-2.5 flex-row items-center rounded text-(--text-size-12)/(--line-height-16) text-foreground hover:bg-accent focus:bg-accent active:bg-selected disabled:opacity-40"
          disabled={
            disabled() ||
            (action.kind === "closeOthers" && props.state.tabs().length < 2)
          }
          onSelect={() => props.onAction(action.kind, props.tabId)}
        >
          <Text>{w(action.kind)}</Text>
        </MenuItem>
      ))}
    </ContextMenu>
  );
}
