//! Backend selection is stored in the application database, never in exported preferences.
use super::{
    connection_credentials::{NativeVault, Vault},
    keepass_vault::KeePassVault,
};
use nsh_core::prelude::*;
use rusqlite::Connection;
use std::path::Path;

pub(super) fn provider(db: &Connection) -> Result<String, JsError> {
    db.query_row(
        "SELECT provider FROM credential_settings WHERE id=1",
        [],
        |row| row.get(0),
    )
    .map_err(|_| super::keepass_vault::error("STORE_IO", "Cannot read credential settings"))
}
pub(super) fn selected(path: &Path) -> Result<Box<dyn Vault>, JsError> {
    let kind = if path.exists() {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| {
                super::keepass_vault::error("STORE_IO", "Cannot read credential settings")
            })?;
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| {
                super::keepass_vault::error("STORE_IO", "Cannot read credential settings")
            })?;
        if version > 3 {
            return Err(super::keepass_vault::error(
                "STORE_VERSION",
                "This application database requires a newer Ferrix",
            ));
        }
        if version >= 3 {
            provider(&db)?
        } else {
            "native".into()
        }
    } else {
        "native".into()
    };
    match kind.as_str() {
        "native" => Ok(Box::new(NativeVault)),
        "keepass" => Ok(Box::new(KeePassVault::cached(path.parent().unwrap())?)),
        _ => Err(super::keepass_vault::error(
            "STORE_INVALID",
            "Unknown credential backend",
        )),
    }
}
