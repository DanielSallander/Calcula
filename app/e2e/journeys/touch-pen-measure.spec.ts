/**
 * TOUCH AND PEN, MEASURED -- plan_M8 S10 (Task D); BUG-0258 design phase 6.
 *
 * WHAT THIS IS: A MEASUREMENT, NOT A PROOF. The approved design (2026-09-29) calls
 * phase 6 "keyboard and touch (later; large)", and it rejected building touch in
 * the same programme ("it rewrites Core's input handling"). Until this journey,
 * every statement about touch was BELIEVED from reading the code:
 *   - app/src/core has no pointer or touch handler, and the grid's doors are
 *     mouse events only (Spreadsheet.tsx:1583-1590: onMouseDown / onMouseMove /
 *     onMouseUp / onContextMenu on the grid area);
 *   - nothing in the grid scrolls natively (overflow: hidden,
 *     Spreadsheet.styles.ts:15, :29, :43);
 *   - Chromium sends compatibility MOUSE events for a touch TAP, and a
 *     contextmenu for a long-press, but none for a touch DRAG;
 *   - a pen arrives mouse-like.
 * This journey drives each gesture three times, with the MOUSE (the control),
 * a PEN and a FINGER, all through the same CDP driver (e2e/helpers/touch.ts).
 * For each one it records what reached the page and what the product did. The
 * run itself is the measurement, published three ways:
 *   - every test attaches its rows to the report (markdown and JSON);
 *   - every test writes e2e/results/touch-pen-measure/<test>.json, overwriting
 *     only its own file;
 *   - the file's afterAll composes e2e/results/touch-pen-measure/TABLE.md.
 *     A test that did not run this time shows there as STALE.
 * Task E and the touch milestone read that table. Nothing here decides what
 * touch SHOULD do.
 *
 * THE GESTURES. One test per gesture and surface, every test title starting with
 * its id. Each gesture is measured with mouse, then pen, then touch, and each
 * measurement starts on a FRESH document (File > New and a new fixture), so one
 * input can never leave state for the next.
 *   TP-1  tap to select: the header of an UNSELECTED slicer.
 *   TP-2  drag to move: an unselected slicer by its header, (+64, +32).
 *   TP-3  resize handle: a SELECTED slicer's right-edge handle, +64.
 *   TP-4  grip: a SELECTED header-less slicer's six-dot grip, first dragged
 *         (+64, +32), then tapped.
 *   TP-5  slicer item tap: "Kiwis" on an unselected slicer.
 *   TP-6  timeline drag: February to May on an unselected timeline.
 *   TP-7  button tap: a run-mode floating button.
 *   TP-8  long-press, held 1 s: a timeline month, a slicer item, a slicer header.
 *   TP-9  cells (worksheet only): tap D10, drag D10 to G16, long-press D10.
 *   TP-10 button cell (worksheet only): a Cell Type: Button running
 *         cellTypes.clear, tapped, then long-pressed 1 s (the one claimed cell
 *         press held long enough to be left stuck; its mouse control has
 *         TEETH on Core's cell press).
 * TP-1 to TP-8 run on a worksheet AND on a canvas page: 18 tests, 27 gestures,
 * 81 measurements. Expect roughly ten minutes. Run it on its own with:
 *   npx playwright test --project=journey e2e/journeys/touch-pen-measure.spec.ts
 *
 * WHAT IS ASSERTED: only what must ALREADY hold, whatever the input.
 *   - HARD: the app is alive after every gesture. The spreadsheet is still
 *     mounted, and the page did not reload or navigate (a per-test mark on
 *     window survives). A touch drag that reached WebView2's swipe navigation
 *     would reload the app under every later test.
 *   - SOFT: once the finger, pen or mouse is lifted, NOTHING still holds the
 *     pointer:
 *       - no element holds pointer capture (the browser's implicit touch
 *         capture was released, and every gotpointercapture was matched);
 *       - none of the product's own press sessions is still armed. They are:
 *         Core's cell press, Core's floating move or resize, the
 *         content-gesture pointer, the floating-button press, the pivot
 *         chrome press, the chart-button press, the slicer item drag and the
 *         timeline range drag.
 *     These sessions ARE the app's pointer capture: window listeners held from
 *     the press until the release. A session still armed after the lift is a
 *     stuck pointer.
 *   - SOFT: every measurement was actually taken. A harness error shows red,
 *     never as a quiet gap in the table.
 *   - SOFT: the MOUSE CONTROL did what moving-objects.spec.ts,
 *     release-acts.spec.ts and object-keyboard.spec.ts prove it does. If it did
 *     not, the harness is broken for that gesture, and the gesture's pen and
 *     touch rows are not a measurement.
 *   - SOFT: PROBE TEETH. During the mouse control of a drag or a long hold, the
 *     press session that must be armed reads true while the button is still
 *     down. For the sessions with teeth -- Core's cell press (TP-10's
 *     long-press), Core's floating move/resize, the timeline range drag and
 *     the slicer item drag -- "nothing held after the lift" therefore comes
 *     from the live modules, not from a second, idle copy that would always
 *     answer false. The floating button, pivot chrome, chart button and
 *     content-gesture probes have no gesture here that proves them live
 *     (TP-7's tap is too short to sample): their "nothing held" is read, not
 *     proved.
 * Soft assertions let every gesture of a test be measured and published even
 * when one of them fails.
 * Everything else is RECORDED and never asserted: whether the touch drag moved
 * the slicer, whether the long-press opened a menu, whether anything scrolled.
 * There is deliberately no test.fail(). An expectation about touch would be a
 * belief, and this run exists to replace beliefs with facts.
 *
 * HOW THE INPUT IS MADE (e2e/helpers/touch.ts).
 *   - Mouse and pen use `Input.dispatchMouseEvent` with `pointerType`. They hover
 *     in from 3 px away, press, and are held 60 ms for a tap or 1 s for a
 *     long-press. A drag moves in 12 steps of 16 ms, stays still 60 ms, then
 *     lifts.
 *   - A finger uses `Input.dispatchTouchEvent` (touchStart / touchMove /
 *     touchEnd) with the same timing. It has no hover.
 *   - Before each measurement the MOUSE is parked off the grid. A real touch
 *     user's mouse is not hovering the object either.
 *
 * CAVEATS FOR WHOEVER READS THE TABLE.
 *   - CDP touch goes through Chromium's TouchEmulator gesture detector, not
 *     through the WM_POINTER input and Aura gesture recognizer that a real
 *     Windows touch screen uses. Tap and long-press timeouts and the touch slop
 *     can differ slightly. A real device is the next measurement.
 *   - Touch points have radius 1 (CDP's default), so Chromium's touch
 *     ADJUSTMENT, which snaps a fat finger to a nearby clickable node, is not
 *     exercised. The 44 px target question belongs to the later milestone.
 *   - Touch emulation is NOT switched on (Emulation.setTouchEmulationEnabled).
 *     The app never reads maxTouchPoints, ontouchstart or a pointer media query
 *     (checked 2026-10-01, app/src + app/extensions), so what the device
 *     advertises changes nothing the app does. The environment block records
 *     what this machine advertises.
 *   - The CDP pen is Chromium's mouse-like pen: pointerType "pen", pressure 0.5
 *     in contact, and hover while in range. The barrel button, the eraser and
 *     tilt are not exercised.
 *   - The input recorder listens PASSIVELY on window in the capture phase and
 *     never cancels an event. React already listens for pointer and touch
 *     events at its root, so the recorder does not change which touches reach
 *     the page.
 *
 * SABOTAGE. This step changes no product file (plan_M8 S10), so there is no
 * product sabotage to restore. Its guards have teeth checked INSIDE the run:
 * the mouse CONTROL row of every gesture proves the driver, the points and the
 * fixture, and PROBE TEETH prove the held-pointer probes read the live
 * modules. The instrument itself has a unit tier,
 * e2e/__tests__/touchInstrument.test.ts (vitest, no app). It pins the driver's
 * CDP calls, including the lift that must happen when a gesture throws. It runs
 * the recorder against jsdom's real events, pins that a blind probe throws
 * instead of reading "nothing held", and checks the table. Each of its guards
 * was sabotaged red when it was written. To watch the stuck-pointer guard bite live (optional, for the main
 * loop): delete `window.addEventListener("mouseup", onSessionUp);` in
 * app/extensions/Slicer/lib/slicerItemDrag.ts:254. TP-5's mouse and pen rows
 * (and its touch row, if the tap's compatibility events reach the slicer) must
 * go red on "... the product still held the pointer (a stuck pointer)" naming
 * "slicer item drag" (and the CONTROL must fail too: the filter never commits).
 * The journey's app loads the frontend from the Vite dev server, so a
 * TypeScript sabotage needs no Rust build. Restore the file byte-identical
 * afterwards.
 *
 * SHARED APP. Every measurement starts with the app's own File > New (the
 * file-api route, never a raw `new_file`: BUG-0205), and every test ends with
 * one.
 *
 * LOCALE. sv-SE. No formula is typed here.
 */
