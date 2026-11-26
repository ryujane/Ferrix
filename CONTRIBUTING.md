# Contributing to Ferrix

Report bugs and propose changes in [GitHub Issues](https://github.com/ryujane/Ferrix/issues).
For a bug, include your Ferrix version, operating system, and steps to reproduce it.

## Local development

Install Rust and the stable NSH CLI.
See the [NSH installation guide](https://nsh.dev/docs/installation) for platform setup.

```sh
nsh run
```

TSX changes hot-reload. Rust changes rebuild and restart the app.

## Checks

Run all three commands before opening a PR.

```sh
nsh check
nsh build
nsh test
```

For Rust changes, also run `cargo fmt -- --check`. For desktop UI changes, verify the affected flow in the native app. Use `nsh test --target macos` for macOS UI tests.

## Commits and pull requests

Work on a topic branch and open a PR against `main` for every change, including documentation, CI fixes, and version bumps. Never push directly to `main`. Keep each commit and PR focused on one change.

Use `<type>: <description>` for commit subjects and PR titles. Choose the type that describes the change. Start the description with a lowercase imperative verb, omit the final period, and aim for 72 characters in total. [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

| Type | Covers |
| --- | --- |
| `feat` | New functionality |
| `fix` | Bug fixes |
| `perf` | Performance improvements |
| `refactor` | Code restructuring that preserves behavior |
| `style` | Formatting-only changes |
| `docs` | Documentation changes |
| `test` | Test-only changes |
| `build` | Build tooling or dependency changes |
| `ci` | CI and release workflow changes |
| `chore` | Repository maintenance and version bumps |

Examples include `fix: restart interrupted key scans` and `docs: update the contribution guide`.

Use the commit body to explain why the change is needed. In the PR body, describe the change and its reason, report the checks you ran, and include screenshots for visible changes. For performance changes, report before and after measurements.

## Project layout

- `src/pages/` contains TSX features. Shared UI lives in `src/components/`, shared state in `src/data/`, and translations in `locales/`.
- `src/native/` contains the Rust implementation. `src/lib.rs` registers the native exports used by TSX.
- `tests/` contains app tests. `.nsh/` contains generated files.

See [Architecture](docs/ARCHITECTURE.md) for module boundaries and state ownership.
