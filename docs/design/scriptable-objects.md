# Scriptable Objects Design

## Context

Calcula aims to make all objects customizable and "open" for users. Rather than limiting users to fixed property panels, every object exposes its code so users can extend behavior and appearance directly.

This feature sits at the heart of Calcula's founding vision. Excel was loved for letting users solve any specific problem themselves -- formulas, VBA, add-ins -- while the industry's successor tools (Power BI) lock users to vendor visuals and vendor data models, leaving them to wait for Microsoft to ship features. Scriptable Objects restore that "build it yourself, today" power through a modern, discoverable, typed experience. But they deliberately avoid repeating VBA's two failure modes: **security** (VBA macros run with full machine access; Calcula scripts are limited by tiered access levels -- see Design Decision 2) and **opacity** (VBA code hides inside binary files where a recipient never knows what a workbook will do; Calcula scripts are visible TypeScript, discoverable on the object that carries them, and must not run from a distributed package without explicit consent -- the Script Security consent dialog exists and **provenance wiring is live** -- `buildHandleFromDefinition` (`app/src/api/scriptHost/broker.ts:85-97`) derives `isDistributed` from `definition.provenance === "distributed"`, and that drives the tier ceiling, whether `ui.html` is auto-granted, and whether consent is required).

> **[CORRECTED 2026-08-16]** The clause above previously read *"with provenance wiring pending; pulled scripts are forced to restricted access in the meantime"*. That was a Wave-2-era statement (see `script-sandbox-architecture.md` §12) and had been stale for some time. Distributed scripts are still forced to the restricted tier -- but now because provenance is a real, plumbed input to the broker, not as an interim blanket measure.

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

**[UPDATED 2026-08-16]** The diagram is the original concept and is still the right mental model,
but the set has grown. The authoritative list is the `ScriptableObjectType` union in
`app/src/api/scriptableObjects.ts:34-54`, which now carries, beyond the five primitives above:
`slicer`, `chart`, `pivot`, `button`, `textbox`, `timeline`, `shape`, `table`, `namedRange`,
`range` (a cell-behavior binding target from granular-bricks phase 2 -- its `instanceId` is the
binding id in the cell-behaviors store) and `panel` (UI objects keyed by panel id).

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

> **[SECURITY -- added 2026-08-16, after BUG-0092.]** A `.calcula-template` file is **executable
> code plus the privilege level it asks to run at**, not a document. The bullets above describe it
> as a sharing format, and that framing is exactly what produced the defect: `importTemplate` was
> `JSON.parse(json) as ObjectTemplate` -- a **cast, which validates nothing** -- and the parsed
> object was persisted verbatim, `accessLevel` included. `stampFromTemplate` copies that field onto
> the stamped definition and `buildHandleFromDefinition` (`broker.ts`) turns
> `accessLevel === "unlocked"` into `tier: "unlocked"`: whole-workbook reach (`getCellValue`,
> `setCellValue`, `updateCellsBatch` over 100,000 cells, `executeCommand`). Object scripts run on
> their object's events, so no further user gesture was needed to execute it. **An imported file
> chose the privilege tier of the code it installed.**
>
> Two rules now hold, enforced in `app/extensions/ScriptableObjects/lib/templateManager.ts:209-263`
> and pinned by `__tests__/templateImportTier.test.ts`:
>
> 1. **The file never chooses its tier.** `accessLevel` is hard-coded `"restricted"` under the
>    comment *"NEVER `raw.accessLevel`."*
> 2. **The file never chooses its identity.** The id is a fresh `crypto.randomUUID()`, *"so an
>    imported file cannot choose the identity that a capability grant or a source hash is keyed to."*
>
> Import is a field-by-field validator; anything unknown or malformed is refused with
> `TemplateImportError`. Any future "share a template" affordance must keep both rules, and the UI
> must not invite the user to "import a file" as though they were choosing a document. Full write-up:
> `wave3-scripting-security.md` §12.

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
