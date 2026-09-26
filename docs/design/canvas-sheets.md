# Canvas sheets — report pages of floating objects

Status: M1–M9 BUILT 2026-09-25 and PROVED LIVE (`app/e2e/journeys/canvas.spec.ts` #1–#7,
`floating-range.spec.ts`). What is open lives in `open-items.md` §2.af, never here. The plan, with the owner's
decisions, is `i-want-to-introduce-wiggly-wozniak.md` in the owner's plans folder.

## 0. What a canvas is

A **canvas** is a sheet kind modelled on the Power BI report canvas: no cell grid, only floating
objects — charts, slicers, timelines, controls (buttons, shapes, pictures, text boxes), floating grids
and pivot tables — on a fixed page (16:9 1280×720 by default; 4:3, Letter or custom) with a snap grid.
Objects on a canvas read their data from cells on other sheets. It is added from the sheet-tab "+"
caret ("Canvas"), and a contextual **Canvas** ribbon tab appears while one is active: Insert, Snap to
grid, Grid size, Show grid, Page size, Background, Fit / Actual size.

The word "canvas" alone already names the HTML painter, so code and strings say **canvas sheet** where
the two could be confused.

## 1. The one idea: an ordinary sheet with a kind tag

A canvas is an **ordinary user sheet** carrying a kind in a parallel vector. It keeps a real,
permanently empty engine grid, so every index-keyed store, the active-mirror swap, the multi-sheet
formula context and 3D ranges keep working unchanged. Three things make it a canvas:

1. **Kind authority.** `AppState.sheet_kinds: Persisted<Vec<SheetKind>>`
   (`persistence::SheetKind` / `CanvasLayout`, `core/persistence/src/lib.rs`), maintained at every
   site `sheet_display_flags` is (append, rotation, delete, move; copy of a canvas is refused).
   `CanvasLayout` holds snap, grid size, show grid, page preset and size, background, `z_order` and
   `locked`. It is saved in `SheetMetadata` (`.cala` format **v9**, stamped only when a canvas exists:
   an older reader would show an editable worksheet — the *mishandle* class) and in
   `PublishedSheetMetadata` (`.calp`). `sanitized()` repairs out-of-range values on load and pull;
   `validate()` refuses them on edit (`set_canvas_layout`, not undoable, like display flags).
2. **Write refusal at every door.** One predicate, `is_canvas_sheet` / `ensure_not_canvas_in_state`
   (`app/src-tauri/src/sheets.rs`), in front of every user-facing cell writer; the door census
   `every_canvas_write_door_is_wired_and_ordered` (`app/src-tauri/src/commands/canvas_sheet_tests.rs`)
   pins each gate by source text AND by order (gate before `DocumentEffect`). The ONE sanctioned
   writer into a canvas's grid is a **canvas pivot** (§5).
3. **A surface in Core.** `GridState.surface` (`"grid" | "canvas"`) is resolved in the same reduce
   step as the sheet context, so it can never tear against it. On a canvas the renderer skips
   gridlines, cells, headers, selection and the page-layout overlay (the cell pass must be SKIPPED,
   not just hidden: the hidden grid holds pivot cells); selection actions are frozen; the header
   gutters collapse to 0.

**The gutter rule has one home.** `paintedDisplayHeadings(surface, displayHeadings)`
(`app/src/core/lib/gridRenderer/layout/headerVisibility.ts`) — a canvas never shows headings — feeds
`effectiveGridConfig` for the painter AND for the mouse layer (`useSpreadsheetSelection.ts`). The
mouse layer once read the stored config, and every object on a canvas was clickable one header away
from its paint (BUG-0139). Any code that turns a pixel into a place must use the painted gutters.

## 2. Snap, page and editability: `@api/layoutSurface`

Core owns the pointer gesture for every floating object, and asks ONE provider at the one point every
family's geometry passes through (`app/src/core/lib/layoutSurface.ts`, re-exported as
`@api/layoutSurface`): `{ snapToGrid, gridSize, showGrid, page, editable }` for a sheet, or `null` for
a worksheet. Core snaps the dragged edges (after the 3px threshold, so a click on an off-grid object
never moves it), clamps to the page (never pulling a dragged edge past a fixed edge already off a
shrunken page), bypasses snap with Alt, and refuses the gesture when `editable` is false. A region
opts out with `data.snap === false` (all snapping) or `data.snapResize === false` (resize only —
floating grids quantise their own resize to rows and columns).

**Editable = not subscribed.** A canvas pulled from a Collaboration application is the publisher's
layout and is read-only until detached. Design Mode is deliberately NOT part of the rule (a
departure from the plan): it is session-only and starts off, so gating on it left a new canvas's charts
immovable while the same chart on a worksheet moved freely.

The CanvasSheet extension (`app/extensions/CanvasSheet`) is the provider; it also paints the page
background and the dot grid, and owns the Canvas tab.

## 3. Objects that read other sheets

