import { cleanup, signal, Scroll, Text, token, View } from "nsh";
import { AlertDialog, Input, Popover, Switch } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import {
  copyConnection,
  defaultKeySeparator,
  newNode,
  newNetworkProxy,
  validateConnection,
  type Config,
  type SavedConnection,
  type Tls,
  type Node,
} from "../../data/connections/connection-model";
import { hubT } from "../../i18n";
import { safeError } from "../../utils/errors";
import {
  probeSshHostKey,
  sshGateway,
  testConnection,
} from "../../data/connections/connection-client";
import type { ConnectionHub } from "../../data/connections/connection-state";
import {
  Choice,
  ErrorText,
  Field,
  Hint,
  Segments,
} from "../../components/form-controls";
import { HubAction, Modal } from "./hub-controls";
import { OrganizationFields } from "./organization-fields";

export function ConnectionDialog(props: {
  hub: ConnectionHub;
  value: SavedConnection;
  editing: boolean;
  onClose: () => void;
  onConnected: () => void;
  onSaved: (id: string) => void;
}) {
  const draft = signal(copyConnection(props.value)),
    mode = signal(props.value.config.mode),
    tab = signal("connection"),
    error = signal(""),
    test = signal(""),
    sshKeyMismatch = signal(false),
    testing = signal(false),
    saving = signal(false);
  let trustedGateway = sshGateway(props.value.config.ssh);
  const isTrustedGateway = (gateway: ReturnType<typeof sshGateway>) =>
    gateway.host.toLowerCase() === trustedGateway.host.toLowerCase() &&
    gateway.port === trustedGateway.port;
  let revision = 0,
    closed = false;
  cleanup(() => {
    closed = true;
    ++revision;
  });
  const patch = (value: Partial<SavedConnection>) => {
    draft.set({ ...draft(), ...value });
    ++revision;
    test.set("");
    sshKeyMismatch.set(false);
    error.set("");
  };
  const config = (value: Partial<Config>) => {
    if (value.mode) mode.set(value.mode);
    patch({ config: { ...draft().config, ...value } });
  };
  const proxy = () => draft().config.proxy ?? newNetworkProxy();
  const patchProxy = (value: Partial<ReturnType<typeof newNetworkProxy>>) =>
    config({ proxy: { ...proxy(), ...value } });
  function validate(requireName = true) {
    const issue = validateConnection(
      draft(),
      props.hub.data().connections,
      requireName,
    );
    if (issue) {
      error.set(issue.message);
      tab.set(issue.tab);
      return false;
    }
    error.set("");
    return true;
  }
  async function confirmSshHostKey(current: number, recheck = false) {
    const settings = draft().config;
    const { ssh } = settings;
    const gateway = sshGateway(ssh);
    if (
      !ssh.enabled ||
      (!recheck && ssh.fingerprint.trim() && isTrustedGateway(gateway))
    )
      return current;

    const fingerprint = await probeSshHostKey(settings);
    if (closed || current !== revision) return;
    const description = hubT("sshTrustPrompt", {
      host: ssh.host.trim(),
      port: ssh.port,
    });
    const { action } = await AlertDialog.show({
      title: hubT("sshTrustTitle"),
      description: `${description}\n\n${fingerprint}`,
      actions: [
        { id: "cancel", label: hubT("cancel"), role: "cancel" },
        { id: "trust", label: hubT("sshTrustConnect") },
      ],
      closeOnEscape: true,
    });
    if (action !== "trust" || closed || current !== revision) return;
    trustedGateway = gateway;
    config({ ssh: { ...ssh, fingerprint } });
    return revision;
  }
  async function runTest(recheck = false) {
    if (testing() || saving() || !validate(false)) return;
    let current = revision;
    testing.set(true);
    test.set(hubT("testing"));
    try {
      const approved = await confirmSshHostKey(current, recheck);
      if (closed || approved !== revision) {
        if (!closed && current === revision)
          test.set(sshKeyMismatch() ? hubT("sshMismatch") : "");
        return;
      }
      current = approved;
      sshKeyMismatch.set(false);
      test.set(hubT("testing"));
      await testConnection(draft().config);
      if (!closed && current === revision) test.set(hubT("testSuccess"));
    } catch (cause) {
      if (!closed && current === revision) {
        const code = (cause as { code?: string })?.code;
        sshKeyMismatch.set(code === "SSH_HOST_KEY_MISMATCH");
        test.set(safeError(cause));
      }
    } finally {
      if (!closed) testing.set(false);
    }
  }
  async function saveAndConnect() {
    if (saving() || testing() || !validate()) return;
    let current = revision;
    saving.set(true);
    try {
      const approved = await confirmSshHostKey(current);
      if (closed || approved !== revision) return;
      current = approved;
      const value = copyConnection(draft());
      if (!value.config.ssh.enabled && !isTrustedGateway(sshGateway(value.config.ssh)))
        value.config.ssh.fingerprint = "";
      const ok = await props.hub.save(value);
      if (closed) return;
      if (!ok) {
        error.set(props.hub.error());
        return;
      }
      props.onSaved(value.id);
      const connected = await props.hub.connectDraft(value);
      if (closed) return;
      if (!connected) {
        error.set(props.hub.error());
        return;
      }
      const openWorkspace = props.onConnected;
      // Finish dismissing the native dialog before replacing its NavPage.
      props.onClose();
      setTimeout(openWorkspace, 0);
    } catch (cause) {
      if (!closed && current === revision) error.set(safeError(cause));
    } finally {
      if (!closed) saving.set(false);
    }
  }
  const field = (
    key:
      | "host"
      | "port"
      | "database"
      | "master"
      | "username"
      | "password"
      | "sentinelUsername"
      | "sentinelPassword"
      | "connectTimeout"
      | "operationTimeout",
    password = false,
    placeholder?: string,
  ) => (
    <Field
      compact
      id={`connection-${key}`}
      label={hubT(key)}
      value={draft().config[key]}
      onChange={(value) => config({ [key]: value })}
      password={password}
      placeholder={placeholder}
      disabled={key === "database" && mode() === "Cluster"}
    />
  );
  return (
    <Modal
      id="connection-dialog"
      title={hubT(props.editing ? "editConnection" : "newConnection")}
      description={hubT("configureConnection")}
      width={820}
      height={884}
      onClose={() => {
        if (!saving()) props.onClose();
      }}
    >
      <View class="px-8">
        <Segments
          id="connection-tab"
          variant="line"
          value={tab()}
          items={[
            { value: "connection", title: hubT("connectionSettings") },
            { value: "security", title: hubT("security") },
            { value: "advanced", title: hubT("advanced") },
          ]}
          onChange={tab.set}
        />
      </View>
      <Scroll testID="connection-form-scroll" class="flex-1 min-h-0">
        <View class="px-8 py-4 gap-3">
          <ErrorText message={error()} />
          {tab() === "connection" ? (
            <>
              <View class="flex-row items-center gap-4">
                <Text class="w-[88px] text-(--text-size-13) font-medium text-foreground">
                  {hubT("mode")}
                </Text>
                <View class="flex-1 max-w-[380px]">
                  <Segments
                    variant="mode"
                    id="connection-mode"
                    value={mode()}
                    items={["Standalone", "Cluster", "Sentinel"].map(
                      (value) => ({
                        value,
                        title: value,
                        icon:
                          value === "Standalone"
                            ? ("database" as const)
                            : value === "Cluster"
                              ? ("network" as const)
                              : ("shield" as const),
                      }),
                    )}
                    onChange={(value) =>
                      config({
                        mode: value as Config["mode"],
                        ...(value === "Cluster" ? { database: "0" } : {}),
                      })
                    }
                  />
                </View>
              </View>
              <Field
                compact
                id="connection-name"
                label={hubT("connectionName")}
                value={draft().name}
                onChange={(name) => patch({ name })}
                placeholder={hubT("connectionNamePlaceholder")}
                maxLength={100}
                autoFocus
              />
              <View class="gap-2.5 pt-[13px] border-t border-border">
                <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                  {hubT("connectionConfig")}
                </Text>
                {mode() === "Standalone" ? (
                  <View class="flex-row gap-5">
                    {field("host", false, "127.0.0.1")}
                    <View class="w-[155px]">{field("port")}</View>
                  </View>
                ) : (
                  <NodeEditor
                    kind={
                      mode() === "Cluster" ? "clusterNodes" : "sentinelNodes"
                    }
                    value={
                      mode() === "Cluster"
                        ? draft().config.clusterNodes
                        : draft().config.sentinelNodes
                    }
                    onChange={(value) =>
                      config({
                        [mode() === "Cluster"
                          ? "clusterNodes"
                          : "sentinelNodes"]: value,
                      })
                    }
                  />
                )}
                <If when={mode() === "Sentinel"}>
                  {field("master", false, "mymaster")}
                </If>
                <View class="flex-row flex-wrap items-end gap-x-5 gap-y-2">
                  <View class="w-[140px]">{field("database")}</View>
                  <View class="flex-row items-end gap-2">
                    <View class="w-[148px]">
                      <Field
                        compact
                        id="connection-key-separator"
                        label={hubT("keySeparator")}
                        value={
                          draft().config.keySeparator ?? defaultKeySeparator
                        }
                        maxLength={3}
                        onChange={(keySeparator) => config({ keySeparator })}
                      />
                    </View>
                    <View class="h-[34px] flex-row items-center gap-1">
                      {[":", ".", "_"].map((separator) => (
                        <Action
                          label={hubT("useKeySeparator", { separator })}
                          selected={draft().config.keySeparator === separator}
                          compact
                          onPress={() => config({ keySeparator: separator })}
                        >
                          <Text class="text-(--text-size-12) font-mono text-foreground">
                            {separator}
                          </Text>
                        </Action>
                      ))}
                    </View>
                  </View>
                </View>
                {mode() === "Cluster" && <Hint>{hubT("clusterDb")}</Hint>}
                <Hint>{hubT("keySeparatorHint")}</Hint>
              </View>
              <View class="gap-2.5 pt-[13px] border-t border-border">
                <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                  {hubT("redisAuthentication")}
                </Text>
                {mode() === "Sentinel" && (
                  <>
                    <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">Sentinel</Text>
                    <View class="flex-row gap-4">
                      {field("sentinelUsername")}
                      {field("sentinelPassword", true)}
                    </View>
                    <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                      {hubT("redisNodes")}
                    </Text>
                  </>
                )}
                <View class="flex-row gap-4">
                  {field("username", false, hubT("defaultUser"))}
                  {field("password", true, hubT("notSet"))}
                </View>
                <Hint>
                  {hubT(
                    mode() === "Sentinel" ? "separateCredentials" : "authHint",
                  )}
                </Hint>
              </View>
              <OrganizationFields
                hub={props.hub}
                groupId={draft().groupId}
                tagIds={draft().tagIds}
                onChange={patch}
              />
            </>
          ) : tab() === "security" ? (
            <>
              {mode() === "Sentinel" && (
                <TlsSettings
                  title="Sentinel TLS"
                  value={draft().config.sentinelTls}
                  onChange={(sentinelTls) => config({ sentinelTls })}
                />
              )}
              <TlsSettings
                title="Redis TLS"
                value={draft().config.dataTls}
                onChange={(dataTls) => config({ dataTls })}
              />
              <View class="gap-4 pt-4 border-t border-border">
                <Toggle
                  title={hubT("ssh")}
                  hint={hubT("sshHint")}
                  checked={draft().config.ssh.enabled}
                  onChange={(enabled) =>
                    config({ ssh: { ...draft().config.ssh, enabled } })
                  }
                />
                <If when={draft().config.ssh.enabled}>
                  <>
                    <View class="flex-row gap-4">
                      <Field
                        compact
                        label={hubT("sshHost")}
                        value={draft().config.ssh.host}
                        onChange={(host) =>
                          config({ ssh: { ...draft().config.ssh, host } })
                        }
                      />
                      <View class="w-28">
                        <Field
                          compact
                          label={hubT("port")}
                          value={draft().config.ssh.port}
                          onChange={(port) =>
                            config({ ssh: { ...draft().config.ssh, port } })
                          }
                        />
                      </View>
                    </View>
                    <Field
                      compact
                      label={hubT("sshUsername")}
                      value={draft().config.ssh.username}
                      onChange={(username) =>
                        config({ ssh: { ...draft().config.ssh, username } })
                      }
                    />
                    <Choice
                      label={hubT("authentication")}
                      value={draft().config.ssh.authentication}
                      items={[
                        { value: "password", title: hubT("password") },
                        { value: "private-key", title: hubT("privateKey") },
                      ]}
                      onChange={(authentication) =>
                        config({
                          ssh: { ...draft().config.ssh, authentication },
                        })
                      }
                    />
                    <If
                      when={draft().config.ssh.authentication === "password"}
                      else={
                        <>
                          <Field
                            compact
                            label={hubT("privateKey")}
                            multiline
                            password
                            value={draft().config.ssh.privateKey}
                            onChange={(privateKey) =>
                              config({
                                ssh: { ...draft().config.ssh, privateKey },
                              })
                            }
                          />
                          <Field
                            compact
                            label={hubT("passphrase")}
                            password
                            value={draft().config.ssh.passphrase}
                            onChange={(passphrase) =>
                              config({
                                ssh: { ...draft().config.ssh, passphrase },
                              })
                            }
                          />
                        </>
                      }
                    >
                      <Field
                        compact
                        id="connection-sshPassword"
                        label={hubT("sshPassword")}
                        password
                        value={draft().config.ssh.password}
                        onChange={(password) =>
                          config({ ssh: { ...draft().config.ssh, password } })
                        }
                      />
                    </If>
                  </>
                </If>
              </View>
            </>
          ) : (
            <View class="gap-4">
              <View class="gap-3">
                <Toggle
                  title={hubT("networkProxy")}
                  hint={hubT("proxyHint")}
                  checked={proxy().enabled}
                  onChange={(enabled) => patchProxy({ enabled })}
                />
                <If when={proxy().enabled}>
                  <Choice
                    id="connection-proxy-kind"
                    label={hubT("proxyKind")}
                    value={proxy().kind}
                    items={[
                      { value: "system", title: hubT("systemProxy") },
                      { value: "socks5", title: "SOCKS5" },
                      { value: "http", title: "HTTP CONNECT" },
                    ]}
                    onChange={(kind) => patchProxy({ kind })}
                  />
                  <If when={proxy().kind === "system"}>
                    <Hint>{hubT("systemProxyHint")}</Hint>
                  </If>
                  <If when={proxy().kind !== "system"}>
                    <View class="flex-row gap-5">
                      <Field
                        compact
                        id="connection-proxy-host"
                        label={hubT("proxyHost")}
                        placeholder="127.0.0.1"
                        value={proxy().host}
                        onChange={(host) => patchProxy({ host })}
                      />
                      <View class="w-[155px]">
                        <Field
                          compact
                          id="connection-proxy-port"
                          label={hubT("port")}
                          value={proxy().port}
                          onChange={(port) => patchProxy({ port })}
                        />
                      </View>
                    </View>
                    <View class="flex-row gap-4">
                      <Field
                        compact
                        id="connection-proxy-username"
                        label={hubT("username")}
                        value={proxy().username}
                        onChange={(username) => patchProxy({ username })}
                      />
                      <Field
                        compact
                        id="connection-proxy-password"
                        label={hubT("proxyPassword")}
                        password
                        value={proxy().password}
                        onChange={(password) => patchProxy({ password })}
                      />
                    </View>
                    <Hint>{hubT("proxyAuthHint")}</Hint>
                  </If>
                  <If when={draft().config.ssh.enabled}>
                    <Hint>{hubT("proxySshHint")}</Hint>
                  </If>
                </If>
              </View>
              <View class="h-px bg-border" />
              <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                {hubT("timeouts")}
              </Text>
              <Hint>{hubT("timeoutHint")}</Hint>
              <View class="flex-row gap-4">
                {field("connectTimeout")}
                {field("operationTimeout")}
              </View>
            </View>
          )}
        </View>
      </Scroll>
      <View class="h-[72px] px-7 border-t border-border flex-row items-center gap-3">
        <HubAction
          testID="connection-test"
          label={hubT(testing() ? "testing" : "testConnection")}
          disabled={testing() || saving()}
          onPress={() => void runTest()}
        />
        <View class="flex-1 min-w-0">
          <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
            {test() || hubT("notTested")}
          </Text>
        </View>
        <If when={sshKeyMismatch() && !testing() && !saving()}>
          <HubAction
            testID="connection-recheck-ssh-host"
            label={hubT("sshRecheckHost")}
            onPress={() => void runTest(true)}
          />
        </If>
        <HubAction
          label={hubT("cancel")}
          disabled={saving()}
          onPress={props.onClose}
        />
        <View class="flex-row items-center">
          <HubAction
            testID="connection-save-connect"
            primary
            label={hubT(saving() ? "saving" : "saveConnect")}
            disabled={saving() || testing()}
            onPress={() => void saveAndConnect()}
          />
        </View>
      </View>
    </Modal>
  );
}
function Toggle(props: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View class="flex-row items-center gap-4">
      <View class="flex-1 gap-1">
        <Text class="text-(--text-size-13) font-medium text-foreground">
          {props.title}
        </Text>
        {props.hint && <Hint>{props.hint}</Hint>}
      </View>
      <Switch
        accessibilityLabel={props.title}
        checked={props.checked}
        onChange={({ checked }) => props.onChange(checked)}
        trackClass="w-9 h-5 rounded-full bg-border-strong checked:bg-primary"
        thumbClass="w-4 h-4 m-0.5 rounded-full bg-white checked:translate-x-4"
      />
    </View>
  );
}
function TlsSettings(props: {
  title: string;
  value: Tls;
  onChange: (value: Tls) => void;
}) {
  const patch = (change: Partial<Tls>) =>
    props.onChange({ ...props.value, ...change });
  return (
    <View class="gap-4">
      <Toggle
        title={props.title}
        hint={hubT("tlsHint")}
        checked={props.value.enabled}
        onChange={(enabled) => patch({ enabled })}
      />
      <If when={props.value.enabled}>
        <>
          <Choice
            label={hubT("trust")}
            value={props.value.trust}
            items={[
              { value: "system", title: hubT("systemTrust") },
              { value: "custom", title: hubT("customCA") },
            ]}
            onChange={(trust) => patch({ trust })}
          />
          <If when={props.value.trust === "custom"}>
            <Field
              compact
              label={hubT("ca")}
              multiline
              value={props.value.ca}
              onChange={(ca) => patch({ ca })}
            />
          </If>
          <Field
            compact
            label={hubT("clientCertificate")}
            multiline
            value={props.value.clientCertificate}
            onChange={(clientCertificate) => patch({ clientCertificate })}
          />
          <Field
            compact
            label={hubT("clientKey")}
            multiline
            password
            value={props.value.clientKey}
            onChange={(clientKey) => patch({ clientKey })}
          />
          <Hint>{hubT("clientPair")}</Hint>
        </>
      </If>
    </View>
  );
}

