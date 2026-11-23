import {
  computed,
  effect,
  keymap,
  Scroll,
  signal,
  Text,
  token,
  View,
  windowSize,
  type InputRef,
  type JSX,
} from "nsh";
import {
  Button,
  Editor,
  Input,
  Select,
  Slider,
  Switch,
  type EditorRef,
} from "nsh/base";
import { Action } from "../../components/action";
import { editorLineHeight, fonts, scaledFontSize } from "../../fonts";
import { Icon, type IconName } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { useClipboardCopy } from "../../utils/clipboard";
import { t, type LanguageSettings } from "../../i18n";
import { CredentialSettingsSection } from "./credential-settings-section";
import {
  createCredentialSettings,
  type CredentialConfiguration,
} from "../../data/credential-settings";
import {
  defaultPreferences,
  fontScaleOptions,
  parsePreferencesDocument,
  type PreferenceSettings,
  type PreferencesDocument,
  type ThemePreference,
} from "../../data/preferences";

type Category =
  | "general"
  | "appearance"
  | "browser"
  | "formatting"
  | "safety"
  | "credentials"
  | "shortcuts"
  | "advanced";
const categories: readonly { id: Category; icon: IconName }[] = [
  { id: "general", icon: "settings" },
  { id: "appearance", icon: "sun" },
  { id: "browser", icon: "folder" },
  { id: "formatting", icon: "braces" },
  { id: "safety", icon: "network" },
  { id: "shortcuts", icon: "terminal" },
  { id: "credentials", icon: "database" },
  { id: "advanced", icon: "filter" },
];

function PreferencesSelect(props: {
  id: string;
  label: string;
  value: string;
  items: { value: string; title: string }[];
  triggerClass?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      items={props.items}
      accessibilityLabel={props.label}
      onChange={({ value }) => {
        if (value !== null) props.onChange(value);
      }}
      align="end"
      popupClass="rounded-md border border-border bg-elevated p-1 shadow-xl"
      itemClass="min-h-9 px-3 py-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-accent selected:bg-selected"
      trigger={
        <View
          testID={props.id}
          class={`h-9 ${props.triggerClass ?? "min-w-0"} flex-row items-center gap-3 rounded border border-border bg-inset px-3 hover:bg-accent`}
        >
          <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">
            {props.items.find((item) => item.value === props.value)?.title ??
              props.value}
          </Text>
          <Icon name="down" size={12} />
        </View>
      }
    />
  );
}

function SettingRow(props: {
  title: string;
  description?: string;
  children: JSX.Element;
  badge?: string;
}) {
  return (
    <View class="flex-row items-center gap-4 py-3 border-b border-border/40">
      <View class="flex-1 min-w-0 gap-1">
        <View class="flex-row flex-wrap items-center gap-2">
          <Text class="text-(--text-size-13) font-medium text-foreground">
            {props.title}
          </Text>
          {props.badge && (
            <Text class="rounded bg-primary/10 px-1.5 py-0.5 text-(--text-size-9) font-mono text-primary">
              {props.badge}
            </Text>
          )}
        </View>
        {props.description && (
          <Text class="text-(--text-size-12) text-muted-foreground leading-(--line-height-18)">
            {props.description}
          </Text>
        )}
      </View>
      <View
        class="shrink-0"
        style={{ maxWidth: windowSize().width < 800 ? 170 : 280 }}
      >
        {props.children}
      </View>
    </View>
  );
}

function Section(props: {
  title: string;
  caption: string;
  color: string;
  children?: JSX.Element;
}) {
  return (
    <View class="rounded-lg p-4 gap-1 border border-border/30">
      <View class="flex-row items-center gap-2 pb-2">
        <View
          class="h-4 w-1 rounded-sm"
          style={{ backgroundColor: props.color }}
        />
        <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {props.title}
        </Text>
        {windowSize().width >= 1050 && (
          <Text class="text-(--text-size-10) font-mono text-faint">{props.caption}</Text>
        )}
      </View>
      {props.children}
    </View>
  );
}

