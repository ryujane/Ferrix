# Redis CLI

The navigation **Console** opens the active Workspace's CLI across the window.
The Workspace's **Terminal** tab uses the same input and history in its split view.

## Commands and connection state

The CLI sends arbitrary Redis commands and binary arguments to the server. It has
no command allowlist: built-in, administrative, scripting and module commands all
use the same execution path. Redis determines availability, syntax, permissions,
and errors. `HELP` and `CLEAR` without arguments are local console commands.

Each Session can own one isolated CLI connection. It starts in the browser's
selected database. `SELECT`, `AUTH`, `WATCH`, and `MULTI`/`EXEC` retain their state
on that connection without affecting the browser, monitoring, or Pub/Sub page.
The `CLI DB` label shows the CLI's database. Switching the browser's database does
not change an already-open CLI connection. Stopping and reopening starts from
the browser's current database and saved connection credentials.

The socket uses the existing verified TLS, pinned SSH, proxy, and Sentinel/Cluster
discovery settings. Cluster follows up to five MOVED/ASK responses for built-in
commands whose fixed Key position is confirmed by `COMMAND INFO`. The reported
slot must match that argument and the destination must belong to the discovered
topology. Reconnection uses the original security settings and current CLI
authentication/database. Scripts, functions, module commands, dynamic-Key
commands and unavailable routing metadata leave routing errors visible without
replay. WATCH, transactions and subscriptions remain pinned to their current
node. Node-local commands address the current CLI node. Other connection-local
settings are not copied to a redirect. Reopen the CLI to refresh its topology.

Commands are never replayed after a transport failure. An interrupted command
can have an unknown outcome; check the data before retrying. Server errors
display Redis's details. UI history masks authentication and common credential
setting commands, including malformed input, and excludes them from recalled
input history.

`MONITOR`, `SUBSCRIBE`, `PSUBSCRIBE`, and sharded subscriptions display bounded
live responses. Blocking commands wait until their reply, **Stop**, `Ctrl+C`, or
Session close. While MONITOR runs, stop it before sending another command.
Stop releases only the CLI connection. Unsubscribing consumes all server
acknowledgements before the next command's reply is delivered.

`CLIENT REPLY OFF`/`SKIP` intentionally suppress acknowledgements. Sending either
closes the CLI socket and reports an unconfirmed outcome so the input stays
usable. Inside MULTI they remain queued; an EXEC containing either command is
sent once and closes without parsing its potentially incomplete aggregate reply.
The next command opens a new socket with normal replies.

RESP2/RESP3 strings, integers, arrays, maps, sets, booleans, doubles, big numbers,
nested errors, attributes and pushes render as text. Integer replies never pass
through JavaScript floating-point numbers. Double-quoted arguments support
`\n`, `\r`, `\t`, `\b`, `\a`, `\\`, `\"`, and `\xHH`; single quotes preserve literal
text except escaped quotes and backslashes. Empty and binary arguments survive
the native bridge as byte arrays.

## Completion

- Type a command prefix for names; container commands also offer subcommands.
  **Tab** inserts the highlighted choice, **Up/Down** changes it, **Escape** hides
  the list, and **Enter** executes.
- The syntax hint describes required arguments, optional flags, alternatives and
  repeated values. Sibling options can appear in any order; alternatives remain
  exclusive.
  It highlights the argument at the caret, even inside an earlier quoted value,
  and identifies its name, type, required/optional state and repeatability. EX/PX
  values show their time units. Module schemas load lazily; a pending hint stays
  distinct from unavailable documentation.
- Hints describe the command structure. Keys and values stay placeholders such
  as `<key>` and `<value>`; completion only inserts command names, subcommands
  and literal options, with at most 80 choices. It does not read or scan Keys.
  Opening the CLI directly leaves browsing data uninitialized until the Key
  browser is opened.
- With no suggestion list, **Up/Down** recalls earlier non-secret commands and
  restores the unfinished draft past the newest command.
- Native `COMMAND` supplies server names, including module commands;
  `COMMAND DOCS <name>` lazily supplies argument schemas. Both use the existing
  bounded background lane, separate from CLI state. Metadata failure never
  prevents execution. Redis versions without DOCS use bundled signatures; if
  COMMAND is denied, the console labels its offline catalog explicitly.
  **Reload commands** refreshes the catalog, as does a successful MODULE command.

The bundled 370 signatures contain factual names and argument schemas from
[Redis's command metadata](https://github.com/redis/redis-doc/blob/master/commands.json),
downloaded on 2026-11-16. Server metadata takes precedence; this bundle never
decides whether a command may execute.

## Bounds and lifecycle

There are at most 16 CLI sockets process-wide and one per Session, with one
pending command per CLI. Input is limited to 65,536 characters, 4,096 arguments,
and the Session's byte budget. Complete wire replies are framed within that
budget (default 256 KiB, maximum 1 MiB), before allocating bulk payloads. Excess
or invalid frames close the CLI so unread data cannot become another reply.
Special replication/file-transfer streams are subject to these RESP limits.

The native live-output ring retains 128 responses / 1 MiB and reports drops.
UI history retains 100 rows / about 1 MiB of text; recall retains 100 entries /
128 Ki characters. History is in memory. Inactive terminals stop draining; the
native ring stays bounded. Session close or Workspace disposal cancels CLI work.

`EXEC` applies successful queued database selections to the prompt. Transactions
that execute other connection-mode changes close their CLI socket after showing
the result, so the next command cannot inherit untracked state.

## Verification

- `cargo fmt -- --check` and `nsh check`.
- `cargo test --lib native::redis::console` exercises bounded RESP framing.
- `cargo test --test redis-console -- --test-threads=1` uses authenticated Redis
  processes for command families, binary values, nested replies, RESP3, isolated
  transactions/SELECT, live MONITOR/subscriptions, indefinite blocking cancellation,
  size limits, validated Cluster routing, preserved WATCH/subscriptions, HELLO
  authentication options, reply suppression and lost/script-error replies without
  replay or authentication to script-supplied destinations.
- `nsh test tests/console.test.tsx` exercises completion, quoting, module commands,
  input history, secret redaction, stopping and offline hints.
- `nsh test tests/workspace.test.tsx` protects shared Workspace/Terminal routes.
- Native macOS captures cover appearances, locales and compact window sizes.
