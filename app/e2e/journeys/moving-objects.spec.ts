/**
 * MOVING OBJECTS -- BUG-0258 design phases 2 to 5b (M5, M7), PROVED LIVE.
 *
 * The grammar (docs/design/canvas-sheets.md §2a; phases 4 and 5 in §2c and
 * §2d): the FRAME of an object moves it, its CONTENT does its own job, and the
 * pointer says which is which. Core
 * asks each floating family ONE question per point (`OverlayRegistration.zoneAt`)
 * before the press selects anything, and derives the press, the pointer and
 * Ctrl/Shift from that one answer. This journey drives the real pointer on the
 * real objects and reads the result back from the BACKEND
 * (`get_all_timeline_slicers`, `get_all_slicers`, `get_undo_state`, the pivot's
 * own view) and the DOM (the cursor rendered under the pointer) -- never "the call
 * returned OK", and never a screenshot golden (they are stale after the owner's
 * UI changes; memory e2e_goldens_stale_after_owner_ui_changes).
 *
 *   1. On an UNSELECTED timeline, a drag from February to May selects
 *      2026-02..2026-05 on the FIRST press; the timeline does not move; ONE
 *      Ctrl+Z restores "all". (BUG-0258 itself: the drag used to MOVE it.)
 *   2. A drag from the year-label strip (frame) moves the timeline and leaves
 *      its range alone; the pointer is `move` there and a hand over a month.
 *   3. Click February, then Shift+click April: 2026-02..2026-04, and the
 *      timeline is still selected (on a canvas, Shift reaching the object
 *      selection would have toggled it OUT).
 *   4. A LOCKED timeline on a canvas: a header drag does not move it, the
 *      pointer over its header is `default` (it was `move` before the lock),
 *      and a range drag still filters (reading a report is not editing it).
 *   5. Two timelines, and separately two slicers, selected: one dragged by its
 *      header and RELEASED OVER THE RIBBON moves both by the same delta and
 *      both stay selected (BUG-0265: the family's own mouseup ran before Core
 *      ended the move, so only the lead was saved).
 *   6. The pointer over the plot of a brushable chart is `crosshair` (content:
 *      the brush) -- on a BAR of it too -- and `move` over its frame -- on an
 *      UNSELECTED chart.
 *
 * Steps 1-3 and 5 run on a worksheet AND on a canvas; 4 is canvas-only (the
 * lock is a canvas layout property); 6 is a worksheet.
 *
 * PHASE 3 -- handles only where they work (core/lib/floatingHandles.ts: ONE
 * geometry for Core's paint and Core's resize hit test; handles live only on a
 * SELECTED object; eight of them, all resizing; Core paints every selected
 * object's outline and handles, the families none):
 *   7. (worksheet) A press 5px inside the top-left corner of an UNSELECTED
 *      timeline, and of an UNSELECTED slicer, is not a resize: the pointer
 *      there is not a resize pointer, and a drag from it MOVES the object with
 *      its size unchanged and leaves it selected. (The slicer's corners were
 *      live, and unpainted, on an unselected slicer before phase 3.)
 *   8. (worksheet) A SELECTED slicer shows a handle pixel just outside its
 *      right-edge midpoint (none while unselected), the pointer there is
 *      `ew-resize`, and dragging it changes the backend width only.
 *   9. (canvas) A shape's right-edge handle drag changes the backend width only
 *      (an edge-midpoint press used to MOVE a shape); a selected, unlocked shape
 *      shows a handle pixel just outside its top-left corner; locked through
 *      Arrange > Lock it shows the PADLOCK and NO handle pixel there, and the
 *      corner no longer promises a resize.
 *  10. (worksheet) Over a SELECTED chart the pointer at the top-right corner is
 *      `nesw-resize`, at the top-left `nwse-resize`, at the right-edge
 *      midpoint `ew-resize`; over an UNSELECTED chart the corner shows `move`,
 *      and so does a BAR of it (frame: a drag there moves the chart).
 *
 * PHASE 4a -- a slicer's items are CONTENT (extensions/Slicer/rendering/
 * slicerRenderer.ts `slicerZoneAt`; the gesture is lib/slicerItemDrag.ts):
 *  11. (worksheet and canvas) On an UNSELECTED slicer, a drag from its first
 *      item to its third selects EXACTLY those three (the backend's
 *      selectedItems and the pivot's rows); the slicer does not move and is
 *      selected; it is ONE undo step, and one Ctrl+Z brings back all six rows.
 *      The pointer is a hand over an item and `move` over the header.
 *  12. (worksheet and canvas) Selected by its header, a click on one item and
 *      then a Ctrl+click on another select BOTH, and the slicer is STILL
 *      selected (the Slicer's own capture mousedown used to hand the raw Ctrl
 *      to `selectSlicer`, which toggled the slicer OUT); on a canvas the
 *      canvas selection still lists it.
 *  13. (worksheet) On a 160 x 96 slicer that must scroll, dragging the painted
 *      scrollbar thumb down 40 px scrolls the items (the renderer's
 *      `getScrollOffset` > 0): no undo step, no move, no filter.
 *
 * PHASE 4b -- buttons act on RELEASE over the same button, and a drag from one
 * moves nothing (extensions/Pivot/lib/pivotChromePress.ts; extensions/Charts/
 * lib/chartButtonPress.ts + chartZoneAt.ts):
 *  14. (canvas) A pivot box with two row fields (Product, then Date): a press
 *      on a product's '-' slid 60 px off and released leaves the view rows
 *      unchanged; a click on it collapses it ONCE (fewer rows, and no fewer a
 *      moment later); a fast double-click on its '+' toggles it ONCE (all rows back, and still back
 *      a second later -- not collapsed again); a drag that starts on the icon
 *      leaves the box's persisted canvasFrame where it was.
 *  16. (worksheet) On a SELECTED chart, a drag from its "Chart Elements"
 *      quick-access button to 80 px away leaves the persisted chart where it
 *      was and opens no popup; a click on the button opens it.
 *
 * PHASE 4c -- a RUN-MODE floating button is CONTENT and runs at the RELEASE
 * inside it (extensions/Controls/lib/controlZoneAt.ts + lib/buttonPress.ts):
 *  15. (worksheet and canvas) Design Mode off, the pointer over the button is a
 *      hand; pressed, its face is darker than released (the pressed look) and
 *      nothing has run; slid 60 px off, it looks raised again, and the release
 *      there runs NOTHING (`button:clicked` counted through the app's own event
 *      bus stays 0); a click inside runs it exactly once and it does not move.
 *      Design Mode on, the pointer is `move`, a drag moves the button (the
 *      backend row) and runs nothing.
 *
 * PHASE 5a -- the six-dot GRIP of an object with no header or title
 * (core/lib/floatingGrip.ts: ONE geometry and ONE visibility rule for Core's
 * paint, press, hover and right-click; core/lib/objectHover.ts: Core's hover).
 * Grip pixels are the hover ink #605E5C (a grip shown because its object is
 * hovered) or the selection blue #0e639c (a selected object's), sampled on the
 * plate where the product's own `floatingGripOf` puts it (e2e/helpers/objectGrip.ts):
 *  17. (worksheet) A header-less slicer shows NO grip pixels above its top-left
 *      while idle; hovered (its body) it does; moving from the body straight up
 *      onto the grip keeps them (and the pointer there is `move`); ONE move out
 *      of the grid onto the ribbon (only the grid area's mouseleave can tell)
 *      takes them away, and so does a wheel scroll of the grid under a still
 *      pointer.
 *  18. (worksheet) Dragging the grip by (+64, +32) moves the slicer (the backend
 *      row) by exactly that, as ONE undo step, its selectedItems untouched, and
 *      dispatches no `floatingObject:gripClick`; a click on the grip of the now
 *      SELECTED slicer dispatches exactly one, and moves, filters and records
 *      nothing.
 *  20. (worksheet) A header-less slicer at sheet y = 0 has no room above: its
 *      grip sits BELOW its bottom edge (pixels there on hover), nothing is
 *      painted above it, and the grip below is grabbable (`move`).
 *  23. (worksheet) A title-less floating grid and a header-less timeline each
 *      show no grip while idle and the grip on hover, with a `move` pointer.
 *
 * PHASE 5b -- the grip's MENU and SIZE AND POSITION, the no-drag route WCAG 2.2
 * SC 2.5.7 requires (extensions/BuiltIn/ObjectPosition: the menu Core's
 * `floatingObject:gripClick` opens and the dialog; @api/objectPosition: the
 * rules, the opener every object menu calls, the grip-menu items):
 *  19. (worksheet) A click on a header-less slicer's grip opens a menu, anchored
 *      at the grip, whose FIRST row is "Size and Position..."; X 480, Y 256 and
 *      OK move the slicer (the backend row) exactly there, size and filter
 *      untouched, as ONE undo step (typing wrote nothing); one Ctrl+Z puts it
 *      back.
 *  21. (canvas) A SELECTED titled chart shows its grip (Core's selection blue);
 *      the grip's menu reads Size and Position, Bring Forward, Send Backward,
 *      Lock; Lock puts the chart in the layout's lock list, the padlock shows,
 *      the grip is gone and its place no longer says `move`; the locked chart's
 *      own right-click "Size and Position..." opens the dialog READ-ONLY (every
 *      box disabled, no OK) saying it is locked. Control: a SELECTED titled
 *      chart on a WORKSHEET shows no grip (owner decision 3).
 *  22. (worksheet and canvas) The right-click menus of a slicer, a timeline, a
 *      chart, a shape and a floating grid -- and on a canvas the pivot box --
 *      each carry "Size and Position...". On a canvas, Arrange's "Size &
 *      Position" is disabled with nothing selected, enabled with the shape
 *      selected, and opens the dialog at the shape's x.
 *
 * Step 9 also asserts BUG-0268 (found by this journey, run 9c): after the
 * shape's right-edge handle resize its published region is 224 wide, like the
 * backend, and stays so after Arrange > Lock -- the resize's own repaint used
 * to read the control before the write landed and put the old width back.
 *
 * WHERE EACH STEP RUNS. 18 tests, 23 runs: a test in a surface loop runs once
 * on a worksheet and once on a canvas, and every test title starts with its
 * step numbers.
 *   worksheet AND canvas: 1-3, 5, 11-12, 15, 22
 *   worksheet only:       6, 7-8, 10, 13, 16, 17-18, 19, 20, 23
 *   canvas only:          4, 9, 14, 21 (21 opens with a worksheet control)
 * Phases 2-3 are steps 1-10 (9 runs); phases 4-5 are steps 11-23 (14 runs).
 *
 * E2E GOTCHAS this journey is written around (read before changing a step):
 *   - Pixels come from samplePixelGrids (e2e/viewportSample.ts): one UNCLIPPED
 *     capture, cropped in the page, read as "some pixels are Core's selection
 *     colour #0e639c" (or the grip's hover ink #605E5C). A clipped capture can
 *     report an absence it caused -- it can photograph the frame before a
 *     hover repaint lands (memory e2e_screenshot_clip_cancels_hover;
 *     e2e/__tests__/noClippedCapture.test.ts refuses a clip). A hover grip is
 *     sampled only after Core's hovered id names the object (`hoveredRegionId`).
 *   - Pointers are read as the user sees them, with `cursorAt`: the computed
 *     cursor of the element UNDER the real pointer (elementFromPoint), so an
 *     inline cursor an extension writes on the grid <canvas> -- which
 *     overrides Core's on the grid area -- is caught.
 *   - Never a golden. The screenshot goldens are stale after the owner's UI
 *     changes (memory e2e_goldens_stale_after_owner_ui_changes) and this
 *     machine renders at DPR 2; every step asserts backend rows, the DOM and
 *     relative pixel counts. Do not re-record goldens to make a step pass.
 *   - No step drives a NATIVE dialog. If one is added, AWAIT the request that
 *     opens it before any synchronous driver (execFileSync of
 *     e2e/answer-native-dialog.ps1): an unawaited Playwright call is not sent
 *     until the next await, after the sync child has run (memory
 *     e2e_unawaited_call_before_execfilesync).
 *
 * SABOTAGE BEFORE COUNTING THIS AS PROOF (the main loop runs it; memory
 * feedback_sabotage_must_hit_the_right_guard). For each line: apply it, confirm
 * it CHANGED the file and the behaviour (not only the bytes), start a FRESH run
 * of the named step (the journey's app loads the frontend from the Vite dev
 * server, so a TypeScript sabotage needs no Rust build), see the quoted
 * failure, then restore the file BYTE-IDENTICAL. core.ts,
 * overlayMoveHandlers.ts and Charts/index.ts are CRLF: edit and compare them
 * with node, never Git Bash sed. Line numbers as of 2026-10-01 (re-read after
 * the M7 fixer round; re-read again 2026-10-02 after M8 and BUG-0270, which
 * moved slicerRenderer.ts, overlayMoveHandlers.ts and ObjectPosition/index.ts).
 *
 *   PHASE 2
 *   - `timelineOverlayZoneAt` (app/extensions/TimelineSlicer/lib/
 *     timelineView.ts:124) answering `null` everywhere (all frame) must
 *     reproduce the ORIGINAL symptom in step 1: the timeline MOVES and the
 *     range stays "all" ("the drag did not select February to May").
 *   - Dropping the capture listener in `armMove`
 *     (app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts:369,
 *     `window.addEventListener("mouseup", endMoveOnRelease, true)`) must make
 *     step 5 save only the lead ("...the co-moved member was NOT saved with the
 *     lead's delta ... (BUG-0265: only the lead was saved)").
 *   - `chartZoneAt` (app/extensions/Charts/lib/chartZoneAt.ts:67) answering
 *     `null` must make step 6 read `move` over the plot ("the plot of a
 *     brushable chart does not show the brush's crosshair").
 *   - Putting the old second writer back in the Charts mousemove
 *     (app/extensions/Charts/index.ts:1555, after `handleChartMouseMove(...)`
 *     in the rAF: `const cv = gridContainer?.querySelector("canvas"); if (cv)
 *     cv.style.cursor = isHoveringDataElement() ? "pointer" : "";`) must make
 *     step 6's bar read `pointer` ("a bar of the brushable plot shows a hand,
 *     not the brush's crosshair") and step 10's bar too ("a bar of a movable,
 *     non-brushable chart shows a hand -- a press there moves the chart").
 *
 *   PHASE 3
 *   - Before trusting a pixel check, HIDE THE CHROME ONCE: comment out the
 *     `paintFloatingSelectionChrome(...)` call in renderGrid
 *     (app/src/core/lib/gridRenderer/core.ts:1166). Steps 8 and 9 must go red
 *     on their handle-pixel checks ("a SELECTED slicer shows no handle pixel at
 *     its right-edge midpoint"; "control: a selected, unlocked shape shows no
 *     corner handle pixel" -- step 9 stops there, so its padlock check, the
 *     canvas's own layer, is not reached).
 *   - Deleting `if (!isObjectInSelection(region)) return false;` in
 *     `floatingHandlesLive` (app/src/core/lib/floatingHandles.ts:281, the
 *     selection gate) must make step 7's unselected corner a handle ("timeline:
 *     an UNSELECTED object's corner promises a resize") and step 10's
 *     unselected-corner control read a resize pointer ("control: an UNSELECTED
 *     chart's corner promises a resize").
 *   - Mapping the "e" handle to the "se" edges (`edgesOf`, the same file :160)
 *     must make steps 8 and 9 change the height too ("the right-edge handle
 *     changed more than the width"; "a right-edge handle drag did not change
 *     the width ONLY ...").
 *   - BUG-0268: dropping `if (!readIsCurrent()) return "superseded";` from
 *     `applyResolvedControlSize` (app/extensions/Controls/lib/
 *     floatingStore.ts:277) must bring back step 9's "BUG-0268: the shape's
 *     region kept its OLD width after a Core-handle resize" (and the missing
 *     padlock). It depends on the order the backend served that run's read and
 *     write in: if it does not reproduce, say so rather than count it.
 *
 *   PHASE 4a
 *   - `slicerZoneOfHit` (app/extensions/Slicer/rendering/slicerRenderer.ts:1130-1131)
 *     answering `{ kind: "frame", cursor: "pointer", part: "item" }` for an
 *     item (the pre-phase-4 answer) must make step 11 MOVE the slicer and leave
 *     its filter unchanged ("the drag from an item MOVED the slicer (the items
 *     are frame again)").
 *   - The same function answering `null` for "scrollbar" (:947-948, frame)
 *     must make step 13 promise a move over the thumb ("the scrollbar promises
 *     a move").
 *   - Putting the Slicer's capture mousedown back (app/extensions/Slicer/
 *     index.ts: a `window.addEventListener("mousedown", ..., true)` in
 *     activate() recording `e.ctrlKey`, fed to `selectSlicer(slicerId, ...)` at
 *     :245 in `handleFloatingSelected` :226 instead of `detail.ctrlKey`) must
 *     make step 12 DESELECT the slicer ("a Ctrl+click on an ITEM took the
 *     slicer OUT of its selection (the raw Ctrl reached selectSlicer)").
 *
 *   PHASE 4b
 *   - Putting back `handlePivotVisualPress(pivotId, d.canvasX, d.canvasY)` in
 *     place of `beginPivotChromePress(...)` in the box's
 *     `floatingObject:bodyDragStart` listener (app/extensions/Pivot/lib/
 *     pivotVisualOverlay.ts:611) must make step 14's slide-off COLLAPSE the
 *     product ("a press on the '-' released 60 px away TOGGLED it (the chrome
 *     acted on the press)").
 *   - `chartButtonAt`'s answer turned back into `{ kind: "frame", cursor:
 *     "pointer", part: button.part }` in `chartZoneAt` (app/extensions/Charts/
 *     lib/chartZoneAt.ts:75) must make step 16's drag from the quick-access
 *     button MOVE the chart ("a drag from the quick-access button MOVED the
 *     chart (the button is frame again)").
 *
 *   PHASE 4c
 *   - Putting the run back on the PRESS -- in the run-mode branch of
 *     `handleFloatingSelected` (app/extensions/Controls/index.ts:2523, in the
 *     handler at :2464), for a button: `emitAppEvent("button:clicked",
 *     { instanceId: controlId, x: 0, y: 0 })` and `void runFloatingButtonClick(
 *     controlSheet, controlRow, controlCol, controlId)` -- must make step 15's
 *     "the button ran on the PRESS" go red (the counter is 1 while it is held).
 *   - Calling `s.run()` without the inside test in `onPressUp`
 *     (app/extensions/Controls/lib/buttonPress.ts:147, `if (!insideAt(...))
 *     return;`) must make step 15's slide-off counter 1 ("pressed and slid off,
 *     the button RAN (it runs on press again)").
 *
 *   PHASE 5a
 *   - Commenting out the `paintFloatingGrips(...)` call in renderGrid
 *     (app/src/core/lib/gridRenderer/core.ts:1165) must make steps 17, 20, 21
 *     and 23 go red on their grip-pixel checks (17: "a HOVERED header-less
 *     slicer shows no grip pixels above its top-left"; 20: "a HOVERED
 *     header-less slicer at the sheet's top edge shows no grip pixels BELOW its
 *     bottom edge"; 21: "a SELECTED canvas chart paints no grip above its
 *     top-left"; 23: "the header-less timeline, HOVERED, shows no grip"). The
 *     product's own `shown` answer stays true there: only the paint is gone.
 *   - Removing `onMouseLeave={handleMouseLeave}` from `<S.GridArea>`
 *     (app/src/core/components/Spreadsheet/Spreadsheet.tsx:1586) must make
 *     step 17's "the pointer LEFT the grid and the slicer is still Core's
 *     hovered object (no mouseleave)" go red.
 *   - Deleting the `[canvasScrollX, canvasScrollY]` clearFloatingHover effect
 *     (the same file :1295-1297) must make step 17's "the grid scrolled under
 *     the pointer and the slicer is still Core's hovered object" go red.
 *   - Dropping `&& !moveState.hasMoved` from the gripClick dispatch in
 *     `handleOverlayMoveMouseUp` (app/src/core/hooks/useMouseSelection/layout/
 *     overlayMoveHandlers.ts:720) must make step 18's "a DRAG of the grip was
 *     taken for a click" go red.
 *   - Making the "above" branch of the placement rule in `floatingGripGeometry`
 *     unconditional (app/src/core/lib/floatingGrip.ts:216, `} else if
 *     (sheetRect.y >= size) {` -> `} else if (true) {`) must make step 20's "a
 *     slicer at sheet y 0 has no room above: its grip must sit BELOW it" go red.
 *   - Deleting `if (isRegionLocked(env.surface, region)) return false;` in
 *     `floatingGripShown` (the same file :365, the lock rule) must make step 21
 *     keep the grip on the LOCKED chart ("the product still shows a grip on a
 *     LOCKED chart").
 *
 *   PHASE 5b
 *   - Deleting `window.addEventListener(FLOATING_GRIP_CLICK_EVENT,
 *     handleGripClick);` in activate() (app/extensions/BuiltIn/ObjectPosition/
 *     index.ts:77) must make step 19's "a click on the grip opened no menu" go
 *     red (and step 21's "a click on the selected chart's grip opened no
 *     menu").
 *   - Removing `...sizeAndPositionRows(slicerId),` from the slicer's menu
 *     (app/extensions/Slicer/handlers/slicerContextMenu.ts:230, in
 *     `showContextMenu` :154) must make step 22's "the slicer's right-click
 *     menu carries no "Size and Position..."" go red.
 *   - Dropping `if (isRegionLocked(surface, region)) return refuse(true,
 *     SIZE_POSITION_LOCKED);` from `sizeAndPositionAvailability`
 *     (app/src/api/objectPosition.ts:129) must make step 21's "a LOCKED chart's
 *     dialog is editable" go red.
 *
 * SHARED APP. Every test starts and ends with the app's own File > New (the
 * file-api route, never a raw `new_file` -- BUG-0205).
 *
 * LOCALE. sv-SE: formulas sent through `update_cell` use `;` (none here).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  callModule,
  configurePivot,
  createRangePivot,
  eventually,
  invoke,
  newFile,
  pivotView,
  pressUndo,
  undoState,
  viewText,
  writeTable,
  cellAt,
} from "../helpers/pivot-live";
import {
  chartData,
  gridBox,
  objects,
  patchActiveCanvas,
  selectedObjects,
  clickEmpty,
  createChart,
  createShape,
  controlsOn,
  persistedCharts,
  type Obj,
} from "../helpers/canvas-live";
import { samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";
import {
  periodPoint,
  timelineLanded,
  timelineRange,
  timelineZonePoint,
  type TimelineRow,
} from "../helpers/timelines";
import { slicerItemPoint, slicerItemValues, slicerLanded, slicerRow, slicerThumbPoint } from "../helpers/slicers";
import {
  activeQuickAccessPopup,
  appEventCount,
  chartQuickAccessPoint,
  createFloatingButton,
  pivotBoxIconPoint,
  setDesignMode,
  startAppEventCounter,
} from "../helpers/objectButtons";
import { gripRect, hoveredRegionId, startWindowEventCounter, windowEventCount, type GripRect } from "../helpers/objectGrip";

// ---------------------------------------------------------------------------
// Data and set-ups
// ---------------------------------------------------------------------------

/** Date / Product / Sales: one product per month, January to June 2026 (TEXT dates: TL-NUM). */
const TL_DATA: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Pears", 2],
  ["'2026-03-03", "Plums", 4],
  ["'2026-04-12", "Kiwis", 8],
  ["'2026-05-20", "Figs", 16],
  ["'2026-06-08", "Limes", 32],
];