function ThemeCard(props: {
  theme: ThemePreference;
  selected: boolean;
  onPress: () => void;
}) {
  const dark = props.theme !== "light";
  return (
    <Button
      testID={`settings-theme-${props.theme}`}
      selected={props.selected}
      accessibilityLabel={t(`settings.theme.${props.theme}`)}
      onPress={props.onPress}
      class={`flex-1 min-w-0 rounded-md border p-3 gap-2 hover:bg-accent active:opacity-80 focus:ring-1 focus:ring-ring ${props.selected ? "border-primary bg-primary/5" : "border-border bg-panel"}`}
    >
      <View class="flex-row items-center gap-2">
        <Icon
          name={
            props.theme === "dark"
              ? "moon"
              : props.theme === "light"
                ? "sun"
                : "settings"
          }
          size={14}
          color={props.selected ? token("primary") : undefined}
        />
        <Text class="flex-1 text-(--text-size-12)/(--line-height-16) font-medium text-foreground">
          {t(`settings.theme.${props.theme}`)}
        </Text>
        <Icon
          name={props.selected ? "check" : "circle"}
          size={13}
          color={props.selected ? token("primary") : token("faint")}
        />
      </View>
      <View
        class="h-14 rounded p-1.5 gap-1"
        style={{ backgroundColor: dark ? "#060e20" : "#f5f7fb" }}
      >
        <View
          class="h-2 rounded-sm"
          style={{ backgroundColor: dark ? "#171f33" : "#e4ecf7" }}
        />
        <View class="flex-1 flex-row gap-1">
          <View
            class="w-1/4 rounded-sm"
            style={{ backgroundColor: dark ? "#131b2e" : "#e4ecf7" }}
          />
          <View
            class="flex-1 rounded-sm p-1 gap-1"
            style={{
              backgroundColor:
                props.theme === "system"
                  ? "#e4ecf7"
                  : dark
                    ? "#0b1326"
                    : "#ffffff",
            }}
          >
            <View
              class="h-1 w-3/4 rounded-sm"
              style={{
                backgroundColor:
                  props.theme === "system"
                    ? "#10b981"
                    : dark
                      ? "#a63942"
                      : "#7bd0ff",
              }}
            />
            <View
              class="h-1 w-1/2 rounded-sm"
              style={{ backgroundColor: dark ? "#334155" : "#cbd5e1" }}
            />
          </View>
        </View>
      </View>
      <Text class="text-(--text-size-10) text-muted-foreground">
        {t(`settings.theme.${props.theme}Hint`)}
      </Text>
    </Button>
  );
}

