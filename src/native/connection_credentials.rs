//! Platform credential storage. No file-based or in-memory production fallback.
use nsh_core::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "com.ryujane.ferrix.connections";
// Windows Credential Manager limits a blob to 2560 bytes. Also accommodates PEM keys.
const CHUNK_BYTES: usize = 2048;
const MAX_CHUNKS: usize = 4096;

/// An immutable, opaque generation of one configuration's secrets.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct CredentialRef {
    id: uuid::Uuid,
    chunks: usize,
}
impl CredentialRef {
    pub(super) fn new(bytes: &[u8]) -> Result<Self, JsError> {
        let chunks = bytes.len().div_ceil(CHUNK_BYTES);
        if chunks == 0 || chunks > MAX_CHUNKS {
            return Err(invalid());
        }
        Ok(Self {
            id: uuid::Uuid::new_v4(),
            chunks,
        })
    }
    pub(super) fn parse(value: &str) -> Result<Self, JsError> {
        let mut parts = value.split(':');
        if parts.next() != Some("v1") {
            return Err(invalid());
        }
        let id = parts
            .next()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .ok_or_else(invalid)?;
        let chunks = parts
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| (1..=MAX_CHUNKS).contains(n))
            .ok_or_else(invalid)?;
        if parts.next().is_some() {
            return Err(invalid());
        }
        Ok(Self { id, chunks })
    }
    pub(super) fn encode(&self) -> String {
        format!("v1:{}:{}", self.id, self.chunks)
    }
    fn account(&self, chunk: usize) -> String {
        format!("{}/{chunk}", self.id)
    }
}

