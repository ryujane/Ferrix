import { signal } from "nsh";
import { CredentialSettings } from "ferrix/native";
export type CredentialProvider = "native" | "keepass";
export type CredentialStatus = {
  provider: CredentialProvider;
  keepassExists: boolean;
  keepassUnlocked: boolean;
  filePath: string;
};
export type CredentialApi = typeof CredentialSettings;
export function createCredentialSettings(
  onChanged?: () => void | Promise<void>,
  api: CredentialApi = CredentialSettings,
) {
  const status = signal<CredentialStatus>({
    provider: "native",
    keepassExists: false,
    keepassUnlocked: false,
    filePath: "",
  });
  const loading = signal(true),
    busy = signal(false),
    available = signal(false),
    error = signal<unknown>(),
    message = signal("");
  function apply(text: string) {
    const value = JSON.parse(text) as CredentialStatus;
    if (
      !["native", "keepass"].includes(value.provider) ||
      typeof value.keepassExists !== "boolean" ||
      typeof value.keepassUnlocked !== "boolean" ||
      typeof value.filePath !== "string"
    )
      throw new Error("Invalid credential status");
    status.set(value);
    available.set(true);
  }
  async function refresh() {
    loading.set(true);
    error.set(undefined);
    try {
      apply(await api.getStatus());
    } catch (cause) {
      error.set(cause);
      available.set(false);
    } finally {
      loading.set(false);
    }
  }
  async function run(action: () => Promise<string>, notice: string) {
    if (busy()) return false;
    busy.set(true);
    error.set(undefined);
    message.set("");
    try {
      apply(await action());
      await onChanged?.();
      message.set(notice);
      return true;
    } catch (cause) {
      error.set(cause);
      try {
        apply(await api.getStatus());
      } catch {}
      return false;
    } finally {
      busy.set(false);
    }
  }
  void refresh();
  return {
    status,
    loading,
    busy,
    available,
    error,
    message,
    refresh,
    useKeePass: (master: string, confirmation?: string) =>
      run(() => api.useKeepass(master, confirmation), "saved"),
    useNative: (master?: string) => run(() => api.useNative(master), "saved"),
    unlock: (master: string) => run(() => api.unlock(master), "unlocked"),
    lock: () => run(() => api.lock(), "locked"),
    changeMaster: (current: string, next: string, confirmation: string) =>
      run(
        () => api.changeMasterPassword(current, next, confirmation),
        "passwordChanged",
      ),
  };
}
export type CredentialConfiguration = ReturnType<
  typeof createCredentialSettings
>;
