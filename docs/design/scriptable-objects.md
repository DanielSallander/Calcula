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
> `wave3-scripting-security.md` §10 (BUG-0092).

### 4. Discoverability: Monaco Editor + Scaffolded Templates
- Code tab uses an embedded **Monaco editor** with full IntelliSense
- Each object type has a **scaffolded default script** with commented-out event handlers
- Users uncomment what they need, autocomplete guides the rest

**Macros start from a working example (2026-10-22).** A macro -- a module script the user runs
themselves -- is created from three doors that all do the same thing: **Developer > New Macro** (the
first item of the menu, `macroRecorder.new`), **Developer > Macros… > New Macro** (the dialog's
footer; the dialog stays open), and the Object Script Editor's own welcome panel together with
`+ Add Script… > Macro (a script you run)`. Each calls `createStarterMacro`
(`app/src/api/macroModules.ts`; pure `@api` over `listWorkbookScripts` / `saveWorkbookScript`, so
both windows and both extensions reach it without importing each other), which takes the first free
`MacroN` name, stores a module `macro-<slug>` whose description carries the `runtime=objectScript`
marker and which has NO `sourcePackage` (it is the user's own code), and fills it from
`buildMacroStarterSource` (`app/src/api/scriptHost/macroStarter.ts`). The starter adds 1 to every
selected cell that holds a number: `api.getSelection()`, one `getRangeValues` per selection area
(typed cells, so the number 5 and the text "5" are told apart and a formula is never overwritten by
its result), one `updateCellsBatch` with numbers written as numbers, `beginBatch` before the first
write and `commitBatch` in `finally` so a half-run is still one undo step, and a `setup(context)`
that runs it on every click when mounted on a button and once when run directly. Its header says
how to run it, change it and what publishing it needs; `macroStarterTypings.test.ts` proves it
type-checks clean under the editor's own `checkJs` language service, so `api.` and `context.`
complete. The editor never shows an empty buffer: with no script, no macro and no draft it renders
a welcome panel in front of the Monaco container (hidden, never unmounted), and the first macro
created anywhere replaces it. Runtime split: the Notebook runtime (`Calcula.*`,
`core/script-engine`) has no selection or active-cell op in its `OP_MANIFEST`, and its `getRange`
returns display text (an "add 1 to a named range" version would overwrite a formula with its
result), so no Notebook starter is offered; that runtime stays reachable from Record Macro…'s
radio and from the Notebook sidebar.

### 5. Typed Contexts: Per-Type
- Each object type defines its own context type (`SlicerContext`, `CellContext`, `SheetContext`, etc.)
- Strong typing makes autocomplete valuable and prevents cross-type errors
- Contexts defined in the API layer (`src/api/`)

### 6. Language: TypeScript/JavaScript
- Natural fit with the existing stack
- Shares the extension API
- Monaco provides native TS support

### 7. Properties by path, and bound properties (2026-10-15)

Every bindable object -- a chart, an on-grid or canvas control, a slicer, a timeline, a canvas page -- is
reachable through ONE handle that addresses its properties by JSON Pointer, the paths the object's own
JSON uses (`/spec/title`, `/properties/text`, `/headerText`, `/background`):

- `context.self` -- the script's OWN object, through `object.getState` / `object.setState` (restricted).
- `api.object(kind, id)` -- ANY object, through `api.objectGetState` / `api.objectSetState` (unlocked).
  `kind` is a binding kind (`chart`, `control` -- by the control's `uid` --, `slicer`, `timelineSlicer`,
  `pivot`, `floatingRange`, `canvasPage`) or a script object type mapped through the object's
  registration (`api.object("shape", "control-0-5-2")`); anything else is a ValidationError naming the
  kinds.

Six methods: `getProperty(path)` (what the user SEES: the binding's result, else the literal),
`getLiteral(path)` (the stored value; `getLiteral("")` returns the whole object JSON, the quickest way to
discover its paths), `getBinding(path)` (`{ formula, model }` or null), `setProperty(path, value)` (a
LITERAL, one JSON value of the property's type), `bindProperty(path, formula, { model? })` and
`unbindProperty(path)`. A BINDING is a formula -- cells, names, a model `[Measure]` under the page's
slicers, literal CUBE functions -- that Calcula re-evaluates whenever what it reads changes; scripts write
it INVARIANT (`,` separators, `.` decimals) whatever the user's locale. Design and semantics:
`canvas-sheets.md` §15.

The rules, each enforced before anything is written:

- **Three setState aspects with their own validator rows** (`binding.set`, `binding.clear`,
  `property.set`, `validators.ts`), so no path reaches `vSetState`'s permissive tail: the pointer must be a
  catalog path (the `@api/objectBindings` mirror of Rust's catalog); code, held code, a button's action
  wiring, position and identity keys are refused by name ("'onSelect' is code; code is never bound.");
  `setProperty` on a control key goes through the SAME per-key check as `shape.setProperty`
  (`checkShapeSetProperty`, which carries the media rule -- `src` takes a `media:{sha256}` already in the
  document or `""`, never a data: URI), and any other path through its catalog value type.
- **The restricted clamp.** A restricted script may bind only to cells on the sheet in front of the user
  -- no other sheet, no defined name, no table reference, nothing indirect (INDIRECT, OFFSET over a
  computed start, GETPIVOTDATA, GET.CONTROLVALUE). The host executor decides it from Rust's own analysis
  of the formula.
- **`bi.query` for measures.** A formula that reads a `[Measure]` or a CUBE function reaches the BI
  engine, so `bindProperty` requires `bi.query` (declared ceiling, then the grant, then the just-in-time
  prompt for a local script), although the method itself names no capability -- its JSDoc says so.
- **The object's own gates.** Protection ("edit objects") and Lock Objects refuse a binding or a literal
  exactly where they refuse the same change from the Properties pane; Rust re-applies them at its door.
- Every write is one undo step and one audit row as this script's (surface `objectScript`).

`ShapeContext.getProperty(key)` / `setProperty(key, value)` keep their meaning: key-based, literal, and
`=...` written through them is stored as TEXT (a formula-typed control property is refused since
2026-10-15; following a formula is `bindProperty`). In the typings, `context.self` is `ScriptObjectHandle`
and `api.object()` returns `ScriptTargetObjectHandle` (the same six methods): two names, because the
generator walks a named interface once and the two doors differ in tier and broker.

**The visual container (WP-C, 2026-10-16).** An object's Format-pane look -- padding, title, subtitle,
divider, spacing, background, border, shadow (`canvas-sheets.md` §14) -- is reached through the SAME doors,
never a new one: there is no `container.set` aspect, no shim method and no typings change
(`validators.test.ts` / `containerKeyScriptDoors.test.ts` assert the source names none).

- A chart, pivot box, slicer, timeline or floating grid: `setProperty` / `bindProperty` on a pointer under
  the kind's container root -- `/spec/container/border/radius`, `/canvasFrame/container/padding/top`,
  `/container/shadow/show` -- through `property.set` / `binding.set` and the catalog's `O::Container` rows.
  The value is checked by the container's own leaf rule (`checkContainerFieldValue`, the same sentence Rust
  gives); a colour given as `rgb()` / `rgba()` is stored as hex. Facts that keep their own spelling are
  refused under the container: `/spec/container/title/text` (a chart's title is `/spec/title`), a slicer's
  title text (`/headerText`), a floating grid's title text (its name: rename it) and `lockAspect` (never bound).
- A control: its flat `container*` keys (`containerTitleText`, `containerBackgroundColor`, ...; 51 keys,
  `CONTROL_CONTAINER_PROPERTY_KEYS`). The KEY door `ShapeContext.setProperty("containerTitleColor", v)`
  checks the value with `checkControlContainerValue` (after the 8 KiB cap) and stores text exactly as given:
  `#rgb` is accepted, `rgb()` is refused. The POINTER door `setProperty("/properties/containerTitleColor",
  v)` gives the SAME refusal sentence (the key's leaf rule speaks first) and then judges Rust's canonical
  spelling: `rgb()` becomes hex, an enum's case is ignored, and `#rgb` is refused (not a binding colour).
  `containerLockAspect` has no pointer row. Both doors end in `set_control_property_core`'s Rust check.

A binding is EVALUATED, never executed: it is not code, it is not in the code inventory, and it cannot run
anything -- the formula language is the cell formula language, under the transient evaluation budget.
Every binding in the workbook is listed by Formulas > Bound Properties... and in the AI's sheet summary.

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
| UserForms | ~~Component objects with custom scripts~~ **Superseded 2026-09-02:** a dedicated `form` object type — a host-painted modal widget tree with cell bindings, shown by its own script or by any other script through `caps.forms.show(name)`. See `docs/design/typescript-forms.md`. |
| Per-object macros | Component instance scripts |