import type { Page } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  callModule,
  cellAt,
  configurePivot,
  createRangePivot,
  eventually,
  installAppImport,
  invoke,
  newFile,
  rcToRef,
  undoState,
  writeTable,
} from "../helpers/pivot-live";
import { controlsOn, gridBox, objects, patchActiveCanvas, type Obj } from "../helpers/canvas-live";
import { periodPoint, timelineRange } from "../helpers/timelines";
import { slicerItemPoint, slicerItemValues, slicerRow } from "../helpers/slicers";
import { appEventCount, createFloatingButton, setDesignMode, startAppEventCounter } from "../helpers/objectButtons";
import { gripRect, startWindowEventCounter, windowEventCount } from "../helpers/objectGrip";
import {
  POINTER_INPUTS,
  PointerDriver,
  composeMeasurementTable,
  heldAfterLift,
  heldPointers,
  markPage,
  openMenus,
  pageAlive,
  readInputLog,
  renderEnvironment,
  renderMeasureTable,
  settleLanding,
  startInputLog,
  stopInputLog,
  summariseEvents,
  targetAt,
  touchEnvironment,
  writeMeasurement,
  type ClientPoint,
  type MeasureRow,
  type PointerInput,
  type TouchEnvironment,
  type WhileHeld,
} from "../helpers/touch";

// ---------------------------------------------------------------------------
// Where the measurement goes
// ---------------------------------------------------------------------------

/** e2e/results/touch-pen-measure (git-ignored, and outside Vite's watch). */
const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results", "touch-pen-measure");

/** After the lift, before reading: a touch tap's compatibility events can wait out the double-tap timeout (~300 ms). */
const SETTLE_MS = 800;

// ---------------------------------------------------------------------------
// Data and fixtures (the moving-objects.spec.ts set-ups)
// ---------------------------------------------------------------------------

type Surface = "worksheet" | "canvas";
const BOTH: readonly Surface[] = ["worksheet", "canvas"];
const WORKSHEET: readonly Surface[] = ["worksheet"];

/** Date / Product / Sales: one product per month, January to June 2026 (TEXT dates). */
const TL_DATA: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Pears", 2],
  ["'2026-03-03", "Plums", 4],
  ["'2026-04-12", "Kiwis", 8],
  ["'2026-05-20", "Figs", 16],
  ["'2026-06-08", "Limes", 32],
];

/** A harness precondition: throws (the measurement's row then says NOT MEASURED, and the soft check goes red). */
function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`precondition: ${what}`);
}

interface Sheet {
  index: number;
  pageWidth: number;
  pageHeight: number;
}

/** Sheet1: the data, and a pivot at E1 (Product rows, Sum of Sales). Sheet1 must be active. */
async function seedPivot(page: Page): Promise<string> {
  await writeTable(page, TL_DATA);
  need((await cellAt(page, 0, 1, 0))?.type === "text", "the dates are text");
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C7", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, {
    pivotId: pid,
    rowFields: [{ sourceIndex: 1, name: "Product" }],
    valueFields: [{ sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" }],
  });
  return pid;
}

/**
 * The sheet the objects go on: Sheet1 itself, or a new canvas whose page fits
 * the window (snap stays on at 16 px, so every position and delta here is a
 * multiple of 16).
 */
async function objectSheet(page: Page, surface: Surface): Promise<Sheet> {
  if (surface === "worksheet") return { index: 0, pageWidth: Number.POSITIVE_INFINITY, pageHeight: Number.POSITIVE_INFINITY };
  const canvas = await addCanvas(page);
  const box = await gridBox(page);
  const pageWidth = Math.min(1280, Math.floor((box.width - 32) / 16) * 16);
  const pageHeight = Math.min(720, Math.floor((box.height - 32) / 16) * 16);
  await patchActiveCanvas(page, { pagePreset: "custom", pageWidth, pageHeight });
  return { index: canvas.index, pageWidth, pageHeight };
}

/** A fresh document: File > New, the pivot when asked, and the sheet the objects go on. */
async function freshDocument(page: Page, surface: Surface, withPivot: boolean): Promise<{ sheet: Sheet; pid: string }> {
  await newFile(page);
  const pid = withPivot ? await seedPivot(page) : "";
  const sheet = await objectSheet(page, surface);
  return { sheet, pid };
}

/** Where a test's objects go (sheet px): right of the pivot (E1:F8) and below the data on a worksheet. */
function origin(surface: Surface): { x: number; y: number } {
  return surface === "worksheet" ? { x: 448, y: 192 } : { x: 64, y: 64 };
}

