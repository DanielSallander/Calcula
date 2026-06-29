# Calcula - Open-Source Spreadsheet Engine

Calcula is an ambitious open-source spreadsheet application (Excel alternative) built for high performance and extensibility using a microkernel architecture.

## Project Vision

Calcula exists to bring back the customizability that made Excel great -- formulas, VBA, add-ins: the ability to build your own solution to any specific problem, today, yourself. The industry's move toward Power BI -- itself a genuinely good tool -- took that away: users are locked to the vendor's visuals and data model, with no custom scripting, waiting for Microsoft to ship a feature instead of building it.

At the same time, Calcula must fix the legitimate downsides that got VBA shunned and Excel files distrusted. These are requirements every feature is held to:

- **Security:** Custom code must run sandboxed, with tiered access levels -- never with full machine access like VBA macros. (Current state: DONE through Wave 3. Object scripts run in per-script hardened Worker realms; distributed extensions that opt in run sandboxed too; all privileged reach is broker-mediated behind a capability model -- net.fetch, bi.query, bi.sql, storage, ui.html, formula.udf -- with a declared-capability ceiling, consent, and audit. Notebooks/one-off scripts run in an isolated Rust QuickJS interpreter over cloned grid state. See docs/design/wave3-scripting-security.md.)
- **Transparency:** Custom code must be visible and auditable. The user must always know where code resides and what it can touch -- never hidden inside a binary file. Scripts arriving in distributed packages must not run without explicit consent. (Current state: DONE through Wave 3. Consent + a per-script audit ring + a transparency panel; Ed25519 signing/TOFU for .calp packages AND distributed extensions via signed sidecar manifests verified at scan; a single queryable script-surface taxonomy. The Rust QuickJS surfaces (notebook/one-off/MCP) now record an always-on, structured grid-mutation audit trail (surface + id + sheet + mutated range) into the per-workbook log, shown as a "Scripts" category in the audit viewer. Remaining (broader "one transparency story"): persisting the in-memory broker capability ring + the net.fetch/bi.* Rust gate calls into that same trail so capability calls also survive reload.)
- **Distribution:** Excel's model of emailing copies of files is replaced by `.calp` packages: publish/subscribe report distribution, plus two-way data collection via writeback

Every feature decision should serve this vision: maximum user customizability, with the security and transparency that Excel/VBA never had.

## Tech Stack

- **OS:** Windows 11
- **Backend:** Rust (workspace structure)
- **Frontend:** React, TypeScript, Vite
- **Bridge:** Tauri (connects Rust to WebView)
- **Rendering:** HTML5 Canvas (supports 1M+ rows)

## Architecture Overview

### Microkernel Architecture (VS Code Style)

Calcula follows a strict **Microkernel Architecture** with three distinct layers:

1. **The Kernel (Core)** - Minimal, stable engine that knows nothing about specific features
2. **The Shell (Host)** - Application frame that orchestrates lifecycle and loads extensions
3. **The Extensions** - All user-facing features (even built-in ones)

### The Four Layers

1. **The Brain (Backend):** Rust - Cell Dependency Graph, Formula Parsing, Persistence
2. **The Face (Core Frontend):** TypeScript + React - Virtualized grid rendering on HTML5 Canvas (zero dependencies on Shell or Extensions)
3. **The API (Facade):** Strictly typed "Sandbox" layer - the ONLY bridge between Core and Extensions
4. **The Bridge:** Tauri - connects Rust backend to WebView frontend

