//! Application persistence: SQLite lifecycle, schema, configurations and credential settings.
//! SQLite is confined to the host's datadir.
use super::connection_credentials::NativeVault;
use super::connection_credentials::{CredentialRef, Secrets, Vault};
use nsh_core::prelude::*;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

const FILE_NAME: &str = "app.sqlite3";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Group {
    id: String,
    name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tag {
    id: String,
    name: String,
    color: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedConnection {
    id: String,
    name: String,
    group_id: Option<String>,
    tag_ids: Vec<String>,
    favorite: bool,
    config: serde_json::Value,
    #[serde(skip)]
    credential_ref: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    revision: i64,
    groups: Vec<Group>,
    tags: Vec<Tag>,
    connections: Vec<SavedConnection>,
}

/// Application storage in the host's data directory. Connection operations use
/// explicit names so other application data can share this storage boundary.
#[module]
pub struct AppStore;

#[module]
impl AppStore {
    /// Read saved configurations from `${dataDir}/app.sqlite3`.
    pub fn load_connections(sys: System) -> Result<Later<String>, JsError> {
        task(sys, |path| {
            let vault = super::credential_backends::selected(path)?;
            let mut db = open(path, vault.as_ref())?;
            let result = read(&mut db, vault.as_ref())?;
            let _ = cleanup_native_after_keepass(&mut db, vault.as_ref());
            Ok(result)
        })
    }
    /// Atomically save the document if its revision still matches the database.
    /// A stale window fails with STORE_CONFLICT instead of overwriting newer data.
    pub fn save_connections(document: String, sys: System) -> Result<Later<String>, JsError> {
        if document.len() > 16 * 1024 * 1024 {
            return Err(invalid());
        }
        task(sys, move |path| {
            let doc: Document = serde_json::from_str(&document).map_err(|_| invalid())?;
            let vault = super::credential_backends::selected(path)?;
            save(&mut open(path, vault.as_ref())?, doc, vault.as_ref())
        })
    }
}

pub(super) fn task(
    sys: System,
    work: impl FnOnce(&Path) -> Result<String, JsError> + Send + 'static,
) -> Result<Later<String>, JsError> {
    let path = sys
        .data_dir
        .ok_or_else(|| {
            failure(
                "DATADIR_UNAVAILABLE",
                "Application data directory is unavailable",
            )
        })?
        .join(FILE_NAME);
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("ferrix-store".into())
        .spawn(move || {
            let result = (|| {
                let _lock = data_lock(&path)?;
                work(&path)
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| failure("STORE_UNAVAILABLE", "Cannot start local storage"))?;
    Ok(Later::new(async move {
        rx.await
            .map_err(|_| failure("STORE_UNAVAILABLE", "Local storage stopped"))?
    }))
}

const ORGANIZATION_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS store_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO store_meta VALUES(1,0);
    CREATE TABLE IF NOT EXISTS connection_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL, favorite INTEGER NOT NULL CHECK(favorite IN(0,1)), config TEXT NOT NULL, credential_ref TEXT);
    CREATE TABLE IF NOT EXISTS connection_tags (connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(connection_id,tag_id));";
const CREDENTIAL_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS credential_gc (reference TEXT NOT NULL, not_before INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT 'native', PRIMARY KEY(reference,provider));
    CREATE TABLE IF NOT EXISTS credential_meta (id INTEGER PRIMARY KEY CHECK(id=1), needs_scrub INTEGER NOT NULL CHECK(needs_scrub IN(0,1)));
    INSERT OR IGNORE INTO credential_meta VALUES(1,0);
    CREATE TABLE IF NOT EXISTS credential_settings (id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL CHECK(provider IN('native','keepass')));
    INSERT OR IGNORE INTO credential_settings VALUES(1,'native');";

pub(super) fn open(path: &Path, vault: &dyn Vault) -> Result<Connection, JsError> {
    let parent = path.parent().ok_or_else(invalid)?;
    std::fs::create_dir_all(parent).map_err(store_error)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(store_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(store_error)?;
    }
    let mut db = Connection::open(path).map_err(store_error)?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(store_error)?;
    let version: u32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(store_error)?;
    if version > 3 {
        return Err(failure(
            "STORE_VERSION",
            "This application database requires a newer Ferrix",
        ));
    }
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;")
        .map_err(store_error)?;
    if version == 0 {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        tx.execute_batch(ORGANIZATION_SCHEMA).map_err(store_error)?;
        tx.execute_batch(CREDENTIAL_SCHEMA).map_err(store_error)?;
        tx.execute_batch("PRAGMA user_version=3;")
            .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
    } else if version == 1 {
        // Remove old WAL contents before changing any legacy plaintext cells. No plaintext backup.
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .map_err(store_error)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let has_reference: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('connections') WHERE name='credential_ref')", [], |r|r.get(0)).map_err(store_error)?;
        if !has_reference {
            tx.execute_batch("ALTER TABLE connections ADD COLUMN credential_ref TEXT;")
                .map_err(store_error)?;
        }
        tx.execute_batch(CREDENTIAL_SCHEMA).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        let document = snapshot(&db)?;
        persist(&mut db, document, vault, true)?;
    }
    if version == 2 {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        tx.execute_batch("CREATE TABLE credential_gc_v3 (reference TEXT NOT NULL, not_before INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT 'native', PRIMARY KEY(reference,provider)); INSERT INTO credential_gc_v3(reference,not_before) SELECT reference,not_before FROM credential_gc; DROP TABLE credential_gc; ALTER TABLE credential_gc_v3 RENAME TO credential_gc;").map_err(store_error)?;
        tx.execute_batch(CREDENTIAL_SCHEMA).map_err(store_error)?;
        tx.execute_batch("PRAGMA user_version=3;")
            .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
    }
    let needs_scrub: bool = db
        .query_row(
            "SELECT needs_scrub FROM credential_meta WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(store_error)?;
    if needs_scrub {
        // Retried on every open if interrupted: remove legacy freelist/page and journal remnants.
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM; UPDATE credential_meta SET needs_scrub=0 WHERE id=1;").map_err(store_error)?;
    }
    // Cleanup is retryable. A locked keychain never undoes a committed configuration save.
    if super::credential_backends::provider(&db)? == vault.provider() {
        let _ = collect_garbage(&mut db, vault);
    }
    Ok(db)
}

/// Read while holding a SQLite read transaction until credential hydration finishes.
/// Writers cannot retire this generation until the reader releases its snapshot.
fn read(db: &mut Connection, vault: &dyn Vault) -> Result<String, JsError> {
    let tx = db.transaction().map_err(store_error)?;
    let mut document = snapshot(&tx)?;
    for connection in &mut document.connections {
        if !Secrets::take(&mut connection.config)?.is_empty() {
            return Err(failure(
                "CREDENTIAL_INVALID",
                "Unexpected plaintext credentials in the connection database",
            ));
        }
        if let Some(reference) = &connection.credential_ref {
            let reference = CredentialRef::parse(reference)?;
            Secrets::decode(&vault.get(&reference)?)?.restore(&mut connection.config)?;
        }
    }
    vault.flush()?;
    tx.commit().map_err(store_error)?;
    serde_json::to_string(&document).map_err(store_error)
}
fn snapshot(db: &Connection) -> Result<Document, JsError> {
    let revision = db
        .query_row("SELECT revision FROM store_meta WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(store_error)?;
    let groups = db
        .prepare("SELECT id,name FROM connection_groups ORDER BY rowid")
        .map_err(store_error)?
        .query_map([], |r| {
            Ok(Group {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(store_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_error)?;
    let tags = db
        .prepare("SELECT id,name,color FROM tags ORDER BY rowid")
        .map_err(store_error)?
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })
        .map_err(store_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_error)?;
    let mut connections = Vec::new();
    let mut query = db.prepare("SELECT id,name,group_id,favorite,config,credential_ref FROM connections ORDER BY rowid").map_err(store_error)?;
    let mut rows = query.query([]).map_err(store_error)?;
    while let Some(row) = rows.next().map_err(store_error)? {
        let id: String = row.get(0).map_err(store_error)?;
        let config: String = row.get(4).map_err(store_error)?;
        let tag_ids = db
            .prepare("SELECT tag_id FROM connection_tags WHERE connection_id=? ORDER BY rowid")
            .map_err(store_error)?
            .query_map([&id], |r| r.get(0))
            .map_err(store_error)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(store_error)?;
        connections.push(SavedConnection {
            id,
            name: row.get(1).map_err(store_error)?,
            group_id: row.get(2).map_err(store_error)?,
            favorite: row.get(3).map_err(store_error)?,
            config: serde_json::from_str(&config)
                .map_err(|_| failure("STORE_CORRUPT", "A saved configuration cannot be read"))?,
            tag_ids,
            credential_ref: row.get(5).map_err(store_error)?,
        });
    }
    Ok(Document {
        revision,
        groups,
        tags,
        connections,
    })
}

fn save(db: &mut Connection, document: Document, vault: &dyn Vault) -> Result<String, JsError> {
    let document = persist(db, document, vault, false)?;
    serde_json::to_string(&document).map_err(store_error)
}
fn persist(
    db: &mut Connection,
    mut document: Document,
    vault: &dyn Vault,
    migration: bool,
) -> Result<Document, JsError> {
    validate(&document)?;
    let mut stored = document.clone();
    let mut prepared: Vec<(CredentialRef, Zeroizing<Vec<u8>>)> = Vec::new();
    {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        // Another window may have finished migrating while this one opened.
        // Never interpret a sanitized v2 snapshot as an instruction to clear its secrets.
        if migration
            && tx
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .map_err(store_error)?
                >= 2
        {
            return Ok(document);
        }
        let previous = snapshot(&tx)?;
        check_revision(previous.revision, document.revision)?;
        let references: HashMap<_, _> = previous
            .connections
            .iter()
            .map(|c| (&c.id, &c.credential_ref))
            .collect();
        for connection in &mut stored.connections {
            let secrets = Secrets::take(&mut connection.config)?;
            connection.credential_ref = None;
            if secrets.is_empty() {
                continue;
            }
            if let Some(Some(old)) = references.get(&connection.id) {
                let reference = CredentialRef::parse(old)?;
                if secrets == Secrets::decode(&vault.get(&reference)?)? {
                    connection.credential_ref = Some(old.to_string());
                    continue;
                }
            }
            let bytes = secrets.encode()?;
            let reference = CredentialRef::new(&bytes)?;
            connection.credential_ref = Some(reference.encode());
            // Durable intent precedes external I/O. Crash leftovers are collected after a lease.
            tx.execute(
                "INSERT INTO credential_gc(reference,not_before,provider) VALUES(?1,unixepoch()+86400,?2)",
                params![reference.encode(),vault.provider()],
            )
            .map_err(store_error)?;
            prepared.push((reference, bytes));
        }
        tx.commit().map_err(store_error)?;
    }
    let result = (|| {
        for (reference, bytes) in &prepared {
            vault.put(reference, bytes)?;
        }
        vault.flush()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let previous = snapshot(&tx)?;
        check_revision(previous.revision, document.revision)?;
        // Protect against expired preparation leases or external deletion before committing a ref.
        for (reference, bytes) in &prepared {
            if vault.get(reference)?.as_slice() != bytes.as_slice() {
                return Err(failure(
                    "CREDENTIAL_INVALID",
                    "System credential verification failed",
                ));
            }
        }
        write_document(&tx, &stored)?;
        let retained: HashSet<_> = stored
            .connections
            .iter()
            .filter_map(|c| c.credential_ref.as_ref())
            .collect();
        for reference in previous
            .connections
            .iter()
            .filter_map(|c| c.credential_ref.as_ref())
        {
            if !retained.contains(reference) {
                tx.execute("INSERT INTO credential_gc(reference,not_before,provider) VALUES(?1,0,?2) ON CONFLICT(reference,provider) DO UPDATE SET not_before=0",params![reference,vault.provider()]).map_err(store_error)?;
            }
        }
        for (reference, _) in &prepared {
            tx.execute(
                "DELETE FROM credential_gc WHERE reference=?1 AND provider=?2",
                params![reference.encode(), vault.provider()],
            )
            .map_err(store_error)?;
        }
        document.revision = document.revision.checked_add(1).ok_or_else(invalid)?;
        tx.execute(
            "UPDATE store_meta SET revision=? WHERE id=1",
            [document.revision],
        )
        .map_err(store_error)?;
        if migration {
            tx.execute_batch(
                "UPDATE credential_meta SET needs_scrub=1 WHERE id=1; PRAGMA user_version=3;",
            )
            .map_err(store_error)?;
        }
        tx.commit().map_err(store_error)?;
        Ok(())
    })();
    if result.is_err() {
        // No committed pointer changed. New generations can be deleted without touching old ones.
        for (reference, _) in &prepared {
            let _ = db.execute(
                "UPDATE credential_gc SET not_before=0 WHERE reference=?1 AND provider=?2",
                params![reference.encode(), vault.provider()],
            );
        }
    }
    let _ = collect_garbage(db, vault);
    result?;
    Ok(document)
}
fn check_revision(actual: i64, expected: i64) -> Result<(), JsError> {
    if actual != expected {
        return Err(failure(
            "STORE_CONFLICT",
            "Connections changed in another window. Reload before saving.",
        ));
    }
    Ok(())
}
fn write_document(db: &Connection, doc: &Document) -> Result<(), JsError> {
    db.execute_batch("DELETE FROM connection_tags; DELETE FROM connections; DELETE FROM connection_groups; DELETE FROM tags;").map_err(store_error)?;
    for g in &doc.groups {
        db.execute(
            "INSERT INTO connection_groups VALUES(?1,?2,?3)",
            params![g.id, g.name, name_key(&g.name)?],
        )
        .map_err(store_error)?;
    }
    for t in &doc.tags {
        db.execute(
            "INSERT INTO tags VALUES(?1,?2,?3,?4)",
            params![t.id, t.name, name_key(&t.name)?, t.color],
        )
        .map_err(store_error)?;
    }
    for c in &doc.connections {
        db.execute("INSERT INTO connections (id,name,name_key,group_id,favorite,config,credential_ref) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![c.id,c.name,name_key(&c.name)?,c.group_id,c.favorite,serde_json::to_string(&c.config).map_err(store_error)?,c.credential_ref]).map_err(store_error)?;
        for id in &c.tag_ids {
            db.execute(
                "INSERT INTO connection_tags VALUES(?1,?2)",
                params![c.id, id],
            )
            .map_err(store_error)?;
        }
    }
    Ok(())
}
pub(super) fn collect_garbage(db: &mut Connection, vault: &dyn Vault) -> Result<(), JsError> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(store_error)?;
    let references=tx.prepare("SELECT reference FROM credential_gc WHERE provider=?1 AND not_before<=unixepoch() AND NOT EXISTS(SELECT 1 FROM connections WHERE credential_ref=reference AND (SELECT provider FROM credential_settings WHERE id=1)=?1)").map_err(store_error)?
        .query_map([vault.provider()],|row|row.get::<_,String>(0)).map_err(store_error)?.collect::<Result<Vec<_>,_>>().map_err(store_error)?;
    let mut removed = Vec::new();
    for reference in references {
        if let Ok(parsed) = CredentialRef::parse(&reference) {
            if vault.delete(&parsed).is_ok() {
                removed.push(reference);
            }
        }
    }
    if !removed.is_empty() {
        vault.flush()?;
    }
    for reference in removed {
        tx.execute(
            "DELETE FROM credential_gc WHERE reference=?1 AND provider=?2",
            params![reference, vault.provider()],
        )
        .map_err(store_error)?;
    }
    tx.commit().map_err(store_error)
}

fn data_lock(path: &Path) -> Result<std::fs::File, JsError> {
    let parent = path.parent().ok_or_else(invalid)?;
    std::fs::create_dir_all(parent).map_err(store_error)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(parent.join("app.lock")).map_err(store_error)?;
    file.lock().map_err(store_error)?;
    Ok(file)
}
fn failure(code: &'static str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}
fn invalid() -> JsError {
    failure(
        "STORE_INVALID",
        "Invalid connection document, duplicate name or missing organization",
    )
}
fn store_error(_: impl std::fmt::Display) -> JsError {
    failure("STORE_IO", "Cannot read or write the connection database")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    pub(super) struct TestVault {
        pub(super) values: RefCell<HashMap<String, Vec<u8>>>,
        fail_put: Cell<bool>,
        fail_get: Cell<bool>,
        fail_delete: Cell<bool>,
        writes: Cell<usize>,
        after_put: RefCell<Option<Box<dyn FnOnce()>>>,
    }
    impl Vault for TestVault {
        fn get(&self, reference: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
            if self.fail_get.get() {
                return Err(failure("KEYCHAIN_UNAVAILABLE", "Locked test vault"));
            }
            self.values
                .borrow()
                .get(&reference.encode())
                .cloned()
                .map(Zeroizing::new)
                .ok_or_else(|| failure("CREDENTIAL_MISSING", "Missing test entry"))
        }
        fn put(&self, reference: &CredentialRef, bytes: &[u8]) -> Result<(), JsError> {
            self.writes.set(self.writes.get() + 1);
            self.values
                .borrow_mut()
                .insert(reference.encode(), bytes.to_vec());
            if let Some(callback) = self.after_put.borrow_mut().take() {
                callback();
            }
            if self.fail_put.get() {
                Err(failure("KEYCHAIN_UNAVAILABLE", "Test write failure"))
            } else {
                Ok(())
            }
        }
        fn delete(&self, reference: &CredentialRef) -> Result<(), JsError> {
            if self.fail_delete.get() {
                return Err(failure("KEYCHAIN_UNAVAILABLE", "Test delete failure"));
            }
            self.values.borrow_mut().remove(&reference.encode());
            Ok(())
        }
    }
    pub(super) fn document() -> Document {
        serde_json::from_value(serde_json::json!({"revision":0,"groups":[{"id":"g","name":"Production"}],"tags":[{"id":"t","name":"Core","color":"coral"}],"connections":[{"id":"c","name":"Cache","groupId":"g","tagIds":["t"],"favorite":true,"config":{"mode":"Standalone","host":"localhost","password":"unique-redis-secret","sentinelPassword":"unique-sentinel-secret","dataTls":{"clientKey":"unique-data-private-key"},"sentinelTls":{"clientKey":"unique-sentinel-private-key"},"ssh":{"password":"unique-ssh-secret","privateKey":"unique-ssh-private-key","passphrase":"unique-key-passphrase"}}}]})).unwrap()
    }
    pub(super) fn loaded(db: &mut Connection, vault: &dyn Vault) -> Document {
        serde_json::from_str(&read(db, vault).unwrap()).unwrap()
    }
    fn stored_config(db: &Connection) -> String {
        db.query_row("SELECT config FROM connections WHERE id='c'", [], |r| {
            r.get(0)
        })
        .unwrap()
    }
    fn assert_no_plaintext(path: &Path) {
        let bytes = std::fs::read(path).unwrap();
        for marker in [
            "unique-redis-secret",
            "unique-sentinel-secret",
            "unique-data-private-key",
            "unique-sentinel-private-key",
            "unique-ssh-secret",
            "unique-ssh-private-key",
            "unique-key-passphrase",
            "historical-plaintext-marker",
        ] {
            assert!(
                !bytes
                    .windows(marker.len())
                    .any(|part| part == marker.as_bytes()),
                "credential bytes leaked into SQLite"
            );
        }
    }
    #[test]
    fn credentials_persist_only_in_vault_and_reopen_with_organization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        {
            let mut db = open(&path, &vault).unwrap();
            save(&mut db, document(), &vault).unwrap();
            assert!(!stored_config(&db).contains("unique-"));
        }
        let doc = loaded(&mut open(&path, &vault).unwrap(), &vault);
        assert_eq!(doc.revision, 1);
        assert_eq!(doc.connections[0].config, document().connections[0].config);
        assert_eq!(doc.connections[0].tag_ids, ["t"]);
        assert_eq!(vault.values.borrow().len(), 1);
        assert_no_plaintext(&path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn organization_edits_reuse_credentials_and_delete_retires_them() {
        let dir = tempfile::tempdir().unwrap();
        let vault = TestVault::default();
        let mut db = open(&dir.path().join(FILE_NAME), &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        let mut doc = loaded(&mut db, &vault);
        doc.groups.clear();
        doc.tags.clear();
        doc.connections[0].group_id = None;
        doc.connections[0].tag_ids.clear();
        save(&mut db, doc, &vault).unwrap();
        assert_eq!(vault.writes.get(), 1);
        let mut doc = loaded(&mut db, &vault);
        assert_eq!(doc.connections.len(), 1);
        assert!(doc.connections[0].group_id.is_none());
        doc.connections.clear();
        save(&mut db, doc, &vault).unwrap();
        assert!(vault.values.borrow().is_empty());
    }
    #[test]
    fn keychain_failure_and_sql_failure_keep_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        let original = loaded(&mut db, &vault);
        let mut update = original.clone();
        update.connections[0].config["password"] = "replacement-secret".into();
        vault.fail_put.set(true);
        assert!(save(&mut db, update.clone(), &vault).is_err());
        vault.fail_put.set(false);
        assert_eq!(
            loaded(&mut db, &vault).connections[0].config,
            original.connections[0].config
        );
        assert_eq!(vault.values.borrow().len(), 1);
        db.execute_batch("CREATE TRIGGER reject_save BEFORE INSERT ON connections BEGIN SELECT RAISE(ABORT,'sensitive diagnostic'); END;").unwrap();
        let error = save(&mut db, update, &vault).unwrap_err();
        assert!(!format!("{error:?}").contains("sensitive diagnostic"));
        assert_eq!(loaded(&mut db, &vault).revision, 1);
        assert_eq!(vault.values.borrow().len(), 1);
        assert_no_plaintext(&path);
    }
    #[test]
    fn conflict_before_or_during_keychain_write_is_safe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        assert!(save(&mut db, document(), &vault).is_err());
        assert_eq!(vault.writes.get(), 1);
        let mut doc = loaded(&mut db, &vault);
        doc.connections[0].config["password"] = "replacement-secret".into();
        let other_path = path.clone();
        *vault.after_put.borrow_mut() = Some(Box::new(move || {
            let other = Connection::open(other_path).unwrap();
            other
                .execute("UPDATE store_meta SET revision=revision+1", [])
                .unwrap();
        }));
        assert!(save(&mut db, doc, &vault).is_err());
        let current = loaded(&mut db, &vault);
        assert_eq!(current.revision, 2);
        assert_eq!(
            current.connections[0].config["password"],
            "unique-redis-secret"
        );
        assert_eq!(vault.values.borrow().len(), 1);
    }
    #[test]
    fn locked_or_missing_vault_never_falls_back_to_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        vault.fail_get.set(true);
        assert!(read(&mut db, &vault).is_err());
        vault.fail_get.set(false);
        vault.values.borrow_mut().clear();
        assert!(read(&mut db, &vault).is_err());
        assert_no_plaintext(&path);
        assert_eq!(
            db.query_row("SELECT count(*) FROM connections", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn queued_deletion_and_crash_preparation_are_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        let mut doc = loaded(&mut db, &vault);
        doc.connections.clear();
        vault.fail_delete.set(true);
        save(&mut db, doc, &vault).unwrap();
        assert_eq!(vault.values.borrow().len(), 1);
        vault.fail_delete.set(false);
        drop(db);
        let mut db = open(&path, &vault).unwrap();
        assert!(vault.values.borrow().is_empty());
        let bytes = Zeroizing::new(vec![1, 2, 3]);
        let pending = CredentialRef::new(&bytes).unwrap();
        vault.put(&pending, &bytes).unwrap();
        db.execute(
            "INSERT INTO credential_gc(reference,not_before) VALUES(?1,unixepoch()+86400)",
            [pending.encode()],
        )
        .unwrap();
        collect_garbage(&mut db, &vault).unwrap();
        assert_eq!(vault.values.borrow().len(), 1);
        db.execute("UPDATE credential_gc SET not_before=0", [])
            .unwrap();
        collect_garbage(&mut db, &vault).unwrap();
        assert!(vault.values.borrow().is_empty());
    }
    pub(super) fn legacy(path: &Path) {
        let db = Connection::open(path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA secure_delete=OFF;")
            .unwrap();
        db.execute_batch(&ORGANIZATION_SCHEMA.replace(", credential_ref TEXT", ""))
            .unwrap();
        db.execute_batch("PRAGMA user_version=1;").unwrap();
        let doc = document();
        let c = &doc.connections[0];
        db.execute(
            "INSERT INTO connection_groups VALUES('g','Production','production')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO tags VALUES('t','Core','core','coral')", [])
            .unwrap();
        db.execute(
            "INSERT INTO connections VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                c.id,
                c.name,
                "cache",
                c.group_id,
                c.favorite,
                c.config.to_string()
            ],
        )
        .unwrap();
        db.execute("INSERT INTO connection_tags VALUES('c','t')", [])
            .unwrap();
        db.execute_batch("CREATE TABLE discarded(value TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO discarded VALUES(?)",
            ["historical-plaintext-marker".repeat(1000)],
        )
        .unwrap();
        db.execute_batch("DELETE FROM discarded;").unwrap();
    }
    #[test]
    fn plaintext_schema_migrates_and_old_sqlite_pages_are_scrubbed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        legacy(&path);
        let vault = TestVault::default();
        assert!(
            std::fs::read(&path)
                .unwrap()
                .windows(19)
                .any(|w| w == b"unique-redis-secret")
        );
        let mut db = open(&path, &vault).unwrap();
        let doc = loaded(&mut db, &vault);
        assert_eq!(doc.connections[0].config, document().connections[0].config);
        assert_eq!(doc.connections[0].group_id.as_deref(), Some("g"));
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            db.query_row("SELECT needs_scrub FROM credential_meta", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            0
        );
        drop(db);
        assert_no_plaintext(&path);
        assert!(!path.with_file_name("app.sqlite3-wal").exists());
    }
    #[test]
    fn denied_migration_preserves_legacy_data_until_keychain_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        legacy(&path);
        let vault = TestVault::default();
        vault.fail_put.set(true);
        assert!(open(&path, &vault).is_err());
        {
            let db = Connection::open(&path).unwrap();
            assert_eq!(
                db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                    .unwrap(),
                1
            );
            assert!(stored_config(&db).contains("unique-redis-secret"));
        }
        vault.fail_put.set(false);
        let mut db = open(&path, &vault).unwrap();
        assert_eq!(loaded(&mut db, &vault).connections.len(), 1);
        drop(db);
        assert_no_plaintext(&path);
    }
    #[test]
    fn malformed_names_and_future_schema_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        let mut doc = document();
        doc.groups.push(Group {
            id: "g2".into(),
            name: "Ｐｒｏｄｕｃｔｉｏｎ".into(),
        });
        assert!(save(&mut db, doc, &vault).is_err());
        assert_eq!(vault.writes.get(), 0);
        db.pragma_update(None, "user_version", 4).unwrap();
        drop(db);
        assert!(open(&path, &vault).is_err());
    }
}

fn name_key(name: &str) -> Result<String, JsError> {
    if name.trim().is_empty()
        || name.trim() != name
        || name.chars().count() > 100
        || name.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(name.nfkc().collect::<String>().to_lowercase())
}
fn id_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && !id.chars().any(char::is_control)
}
fn validate(doc: &Document) -> Result<(), JsError> {
    if doc.connections.len() > 10_000 || doc.groups.len() > 1000 || doc.tags.len() > 1000 {
        return Err(invalid());
    }
    let mut group_ids = HashSet::new();
    let mut tag_ids = HashSet::new();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for g in &doc.groups {
        if !id_valid(&g.id)
            || !group_ids.insert(&g.id)
            || g.name.chars().count() > 30
            || !names.insert(name_key(&g.name)?)
        {
            return Err(invalid());
        }
    }
    names.clear();
    for t in &doc.tags {
        if !id_valid(&t.id)
            || !tag_ids.insert(&t.id)
            || t.name.chars().count() > 30
            || !names.insert(name_key(&t.name)?)
            || !["coral", "blue", "green", "amber", "violet", "slate"].contains(&t.color.as_str())
        {
            return Err(invalid());
        }
    }
    names.clear();
    for c in &doc.connections {
        if !id_valid(&c.id)
            || !ids.insert(&c.id)
            || !names.insert(name_key(&c.name)?)
            || c.group_id
                .as_ref()
                .is_some_and(|id| !group_ids.contains(id))
            || c.tag_ids.iter().any(|id| !tag_ids.contains(id))
            || c.tag_ids.iter().collect::<HashSet<_>>().len() != c.tag_ids.len()
            || !c.config.is_object()
            || !matches!(
                c.config.get("mode").and_then(|v| v.as_str()),
                Some("Standalone" | "Cluster" | "Sentinel")
            )
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod credential_regressions {
    use super::tests::{TestVault, document, legacy, loaded};
    use super::*;

    #[test]
    fn a_second_migrator_cannot_clear_a_committed_credential_reference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        legacy(&path);
        let mut db = open(&path, &vault).unwrap();
        let previous = loaded(&mut db, &vault);
        let sanitized = snapshot(&db).unwrap();
        persist(&mut db, sanitized, &vault, true).unwrap();
        let current = loaded(&mut db, &vault);
        assert_eq!(current.revision, previous.revision);
        assert_eq!(
            current.connections[0].config,
            previous.connections[0].config
        );
    }
    #[test]
    fn unexpected_v2_plaintext_is_rejected_instead_of_becoming_a_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let vault = TestVault::default();
        let mut db = open(&path, &vault).unwrap();
        save(&mut db, document(), &vault).unwrap();
        db.execute(
            "UPDATE connections SET config=?",
            [document().connections[0].config.to_string()],
        )
        .unwrap();
        assert!(read(&mut db, &vault).is_err());
    }
    #[test]
    #[ignore = "explicit native keychain + SQLite migration integration; removes isolated test entries"]
    fn native_keychain_sqlite_migration_rotation_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(db) = Connection::open(&self.0) {
                    if let Ok(mut query)=db.prepare("SELECT credential_ref FROM connections WHERE credential_ref IS NOT NULL UNION SELECT reference FROM credential_gc") {
                        if let Ok(rows)=query.query_map([],|r|r.get::<_,String>(0)) {
                            for reference in rows.flatten() { if let Ok(reference)=CredentialRef::parse(&reference) { let _=NativeVault.delete(&reference); } }
                        }
                    }
                }
            }
        }
        let _cleanup = Cleanup(path.clone());
        legacy(&path);
        let vault = NativeVault;
        let mut db = open(&path, &vault).unwrap();
        let mut doc = loaded(&mut db, &vault);
        assert_eq!(doc.connections[0].config, document().connections[0].config);
        let previous = CredentialRef::parse(
            snapshot(&db).unwrap().connections[0]
                .credential_ref
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        doc.connections[0].config["password"] = "rotated-native-test-secret".into();
        save(&mut db, doc, &vault).unwrap();
        assert!(vault.get(&previous).is_err());
        drop(db);
        let mut db = open(&path, &vault).unwrap();
        let mut doc = loaded(&mut db, &vault);
        assert_eq!(
            doc.connections[0].config["password"],
            "rotated-native-test-secret"
        );
        let current = CredentialRef::parse(
            snapshot(&db).unwrap().connections[0]
                .credential_ref
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        doc.connections.clear();
        save(&mut db, doc, &vault).unwrap();
        assert!(vault.get(&current).is_err());
        let bytes = std::fs::read(path).unwrap();
        assert!(
            !bytes
                .windows(26)
                .any(|w| w == b"rotated-native-test-secret")
        );
    }
}

/// Copy and verify every live credential before publishing the new backend.
pub(super) fn migrate_provider(
    db: &mut Connection,
    source: &dyn Vault,
    target: &dyn Vault,
) -> Result<(), JsError> {
    if source.provider() == target.provider() {
        return Ok(());
    }
    let mut prepared = Vec::new();
    let revision;
    {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let document = snapshot(&tx)?;
        revision = document.revision;
        if super::credential_backends::provider(&tx)? != source.provider() {
            return Err(failure("STORE_CONFLICT", "Credential backend changed"));
        }
        for reference in document
            .connections
            .iter()
            .filter_map(|c| c.credential_ref.as_deref())
        {
            let reference = CredentialRef::parse(reference)?;
            let bytes = source.get(&reference)?;
            tx.execute("INSERT INTO credential_gc(reference,not_before,provider) VALUES(?1,unixepoch()+86400,?2) ON CONFLICT(reference,provider) DO UPDATE SET not_before=excluded.not_before",params![reference.encode(),target.provider()]).map_err(store_error)?;
            prepared.push((reference, bytes));
        }
        tx.commit().map_err(store_error)?;
    }
    let result = (|| {
        for (reference, bytes) in &prepared {
            target.put(reference, bytes)?;
        }
        target.flush()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let actual: i64 = tx
            .query_row("SELECT revision FROM store_meta WHERE id=1", [], |row| {
                row.get(0)
            })
            .map_err(store_error)?;
        check_revision(actual, revision)?;
        if super::credential_backends::provider(&tx)? != source.provider() {
            return Err(failure("STORE_CONFLICT", "Credential backend changed"));
        }
        for (reference, bytes) in &prepared {
            if target.get(reference)?.as_slice() != bytes.as_slice() {
                return Err(failure(
                    "CREDENTIAL_INVALID",
                    "Migrated credential verification failed",
                ));
            }
            tx.execute(
                "DELETE FROM credential_gc WHERE reference=?1 AND provider=?2",
                params![reference.encode(), target.provider()],
            )
            .map_err(store_error)?;
            tx.execute("INSERT INTO credential_gc(reference,not_before,provider) VALUES(?1,0,?2) ON CONFLICT(reference,provider) DO UPDATE SET not_before=0",params![reference.encode(),source.provider()]).map_err(store_error)?;
        }
        tx.execute(
            "UPDATE credential_settings SET provider=? WHERE id=1",
            [target.provider()],
        )
        .map_err(store_error)?;
        tx.execute("UPDATE store_meta SET revision=revision+1 WHERE id=1", [])
            .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(())
    })();
    if result.is_err() {
        for (reference, _) in &prepared {
            let _ = db.execute(
                "UPDATE credential_gc SET not_before=0 WHERE reference=?1 AND provider=?2",
                params![reference.encode(), target.provider()],
            );
        }
        let _ = collect_garbage(db, target);
    } else {
        let _ = collect_garbage(db, source);
    }
    result
}

#[cfg(test)]
mod keepass_tests {
    use super::tests::{TestVault, document, loaded};
    use super::*;
    use crate::native::keepass_vault::{self, KeePassVault};
    #[test]
    fn keepass_backend_migration_preserves_and_retires_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let datadir = dir.path();
        let path = datadir.join(FILE_NAME);
        let native = TestVault::default();
        let mut db = open(&path, &native).unwrap();
        save(&mut db, document(), &native).unwrap();
        let master = "test-master-password";
        let keepass =
            KeePassVault::create_or_unlock(datadir, master.into(), Some(master.into())).unwrap();
        migrate_provider(&mut db, &native, &keepass).unwrap();
        assert_eq!(
            super::super::credential_backends::provider(&db).unwrap(),
            "keepass"
        );
        assert_eq!(
            loaded(&mut db, &keepass).connections[0].config,
            document().connections[0].config
        );
        assert!(native.values.borrow().is_empty());
        let mut doc = loaded(&mut db, &keepass);
        doc.connections[0].config["password"] = "updated-keepass-credential".into();
        save(&mut db, doc, &keepass).unwrap();
        let keepass = KeePassVault::cached(datadir).unwrap();
        assert_eq!(
            loaded(&mut db, &keepass).connections[0].config["password"],
            "updated-keepass-credential"
        );
        migrate_provider(&mut db, &keepass, &native).unwrap();
        assert_eq!(
            super::super::credential_backends::provider(&db).unwrap(),
            "native"
        );
        assert_eq!(
            loaded(&mut db, &native).connections[0].config["password"],
            "updated-keepass-credential"
        );
        let reference = CredentialRef::parse(
            snapshot(&db).unwrap().connections[0]
                .credential_ref
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        assert!(
            KeePassVault::cached(datadir)
                .unwrap()
                .get(&reference)
                .is_err()
        );
        keepass_vault::lock(datadir);
    }
    #[test]
    fn failed_keepass_backend_switch_keeps_source_and_selection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let native = TestVault::default();
        let mut db = open(&path, &native).unwrap();
        save(&mut db, document(), &native).unwrap();
        struct Failing;
        impl Vault for Failing {
            fn provider(&self) -> &'static str {
                "keepass"
            }
            fn get(&self, _: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
                Err(failure("KEEPASS_IO", "Test error"))
            }
            fn put(&self, _: &CredentialRef, _: &[u8]) -> Result<(), JsError> {
                Err(failure("KEEPASS_IO", "Test error"))
            }
            fn delete(&self, _: &CredentialRef) -> Result<(), JsError> {
                Ok(())
            }
        }
        assert!(migrate_provider(&mut db, &native, &Failing).is_err());
        assert_eq!(
            super::super::credential_backends::provider(&db).unwrap(),
            "native"
        );
        assert_eq!(
            loaded(&mut db, &native).connections[0].config,
            document().connections[0].config
        );
    }
}

pub(super) fn cleanup_native_after_keepass(
    db: &mut Connection,
    vault: &dyn Vault,
) -> Result<(), JsError> {
    if vault.provider() != "keepass" || super::credential_backends::provider(db)? != "keepass" {
        return Ok(());
    }
    for reference in snapshot(db)?
        .connections
        .iter()
        .filter_map(|c| c.credential_ref.as_deref())
    {
        let reference = CredentialRef::parse(reference)?;
        let _ = Secrets::decode(&vault.get(&reference)?)?;
    }
    vault.flush()?;
    collect_garbage(db, &NativeVault)
}

#[cfg(test)]
mod native_keepass_integration {
    use super::tests::{document, loaded};
    use super::*;
    use crate::native::keepass_vault::{self, KeePassVault};
    #[test]
    #[ignore = "explicit native Keychain to KeePass and back; cleans isolated credentials"]
    fn native_keychain_keepass_master_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let native = NativeVault;
        let mut db = open(&path, &native).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                keepass_vault::lock(self.0.parent().unwrap());
                if let Ok(db) = Connection::open(&self.0) {
                    if let Ok(mut query)=db.prepare("SELECT credential_ref FROM connections WHERE credential_ref IS NOT NULL UNION SELECT reference FROM credential_gc"){if let Ok(rows)=query.query_map([],|row|row.get::<_,String>(0)){for value in rows.flatten(){if let Ok(reference)=CredentialRef::parse(&value){let _=NativeVault.delete(&reference);}}}}
                }
            }
        }
        let _cleanup = Cleanup(path.clone());
        save(&mut db, document(), &native).unwrap();
        let reference = CredentialRef::parse(
            snapshot(&db).unwrap().connections[0]
                .credential_ref
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        let master = "native-migration-test-master";
        let keepass =
            KeePassVault::create_or_unlock(dir.path(), master.into(), Some(master.into())).unwrap();
        migrate_provider(&mut db, &native, &keepass).unwrap();
        assert!(native.get(&reference).is_err());
        assert_eq!(
            loaded(&mut db, &keepass).connections[0].config,
            document().connections[0].config
        );
        drop(keepass);
        keepass_vault::lock(dir.path());
        assert!(super::super::credential_backends::selected(&path).is_err());
        let keepass = KeePassVault::unlock(dir.path(), master.into()).unwrap();
        migrate_provider(&mut db, &keepass, &native).unwrap();
        assert_eq!(
            loaded(&mut db, &native).connections[0].config,
            document().connections[0].config
        );
        assert!(keepass.get(&reference).is_err());
        let mut doc = loaded(&mut db, &native);
        doc.connections.clear();
        save(&mut db, doc, &native).unwrap();
        assert!(native.get(&reference).is_err());
    }
}

