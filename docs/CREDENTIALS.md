# Credential storage settings

Open Settings → Keys & credentials. Credential actions have their own apply,
lock and password-update controls and take effect immediately. They are separate
from the general Preferences Save & apply, cancel, reset and JSON export.

## Backends and files

- **Native Keychain** on macOS stores one randomly generated key per Ferrix
  data directory in the login Keychain as “Ferrix Credential Vault”. Each
  credential record in `${dataDir}/native-credentials.sqlite3` is independently
  authenticated and encrypted with AES-256-GCM. Windows uses Credential Manager
  and Linux uses Secret Service.
- **KeePass** uses `${dataDir}/credentials.kdbx`. The file is standard KDBX 4.1
  with AES-256 outer encryption, protected entry fields and Argon2id (64 MiB,
  three iterations, two lanes). It can be read by independent KeePass readers.

The selected provider is persisted in `credential_settings` in
`${dataDir}/app.sqlite3`, schema version 3. Connection metadata remains
in the application SQLite database alongside opaque references. The KeePass
master password stays in zeroed native process memory while unlocked. The UI
clears password inputs when an action finishes or its view closes.

Creating a KeePass file requires matching master passwords of at least eight
characters. Existing files require their current master password; they are never
overwritten to reset a forgotten password. The file path is currently fixed to
datadir; selecting unrelated KeePass files and key-file authentication are not
part of this implementation.

The Rust `keepass` dependency's KDBX writer is currently marked experimental
upstream. Generated KDBX 4.1 files are verified with the independent PyKeePass
reader, including protected credential contents and encryption/KDF identifiers.

## Unlocking and password changes

On macOS, Ferrix reads the login Keychain key on demand and keeps it in zeroed
memory only for the current storage operation. Choose “Always Allow” for that
item to authorize future reads by the same signed app. App releases need a
stable signing identity for macOS to reuse that authorization across updates.
Loading the connection list or settings does not request Keychain access.

KeePass starts locked after a process restart. Unlock it in credential settings
before creating or testing new connections. Locking drops the cached master
password, invalidates pending Connection Hub connections and clears the Hub's
cached secrets. Established Redis Sessions remain connected and own their
existing authentication context. A native check guards new connect/test actions
against a locked KeePass vault.

Changing the master password requires the current password and matching new
passwords. The entire existing database is re-encrypted and verified under the
new password before replacement. A wrong current password leaves the file intact.
A forgotten master password cannot be recovered by Ferrix.

## Migration and failure behavior

Existing macOS credentials are upgraded one connection at a time on first use.
macOS can still prompt for the old Keychain entries while reading them. The new
record is written and verified before the connection reference is switched.
Legacy cleanup is retried during a later save. Older Ferrix builds cannot open
the upgraded references.

Switching copies all referenced credentials to the target, persists them and
reads them back, then publishes the new provider in a SQLite transaction with
an expected revision. Source credentials are retired after commit. If either
store or the SQL transaction fails before commit, the original provider and
credentials remain usable. Cleanup retries are tagged with the store they
belong to, so they cannot delete active entries in another backend.

KDBX writes go to an encrypted, owner-only temporary file. The file is synced,
reopened and verified, and atomically renamed over the previous file. A fingerprint
check rejects external changes before overwriting. A datadir lock serializes
connection saves, backend switches, locking and password changes across Ferrix
processes. No plaintext temporary vault or plaintext backup is created.

For macOS Native Keychain, back up `app.sqlite3`, `native-credentials.sqlite3`,
and the matching login Keychain item together. Losing that item prevents
decryption of the corresponding vault. For KeePass, back up the SQLite
configuration and its matching KDBX file. File-system backups made before the
earlier plaintext migration are outside the live-database cleanup.

## Implementation and validation

- `src/native/keepass_vault.rs`: KDBX, master-password lifecycle and atomic writes.
- `src/native/credential_settings.rs`: native settings API.
- `src/native/credential_backends.rs`: provider selection.
- `src/native/app_store.rs`: application SQLite lifecycle, schema migration,
  credential settings and credential migration.
- `src/data/credential-settings.ts` and `src/pages/settings/credential-settings-section.tsx`:
  reactive settings and the native settings section.

`cargo test --lib` covers encryption, wrong passwords, password rotation, external
file changes, backend migration, rollback and previous SQLite guarantees.
`cargo test --lib native_keychain -- --ignored` explicitly tests actual OS-store
migration with isolated, automatically cleaned test entries. The independent
reader test is opt-in using `FERRIX_KEEPASS_VERIFY_PYTHON` pointing to Python with
PyKeePass installed. UI tests cover the settings workflow, search and exclusion
of master passwords from exported JSON. Native macOS verification exercises the
actual settings API with an isolated datadir.
