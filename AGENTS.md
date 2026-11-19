# AGENTS.md

## Project

Ferrix is a native Redis client built on [nsh](https://nsh.dev) mixed mode: a TSX UI plus a Rust crate in the same repo, whose exports the UI imports.

The product targets macOS, Windows and Linux desktops. Local platform verification runs on macOS.

## Commands

- `nsh run` — run the app on this machine in dev mode; `--target ios|android|web|macos|linux|windows|gpui` for another platform
- `nsh check` — `cargo check` the crate, then type-check the TSX against the generated declarations (this is the only lint/type gate; there is no separate lint command)
- `nsh test` — `cargo test`, then discover `*.test.tsx` / `*.test.ts` files importing `nsh/test` and run them headless
- `nsh test --target macos` — run the UI tests in the native macOS host with platform input
- `cargo fmt -- --check` — check Rust formatting
- `nsh package --target web|ios|android|macos|linux|windows` — build a package (output under `.nsh/out/`)

## Architecture

Two halves in one repo, wired by `nsh.json` (`"rust": "."` points at the crate root):

- **UI (TSX)**: root `app.tsx` mounts `src/app.tsx`. Shared controls live in `src/components/`, pages and their private code in `src/pages/<page>/`, shared data/state in `src/data/`, and reusable helpers in `src/utils/`. App-wide modules such as `i18n.ts` and `fonts.ts` live at the `src/` root. Shared modules do not import pages; page-local state stays with its page. The earlier example workspace remains under `ui/` and consumes the same shared controls and assets. Reactivity (`signal`, resources) comes from `"nsh"`; `jsxImportSource` is `"nsh"`. The component/style surface lives in `.nsh/types/nsh/types.d.ts` and `index.d.ts`.
- **Native (Rust)**: the crate `nsh-app-ferrix`. Keep `#[native_module("ferrix/native")]` in `src/lib.rs` at the crate root; implementations live in `src/native/`. The registry exposes exports three ways:
  - `registry.register::<T>()` — components (`#[component]`, with `Props`/`Event` derives; events surface as `onXxx` props)
  - `registry.module::<T>()` — modules (`#[module]`: namespaced functions, e.g. `Format.times(3)`)
  - `registry.class::<T>()` — classes (`#[class]`: stateful objects constructed with `new` in TS, `#[getter]` methods become getters)

Rust owns Redis communication, connection lifecycles and local persistence. TSX owns views, interaction and presentation state. Create view-local state in its component body. For dependency direction, state ownership and adding features, read `docs/ARCHITECTURE.md`.

**Calling semantics are chosen by the Rust signature** — this decides where logic lives:
- a plain `fn` runs synchronously inside the TSX call and returns its value
- an `async fn` returns a Promise and runs as a task on NSH's services
- a module fn taking `cx: &mut ModuleCx` runs in order with the UI/platform; `()` becomes TS `void`, `Result<(), E>` becomes `Promise<void>`, and a returned value becomes a Promise of that value

Rust doc comments become the TS doc comments in `.nsh/types/ferrix/native.d.ts`, generated on build — never edit that file; `nsh check` type-checks the TSX against it.

`.nsh/` is entirely generated and gitignored: runner sources in `.nsh/rust/`, type declarations in `.nsh/types/`, packages in `.nsh/out/`. Don't hand-edit anything there.

Hot reload: TSX edits hot-update the running app; Rust edits rebuild and restart it.

## Naming

Use lowercase kebab-case for source filenames and directories, including components,
tests and scripts: `help-page.tsx`, `navigation-item.tsx`.
Rust module files use snake_case matching their module names, such as
`credential_settings.rs`, and ordinary `mod` declarations. Arrange shared modules
under their normal module directories instead of using `#[path]` attributes.
Cargo-discovered integration test entry filenames may remain kebab-case.
Keep component, type, function and Rust module identifiers in their language's
normal conventions.
Keep tool-defined names such as `Cargo.toml` and `Cargo.lock`, and preserve the
names of generated files and upstream assets.

## nsh docs

LLM-friendly index of all nsh docs: <https://nsh.dev/llms.txt>. Every page is also served as raw Markdown at its URL + `.md` (e.g. <https://nsh.dev/docs/reactivity.md>); Chinese versions live under `/zh-CN/` (e.g. <https://nsh.dev/zh-CN/docs/reactivity.md>). Pages most relevant to this repo:

- Mixed Rust + TSX apps: <https://nsh.dev/docs/rust.md>
- `nsh.json` keys and project layout: <https://nsh.dev/docs/project-structure.md>
- JSX, components, signals: <https://nsh.dev/docs/jsx-and-components.md>, <https://nsh.dev/docs/reactivity.md>
- Styling and the style key reference: <https://nsh.dev/docs/styling.md>, <https://nsh.dev/modules/style-reference.md>
- Tailwind (classes resolved natively): <https://nsh.dev/docs/tailwind.md>
- CLI subcommands: <https://nsh.dev/docs/cli.md>
- Headless testing with `nsh trace`: <https://nsh.dev/docs/testing-and-trace.md>


