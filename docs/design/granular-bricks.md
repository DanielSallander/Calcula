# Granular Bricks — The Grid is Programmable at Every Grain

**Status:** Phase 1 (Cell Types) SHIPPED · Phase 2 (Cell Behaviors) SHIPPED v1 · Phase 3 (Structural bricks) SHIPPED v1 · Phase 4 (Grid layers) SHIPPED extension tier · Phase 5 sketched
**Owner docs:** PHILOSOPHY.md ("Bricks of Every Size"), ARCHITECTURE.md
**Shipped in phase 1:** `app/src/api/cellTypes.ts`, `app/src-tauri/src/cell_types.rs`, `app/extensions/CellTypes/`
**Shipped in phase 2:** `app/src/api/cellBehaviors.ts`, `app/src-tauri/src/cell_behaviors.rs`, the `"range"` object type (contextShims/host forwarders/aspects), `app/extensions/ScriptableObjects/lib/cellBehaviorUx.ts`
**Shipped in phase 3:** `app/src/api/rowHeaderOverrides.ts` (+ multi-provider `columnHeaderOverrides.ts`), gutter paint/click in `headers.ts`/`headerSelectionHandlers.ts`
**Shipped in phase 4:** `app/src/api/gridLayers.ts` + four z-anchor walk-points in `renderGrid()` (`context.grid.layers`)

## Why

Excel was lego: bricks you could build anything with. Calcula's founding promise
("Never Wait for the Vendor") restores that — but the unit of customization must
not stop at the *feature* level (an extension) or the *object* level (a chart
script). A tinkerer should be able to reshape a **single cell** — how it renders,
how it edits, what a click does — and, at the other end of the scale, lay a
**custom layer** across the whole grid. Smaller bricks; more constructions.

This document defines the brick system: what exists, the two-tier architecture
that keeps it safe and fast, and the phased roadmap toward ever-smaller grains.

## The two-tier model

The single hard constraint that shapes everything: **the paint loop is
main-thread, 60 fps, O(1) per visible cell — and sandboxed code can never run
synchronously inside it.** Everything else follows:

> **Extensions extend the engine.** Trusted imperative registries invoked inside
> the hot paths: cell-type renderers compose into the paint loop, interceptors
> into the input paths. Main-thread TypeScript, dogfooded by every built-in.
>
> **Scripts program the workbook.** Sandboxed code (Worker realms / QuickJS)
> can only (a) SET declarative state that trusted renderers interpret at paint
> time, and (b) RECEIVE grid events asynchronously and respond through the
> normal audited, undoable write APIs.

```
MAIN THREAD (trusted)                              SANDBOX (untrusted)
─────────────────────────────────────────────      ──────────────────────────────────
Paint loop @60fps, O(1)/cell:                      Per-script Worker realms / QuickJS:
  cell-type renderers      (extension tier)          event handlers: onClick/onChange…
  style interceptors, cell decorations       async │ declarative writes:
  grid overlays, bitmap blits              events →│   setCellType / decoration specs
Input paths (async-tolerant):                      └→ normal write APIs — capability-
  click/cursor interceptors, edit/commit guards       checked, undoable, audited
State stores (the meeting point):
  cell-type tags {typeId, params} · behavior bindings · decoration/style specs
```

Every brick has both faces: the extension tier defines the **vocabulary**
(cell types, decoration grammars, header slots); the script tier **speaks it**
(sets tags and specs) and **reacts to it** (async events).

## Today's bricks (the catalog)

The extension API already exposes ~60 registration points. The grid-level ones
that this initiative builds on (all in `app/src/api/`, all dogfooded):

| Brick | File | Used by |
|---|---|---|
| Cell types (render+edit+click+validate per cell) | `cellTypes.ts` | **CellTypes extension (this doc, phase 1)** |
| Style interceptors (paint-time computed styling) | `styleInterceptors.ts` | Conditional Formatting |
| Cell decorations (in-cell canvas graphics) | `cellDecorations.ts` | Sparklines, data bars |
| Grid overlays (rect/floating regions + hit-test + cursor + drag claim) | `gridOverlays.ts` | Charts, slicers, pivots, validation |
| Cell click / double-click interceptors | `cellClickInterceptors.ts`, `cellDoubleClickInterceptors.ts` | AutoFilter, validation dropdowns |
| Cell cursor interceptors | `cellClickInterceptors.ts` | Cell types (pointer over checkbox/button) |
| Custom cell editors (React component swap) | `cellEditors.ts` | (registry live, first consumer pending) |
| Edit / range / commit guards | `editGuards.ts`, `commitGuards.ts` | Protection, Data Validation, cell types |
| Column header overrides + header click interception | `columnHeaderOverrides.ts` | Table, AutoFilter |
| Formula functions / custom functions (sandboxed UDFs) | `formulaFunctions.ts`, `customFunctions.ts` | Custom Functions |
| Chart marks / transforms (sandboxed renderers, bitmap-blitted) | `chartMarkScripts.ts`, `chartTransformScripts.ts` | Charts |
| Scriptable objects (per-instance TS on charts/pivots/slicers/shapes…) | `scriptableObjects.ts` | ScriptableObjects |