/** A slicer on the pivot's Product field, 160 x 176. */
async function createSlicer(page: Page, pid: string, sheetIndex: number, x: number, y: number): Promise<string> {
  const s = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: `Product_${x}_${y}`,
      sheetIndex,
      x,
      y,
      width: 160,
      height: 176,
      sourceType: "pivot",
      cacheSourceId: pid,
      fieldName: "Product",
      connectedSources: [{ sourceType: "pivot", sourceId: pid }],
    },
  ]);
  need(s !== null && typeof s?.id === "string", "a slicer was created on the pivot's Product field");
  await eventually(() => slicerItemValues(page, s!.id), (v) => v.length === 6, "the slicer never listed the six products", 15_000);
  await page.waitForTimeout(300);
  return s!.id;
}

/** A months timeline on the pivot's Date field, 416 x 144. */
async function createTimeline(page: Page, pid: string, sheetIndex: number, x: number, y: number): Promise<string> {
  const tl = await callModule<{ id: string } | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
    { name: `Date_${x}_${y}`, sheetIndex, x, y, width: 416, height: 144, sourceId: pid, fieldName: "Date", level: "months" },
  ]);
  need(tl !== null && typeof tl?.id === "string", "a timeline was created on the pivot's Date field");
  await eventually(
    () => callModule<{ periods: unknown[] } | undefined>(page, MOD.TIMELINE_STORE, "getCachedTimelineData", [tl!.id]),
    (d) => (d?.periods.length ?? 0) === 6,
    "the timeline never listed January to June",
    15_000,
  );
  await page.waitForTimeout(300);
  return tl!.id;
}

const SLICER_REGION = (sid: string): string => `slicer-${sid}`;
const TL_REGION = (tid: string): string => `timeline-slicer-${tid}`;

/** The published object of a region, with its selection state. */
async function objectOf(page: Page, regionId: string): Promise<Obj> {
  const o = (await objects(page)).find((x) => x.id === regionId);
  if (!o) throw new Error(`no published object ${regionId}`);
  return o;
}

/** The CLIENT point of a sheet-px point on the active sheet. */
async function clientOf(page: Page, sx: number, sy: number): Promise<ClientPoint> {
  const geo = await readGridGeometry(page);
  const box = await gridBox(page);
  return { x: box.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom, y: box.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom };
}

/** The CLIENT centre of a cell (GridHelper answers relative to the grid canvas). */
async function cellPoint(page: Page, grid: GridHelper, ref: string): Promise<ClientPoint> {
  const local = await grid.cellCenter(ref);
  const box = await gridBox(page);
  return { x: box.x + local.x, y: box.y + local.y };
}

/** `p` moved by (dx, dy) SHEET px at the live zoom. */
async function offsetBy(page: Page, p: ClientPoint, dx: number, dy: number): Promise<ClientPoint> {
  const zoom = (await readGridGeometry(page)).zoom;
  return { x: p.x + dx * zoom, y: p.y + dy * zoom };
}

/** Select exactly this object through the product's own selection API (`@api/objectSelection` selectObject). */
async function selectOnly(page: Page, regionId: string): Promise<void> {
  await installAppImport(page);
  const ok = await page.evaluate(
    async ({ regionId, ov, os }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
      const overlays = (await w.__appImport(ov)) as { getGridRegions: () => Array<{ id: string }> };
      const sel = (await w.__appImport(os)) as { selectObject: (r: unknown) => boolean };
      const r = overlays.getGridRegions().find((x) => x.id === regionId);
      return r ? sel.selectObject(r) : false;
    },
    { regionId, ov: "/src/api/gridOverlays.ts", os: "/src/api/objectSelection.ts" },
  );
  need(ok, `${regionId} could be selected through @api/objectSelection`);
  await eventually(() => objectOf(page, regionId), (o) => o.selected, `precondition: ${regionId} is not selected`);
  await page.waitForTimeout(200);
}

/** Deselect every object through the product's own selection API (`clearObjectSelection`). */
async function deselectEverything(page: Page): Promise<void> {
  await callModule(page, "/src/api/objectSelection.ts", "clearObjectSelection", []);
  await eventually(() => objects(page), (os) => os.every((o) => !o.selected), "precondition: some object is still selected");
  await page.waitForTimeout(150);
}

/** A client point OFF the grid area, where the mouse is parked between measurements. */
async function neutralPoint(page: Page): Promise<ClientPoint> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]") as HTMLElement | null;
    const candidates: Array<{ x: number; y: number }> = [{ x: 2, y: 2 }];
    if (band) {
      const b = band.getBoundingClientRect();
      candidates.push({ x: b.left + 4, y: b.top + 4 });
    }
    for (const c of candidates) {
      const el = document.elementFromPoint(c.x, c.y);
      if (el && !el.closest("[data-grid-area]")) return c;
    }
    return candidates[0];
  });
}

async function cellTypeAt(page: Page, row: number, col: number): Promise<string | null> {
  const all = await invoke<Array<{ row: number; col: number; typeId: string }>>(page, "get_all_cell_types", { sheetIndex: 0 });
  return all.find((c) => c.row === row && c.col === col)?.typeId ?? null;
}

// ---------------------------------------------------------------------------
// The world around a gesture (the same reads for every gesture)
// ---------------------------------------------------------------------------

interface World {
  gridScroll: { x: number; y: number };
  pageScroll: { x: number; y: number };
  /** visualViewport.scale (a pinch or a double-tap zoom changes it). */
  zoom: number;
  /** "D10" or "D10:G16"; null when the grid has none. */
  cellSelection: string | null;
  undoDepth: number;
  selectedObjects: string[];
  menus: string[];
}

