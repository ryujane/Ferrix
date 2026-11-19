//! Credential settings are independent from exported preference documents.
use super::{
    app_store as store,
    connection_credentials::NativeVault,
    credential_backends as backends,
    keepass_vault::{self, KeePassVault},
};
use nsh_core::prelude::*;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    provider: String,
    keepass_exists: bool,
    keepass_unlocked: bool,
    file_path: String,
}
fn status(path: &Path) -> Result<String, JsError> {
    let db = store::open(path, &NativeVault)?;
    let datadir = path.parent().unwrap();
    serde_json::to_string(&Status {
        provider: backends::provider(&db)?,
        keepass_exists: keepass_vault::path(datadir).exists(),
        keepass_unlocked: keepass_vault::is_unlocked(datadir),
        file_path: keepass_vault::path(datadir).to_string_lossy().into_owned(),
    })
    .map_err(|_| keepass_vault::error("STORE_IO", "Cannot read credential settings"))
}
/// Configure native credential storage or a master-password-protected KeePass file.
#[module]
pub struct CredentialSettings;
#[module]
impl CredentialSettings {
    /// Read backend and unlock state. No master password is ever returned.
    pub fn get_status(sys: System) -> Result<Later<String>, JsError> {
        store::task(sys, status)
    }
    /// Create or unlock datadir/credentials.kdbx, then migrate existing credentials.
    pub fn use_keepass(
        master_password: String,
        confirmation: Option<String>,
        sys: System,
    ) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let mut db = store::open(path, &NativeVault)?;
            let datadir = path.parent().unwrap();
            let target = KeePassVault::create_or_unlock(datadir, master_password, confirmation)?;
            if backends::provider(&db)? != "keepass" {
                store::migrate_provider(&mut db, &NativeVault, &target)?;
            }
            let _ = store::collect_garbage(&mut db, &target);
            let _ = store::cleanup_native_after_keepass(&mut db, &target);
            status(path)
        })
    }
    /// Migrate credentials to the OS store. A locked KeePass source needs its password.
    pub fn use_native(
        master_password: Option<String>,
        sys: System,
    ) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let mut db = store::open(path, &NativeVault)?;
            let datadir = path.parent().unwrap();
            if backends::provider(&db)? == "keepass" {
                let source = if let Some(master) = master_password {
                    KeePassVault::unlock(datadir, master)?
                } else {
                    KeePassVault::cached(datadir)?
                };
                store::migrate_provider(&mut db, &source, &NativeVault)?;
                keepass_vault::lock(datadir);
            }
            status(path)
        })
    }
    /// Unlock only for this process; the password is not saved to disk or the OS store.
    pub fn unlock(master_password: String, sys: System) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let mut db = store::open(path, &NativeVault)?;
            let vault = KeePassVault::unlock(path.parent().unwrap(), master_password)?;
            let _ = store::cleanup_native_after_keepass(&mut db, &vault);
            status(path)
        })
    }
    /// Drop the cached master password. Established Redis Sessions are independent.
    pub fn lock(sys: System) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let _ = store::open(path, &NativeVault)?;
            keepass_vault::lock(path.parent().unwrap());
            status(path)
        })
    }
    /// Verify the current password, then atomically re-encrypt the complete KeePass file.
    pub fn change_master_password(
        current_password: String,
        new_password: String,
        confirmation: String,
        sys: System,
    ) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let db = store::open(path, &NativeVault)?;
            if backends::provider(&db)? != "keepass" {
                return Err(keepass_vault::error(
                    "KEEPASS_NOT_ACTIVE",
                    "Enable KeePass before changing its master password",
                ));
            }
            KeePassVault::change_master(
                path.parent().unwrap(),
                current_password,
                new_password,
                confirmation,
            )?;
            status(path)
        })
    }
    /// Connection and test actions must respect an explicitly locked KeePass vault.
    pub fn require_unlocked(sys: System) -> Result<Later<String>, JsError> {
        store::task(sys, move |path| {
            let result = status(path)?;
            let db = store::open(path, &NativeVault)?;
            if backends::provider(&db)? == "keepass"
                && !keepass_vault::is_unlocked(path.parent().unwrap())
            {
                return Err(keepass_vault::error(
                    "KEEPASS_LOCKED",
                    "Unlock KeePass in credential settings before connecting",
                ));
            }
            Ok(result)
        })
    }
}
