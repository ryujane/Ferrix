import { cleanup, effect, keymap, platform, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { Application as DesktopApplication, currentWindow, isAvailable } from "nsh/desktop";
import { TitleBar } from "./components/title-bar";
import { Nav, type NavigationId } from "./components/nav";
import { createLanguageSettings, t } from "./i18n";
import { createPreferences } from "./data/preferences";
import { createAppUpdates } from "./data/app-updates";
import { createWorkspaceHistory } from "./data/workspace-history";
import { SettingsPage } from "./pages/settings/settings-page";
import { HelpPage } from "./pages/help/help-page";
import { createCredentialSettings } from "./data/credential-settings";
import { createConnectionHub } from "./data/connections/connection-state";
import { ConnectionHubPage } from "./pages/connections/connection-hub-page";
import {
  ConnectedWorkspace,
  type WorkspaceKeyTarget,
} from "./pages/workspace/connected-workspace";
import { ToastProvider, useToast } from "./components/toast";
import { Action } from "./components/action";
import { Modal } from "./components/modal";
import { UpdatePrompt } from "./components/update-prompt";
import { PubSubPage } from "./pages/pubsub/pubsub-page";
import { MonitoringPage } from "./pages/monitoring/monitoring-page";

export function App() {
  return (
    <ToastProvider>
      <Application />
    </ToastProvider>
  );
}

function Application() {
  const language = createLanguageSettings();
  const preferences = createPreferences();
  const toast = useToast();
  const updates = createAppUpdates(requestUpdateInstall);
  const history = createWorkspaceHistory(() =>
    toast.error(t("settings.workspaceHistoryError")),
  );
  const connections = createConnectionHub();
  const credentials = createCredentialSettings(connections.credentialsChanged);
  const navigation = createNavStack<NavigationId>(["connections"]);
  const pubsubVisited = signal(false);
  const monitoringVisited = signal(false);
  const keyTarget = signal<WorkspaceKeyTarget>();
  const quitConfirm = signal<"quit" | "update">();
  const page = () => navigation.routes()[0];
  function navigate(next: NavigationId) {
    if (page() === next) return;
    if (next === "pubsub") pubsubVisited.set(true);
    if (next === "overview") monitoringVisited.set(true);
    navigation.replace(next);
  }
  let startupHandled = false;
  effect(() => {
    if (startupHandled || !history.ready() || preferences.loading()) return;
    if (
      !preferences.value().autoReconnect ||
      connections.activeId() ||
      connections.connecting().length
    ) {
      startupHandled = true;
      return;
    }
    if (!credentials.available() || credentials.busy() || !connections.available()) return;
    const status = credentials.status();
    if (status.provider === "keepass" && !status.keepassUnlocked) return;
    startupHandled = true;
    const last = connections.data().connections.find(
      (item) => item.id === history.lastConnection(),
    );
    if (last) {
      const stillWanted = () => !connections.activeId() &&
        connections.connecting().every((id) => id === last.id);
      void connections.connect(last, stillWanted).then((connected) => {
        if (connected && page() === "connections" && connections.activeId() === last.id)
          navigate("keys");
      });
    }
  });
  let usedConnection = false;
  effect(() => {
    if (!history.ready()) return;
    const active = connections.activeId();
    if (active !== undefined) usedConnection = true;
    if (usedConnection) history.setLastConnection(active);
    if (!preferences.loading() && !preferences.value().restoreTabs)
      history.clearWorkspaces();
  });
  const operations = new Set<() => boolean>();
  function registerOperation(running: () => boolean) {
    operations.add(running);
    return () => { operations.delete(running); };
  }
  let quitting = false;
  const needsExitConfirmation = () =>
    preferences.value().confirmExit && [...operations].some((running) => running());
  function quit() {
    if (quitting) return;
    quitting = true;
    quitConfirm.set(undefined);
    void history.flush().finally(() => DesktopApplication.quit());
  }
  function cancelQuit() {
    quitConfirm.set(undefined);
    DesktopApplication.cancelQuitRequest();
  }
  function acceptQuit() {
    const reason = quitConfirm();
    quitConfirm.set(undefined);
    if (reason === "update") void updates.install(history.flush);
    else if (reason === "quit") quit();
  }
  function requestQuit() {
    if (quitConfirm() === "update" || updates.state().phase === "installing") {
      DesktopApplication.cancelQuitRequest();
      return;
    }
    if (needsExitConfirmation()) quitConfirm.set("quit");
    else quit();
  }
  function requestUpdateInstall() {
    if (quitting || quitConfirm()) return;
    if (needsExitConfirmation()) quitConfirm.set("update");
    else void updates.install(history.flush);
  }
  if (isAvailable) {
    cleanup(DesktopApplication.on("quitRequest", requestQuit));
    if (platform.os === "macos") {
      DesktopApplication.setQuitRequestOptions({ mainWindowClose: true });
    } else if (platform.os === "linux" || platform.os === "windows") {
      const window = currentWindow();
      window.set({ closeOnPress: false });
      cleanup(window.on("closePress", requestQuit));
      cleanup(() => window.set({ closeOnPress: true }));
    }
    cleanup(DesktopApplication.on("quit", history.flush));
  }
  keymap.bind("mod+,", () => navigate("settings"));
  return (
    <View class="flex-1 bg-chrome font-sans text-(--text-size-14)">
      <TitleBar
        onThemeChange={(theme) => {
          void preferences.setTheme(theme);
        }}
      />
      <View class="flex-1 min-h-0 flex-row">
        <Nav selected={page()} onSelect={navigate} />
        <View
          testID="main-content"
          class="flex-1 min-w-0 min-h-0 rounded-t-xl rounded-bl-xl overflow-hidden bg-workspace"
        >
          <View
            class={`flex-1 min-w-0 min-h-0 ${page() === "keys" || page() === "console" ? "flex" : "hidden"}`}
          >
            <ConnectedWorkspace
              hub={connections}
              preferences={preferences.value}
              preferencesReady={() => !preferences.loading()}
              history={history}
              registerOperation={registerOperation}
              active={page() === "keys" || page() === "console"}
              showConsole={page() === "console" ? true : undefined}
              consoleFullscreen={page() === "console"}
              onConsoleChange={(show) => {
                if (!show && page() === "console") navigate("keys");
              }}
              onConnections={() => navigate("connections")}
              keyTarget={keyTarget()}
              onKeyTargetHandled={(target) => {
                if (keyTarget() === target) keyTarget.set(undefined);
              }}
            />
          </View>
          {pubsubVisited() && (
            <View
              class={`flex-1 min-w-0 min-h-0 ${page() === "pubsub" ? "flex" : "hidden"}`}
            >
              <PubSubPage
                hub={connections}
                active={page() === "pubsub"}
                onConnections={() => navigate("connections")}
              />
            </View>
          )}
          {monitoringVisited() && (
            <View
              class={`flex-1 min-w-0 min-h-0 ${page() === "overview" ? "flex" : "hidden"}`}
            >
              <MonitoringPage
                hub={connections}
                active={page() === "overview"}
                onConnections={() => navigate("connections")}
                onOpenKey={(connectionId, database, key) => {
                  const live = connections
                    .live()
                    .find((item) => item.id === connectionId);
                  if (!live || live.session.getInfo().closed) return;
                  connections.activeId.set(connectionId);
                  keyTarget.set({ session: live.session, database, key });
                  navigate("keys");
                }}
              />
            </View>
          )}
          <NavStack
            state={navigation}
            testID="page-content"
            class={`flex-1 min-w-0 min-h-0 ${page() === "keys" || page() === "console" || page() === "pubsub" || page() === "overview" ? "hidden" : "flex"}`}
          >
            {(route) => (
              <NavPage
                title={t(`navigation.${route}`)}
                headerVisible={false}
                animation="none"
                class="flex-1 min-w-0 min-h-0 bg-workspace"
              >
                {route === "connections" ? (
                  <ConnectionHubPage
                    hub={connections}
                    onOpenWorkspace={() => navigate("keys")}
                  />
                ) : route === "keys" ||
                  route === "console" ||
                  route === "pubsub" ||
                  route === "overview" ? null : route === "settings" ? (
                  <SettingsPage
                    preferences={preferences}
                    language={language}
                    credentials={credentials}
                  />
                ) : route === "help" ? (
                  <HelpPage updates={updates} />
                ) : (
                  <View class="flex-1 p-4">
                    <Text class="text-foreground">{t("app.hello")}</Text>
                  </View>
                )}
              </NavPage>
            )}
          </NavStack>
        </View>
      </View>
      <If when={updates.promptOpen() && !quitConfirm()}>
        <UpdatePrompt updates={updates} />
      </If>
      <If when={quitConfirm()}>
        <Modal
          id="quit-confirm"
          title={t("settings.quitTitle")}
          description={t(quitConfirm() === "update" ? "updates.restartDescription" : "settings.quitDescription")}
          width={460}
          height={174}
          alert
          onClose={cancelQuit}
        >
          <View class="flex-1 flex-row items-end justify-end gap-2 px-8 pb-5">
            <Action testID="quit-cancel" label={t("settings.cancel")} onPress={cancelQuit} />
            <Action
              testID="quit-accept"
              label={t(quitConfirm() === "update" ? "updates.restart" : "settings.quitConfirm")}
              primary
              onPress={acceptQuit}
            />
          </View>
        </Modal>
      </If>
    </View>
  );
}
