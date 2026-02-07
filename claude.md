# Calcula - Open-Source Spreadsheet Engine

Calcula is an ambitious open-source spreadsheet application (Excel alternative) built for high performance and extensibility using a microkernel architecture.

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
│   └── extensions/         # MOVED OUTSIDE 'src'
│       ├── _standard/      # Base extensions
│       │   ├── formatting/ # Font, Color, Borders
│       │   ├── sorting/    # Sort & Filter logic
│       │   └── charts/     # Charting engine
│       │
│       └── _3rdparty/      # User installed extensions (gitignored)
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

1. **The "Alien" Rule:** The Core (`src/core`) must NEVER import from `src/extensions` or `src/shell`
2. **The Facade Rule:** Extensions (`src/extensions`) must ONLY import from `src/api`. Deep imports into `src/core` are strictly forbidden
3. **Dogfooding:** Built-in features (Formatting, Charts) must be built using the public Extension API. If the API cannot support a feature, improve the API rather than hacking the feature into Core
4. **Inversion of Control:** The Core does not call Extensions. The Core emits events/hooks (via the API), and Extensions respond
5. **Primitive vs. Logic:** If a feature requires new logic (e.g., Sorting), implement generic primitives in Core (e.g., read/write range) and specific business logic in an Extension
6. **Feature Location:** Default to building features as Extensions (`src/extensions/builtin/`) unless they are foundational primitives (like Rendering or Undo/Redo)

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

**EXTENSIONS:**
- Bold/Italic/Font formatting
- Sort and Filter
- Charts and Graphs
- Data Validation
- Financial functions (PMT, NPV, IRR)
- Statistical functions (AVERAGE, STDEV)
- Pivot Tables