async function world(page: Page): Promise<World> {
  const dom = await page.evaluate(() => {
    type GridState = {
      selection?: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
      viewport?: { scrollX?: number; scrollY?: number };
    };
    const gs = (window as unknown as { __CALCULA_GRID_STATE__?: GridState }).__CALCULA_GRID_STATE__;
    const s = gs?.selection ?? null;
    return {
      gridScroll: { x: gs?.viewport?.scrollX ?? 0, y: gs?.viewport?.scrollY ?? 0 },
      pageScroll: { x: window.scrollX, y: window.scrollY },
      zoom: window.visualViewport?.scale ?? 1,
      selection: s ? { r0: Math.min(s.startRow, s.endRow), c0: Math.min(s.startCol, s.endCol), r1: Math.max(s.startRow, s.endRow), c1: Math.max(s.startCol, s.endCol) } : null,
    };
  });
  const sel = dom.selection;
  const cellSelection =
    sel === null ? null : sel.r0 === sel.r1 && sel.c0 === sel.c1 ? rcToRef(sel.r0, sel.c0) : `${rcToRef(sel.r0, sel.c0)}:${rcToRef(sel.r1, sel.c1)}`;
  return {
    gridScroll: dom.gridScroll,
    pageScroll: dom.pageScroll,
    zoom: dom.zoom,
    cellSelection,
    undoDepth: (await undoState(page)).undoDepth,
    selectedObjects: (await objects(page)).filter((o) => o.selected).map((o) => o.id),
    menus: await openMenus(page),
  };
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${Math.round(n)}`;
const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol;

/** What changed around the gesture, in words (object selection is the gesture's own business). */
function worldChanges(b: World, a: World): string[] {
  const out: string[] = [];
  const gx = a.gridScroll.x - b.gridScroll.x;
  const gy = a.gridScroll.y - b.gridScroll.y;
  if (gx !== 0 || gy !== 0) out.push(`the grid scrolled (${signed(gx)}, ${signed(gy)})`);
  const px = a.pageScroll.x - b.pageScroll.x;
  const py = a.pageScroll.y - b.pageScroll.y;
  if (px !== 0 || py !== 0) out.push(`the PAGE scrolled (${signed(px)}, ${signed(py)})`);
  if (a.zoom !== b.zoom) out.push(`page zoom ${b.zoom} -> ${a.zoom}`);
  if (a.cellSelection !== b.cellSelection) out.push(`cell selection ${b.cellSelection ?? "none"} -> ${a.cellSelection ?? "none"}`);
  if (a.undoDepth !== b.undoDepth) out.push(`undo depth ${signed(a.undoDepth - b.undoDepth)}`);
  const opened = a.menus.filter((m) => !b.menus.includes(m));
  if (opened.length > 0) out.push(`menu open: ${opened.join(", ")}`);
  return out;
}

/** Close whatever menu the gesture opened (the menus own Escape). */
async function closeMenus(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if ((await openMenus(page)).length === 0) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

// ---------------------------------------------------------------------------
// A gesture
// ---------------------------------------------------------------------------

interface ControlInput<F> {
  before: F;
  after: F;
  worldBefore: World;
  worldAfter: World;
}

interface Gesture<C, F> {
  /** The table's name for it. */
  name: string;
  /** A fresh fixture (File > New first). */
  setup(page: Page, surface: Surface, grid: GridHelper): Promise<C>;
  /** Where the gesture starts, in CLIENT px, from the product's own geometry. */
  from(page: Page, ctx: C): Promise<ClientPoint>;
  /** Make the gesture with `input`; `whileHeld` samples what is armed before the lift (drags and long holds only). */
  perform(page: Page, driver: PointerDriver, input: PointerInput, from: ClientPoint, ctx: C, whileHeld: WhileHeld): Promise<void>;
  /** The gesture's own object, read from the backend and the live stores. */
  read(page: Page, ctx: C): Promise<F>;
  /** What happened to that object, in words ([] = nothing). */
  effect(before: F, after: F): string[];
  /** The MOUSE control's known outcome: null when it held, else what went wrong. */
  control(m: ControlInput<F>): string | null;
  /** The press session that must read true while the MOUSE control is still down (PROBE TEETH). */
  teeth?: string;
}

type AnyGesture = Gesture<unknown, unknown>;
const gesture = <C, F>(g: Gesture<C, F>): AnyGesture => g as unknown as AnyGesture;

// ---- Slicers -------------------------------------------------------------

interface SlicerCtx {
  sid: string;
  region: string;
}

interface SlicerFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The committed filter; null = every item. */
  items: string[] | null;
  selected: boolean;
}

/** A fresh document with one slicer at the surface's origin -- unselected, or selected, header-less on request. */
async function slicerFixture(page: Page, surface: Surface, opts: { select?: boolean; headerless?: boolean } = {}): Promise<SlicerCtx> {
  const { sheet, pid } = await freshDocument(page, surface, true);
  const at = origin(surface);
  const sid = await createSlicer(page, pid, sheet.index, at.x, at.y);
  const region = SLICER_REGION(sid);
  if (opts.headerless) {
    need(
      Boolean(await callModule(page, MOD.SLICER_STORE, "updateSlicerAsync", [sid, { showHeader: false }])),
      "hiding the slicer's header was accepted",
    );
    await eventually(() => gripRect(page, region), (g) => g.flag === "hover", "precondition: a header-less slicer asks Core for a hover grip");
  }
  if (opts.select) await selectOnly(page, region);
  else await deselectEverything(page);
  return { sid, region };
}

async function readSlicer(page: Page, sid: string): Promise<SlicerFacts> {
  const s = await slicerRow(page, sid);
  return {
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    items: s.selectedItems,
    selected: (await objectOf(page, SLICER_REGION(sid))).selected,
  };
}

const itemsText = (items: string[] | null): string => (items === null ? "all" : `[${items.join(", ")}]`);
const sameItems = (a: string[] | null, b: string[] | null): boolean => JSON.stringify(a) === JSON.stringify(b);

function slicerEffect(b: SlicerFacts, a: SlicerFacts): string[] {
  const out: string[] = [];
  if (a.x !== b.x || a.y !== b.y) out.push(`moved (${signed(a.x - b.x)}, ${signed(a.y - b.y)})`);
  if (a.width !== b.width || a.height !== b.height) out.push(`resized (${signed(a.width - b.width)}, ${signed(a.height - b.height)})`);
  if (!sameItems(b.items, a.items)) out.push(`filter ${itemsText(b.items)} -> ${itemsText(a.items)}`);
  if (a.selected !== b.selected) out.push(a.selected ? "selected" : "deselected");
  return out;
}

/** The middle of a header-ful slicer's header (frame), in CLIENT px. */
async function slicerHeaderPoint(page: Page, sid: string): Promise<ClientPoint> {
  const s = await slicerRow(page, sid);
  return clientOf(page, s.x + s.width / 2, s.y + 10);
}

const tapSlicerHeader = gesture<SlicerCtx, SlicerFacts>({
  name: "tap an UNSELECTED slicer's header",
  setup: (page, surface) => slicerFixture(page, surface),
  from: (page, c) => slicerHeaderPoint(page, c.sid),
  perform: (_page, d, input, from) => d.tap(input, from),
  read: (page, c) => readSlicer(page, c.sid),
  effect: slicerEffect,
  control: ({ before, after }) => {
    if (!after.selected) return "a click on an unselected slicer's header did not select it";
    if (after.x !== before.x || after.y !== before.y) return "a click on the header moved the slicer";
    if (!sameItems(before.items, after.items)) return "a click on the header changed the filter";
    return null;
  },
});

const dragSlicerHeader = gesture<SlicerCtx, SlicerFacts>({
  name: "drag an unselected slicer by its header (+64, +32)",
  setup: (page, surface) => slicerFixture(page, surface),
  from: (page, c) => slicerHeaderPoint(page, c.sid),
  perform: async (page, d, input, from, _c, whileHeld) => d.drag(input, from, await offsetBy(page, from, 64, 32), { whileHeld }),
  read: (page, c) => readSlicer(page, c.sid),
  effect: slicerEffect,
  control: ({ before, after }) =>
    near(after.x, before.x + 64) && near(after.y, before.y + 32) && after.width === before.width && after.height === before.height
      ? null
      : `the header drag did not move the slicer by exactly (+64, +32): (${before.x}, ${before.y}) -> (${after.x}, ${after.y})`,
  teeth: "Core floating move/resize",
});

const resizeSlicer = gesture<SlicerCtx, SlicerFacts>({
  name: "drag a SELECTED slicer's right-edge handle (+64)",
  setup: (page, surface) => slicerFixture(page, surface, { select: true }),
  from: async (page, c) => {
    const s = await slicerRow(page, c.sid);
    return clientOf(page, s.x + s.width, s.y + s.height / 2);
  },
  perform: async (page, d, input, from, _c, whileHeld) => d.drag(input, from, await offsetBy(page, from, 64, 0), { whileHeld }),
  read: (page, c) => readSlicer(page, c.sid),
  effect: slicerEffect,
  control: ({ before, after }) =>
    near(after.width, before.width + 64) && after.height === before.height && after.x === before.x && after.y === before.y
      ? null
      : `the right-edge handle did not widen the slicer by exactly 64 and nothing else: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  teeth: "Core floating move/resize",
});