const SUM_SALES = { sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" };

type Surface = "worksheet" | "canvas";

/** Row labels of a one-level pivot, in order, grand total left out. */
async function rowOrder(page: Page, pivotId: string): Promise<string[]> {
  const v = await pivotView(page, pivotId);
  const t = viewText(v);
  return v.rows.map((r, i) => (r.rowType === "Data" ? t[i][0] : null)).filter((x): x is string => x !== null);
}

/** Sheet1: the data, and a pivot at E1 (Product rows, Sum of Sales). Sheet1 must be active. */
async function seedPivot(page: Page): Promise<string> {
  await writeTable(page, TL_DATA);
  expect((await cellAt(page, 0, 1, 0))?.type, "precondition: the dates are text").toBe("text");
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C7", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });
  return pid;
}

/**
 * The sheet the objects go on: Sheet1 itself, or a new canvas whose page fits
 * the window (every object on screen at zoom 1). Snap stays ON on a canvas
 * (gridSizePx 16), so every position and delta below is a multiple of 16.
 */
async function objectSheet(page: Page, surface: Surface): Promise<{ index: number; pageWidth: number; pageHeight: number }> {
  if (surface === "worksheet") return { index: 0, pageWidth: Number.POSITIVE_INFINITY, pageHeight: Number.POSITIVE_INFINITY };
  const canvas = await addCanvas(page);
  const box = await gridBox(page);
  const pageWidth = Math.min(1280, Math.floor((box.width - 32) / 16) * 16);
  const pageHeight = Math.min(720, Math.floor((box.height - 32) / 16) * 16);
  await patchActiveCanvas(page, { pagePreset: "custom", pageWidth, pageHeight });
  return { index: canvas.index, pageWidth, pageHeight };
}

/**
 * Where the objects of one test sit, in sheet px (multiples of 16). On a
 * worksheet they float over cells, which is harmless; column A (x < 64) is
 * kept free of objects so a click there deselects them (`deselectAll`), and
 * everything stays well left of a task pane a selection may open.
 */
function origin(surface: Surface): { x: number; y: number } {
  return surface === "worksheet" ? { x: 320, y: 192 } : { x: 64, y: 64 };
}

/**
 * Step 5's bands: the timelines' row, and the slicers' row 176 px below it (a
 * timeline is 144 tall), so no object of one family covers the other's header
 * -- before the drag or after the timelines were moved up to y = 0.
 */
function groupOrigin(surface: Surface): { x: number; y: number } {
  return surface === "worksheet" ? { x: 96, y: 48 } : { x: 64, y: 64 };
}
const SLICER_BAND = 176;

/** A months timeline on the pivot's Date field. */
async function createTimeline(page: Page, pid: string, sheetIndex: number, x: number, y: number, width = 416): Promise<string> {
  const tl = await callModule<TimelineRow | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
    { name: `Date_${x}`, sheetIndex, x, y, width, height: 144, sourceId: pid, fieldName: "Date", level: "months" },
  ]);
  expect(tl, "precondition: a timeline was created on the pivot's Date field").toBeTruthy();
  await eventually(
    () => callModule<{ periods: unknown[] } | undefined>(page, MOD.TIMELINE_STORE, "getCachedTimelineData", [tl!.id]),
    (d) => (d?.periods.length ?? 0) === 6,
    "the timeline never listed January to June",
    15_000,
  );
  await page.waitForTimeout(300);
  return tl!.id;
}

/** A slicer on the pivot's Product field (160 wide; 176 tall unless asked). */
async function createSlicer(page: Page, pid: string, sheetIndex: number, x: number, y: number, height = 176): Promise<string> {
  const s = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: `Product_${x}`,
      sheetIndex,
      x,
      y,
      width: 160,
      height,
      sourceType: "pivot",
      cacheSourceId: pid,
      fieldName: "Product",
      connectedSources: [{ sourceType: "pivot", sourceId: pid }],
    },
  ]);
  expect(s, "precondition: a slicer was created on the pivot's Product field").toBeTruthy();
  await page.waitForTimeout(300);
  return s!.id;
}

interface Placed {
  id: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A timeline's PERSISTED rectangle, from the backend. */
async function timelineAt(page: Page, tid: string): Promise<Placed> {
  const all = await invoke<Placed[]>(page, "get_all_timeline_slicers");
  const t = all.find((r) => r.id === tid);
  if (!t) throw new Error(`the backend holds no timeline ${tid}`);
  return t;
}

/** A slicer's PERSISTED rectangle, from the backend. */
async function slicerAt(page: Page, sid: string): Promise<Placed> {
  const all = await invoke<Placed[]>(page, "get_all_slicers");
  const s = all.find((r) => r.id === sid);
  if (!s) throw new Error(`the backend holds no slicer ${sid}`);
  return s;
}

/** The published object (canvas-live `Obj`) of a timeline or slicer, with its selection state. */
async function objectOf(page: Page, regionId: string): Promise<Obj> {
  const o = (await objects(page)).find((x) => x.id === regionId);
  if (!o) throw new Error(`no published object ${regionId}: ${(await objects(page)).map((x) => x.id).join(", ")}`);
  return o;
}
const TL_REGION = (tid: string) => `timeline-slicer-${tid}`;
const SLICER_REGION = (sid: string) => `slicer-${sid}`;

/** The CLIENT point of a sheet-px point on the active sheet. */
async function clientOf(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const box = await gridBox(page);
  return { x: box.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom, y: box.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom };
}

/**
 * Move the real mouse onto `p` and read the cursor the USER SEES there: the
 * computed cursor of the element under the pointer. Core writes its answer on
 * the grid area and the <canvas> inherits it, but an inline cursor on the
 * canvas CHILD (an extension's second writer -- the Charts mousemove wrote a
 * hand over every chart's bars until the fixer round) beats it; reading the
 * grid area's own style was blind to exactly that.
 */
async function cursorAt(page: Page, p: { x: number; y: number }): Promise<string> {
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(300);
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return "<nothing under the pointer>";
    return getComputedStyle(el).cursor;
  }, p);
}

