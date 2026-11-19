# Ferrix

Ferrix is a native Redis desktop client built with [nsh](https://nsh.dev) mixed mode:
a Rust core and a TSX interface in one repository. The target platforms are macOS,
Windows and Linux; local platform verification runs on macOS.

The app opens a native, resizable Redis workspace with dark/light themes, key
search, tabs, a folding JSON editor and an example console. The window currently
uses clearly labeled local example data. The Rust core implements typed Redis
operations; connecting those operations to the window is a separate integration.
See [the window guide](docs/WINDOW.md) for its current scope and shortcuts.

## Development

Use the nsh 0.6.0 stable CLI to match the `nsh-*` dependencies pinned in
`Cargo.lock`. Check the installed version with `nsh --version`.

```sh
nsh run --target macos       # run the native macOS app with hot reload
nsh run --target windows     # run the native Windows app with hot reload
nsh check                    # check Rust and TSX against generated native declarations
nsh test                     # run Rust tests and discover headless UI tests
nsh test --target macos      # run UI tests in the native macOS host
cargo fmt -- --check         # check Rust formatting
nsh package --target macos   # desktop package; also supports linux and windows
```

`nsh check` is the lint/type gate. TSX changes hot-update the running app;
Rust changes rebuild and restart it.

The sidebar's Help page shows application identity from NSH's `appInfo()`, so
version and build follow `nsh.json` and package-time overrides. Project URLs and
the included build notes live in `src/pages/help/help-content.ts`, with English and Chinese
copy in `locales/`. Project and feedback links open in the system browser.

## App updates

Desktop release builds check GitHub Releases on launch. Ferrix checks for a
signed `.nshpkg` first and checks for a desktop archive when none is available.
Help also provides a manual check. Users can download and install an update
immediately, or skip the offered version. An immediate install restarts Ferrix
after the download. If the download fails, Ferrix opens the release page in the
system browser for manual download. A skipped version can still be installed
from Help. The next available version is offered on launch.

The `updater.github` setting in `nsh.json` selects the GitHub repository that
hosts the release assets. Increase the SemVer `version` and the numeric `build`
for each release, including OTA releases. To publish a full desktop release, push
a `vX.Y.Z` tag on the commit with the matching `version` in `nsh.json`. The
[Release workflow](.github/workflows/release.yml) runs `nsh package` for macOS
(Apple Silicon and Intel), Windows (x64), and Linux (x64, Ubuntu 24.04). After
every build succeeds, it generates `latest.json` and publishes it with the
archives on GitHub Releases.

The macOS apps have NSH's ad hoc signature. Developer ID signing and
notarization for distribution are described in [NSH App Updates](https://nsh.dev/docs/app-updates/).

For TSX and bundled asset updates, use the certified release key to sign a
package. The installed desktop build must already trust the root listed in
`updater.packages.roots`.

```sh
ota_keys="$HOME/.config/ferrix/ota"
mkdir -p .nsh/out/ota
nsh publish --key "$ota_keys/release.secret" --cert "$ota_keys/release.cert" -o .nsh/out/ota/Ferrix.nshpkg
nsh update-manifest --package .nsh/out/ota/Ferrix.nshpkg -o .nsh/out/ota
```

Attach `Ferrix.nshpkg` and `latest.json` to the stable GitHub Release. See
[NSH OTA Updates](https://nsh.dev/docs/ota-updates/) for signing and build rules.

## Project structure

```text
app.tsx                       # conventional bootstrap: mount once
app.test.tsx                  # UI/native integration smoke test
src/
  app.tsx                     # application composition and state ownership
  components/                 # shared controls, icons, navigation and title bar
  pages/
    connections/              # connection Hub and its private dialogs/controls
    workspace/                # live Session browser
    settings/                 # preferences and credential settings views
    help/                     # help view, links and release notes
  data/
    connections/              # configuration models, native calls and live state
    preferences.ts            # shared preferences and persistence
    credential-settings.ts    # credential configuration state
  utils/                      # reusable error and window helpers
  i18n.ts                     # application localization
  fonts.ts                    # application typography
  assets/                     # bundled fonts and icons, with licenses
  lib.rs                      # ferrix/native registration at the crate root
  native/                     # Rust implementations
ui/                           # earlier example workspace and its private state
tests/                        # integration tests and acceptance applications
docs/
  ARCHITECTURE.md             # dependencies, state ownership and feature growth
  agents/                     # engineering-skill configuration
```

Rust owns Redis communication, connection lifecycles and persistence. TSX owns
the interface and presentation state, importing native exports from
`ferrix/native`. See [the architecture guide](docs/ARCHITECTURE.md) for adding
features and choosing native calling semantics.

NSH generates declarations, runners and packages under `.nsh/`; edit their source
files instead. Cargo build artifacts live under `target/` unless
`CARGO_TARGET_DIR` selects another location.

Source filenames and directories use lowercase kebab-case. Component and Rust
identifiers follow their language conventions; fixed tool filenames such as
`Cargo.toml` retain their required spelling.