interface GripFacts extends SlicerFacts {
  gripClicks: number;
}

async function gripFixture(page: Page, surface: Surface): Promise<SlicerCtx> {
  const c = await slicerFixture(page, surface, { select: true, headerless: true });
  await eventually(() => gripRect(page, c.region), (g) => g.shown, "precondition: the SELECTED header-less slicer shows its grip");
  await startWindowEventCounter(page, "floatingObject:gripClick");
  return c;
}

async function readGrip(page: Page, c: SlicerCtx): Promise<GripFacts> {
  return { ...(await readSlicer(page, c.sid)), gripClicks: await windowEventCount(page, "floatingObject:gripClick") };
}

function gripEffect(b: GripFacts, a: GripFacts): string[] {
  const out = slicerEffect(b, a);
  if (a.gripClicks !== b.gripClicks) out.push(`floatingObject:gripClick x${a.gripClicks - b.gripClicks}`);
  return out;
}

const dragGrip = gesture<SlicerCtx, GripFacts>({
  name: "drag a SELECTED header-less slicer's grip (+64, +32)",
  setup: gripFixture,
  from: async (page, c) => (await gripRect(page, c.region)).centre,
  perform: async (page, d, input, from, _c, whileHeld) => d.drag(input, from, await offsetBy(page, from, 64, 32), { whileHeld }),
  read: readGrip,
  effect: gripEffect,
  control: ({ before, after }) => {
    if (!(near(after.x, before.x + 64) && near(after.y, before.y + 32))) {
      return `the grip drag did not move the slicer by (+64, +32): (${before.x}, ${before.y}) -> (${after.x}, ${after.y})`;
    }
    if (after.gripClicks !== before.gripClicks) return "a DRAG of the grip was taken for a click";
    if (!sameItems(before.items, after.items)) return "the grip drag filtered the slicer";
    return null;
  },
  teeth: "Core floating move/resize",
});

const tapGrip = gesture<SlicerCtx, GripFacts>({
  name: "tap a SELECTED header-less slicer's grip",
  setup: gripFixture,
  from: async (page, c) => (await gripRect(page, c.region)).centre,
  perform: (_page, d, input, from) => d.tap(input, from),
  read: readGrip,
  effect: gripEffect,
  control: ({ before, after, worldAfter }) => {
    if (after.gripClicks - before.gripClicks !== 1) return `a click on the grip dispatched ${after.gripClicks - before.gripClicks} floatingObject:gripClick, not 1`;
    if (!worldAfter.menus.includes("grip menu")) return `a click on the grip opened no grip menu (open: ${worldAfter.menus.join(", ") || "none"})`;
    if (after.x !== before.x || after.y !== before.y) return "a click on the grip moved the slicer";
    return null;
  },
});

const tapSlicerItem = gesture<SlicerCtx, SlicerFacts>({
  name: "tap the item 'Kiwis' of an UNSELECTED slicer",
  setup: (page, surface) => slicerFixture(page, surface),
  from: (page, c) => slicerItemPoint(page, c.sid, "Kiwis"),
  perform: (_page, d, input, from) => d.tap(input, from),
  read: (page, c) => readSlicer(page, c.sid),
  effect: slicerEffect,
  control: ({ before, after }) => {
    if (!sameItems(after.items, ["Kiwis"])) return `a click on 'Kiwis' left the filter at ${itemsText(after.items)}`;
    if (after.x !== before.x || after.y !== before.y) return "a click on an item moved the slicer";
    return null;
  },
});

// ---- Timelines -----------------------------------------------------------

interface TimelineCtx {
  tid: string;
  region: string;
  /** Where a range drag ends (the May period), in CLIENT px. */
  to: ClientPoint;
}

interface TimelineFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  /** "yyyy-mm..yyyy-mm", or "all". */
  range: string;
  selected: boolean;
}

async function readTimeline(page: Page, tid: string): Promise<TimelineFacts> {
  const all = await invoke<Array<{ id: string; x: number; y: number; width: number; height: number }>>(page, "get_all_timeline_slicers");
  const t = all.find((r) => r.id === tid);
  if (!t) throw new Error(`the backend holds no timeline ${tid}`);
  return {
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    range: await timelineRange(page, tid),
    selected: (await objectOf(page, TL_REGION(tid))).selected,
  };
}

function timelineEffect(b: TimelineFacts, a: TimelineFacts): string[] {
  const out: string[] = [];
  if (a.x !== b.x || a.y !== b.y) out.push(`moved (${signed(a.x - b.x)}, ${signed(a.y - b.y)})`);
  if (a.width !== b.width || a.height !== b.height) out.push(`resized (${signed(a.width - b.width)}, ${signed(a.height - b.height)})`);
  if (a.range !== b.range) out.push(`range ${b.range} -> ${a.range}`);
  if (a.selected !== b.selected) out.push(a.selected ? "selected" : "deselected");
  return out;
}

const dragTimelineRange = gesture<TimelineCtx, TimelineFacts>({
  name: "drag February to May on an UNSELECTED timeline",
  setup: async (page, surface) => {
    const { sheet, pid } = await freshDocument(page, surface, true);
    const at = origin(surface);
    const tid = await createTimeline(page, pid, sheet.index, at.x, at.y);
    await deselectEverything(page);
    return { tid, region: TL_REGION(tid), to: await periodPoint(page, tid, "2026-05") };
  },
  from: (page, c) => periodPoint(page, c.tid, "2026-02"),
  perform: (_page, d, input, from, c, whileHeld) => d.drag(input, from, c.to, { whileHeld }),
  read: (page, c) => readTimeline(page, c.tid),
  effect: timelineEffect,
  control: ({ before, after }) => {
    if (after.range !== "2026-02..2026-05") return `the drag from February to May selected ${after.range}`;
    if (after.x !== before.x || after.y !== before.y) return "the range drag MOVED the timeline (BUG-0258)";
    return null;
  },
  teeth: "timeline range drag",
});

// ---- A run-mode floating button ------------------------------------------

interface ButtonCtx {
  sheetIndex: number;
  centre: { sx: number; sy: number };
}

