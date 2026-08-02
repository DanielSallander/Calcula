# Scriptable Objects Design

## Context

Calcula aims to make all objects customizable and "open" for users. Rather than limiting users to fixed property panels, every object exposes its code so users can extend behavior and appearance directly.

This feature sits at the heart of Calcula's founding vision. Excel was loved for letting users solve any specific problem themselves -- formulas, VBA, add-ins -- while the industry's successor tools (Power BI) lock users to vendor visuals and vendor data models, leaving them to wait for Microsoft to ship features. Scriptable Objects restore that "build it yourself, today" power through a modern, discoverable, typed experience. But they deliberately avoid repeating VBA's two failure modes: **security** (VBA macros run with full machine access; Calcula scripts are limited by tiered access levels -- see Design Decision 2) and **opacity** (VBA code hides inside binary files where a recipient never knows what a workbook will do; Calcula scripts are visible TypeScript, discoverable on the object that carries them, and must not run from a distributed package without explicit consent -- the Script Security consent dialog exists, with provenance wiring pending; pulled scripts are forced to restricted access in the meantime).

## Core Concept

Every object in Calcula is a **live, scriptable component**. Users can open a "Code" tab and extend the object's behavior using TypeScript, with full autocomplete and scaffolded templates.

## Two Categories of Scriptable Objects

### Component Objects (per-instance scripts)
- **Examples:** Slicer, Chart, Pivot, Button, TextBox
- Scripts are attached to **individual instances** (this specific slicer)
- Can be saved as **templates** and stamped into new copies

### Primitive Objects (workbook-scoped scripts)
- **Examples:** Workbook, Sheet, Cell, Row, Column
- Scripts apply to **the type itself**, not individual instances
- One Cell script affects all cells in the workbook
- One Sheet script affects all sheets in the workbook
- Per-sheet differences handled via logic branching, not separate scripts

## Scriptable Object Hierarchy

```
Workbook              (one script - lifecycle, global events)
  |-- Sheet           (one script - applies to all sheets)
      |-- Cell        (one script - applies to all cells)
      |-- Row         (one script - applies to all rows)
      |-- Column      (one script - applies to all columns)
      |-- [Components]  (per-instance scripts - slicer, chart, etc.)
```

## Design Decisions

### 1. Approach: Layered
- Objects have a sealed core (rendering primitives, data binding)
- The object's "personality" is a script that's fully editable
- Users can override appearance methods, add event handlers, add new UI elements
- The sealed core is not accessible/modifiable by user scripts

### 2. Scope Isolation: Tiered Access
- **Restricted mode (default):** Script can only access the object's own state, its parent sheet, and a limited API surface
- **Unlocked mode (opt-in):** Script gets full extension API access - read/write cells, register commands, listen to global events
- Matches how extensions already work in the architecture

### 3. Reusability: Template/Stamp Model (Component Objects only)
- Users can save a customized component object as a **template**
- Templates can be stamped into new independent copies
- No live link back to the template - once stamped, each copy is independent
- Templates stored in user-level folder (e.g., `%APPDATA%/Calcula/templates/`)
- Exportable as `.calcula-template` files for sharing

### 4. Discoverability: Monaco Editor + Scaffolded Templates
- Code tab uses an embedded **Monaco editor** with full IntelliSense
- Each object type has a **scaffolded default script** with commented-out event handlers
- Users uncomment what they need, autocomplete guides the rest

### 5. Typed Contexts: Per-Type
- Each object type defines its own context type (`SlicerContext`, `CellContext`, `SheetContext`, etc.)
- Strong typing makes autocomplete valuable and prevents cross-type errors
- Contexts defined in the API layer (`src/api/`)

### 6. Language: TypeScript/JavaScript
- Natural fit with the existing stack
- Shares the extension API
- Monaco provides native TS support

## Execution Model

Lifecycle-based, not continuously running:

```
create  ->  mount  ->  [user interactions / data changes]  ->  unmount  ->  destroy
```

Scripts register handlers during `mount`. Handlers fire in response to specific events. Idle objects cost nothing.

## Code Tab UX Example

User right-clicks a slicer -> "Edit Script" (or Code tab in properties panel):

```typescript
// Slicer: "Region Filter"
// Access level: restricted (unlock full API in settings)

import type { SlicerContext } from '@calcula/api'

export default function setup(slicer: SlicerContext) {
  // == Events ==
  // slicer.onSelectionChange((items) => { })
  // slicer.onDataRefresh((data) => { })

  // == Appearance ==
  // slicer.style.itemRenderer((item, ctx) => { })

  // == Custom Methods ==
  // slicer.expose('myMethod', () => { })
}
```

## Storage

- **Instance scripts:** stored inside the `.cala` file alongside the object's other properties (position, config, data source). The script is just another property.
- **Primitive object scripts:** stored at workbook level inside the `.cala` file.
- **Templates:** stored in `%APPDATA%/Calcula/templates/`, each a small JSON file with object definition + script. Exportable as `.calcula-template`.

## How This Covers VBA Use Cases

| VBA Pattern | Scriptable Objects Equivalent |
|---|---|
| `Worksheet_Change` | Cell or Sheet script |
| `Workbook_Open` | Workbook object script |
| Custom ribbon buttons | Extension system (existing) |
| UserForms | Component objects with custom scripts |
| Per-object macros | Component instance scripts |
