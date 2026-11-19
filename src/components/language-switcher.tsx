import { Text, View } from "nsh";
import { Select } from "nsh/base";
import { t, type LanguageSettings } from "../i18n";
import { Icon } from "./icon";

export function LanguageSwitcher(props: { settings: LanguageSettings }) {
  const title = () => {
    switch (props.settings.preference()) {
      case "zh-CN":
        return "简体中文";
      case "en":
        return "English";
      default:
        return t("language.system");
    }
  };

  return (
    <View
      desktop={{ windowDrag: false }}
      class="shrink-0 flex-row items-center gap-2"
    >
      <Select
        accessibilityLabel={t("language.label")}
        value={props.settings.preference()}
        items={[
          { value: "system", title: t("language.system") },
          { value: "zh-CN", title: "简体中文" },
          { value: "en", title: "English" },
        ]}
        onChange={(event) => {
          void props.settings.select(event.value);
        }}
        align="end"
        popupClass="rounded-md border border-border bg-elevated p-1 shadow-xl"
        itemClass="h-8 px-3 rounded text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent selected:bg-selected"
        trigger={
          <View
            testID="language-select"
            class="h-8 flex-row items-center gap-2 rounded-md border border-border px-2 hover:bg-accent"
          >
            <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">{title()}</Text>
            <Icon name="down" size={12} />
          </View>
        }
      />
      {props.settings.error() && (
        <Text testID="language-error" class="text-(--text-size-12)/(--line-height-16) text-destructive">
          {t(props.settings.error()!)}
        </Text>
      )}
    </View>
  );
}