/** The client point at the middle of a chart's TALLEST bar (chart-local geometry from the renderer's cache). */
async function tallestBarPoint(page: Page, cid: string, chartAt: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const bars = (await chartData(page, cid))?.bars ?? [];
  if (bars.length === 0) throw new Error("the chart has no bar geometry");
  const bar = bars.reduce((a, b) => (b.height > a.height ? b : a));
  return clientOf(page, chartAt.x + bar.x + bar.width / 2, chartAt.y + bar.y + bar.height / 2);
}

/** A human drag: press at `from`, move in steps to `to` (then on to `releaseAt`), release. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  releaseAt?: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  if (releaseAt) await page.mouse.move(releaseAt.x, releaseAt.y, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** A click the way a hand makes one, optionally with Shift or Ctrl held. */
async function click(page: Page, p: { x: number; y: number }, mod?: "Shift" | "Control"): Promise<void> {
  if (mod) await page.keyboard.down(mod);
  try {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
  } finally {
    if (mod) await page.keyboard.up(mod);
  }
  await page.waitForTimeout(250);
}

/** Deselect every object: an empty point of the canvas page, or a far cell on a worksheet. */
async function deselectAll(page: Page, surface: Surface, sheet: { pageWidth: number; pageHeight: number }): Promise<void> {
  if (surface === "canvas") {
    await clickEmpty(page, Math.min(sheet.pageWidth - 32, 960), Math.min(sheet.pageHeight - 24, 560));
  } else {
    // Two different cells of column A (A6, then A8; no object covers column A):
    // the second click is a selection CHANGE even when A6 was already selected,
    // and the families deselect on one.
    await click(page, await clientOf(page, 30, 110));
    await click(page, await clientOf(page, 30, 150));
  }
}

/** Bring the Canvas contextual tab forward (a selected object's own tab may have taken the band). */
async function openCanvasTab(page: Page): Promise<void> {
  const band = page.locator("[data-ribbon-content]");
  const strip = band.locator("xpath=..").locator("div").first();
  await strip.locator("button", { hasText: /^Canvas$/ }).first().click();
  await page.waitForTimeout(200);
}

/** The canvas's locked objects ("kind:id"), from the backend. */
async function lockedOn(page: Page, canvasIndex: number): Promise<string[]> {
  const r = await invoke<{ sheets: Array<{ index: number; canvasLayout?: { locked?: Array<{ kind: string; id: string }> } }> }>(page, "get_sheets");
  const s = r.sheets.find((x) => x.index === canvasIndex);
  return (s?.canvasLayout?.locked ?? []).map((l) => `${l.kind}:${l.id}`);
}

/**
 * A CLIENT point over the ribbon, straight above `x`, that is NOT inside the
 * grid area (checked: a release there is the whole point of step 5).
 */
