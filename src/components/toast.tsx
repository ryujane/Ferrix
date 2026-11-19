import {
  cleanup,
  context,
  Overlay,
  safeArea,
  signal,
  Text,
  token,
  View,
  windowSize,
  type JSX,
} from "nsh";
import {
  Toast as BaseToast,
  ToastManager,
  ToastStack,
  type ToastEntry,
} from "nsh/base";
import { t } from "../i18n";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";

type ToastTone = "success" | "error" | "info";
type ToastContent = { message: string; tone: ToastTone };
export type ToastOptions = { id?: string; duration?: number };
export type ToastController = {
  show: (
    message: string,
    options?: ToastOptions & { tone?: ToastTone },
  ) => string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
};

const ToastContext = context<ToastController | undefined>(undefined);

export function useToast(): ToastController {
  const toast = ToastContext();
  if (!toast) throw new Error("useToast requires ToastProvider");
  return toast;
}

export function ToastProvider(props: { children?: JSX.Element }) {
  const motion = { duration: 150, exitDuration: 150 };
  const manager = new ToastManager(motion);
  const shown = signal<ToastEntry[]>([]),
    expanded = signal(false);
  let sequence = 0,
    disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sync = () => shown.set(manager.visible(3));
  function tick() {
    if (manager.advance(expanded()).changed) sync();
    if (manager.isEmpty()) {
      clearInterval(timer);
      timer = undefined;
      expanded.set(false);
    }
  }
  function show(
    message: string,
    options: ToastOptions & { tone?: ToastTone } = {},
  ): string {
    const id = options.id ?? `toast-${++sequence}`;
    if (disposed) return id;
    const tone = options.tone ?? "info";
    manager.push(id, { message, tone } satisfies ToastContent, {
      timeout: options.duration ?? (tone === "error" ? 4000 : 2500),
    });
    sync();
    timer ??= setInterval(tick, 50);
    return id;
  }
  function dismiss(id: string) {
    if (!disposed && manager.dismiss(id)) sync();
  }
  const toast: ToastController = {
    show,
    success: (message, options) =>
      show(message, { ...options, tone: "success" }),
    error: (message, options) => show(message, { ...options, tone: "error" }),
    info: (message, options) => show(message, { ...options, tone: "info" }),
    dismiss,
  };
  cleanup(() => {
    disposed = true;
    clearInterval(timer);
    manager.dispose();
  });
  const wide = () => windowSize().width >= 480;
  return (
    <ToastContext.Provider value={toast}>
      {/* A stable host keeps Provider's child resolver from rebuilding the page
          when the toast branch changes. Its child inserts update independently. */}
      <View class="flex-1 min-w-0 min-h-0">
        {props.children}
        <If when={shown().length > 0}>
          <Overlay
            style={{
              pointerEvents: "box-none",
              left: 0,
              right: 0,
              bottom: 0,
              padding: 16,
              paddingBottom: safeArea().bottom + 16,
              alignItems: wide() ? "flex-end" : "center",
            }}
          >
            <ToastStack
              motion={motion}
              placement={wide() ? "bottomRight" : "bottomCenter"}
              closeOnEscape={false}
              style={{ width: 320, maxWidth: "100%" }}
              onExpandedChange={({ expanded: open }) => expanded.set(open)}
            >
              <Each of={shown()} key={(entry: ToastEntry) => entry.id}>
                {(entry) => {
                  const content = () => entry().value as ToastContent;
                  return (
                    <BaseToast
                      testID={`toast-${entry().id}`}
                      transitionStatus={entry().status}
                      accessibilityLabel={content().message}
                      onDismissRequest={() => dismiss(entry().id)}
                      class="flex-row items-center gap-3 rounded-lg border border-border-strong bg-popover px-3 py-2 shadow-lg font-sans transition-opacity duration-150"
                      startingClass="opacity-0"
                      endingClass="opacity-0"
                      swipingClass="transition-none"
                    >
                      <Icon
                        name={
                          content().tone === "success"
                            ? "check"
                            : content().tone === "error"
                              ? "close"
                              : "circle"
                        }
                        size={18}
                        color={token(
                          content().tone === "success"
                            ? "success"
                            : content().tone === "error"
                              ? "destructive"
                              : "steel",
                        )}
                      />
                      <View class="flex-1 min-w-0 py-1">
                        <Text class="text-(--text-size-12)/(--line-height-16) text-popover-foreground">
                          {content().message}
                        </Text>
                      </View>
                      <IconButton
                        label={t("toast.close")}
                        icon="close"
                        size={24}
                        onPress={() => dismiss(entry().id)}
                      />
                    </BaseToast>
                  );
                }}
              </Each>
            </ToastStack>
          </Overlay>
        </If>
      </View>
    </ToastContext.Provider>
  );
}
