//! A single login Keychain item protects independently encrypted credential records.
use super::connection_credentials::{
    CredentialRef, NativeVault, Vault, invalid, login_keychain, unavailable,
};
use nsh_core::prelude::*;
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::{
    cell::RefCell,
    fs::OpenOptions,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const FILE_NAME: &str = "native-credentials.sqlite3";
const SERVICE: &str = "Ferrix Credential Vault";
const KEY_BYTES: usize = 32;
type SecretKey = Zeroizing<[u8; KEY_BYTES]>;

pub(super) trait RootKey {
    fn read(&self, account: &str) -> Result<Option<SecretKey>, JsError>;
    fn create(&self, account: &str, bytes: &[u8]) -> Result<(), JsError>;
}

pub(super) struct LoginKeychain;

fn entry(account: &str) -> Result<keyring::Entry, JsError> {
    keyring::Entry::new(SERVICE, account).map_err(|_| unavailable())
}

impl RootKey for LoginKeychain {
    fn read(&self, account: &str) -> Result<Option<SecretKey>, JsError> {
        match entry(account)?.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let mut key = Zeroizing::new([0; KEY_BYTES]);
                if bytes.len() != key.len() {
                    return Err(invalid());
                }
                key.copy_from_slice(&bytes);
                Ok(Some(key))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }

    fn create(&self, account: &str, bytes: &[u8]) -> Result<(), JsError> {
        login_keychain()?
            .add_generic_password(SERVICE, account, bytes)
            .map_err(|_| unavailable())
    }
}

pub(super) struct MacKeychainVault<K = LoginKeychain> {
    path: PathBuf,
    keys: K,
    // Reuse the key only within this storage task; macOS checks access on the next task.
    unlocked: RefCell<Option<(String, SecretKey)>>,
}

impl MacKeychainVault {
    pub(super) fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
            keys: LoginKeychain,
            unlocked: RefCell::new(None),
        }
    }
}

impl<K: RootKey> MacKeychainVault<K> {
    fn open(&self, create: bool) -> Result<Option<Connection>, JsError> {
        if !self.path.try_exists().map_err(io_error)? {
            if !create {
                return Ok(None);
            }
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&self.path)
                .map_err(io_error)?;
        }
        let mut db = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(io_error)?;
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(io_error)?;
        if version == 0 && create {
            let tx = db.transaction().map_err(io_error)?;
            tx.execute_batch("CREATE TABLE keychain_key (slot INTEGER PRIMARY KEY CHECK(slot=1), account TEXT NOT NULL, initialized INTEGER NOT NULL CHECK(initialized IN(0,1)));
                CREATE TABLE credentials (reference TEXT PRIMARY KEY, nonce BLOB NOT NULL, sealed BLOB NOT NULL);
                PRAGMA user_version=1;").map_err(io_error)?;
            tx.execute(
                "INSERT INTO keychain_key VALUES(1,?1,0)",
                [Uuid::new_v4().to_string()],
            )
            .map_err(io_error)?;
            tx.commit().map_err(io_error)?;
        } else if version != 1 {
            return Err(unavailable());
        }
        Ok(Some(db))
    }