- **Charts are bound by sheet id**, never by name or index: `DataRangeRef.sheetId`, resolved id-first
  (`app/extensions/Charts/lib/dataSourceResolver.ts`); index-only refs from older documents are
  migrated on load. Chart data is read with `getRangeCellsTyped(sheetIndex)` rather than the
  active-sheet viewport, and invalidation is keyed on the SOURCE sheet, so a chart on a canvas repaints
  when its Sheet1 source changes while the canvas is on screen.
- **Off-sheet writes announce themselves**: script and control writes to a non-active sheet emit a
  sheet-tagged `CELLS_UPDATED`.
- **Inserting** goes through each family's own seam (`controlsService`, `floatingRangeService`,
  `chart:createDialog`, `slicer:insertDialog`, `pivot:createDialog`) at a default rect computed by the
  canvas (viewport centre, snapped, cascading) — never by hand-rolling another extension's domain.
- **Keyboard**: Tab / Shift+Tab cycle the objects and Escape deselects through
  `@api/objectSelection` providers. Never dispatch `floatingObject:selected` from the keyboard: it
  means "a mouse press landed", and it runs button macros.

## 4. Collaboration (.calp)

Everything on a canvas travels as a typed artifact: the kind and layout in `metadata.json`,
`floating_ranges.json` (host AND backing sheet ids remapped), `timeline_slicers.json`, charts with
their data-source sheet ids remapped to the SUBSCRIBER's sheets on subscribe and refresh
(`core/calp/src/chart_refs.rs`; never on checkout, where ids are the application's own), and pivot
definitions carrying their frame. After every pull `restore_partition_invariant` puts user sheets
back in a contiguous prefix with object sheets at the tail, and re-anchors every index-keyed object of
a sheet it moves. Publish follows what objects need: a chart's source sheet, a pivot's destination
and source, a floating range's host and backing sheet — but never silently drags in a SUBSCRIBED sheet
(another publisher's content) or an object sheet whose host is not published. Detaching a sheet
claims the objects on it, so the next refresh neither deletes them nor rewrites their cells.

## 5. Pivot tables on a canvas

Owner's decision: a **real pivot in the canvas's hidden grid**, shown through a windowed, scrolling
box — not a cell-less "pivot visual". So slicers, timelines, pivot charts, GETPIVOTDATA and
`=Canvas1!B5` all work, because the cells exist.

- `PivotDefinition.canvas_frame: Option<CanvasFrame { x, y, width, height, frozen_headers }>`
  (`core/pivot-engine/src/definition.rs`; absent on worksheet pivots, so their JSON is unchanged).
- **Create**: a canvas destination REQUIRES a frame and an explicit non-canvas source sheet; a
  worksheet destination refuses a frame. The anchor is allocated by `allocate_canvas_pivot_anchor`
  in 1024-column blocks at row 0 (at most 16 pivots per canvas); a pivot wider than its block fails
  loudly rather than spilling into the next. The frame moves through `update_pivot_properties`
  (undoable); `relocate_pivot` refuses a framed pivot.
- **Every pivot write** now cascades to readers on OTHER sheets (`recalc_after_pivot_write`) and
  writes its merges to ITS OWN sheet — both were active-sheet-only defects (BUG-0140/0141). The
  active-sheet cascade evaluates with no pivot lookup, so the active branch also runs the off-sheet
  pass; otherwise a GETPIVOTDATA elsewhere turned #REF!.
- **GETPIVOTDATA matches the referenced sheet** (BUG-0145): every canvas's first pivot sits at A1, so
  a lookup by cell alone answered from whichever pivot a hash map listed first.
- **The box** is a floating `pivot-visual` region (`app/extensions/Pivot/lib/pivotVisualOverlay.ts`),
  painted directly into the grid context under a clip and a translate — no offscreen buffer (a buffer
  copied at fractional device pixels blurs text at zoom ≠ 100%). Headers stay frozen while the body
  scrolls; the scroll is session-only per pivot and driven by the shared wheel helper
  `app/extensions/_shared/lib/objectWheelScroll.ts`. The +/- and filter buttons are reached through
  `claimsBodyDrag` + `floatingObject:bodyDragStart`, because a press on a floating object is consumed
  before any cell interceptor runs. Selecting the box makes it the active pivot (field list, Design and
  Analyze tabs).
- **Create flows**: the Canvas tab's PivotTable item, the Create PivotTable dialog in canvas mode
  (destination fixed to "this canvas", source must name a worksheet), and the Business Intelligence
  "PivotTable from Model" flows — all taking their default frame from
  `app/extensions/_shared/lib/canvasPivotFrame.ts`.

## 6. Floating grids that scroll

A floating grid shows a window of rows × columns; when its CONTENT is larger (a window shrink hides
cells, it never deletes them; formulas spill), the overflow scrolls with the wheel, with sticky local
column letters and row numbers, on canvases and worksheets alike.

- Scroll lives in a session-only side map keyed by id (`app/extensions/FloatingRange/lib/frScroll.ts`)
  — NOT on the store entry, which is rebuilt on every mutation and would reset it.
- The content extent is the window grown to the backing sheet's used range, capped at 1000×256
  (`frExtent.ts`), read with the existing `getUsedRange` — no new command. The backend write door is
  the SAME extent (`floating_range_write_extent`, `app/src-tauri/src/floating_range.rs`): a cell the
  reader can scroll to and select is a cell they can edit.
- Painting reads only the visible rectangle, in row bands of at most 100,000 cells (a larger window
  used to fail to paint at all, BUG-0144), clipped to the cell viewport with no buffer.

## 7. Arrange: one stacking order, one selection, one undo step

- **One z-order.** Before M8 there were three "topmost" rules (paint by overlay priority, body hit by
  reverse array order, resize handles by forward array order), and every drag frame re-published a
  family at the array's end. Now `stackedFloatingRegions` (paint, bottom-first) and
  `floatingHitOrder` (its exact reverse) in `app/src/api/gridOverlays.ts` drive painting, the body
  hit test, the resize scan (which stops at the first body containing the point, so an occluded handle
  cannot be grabbed), the wheel, Tab-cycling and every family's context-menu lookup. An optional
  `GridRegion.z` (or the registered stacking resolver) switches it on; without one, orders are
  exactly as before. On a canvas the resolver answers the index of the object's ref in
  `CanvasLayout.z_order`; refs MISSING from the list paint ABOVE listed ones, so a newly inserted
  object appears on top. Object refs: `{chart|slicer|timelineSlicer|floatingRange|pivot|control, id}`
  (a control's id is its `row:col` anchor, since its region id embeds the sheet index).
- **One selection.** `@api/objectSelection` holds a canvas-level SET across families; each family
  still holds what it can (Chart, Floating Range and the pivot box are single-select, so extra members
  are held by the set and their chrome is painted by CanvasSheet). A press on another family
  deselects the first unless Ctrl/Shift is held (press parity); a band dragged on the empty page
  selects every object it touches (the marquee). The Name Box shows the selected object's name, or
  "N objects".
- **One geometry seam, one undo step.** Align, distribute, group drag and nudge move objects through
  `@api/objectGeometry` providers (one per family), grouped inside ONE undo transaction that every
  backend recorder JOINS (`record_restores_joining_open_transaction`); debounced saves are flushed
  before the transaction commits; a refused move (a protected sheet) reverts and shows one toast.
  Controls persist a whole gesture through one `set_control_geometry` batch.
- **Lock** is `CanvasLayout.locked`: Core treats a locked object as unmovable and unresizable, but it
  stays selectable. Bring/Send and Lock always write the FULL list.
- **Nudge**: arrows move the selection to the next snap multiple (snap on, no Alt), else 1px / 10px
  with Shift; a burst is one undo step. A floating grid with a cell selected, or a chart below chart
  level, keeps the arrows.

## 8. What a canvas refuses, on purpose

- Cells of any kind, from any door (§1) — except canvas pivots.
- Print and PDF (v1): printing reads cells and a canvas has none; refused with a message.
- Copying a canvas sheet (no object store is cloned); `core:copySheet` is hidden for a canvas.
- Freeze panes, split, headings/gridlines toggles, view modes.
- Converting a sheet between worksheet and canvas: a kind is fixed at creation.
- xlsx: a canvas is written as a hidden worksheet and the loss report says "Canvas sheets".

## 9. Where the proofs are

| Claim | Test |
|---|---|
| Every cell door refuses a canvas, gate before effect | `canvas_sheet_tests.rs` door census + per-door behavioural tests |
| Kind + layout round-trip `.cala` v9; worksheet-only documents unchanged | `core/calcula-format` zip_io tests |
| Snap applies to the PERSISTED position, OFF control lands unsnapped | `canvas.spec.ts` #3; `overlaySnap.test.ts` |
| A canvas chart reads Sheet1 and repaints both ways | `canvas.spec.ts` #2 |
| Publish / pull carries the page, chart (bound to the PULLED sheet) and floating grid, read-only | `canvas.spec.ts` #5; `calp_materialize_tests.rs` |
| A canvas pivot: real cells, painted only inside its box, wheel scrolls it not the page, resize persisted and snapped, a slicer refilters it and a Sheet1 formula follows, survives save/reopen | `canvas.spec.ts` #6; `canvas_sheet_tests.rs` |
| GETPIVOTDATA answers from the referenced sheet | `getpivotdata_answers_from_the_pivot_on_the_referenced_sheet_not_any_pivot_at_that_cell` |
| A floating grid scrolls, fetches only what is visible, and writes within its extent | `frRendererScroll.test.ts`, `frScroll.test.ts`, `floating_range_recalc_tests.rs` |
| Bring to Front changes what paints AND what a click selects at an overlap, and survives reopen; marquee + Align Left; a snapped nudge persisted and undone by one Ctrl+Z | `canvas.spec.ts` #7; `gridOverlaysStacking.test.ts`, `overlayStacking.test.ts`, `objectGeometry.test.ts` |
| A cross-family arrange is ONE undo step | `a_cross_family_arrange_is_one_undo_step_and_one_ctrl_z_restores_all_four` (`canvas_sheet_tests.rs`) |