interface ButtonFacts {
  x: number;
  y: number;
  /** `button:clicked` app events since the fixture was made. */
  ran: number;
}

const tapFloatingButton = gesture<ButtonCtx, ButtonFacts>({
  name: "tap a run-mode floating button",
  setup: async (page, surface) => {
    const { sheet } = await freshDocument(page, surface, false);
    const at = origin(surface);
    const B = { x: at.x, y: at.y, width: 160, height: 48 };
    await setDesignMode(page, false);
    const made = await createFloatingButton(page, { sheetIndex: sheet.index, ...B, label: "Press me" });
    await eventually(() => objects(page), (os) => os.some((o) => o.id === made.instanceId), "the button was never published", 15_000);
    await deselectEverything(page);
    await startAppEventCounter(page, "button:clicked");
    return { sheetIndex: sheet.index, centre: { sx: B.x + B.width / 2, sy: B.y + B.height / 2 } };
  },
  from: (page, c) => clientOf(page, c.centre.sx, c.centre.sy),
  perform: (_page, d, input, from) => d.tap(input, from),
  read: async (page, c) => {
    const r = (await controlsOn(page, c.sheetIndex)).find((x) => x.type === "button");
    if (!r) throw new Error("the backend holds no button");
    return { x: r.x, y: r.y, ran: await appEventCount(page, "button:clicked") };
  },
  effect: (b, a) => {
    const out: string[] = [];
    if (a.ran !== b.ran) out.push(`the button ran x${a.ran - b.ran}`);
    if (a.x !== b.x || a.y !== b.y) out.push(`moved (${signed(a.x - b.x)}, ${signed(a.y - b.y)})`);
    return out;
  },
  control: ({ before, after }) => {
    if (after.ran - before.ran !== 1) return `a click on the run-mode button ran it ${after.ran - before.ran} times, not once`;
    if (after.x !== before.x || after.y !== before.y) return "run mode: a click moved the button";
    return null;
  },
});

// ---- Long-press: a timeline month, a slicer item, a slicer header ---------

interface PairCtx {
  tid: string;
  sid: string;
}

interface PairFacts {
  timeline: TimelineFacts;
  slicer: SlicerFacts;
}

/** A timeline at the origin and a slicer below it, both unselected. */
async function pairFixture(page: Page, surface: Surface): Promise<PairCtx> {
  const { sheet, pid } = await freshDocument(page, surface, true);
  const at = origin(surface);
  const tid = await createTimeline(page, pid, sheet.index, at.x, at.y);
  const sid = await createSlicer(page, pid, sheet.index, at.x, at.y + 160);
  await deselectEverything(page);
  return { tid, sid };
}

async function readPair(page: Page, c: PairCtx): Promise<PairFacts> {
  return { timeline: await readTimeline(page, c.tid), slicer: await readSlicer(page, c.sid) };
}

function pairEffect(b: PairFacts, a: PairFacts): string[] {
  return [...timelineEffect(b.timeline, a.timeline).map((s) => `timeline ${s}`), ...slicerEffect(b.slicer, a.slicer).map((s) => `slicer ${s}`)];
}

const noMenu = (w: World): string | null => (w.menus.length > 0 ? `a left-button hold opened a menu: ${w.menus.join(", ")}` : null);

const longPressMonth = gesture<PairCtx, PairFacts>({
  name: "long-press (1 s) the timeline's March",
  setup: pairFixture,
  from: (page, c) => periodPoint(page, c.tid, "2026-03"),
  perform: (_page, d, input, from, _c, whileHeld) => d.longPress(input, from, { whileHeld }),
  read: readPair,
  effect: pairEffect,
  control: ({ after, worldAfter }) =>
    noMenu(worldAfter) ?? (after.timeline.range === "2026-03..2026-03" ? null : `a 1 s click on March selected ${after.timeline.range}`),
  teeth: "timeline range drag",
});

const longPressItem = gesture<PairCtx, PairFacts>({
  name: "long-press (1 s) the slicer item 'Kiwis'",
  setup: pairFixture,
  from: (page, c) => slicerItemPoint(page, c.sid, "Kiwis"),
  perform: (_page, d, input, from, _c, whileHeld) => d.longPress(input, from, { whileHeld }),
  read: readPair,
  effect: pairEffect,
  control: ({ after, worldAfter }) =>
    noMenu(worldAfter) ?? (sameItems(after.slicer.items, ["Kiwis"]) ? null : `a 1 s click on 'Kiwis' left the filter at ${itemsText(after.slicer.items)}`),
  teeth: "slicer item drag",
});

const longPressHeader = gesture<PairCtx, PairFacts>({
  name: "long-press (1 s) the slicer's header",
  setup: pairFixture,
  from: (page, c) => slicerHeaderPoint(page, c.sid),
  perform: (_page, d, input, from, _c, whileHeld) => d.longPress(input, from, { whileHeld }),
  read: readPair,
  effect: pairEffect,
  control: ({ before, after, worldAfter }) => {
    const menu = noMenu(worldAfter);
    if (menu) return menu;
    if (!after.slicer.selected) return "a 1 s click on the slicer's header did not select it";
    if (after.slicer.x !== before.slicer.x || after.slicer.y !== before.slicer.y) return "a 1 s click on the header moved the slicer";
    return null;
  },
});

// ---- Cells (worksheet) ----------------------------------------------------

interface CellCtx {
  grid: GridHelper;
}

/** Cells carry no object of their own: the world (selection, scroll, menus) is the whole story. */
type NoFacts = Record<string, never>;

async function cellFixture(page: Page, _surface: Surface, grid: GridHelper): Promise<CellCtx> {
  await newFile(page);
  return { grid };
}

const tapCell = gesture<CellCtx, NoFacts>({
  name: "tap the cell D10",
  setup: cellFixture,
  from: (page, c) => cellPoint(page, c.grid, "D10"),
  perform: (_page, d, input, from) => d.tap(input, from),
  read: async () => ({}),
  effect: () => [],
  control: ({ worldAfter }) => (worldAfter.cellSelection === "D10" ? null : `a click on D10 selected ${worldAfter.cellSelection ?? "nothing"}`),
});

const dragCells = gesture<CellCtx & { to: ClientPoint }, NoFacts>({
  name: "drag on the cells from D10 to G16",
  setup: async (page, surface, grid) => ({ ...(await cellFixture(page, surface, grid)), to: await cellPoint(page, grid, "G16") }),
  from: (page, c) => cellPoint(page, c.grid, "D10"),
  perform: (_page, d, input, from, c, whileHeld) => d.drag(input, from, c.to, { whileHeld }),
  read: async () => ({}),
  effect: () => [],
  control: ({ worldAfter }) =>
    worldAfter.cellSelection === "D10:G16" ? null : `a drag from D10 to G16 selected ${worldAfter.cellSelection ?? "nothing"}`,
});