async function ribbonPointAbove(page: Page, x: number): Promise<{ x: number; y: number }> {
  const r = await page.evaluate((x) => {
    const band = document.querySelector("[data-ribbon-content]") as HTMLElement | null;
    if (!band) return { error: "no ribbon content band" };
    const b = band.getBoundingClientRect();
    const y = b.top + Math.min(12, b.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { error: "nothing at the ribbon point" };
    if (hit.closest("[data-grid-area]")) return { error: "the ribbon point is inside the grid area" };
    return { x, y };
  }, x);
  if ("error" in r) throw new Error(`ribbonPointAbove: ${r.error}`);
  return r as { x: number; y: number };
}

async function endClean(page: Page): Promise<void> {
  await page.mouse.up().catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  await newFile(page).catch(() => undefined);
}

/** Two positions are the same within `tol` px (a drag's fractional client px). */
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1-3. The range on a timeline: content drags, frame moves, Shift extends
// ---------------------------------------------------------------------------

for (const surface of ["worksheet", "canvas"] as const) {
  test.describe(`timeline range grammar (${surface})`, () => {
    test(`1-3 (${surface}): a drag on an UNSELECTED timeline's months selects Feb-May and moves nothing (one Ctrl+Z restores 'all'); the year strip moves it and keeps the range; Shift+click extends Feb to Apr and keeps it selected`, async ({
      appPage: page,
    }) => {
      test.setTimeout(240_000);
      try {
        await newFile(page);
        const pid = await seedPivot(page);
        const sheet = await objectSheet(page, surface);
        const at = origin(surface);
        const tid = await createTimeline(page, pid, sheet.index, at.x, at.y);
        expect(await rowOrder(page, pid), "precondition: every month shows").toEqual(["Apples", "Figs", "Kiwis", "Limes", "Pears", "Plums"]);

        // ---- 1. The first press on an UNSELECTED timeline's months drags a range.
        await deselectAll(page, surface, sheet);
        await eventually(() => objectOf(page, TL_REGION(tid)), (o) => !o.selected, "precondition: the timeline is not selected");
        const before = await timelineAt(page, tid);
        const depth0 = (await undoState(page)).undoDepth;

        await drag(page, await periodPoint(page, tid, "2026-02"), await periodPoint(page, tid, "2026-05"));
        await timelineLanded(page);
        await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-05", "the drag did not select February to May");
        const afterDrag = await timelineAt(page, tid);
        expect({ x: afterDrag.x, y: afterDrag.y }, "the range drag MOVED the timeline (BUG-0258)").toEqual({ x: before.x, y: before.y });
        await eventually(
          () => rowOrder(page, pid),
          (o) => JSON.stringify(o) === '["Figs","Kiwis","Pears","Plums"]',
          "the pivot is not filtered to February..May",
        );
        expect((await undoState(page)).undoDepth, "the range drag is not ONE undo step").toBe(depth0 + 1);

        await pressUndo(page);
        await eventually(() => timelineRange(page, tid), (r) => r === "all", "one Ctrl+Z did not restore 'all'");
        const afterUndo = await timelineAt(page, tid);
        expect({ x: afterUndo.x, y: afterUndo.y }, "the Ctrl+Z moved the timeline").toEqual({ x: before.x, y: before.y });

        // ---- 2. The year strip is FRAME: 'move' there, a hand over a month; a drag moves it, the range stays.
        await click(page, await periodPoint(page, tid, "2026-03"));
        await timelineLanded(page);
        await eventually(() => timelineRange(page, tid), (r) => r === "2026-03..2026-03", "precondition: a click on March selects March");
        const strip = await timelineZonePoint(page, tid, "yearStrip");
        expect(await cursorAt(page, strip), "the year strip does not promise a move").toBe("move");
        expect(await cursorAt(page, await periodPoint(page, tid, "2026-04")), "a month does not show its hand").toBe("pointer");

        const geo = await readGridGeometry(page);
        const moveBy = { dx: 64, dy: 32 };
        await drag(page, strip, { x: strip.x + moveBy.dx * geo.zoom, y: strip.y + moveBy.dy * geo.zoom });
        const moved = await eventually(
          () => timelineAt(page, tid),
          (t) => near(t.x, before.x + moveBy.dx) && near(t.y, before.y + moveBy.dy),
          `the year-strip drag did not move the timeline by (${moveBy.dx}, ${moveBy.dy})`,
        );
        expect(moved.width, "the move resized the timeline").toBe(before.width);
        expect(await timelineRange(page, tid), "moving the timeline changed its range").toBe("2026-03..2026-03");

        // ---- 3. Shift+click extends the range, and the timeline stays selected.
        await click(page, await periodPoint(page, tid, "2026-02"));
        await timelineLanded(page);
        await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-02", "precondition: a click on February selects February");
        await eventually(() => objectOf(page, TL_REGION(tid)), (o) => o.selected, "precondition: the clicked timeline is selected");
        await click(page, await periodPoint(page, tid, "2026-04"), "Shift");
        await timelineLanded(page);
        await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-04", "Shift+click on April did not extend February to April");
        expect((await objectOf(page, TL_REGION(tid))).selected, "Shift+click on a month took the timeline OUT of the selection").toBe(true);
        const still = await timelineAt(page, tid);
        expect({ x: still.x, y: still.y }, "the Shift+click moved the timeline").toEqual({ x: moved.x, y: moved.y });
      } finally {
        await endClean(page);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 4. A locked timeline: its frame refuses the move, its content still works
// ---------------------------------------------------------------------------

test.describe("a LOCKED timeline (canvas)", () => {
  test("4: locked -- a header drag moves nothing, the pointer over the header is 'default' (it was 'move'), and a range drag still filters", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "canvas");
      const tid = await createTimeline(page, pid, sheet.index, 64, 64);

      const header = await timelineZonePoint(page, tid, "header");
      expect(await cursorAt(page, header), "control: an unlocked header shows 'move'").toBe("move");

      // Select it by its header (frame) and lock it through Arrange > Lock.
      await click(page, header);
      await eventually(() => objectOf(page, TL_REGION(tid)), (o) => o.selected, "a header click did not select the timeline");
      await openCanvasTab(page);
      await page.locator('[data-testid="canvas-arrange-lock"]').click();
      await eventually(() => lockedOn(page, sheet.index), (l) => l.length === 1, "Arrange > Lock locked nothing");

      const before = await timelineAt(page, tid);
      expect(await cursorAt(page, header), "a LOCKED header still promises a move").toBe("default");

      const geo = await readGridGeometry(page);
      await drag(page, header, { x: header.x + 96 * geo.zoom, y: header.y + 48 * geo.zoom });
      await page.waitForTimeout(600);
      const after = await timelineAt(page, tid);
      expect({ x: after.x, y: after.y }, "a header drag MOVED a locked timeline").toEqual({ x: before.x, y: before.y });

      // Filtering is reading the report: the months still work on a locked timeline.
      await drag(page, await periodPoint(page, tid, "2026-02"), await periodPoint(page, tid, "2026-04"));
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-04", "a range drag on a LOCKED timeline did not filter");
      const end = await timelineAt(page, tid);
      expect({ x: end.x, y: end.y }, "the range drag moved the locked timeline").toEqual({ x: before.x, y: before.y });
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. A multi-selection released over the ribbon (BUG-0265)
// ---------------------------------------------------------------------------

for (const surface of ["worksheet", "canvas"] as const) {
  test.describe(`a group move released over the ribbon (${surface})`, () => {
    test(`5 (${surface}): two timelines, and then two slicers, selected and dragged by one header, released over the ribbon -- both move by the same delta and both stay selected`, async ({
      appPage: page,
    }) => {
      test.setTimeout(300_000);
      try {
        await newFile(page);
        const pid = await seedPivot(page);
        const sheet = await objectSheet(page, surface);
        const at = groupOrigin(surface);
        if (surface === "canvas") {
          expect(at.y + SLICER_BAND + 176, `precondition: the page (${sheet.pageHeight}) is tall enough for both bands`).toBeLessThanOrEqual(sheet.pageHeight);
        }

        type Family = {
          name: string;
          width: number;
          create: (x: number) => Promise<string>;
          read: (id: string) => Promise<Placed>;
          region: (id: string) => string;
          /** The header point (FRAME on both families), in CLIENT px. */
          header: (id: string) => Promise<{ x: number; y: number }>;
        };
        const families: Family[] = [
          {
            name: "timelines",
            width: 320,
            create: (x) => createTimeline(page, pid, sheet.index, x, at.y, 320),
            read: (id) => timelineAt(page, id),
            region: TL_REGION,
            header: (id) => timelineZonePoint(page, id, "header"),
          },
          {
            name: "slicers",
            width: 160,
            create: (x) => createSlicer(page, pid, sheet.index, x, at.y + SLICER_BAND),
            read: (id) => slicerAt(page, id),
            region: SLICER_REGION,
            header: async (id) => {
              const s = await slicerAt(page, id);
              return clientOf(page, s.x + s.width / 2, s.y + 10);
            },
          },
        ];

        for (const fam of families) {
          const leadX = at.x;
          const memberX = at.x + fam.width + 32;
          if (surface === "canvas") {
            expect(memberX + fam.width + 96, `precondition: the page (${sheet.pageWidth}) is wide enough for the ${fam.name}`).toBeLessThanOrEqual(sheet.pageWidth);
          }
          const lead = await fam.create(leadX);
          const member = await fam.create(memberX);

          // Select both: the lead by its header, the member added by Ctrl+header.
          await deselectAll(page, surface, sheet);
          await click(page, await fam.header(lead));
          await click(page, await fam.header(member), "Control");
          await eventually(
            async () => [(await objectOf(page, fam.region(lead))).selected, (await objectOf(page, fam.region(member))).selected],
            (s) => s[0] && s[1],
            `${fam.name}: precondition, both are not selected`,
          );
          const lead0 = await fam.read(lead);
          const member0 = await fam.read(member);

          // Drag the lead's header 96 px right, then up over the ribbon, and release THERE.
          const geo = await readGridGeometry(page);
          const from = await fam.header(lead);
          const right = { x: from.x + 96 * geo.zoom, y: from.y };
          const overRibbon = await ribbonPointAbove(page, right.x);
          await drag(page, from, right, overRibbon);

          const lead1 = await eventually(
            () => fam.read(lead),
            (t) => t.x !== lead0.x,
            `${fam.name}: the lead did not move (did the drag start on its frame?)`,
          );
          const leadDelta = lead1.x - lead0.x;
          expect(near(leadDelta, 96), `${fam.name}: the lead moved ${leadDelta} px, not 96`).toBe(true);
          const member1 = await eventually(
            () => fam.read(member),
            (t) => near(t.x - member0.x, leadDelta, 0.5),
            `${fam.name}: the co-moved member was NOT saved with the lead's delta ${leadDelta} (BUG-0265: only the lead was saved)`,
          );
          expect(
            near(member1.y - member0.y, lead1.y - lead0.y, 0.5),
            `${fam.name}: the member moved ${member1.y - member0.y} px vertically, the lead ${lead1.y - lead0.y}`,
          ).toBe(true);
          await eventually(
            async () => [(await objectOf(page, fam.region(lead))).selected, (await objectOf(page, fam.region(member))).selected],
            (s) => s[0] && s[1],
            `${fam.name}: the release over the ribbon narrowed the selection`,
          );

          // The member STAYS where it was saved (no snap-back at the family's next refresh).
          await callModule(page, fam.name === "timelines" ? MOD.TIMELINE_STORE : MOD.SLICER_STORE, "refreshCache", []);
          await page.waitForTimeout(400);
          const republished = (await objectOf(page, fam.region(member))).x;
          expect(near(republished, member1.x, 0.5), `${fam.name}: the member snapped back to ${republished} after a refresh (saved at ${member1.x})`).toBe(true);
        }
      } finally {
        await endClean(page);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 6. The chart brush's pointer
// ---------------------------------------------------------------------------

test.describe("the chart brush pointer (worksheet)", () => {
  test("6: over the plot of an UNSELECTED brushable chart the pointer is 'crosshair' (the brush); over its frame it is 'move'", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await writeTable(page, [
        ["Month", "Units"],
        ["Jan", 10],
        ["Feb", 40],
        ["Mar", 20],
        ["Apr", 30],
      ]);
      const sheetId = (await invoke<{ sheets: Array<{ sheetId?: string }> }>(page, "get_sheets")).sheets[0].sheetId;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, ...(sheetId ? { sheetId } : {}), startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: "Brush",
        params: [{ name: "brushed", select: "point", on: "category", brush: true }],
      };
      const res = await callModule<{ chart: { chartId: string } | null; refusal: string | null }>(page, MOD.CHART_STORE, "createChartLanded", [
        spec,
        { sheetIndex: 0, x: 320, y: 48, width: 384, height: 256, name: "Brush" },
      ]);
      expect(res.chart, `the chart was refused: ${res.refusal}`).toBeTruthy();
      const cid = res.chart!.chartId;
      await callModule(page, MOD.CHART_STORE, "syncChartRegions", []);
      await eventually(() => chartData(page, cid).then((d) => d !== null), (v) => v, "the chart never painted", 15_000);
      await page.waitForTimeout(300);

      // Where Core itself says the plot (content) and the frame are: its own
      // zone resolution over the chart's rectangle, never a copied layout.
      const geo = await readGridGeometry(page);
      const pts = await page.evaluate(
        async ({ cid, geo, mod }) => {
          const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
          const ov = (await w.__appImport(mod)) as {
            getGridRegions: () => Array<{ id: string; type: string; floating?: { x: number; y: number; width: number; height: number }; data?: Record<string, unknown> }>;
            resolveFloatingZone: (ctx: unknown) => { kind: string; cursor: string };
          };
          const region = ov.getGridRegions().find((g) => g.type === "chart" && g.data?.chartId === cid);
          if (!region?.floating) return { error: "no chart region" };
          const b = {
            x: geo.rowHeaderWidth + region.floating.x - geo.scrollX,
            y: geo.colHeaderHeight + region.floating.y - geo.scrollY,
            width: region.floating.width,
            height: region.floating.height,
          };
          const content: Array<[number, number]> = [];
          let frameTop: [number, number] | null = null;
          for (let y = b.y + 14; y < b.y + b.height - 14; y += 4) {
            for (let x = b.x + 14; x < b.x + b.width - 14; x += 4) {
              const z = ov.resolveFloatingZone({ region, canvasX: x, canvasY: y, row: 0, col: 0, floatingCanvasBounds: b });
              if (z.kind === "content") content.push([x, y]);
              else if (frameTop === null && Math.abs(x - (b.x + b.width / 2)) < 4) frameTop = [x, y];
            }
          }
          if (content.length === 0) return { error: "no content zone on a brushable chart" };
          if (frameTop === null) return { error: "no frame point along the top centre" };
          const xs = content.map((p) => p[0]).sort((a, b) => a - b);
          const ys = content.map((p) => p[1]).sort((a, b) => a - b);
          const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
          const c = (x: number, y: number) => ({ x: area.left + x * geo.zoom, y: area.top + y * geo.zoom });
          return { plot: c(xs[Math.floor(xs.length / 2)], ys[Math.floor(ys.length / 2)]), frame: c(frameTop[0], frameTop[1]) };
        },
        { cid, geo, mod: "/src/api/gridOverlays.ts" },
      );
      if ("error" in pts) throw new Error(`chart zones: ${pts.error}`);

      const selectedBefore = (await selectedObjects(page)).map((o) => o.id);
      expect(selectedBefore, "precondition: the chart is not selected").not.toContain(`chart-${cid}`);
      expect(await cursorAt(page, pts.frame), "the chart's frame does not show 'move'").toBe("move");
      expect(await cursorAt(page, pts.plot), "the plot of a brushable chart does not show the brush's crosshair").toBe("crosshair");
      // ON A BAR of that plot too. The Charts mousemove used to write a hand
      // onto the grid <canvas> over every chart's bars -- a second pointer
      // answer that a read of the grid area's own style never saw.
      const placed = await objectOf(page, `chart-${cid}`);
      const onBar = await tallestBarPoint(page, cid, { x: placed.x, y: placed.y });
      expect(await cursorAt(page, onBar), "a bar of the brushable plot shows a hand, not the brush's crosshair").toBe("crosshair");
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 7-10. Phase 3: handles only where they work
// ---------------------------------------------------------------------------

/** Core's ONE selection colour (core/lib/floatingHandleMetrics.ts), as RGB. */
const CHROME_RGB = [0x0e, 0x63, 0x9c] as const;

/** How many pixels of a sample are Core's selection colour (within a small tolerance). */
function chromePixels(s: PixelSample): number {
  let n = 0;
  for (let i = 0; i + 2 < s.data.length; i += 4) {
    if (
      Math.abs(s.data[i] - CHROME_RGB[0]) <= 24 &&
      Math.abs(s.data[i + 1] - CHROME_RGB[1]) <= 24 &&
      Math.abs(s.data[i + 2] - CHROME_RGB[2]) <= 24
    ) {
      n++;
    }
  }
  return n;
}

/** The CLIENT-px clip of the sheet-px rectangle at (sx, sy), w x h, on the active sheet. */
async function sheetClip(page: Page, sx: number, sy: number, w: number, h: number): Promise<PixelClip> {
  const geo = await readGridGeometry(page);
  const p = await clientOf(page, sx, sy);
  return { x: p.x, y: p.y, width: w * geo.zoom, height: h * geo.zoom };
}

/** Chrome-coloured pixels in the sheet-px rectangle, from ONE fresh capture. */
async function chromeIn(page: Page, sx: number, sy: number, w: number, h: number): Promise<number> {
  const [s] = await samplePixelGrids(page, [await sheetClip(page, sx, sy, w, h)]);
  return chromePixels(s);
}

/** Park the pointer on a sheet point no object covers, so no hover state is what gets sampled. */
async function park(page: Page, sx: number, sy: number): Promise<void> {
  const p = await clientOf(page, sx, sy);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(250);
}

test.describe("phase 3: handles only on a SELECTED object (worksheet)", () => {
  test("7-8 (worksheet): a press 5px inside the corner of an UNSELECTED timeline or slicer moves it and never resizes it; a SELECTED slicer shows its right-edge handle and that handle changes the width only", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      const at = origin("worksheet");
      const tid = await createTimeline(page, pid, sheet.index, at.x, at.y);
      const sid = await createSlicer(page, pid, sheet.index, at.x, at.y + SLICER_BAND);
      const geo = await readGridGeometry(page);

      // ---- 7. An UNSELECTED object's corner is no handle.
      const objs = [
        { name: "timeline", read: () => timelineAt(page, tid), region: TL_REGION(tid) },
        { name: "slicer", read: () => slicerAt(page, sid), region: SLICER_REGION(sid) },
      ];
      for (const obj of objs) {
        await deselectAll(page, "worksheet", sheet);
        await eventually(() => objectOf(page, obj.region), (o) => !o.selected, `${obj.name}: precondition, it is not selected`);
        const before = await obj.read();
        const press = await clientOf(page, before.x + 5, before.y + 5);
        expect(await cursorAt(page, press), `${obj.name}: an UNSELECTED object's corner promises a resize`).not.toMatch(/resize/);
        await drag(page, press, { x: press.x - 32 * geo.zoom, y: press.y - 32 * geo.zoom });
        const after = await eventually(
          () => obj.read(),
          (t) => t.x !== before.x || t.width !== before.width,
          `${obj.name}: the drag from 5px inside its corner did nothing`,
        );
        expect(
          { width: after.width, height: after.height },
          `${obj.name}: a press 5px inside the corner of an UNSELECTED object RESIZED it`,
        ).toEqual({ width: before.width, height: before.height });
        expect(near(after.x, before.x - 32) && near(after.y, before.y - 32), `${obj.name}: it did not move by (-32, -32)`).toBe(true);
        await eventually(() => objectOf(page, obj.region), (o) => o.selected, `${obj.name}: the press did not select it`);
      }

      // ---- 8. A SELECTED slicer: its right-edge handle is painted, and it resizes the width only.
      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => !o.selected, "precondition: the slicer is not selected");
      const s0 = await slicerAt(page, sid);
      const mid = { sx: s0.x + s0.width, sy: s0.y + s0.height / 2 };
      // Just OUTSIDE the right edge: only a handle paints there (the outline is inset).
      const handlePatch = () => chromeIn(page, mid.sx + 1, mid.sy - 2, 2, 4);
      await park(page, 30, 110);
      expect(await handlePatch(), "control: an UNSELECTED slicer shows a handle pixel at its right-edge midpoint").toBe(0);

      await click(page, await clientOf(page, s0.x + s0.width / 2, s0.y + 10));
      await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => o.selected, "a header click did not select the slicer");
      await park(page, 30, 110);
      await eventually(handlePatch, (n) => n > 0, "a SELECTED slicer shows no handle pixel at its right-edge midpoint");

      const from = await clientOf(page, mid.sx, mid.sy);
      expect(await cursorAt(page, from), "the right-edge handle's pointer").toBe("ew-resize");
      await drag(page, from, { x: from.x + 64 * geo.zoom, y: from.y + 20 * geo.zoom });
      const s1 = await eventually(() => slicerAt(page, sid), (s) => s.width !== s0.width, "dragging the slicer's right-edge handle did not change its width");
      expect(near(s1.width, s0.width + 64), `the width changed by ${s1.width - s0.width}, not 64`).toBe(true);
      expect({ x: s1.x, y: s1.y, height: s1.height }, "the right-edge handle changed more than the width").toEqual({ x: s0.x, y: s0.y, height: s0.height });
    } finally {
      await endClean(page);
    }
  });
});

test.describe("phase 3: eight handles that resize, a lock that shows (canvas)", () => {
  test("9 (canvas): a shape's right-edge handle changes the width only; a selected shape shows its corner handle, and LOCKED it shows the padlock and no handle", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const sheet = await objectSheet(page, "canvas");
      const S = { x: 64, y: 64, width: 160, height: 96 };
      const made = await createShape(page, { sheetIndex: sheet.index, ...S });
      await eventually(
        () => objects(page),
        (os) => os.some((o) => o.id === made.instanceId),
        "the shape was never published",
        15_000,
      );
      const row = async () => {
        const r = (await controlsOn(page, sheet.index)).find((c) => c.type === "shape");
        if (!r) throw new Error("the backend holds no shape");
        return r;
      };
      const r0 = await row();
      expect({ x: r0.x, y: r0.y, width: r0.width, height: r0.height }, "precondition: the shape landed where it was asked").toEqual(S);
      const geo = await readGridGeometry(page);
      const parkAt = { sx: Math.min(sheet.pageWidth - 40, 900), sy: Math.min(sheet.pageHeight - 40, 500) };

      // Select it by its body.
      await click(page, await clientOf(page, S.x + S.width / 2, S.y + S.height / 2));
      await eventually(() => objectOf(page, made.instanceId), (o) => o.selected, "a body click did not select the shape");

      // ---- The right-edge handle: width only (it used to MOVE the shape).
      const rightMid = await clientOf(page, S.x + S.width, S.y + S.height / 2);
      expect(await cursorAt(page, rightMid), "the right-edge handle's pointer").toBe("ew-resize");
      await drag(page, rightMid, { x: rightMid.x + 64 * geo.zoom, y: rightMid.y + 16 * geo.zoom });
      const r1 = await eventually(row, (r) => r.width !== r0.width || r.x !== r0.x, "the right-edge handle did nothing");
      expect(
        { x: r1.x, y: r1.y, width: r1.width, height: r1.height },
        "a right-edge handle drag did not change the width ONLY (an edge-midpoint press used to MOVE the shape)",
      ).toEqual({ x: S.x, y: S.y, width: S.width + 64, height: S.height });
      const W = S.width + 64;

      // BUG-0268 (found here, run 9c): the published region -- what Core's
      // chrome, the padlock below and every hit test read -- must follow the
      // backend. The resize's own repaint used to read the control BEFORE the
      // write landed and put the old width back (160 while the backend held 224).
      const regionWidth = () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const load = (m: string) => import(/* @vite-ignore */ m) as Promise<any>;
          const overlays = await load("/src/api/gridOverlays.ts");
          const r = (overlays.getGridRegions() as Array<{ type: string; floating?: { width: number } }>).find(
            (x) => x.type === "floating-control",
          );
          return r?.floating?.width ?? null;
        });
      await eventually(regionWidth, (w) => w === W, "BUG-0268: the shape's region kept its OLD width after a Core-handle resize");

      // ---- Selected and unlocked: the top-left corner handle is painted (just OUTSIDE the corner).
      const cornerPatch = () => chromeIn(page, S.x - 3, S.y - 3, 2, 2);
      // The padlock's body, inside the top-right corner (CanvasSheet lib/selectionChrome.ts paintLockMarks).
      const lockX = S.x + W - 6 - 12 - 4;
      const padlockPatch = () => chromeIn(page, lockX + 1, S.y + 10 + 6, 10, 6);
      await park(page, parkAt.sx, parkAt.sy);
      await eventually(cornerPatch, (n) => n > 0, "control: a selected, unlocked shape shows no corner handle pixel");
      expect(await padlockPatch(), "control: an UNLOCKED shape shows a padlock").toBe(0);

      // ---- Locked: the padlock, and NO handle.
      await openCanvasTab(page);
      await page.locator('[data-testid="canvas-arrange-lock"]').click();
      await eventually(() => lockedOn(page, sheet.index), (l) => l.length === 1, "Arrange > Lock locked nothing");
      expect(await regionWidth(), "BUG-0268: locking put the shape's region back to its old width").toBe(W);
      await eventually(() => objectOf(page, made.instanceId), (o) => o.selected, "locking deselected the shape");
      await park(page, parkAt.sx, parkAt.sy);
      await eventually(padlockPatch, (n) => n > 0, "a selected LOCKED shape shows no padlock").catch(async (e) => {
        // DIAGNOSTIC (run 9b, 2026-09-30: no padlock pixel). Say what the lock
        // layer would have read: the live selection set, each member's ref,
        // whether the active canvas locks it, and the surface.
        const seen = await page
          .evaluate(async () => {
            // Loaded through a variable: the dev server resolves the path, tsc does not.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const load = (m: string) => import(/* @vite-ignore */ m) as Promise<any>;
            const sel = await load("/src/api/objectSelection.ts");
            const grid = await load("/src/api/grid.ts");
            const overlays = await load("/src/api/gridOverlays.ts");
            const locks = await load("/extensions/CanvasSheet/lib/canvasLocks.ts");
            const all = overlays.getGridRegions() as Array<{ id: string; type: string; floating?: unknown }>;
            const selected = sel.getSelectedObjectRegions() as Array<{ id: string; type: string; floating?: unknown }>;
            const snap = grid.getGridStateSnapshot() as { surface?: string; sheetContext?: { activeSheetIndex?: number } } | null;
            return {
              surface: snap?.surface,
              activeSheet: snap?.sheetContext?.activeSheetIndex,
              regions: all.filter((r) => r.floating).map((r) => ({ id: r.id, type: r.type, ref: sel.objectRefOf(r as never) })),
              selected: selected.map((r) => ({
                id: r.id,
                type: r.type,
                floating: r.floating,
                ref: sel.objectRefOf(r as never),
                locked: locks.isLockedOnActiveCanvas(r as never),
              })),
            };
          })
          .catch((err) => ({ probeError: String(err) }));
        throw new Error(`${String(e)}\n-- lock layer inputs: ${JSON.stringify(seen).slice(0, 3000)}`);
      });
      await eventually(cornerPatch, (n) => n === 0, "a LOCKED shape still shows a handle pixel at its corner");
      expect(await chromeIn(page, S.x + 20, S.y, 20, 2), "a LOCKED shape lost its selection outline").toBeGreaterThan(0);
      expect(await cursorAt(page, await clientOf(page, S.x, S.y)), "a LOCKED shape's corner still promises a resize").not.toMatch(/resize/);
    } finally {
      await endClean(page);
    }
  });
});

test.describe("phase 3: each handle's own pointer (worksheet chart)", () => {
  test("10 (worksheet): over a SELECTED chart the top-right corner is 'nesw-resize', the top-left 'nwse-resize', the right edge 'ew-resize'; over an UNSELECTED one the corner is 'move'", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await writeTable(page, [
        ["Month", "Units"],
        ["Jan", 10],
        ["Feb", 40],
        ["Mar", 20],
        ["Apr", 30],
      ]);
      const sheetId = (await invoke<{ sheets: Array<{ sheetId?: string }> }>(page, "get_sheets")).sheets[0].sheetId;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, ...(sheetId ? { sheetId } : {}), startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: "Handles",
      };
      const C = { x: 320, y: 48, width: 384, height: 256 };
      const res = await callModule<{ chart: { chartId: string } | null; refusal: string | null }>(page, MOD.CHART_STORE, "createChartLanded", [
        spec,
        { sheetIndex: 0, ...C, name: "Handles" },
      ]);
      expect(res.chart, `the chart was refused: ${res.refusal}`).toBeTruthy();
      const cid = res.chart!.chartId;
      await callModule(page, MOD.CHART_STORE, "syncChartRegions", []);
      await eventually(() => chartData(page, cid).then((d) => d !== null), (v) => v, "the chart never painted", 15_000);
      const regionId = `chart-${cid}`;
      const sheet = { pageWidth: Number.POSITIVE_INFINITY, pageHeight: Number.POSITIVE_INFINITY };

      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, regionId), (o) => !o.selected, "precondition: the chart is not selected");
      expect(
        await cursorAt(page, await clientOf(page, C.x + C.width - 2, C.y + 2)),
        "control: an UNSELECTED chart's corner promises a resize",
      ).toBe("move");
      // Its bars are FRAME (a drag there moves the chart): 'move', never the
      // hand the Charts mousemove used to write over them.
      const placed = await objectOf(page, regionId);
      expect(
        await cursorAt(page, await tallestBarPoint(page, cid, { x: placed.x, y: placed.y })),
        "a bar of a movable, non-brushable chart shows a hand -- a press there moves the chart",
      ).toBe("move");

      await click(page, await clientOf(page, C.x + C.width / 2, C.y + C.height / 2));
      await eventually(() => objectOf(page, regionId), (o) => o.selected, "a body click did not select the chart");
      expect(await cursorAt(page, await clientOf(page, C.x + C.width, C.y)), "the top-right corner").toBe("nesw-resize");
      expect(await cursorAt(page, await clientOf(page, C.x, C.y)), "the top-left corner").toBe("nwse-resize");
      expect(await cursorAt(page, await clientOf(page, C.x + C.width, C.y + C.height / 2)), "the right-edge midpoint").toBe("ew-resize");
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 11-13. Phase 4a: a slicer's items are content
// ---------------------------------------------------------------------------

/** The same items, order ignored. */
const sameSet = (a: readonly string[] | null, b: readonly string[]) =>
  a !== null && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

for (const surface of ["worksheet", "canvas"] as const) {
  test.describe(`slicer items are content (${surface})`, () => {
    test(`11-12 (${surface}): a drag across an UNSELECTED slicer's first three items selects exactly them and moves nothing (one Ctrl+Z restores all six rows); Ctrl+click on a second item adds it and keeps the slicer selected`, async ({
      appPage: page,
    }) => {
      test.setTimeout(240_000);
      try {
        await newFile(page);
        const pid = await seedPivot(page);
        const sheet = await objectSheet(page, surface);
        const at = origin(surface);
        const sid = await createSlicer(page, pid, sheet.index, at.x, at.y);
        const values = await eventually(
          () => slicerItemValues(page, sid),
          (v) => v.length === 6,
          "the slicer never listed the six products",
          15_000,
        );
        expect(await rowOrder(page, pid), "precondition: every product shows").toHaveLength(6);
        const headerOf = async () => {
          const s = await slicerRow(page, sid);
          return clientOf(page, s.x + s.width / 2, s.y + 10);
        };

        // ---- 11. The first press on an UNSELECTED slicer's items drags a run.
        await deselectAll(page, surface, sheet);
        await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => !o.selected, "precondition: the slicer is not selected");
        const before = await slicerRow(page, sid);
        expect(before.selectedItems, "precondition: the slicer filters nothing").toBeNull();
        const depth0 = (await undoState(page)).undoDepth;
        expect(await cursorAt(page, await slicerItemPoint(page, sid, values[1])), "an item does not show its hand").toBe("pointer");

        const run = values.slice(0, 3);
        await drag(page, await slicerItemPoint(page, sid, values[0]), await slicerItemPoint(page, sid, values[2]));
        await slicerLanded(page);
        const afterDrag = await eventually(
          () => slicerRow(page, sid),
          (s) => s.selectedItems !== null || s.x !== before.x || s.y !== before.y,
          "the drag across the items did nothing at all",
        );
        expect({ x: afterDrag.x, y: afterDrag.y }, "the drag from an item MOVED the slicer (the items are frame again)").toEqual({
          x: before.x,
          y: before.y,
        });
        expect(sameSet(afterDrag.selectedItems, run), `the drag selected ${JSON.stringify(afterDrag.selectedItems)}, not exactly ${JSON.stringify(run)}`).toBe(true);
        await eventually(() => rowOrder(page, pid), (o) => sameSet(o, run), "the pivot is not filtered to the three items dragged across");
        expect((await undoState(page)).undoDepth, "the run is not ONE undo step").toBe(depth0 + 1);
        await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => o.selected, "the press on an item did not select the slicer");
        expect(await cursorAt(page, await headerOf()), "the header does not promise a move").toBe("move");

        await pressUndo(page);
        await eventually(() => rowOrder(page, pid), (o) => o.length === 6, "one Ctrl+Z did not bring back all six rows");
        await eventually(() => slicerRow(page, sid), (s) => s.selectedItems === null, "one Ctrl+Z did not clear the slicer's filter");
        const afterUndo = await slicerRow(page, sid);
        expect({ x: afterUndo.x, y: afterUndo.y }, "the Ctrl+Z moved the slicer").toEqual({ x: before.x, y: before.y });

        // ---- 12. Ctrl+click on an item of a SELECTED slicer: the item toggles, the slicer stays selected.
        await click(page, await headerOf());
        await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => o.selected, "a header click did not select the slicer");
        await click(page, await slicerItemPoint(page, sid, values[0]));
        await slicerLanded(page);
        await eventually(
          () => slicerRow(page, sid),
          (s) => sameSet(s.selectedItems, [values[0]]),
          "precondition: a click on the first item selects it alone",
        );
        await click(page, await slicerItemPoint(page, sid, values[3]), "Control");
        await slicerLanded(page);
        await eventually(
          () => slicerRow(page, sid),
          (s) => sameSet(s.selectedItems, [values[0], values[3]]),
          "a Ctrl+click on a second item did not ADD it to the selection",
        );
        expect(
          (await objectOf(page, SLICER_REGION(sid))).selected,
          "a Ctrl+click on an ITEM took the slicer OUT of its selection (the raw Ctrl reached selectSlicer)",
        ).toBe(true);
        if (surface === "canvas") {
          expect((await selectedObjects(page)).map((o) => o.id), "the canvas selection lost the slicer").toContain(SLICER_REGION(sid));
        }
        const still = await slicerRow(page, sid);
        expect({ x: still.x, y: still.y }, "the item clicks moved the slicer").toEqual({ x: before.x, y: before.y });
      } finally {
        await endClean(page);
      }
    });
  });
}

test.describe("the slicer's scrollbar is content (worksheet)", () => {
  test("13 (worksheet): on a 160 x 96 slicer that must scroll, a drag of the scrollbar thumb 40 px down scrolls the items -- no undo step, no move, no filter", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      const at = origin("worksheet");
      const sid = await createSlicer(page, pid, sheet.index, at.x, at.y, 96);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 6, "the slicer never listed the six products", 15_000);
      expect(
        await callModule<number>(page, MOD.SLICER_RENDERER, "getMaxScrollOffset", [sid]),
        "precondition: six items in a 96 px slicer scroll",
      ).toBeGreaterThan(0);
      expect(await callModule<number>(page, MOD.SLICER_RENDERER, "getScrollOffset", [sid]), "precondition: unscrolled").toBe(0);

      // Unselected: its handles are not live, so the thumb (at the right edge,
      // near the edge's midpoint on a slicer this short) is the slicer's.
      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => !o.selected, "precondition: the slicer is not selected");
      const before = await slicerRow(page, sid);
      const depth0 = (await undoState(page)).undoDepth;

      const thumb = await slicerThumbPoint(page, sid);
      expect(await cursorAt(page, thumb), "the scrollbar promises a move").toBe("default");
      const geo = await readGridGeometry(page);
      await drag(page, thumb, { x: thumb.x, y: thumb.y + 40 * geo.zoom });

      await eventually(
        () => callModule<number>(page, MOD.SLICER_RENDERER, "getScrollOffset", [sid]),
        (v) => v > 0,
        "dragging the scrollbar thumb did not scroll the items",
      );
      const after = await slicerRow(page, sid);
      expect({ x: after.x, y: after.y }, "the thumb drag MOVED the slicer").toEqual({ x: before.x, y: before.y });
      expect(after.selectedItems, "the thumb drag filtered the slicer").toBeNull();
      expect((await undoState(page)).undoDepth, "the thumb drag recorded an undo step").toBe(depth0);
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 14, 16. Phase 4b: buttons act on release; a drag from one moves nothing
// ---------------------------------------------------------------------------

test.describe("the canvas pivot box's +/- acts on release (canvas)", () => {
  test("14 (canvas): a '-' pressed and slid off toggles nothing; a click collapses it once; a fast double-click on the '+' toggles once; a drag from the icon leaves the box where it was", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await writeTable(page, TL_DATA);
      const sheet = await objectSheet(page, "canvas");
      const BOX = { x: 64, y: 64, width: 416, height: 320 };
      const created = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
        {
          sourceRange: "Sheet1!A1:C7",
          destinationCell: "A1",
          sourceSheet: 0,
          destinationSheet: sheet.index,
          hasHeaders: true,
          name: "BoxPivot",
          canvasFrame: { ...BOX, frozenHeaders: true },
        },
      ]);
      const pid = String(created.pivotId);
      // Two row fields: every product carries a +/- over its one date.
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [
          { sourceIndex: 1, name: "Product" },
          { sourceIndex: 0, name: "Date" },
        ],
        valueFields: [SUM_SALES],
      });

      type FramedRegion = { pivotId: string; canvasFrame?: { x: number; y: number; width: number; height: number } };
      const frameOf = async () => {
        const r = (await invoke<FramedRegion[]>(page, "get_pivot_regions_for_sheet")).find((x) => String(x.pivotId) === pid);
        if (!r?.canvasFrame) throw new Error("the canvas pivot's region carries no frame");
        return r.canvasFrame;
      };
      const rowCount = async () => (await pivotView(page, pid)).rows.length;

      const frame0 = await eventually(frameOf, (f) => f.width === BOX.width, "the pivot box never landed on the canvas", 15_000);
      const rows0 = await eventually(rowCount, (n) => n >= 13, "the pivot never showed six products with their dates", 15_000);
      const minus = await eventually(
        () => pivotBoxIconPoint(page, pid, { expanded: true }),
        (p) => p !== null,
        "the box never painted a product's '-'",
        15_000,
      );
      const geo = await readGridGeometry(page);

      // ---- A press on the '-' slid 60 px off and released: nothing toggles, nothing moves.
      await drag(page, minus!, { x: minus!.x + 60 * geo.zoom, y: minus!.y });
      await page.waitForTimeout(800);
      expect(await rowCount(), "a press on the '-' released 60 px away TOGGLED it (the chrome acted on the press)").toBe(rows0);
      expect(await frameOf(), "a drag from the '-' MOVED the pivot box").toEqual(frame0);

      // ---- Pressed and released on it: collapsed (its date row is gone).
      await click(page, minus!);
      const collapsed = await eventually(rowCount, (n) => n < rows0, "a click on the '-' did not collapse the product");
      await page.waitForTimeout(700);
      expect(await rowCount(), "one click on the '-' toggled it more than once").toBe(collapsed);

      // ---- A fast double-click on the '+' (well past the 450 ms guard): toggled ONCE.
      const plus = await eventually(
        () => pivotBoxIconPoint(page, pid, { withKey: minus!.key }),
        (p) => p !== null && !p.isExpanded,
        "the collapsed product shows no '+'",
      );
      await page.mouse.dblclick(plus!.x, plus!.y);
      await eventually(rowCount, (n) => n === rows0, "a double-click on the '+' did not expand the product");
      await page.waitForTimeout(1000);
      expect(await rowCount(), "a double-click on the '+' toggled it TWICE (collapsed again)").toBe(rows0);

      // ---- A drag that starts on the icon: the box stays where it was.
      await page.waitForTimeout(600);
      const again = await eventually(
        () => pivotBoxIconPoint(page, pid, { withKey: minus!.key }),
        (p) => p !== null && p.isExpanded,
        "the expanded product shows no '-'",
      );
      await drag(page, again!, { x: again!.x + 96 * geo.zoom, y: again!.y + 64 * geo.zoom });
      await page.waitForTimeout(800);
      const frame1 = await frameOf();
      expect({ x: frame1.x, y: frame1.y }, "a drag starting on the '-' MOVED the pivot box").toEqual({ x: frame0.x, y: frame0.y });
      expect(await rowCount(), "a drag starting on the '-' toggled it").toBe(rows0);
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Phase 4c: a run-mode floating button runs at the RELEASE inside it
// ---------------------------------------------------------------------------

/** The mean luminance (0..255) of a pixel sample. */
function meanLuma(s: PixelSample): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < s.data.length; i += 4) {
    sum += 0.299 * s.data[i] + 0.587 * s.data[i + 1] + 0.114 * s.data[i + 2];
    n++;
  }
  return n === 0 ? NaN : sum / n;
}

for (const surface of ["worksheet", "canvas"] as const) {
  test.describe(`a run-mode floating button runs on release (${surface})`, () => {
    test(`15 (${surface}): pressed and slid 60 px off, a run-mode button runs nothing; pressed and released inside it runs once; held inside it looks pressed; in Design Mode a drag moves it and runs nothing`, async ({
      appPage: page,
    }) => {
      test.setTimeout(180_000);
      try {
        await newFile(page);
        const sheet = await objectSheet(page, surface);
        const at = origin(surface);
        const B = { x: at.x, y: at.y, width: 160, height: 48 };
        await setDesignMode(page, false);
        const made = await createFloatingButton(page, { sheetIndex: sheet.index, ...B, label: "Press me" });
        await eventually(
          () => objects(page),
          (os) => os.some((o) => o.id === made.instanceId),
          "the button was never published",
          15_000,
        );
        const row = async () => {
          const r = (await controlsOn(page, sheet.index)).find((c) => c.type === "button");
          if (!r) throw new Error("the backend holds no button");
          return r;
        };
        const r0 = await row();
        expect({ x: r0.x, y: r0.y, width: r0.width, height: r0.height }, "precondition: the button landed where it was asked").toEqual(B);
        const geo = await readGridGeometry(page);
        const centre = await clientOf(page, B.x + B.width / 2, B.y + B.height / 2);
        const off = { x: centre.x, y: centre.y + 60 * geo.zoom };
        // A patch of the button's face clear of its centred caption.
        const face = () => sheetClip(page, B.x + 10, B.y + Math.round(B.height * 0.6), 10, 8);
        const faceLuma = async () => meanLuma((await samplePixelGrids(page, [await face()]))[0]);
        await startAppEventCounter(page, "button:clicked");

        // ---- The pointer: a hand (content), not 'move'.
        expect(await cursorAt(page, centre), "a run-mode button does not show its hand").toBe("pointer");
        const released = await faceLuma();

        // ---- Held inside it looks pressed; slid 60 px off it looks raised again, and the release runs nothing.
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.down();
        await page.waitForTimeout(250);
        const held = await faceLuma();
        expect(held, `a held run-mode button does not look pressed (released ${released.toFixed(1)}, held ${held.toFixed(1)})`).toBeLessThan(released - 8);
        expect(await appEventCount(page, "button:clicked"), "the button ran on the PRESS").toBe(0);
        await page.mouse.move(off.x, off.y, { steps: 6 });
        await page.waitForTimeout(250);
        const slidOff = await faceLuma();
        expect(Math.abs(slidOff - released), `slid off, the button still looks pressed (released ${released.toFixed(1)}, now ${slidOff.toFixed(1)})`).toBeLessThan(4);
        await page.mouse.up();
        await page.waitForTimeout(600);
        expect(await appEventCount(page, "button:clicked"), "pressed and slid off, the button RAN (it runs on press again)").toBe(0);

        // ---- Pressed and released inside: runs once.
        await click(page, centre);
        await eventually(() => appEventCount(page, "button:clicked"), (n) => n === 1, "a click inside the button did not run it");
        await page.waitForTimeout(500);
        expect(await appEventCount(page, "button:clicked"), "one click ran the button more than once").toBe(1);
        const r1 = await row();
        expect({ x: r1.x, y: r1.y }, "run mode: the button moved").toEqual({ x: B.x, y: B.y });

        // ---- Design Mode: a drag from its body MOVES it and runs nothing.
        await setDesignMode(page, true);
        expect(await cursorAt(page, centre), "a Design-Mode button is not frame ('move')").toBe("move");
        await drag(page, centre, { x: centre.x + 64 * geo.zoom, y: centre.y + 32 * geo.zoom });
        const r2 = await eventually(row, (r) => r.x !== B.x, "in Design Mode a drag did not move the button");
        expect(near(r2.x, B.x + 64) && near(r2.y, B.y + 32), `the Design-Mode drag landed at (${r2.x}, ${r2.y})`).toBe(true);
        expect(await appEventCount(page, "button:clicked"), "a Design-Mode drag ran the button").toBe(1);
      } finally {
        await setDesignMode(page, false).catch(() => undefined);
        await endClean(page);
      }
    });
  });
}

test.describe("a chart's quick-access button acts on release (worksheet)", () => {
  test("16 (worksheet): a drag from a SELECTED chart's quick-access button leaves the chart where it was and opens nothing; a click opens its popup", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await writeTable(page, [
        ["Month", "Units"],
        ["Jan", 10],
        ["Feb", 40],
        ["Mar", 20],
        ["Apr", 30],
      ]);
      const sheetId = (await invoke<{ sheets: Array<{ sheetId?: string }> }>(page, "get_sheets")).sheets[0].sheetId;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, ...(sheetId ? { sheetId } : {}), startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: "Buttons",
      };
      const C = { x: 320, y: 48, width: 384, height: 256 };
      const res = await callModule<{ chart: { chartId: string } | null; refusal: string | null }>(page, MOD.CHART_STORE, "createChartLanded", [
        spec,
        { sheetIndex: 0, ...C, name: "Buttons" },
      ]);
      expect(res.chart, `the chart was refused: ${res.refusal}`).toBeTruthy();
      const cid = res.chart!.chartId;
      await callModule(page, MOD.CHART_STORE, "syncChartRegions", []);
      await eventually(() => chartData(page, cid).then((d) => d !== null), (v) => v, "the chart never painted", 15_000);
      const regionId = `chart-${cid}`;
      const persisted = async () => {
        const c = (await persistedCharts(page)).find((x) => x.id === cid);
        if (!c) throw new Error(`the backend holds no chart ${cid}`);
        return c;
      };

      // Select it by its body: the quick-access buttons exist only then.
      await click(page, await clientOf(page, C.x + C.width / 2, C.y + 12));
      await eventually(() => objectOf(page, regionId), (o) => o.selected, "a body click did not select the chart");
      const qa = await eventually(
        () => chartQuickAccessPoint(page, cid, "elements"),
        (p) => p !== null,
        "the selected chart painted no quick-access buttons",
      );
      expect(await cursorAt(page, qa!), "the quick-access button does not show its hand").toBe("pointer");
      const before = await persisted();

      // ---- A drag from the button to 80 px away: nothing moves, nothing opens.
      const geo = await readGridGeometry(page);
      await drag(page, qa!, { x: qa!.x + 80 * geo.zoom, y: qa!.y + 16 * geo.zoom });
      await page.waitForTimeout(600);
      const after = await persisted();
      expect({ x: after.x, y: after.y }, "a drag from the quick-access button MOVED the chart (the button is frame again)").toEqual({
        x: before.x,
        y: before.y,
      });
      expect(await activeQuickAccessPopup(page), "a drag off the quick-access button opened its popup").toBeNull();
      await expect(page.getByText("Chart Elements", { exact: true }), "a drag off the button put the popup in the DOM").toHaveCount(0);

      // ---- A click on it: the popup opens.
      await eventually(() => objectOf(page, regionId), (o) => o.selected, "precondition: the chart is still selected");
      const qa2 = await eventually(() => chartQuickAccessPoint(page, cid, "elements"), (p) => p !== null, "the buttons are gone");
      await click(page, qa2!);
      await eventually(
        () => activeQuickAccessPopup(page),
        (p) => p?.chartId === cid && p.buttonType === "elements",
        "a click on the button opened no popup",
      );
      await expect(page.getByText("Chart Elements", { exact: true }), "the popup is not in the DOM").toBeVisible();
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 17, 18, 20, 23. Phase 5a: the six-dot GRIP (core/lib/floatingGrip.ts)
// ---------------------------------------------------------------------------

/** The grip's ink while its object is only HOVERED (core/lib/floatingHandleMetrics.ts FLOATING_GRIP_HOVER_INK #605E5C), as RGB. */
const GRIP_INK_RGB = [0x60, 0x5e, 0x5c] as const;

/**
 * How many pixels of a sample are a GRIP's colours: the hover ink #605E5C (a
 * grip shown because its object is hovered -- a white plate with a grey border
 * and grey dots) or Core's selection blue #0e639c (a SELECTED object's grip --
 * a blue plate with white dots).
 */
function gripPixels(s: PixelSample): number {
  let n = 0;
  for (let i = 0; i + 2 < s.data.length; i += 4) {
    const r = s.data[i];
    const g = s.data[i + 1];
    const b = s.data[i + 2];
    const ink = Math.abs(r - GRIP_INK_RGB[0]) <= 16 && Math.abs(g - GRIP_INK_RGB[1]) <= 16 && Math.abs(b - GRIP_INK_RGB[2]) <= 16;
    const blue = Math.abs(r - CHROME_RGB[0]) <= 24 && Math.abs(g - CHROME_RGB[1]) <= 24 && Math.abs(b - CHROME_RGB[2]) <= 24;
    if (ink || blue) n++;
  }
  return n;
}

/** A grip's painted PLATE (20 x 14 SCREEN px, centred in its 24 x 24 hit square), as a client clip. */
function plateClip(g: { centre: { x: number; y: number } }): PixelClip {
  return { x: g.centre.x - 10, y: g.centre.y - 7, width: 20, height: 14 };
}

/** Grip-coloured pixels in a client clip, from ONE fresh UNCLIPPED capture (a clipped one can photograph the frame before the hover repaint). */
async function gripPixelsIn(page: Page, clip: PixelClip): Promise<number> {
  const [s] = await samplePixelGrids(page, [clip]);
  return gripPixels(s);
}

/** Grip-coloured pixels on the plate of `regionId`'s grip -- where the product's own geometry puts it, shown or not. */
async function gripPixelsOf(page: Page, regionId: string): Promise<number> {
  return gripPixelsIn(page, plateClip(await gripRect(page, regionId)));
}

/**
 * Hover an object's BODY the way a hand does (its hover grip shows only once
 * the object is Core's hovered object), then, with `ontoGrip`, go straight from
 * just inside the edge the grip sits on onto the grip -- never through a cell,
 * which would end the hover. Returns the grip as measured before the moves.
 * (Every object here is wide enough for the grip to sit over its own edge.)
 */
async function hoverBodyThen(page: Page, regionId: string, ontoGrip: boolean): Promise<GripRect> {
  const g = await gripRect(page, regionId);
  const edgeY = g.placement === "above" ? g.y + g.height : g.y;
  const inward = g.placement === "above" ? 1 : -1;
  await page.mouse.move(g.centre.x, edgeY + inward * 30, { steps: 4 });
  await eventually(() => hoveredRegionId(page), (id) => id === regionId, `hovering ${regionId}'s body did not make it Core's hovered object`);
  if (ontoGrip) {
    await page.mouse.move(g.centre.x, edgeY + inward * 4, { steps: 3 });
    await page.mouse.move(g.centre.x, g.centre.y, { steps: 4 });
    await page.waitForTimeout(250);
  }
  return g;
}

/** Hide a slicer's header through the product's own store and wait for its region to ask for a hover grip. */
async function headerlessSlicer(page: Page, sid: string): Promise<string> {
  expect(await callModule(page, MOD.SLICER_STORE, "updateSlicerAsync", [sid, { showHeader: false }]), "hiding the slicer's header was refused").toBeTruthy();
  const region = SLICER_REGION(sid);
  await eventually(() => gripRect(page, region), (g) => g.flag === "hover", "a header-less slicer does not ask Core for a hover grip");
  return region;
}

test.describe("phase 5a: the six-dot grip of a header-less slicer (worksheet)", () => {
  test("17-18 (worksheet): a header-less slicer shows no grip until hovered; it stays as the pointer goes up onto it and goes when the pointer leaves the grid or the grid scrolls; dragging it moves the slicer by exactly the drag as ONE undo step; a click on it is one gripClick", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      // Clear of the data (A1:C7) and the pivot (E1:F8): nothing else is painted
      // where the grip's plate goes, so a grip-coloured pixel there is the grip's.
      const sid = await createSlicer(page, pid, sheet.index, 640, 256);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 6, "the slicer never listed the six products", 15_000);
      const region = await headerlessSlicer(page, sid);
      expect(
        await callModule<number>(page, MOD.SLICER_RENDERER, "getMaxScrollOffset", [sid]),
        "precondition: the header-less slicer does not scroll (a wheel over it must scroll the GRID)",
      ).toBe(0);

      // ---- 17. No grip while idle.
      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, region), (o) => !o.selected, "precondition: the slicer is not selected");
      await park(page, 30, 110);
      const idle = await gripRect(page, region);
      expect(idle.placement, "a slicer at sheet y 256 has room above it").toBe("above");
      expect(idle.shown, "the product shows the grip of an idle, unselected header-less slicer").toBe(false);
      expect(await gripPixelsOf(page, region), "an idle header-less slicer shows grip pixels above its top-left").toBe(0);

      // Hovered: the grip shows.
      await hoverBodyThen(page, region, false);
      await eventually(() => gripPixelsOf(page, region), (n) => n > 10, "a HOVERED header-less slicer shows no grip pixels above its top-left");

      // From the body straight up onto the grip: still shown, and its pointer is 'move'.
      await hoverBodyThen(page, region, true);
      expect(await hoveredRegionId(page), "moving from the body up onto the grip ended the hover").toBe(region);
      expect(await gripPixelsOf(page, region), "moving from the body up onto the grip hid it").toBeGreaterThan(10);
      expect(await cursorAt(page, idle.centre), "the grip's pointer").toBe("move");

      // Out of the grid in ONE move -- no mousemove reaches the grid on the way,
      // so only the grid area's mouseleave can say the pointer left.
      const ribbon = await ribbonPointAbove(page, idle.centre.x);
      await page.mouse.move(ribbon.x, ribbon.y);
      await eventually(
        () => hoveredRegionId(page),
        (id) => id === null,
        "the pointer LEFT the grid and the slicer is still Core's hovered object (no mouseleave)",
      );
      await eventually(() => gripPixelsOf(page, region), (n) => n === 0, "the grip stayed after the pointer left the grid");

      // Hovered again, then the grid scrolls under the STILL pointer: gone.
      await hoverBodyThen(page, region, false);
      await eventually(() => gripPixelsOf(page, region), (n) => n > 10, "hovering the slicer again showed no grip");
      const scrollY0 = (await readGridGeometry(page)).scrollY;
      await page.mouse.wheel(0, 120);
      await eventually(async () => (await readGridGeometry(page)).scrollY, (y) => y > scrollY0, "the wheel over the slicer did not scroll the grid");
      await page.waitForTimeout(300);
      expect(await hoveredRegionId(page), "the grid scrolled under the pointer and the slicer is still Core's hovered object").toBeNull();
      expect(await gripPixelsOf(page, region), "the grip stayed after the grid scrolled under the pointer").toBe(0);
      // Back to the top, wheeling over a cell of column A.
      const scrolled = await readGridGeometry(page);
      const cellA = await clientOf(page, 30, scrolled.scrollY + 100);
      await page.mouse.move(cellA.x, cellA.y, { steps: 3 });
      await page.mouse.wheel(0, -5000);
      await eventually(async () => (await readGridGeometry(page)).scrollY, (y) => y === 0, "the grid did not scroll back to the top");

      // ---- 18. Drag the grip by (+64, +32): the slicer moves by exactly that, as ONE undo step, its filter untouched.
      const before = await slicerRow(page, sid);
      const depth0 = (await undoState(page)).undoDepth;
      await startWindowEventCounter(page, "floatingObject:gripClick");
      const g0 = await hoverBodyThen(page, region, true);
      expect(await gripPixelsOf(page, region), "precondition: the grip shows under the pointer").toBeGreaterThan(10);
      const geo = await readGridGeometry(page);
      await drag(page, g0.centre, { x: g0.centre.x + 64 * geo.zoom, y: g0.centre.y + 32 * geo.zoom });
      const moved = await eventually(
        () => slicerRow(page, sid),
        (s) => s.x !== before.x || s.y !== before.y,
        "dragging the grip did not move the slicer",
      );
      expect(
        { x: moved.x, y: moved.y },
        `the grip drag did not move the slicer by exactly (+64, +32): (${before.x}, ${before.y}) -> (${moved.x}, ${moved.y})`,
      ).toEqual({ x: before.x + 64, y: before.y + 32 });
      expect({ width: moved.width, height: moved.height }, "the grip drag resized the slicer").toEqual({ width: before.width, height: before.height });
      expect(moved.selectedItems, "the grip drag filtered the slicer (the press on the grip acted as an item press)").toEqual(before.selectedItems);
      await eventually(async () => (await undoState(page)).undoDepth, (d) => d === depth0 + 1, "the grip drag is not ONE undo step");
      expect(await windowEventCount(page, "floatingObject:gripClick"), "a DRAG of the grip was taken for a click").toBe(0);
      await eventually(() => objectOf(page, region), (o) => o.selected, "the press on the grip did not select the slicer");

      // A CLICK on the grip (no move): exactly one floatingObject:gripClick; nothing moves, filters or records.
      await park(page, 30, 110);
      const g1 = await eventually(
        () => gripRect(page, region),
        (g) => near(g.x, g0.x + 64 * geo.zoom) && g.shown,
        "the moved, SELECTED slicer shows no grip where its new place puts it",
      );
      await eventually(() => gripPixelsOf(page, region), (n) => n > 10, "a SELECTED header-less slicer paints no grip");
      await click(page, g1.centre);
      await eventually(
        () => windowEventCount(page, "floatingObject:gripClick"),
        (n) => n === 1,
        "a click on the grip dispatched no floatingObject:gripClick",
      );
      await page.waitForTimeout(400);
      expect(await windowEventCount(page, "floatingObject:gripClick"), "one click on the grip dispatched more than one gripClick").toBe(1);
      const still = await slicerRow(page, sid);
      expect(
        { x: still.x, y: still.y, selectedItems: still.selectedItems },
        "a click on the grip moved or filtered the slicer",
      ).toEqual({ x: moved.x, y: moved.y, selectedItems: before.selectedItems });
      expect((await undoState(page)).undoDepth, "a click on the grip recorded an undo step").toBe(depth0 + 1);
    } finally {
      await endClean(page);
    }
  });
});

test.describe("phase 5a: no room above, the grip goes below (worksheet)", () => {
  test("20 (worksheet): a header-less slicer at sheet y = 0 shows its grip BELOW its bottom edge on hover, and nothing above it", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      // At the very top of the sheet, right of the pivot (E1:F8).
      const sid = await createSlicer(page, pid, sheet.index, 576, 0);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 6, "the slicer never listed the six products", 15_000);
      const region = await headerlessSlicer(page, sid);
      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, region), (o) => !o.selected, "precondition: the slicer is not selected");
      await park(page, 30, 110);

      const s = await slicerRow(page, sid);
      expect(s.y, "precondition: the slicer sits at the sheet's top edge").toBe(0);
      const idle = await gripRect(page, region);
      expect(idle.placement, "a slicer at sheet y 0 has no room above: its grip must sit BELOW it").toBe("below");
      const bottom = await clientOf(page, s.x, s.y + s.height);
      expect(near(idle.y, bottom.y, 1), `the grip's square does not start at the slicer's bottom edge (${idle.y} vs ${bottom.y})`).toBe(true);
      // Where an "above" grip's plate would be: across the top edge, in the
      // column-header band (the hit square is 24 SCREEN px at any zoom, so its
      // centre is 12 client px above the edge).
      const top = await clientOf(page, s.x, s.y);
      const aboveClip: PixelClip = { x: idle.centre.x - 10, y: top.y - 12 - 7, width: 20, height: 14 };
      const aboveIdle = await gripPixelsIn(page, aboveClip);
      expect(await gripPixelsOf(page, region), "an idle header-less slicer shows grip pixels below it").toBe(0);

      await hoverBodyThen(page, region, false);
      await eventually(
        () => gripPixelsOf(page, region),
        (n) => n > 10,
        "a HOVERED header-less slicer at the sheet's top edge shows no grip pixels BELOW its bottom edge",
      );
      expect(await gripPixelsIn(page, aboveClip), "hovering the slicer painted grip pixels ABOVE it").toBeLessThanOrEqual(aboveIdle);
      // ...and the grip below is grabbable: from the body down onto it, the pointer says 'move'.
      await hoverBodyThen(page, region, true);
      expect(await cursorAt(page, idle.centre), "the grip below the slicer is not grabbable").toBe("move");
    } finally {
      await endClean(page);
    }
  });
});

