# Architecture of Calcula

Calcula follows a strict **Microkernel Architecture**. This document outlines the boundaries and rules that keep the project maintainable and extensible.

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

## Naming Conventions
- **TypeScript:** camelCase (e.g., `textColor`)
- **Rust:** snake_case (e.g., `text_color`)
- **Boundary:** Serde handles the translation via `#[serde(rename_all = "camelCase")]`.