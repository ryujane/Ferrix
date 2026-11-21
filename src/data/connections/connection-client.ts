import {
  CredentialSettings,
  Redis,
  type RedisProxyOptions,
  type RedisSession,
  type RedisTlsOptions,
} from "ferrix/native";
import { endpoints, type Config, type Tls } from "./connection-model";

const cleanHost = (value: string) => value.trim().replace(/^\[(.*)\]$/, "$1");
export const sshGateway = (value: Config["ssh"]) => ({
  host: cleanHost(value.host),
  port: Number(value.port),
});
const tlsOptions = (value: Tls): RedisTlsOptions | undefined =>
  value.enabled
    ? {
        caCertificatePem: value.trust === "custom" ? value.ca : undefined,
        clientCertificatePem: value.clientCertificate.trim() || undefined,
        clientPrivateKeyPem: value.clientKey.trim() || undefined,
      }
    : undefined;
const proxyOptions = (value: Config["proxy"]): RedisProxyOptions | undefined =>
  value?.enabled
    ? {
        kind: value.kind,
        host: value.kind === "system" ? "" : cleanHost(value.host),
        port: value.kind === "system" ? 0 : Number(value.port),
        username:
          value.kind === "system"
            ? undefined
            : value.username.trim() || undefined,
        password:
          value.kind === "system" ? undefined : value.password || undefined,
      }
    : undefined;

export async function probeSshHostKey(c: Config): Promise<string> {
  await CredentialSettings.requireUnlocked();
  return Redis.probeSshHostKey({
    ...sshGateway(c.ssh),
    proxy: proxyOptions(c.proxy),
    connectTimeoutMs: Number(c.connectTimeout),
  });
}

export async function openConnection(c: Config): Promise<RedisSession> {
  await CredentialSettings.requireUnlocked();
  const common = {
    username: c.username.trim() || undefined,
    password: c.password || undefined,
    database: Number(c.database),
    connectTimeoutMs: Number(c.connectTimeout),
    operationTimeoutMs: Number(c.operationTimeout),
    tls: tlsOptions(c.dataTls),
    proxy: proxyOptions(c.proxy),
    ssh: c.ssh.enabled
      ? {
          ...sshGateway(c.ssh),
          username: c.ssh.username.trim(),
          hostKeySha256: c.ssh.fingerprint.trim(),
          password:
            c.ssh.authentication === "password" ? c.ssh.password : undefined,
          privateKey:
            c.ssh.authentication === "private-key"
              ? c.ssh.privateKey
              : undefined,
          privateKeyPassphrase:
            c.ssh.authentication === "private-key"
              ? c.ssh.passphrase || undefined
              : undefined,
        }
      : undefined,
  };
  const nodes = endpoints(c).map((n) => ({
    host: cleanHost(n.host),
    port: Number(n.port),
  }));
  if (c.mode === "Cluster")
    return Redis.connectCluster({ ...common, seeds: nodes });
  if (c.mode === "Sentinel")
    return Redis.connectSentinel({
      ...common,
      endpoints: nodes,
      primaryGroup: c.master.trim(),
      sentinelUsername: c.sentinelUsername.trim() || undefined,
      sentinelPassword: c.sentinelPassword || undefined,
      sentinelTls: tlsOptions(c.sentinelTls),
    });
  return Redis.connectStandalone({
    ...common,
    host: cleanHost(c.host),
    port: Number(c.port),
  });
}
export async function testConnection(c: Config) {
  let session: RedisSession | undefined;
  try {
    session = await openConnection(c);
    return await session.ping();
  } finally {
    if (session) {
      session.close();
      session.dispose();
    }
  }
}