#[cfg(test)]
mod provider_upgrade_tests {
    use super::tests::{TestVault, document, loaded};
    use super::*;
    #[test]
    fn schema_two_upgrades_without_losing_native_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let native = TestVault::default();
        let mut db = open(&path, &native).unwrap();
        save(&mut db, document(), &native).unwrap();
        let reference = snapshot(&db).unwrap().connections[0]
            .credential_ref
            .clone()
            .unwrap();
        db.execute_batch("DROP TABLE credential_settings; CREATE TABLE credential_gc_v2(reference TEXT PRIMARY KEY,not_before INTEGER NOT NULL); DROP TABLE credential_gc; ALTER TABLE credential_gc_v2 RENAME TO credential_gc; PRAGMA user_version=2;").unwrap();
        db.execute("INSERT INTO credential_gc VALUES(?1,0)", [reference])
            .unwrap();
        drop(db);
        let mut db = open(&path, &native).unwrap();
        assert_eq!(
            super::super::credential_backends::provider(&db).unwrap(),
            "native"
        );
        assert_eq!(
            loaded(&mut db, &native).connections[0].config,
            document().connections[0].config
        );
        assert_eq!(native.values.borrow().len(), 1);
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn backend_publish_conflict_preserves_source_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let native = TestVault::default();
        let mut db = open(&path, &native).unwrap();
        save(&mut db, document(), &native).unwrap();
        struct Target {
            values: TestVault,
            path: std::path::PathBuf,
        }
        impl Vault for Target {
            fn provider(&self) -> &'static str {
                "keepass"
            }
            fn get(&self, r: &CredentialRef) -> Result<Zeroizing<Vec<u8>>, JsError> {
                self.values.get(r)
            }
            fn put(&self, r: &CredentialRef, b: &[u8]) -> Result<(), JsError> {
                self.values.put(r, b)?;
                Connection::open(&self.path)
                    .unwrap()
                    .execute("UPDATE store_meta SET revision=revision+1", [])
                    .unwrap();
                Ok(())
            }
            fn delete(&self, r: &CredentialRef) -> Result<(), JsError> {
                self.values.delete(r)
            }
        }
        let target = Target {
            values: TestVault::default(),
            path: path.clone(),
        };
        assert!(migrate_provider(&mut db, &native, &target).is_err());
        assert_eq!(
            super::super::credential_backends::provider(&db).unwrap(),
            "native"
        );
        assert_eq!(
            loaded(&mut db, &native).connections[0].config,
            document().connections[0].config
        );
        assert!(target.values.values.borrow().is_empty());
    }
}
