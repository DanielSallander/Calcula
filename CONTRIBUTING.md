# Contributing to Calcula

Thanks for your interest in Calcula! This document is honest about where the
project is and what kind of help moves it forward right now.

**Project state:** active development, pre-1.0. APIs change without
backward-compatibility guarantees, file formats are versioned but still
evolving, and the primary platform is Windows 11. If you build on Calcula
today, expect to move with it.

## The best ways to help right now

1. **Write an extension.** Calcula's whole thesis is that every feature — even
   built-in ones — goes through the public extension API. The single most
   valuable contribution is an extension we didn't write: it validates the
   architecture and it's yours from day one.
   - Start from the scaffold: [`app/extensions/_template/`](app/extensions/_template/)
   - Read the guide: [`docs/EXTENSION_GUIDE.md`](docs/EXTENSION_GUIDE.md)
   - The 76 built-in extensions under [`app/extensions/`](app/extensions/) are
     living examples — they use the exact same API you do.
2. **Run it and file good bug reports.** A great report includes: what you did,
   what you expected, what happened, and (ideally) a minimal `.cala` or `.xlsx`
   file that reproduces it. Persistence round-trip bugs (save → reload →
   something changed) are treated as top-severity — include both files.
3. **Test .xlsx fidelity.** Open your real-world Excel files and tell us what
   imports wrong or exports lossy. Saving as `.xlsx` shows a dialog listing
   features that won't carry — if something is lost *silently* instead, that's
   a bug we want immediately.
4. **Improve the docs.** Especially the extension guide and anything that
   confused you on the way in — confusion reports are contributions.

## Before you write a large change

Open an issue first for anything beyond a contained fix — especially changes to
`app/src/core/`, `app/src/shell/`, or the Rust engine crates. Calcula has a
strict microkernel architecture and PRs that fight it can't be merged, no
matter how good the code is. The ground rules:

- **Extensions import only from `@api`** (`app/src/api/`) — never from
  `core/`, `shell/`, or another extension's internals. Shared extension code
  lives in `app/extensions/_shared/`.
- **Core never imports from `shell/` or `extensions/`.**
- These boundaries are enforced: `npm run lint:boundaries` must pass.
- Built-in features get no backdoors — if the API can't support your feature,
  the fix is improving the API, not bypassing it.

[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`PHILOSOPHY.md`](PHILOSOPHY.md)
explain the why; [`CLAUDE.md`](CLAUDE.md) has the working conventions
(including the Rust `snake_case` ⇄ TypeScript `camelCase` serde rules).

### API stability

- **`app/src/api/` (`@api`) is the contract** extensions are written against.
  Pre-1.0 it can still change, but changes are deliberate and noted.
- **`app/src/core/` and `app/src/shell/` are internals.** No stability
  guarantees at all — don't build against them.
- File formats (`.cala`, `.calp`) are versioned with explicit format-version
  gates; bumps are intentional.

## Development setup

Windows 11 is the primary development platform.

1. Install Rust (MSVC toolchain) and Node.js.
2. `npm install` in `app/`.
3. `npm run tauri dev` in `app/` builds and launches the app.
4. For Rust work outside `tauri dev`, run `core/setup-rust-env.ps1` first (it
   configures the MSVC linker environment — plain terminals often have a
   conflicting `link.exe` on PATH).

Tests:

- Frontend: `npx vitest run` in `app/` (targeted paths are much faster than
  the full suite).
- Rust: `cargo test` in `core/` (with the env script above).
- Boundaries: `npm run lint:boundaries` in `app/`.
- TypeScript: `npx tsc --noEmit -p tsconfig.json` in `app/`.

## Commit style

Conventional commits: `type(scope): description` (e.g.
`fix(persistence): restore named ranges on load`). Keep messages about *what*
and *why*.

## Sign your work (DCO)

Every commit must be signed off:

```
git commit -s
```

This adds a `Signed-off-by: Your Name <your@email>` line, certifying the
[Developer Certificate of Origin](DCO) — that you wrote the change or
otherwise have the right to submit it under the project's licenses. It's a
one-flag habit, not a contributor agreement: you keep your copyright.

Why we require it: clean provenance for every line keeps the project's future
options open (including commercial services built *around* the open code),
while everything you contributed remains under MIT/Apache-2.0 permanently.

## License of contributions

Calcula is dual-licensed under [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option. Unless you explicitly state
otherwise, any contribution you intentionally submit for inclusion is
dual-licensed the same way, without additional terms or conditions (per
Apache-2.0 §5).

## Conduct

Be kind, be direct, assume good faith. Disagreements about code are welcome;
disrespect toward people is not.
