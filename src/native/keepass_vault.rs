//! Standard KDBX vault. Master passwords live only in zeroed process memory.
use super::connection_credentials::{CredentialRef, Vault};
use base64::{Engine, engine::general_purpose::STANDARD};
use keepass::{Database, DatabaseKey, config::KdfConfig, db::fields};
use nsh_core::prelude::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use zeroize::Zeroizing;

const FILE_NAME: &str = "credentials.kdbx";
const REF_FIELD: &str = "FerrixCredentialRef";
type Keys = HashMap<PathBuf, Zeroizing<String>>;
fn keys() -> &'static Mutex<Keys> {
    static KEYS: OnceLock<Mutex<Keys>> = OnceLock::new();
    KEYS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn path(datadir: &Path) -> PathBuf {
    datadir.join(FILE_NAME)
}
pub(super) fn is_unlocked(datadir: &Path) -> bool {
    path(datadir).is_file()
        && keys()
            .lock()
            .map(|keys| keys.contains_key(datadir))
            .unwrap_or(false)
}
pub(super) fn lock(datadir: &Path) {
    if let Ok(mut keys) = keys().lock() {
        keys.remove(datadir);
    }
}
fn remember(datadir: &Path, master: &str) -> Result<(), JsError> {
    keys()
        .lock()
        .map_err(|_| locked())?
        .insert(datadir.to_path_buf(), Zeroizing::new(master.to_owned()));
    Ok(())
}
pub(super) fn validate_new_password(password: &str, confirmation: &str) -> Result<(), JsError> {
    if password != confirmation {
        return Err(error(
            "MASTER_PASSWORD_MISMATCH",
            "Master passwords do not match",
        ));
    }
    if password.chars().count() < 8 || password.len() > 1024 || password.trim().is_empty() {
        return Err(error(
            "MASTER_PASSWORD_INVALID",
            "Use a master password with at least eight characters",
        ));
    }
    Ok(())
}
fn database_key(master: &str) -> DatabaseKey {
    DatabaseKey::new().with_password(master)
}
fn read_database(file: &Path, master: &str) -> Result<(Database, [u8; 32]), JsError> {
    if fs::metadata(file).map_err(|_| io_error())?.len() > 64 * 1024 * 1024 {
        return Err(io_error());
    }
    let bytes = fs::read(file).map_err(|_| io_error())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(io_error());
    }
    let fingerprint = Sha256::digest(&bytes).into();
    let database = Database::open(&mut bytes.as_slice(), database_key(master)).map_err(|_| {
        error(
            "KEEPASS_PASSWORD_INVALID",
            "Cannot unlock KeePass. Check the master password and database.",
        )
    })?;
    Ok((database, fingerprint))
}
struct Contents {
    database: Database,
    fingerprint: Option<[u8; 32]>,
    dirty: bool,
}
pub(super) struct KeePassVault {
    datadir: PathBuf,
    master: Zeroizing<String>,
    contents: Mutex<Contents>,
}
impl KeePassVault {
    pub(super) fn cached(datadir: &Path) -> Result<Self, JsError> {
        let master = keys()
            .lock()
            .map_err(|_| locked())?
            .get(datadir)
            .cloned()
            .ok_or_else(locked)?;
        let result = Self::open(datadir, master);
        if result.is_err() {
            lock(datadir);
        }
        result
    }
    fn open(datadir: &Path, master: Zeroizing<String>) -> Result<Self, JsError> {
        let (database, fingerprint) = read_database(&path(datadir), &master)?;
        Ok(Self {
            datadir: datadir.to_path_buf(),
            master,
            contents: Mutex::new(Contents {
                database,
                fingerprint: Some(fingerprint),
                dirty: false,
            }),
        })
    }
    pub(super) fn unlock(datadir: &Path, master: String) -> Result<Self, JsError> {
        let master = Zeroizing::new(master);
        let vault = Self::open(datadir, master)?;
        remember(datadir, &vault.master)?;
        Ok(vault)
    }
    pub(super) fn create_or_unlock(
        datadir: &Path,
        master: String,
        confirmation: Option<String>,
    ) -> Result<Self, JsError> {
        if path(datadir).exists() {
            return Self::unlock(datadir, master);
        }
        let master = Zeroizing::new(master);
        let confirmation = Zeroizing::new(confirmation.unwrap_or_default());
        validate_new_password(&master, &confirmation)?;
        let mut database = Database::new();
        database.root_mut().name = "Ferrix credentials".into();
        database.config.kdf_config = KdfConfig::Argon2id {
            iterations: 3,
            memory: 64 * 1024 * 1024,
            parallelism: 2,
            version: argon2::Version::Version13,
        };
        let vault = Self {
            datadir: datadir.to_path_buf(),
            master,
            contents: Mutex::new(Contents {
                database,
                fingerprint: None,
                dirty: true,
            }),
        };
        vault.flush()?;
        remember(datadir, &vault.master)?;
        Ok(vault)
    }
    pub(super) fn change_master(
        datadir: &Path,
        current: String,
        new: String,
        confirmation: String,
    ) -> Result<(), JsError> {
        let current = Zeroizing::new(current);
        let new = Zeroizing::new(new);
        let confirmation = Zeroizing::new(confirmation);
        validate_new_password(&new, &confirmation)?;
        let (database, fingerprint) = read_database(&path(datadir), &current)?;
        let vault = Self {
            datadir: datadir.to_path_buf(),
            master: new,
            contents: Mutex::new(Contents {
                database,
                fingerprint: Some(fingerprint),
                dirty: true,
            }),
        };
        vault.flush()?;
        remember(datadir, &vault.master)
    }
    fn unchanged(&self, expected: Option<[u8; 32]>) -> Result<(), JsError> {
        match (fs::read(path(&self.datadir)), expected) {
            (Ok(bytes), Some(expected)) if <[u8; 32]>::from(Sha256::digest(&bytes)) == expected => {
                Ok(())
            }
            (Err(e), None) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(error(
                "KEEPASS_CONFLICT",
                "The KeePass file changed. Unlock it again before saving.",
            )),
        }
    }
}
impl Vault for KeePassVault {
    fn provider(&self) -> &'static str {
        "keepass"
    }
    fn get(&self, reference: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
        let contents = self.contents.lock().map_err(|_| locked())?;
        let encoded = reference.encode();
        let root = contents.database.root();
        let entry = root
            .entries()
            .find(|entry| entry.get(REF_FIELD) == Some(encoded.as_str()))
            .ok_or_else(|| {
                error(
                    "CREDENTIAL_MISSING",
                    "Saved credentials are missing from KeePass",
                )
            })?;
        let value = entry
            .get_password()
            .ok_or_else(|| error("CREDENTIAL_INVALID", "Invalid KeePass credential entry"))?;
        STANDARD
            .decode(value)
            .map(Zeroizing::new)
            .map_err(|_| error("CREDENTIAL_INVALID", "Invalid KeePass credential entry"))
    }
    fn put(&self, reference: &CredentialRef, bytes: &[u8]) -> Result<(), JsError> {
        let encoded = reference.encode();
        let mut contents = self.contents.lock().map_err(|_| locked())?;
        if let Some(entry) = contents
            .database
            .root()
            .entries()
            .find(|entry| entry.get(REF_FIELD) == Some(encoded.as_str()))
        {
            let actual = Zeroizing::new(
                STANDARD
                    .decode(entry.get_password().unwrap_or_default())
                    .map_err(|_| io_error())?,
            );
            return if actual.as_slice() == bytes {
                Ok(())
            } else {
                Err(error(
                    "CREDENTIAL_INVALID",
                    "Conflicting immutable credential generation",
                ))
            };
        }
        let mut root = contents.database.root_mut();
        let mut entry = root.add_entry();
        entry.set_unprotected(fields::TITLE, format!("Ferrix / {encoded}"));
        entry.set_unprotected(REF_FIELD, encoded);
        entry.set_protected(fields::PASSWORD, STANDARD.encode(bytes));
        contents.dirty = true;
        Ok(())
    }
    fn delete(&self, reference: &CredentialRef) -> Result<(), JsError> {
        let mut contents = self.contents.lock().map_err(|_| locked())?;
        let encoded = reference.encode();
        let id = contents
            .database
            .root()
            .entries()
            .find(|entry| entry.get(REF_FIELD) == Some(encoded.as_str()))
            .map(|entry| entry.id());
        if let Some(id) = id {
            if let Some(entry) = contents.database.entry_mut(id) {
                entry.remove();
            }
            contents.dirty = true;
        }
        Ok(())
    }
    fn flush(&self) -> Result<(), JsError> {
        let mut contents = self.contents.lock().map_err(|_| locked())?;
        if !contents.dirty {
            return self.unchanged(contents.fingerprint);
        }
        self.unchanged(contents.fingerprint)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".ferrix-credentials-")
            .suffix(".kdbx.tmp")
            .tempfile_in(&self.datadir)
            .map_err(|_| io_error())?;
        contents
            .database
            .save(temporary.as_file_mut(), database_key(&self.master))
            .map_err(|_| io_error())?;
        temporary.as_file().sync_all().map_err(|_| io_error())?;
        let (verified, fingerprint) = read_database(temporary.path(), &self.master)?;
        self.unchanged(contents.fingerprint)?;
        if contents.fingerprint.is_none() {
            temporary
                .persist_noclobber(path(&self.datadir))
                .map_err(|_| io_error())?;
        } else {
            temporary
                .persist(path(&self.datadir))
                .map_err(|_| io_error())?;
        }
        #[cfg(unix)]
        {
            use std::fs::File;

            let _ = File::open(&self.datadir).and_then(|file| file.sync_all());
        }
        contents.database = verified;
        contents.fingerprint = Some(fingerprint);
        contents.dirty = false;
        Ok(())
    }
}
pub(super) fn error(code: &'static str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}
fn locked() -> JsError {
    error(
        "KEEPASS_LOCKED",
        "KeePass is locked. Unlock it in credential settings.",
    )
}
fn io_error() -> JsError {
    error("KEEPASS_IO", "Cannot read or write the KeePass database")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keepass_master_password_lifecycle_and_ciphertext() {
        let dir = tempfile::tempdir().unwrap();
        let datadir = dir.path();
        let master = "ferrix-test-master-password";
        let vault =
            KeePassVault::create_or_unlock(datadir, master.into(), Some(master.into())).unwrap();
        let bytes = Zeroizing::new(b"credential-secret-bytes".to_vec());
        let reference = CredentialRef::new(&bytes).unwrap();
        vault.put(&reference, &bytes).unwrap();
        vault.flush().unwrap();
        assert_eq!(vault.get(&reference).unwrap().as_slice(), bytes.as_slice());
        let file = fs::read(path(datadir)).unwrap();
        assert!(file.starts_with(&[0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]));
        for marker in [master.as_bytes(), bytes.as_slice()] {
            assert!(!file.windows(marker.len()).any(|part| part == marker));
        }
        lock(datadir);
        assert!(!is_unlocked(datadir));
        assert!(KeePassVault::cached(datadir).is_err());
        assert!(KeePassVault::unlock(datadir, "wrong-master-password".into()).is_err());
        let restored = KeePassVault::unlock(datadir, master.into()).unwrap();
        assert_eq!(
            restored.get(&reference).unwrap().as_slice(),
            bytes.as_slice()
        );
        drop(restored);
        let original = fs::read(path(datadir)).unwrap();
        assert!(
            KeePassVault::change_master(
                datadir,
                "wrong-current-password".into(),
                "new-test-master-password".into(),
                "new-test-master-password".into()
            )
            .is_err()
        );
        assert_eq!(fs::read(path(datadir)).unwrap(), original);
        KeePassVault::change_master(
            datadir,
            master.into(),
            "new-test-master-password".into(),
            "new-test-master-password".into(),
        )
        .unwrap();
        lock(datadir);
        assert!(KeePassVault::unlock(datadir, master.into()).is_err());
        let changed = KeePassVault::unlock(datadir, "new-test-master-password".into()).unwrap();
        assert_eq!(
            changed.get(&reference).unwrap().as_slice(),
            bytes.as_slice()
        );
        changed.delete(&reference).unwrap();
        changed.flush().unwrap();
        assert!(
            KeePassVault::cached(datadir)
                .unwrap()
                .get(&reference)
                .is_err()
        );
        lock(datadir);
    }
    #[test]
    fn keepass_refuses_external_file_changes_and_password_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let datadir = dir.path();
        let master = "ferrix-test-master-password";
        assert!(
            KeePassVault::create_or_unlock(datadir, master.into(), Some("other-password".into()))
                .is_err()
        );
        assert!(!path(datadir).exists());
        let stale =
            KeePassVault::create_or_unlock(datadir, master.into(), Some(master.into())).unwrap();
        let fresh = KeePassVault::cached(datadir).unwrap();
        let bytes = b"first-secret";
        let reference = CredentialRef::new(bytes).unwrap();
        fresh.put(&reference, bytes).unwrap();
        fresh.flush().unwrap();
        stale
            .put(
                &CredentialRef::new(b"second-secret").unwrap(),
                b"second-secret",
            )
            .unwrap();
        assert!(stale.flush().is_err());
        assert_eq!(
            KeePassVault::cached(datadir)
                .unwrap()
                .get(&reference)
                .unwrap()
                .as_slice(),
            bytes
        );
        lock(datadir);
    }
}