test.describe("phase 5a: the grip on the other header-less objects (worksheet)", () => {
  test("23 (worksheet): a title-less floating grid and a header-less timeline each show no grip while idle, and the grip on hover", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      // The header-less timeline, below the data (A1:C7) and the pivot (E1:F8).
      const tid = await createTimeline(page, pid, sheet.index, 96, 288);
      expect(
        await callModule(page, MOD.TIMELINE_STORE, "updateTimelineAsync", [tid, { showHeader: false }]),
        "hiding the timeline's header was refused",
      ).toBeTruthy();
      // The title-less floating grid, right of the pivot: 4 rows x 3 columns,
      // through the @api wrapper (the product's route, which repaints).
      const FR_API = "/src/api/floatingRanges.ts";
      const fr = await callModule<{ id: string }>(page, FR_API, "createFloatingRange", [640, 256, "GripGrid"]);
      await callModule(page, FR_API, "updateFloatingRange", [fr.id, { showTitle: false, rowCount: 4, colCount: 3 }]);

      const objs = [
        { name: "the header-less timeline", region: TL_REGION(tid) },
        { name: "the title-less floating grid", region: `fr-${fr.id}` },
      ];
      for (const o of objs) {
        await eventually(() => gripRect(page, o.region), (g) => g.flag === "hover", `${o.name} does not ask Core for a hover grip`);
      }
      await deselectAll(page, "worksheet", sheet);
      for (const o of objs) {
        await eventually(() => objectOf(page, o.region), (x) => !x.selected, `precondition: ${o.name} is not selected`);
        await park(page, 30, 110);
        const idle = await gripRect(page, o.region);
        expect(idle.placement, `${o.name} has room above it`).toBe("above");
        expect(await gripPixelsOf(page, o.region), `${o.name} shows grip pixels while idle`).toBe(0);
        await hoverBodyThen(page, o.region, false);
        await eventually(() => gripPixelsOf(page, o.region), (n) => n > 10, `${o.name}, HOVERED, shows no grip`);
        await hoverBodyThen(page, o.region, true);
        expect(await cursorAt(page, idle.centre), `${o.name}'s grip is not grabbable`).toBe("move");
      }
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// 19, 21, 22. Phase 5b: the grip's MENU and Size and Position
// (extensions/BuiltIn/ObjectPosition; @api/objectPosition)
// ---------------------------------------------------------------------------

/** The label every object menu and the grip's menu carry ("Size and Position..."). */
const SIZE_POS_LABEL = "Size and Position...";

/** The grip's menu (extensions/BuiltIn/ObjectPosition/components/GripMenu.tsx). */
const gripMenu = (page: Page) => page.locator("[data-object-grip-menu]");

/** Its rows' text, in order. */
async function gripMenuRows(page: Page): Promise<string[]> {
  return gripMenu(page).locator('[role="menuitem"]').allTextContents();
}

/** The Size and Position dialog (components/SizePositionDialog.tsx). */
const sizePosDialog = (page: Page) => page.locator("[data-size-position-dialog]");

/** A right-click the way a hand makes one (press, hold, release the secondary button). */
async function rightClickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(60);
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(350);
}

/**
 * How many RENDERED elements read exactly "Size and Position..." -- the row,
 * in whichever family's menu is open (each family paints its own menu, so the
 * text is the one thing they share).
 */
async function sizePosRowsShown(page: Page): Promise<number> {
  return page.evaluate((label) => {
    let n = 0;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length > 0 || (el.textContent ?? "").trim() !== label) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) n++;
    }
    return n;
  }, SIZE_POS_LABEL);
}

