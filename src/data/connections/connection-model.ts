import { hubT } from "../../i18n";

export type Mode = "Standalone" | "Cluster" | "Sentinel";
export type Node = { id: string; host: string; port: string };
export type Tls = {
  enabled: boolean;
  trust: string;
  ca: string;
  clientCertificate: string;
  clientKey: string;
};
export type Ssh = {
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  authentication: string;
  password: string;
  privateKey: string;
  passphrase: string;
  fingerprint: string;
};
export type NetworkProxy = {
  enabled: boolean;
  kind: string;
  host: string;
  port: string;
  username: string;
  password: string;
};
export const newNetworkProxy = (): NetworkProxy => ({
  enabled: false,
  kind: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
});
export type Config = {
  mode: Mode;
  host: string;
  port: string;
  database: string;
  keySeparator?: string;
  master: string;
  username: string;
  password: string;
  sentinelUsername: string;
  sentinelPassword: string;
  clusterNodes: Node[];
  sentinelNodes: Node[];
  dataTls: Tls;
  sentinelTls: Tls;
  ssh: Ssh;
  proxy?: NetworkProxy;
  connectTimeout: string;
  operationTimeout: string;
};
export type Group = { id: string; name: string };
export type TagColor =
  | "coral"
  | "blue"
  | "green"
  | "amber"
  | "violet"
  | "slate";
export type Tag = Group & { color: TagColor };
export type SavedConnection = {
  id: string;
  name: string;
  config: Config;
  groupId: string | null;
  tagIds: string[];
  favorite: boolean;
};
export type ConnectionDocument = {
  revision: number;
  groups: Group[];
  tags: Tag[];
  connections: SavedConnection[];
};
export const emptyDocument = (): ConnectionDocument => ({
  revision: 0,
  groups: [],
  tags: [],
  connections: [],
});
export const newId = () => crypto.randomUUID();
export const newNode = (port = "6379"): Node => ({
  id: newId(),
  host: "",
  port,
});
export const normalizeName = (name: string) =>
  name.trim().normalize("NFKC").toLowerCase();
