import { Text, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { IconButton } from "../../components/icon-button";
import { useToast } from "../../components/toast";
import { workspaceT as w } from "./workspace-text";

const typeStyles: Record<string, string> = {
  string: "bg-type-string/15 text-type-string",
  json: "bg-success/15 text-success",
  hash: "bg-type-hash/15 text-type-hash",
  list: "bg-type-list/15 text-type-list",
  set: "bg-type-set/15 text-type-set",
  zset: "bg-type-zset/15 text-type-zset",
  stream: "bg-type-stream/15 text-type-stream",
};
export function KeyBadge(props: { type?: string }) {
  return (
    <View class="shrink-0 rounded-sm px-1 py-0.5">
      <Text
        class={`text-(--text-size-9) font-mono font-semibold px-1 py-0.5 rounded-sm ${typeStyles[props.type ?? ""] ?? "bg-selected text-muted-foreground"}`}
      >
        {(
          { string: "STR", json: "JSON", stream: "STRM" } as Record<
            string,
            string
          >
        )[props.type ?? ""] ??
          props.type?.toUpperCase() ??
          "KEY"}
      </Text>
    </View>
  );
}
export function WorkspaceHintButton(props: { message: string }) {
  const toast = useToast();
  return (
    <IconButton
      label={w("showHint")}
      icon="help"
      size={24}
      onPress={() => toast.info(props.message, { duration: 6000 })}
    />
  );
}
export function WorkspaceDialog(props: {
  title: string;
  description: string;
  children?: JSX.Element;
  onClose: () => void;
  alert?: boolean;
  heightHint?: number;
  width?: number;
}) {
  const width = () => Math.min(props.width ?? 480, windowSize().width - 32);
  return (
    <Dialog
      testID="workspace-dialog"
      role={props.alert ? "alertdialog" : "dialog"}
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      animation="none"
      closeOnBackdropPress={false}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-black/60"
      class="font-sans rounded-lg border border-border bg-workspace shadow-xl"
      style={{
        position: "absolute",
        width: width(),
        left: (windowSize().width - width()) / 2,
        top: Math.max(
          40,
          (windowSize().height - (props.heightHint ?? 280)) / 2,
        ),
      }}
    >
      <View class="p-5 gap-4">
        <View class="flex-row items-center gap-3">
          <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {props.title}
          </Text>
          <IconButton
            label={w("cancel")}
            icon="close"
            onPress={props.onClose}
          />
        </View>
        <Text class="text-(--text-size-12) text-muted-foreground leading-(--line-height-20)">
          {props.description}
        </Text>
        {props.children}
      </View>
    </Dialog>
  );
}
