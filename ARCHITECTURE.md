# Architecture of Calcula

Calcula follows a strict **Microkernel Architecture**. This document outlines the boundaries and rules that keep the project maintainable and extensible.

## Why a Microkernel

The architecture is the founding vision made structural. Calcula promises Excel-grade customizability (build your own feature instead of waiting for a vendor) without VBA's failure modes (invisible code, unrestricted machine access). A microkernel delivers both at once: extensions and scripts get real power, but only through a narrow, typed, auditable API boundary -- so user code can be trusted because what it can touch is known by contract, not by hope. See `PHILOSOPHY.md` for the full reasoning.

## The Four Layers

1. **The Brain (Backend):** Rust-based logic. Handles the Cell Dependency Graph and Persistence.
2. **The Face (Core Frontend):** TypeScript + React. A pure component rendering the virtualized grid on HTML5 Canvas. **Zero dependencies on Shell.**
3. **The API (Facade):** The strictly typed "Sandpit" that bridges Core and Extensions.
4. **The Bridge:** Tauri-powered communication between Rust and the WebView.

## Folder Structure
Calcula/
├── app/
│   ├── src/
│   │   ├── core/      # The Engine (Pure Primitives)
│   │   ├── shell/     # The Host (Extension Orchestrator)
│   │   └── api/       # The "Contract" (Only import for extensions)
│   └── extensions/    # Feature implementations (Formatting, Charts, etc.)

## The "Alien" Rule
The Core (`src/core`) must treat all extensions as foreign objects. Hard imports from `core` to `extensions` are strictly forbidden. If a feature is needed, it must be requested via the API.

## Boundary Enforcement
These boundaries are not aspirational — they are linted. `npm run lint:boundaries` (config in `app/eslint.boundaries.js`, run in CI) fails the build on:
- **Alien:** Core importing Shell or Extensions.
- **Facade:** an extension importing `src/core`/`src/shell`, or another extension's internals (extensions share only through `@api` or `extensions/_shared`).
- **API neutrality:** `src/api` importing a specific extension (the facade stays feature-agnostic).

## The Backend is the Trusted Kernel (a deliberate boundary)

The lint-enforced microkernel boundary above governs the **frontend** (`app/src` +
`app/extensions`). The Rust backend (`app/src-tauri`) is the **trusted kernel** —
one compiled binary, like an OS kernel — and it exposes **no untrusted-reachable
command-registration or plugin surface, by design.** This is not an unclosed gap;
it is the only structure consistent with both Tauri and the founding security vision:

- Tauri commands are **compile-time** (`generate_handler!` is a macro over a static
  list); there is no runtime command-registration hook to open.
- Built-in commands receive raw `State<AppState>` (≈60 typed `Mutex` feature
  fields). Handing that — or loading a native plugin — to third-party code would be
  exactly the "full machine access like VBA macros" `PHILOSOPHY.md` forbids. No
  consent dialog can authorize it.

So "no first-class citizens / everything is a guest" is enforced at the layer where
guests actually run — the frontend and the **sandboxed worker realm** — which reach
the backend **only** through the broker's consent-gated, ceiling-bounded, audited,
Rust-re-checked **capability** surface (`net.fetch` / `bi.query` / `bi.sql` /
`storage` / `ui.html` / `formula.udf`). Third-party backend reach grows by adding a
**capability** (a richer mediated API), never a command. Even built-in extensions
reach the backend through a typed, capability-classified door:
`ExtensionContext.invokeBackend` runs `assertExtensionMayInvoke` against the
`PRIVILEGED_BACKEND_COMMANDS` denylist (A3), and capability-backed reads
(`bi_query` / `script_bi_sql`) re-validate the per-script grant authoritatively in
Rust (mirroring `script_http_fetch`'s per-call origin re-check).

The kernel's **own** feature wiring is data-driven where it used to be a closed
`match`: e.g. built-in undo/redo restore handlers self-register in a backend
registry (`undo_commands.rs`, keyed by restore `kind`) rather than editing a central
dispatch — the internal-IoC half of "no first-class citizens," with registration
kept strictly in-tree (never a surface untrusted code can register into).

Rejected alternatives (and why): a literal Rust plugin loader (no runtime hook +
violates the security floor); a sidecar/IPC passthrough (heavyweight, re-implements
the broker at a process boundary); threading the per-manifest capability ceiling
into the backend denylist (declared ≠ granted — the broker is where the ceiling +
consent belong). Full reasoning + the phased work: `docs/design/backend-facade.md`.

## Naming Conventions
- **TypeScript:** camelCase (e.g., `textColor`)
- **Rust:** snake_case (e.g., `text_color`)
- **Boundary:** Serde handles the translation via `#[serde(rename_all = "camelCase")]`.