export function SettingsPage(props: {
  preferences: PreferenceSettings;
  language: LanguageSettings;
  credentials?: CredentialConfiguration;
}) {
  const copyToClipboard = useClipboardCopy();
  const credentials = props.credentials ?? createCredentialSettings();
  const savedDocument = (): PreferencesDocument => ({
    version: 1,
    language: props.language.preference(),
    ...props.preferences.value(),
  });
  const draft = signal<PreferencesDocument>(savedDocument());
  const edited = signal(false),
    category = signal<Category>("general"),
    query = signal("");
  const mode = signal<"form" | "json">("form"),
    json = signal("");
  const status = signal<string>(),
    statusError = signal(false),
    applying = signal(false),
    saveFailed = signal(false);
  let search: InputRef | undefined;
  let configEditor: EditorRef | undefined;
  const narrow = () => windowSize().width < 760;
  const dirty = computed(
    () =>
      saveFailed() ||
      (mode() === "json"
        ? json() !== JSON.stringify(savedDocument(), null, 2)
        : JSON.stringify(draft()) !== JSON.stringify(savedDocument())),
  );

  effect(() => {
    const saved = savedDocument();
    if (!edited()) {
      draft.set(saved);
      json.set(JSON.stringify(saved, null, 2));
    }
  });

  function update<K extends keyof PreferencesDocument>(
    key: K,
    value: PreferencesDocument[K],
  ) {
    edited.set(true);
    draft.set({ ...draft(), [key]: value });
    status.set(undefined);
  }
  function notify(key: string, error = false) {
    status.set(key);
    statusError.set(error);
  }
  function jsonError(cause: unknown) {
    notify(
      cause instanceof Error && cause.message.startsWith("settings.")
        ? cause.message
        : "settings.invalidJson",
      true,
    );
  }
  function toggleJson() {
    if (mode() === "form") {
      json.set(JSON.stringify(draft(), null, 2));
      mode.set("json");
      category.set("advanced");
    } else {
      try {
        draft.set(parsePreferencesDocument(json()));
        mode.set("form");
        category.set("general");
      } catch (cause) {
        jsonError(cause);
        return false;
      }
    }
    return true;
  }
  function selectCategory(value: Category) {
    if ((value === "advanced") !== (mode() === "json") && !toggleJson()) return;
    category.set(value);
  }
  function cancel() {
    draft.set(savedDocument());
    json.set(JSON.stringify(savedDocument(), null, 2));
    edited.set(false);
    saveFailed.set(false);
    notify("settings.discarded");
  }
  function reset() {
    edited.set(true);
    const next: PreferencesDocument = {
      version: 1,
      language: "system",
      ...defaultPreferences,
    };
    draft.set(next);
    json.set(JSON.stringify(next, null, 2));
    saveFailed.set(false);
    notify("settings.defaultsRestored");
  }
  async function save() {
    if (applying() || props.preferences.loading()) return;
    let next: PreferencesDocument;
    try {
      next = parsePreferencesDocument(
        mode() === "json" ? json() : JSON.stringify(draft()),
      );
    } catch (cause) {
      jsonError(cause);
      return;
    }
    applying.set(true);
    try {
      const preferencesSaved = await props.preferences.save(next);
      if (!preferencesSaved) {
        saveFailed.set(true);
        notify(props.preferences.error() ?? "settings.saveError", true);
        return;
      }
      const languageSaved = await props.language.select(next.language);
      if (!languageSaved) {
        saveFailed.set(true);
        notify("language.saveError", true);
        return;
      }
      edited.set(false);
      saveFailed.set(false);
      draft.set(savedDocument());
      json.set(JSON.stringify(savedDocument(), null, 2));
      notify("settings.saved");
    } finally {
      applying.set(false);
    }
  }
  async function exportJson() {
    try {
      const next = parsePreferencesDocument(
        mode() === "json" ? json() : JSON.stringify(draft()),
      );
      await copyToClipboard(JSON.stringify(next, null, 2));
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("settings."))
        jsonError(cause);
      else notify("settings.exportError", true);
    }
  }

  keymap.bind("mod+f", () => search?.focus());
  keymap.bind("mod+s", () => {
    void save();
  });

  const matches = (keys: string[]) => {
    const text = query().trim().toLowerCase();
    return (
      !text ||
      keys.some((key) =>
        `${key} ${t(`settings.${key}`)} ${t(`settings.${key}Description`)}`
          .toLowerCase()
          .includes(text),
      )
    );
  };
  const field = (area: Category, key: string) =>
    (category() === "general" ||
      category() === area ||
      (category() === "safety" && key === "confirmExit")) &&
    matches([key]);
  const startup = () =>
    ["language", "autoReconnect", "restoreTabs", "confirmExit"].some((key) =>
      field("general", key),
    );
  const appearance = () =>
    ["theme", "uiFontScale", "editorFont", "fontSize"].some((key) =>
      field("appearance", key),
    );
  const browser = () =>
    field("browser", "scanCount") ||
    field("browser", "keyTabMode") ||
    field("formatting", "formatter");
  const credentialSection = () =>
    (category() === "general" || category() === "credentials") &&
    (!query().trim() ||
      [
        "credentials.title",
        "credentials.provider",
        "credentials.masterPassword",
        "credentials.keepassDescription",
        "credentials.nativeDescription",
      ].some((key) =>
        t(key).toLowerCase().includes(query().trim().toLowerCase()),
      ) ||
      "native keychain keepass master password".includes(
        query().trim().toLowerCase(),
      ));
  const noMatches = () =>
    !startup() &&
    !appearance() &&
    !browser() &&
    !credentialSection() &&
    !["shortcuts", "advanced"].includes(category());
  const checkbox = (
    key: "autoReconnect" | "restoreTabs" | "confirmExit",
  ) => (
    <Switch
      testID={`settings-${key}`}
      accessibilityLabel={t(`settings.${key}`)}
      checked={draft()[key]}
      onChange={({ checked }) => update(key, checked)}
      class="h-9 justify-center disabled:opacity-45 focus:ring-1 focus:ring-ring"
      trackClass="w-10 h-[22px] rounded-full bg-border checked:bg-primary"
      thumbClass="absolute left-0.5 top-0.5 w-[18px] h-[18px] rounded-full bg-white checked:translate-x-[18px]"
    />
  );
  const select = (
    key: "language" | "formatter" | "keyTabMode",
    items: { value: string; title: string }[],
    triggerClass?: string,
  ) => (
    <PreferencesSelect
      id={`settings-${key}`}
      label={t(`settings.${key}`)}
      value={draft()[key]}
      items={items}
      triggerClass={triggerClass}
      onChange={(value) =>
        update(key, value as PreferencesDocument[typeof key])
      }
    />
  );

  return (
    <View testID="settings-page" class="flex-1 min-w-0 min-h-0 bg-workspace">
      <View
        testID="settings-header"
        class="h-12 shrink-0 flex-row items-center gap-3 border-b border-border bg-workspace px-4"
      >
        <Icon name="filter" color={token("primary")} size={18} />
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {t("settings.title")}
        </Text>
        <View class="flex-1" />
        <View
          class="h-8 flex-row items-center gap-2 rounded bg-inset px-2"
          style={{ width: narrow() ? 180 : 280 }}
        >
          <Icon name="search" size={13} />
          <Input
            ref={(ref) => {
              search = ref;
            }}
            testID="settings-search"
            accessibilityLabel={t("settings.search")}
            value={query()}
            onChange={({ value }) => query.set(value)}
            placeholder={t("settings.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            class="flex-1 min-w-0 h-8 text-(--text-size-12)/(--line-height-16) text-foreground"
          />
          {query() ? (
            <IconButton
              label={t("settings.clearSearch")}
              icon="close"
              size={22}
              onPress={() => query.set("")}
            />
          ) : (
            <Text class="text-(--text-size-10) font-mono text-faint">
              {keymap.label("mod+f")}
            </Text>
          )}
        </View>
      </View>
      <View
        class="flex-1 min-h-0"
        style={{ flexDirection: narrow() ? "column" : "row" }}
      >
        {narrow() ? (
          <View class="p-2 border-b border-border">
            <PreferencesSelect
              id="settings-category"
              label={t("settings.categoryLabel")}
              value={category()}
              items={categories.map((item) => ({
                value: item.id,
                title: t(`settings.categories.${item.id}`),
              }))}
              onChange={(value) => selectCategory(value as Category)}
            />
          </View>
        ) : (
          <View class="w-56 shrink-0 min-h-0 border-r border-border bg-workspace p-3 gap-1">
            <Text class="px-2 py-2 text-(--text-size-9) font-mono text-faint">
              {t("settings.corePreferences")}
            </Text>
            {categories.map((item, index) => (
              <>
                {index === 5 && (
                  <Text class="px-2 pt-5 pb-2 text-(--text-size-9) font-mono text-faint">
                    {t("settings.environment")}
                  </Text>
                )}
                <Button
                  testID={`settings-category-${item.id}`}
                  accessibilityLabel={t(`settings.categories.${item.id}`)}
                  selected={category() === item.id}
                  onPress={() => selectCategory(item.id)}
                  class={`min-h-9 flex-row items-center gap-2.5 rounded px-2 py-2 hover:bg-accent focus:ring-1 focus:ring-ring ${category() === item.id ? "bg-selected" : "bg-transparent"}`}
                >
                  <Icon
                    name={item.icon}
                    size={16}
                    color={
                      category() === item.id ? token("primary") : undefined
                    }
                  />
                  <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">
                    {t(`settings.categories.${item.id}`)}
                  </Text>
                  {item.id === "general" && category() === item.id && (
                    <View class="w-1 h-3 rounded-full bg-primary" />
                  )}
                  {item.id === "appearance" && (
                    <Text class="text-(--text-size-9) font-mono text-faint">
                      {t(`theme.${draft().theme}`)}
                    </Text>
                  )}
                  {item.id === "browser" && (
                    <Text class="text-(--text-size-9) font-mono text-success">SCAN</Text>
                  )}
                  {item.id === "formatting" && (
                    <Text class="text-(--text-size-9) font-mono text-steel">JSON</Text>
                  )}
                </Button>
              </>
            ))}
            <View class="flex-1" />
            <View class="rounded bg-inset p-2 gap-2">
              <View class="flex-row items-center gap-2">
                <View class="w-1.5 h-1.5 rounded-full bg-success" />
                <Text class="text-(--text-size-10) text-faint">
                  {t("settings.localPreferences")}
                </Text>
              </View>
              <Action
                label={t(
                  mode() === "json" ? "settings.editForm" : "settings.editJson",
                )}
                icon="braces"
                compact
                onPress={toggleJson}
              />
            </View>
          </View>
        )}
        <View class="flex-1 min-w-0 min-h-0">
          {(status() || props.preferences.error()) && (
            <View class="shrink-0 border-b border-border px-4 py-2">
              <Text
                testID="settings-notice"
                class={`text-(--text-size-12)/(--line-height-16) ${statusError() || (!status() && props.preferences.error()) ? "text-destructive" : "text-success"}`}
              >
                {t(status() ?? props.preferences.error()!)}
              </Text>
            </View>
          )}
          {props.preferences.loading() ? (
            <View class="flex-1 items-center justify-center">
              <Text class="text-(--text-size-14)/(--line-height-20) text-muted-foreground">
                {t("settings.loading")}
              </Text>
            </View>
          ) : mode() === "json" ? (
            <View class="flex-1 min-h-0 p-4 gap-3">
              <View class="flex-row items-center gap-3">
                <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                  ferrix-settings.json
                </Text>
                <IconButton
                  label={t("settings.focusEditor")}
                  icon="pencil"
                  onPress={() => configEditor?.focus()}
                />
                <Action
                  label={t("settings.editForm")}
                  icon="settings"
                  compact
                  onPress={toggleJson}
                />
              </View>
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {t("settings.jsonHint")}
              </Text>
              <Editor
                ref={(ref) => {
                  configEditor = ref;
                }}
                testID="settings-json"
                accessibilityLabel={t("settings.jsonEditor")}
                autoFocus
                language="json"
                value={json()}
                onChange={({ value }) => {
                  edited.set(true);
                  json.set(value);
                  status.set(undefined);
                }}
                fontFamily={
                  draft().editorFont === "JetBrains Mono"
                    ? fonts.mono
                    : draft().editorFont
                }
                fontSize={scaledFontSize(draft().fontSize)}
                lineHeight={editorLineHeight(scaledFontSize(draft().fontSize))}
                softWrap
                scrollBeyondLastLine={false}
                class="flex-1 min-h-0 bg-workspace text-foreground"
              />
            </View>
          ) : (
            <Scroll
              testID="settings-scroll"
              class="flex-1 min-h-0"
              contentStyle={{ padding: narrow() ? 12 : 18, gap: 16 }}
            >
              {startup() && (
                <Section
                  title={t("settings.clientExperience")}
                  caption={t("settings.startupCaption")}
                  color={token("primary")}
                >
                  {field("general", "language") && (
                    <SettingRow
                      title={t("settings.language")}
                      description={t("settings.languageDescription")}
                    >
                      {select(
                        "language",
                        [
                          { value: "system", title: t("language.system") },
                          { value: "zh-CN", title: "简体中文" },
                          { value: "en", title: "English" },
                        ],
                        "min-w-40",
                      )}
                    </SettingRow>
                  )}
                  {(
                    ["autoReconnect", "restoreTabs", "confirmExit"] as const
                  ).map(
                    (key) =>
                      field("general", key) && (
                        <SettingRow
                          title={t(`settings.${key}`)}
                          description={t(`settings.${key}Description`)}
                          badge={
                            key === "confirmExit"
                              ? t("settings.safetyBadge")
                              : undefined
                          }
                        >
                          {checkbox(key)}
                        </SettingRow>
                      ),
                  )}
                </Section>
              )}
              {appearance() && (
                <Section
                  title={t("settings.appearance")}
                  caption={t("settings.appearanceCaption")}
                  color={token("steel")}
                >
                  {field("appearance", "theme") && (
                    <View class="gap-3 py-2">
                      <Text class="text-(--text-size-13) font-medium text-foreground">
                        {t("settings.theme")}
                      </Text>
                      <View
                        style={{
                          flexDirection:
                            windowSize().width < 630 ? "column" : "row",
                          gap: 10,
                        }}
                      >
                        {(["dark", "light", "system"] as const).map((theme) => (
                          <ThemeCard
                            theme={theme}
                            selected={draft().theme === theme}
                            onPress={() => update("theme", theme)}
                          />
                        ))}
                      </View>
                    </View>
                  )}
                  {field("appearance", "uiFontScale") && (
                    <SettingRow
                      title={t("settings.uiFontScale")}
                      description={t("settings.uiFontScaleDescription")}
                    >
                      <PreferencesSelect
                        id="settings-uiFontScale"
                        label={t("settings.uiFontScale")}
                        value={String(draft().uiFontScale)}
                        items={fontScaleOptions.map((scale) => ({
                          value: String(scale),
                          title: `${scale}%`,
                        }))}
                        onChange={(value) =>
                          update("uiFontScale", Number(value))
                        }
                      />
                    </SettingRow>
                  )}
                  {field("appearance", "editorFont") && (
                    <SettingRow
                      title={t("settings.editorFont")}
                      description={t("settings.editorFontDescription")}
                    >
                      <Input
                        testID="settings-editorFont"
                        accessibilityLabel={t("settings.editorFont")}
                        value={draft().editorFont}
                        onChange={({ value }) => update("editorFont", value)}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={200}
                        style={{ width: windowSize().width < 800 ? 160 : 224 }}
                        class="h-9 rounded border border-border bg-inset px-3 text-(--text-size-12)/(--line-height-16) text-foreground font-mono"
                      />
                    </SettingRow>
                  )}
                  {field("appearance", "fontSize") && (
                    <View class="gap-1 py-3">
                      <View class="flex-row justify-between">
                        <Text class="text-(--text-size-13) font-medium text-foreground">
                          {t("settings.fontSize")}
                        </Text>
                        <Text
                          testID="settings-font-size-label"
                          class="text-(--text-size-12)/(--line-height-16) font-mono text-primary"
                        >{`${draft().fontSize}px`}</Text>
                      </View>
                      <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                        {t("settings.fontSizeDescription")}
                      </Text>
                      <View class="flex-row items-center gap-3">
                        <Text class="text-(--text-size-10) font-mono text-faint">
                          11px
                        </Text>
                        <Slider
                          testID="settings-editor-font-size"
                          accessibilityLabel={t("settings.fontSize")}
                          value={draft().fontSize}
                          min={11}
                          max={18}
                          step={1}
                          onChange={({ value }) => {
                            if (typeof value === "number")
                              update("fontSize", value);
                          }}
                          class="flex-1"
                          trackClass="h-8 justify-center"
                          indicatorClass="h-1 rounded-full bg-border"
                          rangeClass="rounded-full bg-primary"
                          thumbClass="w-3 h-3 rounded-full bg-primary focus:ring-2 focus:ring-ring"
                        />
                        <Text class="text-(--text-size-10) font-mono text-faint">
                          18px
                        </Text>
                      </View>
                    </View>
                  )}
                  {(field("appearance", "fontSize") ||
                    field("appearance", "editorFont")) && (
                    <View class="rounded border border-border bg-workspace px-3 py-2 gap-1">
                      <Text class="text-(--text-size-9) text-faint">
                        {t("settings.fontPreview")}
                      </Text>
                      <Text
                        style={{
                          fontFamily:
                            draft().editorFont === "JetBrains Mono"
                              ? fonts.mono
                              : draft().editorFont,
                          fontSize: scaledFontSize(draft().fontSize),
                          lineHeight: editorLineHeight(
                            scaledFontSize(draft().fontSize),
                          ),
                          color: token("steel"),
                        }}
                      >
                        {'{ "key": "users:session", "ttl": 3600 }'}
                      </Text>
                    </View>
                  )}
                </Section>
              )}
              {browser() && (
                <Section
                  title={t("settings.keyBrowser")}
                  caption={t("settings.browserCaption")}
                  color={token("success")}
                >
                  {field("browser", "keyTabMode") && (
                    <SettingRow
                      title={t("settings.keyTabMode")}
                      description={t("settings.keyTabModeDescription")}
                    >
                      {select(
                        "keyTabMode",
                        [
                          { value: "new", title: t("settings.keyTabModeNew") },
                          { value: "replace", title: t("settings.keyTabModeReplace") },
                        ],
                        "min-w-44",
                      )}
                    </SettingRow>
                  )}
                  {field("browser", "scanCount") && (
                    <SettingRow
                      title={t("settings.scanCount")}
                      description={t("settings.scanCountDescription")}
                    >
                      <View class="flex-row items-center gap-2">
                        <Input
                          testID="settings-scanCount"
                          accessibilityLabel={t("settings.scanCount")}
                          value={String(draft().scanCount)}
                          keyboardType="number-pad"
                          onChange={({ value }) =>
                            update("scanCount", Number(value))
                          }
                          class="w-24 h-9 rounded border border-border bg-inset px-3 text-(--text-size-12)/(--line-height-16) text-foreground font-mono"
                        />
                        <Text class="text-(--text-size-10) font-mono text-faint">
                          COUNT
                        </Text>
                      </View>
                    </SettingRow>
                  )}
                  {field("formatting", "formatter") && (
                    <SettingRow
                      title={t("settings.formatter")}
                      description={t("settings.formatterDescription")}
                    >
                      {select(
                        "formatter",
                        ["auto", "json", "raw", "hex"].map((value) => ({
                          value,
                          title: t(`settings.format.${value}`),
                        })),
                      )}
                    </SettingRow>
                  )}
                </Section>
              )}
              {credentialSection() && (
                <Section
                  title={t("credentials.title")}
                  caption={t("credentials.caption")}
                  color={token("primary")}
                >
                  <CredentialSettingsSection state={credentials} />
                </Section>
              )}
              {category() === "shortcuts" && (
                <Section
                  title={t("settings.categories.shortcuts")}
                  caption=""
                  color={token("steel")}
                >
                  {[
                    ["openSettings", "mod+,"],
                    ["search", "mod+f"],
                    ["save", "mod+s"],
                  ].map(([key, command]) => (
                    <View class="flex-row items-center justify-between py-4 border-b border-border/40">
                      <Text class="text-(--text-size-14)/(--line-height-20) text-foreground">
                        {t(`settings.${key}`)}
                      </Text>
                      <Text class="rounded bg-panel border border-border px-2 py-1 text-(--text-size-12)/(--line-height-16) font-mono text-muted-foreground">
                        {keymap.label(command)}
                      </Text>
                    </View>
                  ))}
                </Section>
              )}
              {noMatches() && (
                <View class="items-center justify-center gap-3 py-16">
                  <Icon name="search" size={28} />
                  <Text class="text-(--text-size-14)/(--line-height-20) text-muted-foreground">
                    {t("settings.noResults")}
                  </Text>
                  <Action
                    label={t("settings.clearSearch")}
                    onPress={() => {
                      query.set("");
                      category.set("general");
                    }}
                  />
                </View>
              )}
            </Scroll>
          )}
          <View class="shrink-0 flex-row flex-wrap items-center gap-2 border-t border-border px-3 py-2">
            <Action
              testID="settings-reset"
              label={t("settings.reset")}
              icon="refresh"
              compact
              onPress={reset}
            />
            <Action
              testID="settings-export"
              label={t("settings.export")}
              icon="copy"
              compact
              onPress={() => {
                void exportJson();
              }}
            />
            {narrow() && (
              <Action
                label={t(
                  mode() === "json" ? "settings.editForm" : "settings.editJson",
                )}
                icon="braces"
                compact
                onPress={toggleJson}
              />
            )}
            <View class="flex-1" />
            {!narrow() && (
              <Text class="text-(--text-size-10) text-faint">
                {t(dirty() ? "settings.unsaved" : "settings.upToDate")}
              </Text>
            )}
            <Action
              testID="settings-cancel"
              label={t("settings.cancel")}
              compact
              disabled={applying()}
              onPress={cancel}
            />
            <Action
              testID="settings-save"
              label={t(applying() ? "settings.saving" : "settings.save")}
              icon="check"
              primary
              compact
              disabled={!dirty() || applying() || props.preferences.loading()}
              onPress={() => {
                void save();
              }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