/** A ribbon control by test id, opening the band's launchers when its section is folded. */
async function ribbonControl(page: Page, testId: string) {
  const el = page.locator(`[data-testid="${testId}"]`).first();
  if (!(await el.isVisible().catch(() => false))) {
    const launchers = page.locator("[data-ribbon-content] button[aria-haspopup]");
    const n = await launchers.count();
    for (let i = 0; i < n && !(await el.isVisible().catch(() => false)); i++) {
      await launchers.nth(i).click().catch(() => undefined);
      await page.waitForTimeout(250);
      if (!(await el.isVisible().catch(() => false))) await page.keyboard.press("Escape");
    }
  }
  return el;
}

/** A bar chart of Sales by Product over Sheet1!A1:C7 (the TL_DATA table). */
async function salesChart(page: Page, sheetIndex: number, C: { x: number; y: number; width: number; height: number }, title: string): Promise<string> {
  const sheetId = (await invoke<{ sheets: Array<{ sheetId?: string }> }>(page, "get_sheets")).sheets[0].sheetId;
  return createChart(
    page,
    {
      mark: "bar",
      data: { sheetIndex: 0, ...(sheetId ? { sheetId } : {}), startRow: 0, startCol: 0, endRow: 6, endCol: 2 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 1,
      series: [{ sourceIndex: 2, name: "Sales", color: "#4472C4" }],
      title,
    },
    { sheetIndex, ...C, name: title },
  );
}

test.describe("phase 5b: the grip's menu and Size and Position (worksheet)", () => {
  test("19 (worksheet): a click on a header-less slicer's grip opens a menu led by 'Size and Position...'; X 480, Y 256 and OK move the slicer exactly there as ONE undo step; one Ctrl+Z puts it back", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "worksheet");
      const sid = await createSlicer(page, pid, sheet.index, 640, 224);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 6, "the slicer never listed the six products", 15_000);
      const region = await headerlessSlicer(page, sid);
      await deselectAll(page, "worksheet", sheet);
      await eventually(() => objectOf(page, region), (o) => !o.selected, "precondition: the slicer is not selected");
      await park(page, 30, 110);
      const before = await slicerRow(page, sid);
      expect({ x: before.x, y: before.y }, "precondition: the slicer landed where it was asked").toEqual({ x: 640, y: 224 });
      const depth0 = (await undoState(page)).undoDepth;

      // ---- A click on the grip: the menu, led by Size and Position.
      const g = await hoverBodyThen(page, region, true);
      await click(page, g.centre);
      await expect(gripMenu(page), "a click on the grip opened no menu").toBeVisible();
      const rows = await gripMenuRows(page);
      expect(rows[0], `the grip's menu is not led by Size and Position: ${JSON.stringify(rows)}`).toBe(SIZE_POS_LABEL);
      expect(await gripMenu(page).getAttribute("data-object-grip-menu"), "the menu is for another object").toBe(region);
      // The menu sits at the grip: its top edge just under the grip's hit square.
      const box = (await gripMenu(page).boundingBox())!;
      expect(near(box.x, g.x, 4) && near(box.y, g.y + g.height + 2, 4), `the menu is not anchored at the grip (${box.x},${box.y} vs ${g.x},${g.y + g.height})`).toBe(true);

      // ---- Size and Position: X 480, Y 256, OK.
      await gripMenu(page).locator('[role="menuitem"]').first().click();
      await expect(gripMenu(page), "choosing a row left the menu open").toHaveCount(0);
      await expect(sizePosDialog(page), "Size and Position opened no dialog").toBeVisible();
      const xBox = page.locator('[data-testid="size-position-x"]');
      await expect(xBox, "the dialog does not start at the slicer's x").toHaveValue(String(before.x));
      await expect(page.locator('[data-testid="size-position-y"]')).toHaveValue(String(before.y));
      await xBox.fill("480");
      await page.locator('[data-testid="size-position-y"]').fill("256");
      expect((await undoState(page)).undoDepth, "typing in a box wrote something before OK").toBe(depth0);
      await page.locator('[data-testid="size-position-ok"]').click();
      await expect(sizePosDialog(page), "OK did not close the dialog").toHaveCount(0);

      const moved = await eventually(() => slicerRow(page, sid), (s) => s.x !== before.x || s.y !== before.y, "OK did not move the slicer");
      expect({ x: moved.x, y: moved.y }, "the slicer is not where X and Y said").toEqual({ x: 480, y: 256 });
      expect({ width: moved.width, height: moved.height }, "Size and Position resized the slicer").toEqual({ width: before.width, height: before.height });
      expect(moved.selectedItems, "Size and Position filtered the slicer").toEqual(before.selectedItems);
      await eventually(async () => (await undoState(page)).undoDepth, (d) => d === depth0 + 1, "Size and Position is not ONE undo step");
      await eventually(() => objectOf(page, region), (o) => o.x === 480 && o.y === 256, "the published region did not follow the move");

      // ---- One Ctrl+Z puts it back.
      await pressUndo(page);
      await eventually(
        () => slicerRow(page, sid),
        (s) => s.x === before.x && s.y === before.y,
        "one Ctrl+Z did not put the slicer back where it was",
      );
    } finally {
      await endClean(page);
    }
  });
});

