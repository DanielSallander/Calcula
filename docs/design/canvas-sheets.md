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

**One geometry answer per object: `objectGeometryEditable(sheetIndex, region, offSurface)`**
(`@api/layoutSurface`). On a layout surface it is `editable && !locked`; on a worksheet it is the
family's own rule. Only the FLOATING GRID publishes `movable`/`resizable` from it
(`floatingRangeStore.ts`, its sole caller). The other families do not: charts, slicers and the pivot
box publish no `movable` flag, a timeline publishes only `resizable` (while it is selected), and
Controls publish both from Design Mode for buttons. Core therefore applies the lock and the
subscription ITSELF, for every family: the press and the pointer from one rule
(`resolveFloatingZone`'s `canMove`, §2a), the corner resize in `overlayResizeHandlers.ts`; the canvas's
arrange / nudge / group drag re-check the lock on their own. Design Mode decides only what a press
on an object's WORKING area means.

**Floating grids** (owner decision 2026-09-27, replacing the 2026-08-13 "button rule"): the title
bar is the frame, not the working surface, so it moves the grid in every mode on every sheet kind
(`offSurface = true`). With the title hidden, a 4px band just inside the frame edge moves it; in
Design Mode the whole body does (`data.bodyGrab`, never `movable`: reading `movable` there would make
every title-less grid's cells unselectable). These are the grid's ZONES, answered by ONE pure
`frZoneAt` (its `OverlayRegistration.zoneAt`, M5; no cursor or body-drag claim beside it), from which
Core derives the press, the pointer and Ctrl/Shift: the title, the band and the Design-Mode body are
FRAME (Core selects, and moves the grid when it can move; one that cannot shows `default` and only
selects), cells, headers and a live edge ball are CONTENT (the grid's own work, on a locked or
subscribed grid too), and while a formula picks a reference the whole grid is content that picks and
never selects. Core asks once per press BEFORE the press selects anything, so the answer carries the
two facts the handlers must never re-derive: that the press is a reference pick (after the insertion
the text no longer expects one), and that the balls were live before the press's commit closed the
editor. The corner handles and edge balls exist only on a SELECTED
grid (`resizable = geometry && selected`), and are neither painted nor grabbable while its cell
editor is open: the editor announces open and teardown through `lib/frEditingRange.ts`, and the
store re-publishes `resizable` (`syncFloatingRangeRegions`, `installFrRegionResyncs`), which Core's
handles read through `floatingHandlesLive` (`core/lib/floatingHandles.ts`, §2b). The grid publishes
`handles: "corners"`: Core offers it the four corners only (they change the COUNTS), so no Core
midpoint pre-empts a yellow ball (they scale the CELLS; the balls paint in the grid's own
`floating-range-edge-balls` layer, above Core's outline, and only where the grid is on top at the
ball's centre -- where the ball is grabbable); an edge drag starts only past a latched 3px
threshold, so a click's wobble writes nothing; the right-click menu
follows editability, with its size items withheld on a locked grid. Every size door -- menu,
Properties, edge scaling (clamped to the page), the corner count-resize (never rounded past a
clamp), the script provider's `resize` -- asks `frGeometryEditable`, and the backend refuses a
geometry patch on a SUBSCRIBED CANVAS before its `DocumentEffect`. A drag persists ONCE, at
`moveComplete` (preview frames write nothing), so a human drag with pauses is one undo step. A
frame press (title, border band, Design-Mode body) commits an open cell edit first (click-away
semantics, in the grid's `floatingObject:selected` handler): the value is kept, edit mode ends; a
cell press commits too, unless it lands on the cell being edited. Buttons still need Design Mode to
be dragged: in run mode a button's body is content, and a press on it runs the button at the release
inside it (§2c).

The CanvasSheet extension (`app/extensions/CanvasSheet`) is the provider; it also paints the page
background and the dot grid, and owns the Canvas tab.

## 2a. The press grammar: one zone answer per point (BUG-0258)

The frame of an object moves it, its content does its own job, and the pointer says which is which
(owner decision 2026-09-29, design "Button Code and Moving Objects", Part 2). Each floating family
registers ONE pure function, `OverlayRegistration.zoneAt` (`@api/gridOverlays`), that answers
`frame` or `content` for a point -- with the content's pointer and the family's own name for the
part. Core resolves it ONCE per press, BEFORE the press selects anything (`resolveFloatingZone`;
`overlayMoveHandlers.ts` `pressZone`), and derives three things from that one answer:

- **The press.** Content: Core selects the object as a PLAIN press and hands the press to
  `floatingObject:bodyDragStart` with the raw modifiers; it never moves the object -- on a locked
  object and a subscribed page too, because reading a report is not editing it. Frame: Core selects
  (Ctrl/Shift add or toggle on a canvas) and moves the object when it can: `canMove` = not published
  `movable: false`, not locked on the layout surface, and the surface editable. A frame press that
  cannot move only selects; no move is armed.
- **The pointer.** Content: its own. Frame: its own if it names one, else `move` where the object can
  move and `default` where it cannot -- a locked or subscribed object never promises a move it will
  refuse. A content gesture that holds the button (the timeline's range drag) holds Core's pointer
  over its object (`holdContentGestureCursor`) and lets it go on every end path.
- **The modifiers.** On content they are the content's: Shift+click extends a timeline's range from
  its ANCHOR -- the period the last plain range gesture started at, kept by a Shift+click (click July,
  Shift+click February, Shift+click April gives April..July); a range no gesture of the session left
  (the backend's, a script's) extends by position instead -- and does not toggle the timeline out of a
  canvas selection. Excel's own timeline was not checked.

**The order.** A floating object is painted over the cells, the selection and its fill handle, so it
answers first: the mouse-down wrapper (`useSpreadsheetSelection.ts`) hands a press on a LIVE handle of
a selected object or on an object's body to the object BEFORE the fill handle and the cell click
interceptors, and the hover asks in the same order (a handle's pointer, else the body's zone pointer,
before the fill handle, the formula reference borders and the selection border). A handle is centred
on the object's edge, so its outer half lies over the neighbouring cells: asked after them, a press
there ran the cell's own action (a checkbox toggled, a button cell ran its macro) or started a fill
drag while the pointer promised a resize, and over a timeline tile or a locked object lying on the
active cell's border the pointer said `move` (a cell drag) while the press started a range drag or
only selected. A double-click on a handle's outer half never opens the cell editor underneath. While a
content gesture holds the pointer no handle takes the hover from it (the timeline's range drag selects
the timeline, so its handles turn live halfway through). Pinned end to end in
`components/Spreadsheet/__tests__/floatingPressBeforeCells.test.tsx` and
`hooks/useMouseSelection/__tests__/floatingHoverOrder.test.tsx`.

A family that registers no `zoneAt` is all frame. There is no second answer -- and no second WRITER:
an extension that writes `canvas.style.cursor` puts an inline cursor on the grid <canvas> CHILD, which
beats Core's pointer on the grid area. The Charts mousemove did that over every chart's bars, points,
slices, axes and buttons (a hand over a brushable plot's crosshair, over a movable chart's `move`,
over a locked chart's `default`) until the fixer round; the buttons that really act on a click now say
so in `chartZoneAt` (content, `pointer`, since phase 4b: §2c). The two cell writers left (checkbox cells, run-mode button
cells) write only where no floating object lies on the cell. `app/src/api/__tests__/
gridCanvasCursorCensus.test.ts` lists every inline-cursor writer in the extensions with its reason.
The per-press body-drag
claim and the floating pointer callback -- two answers kept in step by hand, which drifted until the
timeline showed a hand over month tiles that moved it -- were deleted (M5). The pointer callback
survives as `getCellCursor`, asked ONLY for CELL-ANCHORED regions (the worksheet pivot's icons, the
AutoFilter and validation chevrons). `app/src/api/__tests__/overlayZoneCensus.test.ts` holds it: no
source names the old claim, no overlay registration carries `getCursor:` (an `as
OverlayRegistration` cast would hide one from the compiler), and every family that publishes a
`floating` box registers `zoneAt` and nothing beside it -- found by what it publishes, so a new family
cannot slip past.

| Family | Content: its own work (pointer) | Frame: Core selects, moves when it can |
|---|---|---|
| Timeline (`lib/timelineZones.ts`) | the month tiles (`pointer`); the two range-end markers (`ew-resize`); the clear button while there is a filter and the level buttons (`pointer`, they act on release over themselves); the scrollbar (`default`) | the header (with the dimmed clear button while unfiltered), the year-label strip, the empty space, the gaps in the level row |
| Slicer (`slicerZoneAt`) | its items, "Select all", and the clear button while the slicer filters (`pointer`); the scrollbar (`default`) -- §2c | the header (with the dimmed clear button while unfiltered), the padding and the gaps between items; with the header hidden, a 4px band at its edges |
| Chart (`lib/chartZoneAt.ts`) | the plot area of a brushable, non-composed chart, off its param widgets (`crosshair`: the interval brush); a selected chart's quick-access buttons and param-widget controls, and a pivot chart's field buttons (`pointer`; they act on release over themselves, §2c) | everything else -- its bars and axes too (`move`); the widget strip off its controls; the insight cue stepper and comment boxes |
| Pivot box (`pivotVisualZoneAt`) | the +/- icons, the filter buttons and report-filter combos, and the loading indicator's Cancel (`pointer`; they act on release over themselves, §2c) | its cells and blank space |
| Floating grid (`frZoneAt`) | cells and row/column headers (`cell`); a live edge ball (`ew-resize` / `ns-resize`); the near-miss margin just outside the frame (`default`, inert); while a formula picks a reference, the whole grid (`cell`: it picks, never selects) | the title bar; with no title, the 4px border band (when it can move) and, in Design Mode, the whole body |
| Controls (`lib/controlZoneAt.ts`) | a run-mode button's whole body (`pointer`, part `button`; it runs on release inside it, §2c) | a Design-Mode button, and every shape and picture |

**The release.** Core also ENDS a frame move before any family hears the release: arming a move binds
a capture-phase window mouseup (`armMove`), so a release over the ribbon, the formula bar or a task pane
no longer reaches a family's own mouseup first. It used to, and the family then dropped its multi-move
snapshot: only the lead of a multi-selection was saved and the co-moved objects snapped back
(BUG-0265; inside the grid area React's onMouseUp always ended the move first, so nobody saw it).

## 2b. Handles only where they work (BUG-0258 design phase 3)

Core paints a selected floating object's selection chrome AND hit-tests its resize handles from ONE
module, `app/src/core/lib/floatingHandles.ts`, so a handle cannot be painted where it cannot be
grabbed, nor grabbed where it is not painted:

- **Live only on a SELECTED object** (`floatingHandlesLive`): selected by its family or held by the
  canvas selection set, not published `resizable: false`, not locked on the layout surface, the
  surface editable, and no formula picking a reference. Before, the four 10px corner boxes were live
  on every object: a press just outside an unselected chart resized it without selecting it, and a
  slicer's corners took presses on its first item with nothing painted there. A press 5px inside an
  unselected object's corner now falls to its body and selects it.
- **Eight handles that all resize**: the corners, plus the edge midpoints on edges of at least 48px;
  each drags only its own sides (the right-edge handle changes the width alone) and shows its own
  pointer (`nwse` / `nesw` / `ns` / `ew`, on hover and while dragged). Shapes and pictures painted
  eight handles before, of which only the four corners worked: an edge-midpoint press MOVED them. A
  region publishing `data.handles: "corners"` gets the four corners only (the floating grid).
- **Geometry**: 7px painted squares centred on the corner or edge midpoint (on a 1px white plate);
  the hit square is the centre +/- 6px (`FLOATING_HANDLE_HIT_HALF`, below 8 so a selected chart's
  quick-access buttons at right+8 stay clear). The numbers live in the import-free
  `core/lib/floatingHandleMetrics.ts` and are re-exported through `@api/gridOverlays` (the floating
  grid derives its shortest ball-carrying edge from the hit size).
- **Paint** (`core/lib/gridRenderer/rendering/floatingObjectChrome.ts`): after every floating object
  and before the over-selection layers, in the exact reverse of `floatingHitOrder`, a 2px outline in
  ONE colour (`#0e639c`) for every selected object, and the handles only while live. A locked object,
  or any object on a subscribed page, gets the outline and NO handles; the canvas's padlock paints over
  it. No family paints selection chrome of its own (the chart, button, shape, picture, pivot box,
  floating grid, slicer and timeline renderers each did, four different ways; the canvas painted a
  copy of the chart's frame for set-held members), which `floatingChromePaint.test.ts` holds with a
  source census.
- **Stacking**: handles are the topmost thing painted, so they are hit before any object's body: a
  selected object's handle painted over an object stacked above it is grabbable there. Where two
  selected objects' handles overlap, the topmost object's wins -- the one painted last.
- **Not under the headers**: the row and column headers paint AFTER the chrome, so no handle is hit
  inside the header gutters (`floatingHandleAt`): the covered half of the top handles of an object at
  row 1 (or of one scrolled under the header) is the header's, and a press there selects the column.
- **The floating grid**: a second or later grid of a canvas multi-selection (held by the selection
  SET: the family holds one range) is `resizable` too and gets its corners and edge balls, like every
  family's set-held member (`frRangeInSelection`).
- **Known gap**: an html shape's chrome still paints under its opaque DOM frame
  (`shapeRenderer.ts`, `framePaintsTheShape`).
- **The family follows the handle** (BUG-0268, found live by `moving-objects.spec.ts` step 9): a
  control resized by a Core handle used to get its OLD rectangle back, because the resize's own
  repaint re-read the control before the geometry write had landed (Tauri serves commands on a thread
  pool) and wrote the stale size back into the region. Every Controls geometry write is now tracked
  from the moment it is issued (`app/extensions/Controls/lib/geometryWriteOrder.ts`, through the one
  door `setControlGeometry`), a renderer's read waits for the writes in flight, and the ONE write-back
  (`floatingStore.applyResolvedControlSize`) applies a read only while it is still current.

## 2c. Content that works: slicer items, buttons and chrome act on release (BUG-0258 design phase 4)

Phase 4 finishes the zone table (§2a): every part of an object that DOES something is content, and
every button-like part acts when it is RELEASED over itself, never on the press -- the Windows button
rule: sliding off before the release cancels. A release the page never heard (a mousemove with the
primary button up) drops the press too, and so does the release of another button while the primary
one is up (a MIDDLE press arms a content press too -- Core hands over every press but the secondary).
The slicer, pivot box, chart-button and run-mode-button presses also cancel on Escape and a window
blur. Each gesture binds its window listeners for the press only (session-scoped rows in
`app/src/core/lib/globalInputListeners.ts`), and those four own Escape while they live through their
family's object-selection provider (`ownsKey`), so a canvas does not also deselect the object under
the pointer. A content press never moves its object, on a locked object and a subscribed page too.

Two more rules (M7 review, 2026-10-01):

- **A held content press holds Core's pointer** (`@api/gridOverlays` `holdContentGestureCursor`,
  released on every end path) -- the slicer's and the timeline's gestures always did, and the pivot
  box's chrome, a chart's buttons and a run-mode button now do too: while the button is held no grip
  shows and no resize handle answers, and the object keeps its pointer. (The chart's interval brush
  does not hold it yet: left open.)
- **"Released inside" means uncovered too.** A part another object covers is not the button's to
  release on -- Core's press there would have gone to the cover -- so the slicer's Select all and clear
  button, the pivot box's chrome and a chart's buttons ask `isFloatingRegionCoveredAtClient` (another
  object's visible grip, or an object stacked above whose rectangle or extended `hitTest` holds the
  point) and a run-mode button asks `topFloatingRegionAtClient` (its own rectangle and topmost). A
  chart's quick-access buttons sit OUTSIDE its rectangle, which is why the shared question is "nothing
  above it here", not "it is topmost here".

- **Slicer** (`app/extensions/Slicer`: zone `rendering/slicerRenderer.ts` `slicerZoneOfHit`, gesture
  `lib/slicerItemDrag.ts`).
  - Content: the items, "Select all" and the clear button (`pointer`), the clear button only while the
    slicer filters (unfiltered it is painted dimmed and is frame, D9); the scrollbar (`default`).
    Frame: the header, the padding and the gaps between items; with the header hidden, a 4px band at
    the edges (`SLICER_FRAME_BAND`, D3; the scrollbar wins over it). Paint, hit test, scroll clamp and
    gesture share one layout (`slicerFrameOf`), and the thumb one geometry (`slicerScrollThumb`).
  - A click on an item filters by the item's own rule (exclusive; Ctrl toggles; a 'multi' slicer
    toggles). A drag across items -- past Core's 3px threshold or onto another painted item -- selects
    the RUN from the pressed item to the one under the pointer (D4): a plain drag selects exactly the
    run, Ctrl+drag adds it, a 'single' slicer takes the item released on, a 'multi' slicer adds it. A
    run that covers every item clears the filter. **From an unfiltered slicer** an adding run (Ctrl,
    or any drag in 'multi') selects exactly the run, as a plain drag does: adding to "every item" is
    every item, so the drag wrote nothing and showed nothing while held, though the grammar says a drag
    across items selects the run (M7 review; `selectionAfterItemRun`). A CLICK there still toggles
    its item off (all but that one). **Owner call, beside D4:** keep this, or make the adding run from
    "all" remove the run, mirroring the click. While the button is held the run is a transient
    preview only the renderer reads (`lib/slicerGestureView.ts`: no backend write, no dirty flag); past
    the item area it clamps to the edge item and the items auto-scroll.
  - ONE queued commit at the release (`clickSlicerItem`, `clickSlicerItemRun` or
    `clickSlicerClearFilter`, each through `queueSlicerClick`): one backend command and one undo step
    for the slicer and every pivot it filters. A result equal to the current selection writes nothing.
  - "Select all" and the clear button act only when released over themselves, uncovered. The
    scrollbar moves the items (a thumb grab, or a jump on the track) and writes nothing.
  - **Ctrl+click on an item keeps the slicer selected** (BUG-0269). The Slicer kept its own capture
    mousedown and handed the RAW Ctrl to `selectSlicer`, which toggled the slicer OUT of its selection
    on every Ctrl+click on an item. That listener is gone: the object-selection Ctrl is Core's
    `detail.ctrlKey`, which Core sends false on content.
- **Canvas pivot box** (`app/extensions/Pivot/lib/pivotChromePress.ts`). A +/-, a report-filter combo,
  a Row/Column Labels filter button and the loading indicator's Cancel act at the release over the SAME
  chrome (D5), uncovered: the press records its key (`pressKey`), the release hit-tests the box as it
  is painted then. The 450 ms double-click guard (`REPEAT_PRESS_MS`) now runs between RELEASES, so a double-click
  on a +/- toggles it once.
- **Chart buttons** (`app/extensions/Charts/lib/chartButtonPress.ts`, ONE hit test read by the zone and
  the release). A selected chart's quick-access buttons and param-widget controls and a pivot chart's
  field buttons are content with a hand; the widget strip off its controls stays frame, and the brush
  is unchanged. A button acts only when its press is released over the SAME button (the same
  quick-access button, field, widget param and step), uncovered. Escape and a window blur cancel the
  press (`lib/chartButtonSession.ts`) -- an unselected pivot chart's field buttons are live, so
  without that a press, Escape and a release on the button still opened its menu. The insight cue
  stepper and comment boxes stay frame (D8).
- **Run-mode floating buttons** (`app/extensions/Controls/lib/controlZoneAt.ts`, `lib/buttonPress.ts`).
  With Design Mode off a button's whole body is content (`pointer`, part `button`). The press only
  ARMS it; it looks pressed (no highlight, a 12% black wash, the caption 1px down and right) while the
  pointer is inside, and it runs at the release inside it -- on its rectangle AND topmost there
  (`topFloatingRegionAtClient`) -- exactly once: the `button:clicked` hook, then the click path with
  its macro link, application approval and audit, called unchanged, only later. Sliding off, Escape,
  a blur, a lost release, the next press and deactivation run nothing. In Design Mode a button is frame
  and moves; shapes and pictures are frame in both modes. A right-press never runs a button.
- **A grip press never acts.** A press on an object's grip (§2d) is a frame press with part `grip`. The
  Slicer, Timeline, Charts and Controls listeners of `floatingObject:selected` skip it (no pending
  click, no `shape:clicked`); the floating grid and the pivot box treat it as any frame press, which
  acts on nothing.
- **The cells too (2026-10-01).** The same rule now holds for buttons and chrome that live IN cells
  -- a button CELL (Cell Type: Button), an in-cell button control, and a WORKSHEET pivot's +/-,
  report-filter dropdowns, Row/Column Labels filter buttons and loading Cancel -- through ONE change
  to the cell-click seam, not a copy per feature. A cell-click interceptor may answer a press with a
  RELEASE CLAIM (`actOnRelease`, or `actOnCellRelease(row, col, run, { pressedLook })` for a button in
  one cell; `@api/cellClickInterceptors`), and Core's press session
  (`app/src/core/lib/cellPressRelease.ts`) carries it. Only Core's mouse-down opens a session, and it
  opens it BEFORE the interceptors answer, so a fast click's release is kept and judged when the claim
  arrives. The claim runs ONCE, and only when the release lands on the same target, on the cells (not
  a header, a floating object or an element that claims the pointer) and on the press's sheet. The
  next press by any path, Escape (the shortcut dispatcher stands aside while a press is held), a
  window blur, a mousemove with the primary button up and a middle release with the primary up all
  end it with nothing done; only a primary press arms one, so a right or middle press on a button or
  on pivot chrome now runs nothing (it ran the action at the press before). A button cell and an
  in-cell button look pressed while held inside (`isCellPressed`). Worksheet pivot chrome is ONE
  interceptor in place of four (`app/extensions/Pivot/lib/pivotCellChrome.ts`); its menus open at the
  RELEASE point, and a +/- whose cell is not in the cached view, or a report filter the backend no
  longer knows, is not claimed (the cell is selected as before). Checkbox cells -- a checkbox CELL
  and a legacy style-flag checkbox -- joined on 2026-10-02 (owner question 26): they toggle on the
  release on their own cell through the same seam, select the cell at the press, read the value at
  the release, and Space still toggles at once; they show no pressed look. A worksheet pivot's +/-
  double-click now toggles ONCE, as the canvas box's does (owner question 27): the box's 450 ms
  guard is one module both surfaces ask (`app/extensions/Pivot/lib/pivotChromeRepeat.ts`). Still on
  the PRESS, by scope: the AutoFilter and validation dropdown chevrons (a Windows combo opens on the
  press), hyperlinks, notes and table header buttons. Known difference: a button in a merged cell
  must be pressed and released over the same underlying cell. Live journey: `release-acts.spec.ts`
  (RA-1..RA-8), written, not yet run. The keyboard into slicers and timelines is §2e; touch and pen were MEASURED, not
  changed (§2e, last paragraph).
- **Excel was not run.** Dragging across slicer items to select them (Chandoo shows it; Microsoft
  documents only Ctrl+click), what Ctrl+drag and the 'single' / 'multi' drags should do (D4 is our
  choice), and whether Excel's slicer clear button acts on release are unverified.
- **Behaviour a user will notice:** a drag from a slicer item no longer moves the slicer; Ctrl+click
  on an item never deselects it; floating macro buttons run on RELEASE and sliding off cancels; the
  canvas pivot box's +/- and filter menus act on release; a drag from a chart's quick-access, field or
  widget button no longer moves the chart. On a canvas, a content press on one member of a
  multi-selection narrows the selection to that object at the release (never toggling it out), so
  Ctrl+click on an item of one of two selected slicers leaves only that slicer selected.

## 2d. The grip and Size and Position (BUG-0258 design phase 5)

An object with no frame to grab -- a slicer or a timeline with its header hidden, a floating grid
without a title -- shows a small six-dot GRIP just outside its top-left edge while it is hovered or
selected; on a CANVAS the selected object shows one whatever its family (Power BI's visual header).
Dragging the grip moves the object exactly as a frame drag does; CLICKING it opens a small menu led by
**Size and Position...**, the no-drag route WCAG 2.2 SC 2.5.7 requires (keyboard nudging alone does not
meet it). Owner decision: charts, shapes and pictures on a WORKSHEET get no grip -- they move by their
body, as in Excel.

- **One module.** `app/src/core/lib/floatingGrip.ts` holds the geometry, ONE plate function and THE
  visibility rule. Core's paint (`paintFloatingGrips`, `floatingObjectChrome.ts`), press
  (`overlayMoveHandlers.ts` `checkGrip` / `handleGripMouseDown`), hover, right-click and
  `topFloatingRegionAt` (through the leaf probe `core/lib/floatingChromeProbe.ts`) all read it, so the
  grip cannot be painted where it is not grabbable, nor grabbable where it is not painted.
- **Geometry.** The hit square is 24 SCREEN px at any zoom -- logical 24 / zoom, the one zoom-invariant
  piece of chrome (D1; handles stay logical). It sits above the top edge, `FLOATING_GRIP_GAP_X` (the
  handle hit half + 2) right of the left edge so it clears the top-left handle; below the bottom edge
  when the object's sheet y leaves no room above; and nowhere on a canvas page with no room either way
  (Size and Position stays in the object's menu). An object too narrow for the grip to stay 8px left of
  its top midpoint (Core's n handle, a floating grid's yellow ball) -- under 80px at zoom 1, under 128px
  at zoom 0.5 -- gets it BESIDE its LEFT edge, level with its top edge (level with its bottom edge where
  a grip taller than the object would overhang a canvas page), so the two share a stretch of that edge:
  a hover grip shows only while its object is hovered, and from the old spot diagonal to the top-left
  corner a hand crossing the corner lost the hover and the grip vanished before it was reached (M7
  review). The hit square is half-open on the object's side, so it never takes a point of
  its own object -- nor one the object claims past its edge through its overlay's extended
  `hitTest` (a selected floating grid's yellow edge ball, painted above the grip, whose outer half a
  narrow, short grid's grip beside its left edge would otherwise have taken); on a dense page it can
  lie over a neighbour, where it is painted above it and wins its press. The plate is 20 x 14 screen px centred in the square: Core's blue `#0e639c` with white dots on
  a selected object, white with a `#605E5C` border and dots on a hovered one.
- **When it shows** (`floatingGripShown`). The region is floating and can MOVE -- not `movable: false`
  (so never on a run-mode button), not locked, the surface editable -- and nothing blocks it: no move or
  resize in progress, no content gesture holding the button, no formula picking a reference, no point
  mode showing another sheet. AND either it publishes `data.grip: "hover"` (the Slicer, Timeline and
  FloatingRange stores set it exactly when the header or title is hidden) and is hovered or selected, or
  it is the PRIMARY member of a canvas selection (D2: one grip per multi-selection).
- **Core's hover** (`app/src/core/lib/objectHover.ts`, a leaf). The hover pass sets the hovered object
  on every mousemove that is not a drag (handle, then grip, then body; none over a cell). The grid
  area's `onMouseLeave` clears it, and so do a scroll, a sheet switch and the hovered object leaving
  the published list -- each changes what is under a still pointer without a mousemove, so a grip under
  a still pointer disappears and comes back at the next move. A hover change repaints only when a
  `grip: "hover"` region is involved; a gesture change always does. `@api/gridOverlays` re-exports the
  hover getter and listener from the leaf, and the pivot box clears its chrome highlight when Core's
  hover leaves it.
- **Press and paint agree.** The press scans the live handles (priority 1.5), then the grips (1.6),
  then the bodies (1.7); grips are painted after every object and before the selection chrome, so a
  handle that overlaps a grip is drawn over it and wins. A grip press is a frame press with part `grip`
  (`floatingObject:selected`, then Core's move): a drag past 3px moves the object as ONE undo step, and
  a release that never moved dispatches `floatingObject:gripClick` (`@api/objectGrip`, with the grip's
  CLIENT rectangle as `anchor`; that seam carries only the event -- whose point a client point is,
  grip included, is `topFloatingRegionAtClient`'s question, and a grip-only door with no consumer was
  removed). A double-click on a grip opens no cell editor.
- **Right-click** (D6). `topFloatingRegionAt` answers the grip's object for a point on a visible grip,
  so every family's right-click, wheel and hover lookup agrees with Core's press about who owns it;
  where no family claims the right-click, Core's grid context menu dispatches `gripClick` with
  `button: 2`. Charts resolve their right-click by the chart's own bounds, which the grip lies outside,
  so a chart's grip gets the grip menu. Both menus carry Size and Position.
- **The grip menu** (`app/extensions/BuiltIn/ObjectPosition/components/GripMenu.tsx`): "Size and
  Position..." first, a rule, then whatever is registered through `@api/objectPosition`
  `registerObjectGripMenuItem` -- a canvas adds Bring Forward, Send Backward and Lock, each acting on
  THAT object only and listed only for an object on the active canvas
  (`app/extensions/CanvasSheet/lib/gripMenuItems.ts`). It opens under the grip (above it when there is
  no room), takes focus and gives it back, and consumes the menu keys (arrows, Home / End, Enter /
  Space, Escape); a press outside closes it, and so does its object disappearing.
- **Size and Position** (`@api/objectPosition` holds the rules, the opener and the menu entry;
  `app/extensions/BuiltIn/ObjectPosition` the dialog). X, Y, Width and Height in LOGICAL px with no
  snap (D7: a typed 100 is 100); a changed size is at least 16, x and y at least 0; on a canvas the
  size is capped to the page and the object kept on it (`clampMoveToPage`); Width and Height are
  disabled where the provider cannot resize (a floating grid: its size is its rows and columns). OK
  commits EXACTLY ONE `commitObjectGeometry([change], "Size and Position")` -- one undo step through
  `@api/objectGeometry`, the arrange seam (§7) -- and only when something changed; Cancel, Escape and an
  unchanged OK commit nothing; a backend refusal (a protected sheet) is that seam's one toast.
- **Read-only, not hidden** (a refinement of D7 for the owner to confirm). The availability rule is
  Core's drag rule in order: no geometry provider, a subscribed page, a locked object, `movable: false`
  (a run-mode button: "Turn on Design Mode..."). Only an object no provider owns gets a DISABLED menu
  row. A locked object, a subscribed page or a run-mode button still opens the dialog READ-ONLY -- every
  box disabled, the reason shown, only a Close button -- because its position is information and the
  reason says what to change.
- **Every door.** The grip menu; every family's right-click menu (Slicer, Timeline, Charts, the
  floating grid, Controls and the canvas pivot box, each asking `sizeAndPositionMenuEntry` for its row
  -- `objectMenuSizePositionCensus.test.ts` finds the families by what they publish); the canvas's
  Arrange group (§7); the command `object.sizeAndPosition` (the canvas selection's primary object).
- **Known limits.** A narrow object at the sheet's left edge has its grip under the row headers, where
  nothing is grabbable (its menu still has Size and Position). DOM stacked inside the grid area (html-shape iframes,
  the floating-grid editor) sends no grid mouseleave, so the hover can stay stale over it until the next
  move. Size and Position takes typed px literally, so on a snapping canvas it can place an object off
  the grid a drag would have snapped to.

## 2e. The keyboard inside an object (BUG-0258 design phase 6)

Before phase 6 a selected slicer or timeline could only be used with the mouse. Now the keyboard can
go INTO one. Everything below is Calcula's choice and is labelled so: Excel's own route into a slicer
is Tab to its items, Down, Enter, and Alt+C to clear (not verified here), and Excel's timeline has no
documented keyboard route into its periods.

- **Going in (KD1).** Enter goes in only when exactly ONE object is selected across every family
  (`@api/objectSelection`) and it is a slicer or a timeline; plain Enter only (Shift, Ctrl and
  Alt+Enter stay the grid's). A slicer starts on its first SELECTED item when it filters, otherwise on
  slot 0 ("Select all" when shown); a timeline on the first period of the range it shows, otherwise on
  the first visible period, scrolled fully into view; a timeline with no periods is not entered.
  Nothing is claimed until Enter went in, except Alt+C (below).
- **The focus is view state (KD2).** A slicer's focus is an item by its VALUE (the slot is only a
  hint), a timeline's a period by its START DATE at one level. Never saved, never undone, no
  `DocumentEffect`, no backend call; DOM focus never moves and the Tab order is unchanged.
- **Moving.** Slicer: the arrows, Home/End and PageUp/PageDown, row by row as painted (Up and Down a
  row, Left and Right a column; a horizontal slicer is one painted row). Timeline: Left and Right one
  period, Home/End, PageUp/PageDown by the number of whole periods it shows; Up and Down are consumed
  and do nothing (a level change from the keyboard is later work). Nothing wraps, and every claimed
  key is consumed even at an edge, so the grid never gets half a gesture. The items scroll, as little
  as possible, to keep the focus in view.
- **Applying.** Slicer: Space or Enter applies the focused item by the slicer's own click rule (one
  queued commit, one undo step); Ctrl toggles; Shift selects ONE run from the item last applied to the
  focus, passed in sweep order with the focused item last, as a drag passes it (a 'single' slicer
  takes the run's last value); Ctrl+Shift adds the run; on "Select all" Space clears; a held key
  applies once. Timeline: Shift with a move grows a PREVIEW from the ANCHOR -- the period the focus
  was on when the Shift run began, like Excel's Shift+arrow on cells -- shown and never written; Space
  or Enter commits it ONCE through `commitTimelineSpan`
  (`app/extensions/TimelineSlicer/lib/timelineCommit.ts`, the drag's own rule: one backend command,
  one undo step, dates that already are the range write nothing). The run ends at the commit, and its
  anchor is left for a later mouse Shift+click.
- **Leaving.** Escape leaves and the object stays selected (on a timeline the first Escape drops a
  preview, "Preview cancelled"); on a canvas the next Escape is the canvas's and deselects. Alt+C
  clears a FILTERED slicer or timeline, inside or merely selected (AltGr+C, a character on some
  layouts, is never Alt+C). Tab is never claimed. The focus also ends on any selection change that
  leaves anything but exactly that object selected (a deselect, a cell click, another object, Tab,
  the object deleted), the next `floatingObject:selected` or `floatingObject:bodyDragStart`, a sheet
  switch, a RIGHT press anywhere but the focused object (a right press on it keeps the keyboard
  inside, for its own menu), and a refresh or level change that leaves the focus nothing to stand on:
  the stores announce every change of what they hold (`SLICER_DATA_CHANGED`, `TIMELINE_DATA_CHANGED`)
  and the focus ends at once, saying "Left <name>". A refresh that only MOVES the focused item keeps
  the focus on it.
- **The cell behind it.** While the keyboard is inside on a WORKSHEET, the object claims the selection
  through `@api/selectionOwner` (owners `slicerKeyFocus` and `timelineKeyFocus`, no typing):
  type-to-edit, F2, Delete's Clear Contents, the grid commands, Data Validation's Alt+Down and the
  formatting doors refuse ("... is not available while the keyboard is inside a slicer. Press Escape
  to leave it. Nothing was changed."). A canvas has no cell behind its objects, so it claims nothing.
- **Who else gets the key.** Each keyboard is ONE window-capture keydown
  (`app/extensions/Slicer/lib/slicerKeys.ts`, `app/extensions/TimelineSlicer/lib/timelineKeys.ts`,
  rows in `app/src/core/lib/globalInputListeners.ts`). It stands down, in order, for a claimed key, a
  key already handled (a user's own shortcut on Space, Enter or an arrow wins), a text field, a live
  cell edit -- Core's own or a floating grid's (`isCellEditInProgress`) -- the grid not having focus,
  the object's own mouse gesture, its right-click menu, and an object's grip menu
  (`@api/objectPosition` `isObjectGripMenuOpen`). While the keyboard is inside, the family's
  `ownsKey` answers Escape and the arrows, so a canvas's Escape and arrow-nudge stand down.
- **Spoken (KD3).** Through ONE polite live region the shell mounts once (`@api/announce`, received
  by `app/src/shell/Announcer.tsx`: `role="status"`, visually hidden, never focused): going in
  ("Region: North, 1 of 4, selected"), every move ("..., no data" for an item the slicer shows as
  having none), every apply once it LANDED, in its new state (a slicer run by its extent: "North to
  West, 3 of 3 selected"), a timeline preview ("Feb 2026 to Apr 2026 previewed, 3 periods") and its
  commit ("Feb 2026 to Apr 2026 selected"), "Left <name>", and "Filter cleared" only when a filter was
  cleared. The region empties at once and writes after it settles (150 ms), so a held arrow is said
  once, where it stopped, and the same sentence twice is heard twice. Canvas objects are still
  OUTSIDE the accessibility tree: the live region is the minimum, not an accessibility tree.
- **The ring (KD4).** A 2px #000000 outline with a 1px #ffffff line inside the focused item or period
  (on a timeline painted after the selection bar). On every slicer preset (45) and every timeline
  colour set, one of the two tones reaches 3:1 against what it sits on.
- **Space and '+' in a shortcut.** A shortcut recorded on Space or '+' used to be saved and never fire
  (BUG-0271); both keys are now spelled by name ("Ctrl+Space", "Ctrl+Plus"). Settings names the
  grid's own Space keys (select the column, the row, everything; toggle a check box or apply a slicer
  or timeline item) as the conflict, and a user's binding WINS over them -- warned, never refused.
  The one exception is a BARE key (owner call 23, 2026-10-02): a user shortcut on Space, Enter or a
  printable character with no Ctrl, Alt, Shift or Meta is REFUSED with one sentence
  (`bareKeyShortcutRefusal`, `app/src/api/keybindings.ts`), because it would also take that key
  from every text field and the first keystroke of every cell entry; "not while editing" would not
  help, since typing into a cell starts in ready mode. A bare-key binding STORED before the rule is
  dropped when the bindings load, said on the console, so the next save writes it out
  (`dropStoredBareKey`).

**A selected object owns the keyboard on a worksheet too (BUG-0270).** A slicer or timeline merely
SELECTED, not entered, used to leave Core's active cell live behind it: Delete cleared that cell and
typing edited it. Now any selected floating object on a worksheet holds a FALLBACK claim
(`app/extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts`; `SelectionOwner.fallback`, so it
never speaks over a floating grid's cell or the keyboard inside a slicer): typing, F2, Space, Alt+Down
and the grid commands refuse, each sentence said once per selection; Delete and Backspace delete the
selected objects through each family's own delete as ONE undo step (a protected sheet's refusal is one
toast and the objects stay selected; a subscribed page refuses); Escape deselects. A family that owns
Delete at that moment wins (inside a slicer, a chart's title, a floating grid's cell, an open menu, a
held press). A press on the sheet -- the active cell itself included -- deselects the objects; a plain
press on one object deselects every other family; the formula bar is empty and read-only, fx refuses,
and the Name Box refuses to define a name while an object holds the selection; Design Mode ending
deselects buttons. The object INSERTS are the exception (owner call 25, 2026-10-02, Excel parity):
Insert Shape, Insert > Controls > Button and Insert Image are not refused while an object is selected
and place the new object at the active cell the selected object left where it was -- the claim
ADMITS the door kind `objectInsert` (`SelectionOwner.admits`), which the three doors ask as
(`app/extensions/Controls/lib/insertAnchor.ts`) -- and only they: a source census
(`app/extensions/Controls/__tests__/objectInsertDoorCensus.test.ts`) fails the build when any other
door spells the kind, hands the seam a kind, or borrows the Controls helper. A floating grid's own claim (a selected cell, or
the grid selected whole) admits nothing and still refuses them. On a canvas the same Delete now deletes ONE selected slicer, timeline or pivot box
(a dead key before).

**Found and fixed before shipping (the M8 review), so not in the ledger:** a key the inner focus did
not claim reached the hidden cell; a held arrow flooded the live region; Alt+C said "Filter cleared"
with nothing filtered, and a Shift+Space run was said as one item; a stale focus swallowed the next
key; another object's right-click menu could not take Escape first; the keyboards ignored a floating
grid's cell edit.

**Later work** is the keyboard follow-ups row of `docs/design/open-items.md` §2.af: a keyboard way to
SELECT an object on a worksheet (Tab cycling is canvas-only), Tab on a canvas saying what it selected,
Shift+F10 and the Menu key, Alt+S, timeline level keys, an ARIA listbox and type-ahead, toasts in a
live region.

**Touch and pen: measured, not changed.** `app/e2e/journeys/touch-pen-measure.spec.ts` (its instrument
in `app/e2e/helpers/touch.ts`, unit-tested by `e2e/__tests__/touchInstrument.test.ts`) drives 27
gestures by mouse, pen and touch on both surfaces and records what each one did and whether anything
still holds the pointer after the lift. It has not run live yet. The bridge it would inform is
sketched in `docs/design/open-items.md` (the touch and pen row).

## 3. Objects that read other sheets

- **Charts are bound by sheet id**, never by name or index: `DataRangeRef.sheetId`, resolved id-first
  (`app/extensions/Charts/lib/dataSourceResolver.ts`); index-only refs from older documents are
  migrated on load, and that stamp is recorded as a STAMP (`update_chart` with `sheetIdStamp`,
  verified by `record_chart_sheet_id_stamp` in `chart_commands.rs` to add sheet ids and nothing
  else) with no undo step. After a load (`"afterLoad"`) it is clean -- loading a workbook is not
  editing it (`CleanReason::LoadingFromDisk` names this step). The same stamp after a create whose
  sheet list was cold (`"afterCreate"`) dirties like the create it finishes. A chart render that FAILS while the
  chart store is behind a sheet-collection change (the sheet it sat on was just deleted) is dropped
  quietly; the store reload repaints (`isChartStoreReloadPending`, `chartStore.ts`).
  Chart data is read with `getRangeCellsTyped(sheetIndex)` rather than the
  active-sheet viewport, and invalidation is keyed on the SOURCE sheet, so a chart on a canvas repaints
  when its Sheet1 source changes while the canvas is on screen.
- **Off-sheet writes announce themselves**: script and control writes to a non-active sheet emit a
  sheet-tagged `CELLS_UPDATED`.
- **Inserting** goes through each family's own seam (`controlsService`, `floatingRangeService`,
  `chart:createDialog`, `slicer:insertDialog`, `pivot:createDialog`) at a default rect computed by the
  canvas (viewport centre, snapped, cascading) — never by hand-rolling another extension's domain.
- **Keyboard**: Tab / Shift+Tab cycle the objects and Escape deselects through
  `@api/objectSelection` providers; Enter goes INTO a selected slicer or timeline (§2e), and Delete
  deletes the selection on a canvas and on a worksheet alike (§2e, BUG-0270). Never dispatch
  `floatingObject:selected` from the keyboard: it
  means "a mouse press landed", and families arm their click handling on it (it ran button macros
  until phase 4c moved a button's run to the release, §2c).

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
  `app/extensions/_shared/lib/objectWheelScroll.ts`. The +/- and filter buttons are CONTENT in the box's
  zone answer (`pivotVisualZoneAt`, §2a) and reach the box through `floatingObject:bodyDragStart`,
  because a press on a floating object is consumed before any cell interceptor runs; they act at the
  RELEASE over the same button, never on the press (§2c). Selecting the box
  makes it the active pivot (field list, Design and
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
  hit test, the resize scan (over the live handles of SELECTED objects only, which Core paints above
  every object, so no body occludes one -- §2b), the wheel, Tab-cycling and every family's
  context-menu lookup. An optional
  `GridRegion.z` (or the registered stacking resolver) switches it on; without one, orders are
  exactly as before. On a canvas the resolver answers the index of the object's ref in
  `CanvasLayout.z_order`; refs MISSING from the list paint ABOVE listed ones, so a newly inserted
  object appears on top. Object refs: `{chart|slicer|timelineSlicer|floatingRange|pivot|control, id}`
  (a control's id is its `row:col` anchor, since its region id embeds the sheet index).
- **One selection.** `@api/objectSelection` holds a canvas-level SET across families; each family
  still holds what it can (Chart, Floating Range and the pivot box are single-select, so extra members
  are held by the set; Core paints every selected object's chrome, set-held or not -- §2b). A press on another family
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
- **Size and Position** (§2d): Arrange's fifth button, "Size & Position"
  (`canvas-arrange-size-position`), opens the dialog for the PRIMARY selected object; it is disabled
  with nothing selected, on a subscribed page, or when no dialog can open. The selected object's grip
  menu carries the same dialog plus Bring Forward, Send Backward and Lock for THAT object (the Arrange
  commands, `lib/zOrderStore.ts`, so both doors change the one z-order and lock list the same way, each
  as one undo step). A fifth hero widens the group, so at narrow widths the Canvas tab folds sooner: a
  journey that clicks an Arrange control directly may need the band's launcher.
- **Nudge**: arrows move the selection to the next snap multiple (snap on, no Alt), else 1px / 10px
  with Shift; a burst is one undo step. A floating grid with a cell selected, or a chart below chart
  level, keeps the arrows.

## 8. Editing a floating grid's cell: one session, two views

Owner finding 2026-09-27: clicking another sheet's tab while typing in a floating-grid cell ended
the edit, and a selected floating-grid cell showed nothing in the formula bar. A floating grid
lives outside Core's selection, so every place that assumed "the edited cell is Core's active cell"
had to learn about a second owner. The answer is ONE Core module and ONE session.

- **One module owns the state**: `app/src/core/lib/formulaEditTarget.ts` (dependency-free). It
  holds the pick slot (`registerExternalFormulaTarget`, which carries the edit SESSION), the
  selection-scoped CELL slot (`publishExternalCellTarget`: a selected floating-grid cell), the
  explicit `parked` state, the Name Box address-resolver slot, and ONE reader for the shell,
  `resolveFormulaBarSource()`. `@api/externalEdit` is a pure re-export, so the shell and the
  extension cannot read two copies.
- **Two views of one session.** The floating grid's in-cell textarea and the formula bar are views
  of the same `ExternalEditSession`; the bar adopts the session (`adoptBarView`) when it is clicked or
  when fx opens, so an edit started in the cell finishes in the bar and vice versa. A selected cell's
  formula shows in the bar with the workbook's own capitalisation (the off-sheet write door now
  restamps sheet, name and table casing, `update_cell_on_sheets_inner`), and the Name Box shows
  `Float1!A1` (or `Float1!A1:B3`) and accepts `Float1!B2`.
- **Parked across sheet switches.** Clicking a sheet tab while a formula expects a reference switches
  the grid to that sheet in POINT MODE (`switchSheetForPointMode`, `core/lib/pointModeSheetSwitch.ts`)
  and parks the session instead of committing it: a click inserts `Sheet1!E2`, the text stays
  editable in the bar, Enter commits to the floating-grid cell and returns to the host sheet, Escape
  cancels and returns. With a complete reference, a cell click commits and returns (grid parity).
  While parked, the shown sheet paints and hit-tests none of the host's floating objects
  (`isPointModeOnForeignSheet`, `core/lib/pointModeView.ts`).
- **Core reads one liveness signal**, `isExternalEditLive()`, at every door that would otherwise act
  on its own hidden selection: the pointer door's focus rule, the grid keyboard, the container
  fallback (which also gives a parked session Enter / Tab / Escape / Backspace / typing when the
  formula bar is hidden), commit-before-select, the double-click door, cell-click interceptors, the
  keyboard dispatcher (grid-scoped and "not-editing" bindings stand down, and so does Core's OWN
  parked edit since the edit flag moved to `core/lib/cellEditFlag.ts`), the Undo/Redo commands and
  the Name Box (typed or picked from the list: "Finish the formula..."). A press on Core's
  already-active cell is announced after it is handled (`onGridCellPressed`,
  `core/lib/cellClickInterceptors.ts`) so the floating grid drops its selection.
- **A floating grid's selection owns the keyboard.** While a floating-grid cell or range is
  selected, Delete / Backspace clear ITS cells, and every key or grid command that would act on
  Core's hidden cell is refused with a toast: `FR_REFUSED_GRID_KEYS`
  (`app/extensions/FloatingRange/lib/frKeyRouting.ts`) as EXCLUSIVE bindings (`KeyBinding.exclusive`
  stops later window listeners) that are not LISTED in keyboard settings (`KeyBinding.listed`), and
  all grid commands (`GridCommand` is derived from Core's `GRID_COMMANDS`, never copied). Ribbon
  and menu FORMATTING doors still read Core's selection (open-items 2.af).
- The write stays the existing id-addressed, undoable `update_floating_range_cell`; no backend,
  `DocumentEffect` or format change was needed for the seam.

## 9. Slicers on a Calcula model

Owner finding 2026-09-27: Insert Slicers said "No Tables or PivotTables found" in a workbook whose
pivots come from a Calcula model. Owner decisions: a model slicer filters every pivot of that model
on its OWN sheet or canvas, including pivots added later; deleting any slicer removes its filter and
one Ctrl+Z restores both; model slicers reach pivots and pivot charts now, design-query charts next.

- **The source.** `SlicerSourceType::BiConnection` with the connection's id in `data_source_id`.
  Insert Slicers lists every loaded model first ("Sales (Model)"), its columns as fields, and says
  what the slicer will reach (`MODEL_SLICER_REACH`, `app/extensions/Slicer/lib/insertSlicerPlan.ts`).
  Items come from the model column itself (`get_slicer_items_core`), not from any pivot's cache.
- **The page rule, server-side.** A click applies to every BI pivot of that connection on the
  slicer's sheet through `apply_pivot_filter` with a `biFieldKey`; a column the pivot does not carry
  is added by `ensure_bi_field` (which first scans the CURRENT cache, so re-applying after a Clear
  records nothing and keeps redo). A pivot created or re-laid-out later picks the slicer up in
  `update_bi_pivot_fields_core`'s page fold (`page_model_slicers`). Level 1 is a host mask
  (`hidden_for_selection`, one spelling rule for booleans and decimals); level 2+ pins an engine
  filter and re-queries (`requery_filter_change` records ONE restore of the state before the
  change). Columns are identified by `Table.Column` (`SlicerFilter.model_key`,
  `FieldCache.model_key`), never by a bare name two tables could share, and are checked against the
  LIVE model (`refresh_bi_model_snapshot`), not the pivot's creation-time snapshot.
- **Delete clears.** `delete_slicer_core` records the pre-delete state, clears the filter on every
  target (a table slicer's AutoFilter column included) with no transaction held open across the
  model wait, and records one step; deleting the SHEET a slicer lives on clears its filters on pivots
  elsewhere.
- **The editor stops re-sending stale filters.** `BiFieldRef.hiddenItems` is tri-state (absent =
  keep what the pivot hides now, a list = set, `[]` = clear), and the field list sends a real
  row/column field's hidden items only when the user edited them in the editor
  (`app/extensions/Pivot/components/biFieldsRequest.ts`); the chips re-read the definition after each
  view update, so a slicer's filter shows up in the pane and the Pivot Layout DSL.
- **Failures are said once.** A target that refuses a slicer or ribbon filter is reported in one toast
  per gesture; the other targets still filter.
- **A reopened model pivot** registers its region from its saved output extent
  (`SavedBiPivotMetadata.outputExtent`), so its first refresh does not mistake its own cells for user
  data; a canvas pivot never counts overwritten cells.

## 10. What a canvas refuses, on purpose

- Cells of any kind, from any door (§1) — except canvas pivots.
- Print and PDF (v1): printing reads cells and a canvas has none; refused with a message.
- Copying a canvas sheet (no object store is cloned); `core:copySheet` is hidden for a canvas.
- Freeze panes, split, headings/gridlines toggles, view modes.
- Converting a sheet between worksheet and canvas: a kind is fixed at creation.
- xlsx: a canvas is written as a hidden worksheet and the loss report says "Canvas sheets".

## 11. Where the proofs are

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
| A floating grid inserted from the Canvas tab moves by its title with Design Mode off, and the move persists | `canvas.spec.ts` #8; `frMoveZones.test.ts` |
| A floating-grid formula survives a sheet-tab click: point at Sheet1!E2, Enter commits and returns | `canvas.spec.ts` #9; `pointModeSheetSwitch.test.ts`, `frSheetChange.test.ts` |
| A selected floating-grid cell shows its formula (workbook casing) and `Float1!A1`, and the bar edits it | `canvas.spec.ts` #10; `an_off_sheet_formula_keeps_the_sheet_names_capitalisation` |
| No key or grid command reaches Core's hidden cell while a floating-grid cell is selected | `frKeyRouting.test.ts`, `gridCommandDrift.test.ts`, `keybindings.editContext.test.ts` |
| A model slicer: offered by Insert Slicers, items from the model, filters its canvas's pivots and not another sheet's, one Ctrl+Z per click, delete clears and Ctrl+Z restores, survives save/reopen and a refresh | `canvas.spec.ts` #11; `slicer/model_slicer_tests.rs` |
| Undo of a pinned apply restores the state before it | `undoing_a_pinned_apply_restores_the_pre_pin_definition`, `undoing_a_level_change_to_pinned_restores_the_mask` |
| One zone answer per press: content is handed over (locked and subscribed too), a frame that cannot move only selects and shows `default`, the zone is asked before anything is selected | `overlayZones.test.ts`, `overlayContentClaim.test.ts`, `overlayZoneHoverWiring.test.tsx`, `gridOverlays.test.ts`; per family `timelineZones.test.ts`, `chartZoneAt.test.ts`, `slicerZoneAt.test.ts`, `pivotVisualOverlay.test.ts`, `controlZoneAt.test.ts`, `frMoveZones.test.ts` |
| No second per-point answer can come back; every floating family answers `zoneAt` | `overlayZoneCensus.test.ts`; the type pin in `gridOverlays-interactions.test.ts` |
| A move released outside the grid area saves every co-moved object (BUG-0265) | `overlayReleaseOrder.test.tsx` |
| LIVE: a timeline range drag on an unselected timeline, a year-strip move, Shift+click, a locked timeline, a release over the ribbon, the chart brush pointer | `moving-objects.spec.ts` (written 2026-09-30; run by the main loop) |
| Handles: live only on a selected object, eight that each drag their own sides, the pointer per handle, one geometry for paint and hit, handles topmost | `floatingHandles.test.ts`, `overlayHandles.test.ts`, `overlayHandleHover.test.tsx`, `overlayStacking.test.ts`; `timelineResizeGate.test.ts` (no family resize flag) |
| Core paints the chrome (outline once per selected object, handles only while live, locked = outline only), and no family paints its own | `floatingChromePaint.test.ts` (incl. the family census); `selectionChromeAndLabel.test.ts` (the canvas paints only its padlock); `frEdgeBalls.test.ts` |
| LIVE: an unselected corner selects and moves, a slicer's right-edge handle shows and resizes the width only, a shape's right-edge handle resizes, a locked shape shows the padlock and no handle, per-corner pointers on a chart | `moving-objects.spec.ts` steps 7-10 (written 2026-09-30; run by the main loop) |
| A Core-handle resize leaves the control's region at its new size, whatever order the read and the write are served in (BUG-0268) | `resizeKeepsRegion.test.ts` (real `activate()`, a fake backend that serves out of order), `geometryWriteOrder.test.ts`; live: `moving-objects.spec.ts` step 9 |
| Slicer items are content: a click filters, Ctrl+click toggles the item and keeps the slicer selected (BUG-0269), a drag selects the run as ONE queued commit, Select all and the clear button act on release over themselves, the thumb scrolls and writes nothing; paint == hit for items and thumb | `slicerZoneAt.test.ts`, `slicerItemDrag.test.ts`, `slicerClickSelection.run.test.ts`, `slicerPressWiring.test.ts` (real `activate()`), `slicerNoPhantomDrag.test.ts`, `slicerRunPreviewPaint.test.ts`, `slicerEscapeOwnership.test.ts`, `slicerMouseupLifetime.test.ts` |
| The pivot box's chrome and a chart's buttons act on release over the same button; the 450 ms guard runs between releases; a drag from them moves nothing; a chart-button press cancels on Escape and blur and its provider owns Escape meanwhile | `pivotChromePress.test.ts`, `pivotVisualOverlay.test.ts`; `chartZoneAt.test.ts`, `chartButtonRelease.test.ts` (real `activate()`), `chartMouseupLifetime.test.ts`, `chartObjectSelection.test.ts` |
| Every content press holds Core's pointer and lets go on every end path; a covered part is not released on; a middle press ends at its release with nothing done; an adding slicer run from "all" selects the run | `floatingRegionCovered.test.ts`; `buttonPress.test.ts`, `pivotChromePress.test.ts`, `chartButtonRelease.test.ts`, `slicerItemDrag.test.ts`, `timelineRangeDrag.test.ts`, `slicerClickSelection.run.test.ts` |
| A run-mode button runs once at the release inside it and never on the press; sliding off, Escape, a blur and a lost release run nothing; it looks pressed while held inside | `controlZoneAt.test.ts`, `buttonPress.test.ts`, `buttonRunOnRelease.test.ts` (real `activate()`), `buttonPressNoPhantom.test.ts`, `buttonPressedPaint.test.ts`; `overlayMoveRightPress.test.ts` (a right-press runs nothing) |
| The grip: 24 screen px at zoom 0.5, 1 and 2 with paint == hit, above / below / beside a narrow object's left edge (reachable from its body at zoom 0.5 and 1) / none, half-open on its object, the visibility rule, priority after the handles and before the bodies, `gripClick` only for a press that never moved, Core's hover and everything that clears it, the right-click, the probe | `floatingGrip.test.ts`, `objectHover.test.ts`, `overlayGripPress.test.ts`, `gripHoverWiring.test.tsx`, `gridHoverClear.test.ts`, `floatingChromePaint.test.ts`, `gridOverlays.test.ts`, `objectGrip.test.ts`; the families' grip flags in `slicerStoreGrip.test.ts`, `timelineStoreGrip.test.ts`, `floatingRangeStore.test.ts` |
| Size and Position: the availability rule, ONE commit labelled "Size and Position" and none for Cancel or an unchanged OK, the read-only dialog, the page clamp and the 16px minimum, the grip menu (first row, keys, outside press), the canvas's grip items, a row in every family's menu, Arrange's button | `objectPosition.test.ts`, `sizePosition.test.ts`, `SizePositionDialog.test.tsx`, `gripMenu.test.tsx` (real `activate()`), `gripMenuItems.test.ts`, `gripMenuWiring.test.ts`, `objectMenuSizePositionCensus.test.ts` and the per-family `*MenuSizePosition*` tests, `canvasArrangeSection.test.tsx` |
| LIVE: slicer items (run drag, Ctrl+click keeps the slicer selected, the thumb), the pivot box's +/- on release, a run-mode button on release, a chart's quick-access button on release, the grip (idle, hover, leaving the grid, a scroll, drag, click, below at y 0, a timeline and a floating grid), the grip menu and Size and Position, a selected canvas chart's grip and Lock, Size and Position in every family's menu and in Arrange | `moving-objects.spec.ts` steps 11-23, written 2026-09-30/10-01. Steps 11-14 and 16 passed in E2E run 9b on the M7 T1/T2 tree; all 23 runs passed in E2E run 10b (2026-10-01), before the cell-release change moved Core's press door, so every step runs again on the final tree with the sabotages in the spec's header (the main loop; none has run live yet) |
| The cell interceptors act on release: Core's press session (opened only by Core's mouse-down, before the interceptors answer; one run, on the same target, on the cells and the press's sheet; Escape, a blur, a lost release, the next press and a non-primary press run nothing), worksheet pivot chrome as one interceptor, in-cell buttons and button cells with their pressed look; zoom 1.5, a frozen row on a scrolled sheet, a sheet switch while held; Escape stays the held press's | `cellPressRelease.test.ts`, `cellClickInterceptors.test.ts`, `cellReleaseClaimWiring.test.tsx`, `pivotCellChrome.test.ts`, `inCellButtonRelease.test.ts`, `buttonCellRelease.test.ts`, `cellTypes.test.ts`, `keybindings.heldCellPress.test.ts`; `explicitMacroRun.test.ts` (a release claim runs only from Core's session) |
| Checkbox cells (a checkbox CELL and a legacy style-flag checkbox) toggle on the release on their own cell: claimed at the press with the cell selected, the value read at the release, Space at once; a worksheet pivot's chrome drops a double-click's second release through the canvas box's own 450 ms guard (one module, Cancel unguarded) (owner questions 26 and 27, 2026-10-02) | `checkboxRelease.test.ts`, `checkboxCellRelease.test.ts`, `pivotCellChrome.test.ts` (the double-click and a one-guard pin), `pivotChromePress.test.ts`, `pivotVisualOverlay.test.ts` |
| LIVE: a worksheet pivot's '-', report filter, Row Labels button and loading Cancel, an in-cell button control, a button cell, a checkbox cell and a legacy checkbox act at the release, and slid off run nothing; a worksheet +/- double-click toggles once | `release-acts.spec.ts` RA-1..RA-8 (RA-1..RA-5 written 2026-10-01, RA-6..RA-8 2026-10-02), NOT run yet (nine live sabotages in its header) |
| The keyboard inside a slicer and a timeline (§2e): going in, every move, apply, the timeline preview and its ONE commit, Escape and Alt+C, every gate, every end, the claim on the hidden cell, the ring's geometry and contrast, a canvas's Tab / Escape / nudge standing down | `slicerKeyboard.test.ts`, `slicerKeyboardCanvas.test.ts`, `slicerSlotStep.test.ts`, `slicerFocusRingContrast.test.ts`, `slicerStoreDataChanged.test.ts`; `timelineKeyboard.test.ts`, `timelineKeyboardCanvas.test.ts`, `timelineFocusRing.test.ts`, `timelineCommit.test.ts`, `timelineStoreDataChanged.test.ts`; `gripMenuOpenProbe.test.tsx` |
| One polite live region, debounced, mounted once | `announce.test.ts`, `Announcer.test.tsx`, `layoutAnnouncerMount.test.tsx` |
| Space and '+' in a shortcut; the grid's Space keys named as the conflict (BUG-0271) | `keybindings.spaceAndPlus.test.ts` |
| A user shortcut on a BARE Space, Enter or printable character is refused, at both write doors and in Settings (owner call 23) | `keybindings.bareKeyRefusal.test.ts`, `KeybindingsPage.bareKey.test.tsx` |
| A selected object owns the keyboard on a worksheet (BUG-0270): the fallback claim, Delete as one undo step, Escape, the press parity, the formula bar and the Name Box, Design Mode ending | `selectedObjectKeys.test.ts`, `selectionOwner.test.ts`, `objectSelectionReadOnlyDelete.test.ts`, `objectSelectionWorksheetPress.test.ts`, `formulaInputSelectionOwner.test.tsx`, `formulaBarFxSelectionOwner.test.tsx`, `controlDesignModeDeselect.test.ts` |
| The object inserts (Insert Shape, Insert > Controls > Button, Insert Image) are not refused while an object is selected, through the real Insert menu; a door KIND an owner admits (owner call 25) | `insertWithObjectSelected.test.ts`, `controlInsertSelectionOwner.test.ts`, `selectedObjectKeys.test.ts` T16, `selectionOwner.test.ts` |
| LIVE: the keyboard inside (K-1..K-5) and a selected object's keys (SK-1..SK-8) | `object-keyboard.spec.ts` passed in E2E run 10f and `selected-object-keys.spec.ts` in run 10 (2026-10-01), before the cell-release change and a change to the Escape dispatcher; both run again, with their headers' sabotages. K-6 (a bare key refused) and SK-9 (Insert > Controls > Button with a slicer selected) were added 2026-10-02 and have NOT run |
| Touch and pen are MEASURED, nothing changed | `touch-pen-measure.spec.ts` (written, NOT run); its instrument `touchInstrument.test.ts` |


## 12. The fix-all programme (2026-09-28/29)

Every defect the canvas work and its reviews had filed was fixed in six adversarially reviewed waves,
then driven through the real app (`app/e2e/journeys/fixall-*.spec.ts`), which found about thirty more.
What changed in the rules a reader of this file relies on:

- **A selection owner.** While a floating grid's cell holds the selection, every door that would act
  on Core's hidden cell refuses once (`@api/selectionOwner`): formatting, Format Painter, paste,
  insert, the contextual tabs.
- **One undo step, owned.** A backend command commits only the step its OWN begin opened
  (`engine::OwnedTransaction`); a gesture, a script batch and a command-line run each close only what
  they opened (the begin answers with a ticket); a canvas multi-selection's delete / copy / paste /
  duplicate is ONE step; z-order and lock are undoable (`canvas_stacking` restore).
- **Floating controls follow the ACTIVE sheet.** They used to load sheet 0's controls always
  (`GridConfig.activeSheet` was never set; the field is gone — read `sheetContext.activeSheetIndex`).
- **A sheet switch from an extension is a tab click.** Bookmarks, view bookmarks, the Application
  Explorer, Go To, CSV import and a notebook's Send to grid switch through ONE door (`@api`
  `activateSheet`, `app/src/api/sheetSwitch.ts`): beforeSwitch, the backend switch AWAITED, the prime,
  the context with the sheet's own surface, normalSwitch, SHEET_CHANGED. An unawaited switch let the
  tab strip's re-read dispatch the canvas back, so Next Bookmark from a canvas left the grid on it.
- **Undo is refused at every door while a gesture lands**, not only at Ctrl+Z: the refusal registry
  (`app/src/api/commandRefusals.ts`) is asked by `CommandRegistry.execute` too (ribbon, menus, QAT).
- **The marquee** exists only while the primary button is held; a move with it up ends the band
  unapplied.
- **A pane dropdown may name a floating range** (`Float1!A1:A3`); it reads the range by id.
- **Model slicers** are ONE backend gesture with no transaction held across the model re-query, and
  a DirectQuery CSV/Parquet/REST source now aggregates locally (model-engine-lib
  `ConnectorCapabilities::aggregate_pushdown`) — it used to return raw rows as aggregates, so a Year
  slicer listed regions.
- **Values on rows** show one value column, each row its own value field; Show Values As can be set
  in the Value Field Settings dialog (Base field / Base item), the base reaches the backend as the
  `showAs` rule, and a reopened editor sends each value field's Show Values As and number format back
  (the update replaces the value fields); GETPIVOTDATA with no field/item pairs reads a values-on-rows
  total; pivot text sorts ignoring case.
- **Timelines** read typed dates correctly (the pivot cache uses `engine::date_serial`), offer only
  date-formatted numeric columns, and no longer arm a phantom range drag on a click.

Live proofs: `fixall-canvas.spec.ts` (LIVE-1 controls per sheet, LIVE-2 marquee, V1–V6, W25/W26,
B5/B6), `fixall-calp.spec.ts` (subscribe/checkout/refresh renames, validation wires, undo batches, the
command line), `fixall-edit.spec.ts`, `fixall-pivot.spec.ts`, `fixall-lifecycle.spec.ts`. The ledger
entries carry the fix notes (`tests/regression/bug-ledger.json`).
