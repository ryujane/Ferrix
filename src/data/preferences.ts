import { setColorScheme, signal, Storage } from "nsh";
import { applyTypography, defaultEditorFontSize } from "../fonts";
import type { LanguagePreference } from "../i18n";

export type ThemePreference = "dark" | "light" | "system";
export type ValueFormatter = "auto" | "json" | "raw" | "hex";
export interface Preferences {
  theme: ThemePreference;
  editorFont: string;
  fontSize: number;
  uiFontScale: number;
  scanCount: number;
  keyTabMode: "new" | "replace";
  formatter: ValueFormatter;
  autoReconnect: boolean;
  restoreTabs: boolean;
  confirmExit: boolean;
}
export type PreferencesDocument = Preferences & {
  version: 1;
  language: LanguagePreference;
};

export const fontScaleOptions = [90, 100, 110, 120, 125] as const;

export const defaultPreferences: Readonly<Preferences> = {
  theme: "dark",
  editorFont: "JetBrains Mono",
  fontSize: defaultEditorFontSize,
  uiFontScale: 100,
  scanCount: 3000,
  keyTabMode: "new",
  formatter: "auto",
  autoReconnect: false,
  restoreTabs: false,
  confirmExit: true,
};

// Validate both stored preferences and the JSON editor before applying anything.
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("settings.invalidJson");
  const p = value as Record<string, unknown>;
  if (
    typeof p.theme !== "string" ||
    !["dark", "light", "system"].includes(p.theme)
  )
    throw new Error("settings.invalidTheme");
  if (
    typeof p.editorFont !== "string" ||
    !p.editorFont.trim() ||
    p.editorFont.length > 200
  )
    throw new Error("settings.invalidFont");
  if (
    typeof p.fontSize !== "number" ||
    !Number.isInteger(p.fontSize) ||
    p.fontSize < 11 ||
    p.fontSize > 18
  )
    throw new Error("settings.invalidFontSize");
  const uiFontScale =
    p.uiFontScale === undefined ? defaultPreferences.uiFontScale : p.uiFontScale;
  if (
    typeof uiFontScale !== "number" ||
    !fontScaleOptions.some((option) => option === uiFontScale)
  )
    throw new Error("settings.invalidUiFontScale");
  if (
    typeof p.scanCount !== "number" ||
    !Number.isInteger(p.scanCount) ||
    p.scanCount < 100 ||
    p.scanCount > 10000
  )
    throw new Error("settings.invalidScanCount");
  const keyTabMode =
    p.keyTabMode === undefined ? defaultPreferences.keyTabMode : p.keyTabMode;
  if (keyTabMode !== "new" && keyTabMode !== "replace")
    throw new Error("settings.invalidKeyTabMode");
  if (
    typeof p.formatter !== "string" ||
    !["auto", "json", "raw", "hex"].includes(p.formatter)
  )
    throw new Error("settings.invalidFormatter");
  for (const key of ["autoReconnect", "restoreTabs", "confirmExit"]) {
    if (typeof p[key] !== "boolean") throw new Error("settings.invalidBoolean");
  }
  return {
    theme: p.theme as ThemePreference,
    editorFont: p.editorFont.trim(),
    fontSize: p.fontSize,
    uiFontScale,
    scanCount: p.scanCount,
    keyTabMode,
    formatter: p.formatter as ValueFormatter,
    autoReconnect: p.autoReconnect as boolean,
    restoreTabs: p.restoreTabs as boolean,
    confirmExit: p.confirmExit as boolean,
  };
}

export function parsePreferencesDocument(text: string): PreferencesDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("settings.invalidJson");
  }
  const p = value as Partial<PreferencesDocument> | null;
  if (!p || p.version !== 1) throw new Error("settings.invalidVersion");
  if (
    typeof p.language !== "string" ||
    !["system", "zh-CN", "en"].includes(p.language)
  )
    throw new Error("settings.invalidLanguage");
  return { version: 1, language: p.language!, ...parsePreferences(p) };
}

export function createPreferences() {
  const value = signal<Preferences>({ ...defaultPreferences });
  const loading = signal(true),
    saving = signal(false);
  const error = signal<string>();
  let revision = 0;
  const storageKey = "ferrix.preferences";

  function apply(next: Preferences) {
    const previous = value();
    if (
      next.uiFontScale !== previous.uiFontScale ||
      next.fontSize !== previous.fontSize
    )
      applyTypography(next.uiFontScale, next.fontSize);
    value.set(next);
    setColorScheme(next.theme);
  }

  async function restore() {
    try {
      const text = await Storage.getItem(storageKey);
      if (text && revision === 0) {
        const stored = JSON.parse(text);
        if (stored.version !== 1) throw new Error("settings.invalidVersion");
        apply(parsePreferences(stored));
      }
    } catch {
      if (revision === 0) error.set("settings.loadError");
    } finally {
      loading.set(false);
    }
  }

  async function save(next: Preferences): Promise<boolean> {
    if (saving()) return false;
    ++revision;
    saving.set(true);
    error.set(undefined);
    try {
      const validated = parsePreferences(next);
      await Storage.setItem(
        storageKey,
        JSON.stringify({ version: 1, ...validated }),
      );
      apply(validated);
      return true;
    } catch (cause) {
      const key =
        cause instanceof Error && cause.message.startsWith("settings.invalid")
          ? cause.message
          : "settings.saveError";
      error.set(key);
      return false;
    } finally {
      saving.set(false);
    }
  }

  void restore();
  return {
    value: () => value(),
    loading: () => loading(),
    saving: () => saving(),
    error: () => error(),
    save,
    setTheme: (theme: ThemePreference) => save({ ...value(), theme }),
  };
}

export type PreferenceSettings = ReturnType<typeof createPreferences>;