    fn cipher(&self, db: &Connection, create: bool) -> Result<LessSafeKey, JsError> {
        let (account, initialized): (String, bool) = db
            .query_row(
                "SELECT account, initialized FROM keychain_key WHERE slot=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(io_error)?;
        if Uuid::parse_str(&account).is_err() {
            return Err(invalid());
        }
        let mut unlocked = self.unlocked.borrow_mut();
        if unlocked
            .as_ref()
            .is_none_or(|(current, _)| *current != account)
        {
            let key = match self.keys.read(&account)? {
                Some(key) => key,
                None if !initialized && create => {
                    let mut new_key = Zeroizing::new([0; KEY_BYTES]);
                    SystemRandom::new()
                        .fill(new_key.as_mut())
                        .map_err(io_error)?;
                    self.keys.create(&account, new_key.as_ref())?;
                    let stored = self.keys.read(&account)?.ok_or_else(missing)?;
                    if stored.as_ref() != new_key.as_ref() {
                        return Err(invalid());
                    }
                    stored
                }
                None => return Err(missing()),
            };
            *unlocked = Some((account, key));
        }
        if !initialized && create {
            db.execute("UPDATE keychain_key SET initialized=1 WHERE slot=1", [])
                .map_err(io_error)?;
        }
        let (_, key) = unlocked.as_ref().ok_or_else(unavailable)?;
        UnboundKey::new(&AES_256_GCM, key.as_ref())
            .map(LessSafeKey::new)
            .map_err(io_error)
    }

    fn read_sealed(
        &self,
        db: &Connection,
        reference: &CredentialRef,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, JsError> {
        let encoded = reference.encode();
        let row: Option<(Vec<u8>, Vec<u8>)> = db
            .query_row(
                "SELECT nonce,sealed FROM credentials WHERE reference=?1",
                [&encoded],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(io_error)?;
        let Some((nonce, sealed)) = row else {
            return Ok(None);
        };
        let plain_len = sealed
            .len()
            .checked_sub(AES_256_GCM.tag_len())
            .ok_or_else(invalid)?;
        if !reference.matches_length(plain_len) {
            return Err(invalid());
        }
        let mut bytes = Zeroizing::new(sealed);
        let nonce = Nonce::try_assume_unique_for_key(&nonce).map_err(|_| invalid())?;
        self.cipher(db, false)?
            .open_in_place(nonce, Aad::from(&encoded), &mut bytes)
            .map_err(|_| invalid())?;
        bytes.truncate(plain_len);
        Ok(Some(bytes))
    }
}

impl<K: RootKey> Vault for MacKeychainVault<K> {
    fn new_reference(&self, bytes: &[u8]) -> Result<CredentialRef, JsError> {
        CredentialRef::sealed(bytes)
    }

    fn should_upgrade(&self, reference: &CredentialRef) -> bool {
        !reference.is_sealed()
    }

    fn get(&self, reference: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
        if !reference.is_sealed() {
            return NativeVault.get(reference);
        }
        let db = self.open(false)?.ok_or_else(missing)?;
        self.read_sealed(&db, reference)?.ok_or_else(missing)
    }

    fn put(&self, reference: &CredentialRef, bytes: &[u8]) -> Result<(), JsError> {
        if !reference.is_sealed() || !reference.matches_length(bytes.len()) {
            return Err(invalid());
        }
        let db = self.open(true)?.ok_or_else(unavailable)?;
        if let Some(saved) = self.read_sealed(&db, reference)? {
            return if saved.as_slice() == bytes {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        let encoded = reference.encode();
        let mut nonce = [0; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).map_err(io_error)?;
        let mut sealed = Zeroizing::new(bytes.to_vec());
        self.cipher(&db, true)?
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(&encoded),
                &mut *sealed,
            )
            .map_err(io_error)?;
        db.execute(
            "INSERT INTO credentials VALUES(?1,?2,?3)",
            params![encoded, nonce.as_slice(), sealed.as_slice()],
        )
        .map_err(io_error)?;
        Ok(())
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), JsError> {
        if !reference.is_sealed() {
            return NativeVault.delete(reference);
        }
        if let Some(db) = self.open(false)? {
            db.execute(
                "DELETE FROM credentials WHERE reference=?1",
                [reference.encode()],
            )
            .map_err(io_error)?;
        }
        Ok(())
    }
}

fn io_error(_: impl std::fmt::Debug) -> JsError {
    JsError::Error("Cannot read or write the encrypted credential vault".into())
        .with_code("NATIVE_VAULT_IO")
}

fn missing() -> JsError {
    JsError::Error("The encrypted credential or its Keychain key is missing".into())
        .with_code("CREDENTIAL_MISSING")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::HashMap};

    #[derive(Default)]
    struct TestKeychain {
        items: RefCell<HashMap<String, SecretKey>>,
        reads: Cell<usize>,
        denied: Cell<bool>,
    }

    impl RootKey for &TestKeychain {
        fn read(&self, account: &str) -> Result<Option<SecretKey>, JsError> {
            self.reads.set(self.reads.get() + 1);
            if self.denied.get() {
                return Err(unavailable());
            }
            Ok(self.items.borrow().get(account).cloned())
        }

        fn create(&self, account: &str, bytes: &[u8]) -> Result<(), JsError> {
            let key = Zeroizing::new(bytes.try_into().map_err(|_| invalid())?);
            assert!(
                self.items
                    .borrow_mut()
                    .insert(account.into(), key)
                    .is_none()
            );
            Ok(())
        }
    }

    fn protected_vault<'a>(
        dir: &Path,
        keys: &'a TestKeychain,
    ) -> MacKeychainVault<&'a TestKeychain> {
        MacKeychainVault {
            path: dir.join(FILE_NAME),
            keys,
            unlocked: RefCell::new(None),
        }
    }

    #[test]
    fn records_share_one_key_and_only_cache_it_for_each_task() {
        let dir = tempfile::tempdir().unwrap();
        let keys = TestKeychain::default();
        let vault = protected_vault(dir.path(), &keys);
        let secret = b"unique-private-key-fixture";
        let first = vault.new_reference(secret).unwrap();
        let other = vault.new_reference(b"redis-password").unwrap();
        assert!(!vault.path.exists());
        assert_eq!(keys.reads.get(), 0);
        vault.put(&first, secret).unwrap();
        vault.put(&other, b"redis-password").unwrap();
        assert_eq!(vault.get(&first).unwrap().as_slice(), secret);
        assert_eq!(keys.items.borrow().len(), 1);
        // Initial creation performs a lookup and verifies that the key was persisted.
        assert_eq!(keys.reads.get(), 2);
        assert!(
            !std::fs::read(&vault.path)
                .unwrap()
                .windows(secret.len())
                .any(|part| part == secret)
        );
        drop(vault);

        let reopened = protected_vault(dir.path(), &keys);
        assert_eq!(reopened.get(&first).unwrap().as_slice(), secret);
        assert_eq!(reopened.get(&other).unwrap().as_slice(), b"redis-password");
        assert_eq!(keys.reads.get(), 3);
        drop(reopened);

        keys.denied.set(true);
        assert!(protected_vault(dir.path(), &keys).get(&first).is_err());
        keys.denied.set(false);
        keys.items.borrow_mut().clear();
        let no_key = protected_vault(dir.path(), &keys);
        assert!(no_key.get(&first).is_err());
        assert!(
            no_key
                .put(&no_key.new_reference(secret).unwrap(), secret)
                .is_err()
        );
        assert!(keys.items.borrow().is_empty());
    }

    #[test]
    fn encrypted_records_are_bound_to_their_immutable_references() {
        let dir = tempfile::tempdir().unwrap();
        let keys = TestKeychain::default();
        let vault = protected_vault(dir.path(), &keys);
        let secret = b"first";
        let saved = vault.new_reference(secret).unwrap();
        let other = vault.new_reference(secret).unwrap();
        vault.put(&saved, secret).unwrap();
        vault.put(&saved, secret).unwrap();
        assert!(vault.put(&saved, b"wrong").is_err());
        let db = vault.open(false).unwrap().unwrap();
        db.execute(
            "UPDATE credentials SET reference=?1 WHERE reference=?2",
            params![other.encode(), saved.encode()],
        )
        .unwrap();
        assert!(vault.get(&other).is_err());
        vault.delete(&other).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM credentials", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    #[ignore = "uses one randomly named login Keychain test item, then deletes it"]
    fn native_keychain_single_item_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = MacKeychainVault::new(dir.path());
        let secret = Zeroizing::new(vec![42; 9000]);
        let first = vault.new_reference(&secret).unwrap();
        let second = vault.new_reference(b"password").unwrap();
        let result = (|| {
            vault.put(&first, &secret)?;
            vault.put(&second, b"password")?;
            let reopened = MacKeychainVault::new(dir.path());
            Ok::<_, JsError>((reopened.get(&first)?, reopened.get(&second)?))
        })();
        if let Ok(Some(db)) = vault.open(false) {
            let account: String = db
                .query_row("SELECT account FROM keychain_key WHERE slot=1", [], |row| {
                    row.get(0)
                })
                .unwrap();
            super::super::connection_credentials::delete_login_item(SERVICE, &account).unwrap();
            assert!(LoginKeychain.read(&account).unwrap().is_none());
        }
        let (actual, password) = result.unwrap();
        assert_eq!(actual.as_slice(), secret.as_slice());
        assert_eq!(password.as_slice(), b"password");
    }
}
