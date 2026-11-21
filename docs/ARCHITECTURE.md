# Ferrix Architecture

Ferrix uses nsh mixed mode with one Rust crate and one TSX source tree.
The product targets macOS, Windows and Linux desktops, with macOS verification
on the development machine.

## Entry points and dependencies

```text
app.tsx -> src/app.tsx -> src/pages/<page>/
                         src/components/
                         src/data/ -> ferrix/native
                         src/utils/         |
                         src/i18n.ts        |
                         src/fonts.ts       |
                           src/lib.rs -> src/native/
```

The root `app.tsx` calls `mount(App)` once. `src/app.tsx` composes the shell and
owns navigation, preferences, language and the Connection Hub controller.
Pages live under `src/pages/`, grouped into `connections/`, `workspace/`,
`settings/`, `pubsub/`, `monitoring/` and `help/`. Each page keeps its private controls, content and
presentation helpers together. Shared controls live under `src/components/`;
reusable error and window helpers live under `src/utils/`. Application-wide
localization and font definitions stay at the `src/` root, with runtime assets
under `src/assets/`.

Shared state and data operations live under `src/data/`. The `connections/`
module separates configuration models and validation (`connection-model.ts`),
native connection calls (`connection-client.ts`), and saved/live connection
ownership (`connection-state.ts`). Preferences and credential configuration each
have their own module alongside it. Data modules and generic controls do not
import pages; pages do not import another page's private implementation. Keep
domain-specific helpers with their owner instead of collecting them in `utils/`.

Connection configurations, groups and tags use Rust-owned SQLite in the host's
datadir. Live Sessions belong to the app-level controller and survive page
changes; view-local drafts and filters belong to their components. See
[CONNECTIONS.md](CONNECTIONS.md) for storage, lifecycle and validation details.

The navigation rail's Console route expands the active Session's existing terminal
across the workspace, hiding the Key browser and Key tab strip. The workspace's
own Terminal tab keeps the normal split layout. Both entry points share console
history and input, and returning to Keys preserves its tabs, drafts and panel state.
The Key browser starts its initial scan/catalog reads only when its Workspace is
active outside the fullscreen CLI. CLI structure hints do not consume Key data.
The Rust `KeyInventory` keeps SCAN results in byte slabs with numeric metadata
and deduplicates by binary key. The folder index references slots, using ranges
for contiguous runs. The native `KeyRows` component reads the same inventory
instance and renders only viewport rows. Rust owns row styles, tree navigation
and context menus. TSX owns the search, database and scan controls and handles
the component's key and folder actions. Stopping a Key Scan releases its native
continuation and keeps the loaded keys. Restarting begins a fresh scan with the
current filter.

`src/native/redis/console.rs` owns the CLI's isolated, cancellable socket, preserving
connection-local commands without contaminating browser lanes. Its bounded RESP
framer also receives streaming output. Command catalogs/documentation use the
existing background lane; argument parsing, completion and retained presentation
state stay private to `src/pages/workspace/`. See [CLI.md](CLI.md).

`src/native/app_store.rs` owns the application SQLite lifecycle, schema migrations
and storage worker. The shared database currently holds connection configurations,
groups, tags and credential settings. Its native `AppStore` module exposes
`loadConnections` and `saveConnections` for the Hub; further application data can
add explicit operations at the same storage boundary. The database is stored at
`${dataDir}/app.sqlite3`, with `app.lock` serializing datadir operations.

