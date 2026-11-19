import {
  CredentialSettings,
  Redis,
  type RedisSession,
  type RedisTlsOptions,
} from "ferrix/native";
import { endpoints, type Config, type Tls } from "./connection-model";

const cleanHost = (value: string) => value.trim().replace(/^\[(.*)\]$/, "$1");
const tlsOptions = (value: Tls): RedisTlsOptions | undefined =>
  value.enabled
    ? {
        caCertificatePem: value.trust === "custom" ? value.ca : undefined,
        clientCertificatePem: value.clientCertificate.trim() || undefined,
        clientPrivateKeyPem: value.clientKey.trim() || undefined,
      }
    : undefined;
export async function openConnection(c: Config): Promise<RedisSession> {
  await CredentialSettings.requireUnlocked();
  const common = {
    username: c.username.trim() || undefined,
    password: c.password || undefined,
    database: Number(c.database),
    connectTimeoutMs: Number(c.connectTimeout),
    operationTimeoutMs: Number(c.operationTimeout),
    tls: tlsOptions(c.dataTls),
    proxy: c.proxy?.enabled
      ? {
          kind: c.proxy.kind,
          host: c.proxy.kind === "system" ? "" : cleanHost(c.proxy.host),
          port: c.proxy.kind === "system" ? 0 : Number(c.proxy.port),
          username:
            c.proxy.kind === "system"
              ? undefined
              : c.proxy.username.trim() || undefined,
          password:
            c.proxy.kind === "system"
              ? undefined
              : c.proxy.password || undefined,
        }
      : undefined,
    ssh: c.ssh.enabled
      ? {
          host: cleanHost(c.ssh.host),
          port: Number(c.ssh.port),
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