function NodeEditor(props: {
  kind: "clusterNodes" | "sentinelNodes";
  value: Node[];
  onChange: (nodes: Node[]) => void;
}) {
  return (
    <View class="gap-3">
      <View class="flex-row justify-between items-center">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {hubT(props.kind)}
        </Text>
        <Action
          label={hubT("addNode")}
          icon="plus"
          disabled={props.value.length >= 32}
          onPress={() =>
            props.onChange([
              ...props.value,
              newNode(props.kind === "clusterNodes" ? "6379" : "26379"),
            ])
          }
        />
      </View>
      <Each of={props.value} key={(node) => node.id}>
        {(node, index) => (
          <View class="flex-row gap-3 items-end">
            <Field
              compact
              id={`node-host-${index()}`}
              label={hubT("host")}
              value={node().host}
              onChange={(host) =>
                props.onChange(
                  props.value.map((n) =>
                    n.id === node().id ? { ...n, host } : n,
                  ),
                )
              }
              placeholder="redis.example.com"
            />
            <View class="w-28">
              <Field
                compact
                id={`node-port-${index()}`}
                label={hubT("port")}
                value={node().port}
                onChange={(port) =>
                  props.onChange(
                    props.value.map((n) =>
                      n.id === node().id ? { ...n, port } : n,
                    ),
                  )
                }
              />
            </View>
            <Action
              label={hubT("removeNode")}
              icon="trash"
              disabled={props.value.length === 1}
              onPress={() =>
                props.onChange(props.value.filter((n) => n.id !== node().id))
              }
            />
          </View>
        )}
      </Each>
    </View>
  );
}