The Connection Hub's slow-log dialog owns a private, temporary Session built by
`connection-client.ts`. Its page-local state owns the latest snapshot, filter and
selection; dismissal releases the Session and ignores late completions. Native
`redis/slowlog.rs` reads bounded server/node logs on the Session background lane.
It preserves binary arguments and exact integer fields without modifying logging
settings. See [CONNECTIONS.md](CONNECTIONS.md#slow-logs) for scope and limits.

Keep `#[native_module("ferrix/native")]` at the crate root in `src/lib.rs`.
The registration function selects the exported components, modules and classes;
their implementations live in `src/native/`.

Monitoring's client-count action queries `redis/clients.rs` using its existing
Session background lane. Its page-local dialog/state owns the filtered snapshot
and selection, and is disposed when monitoring becomes inactive. It neither
creates nor closes a Session. Both this dialog and Connection Hub dialogs use the
shared native container in `src/components/modal.tsx`. See [MONITORING.md](MONITORING.md#connected-client-details).

Monitoring's key analysis discovers all databases and owns one private Session
opened by `RedisSession.openDatabaseSession`. The native factory preserves the
parent's security/discovery options; switching the private Session never mutates
the Workspace's selected database. `database-analysis.ts` combines bounded per-DB
scans from `key-analysis.ts`, retaining per-database memory/status, aggregate
observations and 20 ranked keys with database-qualified identities. Cancellation
and late replies are handled by `analysis-state.ts`. Cluster covers DB 0 across
all primaries. See [MONITORING.md](MONITORING.md#key-performance-analysis).

Ranked-key navigation goes through the application composition in `src/app.tsx`.
Monitoring emits the connection ID, database and binary key; the app sends a
Session-qualified target to the Workspace and selects the Keys page. The
Workspace consumes that target through its existing switch, draft-confirmation
and detail-tab flows. Monitoring never directly switches the shared Session.

`Version.getVersion()` reports the Rust package version from
`Cargo.toml`; `nsh.json` separately describes the application package.

RedisJSON uses `src/native/redis/json.rs` on the existing Session lanes. Key
details and metadata normalize the module type `ReJSON-RL` to `json`; Key Scans
map the public `json` filter back to Redis's module name. Whole-document reads
and JSONPath match arrays have separate presentation state in the inspector.
Only complete documents can be edited directly. JSONPath results are read only,
with explicit set/delete dialogs applying to the reviewed path and every match.
Returning to the document preserves its draft. Path writes require a clean
document draft. Large documents can still be queried and changed at bounded
paths. Reads use atomic TYPE/JSON.GET/PTTL; writes check existence and type in
the same Lua operation, preserve TTL and never recreate a vanished document.
JSON text crosses the native bridge without parsing numbers in JavaScript.

The String inspector offers independent decoding and decompression selectors.
`src/pages/workspace/value-codecs.ts` adapts the `ValueCodec` native module;
`workspace-state.ts` keeps each tab's preview separate from its original bytes
and raw draft. Decoded text and MessagePack JSON have their own editable draft
and acknowledged baseline; decoded binary Hex remains read only. Views survive
tab switches and reapply after reload. Save runs the inverse codec pipeline
before the existing binary `setString` operation, which preserves TTL by default.
Encoding failure leaves the draft intact and sends no Redis write. An uncertain
write retains the draft and cannot be replayed; edits made while a save is pending
remain dirty after acknowledgement. Save or undo decoded edits before changing
codecs or restoring the original view. A revision and the
Workspace epoch prevent obsolete results from replacing a newer preview.
`src/native/value_codec.rs` runs local transformations on bounded worker threads,
without touching Redis. Complete inputs are limited to 64 KiB and output to
1 MiB; partial String ranges cannot be transformed. Edited text is limited to
1 MiB and the re-encoded value to 64 KiB, matching the complete-value read limit.

Gzip, Zstd, LZ4 Frame, LZ4 with a four-byte little-endian decoded-size prefix,
Zlib, raw Deflate, and raw/framed Snappy are supported. Base64, Base64 URL,
Hex and URL percent decoding run before decompression; MessagePack parsing runs
after it. MessagePack previews retain integer literals, map order and duplicate
string keys. JSON-incompatible values use tagged objects: `$binary` and
`$invalidUtf8` contain Hex, `$ext` holds `type` and Hex `data`, `$map` holds
ordered key/value pairs, and `$float` holds nonfinite values as strings.
MessagePack encoding parses raw JSON numbers and ordered map entries, preserving
64-bit integer precision and duplicate keys. Original values supply type hints
for float width, nonfinite payloads, and ordinary maps whose keys resemble the
tagged notation. Binary and extension tags are validated before any Redis write.
Snappy framed/raw and Base64 padding variants follow the original source.

Pickle uses the Rust `deser-pickle` machine, which records data without importing
or calling Python code. The same editable JSON view and inverse compression
pipeline support Python dictionaries (in insertion order), lists, tuples, sets,
frozensets, bytes, bytearrays, arbitrary-size integers and nonfinite floats.
JSON tags `$tuple`, `$set`, `$frozenset`, `$bytes`, `$bytearray`, `$dict`
and `$float` retain types that JSON cannot express. Original ordinary dictionaries
whose keys resemble tags remain ordinary dictionaries.

Pickle protocols 0–5 are read. Saves preserve protocol headers 2–5; headerless
legacy inputs use protocol-0-compatible output, readable by the same Python
versions. Custom objects, cyclic/shared containers, persistent IDs and external
buffers are rejected without enabling a write. Deserialization has depth, event,
payload and shared-expansion limits in addition to the common codec byte limits.
Python-generated fixtures and a Python cross-check cover built-in types and
protocol compatibility; Python is not a production dependency.

The crate-root `#[native_components(macos)]` entry also initializes the appearance
of Ferrix's own AppKit host before its first background pass. The implementation
in `src/native/window.rs` reads the compile-time `nsh.json` and applies its
appearance process-locally. This covers the development host's pre-bundle period;
normal per-surface theme switching continues through NSH. It exposes no TS API.

`src/native/redis.rs` implements the `Redis` module, generated lifecycle DTOs
and the owned `RedisSession` class. Its dedicated Tokio runtime owns each
Session's independent interactive/background transport lanes and bounded request
registration; the NSH engine only performs
local admission/context reads and awaits bounded results. Explicit close and
native class disposal share cancellation. Keep subsequent Redis operations on
this worker boundary; `async fn` alone would still poll work on NSH's engine.
See [the implemented lifecycle contract](REDIS_API.md#implemented-standalone-lifecycle).

`src/native/redis/scan.rs` owns progressive Key Scan state and one Session-scoped
continuation pool. Key, Hash and Set scans share admission, retained
reply accounting and lifecycle invalidation through this pool. Scan pages use
the bounded background lane alongside selected metadata; cancellation also
settles the native Promise locally without waiting for a server response.
Reconnect generation changes go through `SessionState::advance_generation` so
old continuations release resources and cannot publish stale pages.
`src/native/redis/continuation.rs` shares local scan admission, generation checks,
failure/cancellation settlement and bounded retained-reply draining. Hash and Set
reuse its one-cursor progress state; Key Scan keeps its aggregate Cluster
progress and command preparation in `scan.rs`. These private helpers perform no
network work and hold no progress lock across an await.
`src/native/redis/hashes.rs` owns binary Hash scans and mutations. Hash scans use
the same continuation pool and cancellation lifecycle as Key Scans, retain excess
compact HSCAN replies within shared quotas and never collect visited fields.
`src/native/redis/lists.rs` owns bounded binary List ranges and in-place edits.
Ranges use exact offset/count requests without retained cursors; their atomic
same-Key read pipeline and non-replayed writes use the shared Connection adapter.
`src/native/redis/sets.rs` owns binary Set scans and membership mutations. It uses
the shared continuation pool and preserves complete compact SSCAN replies across
bounded pages; in-place SADD/SREM preserve TTL and exact affected counts.
Set operations use the common Connection adapter with an explicit routing Key;
generation-bound SSCAN transactions cannot replay after transport replacement.
`src/native/redis/zsets.rs` owns bounded binary ZSet rank pages and member/score
edits. Rank pages share exact offset/count validation with Lists and read
cardinality, scores and TTL in one same-Key transaction. ZADD CH/ZREM edits use
the common mutation dispatch path and never replay an uncertain write.

`src/native/redis/streams.rs` owns Stream history pages and explicit message writes. XRANGE, XLEN
and TTL share a same-Key transaction; pages retain exact string IDs and ordered
binary field/value pairs, including repeated names. An exclusive `after` ID
advances the history without consuming or acknowledging messages. Each page has
at most 200 messages and a byte budget. XADD appends ordered binary fields and
returns the acknowledged exact ID; XDEL removes the entire selected message.
Both share mutation admission and unknown-outcome handling, without replay.
The workspace uses a dedicated table, an add-message dialog, deletion confirmation
and read-only JSON/text previews. Unloaded history keeps its original boundary
when a new message is appended at the tail.

`src/native/redis/pubsub.rs` owns one bounded, dedicated RESP3 receiver per Session,
with acknowledged subscription changes, binary payloads and explicit cancellation.
It reuses the shared security/discovery factories without occupying either command
lane. Publications use the existing mutation worker and unknown-write handling.
`src/pages/pubsub/` owns subscription presentation, bounded captured history, search
and publisher drafts; its per-Session state survives page navigation. See
[PUBSUB.md](PUBSUB.md) for limits, recovery and log export.

`src/native/redis/metrics.rs` observes selected INFO fields, command percentiles and
optional SLOWLOG length on the existing bounded background lane. It returns exact
counter strings and identifies Cluster observations by one node's address and role.
`src/pages/monitoring/` owns sampling controls, bounded in-memory history and chart
presentation; inactive panels stop polling and discard pending observations.
Native JSON exports share `src/native/redis/export.rs` and the host Save dialog.
See [MONITORING.md](MONITORING.md) for scope, metric meaning and verification.

`src/native/redis/create_key.rs` creates one typed Key with its initial entries and
TTL in one atomic same-Key operation. An explicit `CreateKeyOptions.database`
uses a dedicated connection through the existing Standalone/Sentinel/Cluster
connection factory. It does not select a database on the workspace Session,
replace its transports or invalidate its continuations. Targeted creation shares
request admission, deadlines, cancellation and unknown-write handling; a timeout
drops its dedicated transport rather than the workspace transport. Cluster targets
are restricted to DB0. The new-key dialog owns its target database; creating in
another database updates catalog counts without changing the active Key, tabs,
drafts or Key Scan in the current Workspace.

`src/native/redis/metadata.rs` prepares bounded selected metadata batches on the
background lane, using finite Standalone pipelines and Cluster read-only
pipelines grouped by observed primary with at most 64 commands. Retained
MOVED/ASK responses still use explicit individual routing and exclusive ASKING.
A generation change restarts the whole bounded batch once, preventing
earlier observations from being stamped with a later generation.
It retains no metadata cache or scanned-Key inventory.
Request registration covers queueing, execution and native reply delivery/drop.
Session and global background quotas reserve interactive admission/execution;
Key/Hash/Set continuations share global as well as Session retention limits.
Both lanes call `SessionState::connect` for discovery/security and synchronize
with committed Session generations. A bounded shared Cluster discovery cache
keeps surviving endpoints available to either lane after the original seed dies.
Connections retain their actual attempt generation; shared result/delivery
validation rejects stale ordinary reads while preserving acknowledged write
context. Database Switch gates new work
and drains the shared admission registration across both lanes before replacement;
see [the barrier contract](REDIS_API.md#implemented-concurrent-browsing-limits).
`SessionState` commits both candidate transports with the database and generation
under one context lock. A separate bounded lifecycle reservation covers switch
preparation and native reply delivery without joining its own drain barrier.
Reconnect factories apply the committed database to the original connection
settings, including Sentinel rediscovery.
`src/native/security.rs` owns the generated verified TLS settings, certificate
validation, direct connection construction and structured TLS error categories.
Reuse that contract for subsequent Cluster and Sentinel builders; keep their
service-facing and data-node security settings independent.

`src/native/redis/ssh.rs` owns pinned SSH gateway authentication and direct-tcpip
streams. Redis endpoint names pass to the gateway without local resolution;
`security.rs` can wrap these streams with TLS using the original Redis identity.
The shared connection factory applies SSH to both lanes, discovered Cluster and
Sentinel endpoints and replacements. `redis/transport.rs` owns custom Redis
driver tasks; dropping a transport aborts its driver and cancels the underlying
SSH socket, including a pending handshake or unanswered command. Keep gateway
credentials in runtime options and never expose underlying SSH diagnostics.

`src/native/redis/proxy.rs` provides bounded SOCKS5 and HTTP CONNECT negotiation
under the shared connection factory and setup deadline. It delegates System mode
to `proxy/system/` platform adapters. Adapters resolve
the current route for every socket, including exclusions, and never persist system
endpoints or credentials. Only an explicit system DIRECT route permits direct access;
an unsupported system configuration or failed proxy must not fall back to direct.
The factory returns a TCP tunnel
to the original Redis endpoint or, with SSH, to the pinned SSH gateway. All
discovered and replacement endpoints inherit the explicit proxy settings, and
TLS retains the destination's identity. The UI stores non-secret proxy metadata
in the connection configuration; proxy passwords use the existing credential
backend with backward-compatible decoding of earlier secret bundles.

`src/native/redis/cluster.rs` owns Cluster seed discovery, a bounded primary/slot
cache and explicit MOVED/ASK handling. It uses the shared verified direct-node
factory rather than the redis-rs Cluster request retry machinery, so a transport
failure cannot replay a mutation. The worker's `Connection` adapter supplies an
explicit routing Key for commands and same-Key read pipelines. ASKING and its
intended command use one exclusively owned connection. Aggregate Key Scans keep
one cursor per observed primary ID/endpoint, including zero-slot primaries. The
Session shares a bounded identity from `CLUSTER SLOTS` plus `CLUSTER NODES`, with
normalized slot ownership and observed migration markers. A scan page executes
at most one primary SCAN and reuses topology for one second in an unchanged
generation; known routing/recovery events require a new observation. Changed
observations invalidate continuations and release their state. Unchanged refreshes
preserve cursor transports; lost replies never replay. This is observation-based
invalidation, with no Cluster snapshot or immediate-change-detection guarantee.

`src/native/redis/sentinel.rs` owns bounded named-primary discovery and ROLE
validation. It uses the shared direct connection/security factory, with separate
Sentinel-facing and data-facing credentials and verified TLS. The Session retains
the original Sentinel endpoints/group rather than a resolved primary address;
every `SessionState::connect` reruns discovery with the Session's database.
The resulting direct transport shares typed operations, cancellation and explicit
read recovery without any hidden mutation retry manager.

## Rust and TSX responsibilities

Rust owns Redis communication, connection lifecycles, command execution and local
persistence. Implement those use cases in Rust feature modules as they arrive,
with native exports adapting them for the UI. Add storage implementations when
there is a concrete persistence use case.

TSX owns application composition, views, interaction and presentation state.
View components may import native exports directly. `src/app.tsx` composes pages
and shared controls; pages consume shared data, controls and helpers. Keep
page-specific drafts and filters within the page.

NSH generates the native TypeScript declarations from Rust signatures and doc
comments. Keep interface documentation on the Rust exports and regenerate it with
`nsh check`.

## State and lifecycle

Create view-local native objects and signals in the component body. NSH components
run once when created; the reactive bindings update afterwards. Each page creates
its own presentation state for its lifetime.

Introduce application-wide state only when a feature needs shared ownership.
Keep mutable signals private behind the functions that read and change them.
Long-lived Redis connections belong to the Rust layer; their ownership and cleanup
must be explicit when that functionality is implemented.

## Native calling semantics

The Rust signature determines how TSX calls an export:

| Rust signature | TSX behavior |
| --- | --- |
| Plain synchronous function | Runs during the call and returns its value |
| `async fn` | Returns a Promise and runs as a task on NSH's services |
| Module function with `&mut ModuleCx`, returning `()` | Runs in UI/platform order and returns `void` |
| Module function with `&mut ModuleCx`, returning `Result<(), E>` | Runs in UI/platform order and returns `Promise<void>` |
| Module function with `&mut ModuleCx`, returning a value | Runs in UI/platform order and returns a Promise of that value |

Keep synchronous exports short. Redis I/O and blocking persistence work need an
execution strategy that keeps them off the UI thread; choose that strategy when
implementing the corresponding service. Reserve `ModuleCx` for work that needs
UI/platform ordering.

## Validation

- Give each worktree its own `CARGO_TARGET_DIR`. Parallel worktrees contain the
  same Cargo package name; sharing writable build outputs can reuse another
  worktree's native registry when only TS or test drivers change. Keep acceptance
  and final checks in the worktree's isolated directory.
- `cargo fmt -- --check` checks Rust formatting.
- `nsh check` checks the crate, generates native declarations and type-checks TSX.
- `nsh test` runs Rust tests and discovers `*.test.tsx` / `*.test.ts` files
  importing `nsh/test`. Place new tests beside the feature they exercise.
- `tests/redis-session.rs` owns ephemeral authenticated Redis fixtures and bundles
  the TS public API acceptance app against the real native registry. It requires
  Redis 6+ (`REDIS_SERVER` or PATH), never an existing Redis service.
- `nsh test --target macos` runs the UI tests in the AppKit host using native
  platform input. Headless results alone do not verify macOS window behavior.
- Verify Windows and Linux behavior on those platforms when adding platform
  integrations or preparing their releases.

`.nsh/` is generated and ignored by Git. Its declarations, runners and packages
are outputs of the nsh commands. Source changes belong in `src/`, the root entry
points and configuration.

## References

- [NSH coding guides](https://nsh.dev/docs/coding-guides/)
- [Rust and TSX mixed mode](https://nsh.dev/docs/rust/)
- [Project structure](https://nsh.dev/docs/project-structure/)
- [Testing and trace](https://nsh.dev/docs/testing-and-trace/)
