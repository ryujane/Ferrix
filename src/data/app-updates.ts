import { appInfo, cleanup, locale, openUrl, platform, signal, Storage } from "nsh";
import {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  downloadUpdate,
  installAndRestart,
  restartToPackage,
  shellInfo,
  type AppUpdate,
  type PackageUpdate,
} from "nsh/updater";
import { projectLinks } from "./project-links";

type UpdateOffer =
  | (AppUpdate & { kind: "app" })
  | (PackageUpdate & { kind: "package"; canInstall: true });

type OfferPhase =
  | "available"
  | "skipped"
  | "skipping"
  | "skipFailed"
  | "downloaded"
  | "installing"
  | "installFailed"
  | "opening"
  | "downloadFailed"
  | "downloadAndOpenFailed"
  | "openFailed";

type UpdateState =
  | { phase: "idle" | "unavailable" | "checking" | "current" | "checkFailed" }
  | { phase: OfferPhase; update: UpdateOffer }
  | { phase: "downloading"; update: UpdateOffer; progress?: number };

const nativeUpdater = {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  downloadUpdate,
  restartToPackage,
  installAndRestart,
  openUrl,
};
const skippedVersionKey = "ferrix.skipped-update-version";

function releasePage(downloadUrl: string) {
  const url = new URL(downloadUrl);
  if (url.origin !== "https://github.com") return downloadUrl;
  const asset = url.pathname.match(
    /^(\/[^/]+\/[^/]+\/releases)\/(?:latest\/download|download\/([^/]+))\/[^/]+$/,
  );
  if (!asset) return downloadUrl;
  const [, releases, tag] = asset;
  return `${url.origin}${releases}/${tag ? `tag/${tag}` : "latest"}`;
}

export function createAppUpdates(
  onReadyToInstall: () => void,
  api = nativeUpdater,
  supported = platform.desktop && !appInfo().development && !!shellInfo().version,
) {
  const state = signal<UpdateState>({ phase: supported ? "idle" : "unavailable" });
  const promptOpen = signal(false);
  let disposed = false;
  let installAfterDownload = false;
  cleanup(() => {
    disposed = true;
  });

  const canCheck = () =>
    supported &&
    !["checking", "downloading", "downloaded", "opening", "skipping", "installing"].includes(
      state().phase,
    );

  async function findUpdate(): Promise<UpdateOffer | null> {
    const options = { locale: locale() };
    let packageError: unknown;
    const packageUpdate = await api.checkForPackage(options).catch((cause) => {
      packageError = cause;
      return null;
    });
    if (packageUpdate)
      return { ...packageUpdate, kind: "package", canInstall: true };
    if (disposed) return null;
    const appUpdate = await api.checkForUpdate(options);
    if (appUpdate) return { ...appUpdate, kind: "app" };
    if (packageError !== undefined) throw packageError;
    return null;
  }

  async function check(startup = false) {
    if (!canCheck()) return;
    state.set({ phase: "checking" });
    try {
      const [update, skipped] = await Promise.all([
        findUpdate(),
        Storage.getItem(skippedVersionKey).catch(() => null),
      ]);
      if (disposed) return;
      if (!update) {
        state.set({ phase: "current" });
        return;
      }
      const wasSkipped = skipped === update.version;
      state.set({ phase: wasSkipped ? "skipped" : "available", update });
      if (startup && !wasSkipped) promptOpen.set(true);
    } catch {
      if (!disposed) state.set({ phase: "checkFailed" });
    }
  }

  function dismissPrompt() {
    installAfterDownload = false;
    promptOpen.set(false);
  }

  async function skip() {
    const value = state();
    if (!("update" in value) || !canSkip()) return;
    const { update } = value;
    state.set({ phase: "skipping", update });
    try {
      await Storage.setItem(skippedVersionKey, update.version);
      if (disposed) return;
      state.set({ phase: "skipped", update });
      dismissPrompt();
    } catch {
      if (!disposed) state.set({ phase: "skipFailed", update });
    }
  }

  async function visitRelease(update: UpdateOffer, afterDownloadFailure: boolean) {
    state.set({ phase: "opening", update });
    let opened = false;
    try {
      const url = update.kind === "package"
        ? projectLinks.releases
        : releasePage(update.url);
      opened = (await api.openUrl(url)).opened;
    } catch {
      // The offer retains a browser action if the system could not open it.
    }
    if (disposed) return;
    const phase = afterDownloadFailure
      ? opened ? "downloadFailed" : "downloadAndOpenFailed"
      : opened ? "available" : "openFailed";
    state.set({ phase, update });
  }

  const canApply = () =>
    [
      "available", "skipped", "skipFailed", "downloaded", "installFailed",
      "downloadFailed", "downloadAndOpenFailed", "openFailed",
    ].includes(state().phase);
  const canSkip = () => {
    const value = state();
    if (!("update" in value) || !canApply() || value.phase === "skipped") return false;
    // A downloaded OTA package is already staged for the next launch.
    return value.update.kind === "app" ||
      (value.phase !== "downloaded" && value.phase !== "installFailed");
  };

  async function apply() {
    const value = state();
    if (!("update" in value) || !canApply()) return;
    const { update } = value;
    if (!update.canInstall) {
      await visitRelease(update, false);
      return;
    }
    if (value.phase === "downloaded" || value.phase === "installFailed") {
      onReadyToInstall();
      return;
    }

    installAfterDownload = true;
    state.set({ phase: "downloading", update });
    try {
      const download = update.kind === "package"
        ? api.downloadPackage
        : api.downloadUpdate;
      await download(({ received, total }) => {
        const current = state();
        if (!disposed && current.phase === "downloading" && total && total > 0) {
          const progress = Math.min(100, Math.floor((received / total) * 100));
          if (current.progress !== progress)
            state.set({ phase: "downloading", update, progress });
        }
      });
    } catch {
      if (!disposed) await visitRelease(update, true);
      return;
    }
    if (disposed) return;
    state.set({ phase: "downloaded", update });
    if (installAfterDownload) onReadyToInstall();
  }

  async function install(flushWorkspace: () => Promise<void>) {
    const value = state();
    if (value.phase !== "downloaded" && value.phase !== "installFailed") return;
    const { update } = value;
    state.set({ phase: "installing", update });
    try {
      await flushWorkspace();
      if (disposed) return;
      if (update.kind === "package") await api.restartToPackage();
      else await api.installAndRestart();
    } catch {
      if (!disposed) state.set({ phase: "installFailed", update });
    }
  }

  async function openRelease() {
    const value = state();
    if (value.phase !== "downloadFailed" && value.phase !== "downloadAndOpenFailed") return;
    await visitRelease(value.update, true);
  }

  void check(true);
  return {
    state: () => state(),
    promptOpen: () => promptOpen(),
    dismissPrompt,
    canCheck,
    canApply,
    canSkip,
    check: () => check(),
    skip,
    apply,
    install,
    openRelease,
  };
}

export type AppUpdates = ReturnType<typeof createAppUpdates>;