const tls = (): Tls => ({
  enabled: false,
  trust: "system",
  ca: "",
  clientCertificate: "",
  clientKey: "",
});
export const defaultKeySeparator = ":";
function validKeySeparator(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    Array.from(value).length <= 3 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
export const connectionKeySeparator = (config: Config) =>
  validKeySeparator(config.keySeparator)
    ? config.keySeparator
    : defaultKeySeparator;

export function newConnection(groupId: string | null = null): SavedConnection {
  return {
    id: newId(),
    name: "",
    groupId,
    tagIds: [],
    favorite: false,
    config: {
      mode: "Standalone",
      host: "",
      port: "6379",
      database: "0",
      keySeparator: defaultKeySeparator,
      master: "",
      username: "",
      password: "",
      sentinelUsername: "",
      sentinelPassword: "",
      clusterNodes: [newNode()],
      sentinelNodes: [newNode("26379")],
      dataTls: tls(),
      sentinelTls: tls(),
      ssh: {
        enabled: false,
        host: "",
        port: "22",
        username: "",
        authentication: "password",
        password: "",
        privateKey: "",
        passphrase: "",
        fingerprint: "",
      },
      connectTimeout: "3000",
      operationTimeout: "5000",
      proxy: newNetworkProxy(),
    },
  };
}
export function copyConnection(value: SavedConnection): SavedConnection {
  const copied = JSON.parse(JSON.stringify(value)) as SavedConnection;
  copied.config.proxy = { ...newNetworkProxy(), ...copied.config.proxy };
  copied.config.keySeparator = connectionKeySeparator(copied.config);
  return copied;
}
export function organizationError(
  name: string,
  items: Group[],
  id?: string,
): string | undefined {
  if (
    !name.trim() ||
    Array.from(name.trim()).length > 30 ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    return hubT("invalidOrganization");
  if (
    items.some(
      (item) =>
        item.id !== id && normalizeName(item.name) === normalizeName(name),
    )
  )
    return hubT("duplicateName");
}
const integer = (value: string, min: number, max: number) =>
  /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
const host = (value: string) =>
  !!value.trim() && !/[\s/@?#]/.test(value.trim()) && !value.includes("://");
export function validateConnection(
  value: SavedConnection,
  all: SavedConnection[],
  requireName = true,
): { message: string; tab: string } | undefined {
  const c = value.config,
    fail = (key: string, tab = "connection") => ({ message: hubT(key), tab });
  if (
    requireName &&
    (!value.name.trim() ||
      Array.from(value.name.trim()).length > 100 ||
      /[\x00-\x1f\x7f]/.test(value.name))
  )
    return fail("invalidName");
  if (
    requireName &&
    all.some(
      (item) =>
        item.id !== value.id &&
        normalizeName(item.name) === normalizeName(value.name),
    )
  )
    return fail("duplicateName");
  if (c.mode === "Standalone") {
    if (!host(c.host)) return fail("invalidHost");
    if (!integer(c.port, 1, 65535)) return fail("invalidPort");
  } else {
    const nodes = c.mode === "Cluster" ? c.clusterNodes : c.sentinelNodes;
    if (
      !nodes.length ||
      nodes.length > 32 ||
      nodes.some((n) => !host(n.host) || !integer(n.port, 1, 65535))
    )
      return fail("invalidNodes");
  }
  if (
    !integer(c.database, 0, 2147483647) ||
    (c.mode === "Cluster" && c.database !== "0")
  )
    return fail("invalidDatabase");
  if (c.keySeparator !== undefined && !validKeySeparator(c.keySeparator))
    return fail("invalidKeySeparator");
  if (
    c.mode === "Sentinel" &&
    (!c.master.trim() ||
      /[\x00-\x1f\x7f]/.test(c.master) ||
      new TextEncoder().encode(c.master.trim()).length > 512)
  )
    return fail("invalidMaster");
  if (
    (c.username.trim() && !c.password) ||
    (c.mode === "Sentinel" && c.sentinelUsername.trim() && !c.sentinelPassword)
  )
    return fail("missingPassword");
  for (const security of [
    c.dataTls,
    ...(c.mode === "Sentinel" ? [c.sentinelTls] : []),
  ]) {
    if (
      security.enabled &&
      ((security.trust === "custom" && !security.ca.trim()) ||
        !!security.clientCertificate.trim() !== !!security.clientKey.trim())
    )
      return fail("invalidTls", "security");
  }
  if (c.ssh.enabled) {
    const s = c.ssh;
    if (
      !host(s.host) ||
      !integer(s.port, 1, 65535) ||
      !s.username.trim() ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(s.fingerprint.trim()) ||
      (s.authentication === "password" ? !s.password : !s.privateKey.trim())
    )
      return fail("invalidSsh", "security");
  }
  if (c.proxy?.enabled && c.proxy.kind !== "system") {
    const p = c.proxy,
      bytes = (text: string) => new TextEncoder().encode(text).length;
    const proxyHost = p.host.trim().replace(/^\[(.*)\]$/, "$1");
    if (
      !["socks5", "http"].includes(p.kind) ||
      !host(proxyHost) ||
      !/^[\x21-\x7e]+$/.test(proxyHost) ||
      bytes(proxyHost) > 253 ||
      /[\[\]\\]/.test(proxyHost) ||
      !integer(p.port, 1, 65535) ||
      !!p.username.trim() !== !!p.password ||
      bytes(p.username.trim()) > 255 ||
      bytes(p.password) > 255 ||
      /[\x00-\x1f\x7f]/.test(p.username) ||
      (p.kind === "http" && p.username.includes(":"))
    )
      return fail("invalidProxy", "advanced");
  }
  if (
    ![c.connectTimeout, c.operationTimeout].every((v) => integer(v, 10, 120000))
  )
    return fail("invalidTimeout", "advanced");
}
export const address = (node: { host: string; port: string }) =>
  `${node.host.includes(":") ? `[${node.host}]` : node.host}:${node.port}`;
export function endpoints(c: Config): { host: string; port: string }[] {
  return c.mode === "Cluster"
    ? c.clusterNodes
    : c.mode === "Sentinel"
      ? c.sentinelNodes
      : [{ host: c.host, port: c.port }];
}
export function redactConnection(value: SavedConnection): SavedConnection {
  const result = copyConnection(value),
    c = result.config;
  c.password = "";
  c.sentinelPassword = "";
  c.dataTls.clientKey = "";
  c.sentinelTls.clientKey = "";
  c.ssh.password = "";
  c.ssh.privateKey = "";
  c.ssh.passphrase = "";
  if (c.proxy) c.proxy.password = "";
  return result;
}
