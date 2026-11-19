import { Text, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { IconButton } from "./icon-button";
import { hubT } from "../i18n";

export function Modal(props: {
  title: string;
  headerHeight?: number;
  headerPaddingTop?: number;
  description?: string;
  onClose: () => void;
  children?: JSX.Element;
  width?: number;
  height?: number;
  id?: string;
  alert?: boolean;
}) {
  return (
    <Dialog
      testID={props.id}
      role={props.alert ? "alertdialog" : "dialog"}
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      animation="none"
      closeOnBackdropPress={false}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-black/60"
      class="font-sans rounded-lg border border-border bg-workspace overflow-hidden shadow-xl"
      style={{
        position: "absolute",
        left:
          (windowSize().width -
            Math.min(props.width ?? 740, windowSize().width - 32)) /
          2,
        top:
          (windowSize().height -
            Math.min(props.height ?? 740, windowSize().height - 48)) /
          2,
        width: Math.min(props.width ?? 740, windowSize().width - 32),
        height: Math.min(props.height ?? 740, windowSize().height - 48),
      }}
    >
      <View
        class="px-8 flex-row items-center shrink-0 gap-4"
        style={{
          height: props.headerHeight ?? 96,
          paddingTop: props.headerPaddingTop ?? 0,
        }}
      >
        <View class="flex-1 gap-1">
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {props.title}
          </Text>
          {props.description && (
            <Text class="text-(--text-size-12) leading-(--line-height-18) text-muted-foreground">
              {props.description}
            </Text>
          )}
        </View>
        <IconButton
          testID={props.id ? props.id + "-close" : undefined}
          label={hubT("close")}
          icon="close"
          onPress={props.onClose}
        />
      </View>
      {props.children}
    </Dialog>
  );
}
