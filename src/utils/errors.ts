import { hubT } from "../i18n";

export function safeError(cause: unknown): string {
  const code = (cause as { code?: string })?.code;
  const known: Record<string, string> = {
    KEEPASS_LOCKED: "keepassLocked",
    KEEPASS_PASSWORD_INVALID: "keepassPasswordInvalid",
    KEEPASS_IO: "keepassIo",
    KEEPASS_CONFLICT: "keepassConflict",
    KEEPASS_NOT_ACTIVE: "keepassNotActive",
    MASTER_PASSWORD_INVALID: "masterPasswordInvalid",
    MASTER_PASSWORD_MISMATCH: "masterPasswordMismatch",
    KEYCHAIN_UNAVAILABLE: "keychainUnavailable",
    CREDENTIAL_MISSING: "credentialsMissing",
    CREDENTIAL_INVALID: "credentialsInvalid",
    STORE_CONFLICT: "conflict",
    STORE_VERSION: "newerDatabase",
    DATADIR_UNAVAILABLE: "noDatadir",
    AUTH_FAILED: "authFailed",
    CONNECTION_FAILED: "connectionFailed",
    TIMEOUT: "timeout",
    TLS_ERROR: "tlsFailed",
    SSH_CONNECTION_FAILED: "sshConnectionFailed",
    SSH_HOST_KEY_MISMATCH: "sshMismatch",
    SSH_KEY_INVALID: "sshKeyInvalid",
    SSH_KEY_UNSUPPORTED: "sshKeyUnsupported",
    SSH_RSA_SHA2_REQUIRED: "sshRsaSha2Required",
    SYSTEM_PROXY_UNAVAILABLE: "systemProxyUnavailable",
    SYSTEM_PROXY_UNSUPPORTED: "systemProxyUnsupported",
    PROXY_CONFIGURATION_INVALID: "invalidProxy",
    PROXY_AUTHENTICATION_FAILED: "proxyAuthFailed",
    PROXY_CONNECTION_FAILED: "proxyConnectionFailed",
    PROXY_PROTOCOL_ERROR: "proxyProtocolFailed",
  };
  return (
    hubT(known[code ?? ""] ?? "operationFailed") +
    (code && /^[A-Z_]{2,50}$/.test(code) ? ` (${code})` : "")
  );
}