const longPressCell = gesture<CellCtx, NoFacts>({
  name: "long-press (1 s) the cell D10",
  setup: cellFixture,
  from: (page, c) => cellPoint(page, c.grid, "D10"),
  perform: (_page, d, input, from, _c, whileHeld) => d.longPress(input, from, { whileHeld }),
  read: async () => ({}),
  effect: () => [],
  control: ({ worldAfter }) =>
    noMenu(worldAfter) ?? (worldAfter.cellSelection === "D10" ? null : `a 1 s click on D10 selected ${worldAfter.cellSelection ?? "nothing"}`),
});

// ---- A button cell (worksheet) ---------------------------------------------

const BUTTON_CELL = { row: 6, col: 3 };

/** The user's OWN button cell at D7 running `cellTypes.clear`, in run mode. */
async function buttonCellFixture(page: Page, _surface: Surface, grid: GridHelper): Promise<CellCtx> {
  await newFile(page);
  await setDesignMode(page, false);
  // `cellTypes.clear` clears the SELECTION's cell type -- the button's own,
  // since its press selects it: the observable that it ran (release-acts.spec.ts
  // RA-5).
  await callModule(page, "/src/api/cellTypes.ts", "setCellType", [
    BUTTON_CELL.row,
    BUTTON_CELL.col,
    "calcula.button",
    { label: "Clear me", action: { kind: "command", commandId: "cellTypes.clear" } },
  ]);
  await callModule(page, "/src/api/cellTypes.ts", "refreshCellTypeAssignments", []);
  await eventually(() => cellTypeAt(page, BUTTON_CELL.row, BUTTON_CELL.col), (t) => t === "calcula.button", "precondition: the button cell exists");
  await page.waitForTimeout(300);
  return { grid };
}

type ButtonCellFacts = { cellType: string | null };

const readButtonCell = async (page: Page): Promise<ButtonCellFacts> => ({ cellType: await cellTypeAt(page, BUTTON_CELL.row, BUTTON_CELL.col) });

const buttonCellEffect = (b: ButtonCellFacts, a: ButtonCellFacts): string[] =>
  a.cellType !== b.cellType ? [`the button ran (its cell type ${b.cellType ?? "none"} -> ${a.cellType ?? "none"})`] : [];

const tapButtonCell = gesture<CellCtx, ButtonCellFacts>({
  name: "tap a button cell (Cell Type: Button running cellTypes.clear) at D7",
  setup: buttonCellFixture,
  from: (page, c) => cellPoint(page, c.grid, rcToRef(BUTTON_CELL.row, BUTTON_CELL.col)),
  perform: (_page, d, input, from) => d.tap(input, from),
  read: readButtonCell,
  effect: buttonCellEffect,
  control: ({ after }) => (after.cellType !== "calcula.button" ? null : "a click on the button cell did not run its command"),
});

// THE ONE GESTURE WHERE A STUCK PRESS IS LIKELY. A button cell's press is held
// by Core's cell press session until its release. A pen or a finger whose
// compatibility mouseup never arrives would leave `isCellPressHeld()` true and
// the button drawn pressed -- and a tap closes too fast to show it, while TP-9's
// long-press is on an unclaimed cell, whose session closes at once. So this is
// measured held for 1 s, with TEETH: during the mouse control the Core cell
// press must read true while the button is still down, which proves the
// "nothing held after the lift" of every row reads the LIVE session.
const longPressButtonCell = gesture<CellCtx, ButtonCellFacts>({
  name: "long-press (1 s) a button cell (Cell Type: Button running cellTypes.clear) at D7",
  setup: buttonCellFixture,
  from: (page, c) => cellPoint(page, c.grid, rcToRef(BUTTON_CELL.row, BUTTON_CELL.col)),
  perform: (_page, d, input, from, _c, whileHeld) => d.longPress(input, from, { whileHeld }),
  read: readButtonCell,
  effect: buttonCellEffect,
  control: ({ after, worldAfter }) =>
    noMenu(worldAfter) ??
    (after.cellType !== "calcula.button" ? null : "a 1 s click on the button cell did not run its command at the release"),
  teeth: "Core cell press",
});

// ---------------------------------------------------------------------------
// One measurement
// ---------------------------------------------------------------------------

interface Measurement {
  row: MeasureRow;
  controlFailure: string | null;
  teethFailure: string | null;
}