#[cfg(test)]
mod interoperability {
    use super::*;
    #[test]
    #[ignore = "independent KDBX reader; set FERRIX_KEEPASS_VERIFY_PYTHON to Python with pykeepass"]
    fn keepass_file_is_readable_by_independent_reader() {
        let python = std::env::var_os("FERRIX_KEEPASS_VERIFY_PYTHON")
            .expect("Set independent reader Python path");
        let dir = tempfile::tempdir().unwrap();
        let master = "interop-master-password";
        let vault =
            KeePassVault::create_or_unlock(dir.path(), master.into(), Some(master.into())).unwrap();
        let bytes = b"interoperability-credential";
        let reference = CredentialRef::new(bytes).unwrap();
        vault.put(&reference, bytes).unwrap();
        vault.flush().unwrap();
        let result=std::process::Command::new(python).arg("-c").arg("import sys,base64; from pykeepass import PyKeePass; db=PyKeePass(sys.argv[1],password='interop-master-password'); entry=db.find_entries(title='Ferrix / '+sys.argv[2],first=True); assert entry is not None, 'missing Ferrix entry'; assert base64.b64decode(entry.password)==b'interoperability-credential', 'credential payload mismatch'; assert db.encryption_algorithm=='aes256', db.encryption_algorithm; from pykeepass.kdbx_parsing import kdf_uuids; assert db.kdbx.header.value.dynamic_header.kdf_parameters.data.dict['$UUID'].value==kdf_uuids['argon2id']").arg(path(dir.path())).arg(reference.encode()).status().unwrap();
        lock(dir.path());
        assert!(result.success());
    }
}
