# Connection Hub

The native entry point opens Connection Hub. The layout and form follow
`prototypes/connection-hub/`: organization navigation, grouped connection rows,
a configuration detail panel, a connection editor and a group/tag manager.
The React prototype remains a standalone design reference.

The native Hub follows the prototype's ledger layout: a 228-point organization
sidebar and compact 65-point connection rows. Selecting a connection opens its
details in a right-edge drawer over the list. The drawer slides in and out using
NSH's native `Sheet`, respects reduced motion, and closes with its close button,
Escape or a backdrop press. Closing retains the selected connection and returns
keyboard focus to its row; the list uses all available width while the drawer
is closed. Both the drawer and its backdrop start below the native title bar,
leaving the window controls and theme switch accessible.
The connection editor uses the same three tabs and colocated
group/tag controls;
the organization manager uses searchable rows with explicit per-row saving.
Narrow windows provide a filter sheet and the same closable detail drawer.
Only the remaining layout and interactions follow the prototype. Typography,
colors, controls and selection styling use the existing application conventions
shared with Settings; there is no separate Hub palette. See
[the native comparison](../design-qa.md) for captures and verification.

## Ownership

`app.tsx` creates `createConnectionHub()` once. The controller in
`src/data/connections/connection-state.ts` owns saved configurations and live Sessions
across page changes. Views under `src/pages/connections/` own search, selection, drafts
and dialogs. Persistence goes through `AppStore.loadConnections` and
`AppStore.saveConnections` in `src/native/app_store.rs`. This application storage
module also owns SQLite lifecycle, schema migrations and credential settings.

`Redis.connectStandalone`, `connectCluster` and `connectSentinel` perform real
network connections. Test connection opens an independent Session, sends PING
and disposes it in a finally block. Saving alone makes no network request.
Save & connect saves first; a failed connection leaves the configuration saved
and keeps the editor open. Errors shown in the UI use stable codes and never
include credentials or server diagnostics.

Live Sessions are independent of saved configurations. Deleting a saved group,
tag or configuration does not close an open Session. Connecting an edited
configuration replaces its existing Session only after the new Session succeeds.
Each connection row has a **More actions** menu. Connected rows offer
**Close connection** in this menu. Confirmation
warns that the Workspace and its unsaved changes will be discarded. Closing
releases and disposes that Session, preserves its saved configuration, and selects
another open Session if the active one was closed. Closing the app closes and
disposes all Sessions. The connected workspace offers
progressive, bounded key scanning and live metadata; String values have a read-only
64 KiB preview. The original sample editor under `ui/` is not mounted and does
not represent live Redis data.

## Slow logs

Each connection row's **More actions** menu offers **Query slow log**, including
disconnected connections. Opening it creates an
independent Session from the saved Connection Configuration, including its
credentials, TLS, SSH, proxy and deployment mode. It works without opening a
Workspace or replacing an existing Session. Refreshes reuse this private Session;
closing the dialog or leaving the page closes and disposes it. A connection or
query completing after dismissal cannot populate a later dialog.

The panel queries the latest 10, 50, 100 or 200 entries, defaults to 50 and refreshes
on request. It displays execution duration, timestamp, ID, command arguments and
available client address/name. Keyword filtering applies to the fetched entries.
Commands can be copied with binary-safe Redis argument quoting. Exact IDs and
microsecond durations cross the native bridge as decimal strings. Redis may
already have truncated logged arguments; copied commands represent the recorded
arguments, not necessarily the original request.

Queries only issue `SLOWLOG GET` and optional `SLOWLOG LEN`; they do not change
logging thresholds or clear logs. The account needs `SLOWLOG GET` permission.
If `SLOWLOG LEN` is unavailable, entries remain visible without a total count.
Permission errors, oversized replies, empty logs and empty filtered results have
separate states. Refresh errors retain the last successful snapshot. There is no
background polling or persisted slow-log history.

