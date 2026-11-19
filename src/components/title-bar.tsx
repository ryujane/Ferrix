import {
  colorScheme,
  reduceMotion,
  setColorScheme,
  View,
  Text,
  type JSX,
} from "nsh";
import { Button } from "nsh/base";
import { Logo } from "./logo";
import { Icon } from "./icon";
import { scaledFontSize } from "../fonts";
import { t } from "../i18n";
import type { ThemePreference } from "../data/preferences";
import { titleBarArea } from "../utils/window";

export function TitleBar(props: {
  children?: JSX.Element;
  onThemeChange?: (theme: ThemePreference) => void;
}) {
  const area = () => titleBarArea();
  return (
    <If when={area().height > 0}>
      <View
        testID="title-bar"
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center gap-2 bg-chrome"
        style={{
          paddingLeft: Math.max(area().left + 8, 12),
          paddingRight: Math.max(area().right + 8, 12),
          height: area().height,
        }}
      >
        <Logo size={32} />
        <Text class="mr-4 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">Ferrix</Text>
        <View class="flex-1" />
        {props.children}
        <View
          testID="theme-switcher"
          desktop={{ windowDrag: false }}
          accessibilityLabel={t("settings.theme")}
          class="relative shrink-0 flex-row items-center rounded-full border p-0.5"
          style={{
            height: 30,
            backgroundColor: colorScheme() === "dark" ? "#131b2e" : "#e2eaf5",
            borderColor: colorScheme() === "dark" ? "#2d344999" : "#cbd5e199",
            boxShadow: "inset 0 2px 4px #0000000f",
          }}
        >
          <View
            testID="theme-switch-thumb"
            class="absolute left-0.5 top-0.5 bottom-0.5 w-[58px] rounded-full"
            style={{
              backgroundColor: "#ff5451",
              boxShadow: "0 2px 4px #00000026",
              pointerEvents: "none",
              transform:
                colorScheme() === "dark"
                  ? "translateX(0px)"
                  : "translateX(58px)",
              transitionProperty: "transform",
              transitionDuration: reduceMotion() ? 0 : 280,
              transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
          {(["dark", "light"] as const).map((scheme) => (
            <Button
              testID={`theme-${scheme}`}
              accessibilityLabel={t(`theme.${scheme}`)}
              selected={colorScheme() === scheme}
              onPress={() =>
                props.onThemeChange
                  ? props.onThemeChange(scheme)
                  : setColorScheme(scheme)
              }
              hitSlop={{ top: 3, bottom: 3 }}
              class="relative z-10 w-[58px] h-6 flex-row items-center justify-center gap-1 rounded-full bg-transparent hover:opacity-90 active:opacity-70 focus:ring-1 focus:ring-primary"
            >
              <Icon
                name={scheme === "dark" ? "moon" : "sun"}
                size={14}
                color={
                  colorScheme() === scheme
                    ? "#5c0008"
                    : colorScheme() === "dark"
                      ? "#e4beba"
                      : "#64748b"
                }
              />
              <Text
                style={{
                  fontSize: scaledFontSize(10),
                  lineHeight: scaledFontSize(12),
                  fontWeight: 600,
                  color:
                    colorScheme() === scheme
                      ? "#5c0008"
                      : colorScheme() === "dark"
                        ? "#e4beba"
                        : "#64748b",
                }}
              >
                {t(`theme.${scheme}`)}
              </Text>
            </Button>
          ))}
        </View>
      </View>
    </If>
  );
}
