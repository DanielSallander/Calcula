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

## Facade-Driven Cross-Extension Communication (the IoC inversion)

Not every API surface is a typed command query. Some features need **bidirectional control
between extensions** without either importing the other. The `@api/chartParams.ts` facade
exemplifies this: Charts implements a `ChartParamController` and registers it in its
`activate()` (`registerChartParamController`), clearing it to `null` on `deactivate()`;
Animation then calls `listAnimatableCharts()` / `setChartParamValue()` with **no import of
Charts internals**. The facade itself imports no extension, so API neutrality holds — Charts
provides the implementation, Animation consumes the proxy, and neither knows the other's
module exists. (Same shape as `@api/pivot.ts`'s `registerPivotApi`.)

The same inversion exposes Core primitives to extensions without an extension reaching into
Core: `app/src/core/lib/gridCapture.ts` (deterministic grid-region capture, registered by
`GridCanvas.tsx`) is surfaced through `@api/rendering.ts` rather than imported directly. Each
facade registers once per extension and is referenced through init-time `@api` imports,
keeping the import graph acyclic. This is the practical form of the Inversion-of-Control rule
in `CLAUDE.md`: the Core (and one extension) emit capabilities; consumers respond.

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

**Example — transient writes without undo leakage.** The `Animation` extension applies the
same data-driven, transient discipline. `anim_snapshot` / `anim_apply_frame` / `anim_restore`
(`app/src-tauri/src/animation_commands.rs`) form a snapshot/apply/restore trio keyed by a
caller-owned token; each frame applies transient writes and recalculates dependents (mirroring
`scenario_show`) **without touching the undo stack or marking the document dirty**. There is
no suppression flag — the commands simply never call an undo-recording path — which preserves
the invariant that undo/redo sees only intentional user actions, never preview state. The
frontend reaches these through the same capability-classified door
(`createBackendChannel("Animation")`, A3), not a raw passthrough; its persistence rides the
generic extension-data tier plus a `set_extension_data_undoable` variant that self-registers in
the same `undo_commands.rs` restore registry (`obj_extension_data`).

Rejected alternatives (and why): a literal Rust plugin loader (no runtime hook +
violates the security floor); a sidecar/IPC passthrough (heavyweight, re-implements
the broker at a process boundary); threading the per-manifest capability ceiling
into the backend denylist (declared ≠ granted — the broker is where the ceiling +
consent belong). Full reasoning + the phased work: `docs/design/backend-facade.md`.

## Secondary Editor Windows

Some editors need more room than a pane — they open as **standalone Tauri
windows** that still belong to the application (the VBA-in-Excel shape). Three
exist: `chart-spec-editor`, `object-script-editor`, and `model-editor` (the BI
Model Editor, `docs/design/model-editor.md`). Each follows one mechanism:

- Its own HTML entry + `src/*Main.tsx` bootstrap (a Vite rollup input), mounting
  a single extension-owned app component — no Shell, no GridProvider.
- A capability file (`src-tauri/capabilities/<label>.json`) granting only event
  permissions. Capabilities do **not** gate app-defined commands, so the real
  containment is the next line.
- **Window guards** (`security/window_guard.rs`): dangerous commands declare
  which window labels may call them as data (`MAIN`,
  `MAIN_AND_OBJECT_SCRIPT_EDITOR`, `MAIN_AND_MODEL_EDITOR`). A secondary window
  gets exactly the commands its editor needs — reads included, when they carry
  sensitive payloads (the model overview includes RLS role definitions) — and a
  compromised secondary webview gets nothing else. Guards are independent of
  every frontend check (`docs/design/script-sandbox-architecture.md` §7).
- Cross-window traffic goes through the sanctioned `@api/backend`
  `emitTauriEvent`/`listenTauriEvent` door (raw `@tauri-apps/api/event` is
  lint-banned in extensions), with a ready-handshake for the initial payload
  and a singleton opener that re-attaches via `getByLabel` after a
  main-webview reload.

The Model Editor adds one more architectural rule worth stating generally:
**shared mutable engine state gets one writer serialization point.** Every BI
model writer (editor mutations, workbook calculated measures, dataset-package
refresh) acquires the shared engine's lock first and snapshots, edits,
validates, installs, and mirrors under it — concurrent writers cannot
interleave between snapshot and install.

## Naming Conventions
- **TypeScript:** camelCase (e.g., `textColor`)
- **Rust:** snake_case (e.g., `text_color`)
- **Boundary:** Serde handles the translation via `#[serde(rename_all = "camelCase")]`.

## Transient Writes and the Undo Invariant

Preview or simulation state — changes shown to the user that must not persist across a
stop/reload — is modelled explicitly so it can never leak into the undo history or a saved
file. Animation is the reference implementation: frame writes go through `anim_apply_frame`,
which recalculates dependents but does **not** append to the undo stack or dirty the document;
stopping calls `anim_restore` to put the model back exactly. The invariant is simple — **undo
sees only committed, intentional user actions, never an intermediate preview frame** — and
"transient" is an implementation detail behind the facade, not a user-facing mode. The backend
precedent is `scenario_show` (`scenario_manager.rs`); the full design is in
`docs/design/animation-simulation.md`.