Plus the app-frame bricks (menus, panels, dialogs, overlays, status bar,
activity bar, commands, keybindings, events, settings, file formats) and the
data bricks (full cell/sheet/merge/filter/validation/BI access).

## The performance contract

Every brick that touches the paint path obeys these rules. They are what lets
a 1M-row grid stay at 60 fps while being this pluggable:

1. **O(1) per visible cell.** Lookups are indexed (`Map.get` with numeric keys),
   never scans. A brick that isn't relevant to a cell must bail in nanoseconds
   (`hasCellTypes()`-style fast flags let untouched workbooks pay zero).
2. **No allocation in the loop.** Contexts are reused; keys are numbers, not
   strings, in new code.
3. **Balanced canvas state.** Every hook runs inside `save()`/`clip()`/`restore()`
   owned by the caller; a throwing brick cannot corrupt the frame (try/catch at
   every dispatch).
4. **No synchronous I/O in paint.** Data arrives via state stores populated by
   events; paint only reads.
5. **No sandboxed code in paint. Ever.** Script-tier visuals are either
   declarative state interpreted by trusted renderers, or bitmaps rendered
   asynchronously off-thread and blitted from a cache (the chart-marks
   mechanism).
6. **Interaction may be async; claiming may not.** Input interceptors decide
   "claimed or not" synchronously-fast on the main thread; handlers then run
   async. For script-tier bricks this means claim decisions are **declarative
   metadata**, never handler return values.

## Phase 1 — Cell Types (SHIPPED)

A **cell type** is one brick composing rendering + editing + interaction +
validation, assigned to individual cells.

**The registry** (`app/src/api/cellTypes.ts`, exposed as
`context.grid.cellTypes`):

```ts
registerCellType({
  id: "calcula.checkbox",
  render(ctx)   // true = handled, Core skips the text pass; false = value stays visible
  editor        // "default" (normal inline editor) | "none" (gestures blocked)
  onClick(ctx)  // claim + act; all writes via normal undoable APIs
  onKeyDown(ctx)// Space on the selected cell (v1)
  coerce(v, p)  // commit-time rewrite ("yes" -> "TRUE")
  validate(v,p) // commit-time verdict: "block" | "retry" | null
  getCursor(p)  // CSS cursor over typed cells
  displayText(v, p)
});
```

**The assignments** (`app/src-tauri/src/cell_types.rs`): per-cell
`(sheet, row, col) -> { typeId, params }` in the backend — undoable
(`obj_cell_types` restore kind), persisted per sheet keyed by SheetId
(`cell_types.json` in .cala), and — unlike every older per-cell store —
**shifted by row/column inserts/deletes inside the same undo transaction as
the grid change**, so one Ctrl+Z restores both atomically.

**How it composes:** ONE new core hook (`renderCellTypeCell`, called from both
draw paths — main and freeze/split — after decorations, with a `handled` return
that suppresses the default text pass). Everything else fans out through the
existing registries: one click interceptor, one cursor interceptor, one edit
guard, one commit guard — each doing a single O(1) index lookup. The commit
guard needed one additive contract change: `CommitGuardResult.newValue` lets
any guard rewrite the committed value (rewrites chain).

**Starter types** (dogfood extension `app/extensions/CellTypes/`):

- **checkbox** — a real TRUE/FALSE cell: formulas keep working
  (`=IF(A1;…)`), formula cells render read-only; click + Space toggle through
  the normal write path (one undo step); typing coerces (`yes` → TRUE) and
  validates (`retry` on garbage).
- **progress** — numeric cell rendered as a bar
  (`params: { max, color, showLabel }`); normal editing; non-numeric values
  fall through to plain text.