### Directory Structure
```
Calcula/
├── app/
│   ├── src/
│   │   ├── core/           # The Engine. PURE.
│   │   │                   # RULE: Cannot import from 'shell' or 'extensions'
│   │   │
│   │   ├── shell/          # The Host
│   │   │                   # Responsibilities:
│   │   │                   # 1. Mounts the Core Grid
│   │   │                   # 2. Scans the 'extensions' folder
│   │   │                   # 3. Registers them into the Core
│   │   │
│   │   └── api/            # The "Sandpit"
│   │                       # The ONLY interfaces extensions are allowed to touch
│   │
│   └── extensions/         # MOVED OUTSIDE 'src'. ~58 feature extensions, flat:
│       ├── Charts/          #   Charts, Pivot, Sorting, Slicer, Table, ... (one dir each)
│       ├── Pivot/
│       ├── ...              #   (full list registered in extensions/manifest.ts)
│       ├── BuiltIn/         # Built-in dialogs/menus (FindReplace, FormatCells, HomeTab, ...)
│       ├── _shared/         # Shared widgets + libs reusable across extensions
│       │                    #   (the ONLY sanctioned cross-extension code; NOT @api)
│       ├── _standard/       # (legacy bucket; currently only conditional-formatting)
│       ├── _template/       # Scaffold for authoring a new extension
│       ├── manifest.ts      # Static list of built-in extensions (load order)
│       └── index.ts
│
│   # 3rd-party extensions are NOT in the repo: scanned at runtime from
│   # %APPDATA%/com.calcula.app/extensions/.
```

### What Lives Where

**Core (`app/src/core/`)** - The "Kernel". Universal primitives only:
- Grid rendering pipeline & virtualization
- Selection model & Cursor logic
- Input handling (Keyboard/Mouse primitives)
- Undo/Redo stack
- **CONSTRAINT:** Never imports from `shell` or `extensions`

**Shell (`app/src/shell/`)** - The "Container":
- Window Layout (Sidebar, Status Bar)
- Extension Host (scanning, loading, activating extensions)
- **CONSTRAINT:** Orchestrates Core and Extensions but contains no business logic

**API (`app/src/api/`)** - The "Contract":
- `types.ts`: Stable interfaces re-exported from Core
- `commands.ts`: Registry definitions
- **CONSTRAINT:** The ONLY import allowed in an Extension file

**Extensions (`app/extensions/`)** - The "Features":
- Built-in: Formatting, Sort/Filter, Charts, Financial/Statistical Functions
- User: Future 3rd party plugins
- **CONSTRAINT:** Must function exactly like 3rd party plugins. No "backdoor" access to Core internal state

### Extension Points (via `src/api`)

Extensions interact with Core exclusively through the API Facade:
- `commands.register(id, handler)` - Register actions (e.g., "format.bold")
- `ui.ribbon.registerTab(tabDef)` - Inject UI elements
- `formulas.registerFunction(name, impl)` - Add calculation logic
- `events.onSelectionChange(cb)` - Listen for context

## CRITICAL RULES - STRICT ENFORCEMENT

### Architecture & Import Boundaries

1. **The "Alien" Rule:** The Core (`src/core`) must NEVER import from `app/extensions` or `src/shell`
2. **The Facade Rule:** Extensions (`app/extensions`) must ONLY import from `src/api` (`@api`); they must not import another extension's internals — share via `@api` or `extensions/_shared`. Deep imports into `src/core`/`src/shell` are strictly forbidden. (Enforced: `npm run lint:boundaries` / `app/eslint.boundaries.js`.)
3. **Dogfooding:** Built-in features (Formatting, Charts) must be built using the public Extension API. If the API cannot support a feature, improve the API rather than hacking the feature into Core
4. **Inversion of Control:** The Core does not call Extensions. The Core emits events/hooks (via the API), and Extensions respond
5. **Primitive vs. Logic:** If a feature requires new logic (e.g., Sorting), implement generic primitives in Core (e.g., read/write range) and specific business logic in an Extension
6. **Feature Location:** Default to building features as Extensions (`app/extensions/`; built-in dialogs/menus live under `app/extensions/BuiltIn/`) unless they are foundational primitives (like Rendering or Undo/Redo)

### Naming Conventions (Rust <-> TypeScript API Boundary)