Slow logs belong to the server, across its logical databases. Cluster results
describe one identified node, rather than an aggregate of all nodes. The native
reader uses the Session background lane, validates the 1–200 entry limit, enforces
the configured response budget (256 KiB by default), and retries a recoverable
transport failure once. Legacy replies without client fields and newer replies
with original argument counts are both supported. The selected database is not
changed.

Implementation: `src/native/redis/slowlog.rs` and the page-local
`slowlog-dialog.tsx`, `slowlog-state.ts`, `slowlog-values.ts`. Tests:
`tests/redis-slowlog.rs`, `tests/slowlog.test.tsx`. Redis command references:
[SLOWLOG GET](https://redis.io/docs/latest/commands/slowlog-get/) and
[SLOWLOG LEN](https://redis.io/docs/latest/commands/slowlog-len/).

## SSH host fingerprints

For a new SSH gateway, **Test Connection** and **Save & Connect** show the
gateway address and fingerprint before SSH login. Check the fingerprint with
the gateway administrator and choose **Trust and continue**. Saving keeps the
approved fingerprint with the connection settings. Future connections reject a
different key. If your administrator has rotated the key, **Test Connection**
offers **Verify SSH host again** after a mismatch.

SSH login supports Ed25519, ECDSA and 2048–4096-bit RSA private keys. RSA login
uses SHA-2 signatures. RSA keys can be supplied in OpenSSH or PEM format.

## Network proxy

The connection editor's Advanced tab supports System, SOCKS5 or HTTP CONNECT
proxy modes, disabled by default for both new and existing configurations. In manual modes, set the host,
port and optional username/password pair. SOCKS5 supports no authentication or
username/password authentication; HTTP CONNECT supports optional Basic proxy
authentication. Both connect to the proxy over TCP and resolve destination
hostnames at the proxy. Hosts must be ASCII DNS names or IP addresses.

System mode ignores saved manual endpoints and credentials. Each new socket reads
the current settings, including bypass rules: CFNetwork on macOS, the active user's
Internet Settings on Windows, and environment variables followed by GNOME GSettings
on Linux. Linux environment lookup uses `all_proxy`, `http_proxy`, `https_proxy`
(or uppercase equivalents) and `no_proxy`. A disabled system proxy or an excluded
destination connects directly. A failed proxy never falls back to direct.
PAC/WPAD and proxy protocols other than SOCKS5/HTTP CONNECT are currently rejected
with a specific unsupported-configuration error; configure a manual proxy instead.
System credentials are transient and do not enter saved connection configuration.

The proxy applies to testing, both Session lanes, reconnects, database changes,
dedicated target-database creation, Cluster discovery/redirects and Sentinel
discovery/data nodes. With SSH enabled the path is proxy → SSH gateway → Redis;
the SSH host key is still pinned. Redis/Sentinel TLS runs inside the tunnel and
verifies the original endpoint identity. Failure never falls back to a direct
connection. Proxy negotiation shares the existing overall setup deadline, caps
HTTP response headers at 8 KiB and returns credential-free error categories.

Proxy passwords join the selected Native Keychain/KeePass credential store and
are removed from configuration JSON and redacted exports. The original seven-field
credential bundles remain readable; no SQLite schema migration is required.

Protocol references: [SOCKS5](https://www.rfc-editor.org/rfc/rfc1928),
[SOCKS5 authentication](https://www.rfc-editor.org/rfc/rfc1929),
[HTTP CONNECT](https://www.rfc-editor.org/rfc/rfc9110.html#name-connect).

## SQLite and datadir

The shared application database is **`${dataDir}/app.sqlite3`**, with `app.lock`
serializing datadir operations. The directory is provided
by NSH as the injected Rust `System.data_dir`; Ferrix does not derive a location
from the working directory or fall back to an in-memory database. Missing datadir
or write failures are visible in the Hub and require a successful reload before
editing. Development hosts and packaged apps may supply different datadirs.

Schema version 3 contains `connections`, `connection_groups`, `tags`,
`connection_tags`, `store_meta`, `credential_gc`, `credential_meta` and
`credential_settings`.
Configuration JSON stores mode-specific endpoints, usernames, public TLS certificates,
SSH settings, database and timeouts. `connections.credential_ref` holds an opaque
reference to secrets in the native credential store. Password and private-key fields
in SQLite are empty.
Favorites and all organization associations persist. No example connections are
inserted on first launch. Preferences and language keep their existing NSH
Storage behavior.

Each save uses an immediate SQLite transaction with foreign keys and an expected
revision. A stale window fails with `STORE_CONFLICT`; reload before reapplying
its edit. A failed transaction leaves the previous document intact. Unknown
future schema versions are rejected without modification. Native I/O runs on a
storage worker, away from the UI thread.

The SQLite file is created with owner-only `0600` permissions on Unix;
Windows inherits the datadir's ACL. The default backend uses the platform's native store:
macOS Keychain, Windows Credential Manager, and Linux Secret Service (an available,
unlocked desktop service is required). There is no plaintext or in-memory production
fallback. Unsupported platforms and denied/locked stores return a visible error.
Settings also supports a master-password-protected KeePass file in datadir. See
[CREDENTIALS.md](CREDENTIALS.md) for selection, unlock and migration behavior.

Redis and Sentinel passwords, both TLS client private keys, the SSH password,
SSH private key and its passphrase are stored together in an immutable credential
generation. Public certificates and usernames stay in SQLite. macOS protects
separately encrypted generations with a single login Keychain key. The remaining
native backends use 2048-byte entries to accommodate Windows' credential blob limit.
Only opaque random references and cleanup metadata go into SQLite. Loading or
reloading the connection list reads SQLite. Editing or opening a connection
reads the credential for that connection. Serialized secret buffers are zeroed
when released by the Rust credential adapter.

Saving records a durable preparation reference, writes and reads back the new
native entry, then commits its SQLite pointer after rechecking the document revision.
An OS-store or SQL failure retains the previous configuration and credential
generation. Changes to groups, tags or favorites reuse unchanged credentials.
Superseded/deleted generations are removed after commit. A denied deletion is
queued for retry on the next save. Abandoned preparation entries are collected
after a 24-hour lease, with a final native-entry check before a pointer can commit.
Active references are never collected.

Version 1 plaintext configurations migrate when a connection is opened for use
or when the database is saved. The connection list hides legacy secrets while
waiting for migration.
Credentials must reach the native store before their SQLite fields are cleared.
Denied migration leaves the original data and schema version available for retry;
it never silently substitutes unauthenticated settings. Successful migration enables
secure deletion, checkpoints/removes WAL contents and vacuums old SQLite pages.
A durable scrub marker retries interrupted cleanup before the database is used.
This cleans the live database; pre-existing filesystem backups or snapshots are
outside the migration. No plaintext backup is created. A SQLite-only backup does
not contain credentials and will need its matching native credential store.

## Organization rules

A configuration has at most one group and any number of tags. Group and tag names
are trimmed, limited to 30 characters and deduplicated using NFKC normalization
and lowercase. A connection name is limited to 100 characters. The system
Ungrouped item cannot be edited or deleted.

The connection form places group and tags in the same section. Both selectors
have direct creation controls, work with empty collections and offer creation
for unmatched search text. Creation saves immediately and selects the new item;
cancelling the connection editor keeps newly created organization items.

Deleting a group relocates its connections to Ungrouped. Deleting a tag removes
only its associations. Both actions show affected connections before confirmation.

## Validation

`nsh check`, `cargo fmt -- --check` and `nsh test` are the repository gates.
Native unit tests cover reopening, credential separation, relationships, permissions,
failed keychain/SQL writes, conflict handling, rotation/deletion, queued cleanup,
plaintext migration, raw SQLite page scrubbing and future schema versions.
The ignored native-keychain test can be run explicitly to verify multi-entry
write/read/delete against the actual OS store. `tests/connection-hub.test.tsx`
covers inline creation, save/restore, filtering, deletion semantics, Session
closing/reconnection and Cluster seed input using an isolated test store. Native
macOS runs exercise platform input separately from headless testing.