- **button** — fires `params.action`: a registered command or a workbook
  script (script-security-gated; failures toast — a click that silently does
  nothing is a transparency failure). `editor:"none"`; in Design Mode clicks
  select instead of firing.

**Rules worth knowing:**
- *Fallback:* an assignment whose type id isn't registered degrades to a plain
  cell + small corner badge — nothing hidden, fully editable, tag survives
  save/reload and reactivates when the type registers.
- *Show Formulas mode* suppresses type rendering (the raw value/formula must
  be visible — transparency over prettiness).
- *Merged cells:* the master cell renders the type.
- *v1 scope cuts:* copy/paste/fill do not carry tags (follow-up:
  `ClipboardData.cellTypes`, the validations precedent); cell types are not
  published to .calp yet (`params.action` will need a
  `sanitize_distributed_controls`-style pass when they are).

**Incidental debt paid:** the dormant cell-cursor registry is now consumed by
core (`useMouseSelection`); the hardcoded `checkbox.toggle` Space dispatch in
`useGridKeyboard` became a generic cell-type hook (legacy fallback retained);
typed cells render correctly in frozen panes (the legacy transparent-text
checkbox hack never did).

## Phase 2 — Per-cell script behaviors (SHIPPED v1)

The tinkerer's tier: attach behavior to THIS cell/range from a sandboxed
workbook script — VBA's `Worksheet_Change`/click handlers, per-cell, safe.
Right-click a cell → **Attach Behavior…** creates a binding + a scaffolded
`"range"` script, mounts it, and opens the code editor.

**Attachment model (shipped).** A first-class **binding record**
`{ id, scriptId, sheetIndex, startRow..endCol, claimClick, enabled, orphaned }`
(`app/src-tauri/src/cell_behaviors.rs`) + the instance-scoped `"range"`
`ScriptableObjectType` whose `instanceId` = bindingId. Reuses unchanged: the
ObjectScriptManager mount lifecycle, Script Security gate, object-script
backend CRUD + .cala persistence, the Monaco editor + scaffolds. Principle:
**imperative creation, declarative existence** — persisted bindings are
inspectable without running code (the anti-VBA-opacity rule). Bindings are
undoable (`obj_cell_behaviors`), persisted per binding keyed by SheetId
(`cell_behaviors.json`), and shifted by structural edits **inside the same
undo transaction** with table-boundary semantics: insert above→shift,
inside→grow; delete overlapping→shrink, delete containing→**orphaned** +
disabled (undo restores; coords kept for re-targeting).