**THE GOLDEN RULE:**
- **TypeScript:** Always use `camelCase` for ALL properties (textColor, backgroundColor, styleIndex)
- **Rust:** Always use `snake_case` for ALL fields (text_color, background_color, style_index)
- **Serde handles conversion automatically** via `#[serde(rename_all = "camelCase")]`

**Rust API types** (in `api_types.rs`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // <-- This handles ALL fields
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub style_index: usize,  // Rust uses snake_case
}
```

**TypeScript types** (in `types.ts`):
```typescript
export interface CellData {
  row: number;
  col: number;
  styleIndex: number;  // TypeScript uses camelCase
}
```

**RULES:**
- Use `#[serde(rename_all = "camelCase")]` on Rust structs
- NEVER use manual `#[serde(rename = "...")]` on individual fields
- All Tauri API types must live in `api_types.rs` (Rust) and `types.ts` (TS)
- TypeScript interfaces in `types.ts` must exactly mirror Rust structs in `api_types.rs`

### Coding Standards

1. **No Placeholders:** Write full implementation code. Do not use placeholders like `// ... rest of code`
2. **Windows Native:** Assume Windows 11 paths and environment
3. **Clean Output:** Avoid Unicode characters in terminal output (use `[OK]` instead of checkmarks)
4. **Modularity:** Keep logic isolated. UI should never calculate; Backend should never render
5. **Completeness:** Provide full functional blocks or complete files
6. **Folder-as-Module:** For TypeScript, prefer the "Folder-as-Module" pattern to keep files organized into smaller, manageable sizes

## Common Mistakes to Avoid

- Using `style_index` in TypeScript (should be `styleIndex`)
- Using `text_color` in TypeScript (should be `textColor`)
- Using `styleIndex` in Rust (should be `style_index`)
- Forgetting `#[serde(rename_all = "camelCase")]` on new Rust structs
- Adding `#[serde(rename = "fieldName")]` to individual fields (use struct-level instead)
- Importing from `extensions/` in core code (core must never depend on extensions)
- Importing deep into `src/core/...` from extensions (use `src/api` only)
- Creating backdoor access for built-in extensions (they must use the same API as 3rd party extensions)

## The "Calcula" Decision Matrix

When developing a new feature, ask these three questions:

| Question | If YES... | If NO... |
|----------|-----------|----------|
| "Is it a Primal? Does the grid need this to simply exist (e.g., coordinates, scrolling, basic pixel rendering)?" | CORE | Move to next question |
| "Is it a Bridge? Is this a generic tool that any extension might need (e.g., 'Show a Dialog,' 'Read a Cell,' 'Interchange format')?" | API | Move to next question |
| "Is it a Feature? Is this a specific user-facing behavior (e.g., Data Validation, Charts, Pivot, Formatting)?" | EXTENSION | It's an Extension |

## Examples of What Goes Where

**CORE:**
- Grid virtualization and Canvas rendering
- Cell coordinates and range logic
- Selection model (active cell, ranges)
- Keyboard/Mouse event primitives
- Undo/Redo stack
- Copy/Paste clipboard primitives

**API:**
- Command registry (`commands.register`)
- UI injection points (`ui.ribbon.registerTab`)
- Formula registration (`formulas.registerFunction`)
- Event subscriptions (`events.onSelectionChange`)
- Generic data access (`getCellValue`, `setCellValue`)

**EXTENSIONS:** (a few examples)
- Bold/Italic/Font formatting
- Sort and Filter
- Charts and Graphs
- Data Validation
- Financial functions (PMT, NPV, IRR)
- Statistical functions (AVERAGE, STDEV)
- Pivot Tables

## Development environment
In order for Rust environment to work it must first be set using the script:
core\setup-rust-env.ps1

## Git Commit Messages

When I ask for a commit message, or when starting a conversation, check for uncommitted
changes using `git diff` and `git status`. Suggest a conventional commit message based
on the changes. Format: `type(scope): description`. Do not run git commit -- only
provide the message text so I can paste it into the Source Control input box.

## Backward compatibility
Since we are currently not in production there is no need at all for backward compatibility.