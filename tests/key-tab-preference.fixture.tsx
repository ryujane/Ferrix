import { mount, signal, Text, View } from "nsh";
import { setLocale } from "nsh/i18n";
import { Action } from "../src/components/action";
import { ToastProvider, useToast } from "../src/components/toast";
import {
  defaultPreferences,
  type PreferenceSettings,
  type Preferences,
} from "../src/data/preferences";
import type { LanguageSettings } from "../src/i18n";
import { SettingsPage } from "../src/pages/settings/settings-page";
import {
  createWorkspaceState,
  type WorkspaceSession,
} from "../src/pages/workspace/workspace-state";
import { encode } from "../src/pages/workspace/workspace-values";

function Fixture() {
  setLocale("en");
  const saved = signal<Preferences>({ ...defaultPreferences });
  const save: PreferenceSettings["save"] = async (next) => {
    saved.set(next);
    return true;
  };
  const preferences: PreferenceSettings = {
    value: saved,
    loading: () => false,
    saving: () => false,
    error: () => undefined,
    save,
    setTheme: (theme) => save({ ...saved(), theme }),
  };
  const language: LanguageSettings = {
    preference: () => "en",
    error: () => undefined,
    select: async () => true,
  };
  const session = {
    getInfo: () => ({ database: 0, generation: "1", closed: false }),
    getKeyInfo: async () => ({ exists: true, type: "string" }),
    readStringRange: async () => ({
      exists: true,
      value: encode("value"),
      length: "5",
      expiration: "persistent",
    }),
  } as unknown as WorkspaceSession;
  const state = createWorkspaceState(session, useToast(), preferences.value);

  return (
    <View class="flex-1 min-h-0 bg-workspace">
      <View class="flex-row">
        {["alpha", "beta", "gamma", "delta"].map((key) => (
          <Action
            label={`Open ${key}`}
            onPress={() => void state.openKey(encode(key))}
          />
        ))}
        <Action label="Edit value" onPress={() => state.edit("draft")} />
      </View>
      <Text>{`Tabs ${state.tabs().map((tab) => tab.name).join(", ")}`}</Text>
      <Text>{`Active ${state.active()?.name ?? ""}`}</Text>
      <Text>{`Value ${state.active()?.value ?? ""}`}</Text>
      <SettingsPage preferences={preferences} language={language} />
    </View>
  );
}

mount(() => <ToastProvider><Fixture /></ToastProvider>);
