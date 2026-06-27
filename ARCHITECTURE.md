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

Note: the microkernel boundary is enforced on the **frontend** (`app/src` + `app/extensions`). The Rust backend (`app/src-tauri`) is currently a feature-monolith without an analogous extension boundary — see the architecture remediation notes.

## Naming Conventions
- **TypeScript:** camelCase (e.g., `textColor`)
- **Rust:** snake_case (e.g., `text_color`)
- **Boundary:** Serde handles the translation via `#[serde(rename_all = "camelCase")]`.