/// Backend seam for deterministic transaction/failure tests, never selected by the UI.
pub(super) trait Vault {
    fn provider(&self) -> &'static str {
        "native"
    }
    /// Persist staged changes before SQLite is allowed to refer to them.
    fn flush(&self) -> Result<(), JsError> {
        Ok(())
    }
    fn get(&self, reference: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError>;
    fn put(&self, reference: &CredentialRef, bytes: &[u8]) -> Result<(), JsError>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), JsError>;
}
pub(super) struct NativeVault;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn entry(reference: &CredentialRef, chunk: usize) -> Result<keyring::Entry, JsError> {
    keyring::Entry::new(SERVICE, &reference.account(chunk)).map_err(vault_error)
}
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn vault_error(error: keyring::Error) -> JsError {
    // OS errors can include names, paths or secret bytes: expose stable codes only.
    if matches!(error, keyring::Error::NoEntry) {
        JsError::Error("Saved credentials are missing from the system credential store".into())
            .with_code("CREDENTIAL_MISSING")
    } else {
        unavailable()
    }
}
fn unavailable() -> JsError {
    JsError::Error("Cannot access the system credential store. Unlock it and retry.".into())
        .with_code("KEYCHAIN_UNAVAILABLE")
}
fn invalid() -> JsError {
    JsError::Error("Invalid saved credential reference or material".into())
        .with_code("CREDENTIAL_INVALID")
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl Vault for NativeVault {
    fn get(&self, reference: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
        let mut bytes = Zeroizing::new(Vec::new());
        for i in 0..reference.chunks {
            let chunk = Zeroizing::new(entry(reference, i)?.get_secret().map_err(vault_error)?);
            if chunk.is_empty()
                || chunk.len() > CHUNK_BYTES
                || (i + 1 < reference.chunks && chunk.len() != CHUNK_BYTES)
            {
                return Err(invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    fn put(&self, reference: &CredentialRef, bytes: &[u8]) -> Result<(), JsError> {
        if reference.chunks != bytes.len().div_ceil(CHUNK_BYTES) {
            return Err(invalid());
        }
        for (i, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
            entry(reference, i)?
                .set_secret(chunk)
                .map_err(vault_error)?;
        }
        // Verify persistence before the database is allowed to point to this generation.
        if self.get(reference)?.as_slice() != bytes {
            return Err(unavailable());
        }
        Ok(())
    }
    fn delete(&self, reference: &CredentialRef) -> Result<(), JsError> {
        let mut failed = false;
        for i in 0..reference.chunks {
            match entry(reference, i)
                .and_then(|entry| entry.delete_credential().map_err(vault_error))
            {
                Ok(()) => (),
                Err(error) if error == vault_error(keyring::Error::NoEntry) => (),
                Err(_) => failed = true,
            }
        }
        if failed { Err(unavailable()) } else { Ok(()) }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl Vault for NativeVault {
    fn get(&self, _: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
        Err(unavailable())
    }
    fn put(&self, _: &CredentialRef, _: &[u8]) -> Result<(), JsError> {
        Err(unavailable())
    }
    fn delete(&self, _: &CredentialRef) -> Result<(), JsError> {
        Err(unavailable())
    }
}

const SECRET_PATHS: &[&[&str]] = &[
    &["password"],
    &["sentinelPassword"],
    &["dataTls", "clientKey"],
    &["sentinelTls", "clientKey"],
    &["ssh", "password"],
    &["ssh", "privateKey"],
    &["ssh", "passphrase"],
];
#[derive(Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Secrets {
    fields: [String; 7],
    // Keep the original seven-field payload readable by existing installations.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    proxy_password: String,
}
impl Drop for Secrets {
    fn drop(&mut self) {
        for value in &mut self.fields {
            value.zeroize();
        }
        self.proxy_password.zeroize();
    }
}
impl Secrets {
    /// Strip every secret from the JSON that will be written to SQLite.
    pub(super) fn take(config: &mut Value) -> Result<Self, JsError> {
        let mut secrets = Self::default();
        for (secret, path) in secrets
            .fields
            .iter_mut()
            .chain(std::iter::once(&mut secrets.proxy_password))
            .zip(
                SECRET_PATHS
                    .iter()
                    .copied()
                    .chain(std::iter::once(&["proxy", "password"][..])),
            )
        {
            if let Some(value) = field_mut(config, path)? {
                let text = value.as_str().ok_or_else(invalid)?;
                if !text.is_empty() {
                    let Value::String(text) = value else {
                        unreachable!()
                    };
                    *secret = std::mem::take(text);
                }
            }
        }
        Ok(secrets)
    }
    pub(super) fn is_empty(&self) -> bool {
        self.fields.iter().all(String::is_empty) && self.proxy_password.is_empty()
    }
    pub(super) fn encode(&self) -> Result<Zeroizing<Vec<u8>>, JsError> {
        serde_json::to_vec(self)
            .map(Zeroizing::new)
            .map_err(|_| invalid())
    }
    pub(super) fn decode(bytes: &[u8]) -> Result<Self, JsError> {
        serde_json::from_slice(bytes).map_err(|_| invalid())
    }
    pub(super) fn restore(&self, config: &mut Value) -> Result<(), JsError> {
        for (value, path) in self
            .fields
            .iter()
            .chain(std::iter::once(&self.proxy_password))
            .zip(
                SECRET_PATHS
                    .iter()
                    .copied()
                    .chain(std::iter::once(&["proxy", "password"][..])),
            )
        {
            if value.is_empty() {
                continue;
            }
            let mut parent = &mut *config;
            for key in &path[..path.len() - 1] {
                parent = parent
                    .as_object_mut()
                    .ok_or_else(invalid)?
                    .entry(*key)
                    .or_insert_with(|| serde_json::json!({}));
            }
            parent.as_object_mut().ok_or_else(invalid)?.insert(
                path[path.len() - 1].to_string(),
                Value::String(value.clone()),
            );
        }
        Ok(())
    }
}

fn field_mut<'a>(value: &'a mut Value, path: &[&str]) -> Result<Option<&'a mut Value>, JsError> {
    let member = value.as_object_mut().ok_or_else(invalid)?.get_mut(path[0]);
    match member {
        Some(member) if path.len() == 1 => Ok(Some(member)),
        Some(member) => field_mut(member, &path[1..]),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_password_is_stripped_restored_and_old_bundles_remain_readable() {
        let legacy = br#"{"fields":["redis","","","","","",""]}"#;
        let mut legacy_config = serde_json::json!({"password":"", "host":"localhost"});
        Secrets::decode(legacy)
            .unwrap()
            .restore(&mut legacy_config)
            .unwrap();
        assert_eq!(legacy_config["password"], "redis");
        assert!(legacy_config.get("proxy").is_none());
        let mut config = serde_json::json!({"proxy":{"enabled":true,"host":"localhost","username":"user","password":"proxy-secret"}});
        let original = config.clone();
        let secrets = Secrets::take(&mut config).unwrap();
        assert_eq!(config["proxy"]["password"], "");
        assert_eq!(config["proxy"]["username"], "user");
        assert!(!secrets.is_empty());
        Secrets::decode(&secrets.encode().unwrap())
            .unwrap()
            .restore(&mut config)
            .unwrap();
        assert_eq!(config, original);
    }
    #[test]
    fn references_are_opaque_bounded_and_secrets_round_trip() {
        let mut config = serde_json::json!({"password":"redis", "sentinelPassword":"sentinel", "dataTls":{"clientKey":"data-key"}, "sentinelTls":{"clientKey":"sentinel-key"}, "ssh":{"password":"ssh", "privateKey":"key", "passphrase":"phrase"},"host":"localhost"});
        let original = config.clone();
        let secrets = Secrets::take(&mut config).unwrap();
        for marker in ["redis", "sentinel-key", "data-key"] {
            assert!(!config.to_string().contains(marker));
        }
        let bytes = secrets.encode().unwrap();
        let reference = CredentialRef::new(&bytes).unwrap();
        assert!(CredentialRef::parse(&reference.encode()).is_ok());
        Secrets::decode(&bytes)
            .unwrap()
            .restore(&mut config)
            .unwrap();
        assert_eq!(config, original);
        assert!(CredentialRef::parse("v1:arbitrary-account:0").is_err());
        assert!(CredentialRef::new(&[]).is_err());
    }
    #[test]
    #[ignore = "explicit native keychain integration; writes and removes isolated test entries"]
    fn native_keychain_round_trip_and_large_private_key() {
        let vault = NativeVault;
        let bytes = Zeroizing::new(vec![b'x'; CHUNK_BYTES * 3 + 17]);
        let reference = CredentialRef::new(&bytes).unwrap();
        let result = vault.put(&reference, &bytes).and_then(|()| {
            assert_eq!(vault.get(&reference)?.as_slice(), bytes.as_slice());
            Ok(())
        });
        let cleanup = vault.delete(&reference);
        result.unwrap();
        cleanup.unwrap();
        assert!(vault.get(&reference).is_err());
    }
}
