import { Scroll, Text, token, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { Dot } from "../../components/dot";
import { Icon, type IconName } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { workspaceT as w } from "./workspace-text";

export const workspaceWriteDialogWidth = () =>
  Math.min(620, windowSize().width - 32);

export function WorkspaceWriteDialog(props: {
  title: string;
  icon?: IconName;
  description: string;
  database: number;
  keyCount?: string | null;
  databaseControl?: JSX.Element;
  testIDPrefix: string;
  formTestID: string;
  busy: boolean;
  onClose: () => void;
  children?: JSX.Element;
  footer: JSX.Element;
}) {
  const height = () => Math.min(600, windowSize().height - 48);
  return (
    <Dialog
      testID="workspace-dialog"
      role="dialog"
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      animation="none"
      closeOnBackdropPress={false}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-black/60"
      class="font-sans rounded-xl overflow-hidden border border-border-strong bg-panel shadow-xl"
      style={{
        position: "absolute",
        width: workspaceWriteDialogWidth(),
        height: height(),
        left: (windowSize().width - workspaceWriteDialogWidth()) / 2,
        top: (windowSize().height - height()) / 2,
      }}
    >
      <View class="h-10 shrink-0 px-4 flex-row items-center gap-2 bg-chrome border-b border-border/40">
        <Icon name={props.icon ?? "plus"} size={16} color={token("primary")} />
        <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {props.title}
        </Text>
        <If when={props.databaseControl !== undefined}>
          {props.databaseControl}
        </If>
        <If when={props.databaseControl === undefined}>
          <View class="flex-row items-center gap-1.5 px-2 py-1 rounded bg-panel">
            <Dot />
            <Text class="font-mono text-(--text-size-11) text-foreground">
              DB{props.database}
            </Text>
            <If when={props.keyCount != null}>
              <Text class="font-mono text-(--text-size-10) text-muted-foreground">
                {w("databaseKeys", { count: props.keyCount })}
              </Text>
            </If>
          </View>
        </If>
        <IconButton
          testID={`${props.testIDPrefix}-close`}
          label={w("cancel")}
          icon="close"
          size={24}
          disabled={props.busy}
          onPress={props.onClose}
        />
      </View>
      <Scroll
        testID={props.formTestID}
        class="flex-1 min-h-0"
        contentClass="p-3 gap-3"
      >
        {props.children}
      </Scroll>
      <View class="shrink-0 px-4 py-3 bg-chrome border-t border-border/40">
        {props.footer}
      </View>
    </Dialog>
  );
}