**Event routing (shipped).** One cell click + one double-click interceptor
(`app/src/api/cellBehaviors.ts`) do an O(1) index lookup → gates (Design Mode,
disabled/orphaned, script actually mounted — an unmounted behavior must never
swallow clicks) → emit `cellbehavior:clicked`/`:dblclicked`, which the host
forwards into that script's worker. **Click-claim is binding metadata
(`claimClick`), never a handler return value** (contract rule 6). `onChange`
rides the rAF-debounced cell-event batches: ONE delivery per binding per
flush, clipped to the target, capped at 1,000 entries + `truncated` flag;
**self-echo suppressed** via broker write attribution (every script write is
remembered ~250 ms; a script's own writes never re-fire its onChange); token
bucket **20 deliveries/s** per binding; the existing per-script watchdog
applies. The script surface: `range.onClick/onDoubleClick/onChange`,
`getAddress()/getValues()` (mirror-backed sync reads), `setValues()`
(structurally clamped to the target — restricted tier included), and the
two-tier handshake `setCellType(typeId, params)` / `clearCellType()`.

**Security (shipped).** No new capability — receiving events about your own
bound range is structural scoping; range scripts ride the existing
"object-script" surface, Script Security gate, and tier model (restricted by
default). Transparency: behavior cells show a corner badge in Design Mode
(orphaned = red), bindings are plain records in the store, and the scripts
pane lists range scripts like any other.

**`onBeforeCommit` (SHIPPED, the replying hook).** A range script can
validate/rewrite a user edit BEFORE it commits: return `"block"` (cancel),
`"retry"` (keep the editor open), or `{ newValue }` (commit a rewrite; chains
through the commit-guard pipeline). Unlike the fire-and-forget hooks it
REPLIES — the handler registers as an internal exposed method and the commit
guard awaits its verdict over the methodCall channel under a hard **1,500 ms
deadline**; timeouts, errors, and unmounted scripts all default to ALLOW, so
a hung script can never hold the user's keystroke hostage. The opt-in
`blocking: true` mode (deny-on-timeout, surfaced in consent) remains a later
slice.

**Deferred within phase 2:** cascade depth-cap stamping (needs end-to-end
write attribution through recalc; the self-echo suppression + rate limit cover
the common loop today); `range.setDecorations`/`setStyleRules` declarative
specs; named-range-anchored targets; per-binding fire counters in a dedicated
panel section; .calp carry of bindings with target-inclusive consent-hash
keying (range *scripts* already travel as object scripts and arrive
forced-Restricted; without their bindings they stay dormant until attached);
`blocking: true` deny-on-timeout commit verdicts.

## Phase 3 — Structural bricks (SHIPPED v1)

The grid furniture became bricks:

- **`columnHeaderOverrides` is now multi-provider** with priorities (first
  non-null wins) and multi-interceptor clicks — Table and AutoFilter no longer
  clobber each other's single slot; the legacy `setColumnHeaderOverrideProvider`
  signature registers into the same registry.
- **`rowHeaderOverrides`** (`app/src/api/rowHeaderOverrides.ts`): symmetric
  row-number text/color override providers, painted in both row-header paths
  (normal + frozen/split).
- **The row gutter lane**: `registerRowGutterWidget({ id, priority,
  getWidget(row) -> { glyph: dot|flag|chevron-right|chevron-down, color },
  onClick(row) })` — a per-row widget slot at the left edge of the row header
  (`ROW_GUTTER_WIDTH`, after the grouping outline bar), painted by the header
  pass and click-routed BEFORE default row selection. Dogfooded by cell
  behaviors: in Design Mode, rows intersecting a behavior target show a gutter
  dot (red when orphaned); clicking it opens the behavior's code editor.

**Still in phase 3's later slices:** script-tier declarative header/gutter
specs routed through the binding dispatch, and script-authored bitmap cell
renderers (OffscreenCanvas worker → host blit cache — the chart-marks
mechanism, applied per cell). (`onBeforeCommit` shipped — see phase 2.)

## Phase 4 — Grid layers (extension tier SHIPPED)

**Shipped:** `registerGridLayer({ id, anchor, priority, paint(ctx) })` — full-
viewport, scroll-synced canvas layers at four named z-anchors woven into
`renderGrid()`'s pass order: **under-cells** (after the background clear,
before gridlines/content), **under-selection** (after cell content +
cell-anchored overlays + spill borders, before the selection highlight),
**over-selection** (after selection + floating overlays, before headers), and
**over-headers** (topmost, before the page-layout chrome). The built-in passes
stay hardcoded; layers slot between them at walk-points guarded by
`hasGridLayers()` fast flags — zero cost when nothing is registered. Each
layer paints inside save/restore + try/catch (a throwing layer is contained).
Exposed as `context.grid.layers.register`. Dogfood: **Highlight Cell
Behaviors** (command + context menu) — an under-selection layer tinting every
behavior target on the active sheet (red = orphaned), registered only while
toggled.

**Remaining phase-4 slices:** refactor the built-in passes themselves into the
registry (pure refactor, no visual change), then the script tier — sandboxed
HTML layers as sketched below.

Original sketch: refactor `renderGrid`'s hardcoded pass order into a **named z-anchor registry**
(`under-cells | under-selection | over-selection | over-headers` + numeric
priority), with all built-in passes registered first (pure refactor, no visual
change). Then: full-viewport scroll-synced canvas layers for extensions, and
**sandboxed HTML layers** for scripts — a scroll-synced iframe
(`sandbox="allow-scripts"`, opaque origin, postMessage bridge; the
scriptable-shapes mechanism, `ui.html`-gated) with pointer-events pass-through
by default and opt-in declared hit rectangles.

## Phase 5 — Declarative renderers & rich values (direction)

- **Declarative cell renderer grammar:** a JSON template (stack/row of
  text/icon/bar/badge primitives bound to `value`/`params` with format +
  threshold rules) interpreted by ONE trusted renderer — the zero-worker-cost
  path to thousands of script-defined cells (the "StyleProgram" trade).
- **Rich values:** cell *types* tag CELLS (presentation + behavior at an
  address); rich *values* type the VALUE — `{ type: "stock", payload }`
  flowing through formulas, spills, copies. Requires engine `EvalResult` work.
  Bridge decision already made: the `render(value, params, ctx)` contract is
  value-driven, so every renderer survives a later value-typed dispatch.