test.describe("phase 5b: the grip of a SELECTED canvas object, and its menu (canvas)", () => {
  test("21 (canvas): a selected titled chart shows its grip; the grip's menu lists Bring Forward, Send Backward and Lock; Lock locks it -- padlock on, grip gone, no 'move' there. On a worksheet a selected titled chart shows no grip", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await writeTable(page, TL_DATA);

      // ---- Worksheet control (owner decision 3): a SELECTED titled chart has no grip.
      const W = { x: 320, y: 224, width: 384, height: 224 };
      const wsCid = await salesChart(page, 0, W, "Worksheet");
      const wsRegion = `chart-${wsCid}`;
      await deselectAll(page, "worksheet", { pageWidth: Number.POSITIVE_INFINITY, pageHeight: Number.POSITIVE_INFINITY });
      await park(page, 30, 110);
      const wsIdle = await gripPixelsOf(page, wsRegion);
      await click(page, await clientOf(page, W.x + W.width / 2, W.y + W.height / 2));
      await eventually(() => objectOf(page, wsRegion), (o) => o.selected, "a body click did not select the worksheet chart");
      await park(page, 30, 110);
      expect((await gripRect(page, wsRegion)).shown, "the product shows a grip on a selected titled WORKSHEET chart").toBe(false);
      expect(await gripPixelsOf(page, wsRegion), "a selected titled worksheet chart paints a grip").toBeLessThanOrEqual(wsIdle);

      // ---- The canvas.
      const sheet = await objectSheet(page, "canvas");
      const C = { x: 64, y: 96, width: 384, height: 224 };
      const cid = await salesChart(page, sheet.index, C, "Canvas");
      const region = `chart-${cid}`;
      const parkAt = { sx: Math.min(sheet.pageWidth - 40, 900), sy: Math.min(sheet.pageHeight - 40, 460) };
      await park(page, parkAt.sx, parkAt.sy);
      await eventually(() => objectOf(page, region), (o) => !o.selected, "precondition: the canvas chart is not selected");
      const g0 = await gripRect(page, region);
      expect(g0.placement, "a chart at page y 96 has room above").toBe("above");
      const idle = await gripPixelsOf(page, region);

      await click(page, await clientOf(page, C.x + C.width / 2, C.y + C.height / 2));
      await eventually(() => objectOf(page, region), (o) => o.selected, "a body click did not select the canvas chart");
      await park(page, parkAt.sx, parkAt.sy);
      await eventually(() => gripRect(page, region), (g) => g.shown, "the product shows no grip on the SELECTED canvas chart");
      await eventually(() => gripPixelsOf(page, region), (n) => n > idle + 10, "a SELECTED canvas chart paints no grip above its top-left");

      // The padlock place, inside the top-right corner (CanvasSheet lib/selectionChrome.ts paintLockMarks).
      const lockX = C.x + C.width - 6 - 12 - 4;
      const padlockPatch = () => chromeIn(page, lockX + 1, C.y + 10 + 6, 10, 6);
      const padlock0 = await padlockPatch();

      // ---- The grip's menu: Size and Position, then the page's verbs.
      const g = await gripRect(page, region);
      await click(page, g.centre);
      await expect(gripMenu(page), "a click on the selected chart's grip opened no menu").toBeVisible();
      expect(await gripMenuRows(page)).toEqual([SIZE_POS_LABEL, "Bring Forward", "Send Backward", "Lock"]);
      await gripMenu(page).locator('[data-grip-menu-item="canvas.grip.lock"]').click();
      await expect(gripMenu(page)).toHaveCount(0);

      // ---- Locked: in the layout, the padlock shows, the grip is gone and promises no move.
      await eventually(() => lockedOn(page, sheet.index), (l) => l.includes(`chart:${cid}`), "the grip menu's Lock did not lock the chart");
      await eventually(() => objectOf(page, region), (o) => o.selected, "locking deselected the chart");
      await park(page, parkAt.sx, parkAt.sy);
      await eventually(padlockPatch, (n) => n > padlock0, "the LOCKED chart shows no padlock");
      expect((await gripRect(page, region)).shown, "the product still shows a grip on a LOCKED chart").toBe(false);
      await eventually(() => gripPixelsOf(page, region), (n) => n <= idle, "a LOCKED chart still paints its grip");
      expect(await cursorAt(page, g.centre), "the former grip still promises a move").not.toBe("move");

      // ---- The LOCKED chart's own menu still offers Size and Position: read-only, saying why.
      await rightClickAt(page, await clientOf(page, C.x + C.width / 2, C.y + C.height / 2));
      const row = page.locator('[data-chart-menu-item="sizeAndPosition"]');
      await expect(row, "the locked chart's menu carries no Size and Position").toBeVisible();
      await row.click();
      await expect(sizePosDialog(page), "Size and Position opened no dialog for the locked chart").toBeVisible();
      await expect(page.locator('[data-testid="size-position-x"]'), "a LOCKED chart's dialog is editable").toBeDisabled();
      await expect(page.locator('[data-testid="size-position-reason"]'), "the dialog does not say the chart is locked").toContainText("locked");
      await expect(page.locator('[data-testid="size-position-ok"]'), "a LOCKED chart's dialog offers OK").toHaveCount(0);
      await page.locator('[data-testid="size-position-close"]').click();
      await expect(sizePosDialog(page)).toHaveCount(0);
    } finally {
      await endClean(page);
    }
  });
});