async function measure(
  page: Page,
  grid: GridHelper,
  driver: PointerDriver,
  id: string,
  surface: Surface,
  g: AnyGesture,
  input: PointerInput,
): Promise<Measurement> {
  const row: MeasureRow = {
    id,
    surface,
    gesture: g.name,
    input,
    target: "",
    happened: "",
    events: "",
    heldMidGesture: "(not sampled)",
    heldAfter: [],
    captureAfter: [],
    pageErrors: [],
    notes: [],
    facts: {},
    error: null,
    measuredAt: new Date().toISOString(),
  };
  let controlFailure: string | null = null;
  let teethFailure: string | null = null;
  const errors: string[] = [];
  const onPageError = (e: Error): void => {
    errors.push(String(e?.message ?? e).slice(0, 300));
  };
  page.on("pageerror", onPageError);
  try {
    // A press session an EARLIER measurement left armed was already reported
    // there; Escape (every session owns it) ends it so it cannot be blamed on
    // this gesture too.
    if ((await heldPointers(page)).length > 0) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    const ctx = await g.setup(page, surface, grid);
    await driver.park(await neutralPoint(page));
    await page.waitForTimeout(150);
    const from = await g.from(page, ctx);
    const target = await targetAt(page, from);
    row.target = `${target.element}; touch-action ${target.touchAction}`;
    need(
      target.onGrid,
      `the gesture's start point (${Math.round(from.x)}, ${Math.round(from.y)}) is on the grid area -- it is over ${target.element} (is the window too small for this fixture?)`,
    );
    const worldBefore = await world(page);
    const before = await g.read(page, ctx);
    const heldBefore = await heldPointers(page);
    if (heldBefore.length > 0) {
      row.notes.push(`already armed BEFORE the gesture (an earlier stuck pointer, not counted against this one): ${heldBefore.join(", ")}`);
    }

    await startInputLog(page);
    // A property, not a `let`: TypeScript does not see an assignment made inside a callback.
    const sample: { held: string[] | null } = { held: null };
    await g.perform(page, driver, input, from, ctx, async () => {
      sample.held = await heldPointers(page);
    });
    await page.waitForTimeout(SETTLE_MS);
    const landing = await settleLanding(page);
    if (landing.length > 0) row.notes.push(`still landing after 10 s: ${landing.join(", ")}`);
    row.heldAfter = (await heldAfterLift(page)).filter((h) => !heldBefore.includes(h));
    const log = await readInputLog(page);
    row.events = summariseEvents(log);
    row.captureAfter = log.capture.stillCaptured;
    const worldAfter = await world(page);
    const after = await g.read(page, ctx);

    const mid = sample.held;
    row.heldMidGesture = mid === null ? "(not sampled)" : mid.length > 0 ? mid.join(", ") : "nothing armed";
    const changes = [...g.effect(before, after), ...worldChanges(worldBefore, worldAfter)];
    row.happened = changes.length > 0 ? changes.join("; ") : "nothing";
    row.facts = { before, after, worldBefore, worldAfter, log };

    if (input === "mouse") {
      controlFailure = g.control({ before, after, worldBefore, worldAfter });
      if (controlFailure) row.notes.push(`CONTROL FAILED: ${controlFailure}`);
      if (g.teeth !== undefined && !(mid ?? []).includes(g.teeth)) {
        teethFailure =
          `while the mouse was still down, "${g.teeth}" did not read true (armed then: ${mid === null ? "not sampled" : mid.join(", ") || "nothing"}) -- ` +
          "the stuck-pointer probe may be reading a second, idle copy of its module, and its 'nothing held after the lift' would then be worthless";
        row.notes.push(`PROBE TEETH FAILED: ${teethFailure}`);
      }
    }
  } catch (e) {
    row.error = String(e instanceof Error ? e.message : e).slice(0, 600);
  } finally {
    page.off("pageerror", onPageError);
    row.pageErrors = errors;
    await driver.releaseAll().catch(() => undefined);
    await closeMenus(page).catch(() => undefined);
    await stopInputLog(page).catch(() => undefined);
  }
  return { row, controlFailure, teethFailure };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function publish(rows: MeasureRow[], env: TouchEnvironment | null): Promise<void> {
  const info = test.info();
  const file = { title: info.title, measuredAt: new Date().toISOString(), env, rows };
  const md = `# ${info.title}\n\n${renderEnvironment(env)}\n\n${renderMeasureTable(rows)}\n`;
  await info.attach("touch-pen measurement.md", { body: md, contentType: "text/markdown" }).catch(() => undefined);
  await info.attach("touch-pen measurement.json", { body: JSON.stringify(file, null, 2), contentType: "application/json" }).catch(() => undefined);
  try {
    const written = writeMeasurement(RESULTS_DIR, file);
    console.log(`\n[touch-pen] ${info.title}\n${renderMeasureTable(rows)}\n[touch-pen] rows written to ${written}\n`);
  } catch (e) {
    console.log(`[touch-pen] could not write the rows of "${info.title}": ${String(e)}`);
  }
}

test.afterAll(() => {
  try {
    const table = composeMeasurementTable(RESULTS_DIR);
    if (table !== null) console.log(`[touch-pen] the whole table: ${path.join(RESULTS_DIR, "TABLE.md")}`);
  } catch (e) {
    console.log(`[touch-pen] could not compose the table: ${String(e)}`);
  }
});

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

interface MeasureTest {
  id: string;
  title: string;
  surfaces: readonly Surface[];
  gestures: readonly AnyGesture[];
}

const TESTS: readonly MeasureTest[] = [
  { id: "TP-1", title: "tap to select: the header of an UNSELECTED slicer", surfaces: BOTH, gestures: [tapSlicerHeader] },
  { id: "TP-2", title: "drag to move: an unselected slicer by its header, (+64, +32)", surfaces: BOTH, gestures: [dragSlicerHeader] },
  { id: "TP-3", title: "resize handle: a SELECTED slicer's right-edge handle, +64", surfaces: BOTH, gestures: [resizeSlicer] },
  { id: "TP-4", title: "grip: a SELECTED header-less slicer's grip, dragged (+64, +32), then tapped", surfaces: BOTH, gestures: [dragGrip, tapGrip] },
  { id: "TP-5", title: "slicer item tap: 'Kiwis' on an unselected slicer", surfaces: BOTH, gestures: [tapSlicerItem] },
  { id: "TP-6", title: "timeline drag: February to May on an unselected timeline", surfaces: BOTH, gestures: [dragTimelineRange] },
  { id: "TP-7", title: "button tap: a run-mode floating button", surfaces: BOTH, gestures: [tapFloatingButton] },
  { id: "TP-8", title: "long-press (1 s): a timeline month, a slicer item, a slicer header", surfaces: BOTH, gestures: [longPressMonth, longPressItem, longPressHeader] },
  { id: "TP-9", title: "cells: tap D10, drag D10 to G16, long-press D10", surfaces: WORKSHEET, gestures: [tapCell, dragCells, longPressCell] },
  {
    id: "TP-10",
    title: "button cell: tap, and long-press 1 s, a Cell Type: Button running cellTypes.clear",
    surfaces: WORKSHEET,
    gestures: [tapButtonCell, longPressButtonCell],
  },
];

for (const t of TESTS) {
  for (const surface of t.surfaces) {
    test.describe(`touch and pen, measured: ${t.id} (${surface})`, () => {
      test(`${t.id} (${surface}): ${t.title} -- by mouse (the control), pen and touch`, async ({ appPage: page, grid }) => {
        test.setTimeout(150_000 + 90_000 * t.gestures.length);
        const rows: MeasureRow[] = [];
        let env: TouchEnvironment | null = null;
        const driver = await PointerDriver.open(page);
        try {
          const mark = await markPage(page);
          env = await touchEnvironment(page);
          // Every probe must be able to answer (a blind one throws here), and
          // nothing may hold the pointer before the first gesture.
          expect.soft(await heldPointers(page), "something already held the pointer before this test's first gesture (left by an earlier test?)").toEqual([]);

          for (const g of t.gestures) {
            for (const input of POINTER_INPUTS) {
              const m = await measure(page, grid, driver, t.id, surface, g, input);
              rows.push(m.row);
              const label = `${t.id} (${surface}) "${g.name}" by ${input}`;
              expect.soft(m.row.error, `HARNESS: ${label} could not be measured`).toBeNull();
              expect.soft(m.row.heldAfter, `${label}: after the ${input} was lifted the product still held the pointer (a stuck pointer)`).toEqual([]);
              expect.soft(m.row.captureAfter, `${label}: after the ${input} was lifted an element still held pointer capture`).toEqual([]);
              if (input === "mouse") {
                expect
                  .soft(
                    m.controlFailure,
                    `CONTROL: ${label} -- the mouse, through the same CDP driver, did not do what the proving journeys show it does; ` +
                      "the harness is broken for this gesture, so its pen and touch rows are not a measurement",
                  )
                  .toBeNull();
                expect.soft(m.teethFailure, `PROBE TEETH: ${label}`).toBeNull();
              }
              // HARD: the app survived the gesture, and this is still the same document.
              const alive = await pageAlive(page, mark);
              expect(
                alive.mounted && alive.marked,
                `${label}: the app did not survive the gesture -- mounted ${alive.mounted}, same document ${alive.marked} (${alive.detail})`,
              ).toBe(true);
            }
          }
        } finally {
          await driver.close();
          await publish(rows, env);
          await page.keyboard.press("Escape").catch(() => undefined);
          await setDesignMode(page, false).catch(() => undefined);
          await newFile(page).catch(() => undefined);
        }
      });
    });
  }
}