## Distribution bricks (opening the `.calp` system)

The bricks above open the *grid*; a parallel family opens the *distribution*
system, so a third party can control how packages are hosted, labelled,
validated, and what object families travel. Guiding principle: **expose the
data plane, guard the control plane** — a third party may define *where
packages live* and *what travels*, but never *how signing/integrity/merge*
work (those stay hardcoded and mandatory).

**Brick 1 — Registry providers (SHIPPED).** The `.calp` core already had a
`RegistryTransport` trait; only `LocalRegistry` existed. Added
`HttpRegistry` (app crate, `reqwest::blocking`, **read-only**) + an
`open_registry(location)` factory that routes by URL scheme
(`file://`/path → local, `http(s)://` → HTTP), so **any static HTTPS host
(S3, nginx, GitHub Pages) is a valid read-only registry with no server code**.
Every calp command constructs its registry through the one factory; the two
`refresh` functions were generified `&LocalRegistry → &dyn RegistryTransport`,
and a forwarding `impl RegistryTransport for Box<dyn RegistryTransport>` lets
the factory return a boxed transport that callers pass as `&dyn`. **The trust
chain is transport-agnostic** — an HTTP pull runs the identical Ed25519
signature + TOFU pin + min-app-version + per-artifact SHA-256 verification
(inspect switched to `verify_manifest_signature_via`). A per-machine
saved-registry catalog (`registries.json` in the profile dir, never the
workbook) + a picker in the Subscribe dialog. `@api/distributionRegistries.ts`.

**Brick 2 — Pluggable package kinds (SHIPPED).** `registerPackageKind({ id,
label, description, refreshDefaults })` — the publish picker and package
inspection now show domain kinds beyond report/template/dataset. Frontend-only
(`@api/packageKinds.ts`): the `kind` string already flows end-to-end and the
backend falls back to `report` semantics for unknown kinds.
*Honest limit:* `refreshDefaults` is advisory metadata — the refresh pipeline
is not yet kind-aware (nor for the built-ins), so kinds drive labels/intent,
not (yet) engine behavior.

**Brick 3 — Writeback validators (SHIPPED).** `registerWritebackValidator(name,
label, fn)` — a publisher names a validator on a writeback region's schema; the
subscriber's client runs it as an **advisory, as-you-type check**. The name
rides the schema's forward-compatible `extra` map (no format change), surfaced
to the subscriber via `WritebackRegionEntry.custom_validator`.
*Security boundary, by design:* this is a frontend UX check only — the
**authoritative** built-in `ValueSchema` gate on the Rust submit path is
unchanged, so a bypassed custom validator can never land invalid data in the
shared registry. `@api/writebackValidators.ts`.

**Brick 4 — Distributable object types (SHIPPED, cell-types dogfood).** The
open channel for object families beyond the built-in set: a new optional,
forward-compatible `custom_objects` list in the version manifest, each entry an
opaque JSON artifact written under `custom_objects/{index}.json` (index-based
paths, so extension-supplied ids can't inject a filesystem path) and
**integrity-checked + signed like every other artifact**. Publish carries
them (`PublishRequest.custom_objects`); pull reads them
(`PullResult.custom_objects`); both survive a round-trip test. **Cell types are
the dogfood, materialized Rust-side** (mirroring controls, with the
package→local sheet remap, on pull AND refresh) — proving the channel
end-to-end. Third-party JS providers use the same channel through
`@api/distributableObjects.ts`: `registerDistributableObjectProvider({ kind,
collect, materialize })`; `publishPackage` auto-collects providers into the
package and `pullPackage` auto-dispatches non-built-in kinds back to them.
This is the seam that lets a **third-party custom pivot ship its definition** in
a `.calp`. *Deferred:* refresh-side dispatch to JS providers (cell types refresh
Rust-side today); `blocking: true` writeback verdicts remain a phase-3 grid item.

## Cross-cutting rules

- **No first-class citizens.** Every brick here ships behind `@api`; the
  CellTypes extension proves each phase by building on the public surface only.
- **Transparency beats capability.** Anything a script attaches to the grid is
  visible without running it: badges on cells, a panel that lists every
  attachment with target/provenance/counters, consent that re-prompts on
  retarget, audit entries for firings and writes.
- **The undo stack is sacred** (like the paint loop): every brick's writes are
  undoable through the normal pipeline; structural edits restore bricks and
  grid in the same transaction; transient/preview state never enters undo.