for (const surface of ["worksheet", "canvas"] as const) {
  test.describe(`phase 5b: Size and Position in every object's menu (${surface})`, () => {
    test(`22 (${surface}): the right-click menus of the slicer, timeline, chart, shape and floating grid${surface === "canvas" ? ", and the pivot box," : ""} each carry 'Size and Position...'${surface === "canvas" ? "; Canvas > Arrange's Size & Position is enabled with a selection and disabled without" : ""}`, async ({
      appPage: page,
    }) => {
      test.setTimeout(300_000);
      try {
        await newFile(page);
        const pid = await seedPivot(page);
        const sheet = await objectSheet(page, surface);
        // Two rows of objects, clear of the data and the pivot on a worksheet.
        const base = surface === "worksheet" ? { x: 128, y: 192 } : { x: 64, y: 64 };
        const at = (dx: number, dy: number) => ({ x: base.x + dx, y: base.y + dy });

        const S = { ...at(0, 0), width: 160, height: 144 };
        const sid = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
          {
            name: "Product_menu",
            sheetIndex: sheet.index,
            ...S,
            sourceType: "pivot",
            cacheSourceId: pid,
            fieldName: "Product",
            connectedSources: [{ sourceType: "pivot", sourceId: pid }],
          },
        ]).then((s) => s!.id);
        const T = { ...at(192, 0), width: 400, height: 144 };
        const tid = await createTimeline(page, pid, sheet.index, T.x, T.y, T.width);
        const Ch = { ...at(624, 0), width: 320, height: 144 };
        await salesChart(page, sheet.index, Ch, "Menu");
        const Sh = { ...at(0, 176), width: 160, height: 96 };
        const shape = await createShape(page, { sheetIndex: sheet.index, ...Sh });
        const FR_API = "/src/api/floatingRanges.ts";
        const F = at(192, 176);
        const fr = await callModule<{ id: string }>(page, FR_API, "createFloatingRange", [F.x, F.y, "MenuGrid"]);
        await callModule(page, FR_API, "updateFloatingRange", [fr.id, { rowCount: 4, colCount: 3 }]);
        const B = { ...at(624, 176), width: 288, height: 160 };
        if (surface === "canvas") {
          await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
            {
              sourceRange: "Sheet1!A1:C7",
              destinationCell: "A1",
              sourceSheet: 0,
              destinationSheet: sheet.index,
              hasHeaders: true,
              name: "MenuBox",
              canvasFrame: { ...B, frozenHeaders: true },
            },
          ]);
          // The raw create publishes nothing by itself: the Create PivotTable
          // dialog announces "pivot:refresh" after its create (CreatePivotDialog
          // .tsx), and step 14 only got its box because configurePivot refreshes.
          // Do what the user's path does (run 10, 2026-10-01: "never published").
          await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
        }

        const targets: Array<{ name: string; region: () => Promise<string>; point: { sx: number; sy: number } }> = [
          { name: "the slicer", region: async () => SLICER_REGION(sid), point: { sx: S.x + S.width / 2, sy: S.y + 12 } },
          { name: "the timeline", region: async () => TL_REGION(tid), point: { sx: T.x + 40, sy: T.y + 12 } },
          {
            name: "the chart",
            region: async () => (await objects(page)).find((o) => o.type === "chart")!.id,
            point: { sx: Ch.x + Ch.width / 2, sy: Ch.y + Ch.height / 2 },
          },
          { name: "the shape", region: async () => shape.instanceId, point: { sx: Sh.x + Sh.width / 2, sy: Sh.y + Sh.height / 2 } },
          { name: "the floating grid", region: async () => `fr-${fr.id}`, point: { sx: F.x + 24, sy: F.y + 8 } },
        ];
        if (surface === "canvas") {
          targets.push({
            name: "the pivot box",
            region: async () => (await objects(page)).find((o) => o.type === "pivot-visual")!.id,
            point: { sx: B.x + 40, sy: B.y + 40 },
          });
        }
        for (const t of targets) {
          await eventually(
            async () => (await objects(page)).map((o) => o.id).includes(await t.region().catch(() => "")),
            (v) => v,
            `${t.name} was never published`,
            15_000,
          );
        }
        await page.waitForTimeout(500);

        for (const t of targets) {
          await deselectAll(page, surface, sheet);
          expect(await sizePosRowsShown(page), `a menu was still open before ${t.name}'s right-click`).toBe(0);
          await rightClickAt(page, await clientOf(page, t.point.sx, t.point.sy));
          await eventually(() => sizePosRowsShown(page), (n) => n === 1, `${t.name}'s right-click menu carries no "${SIZE_POS_LABEL}"`);
          // Close it: Escape for the menus that own it, a press outside for the rest.
          await page.keyboard.press("Escape");
          await deselectAll(page, surface, sheet);
          await eventually(() => sizePosRowsShown(page), (n) => n === 0, `${t.name}'s menu did not close`);
        }

        if (surface === "canvas") {
          // ---- Canvas > Arrange > Size & Position: enabled with a selection, disabled without.
          await deselectAll(page, surface, sheet);
          await openCanvasTab(page);
          const button = await ribbonControl(page, "canvas-arrange-size-position");
          await expect(button, "Size & Position is enabled with nothing selected").toBeDisabled();
          await click(page, await clientOf(page, Sh.x + Sh.width / 2, Sh.y + Sh.height / 2));
          await eventually(() => objectOf(page, shape.instanceId), (o) => o.selected, "a body click did not select the shape");
          await openCanvasTab(page);
          const enabled = await ribbonControl(page, "canvas-arrange-size-position");
          await expect(enabled, "Size & Position is disabled with the shape selected").toBeEnabled();
          await enabled.click();
          await expect(sizePosDialog(page), "Arrange's Size & Position opened no dialog").toBeVisible();
          await expect(page.locator('[data-testid="size-position-x"]'), "the dialog is not the selected shape's").toHaveValue(String(Sh.x));
          await page.locator('[data-testid="size-position-cancel"]').click();
          await expect(sizePosDialog(page)).toHaveCount(0);
        }
      } finally {
        await endClean(page);
      }
    });
  });
}
