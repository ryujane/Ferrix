import { signal, Storage } from "nsh";
import { setLocale, t } from "nsh/i18n";

export { t } from "nsh/i18n";

export type LanguagePreference = "system" | "zh-CN" | "en";
const storageKey = "ferrix.language";

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "zh-CN" || value === "en";
}

// One owner per app surface; the native locale drives all translated bindings.
export function createLanguageSettings() {
  const preference = signal<LanguagePreference>("system");
  const error = signal<"language.loadError" | "language.saveError">();
  let revision = 0;

  function apply(value: LanguagePreference) {
    preference.set(value);
    setLocale(value === "system" ? null : value);
  }

  async function restore() {
    try {
      const stored = await Storage.getItem(storageKey);
      // A choice made while storage was loading always wins.
      if (revision === 0 && isLanguagePreference(stored)) apply(stored);
    } catch {
      if (revision === 0) error.set("language.loadError");
    }
  }

  async function select(value: string | null) {
    if (!isLanguagePreference(value)) return false;
    const current = ++revision;
    apply(value);
    error.set(undefined);
    try {
      if (value === "system") await Storage.removeItem(storageKey);
      else await Storage.setItem(storageKey, value);
      return true;
    } catch {
      if (revision === current) error.set("language.saveError");
      return false;
    }
  }

  void restore();
  return { preference: () => preference(), error: () => error(), select };
}

export type LanguageSettings = ReturnType<typeof createLanguageSettings>;

export const hubT = (key: string, values?: Record<string, unknown>) =>
  t(`hub.${key}`, values);
