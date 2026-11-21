import { Text, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { IconButton } from "./icon-button";
import { hubT } from "../i18n";

const panelClass =
  "font-sans rounded-lg border border-border bg-workspace overflow-hidden shadow-xl";

export function Modal(props: {
  title: string;
  headerHeight?: number;
  headerPaddingTop?: number;
  description?: string;
  onClose: () => void;
  children?: JSX.Element;
  width?: number;
  height?: number | "auto";
  maxHeight?: number;
  id?: string;
  alert?: boolean;
}) {
  const autoHeight = () => props.height === "auto";
  const width = () => Math.min(props.width ?? 740, windowSize().width - 32);
  const maxHeight = () => {
    const available = windowSize().height - 48;
    return Math.min(props.maxHeight ?? available, available);
  };
  const height = () =>
    Math.min(typeof props.height === "number" ? props.height : 740, maxHeight());

  function Content() {
    return (
      <>
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
      </>
    );
  }

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
      class={
        autoHeight() ? "absolute inset-0 items-center justify-center" : panelClass
      }
      style={
        autoHeight() ? undefined : {
          position: "absolute",
          left: (windowSize().width - width()) / 2,
          top: (windowSize().height - height()) / 2,
          width: width(),
          height: height(),
        }
      }
    >
      <If when={autoHeight()}>
        <View class={panelClass} style={{ width: width(), maxHeight: maxHeight() }}>
          <Content />
        </View>
      </If>
      <If when={!autoHeight()}>
        <Content />
      </If>
    </Dialog>
  );
}
