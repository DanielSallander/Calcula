/**
 * THE ONE OBJECT PANE AND THE VISUAL-CONTAINER FORMAT PANE, LIVE, AGAINST THE
 * OWNER'S ADVENTUREWORKS MODEL (WP-C, D-PANE + D-FORMAT, 2026-10-16).
 *
 * Owner findings F1 + F5 (scratchpad maps/DECISIONS.md): selecting any canvas
 * object shows ONE side pane like the pivot's -- Fields / Design for a model
 * object, Data for a range chart, Settings / Properties for the rest -- plus a
 * Power BI Format tab (Properties, Title, Effects, Data format) whose fields
 * all carry fx (bindable through WP-D). Every lane proved its half in jsdom
 * with the backend doubled; this journey drives the pane, the Format cards,
 * Core's container paint and the families' paint == hit against the REAL
 * backend, the real Postgres model and the real pointer.
 *
 * WHAT IS ASSERTED. The pane's own state (@api/objectPane
 * `getObjectPaneState`), its DOM (tab strip, Format cards and rows, the build
 * tabs' hooks), backend state (persisted chart specs, pivot regions, slicers,
 * timelines, controls, floating ranges, the undo label), what the painters
 * WROTE (a fillText recorder, with the fill colour where the step is about a
 * colour) and RELATIVE pixel samples (e2e/viewportSample.ts: the same patch
 * before and after, plus an untouched control patch). Never a golden (R14:
 * the goldens are stale by owner decision, and this display is DPR 2).
 *
 * THE SCENE (built once, by J0; the steps run in order, `mode: "serial"`).
 * File > New; Sheet1 A1:D5 = the quarters table (canvas-powerbi's), J1:L5 =
 * Month / Units / Day (the timeline's source), a range bar chart over
 * Sheet1!A1:B5 at (300, 20) and a range pivot "Dates" over J1:L5 at N1; the
 * owner's AdventureWorks connection (probed through the chart's own reader:
 * an unreachable server FAILS J0 -- never a skip); a canvas C shown at 70 %
 * (grid and snap off, so drags and pixel samples are exact) holding
 *   the BI pivot box "AWPivot" (territorygroup x [Revenue])   (40, 40, 460 x 280)
 *   a design-query bar chart (territorygroup x [Revenue])      (540, 40, 420 x 280)
 *   a measure Card VALUES: [Revenue], titled "Total revenue"   (40, 360, 240 x 140)
 *   a model slicer on territorygroup                           (300, 360, 200 x 220)
 *   a text box inserted through Canvas > Elements > Text Box, moved to (980, 40)
 *   and typed "Notes" in its Properties tab.
 * Later steps add, each in its own step, a floating grid pair (J20), a button
 * and a shape (J21), a timeline and a pivot-sourced chart (J22) and a page
 * navigator plus a second canvas (J23). At 70 % the whole 1280 x 720 page
 * stays on screen with the 320 px pane open beside the grid.
 *
 * THE PANE BETWEEN STEPS. The fixture closes every task pane before each test
 * and clears "closed by hand"; each step opens the pane itself, by the route
 * it is about. Every expected number comes from the model through the chart's
 * own reader (`designQueryData`), never typed in.
 *
 * LOCALE. sv-SE: a formula a person types uses `;`; none here needs one.
 *
 * DELIBERATE DEPARTURES FROM THE SPEC TEXT (C-pane-format.md section 5), each
 * checked against the code:
 *   - J10's save / New / reopen is the LAST test ("J10 (reopen)"): reopening
 *     replaces the whole scene, and every step after J10 needs it.
 *   - J5: Apply is DISABLED while the draft equals the stored query
 *     (ChartDesignTab), so "Apply again with the same text" is asserted as the
 *     disabled Apply plus an unchanged undo label.
 *   - J7: the chart's border is ON by default (1 px #d0d0d0), so "border on" is
 *     a commit only if it was off. The undo proof counts the commits actually
 *     made: N Ctrl+Z restore the container exactly and nothing older (the
 *     design query), N Ctrl+Y put it back. The corner sample is taken BEFORE
 *     the shadow goes on (a blurred outside shadow reaches the opposite corner
 *     faintly).
 *   - J18 / J19 bind Sheet1!A21 / Sheet1!A20 instead of B2 / D1: B2 and D1
 *     sit inside the quarters table the range chart plots, and the binding
 *     cells are typed through the grid (the user's announcing door), so they
 *     must be clear of the range chart floating over E1:K13.
 *   - J21: "ONE undo step reverts both" is asserted per commit -- the colour
 *     and the width are two Format commits, so each is ONE undo entry that
 *     takes back exactly what it wrote (and Ctrl+Y re-applies both).
 *   - J22: the timeline family is pivot-sourced only (TimelineSourceType =
 *     "pivot"), so the timeline reads the range pivot "Dates", not a model
 *     date field.
 *   - J23: "a click there navigates" is proved on item 1 (the second canvas
 *     the step adds): item 0 is the page the navigator is on.
 *   - J24 drives Value Field Settings... on a RANGE pivot box it adds on C
 *     ("RangeBox" over J1:L5): on the AW data-model box the item is greyed by
 *     design ("Not available on a data-model PivotTable yet.", an open-items
 *     row), so the re-pointed canvas route can only be reached on a range box.
 *   - J10 samples the default-style header itself, right before the pick: J9's
 *     padding and title moved the cell since J3, so J3's sample has another
 *     clip size (2026-10-16 proof run).
 *   - J4 presses no Escape after View > Panels > Show Object pane: the menu
 *     gives the grid the keyboard, and Escape there deselects the Card, which
 *     closes the pane.
 *
 * RUNNING IT. WP-C changed Rust (the visual-format crate, the container
 * persistence, `set_control_appearance` -- command 831), so launch manually
 * (`E2E_MANUAL=1`, no `--reporter`; memory note "E2E after a Rust change")
 * with CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target, and
 * confirm global-setup printed a binary built after WP-C. Postgres must be up.
 *
 * SABOTAGE PROOFS FOR THE PROOF PHASE (each must turn EXACTLY the named step
 * red; confirm first that the sabotage changed behaviour -- CLAUDE.md "a
 * sabotage that is a no-op passes"):
 *   (1) BuiltIn/ObjectPane/lib/objectPanePolicy.ts `armPress`: call
 *       `finishArm(a)` at the press instead of at the mouseup -> J2 red
 *       ("a moved press opened the pane").
 *   (2) src/api/gridOverlays.ts `resolveFloatingZone`: make the container
 *       band answer CONTENT instead of frame -> J9 red (the band press inside
 *       the padding does not move the box). Measured 2026-10-16: REMOVING the
 *       band test is a no-op for a pivot box -- its own `pivotVisualZoneAt`
 *       (Pivot/lib/pivotVisualOverlay.ts) answers frame outside its content
 *       rect too -- so that sabotage leaves J9 green and proves nothing.
 *   (3) app/src-tauri/src/pivot (`expand_bi_value_fields`): stop copying
 *       `number_format` -> J11 red (the value cell loses its one decimal after
 *       the field change).
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  callModule,
  clickCanvasControl,
  clickCanvasMenuRow,
  closeCanvasFlyouts,
  createChart,
  createShape,
  createTimeline,
  dismissToasts,
  eventually,
  gridKey,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  openFileAtPath,
  patchActiveCanvas,
  persistedCharts,
  selectedObjects,
  sheetPointToPage,
  sheetsResult,
  undoState,
  type PersistedChart,
} from "../helpers/canvas-live";
import {
  awPivotView,
  cellPagePoint,
  cellSheetRect,
  cellText,
  createAwCanvasPivot,
  createFr,
  dropAdventureWorks,
  findInView,
  frCellPoint,
  frEditorOpen,
  frEditText,
  visualState,
  type AwConnection,
  type AwPivotView,
  type CanvasFrame,
  type FrInfo,
} from "../helpers/adventureworks-live";
import { FR_CHROME, clickSheetTab } from "../helpers/edit-harness";
import { slicerItemPoint, slicerLanded } from "../helpers/slicers";
import { cachedData, recordedTexts, startTextRecorder } from "../helpers/chart-paint";
import {
  OBJECT_PANE_ID,
  PIVOT_EDITOR_PANE_ID,
  REGION_TYPE,
  averageRgb,
  bindFormatField,
  clickSliderMiddle,
  closeObjectPaneQuietly,
  commitFormatHex,
  commitFormatNumber,
  commitFormatText,
  connectAdventureWorksProbed,
  contentRectOf,
  expandFormatCard,
  expectedByCategory,
  expectedMeasure,
  focusInsideGrid,
  formatInput,
  formatRow,
  isGridFocused,
  liveRegions,
  luminance,
  manuallyClosedPanes,
  nearestColour,
  openFormat,
  openPaneTab,
  openTaskPaneIds,
  paneOpenedWithin,
  paneRoot,
  paneTabs,
  placeRegion,
  recordedStyledTexts,
  regionWhere,
  removeFormatBinding,
  restoreObjectPaneMemory,
  selectFormat,
  setFormatToggle,
  sheetClip,
  startStyledTextRecorder,
  waitPane,
  wellCentre,
  wellFieldNames,
  type LiveRegion,
  type PaneState,
} from "../helpers/object-pane";
import { diffCount, samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const CONNECTION_NAME = `AW (object pane journey ${RUN})`;
const ZOOM_PERCENT = 70;
const DOC = path.join(os.tmpdir(), `calcula-object-pane-${RUN}.cala`);

const PIVOT_FRAME: CanvasFrame = { x: 40, y: 40, width: 460, height: 280 };
const BAR_AT = { x: 540, y: 40, width: 420, height: 280 };
const CARD_AT = { x: 40, y: 360, width: 240, height: 140 };
const SLICER_AT = { x: 300, y: 360, width: 200, height: 220 };
const TEXT_BOX_AT = { x: 980, y: 40 };
const PAD_FR_AT = { x: 980, y: 130 };
const EDIT_FR_AT = { x: 820, y: 360 };
const BUTTON_AT = { x: 540, y: 360, width: 120, height: 40 };
const SHAPE_AT = { x: 680, y: 360, width: 120, height: 80 };
const TIMELINE_AT = { x: 540, y: 470, width: 320, height: 112 };
const PIVOT_CHART_AT = { x: 980, y: 330, width: 280, height: 200 };
const NAVIGATOR_AT = { x: 40, y: 600 };
/** An empty point of the page (sheet px): a click there selects nothing. */
/** J24's range pivot box (clear of every object before it and of EMPTY_AT). */
const RANGE_BOX_AT = { x: 900, y: 590, width: 300, height: 110 };
const EMPTY_AT = { x: 1250, y: 700 };

const TERRITORY = { table: "BI.dim_territory", column: "territorygroup" };
const BAR_DSL = "ROWS: BI.dim_territory.territorygroup\nVALUES: [Revenue]";
const CARD_DSL = "VALUES: [Revenue]";
const SHARE_DSL = "VALUES: [% Revenue of Total]";
const CARD_TITLE = "Total revenue";
const BAR_TITLE = "Revenue by group";
const PIVOT_TITLE = "Revenue by territory group";
const PIVOT_STYLE = "PivotStyleMedium9";
const EUROPE = "Europe";
/** Sheet1 cells the binding steps type into (clear of the range chart). */
const COLOUR_CELL = "A20";
const TITLE_CELL = "A21";

/** Sheet1 A1:D5: Region / Q1 / Q2 / Q3 (canvas-powerbi's quarters). */
const QUARTERS: string[][] = [
  ["Region", "Q1", "Q2", "Q3"],
  ["North", "10", "20", "5"],
  ["South", "40", "15", "25"],
  ["East", "20", "30", "10"],
  ["West", "30", "25", "20"],
];

/** Sheet1 J1:L5: Month / Units / Day (the timeline's pivot source). */
const DATES: string[][] = [
  ["Month", "Units", "Day"],
  ["Jan", "10", "2026-01-15"],
  ["Feb", "40", "2026-02-15"],
  ["Mar", "20", "2026-03-15"],
  ["Apr", "30", "2026-04-15"],
];

interface Scene {
  conn: AwConnection;
  total: number;
  byGroup: Record<string, number>;
  sheet1Index: number;
  canvasIndex: number;
  pivotId: string;
  barId: string;
  cardId: string;
  slicerId: string;
  rangeChartId: string;
  rangePivotId: string;
  textBox: { row: number; col: number };
  /** J3: the pivot's header cell, default style (J10 compares the new style against it). */
  headerSample: PixelSample | null;
  /** Objects later steps add. */
  padFr: FrInfo | null;
  timelineId: string | null;
  pivotChartId: string | null;
}

let scene: Scene | null = null;
let connHeld: AwConnection | null = null;

function need(): Scene {
  if (!scene) throw new Error("the scene was not built (J0 failed); every later step needs it");
  return scene;
}

// ---------------------------------------------------------------------------
// Reading the app
// ---------------------------------------------------------------------------

type Props = Record<string, { value: string }>;

async function controlRows(page: Page, sheetIndex: number): Promise<Array<{ row: number; col: number; type: string; props: Props }>> {
  const raw = await invoke<Array<{ row: number; col: number; metadata: { controlType: string; properties: Props } }>>(page, "get_all_controls", { sheetIndex });
  return raw.map((c) => ({ row: c.row, col: c.col, type: c.metadata.controlType, props: c.metadata.properties }));
}

async function controlProps(page: Page, sheetIndex: number, row: number, col: number): Promise<Record<string, string>> {
  const c = (await controlRows(page, sheetIndex)).find((x) => x.row === row && x.col === col);
  if (!c) throw new Error(`no control at (${row}, ${col}) on sheet ${sheetIndex}`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.props)) out[k] = v.value;
  return out;
}

async function chartRow(page: Page, id: string): Promise<PersistedChart> {
  const c = (await persistedCharts(page)).find((x) => x.id === id);
  if (!c) throw new Error(`the backend holds no chart ${id}`);
  return c;
}

type Container = Record<string, Record<string, unknown> | unknown>;

function containerOf(spec: Record<string, unknown>): Container {
  return ((spec as { container?: Container }).container ?? {}) as Container;
}

/** A container flattened to "group.leaf" -> value (empty groups vanish), for exact comparisons. */
function leaves(c: Container | undefined | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 !== undefined && v2 !== null) out[`${k}.${k2}`] = v2;
      }
    } else if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

interface PivotRegionRow {
  pivotId: string | number;
  name: string;
  canvasFrame?: CanvasFrame & { container?: Container };
  style?: { styleId: string; themeOverrides?: Record<string, string> };
}

async function pivotRegion(page: Page, pivotId: string): Promise<PivotRegionRow> {
  const all = await invoke<PivotRegionRow[]>(page, "get_pivot_regions_for_sheet");
  const r = all.find((x) => String(x.pivotId) === pivotId);
  if (!r) throw new Error(`pivot ${pivotId} has no region on the active sheet`);
  return r;
}

async function activeIndex(page: Page): Promise<number> {
  return (await sheetsResult(page)).activeIndex;
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

async function ensureZoom(page: Page): Promise<void> {
  const geo = await readGridGeometry(page);
  if (Math.abs(geo.zoom - ZOOM_PERCENT / 100) < 0.01) return;
  await callModule(page, "/src/api/grid.ts", "setZoomLevel", [ZOOM_PERCENT]);
  await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - ZOOM_PERCENT / 100) < 0.01, `the canvas did not zoom to ${ZOOM_PERCENT}%`);
  await page.waitForTimeout(200);
}

/** The canvas C on screen at the journey's zoom. */
async function onCanvas(page: Page): Promise<void> {
  const s = need();
  if ((await activeIndex(page)) !== s.canvasIndex) {
    await clickSheetTab(page, s.canvasIndex);
    await eventually(() => activeIndex(page), (i) => i === s.canvasIndex, "the canvas did not become the active sheet");
  }
  await ensureZoom(page);
}

async function onSheet1(page: Page): Promise<void> {
  const s = need();
  if ((await activeIndex(page)) !== s.sheet1Index) {
    await clickSheetTab(page, s.sheet1Index);
    await eventually(() => activeIndex(page), (i) => i === s.sheet1Index, "Sheet1 did not become the active sheet");
  }
}

function chartRegion(page: Page, chartId: string): Promise<LiveRegion> {
  return regionWhere(page, (r) => r.type === REGION_TYPE.chart && r.data.chartId === chartId, `chart ${chartId}`);
}

function pivotBoxRegion(page: Page, pivotId: string): Promise<LiveRegion> {
  return regionWhere(page, (r) => r.type === REGION_TYPE.pivot && String(r.data.pivotId) === pivotId, `the pivot box ${pivotId}`);
}

function controlRegion(page: Page, row: number, col: number): Promise<LiveRegion> {
  return regionWhere(page, (r) => r.type === REGION_TYPE.control && r.data.row === row && r.data.col === col, `the control at (${row}, ${col})`);
}

/** A hand's click at a point inside a region (sheet offsets from its top-left). */
async function clickRegion(page: Page, r: LiveRegion, at: { dx: number; dy: number } = { dx: 24, dy: 24 }): Promise<void> {
  const p = await sheetPointToPage(page, r.floating.x + at.dx, r.floating.y + at.dy);
  await humanClick(page, p.x, p.y);
  await page.waitForTimeout(250);
}

/** Click a region and wait until the pane shows it (a press opens one task after the mouseup). */
async function openPaneOn(page: Page, r: LiveRegion, at?: { dx: number; dy: number }): Promise<PaneState> {
  await clickRegion(page, r, at);
  return waitPane(page, (s) => s.open && s.regionId === r.id, `a click on ${r.type} ${r.id} did not open the object pane on it`);
}

/** Click the empty page: nothing selected, so the pane closes. */
async function deselectAll(page: Page): Promise<void> {
  const p = await sheetPointToPage(page, EMPTY_AT.x, EMPTY_AT.y);
  await humanClick(page, p.x, p.y);
  await eventually(() => selectedObjects(page), (s) => s.length === 0, "a click on the empty page left an object selected");
  await waitPane(page, (s) => !s.open, "with nothing selected the object pane is still open");
  await page.waitForTimeout(300);
}

async function undo(page: Page): Promise<void> {
  await gridKey(page, "Control+z");
  await page.waitForTimeout(600);
}

async function redo(page: Page): Promise<void> {
  await gridKey(page, "Control+y");
  await page.waitForTimeout(600);
}

async function writeActive(page: Page, rows: string[][], row0: number, col0: number): Promise<void> {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      await invoke(page, "update_cell", { row: row0 + r, col: col0 + c, value: rows[r][c] });
    }
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

/** The pivot's first Data cell in its view (the box's first value). */
function firstValueCell(view: AwPivotView): { viewRow: number; viewCol: number; text: string } {
  const hit = findInView(view, (c) => c.cellType === "Data" && typeof c.value === "number");
  if (!hit) throw new Error("the pivot view has no value cell");
  return { viewRow: hit.viewRow, viewCol: hit.viewCol, text: cellText(hit.cell) };
}

/** The pivot's first column-header cell (a header-row patch for the style comparison). */
function firstHeaderCell(view: AwPivotView): { viewRow: number; viewCol: number } {
  const hit = findInView(view, (c, _r, _c, row) => row.rowType === "ColumnHeader" || c.cellType === "ColumnHeader" || c.cellType === "RowLabelHeader");
  if (!hit) throw new Error("the pivot view has no header cell");
  return { viewRow: hit.viewRow, viewCol: hit.viewCol };
}

async function headerPatch(page: Page, pivotId: string): Promise<PixelClip> {
  const view = await awPivotView(page, pivotId);
  const h = firstHeaderCell(view);
  const rect = await eventually(() => cellSheetRect(page, pivotId, h.viewRow, h.viewCol), (r) => !!r && r.width > 12 && r.height > 6, "the pivot's header cell is not shown");
  // The right end of the cell: clear of its text, inside its fill.
  return sheetClip(page, rect!.x + rect!.width - 10, rect!.y + 3, 6, Math.max(2, rect!.height - 6));
}

async function closePaneByHand(page: Page): Promise<void> {
  await page.locator('button[title="Close Task Pane"]').first().click();
  await waitPane(page, (s) => !s.open, "the X did not close the object pane");
}

// ===========================================================================

test.describe("the ONE object pane + the visual-container Format pane (WP-C), live on AdventureWorks", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.afterAll(async ({ sharedPage: page }) => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    await restoreObjectPaneMemory(page).catch(() => undefined);
    await dismissToasts(page).catch(() => undefined);
    await newFile(page).catch(() => undefined);
    await dropAdventureWorks(page, connHeld);
    // A reopen may have re-created the connection from the file: drop every one of this journey's name.
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.name === CONNECTION_NAME) await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
    }
    fs.rmSync(DOC, { force: true });
    // The leaked-pane rule: prove the container hidden before the next spec runs.
    await callModule(page, "/src/api/ui.ts", "closeTaskPane", [OBJECT_PANE_ID]).catch(() => undefined);
    await callModule(page, "/src/api/ui.ts", "hideTaskPaneContainer").catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  test("J0 the scene: Sheet1 tables, a range chart and a range pivot; AdventureWorks connected and probed; a canvas with the AW pivot box, a design-query bar chart, a measure Card, a model slicer and a text box typed through the real UI", async ({ appPage: page }) => {
    await installAppImport(page);
    // The journey asserts what a reader with NO tab history sees (the memory is localStorage-backed).
    await restoreObjectPaneMemory(page);
    await newFile(page);
    const first = await sheetsResult(page);
    const sheet1 = first.sheets[first.activeIndex];
    await writeActive(page, QUARTERS, 0, 0);
    await writeActive(page, DATES, 0, 9);

    const rangeChartId = await createChart(
      page,
      {
        mark: "bar",
        data: { sheetIndex: sheet1.index, ...(sheet1.sheetId ? { sheetId: sheet1.sheetId } : {}), startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Q1", color: "#4472C4" }],
        title: "Quarters",
      },
      { sheetIndex: sheet1.index, x: 300, y: 20, width: 400, height: 250, name: "RangeChart" },
    );

    const datesView = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
      { sourceRange: "Sheet1!J1:L5", destinationCell: "N1", sourceSheet: sheet1.index, destinationSheet: sheet1.index, hasHeaders: true, name: "Dates" },
    ]);
    const rangePivotId = String(datesView.pivotId);
    await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
      { pivotId: rangePivotId, rowFields: [{ sourceIndex: 0, name: "Month" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
    ]);

    const probed = await connectAdventureWorksProbed(page, CONNECTION_NAME);
    connHeld = probed.conn;
    const byGroup = await expectedByCategory(page, probed.conn.connectionId, BAR_DSL);
    expect(byGroup[EUROPE], `the model has no ${EUROPE} territory group: ${JSON.stringify(byGroup)}`).toBeGreaterThan(0);
    expect(byGroup[EUROPE], "the Europe filter would not narrow Revenue: J12 would be vacuous").toBeLessThan(probed.total);

    const canvas = await addCanvas(page);
    await patchActiveCanvas(page, { showGrid: false, snapToGrid: false });
    const sc: Scene = {
      conn: probed.conn,
      total: probed.total,
      byGroup,
      sheet1Index: sheet1.index,
      canvasIndex: canvas.index,
      pivotId: "",
      barId: "",
      cardId: "",
      slicerId: "",
      rangeChartId,
      rangePivotId,
      textBox: { row: -1, col: -1 },
      headerSample: null,
      padFr: null,
      timelineId: null,
      pivotChartId: null,
    };
    scene = sc;
    await ensureZoom(page);

    sc.pivotId = await createAwCanvasPivot(page, {
      canvasIndex: canvas.index,
      connectionId: probed.conn.connectionId,
      frame: PIVOT_FRAME,
      rows: [TERRITORY],
      columns: [],
      values: [{ measureName: "Revenue" }],
      name: "AWPivot",
    });

    sc.barId = await createChart(
      page,
      { mark: "bar", data: { type: "designQuery", dslText: BAR_DSL, connectionId: probed.conn.connectionId }, hasHeaders: true, seriesOrientation: "columns", categoryIndex: 0, series: [], title: "Revenue" },
      { sheetIndex: canvas.index, ...BAR_AT, name: "BarChart" },
      { waitPaint: false },
    );
    sc.cardId = await createChart(
      page,
      { mark: "card", data: { type: "designQuery", dslText: CARD_DSL, connectionId: probed.conn.connectionId }, hasHeaders: true, seriesOrientation: "columns", categoryIndex: 0, series: [], title: CARD_TITLE },
      { sheetIndex: canvas.index, ...CARD_AT, name: "Card" },
      { waitPaint: false },
    );
    await eventually(() => cachedData(page, sc.barId), (d) => !!d && d.series.length > 0 && d.categories.includes(EUROPE), "the design-query bar chart never painted its groups", 60_000);
    await eventually(
      () => cachedData(page, sc.cardId),
      (d) => !!d && Math.abs((d.series[0]?.values[0] ?? Number.NaN) - probed.total) < 0.01,
      `the Card never showed the model's total ${probed.total}`,
      60_000,
    );

    const slicer = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
      {
        name: "Group",
        sheetIndex: canvas.index,
        ...SLICER_AT,
        sourceType: "biConnection",
        cacheSourceId: probed.conn.connectionId,
        fieldName: `${TERRITORY.table}.${TERRITORY.column}`,
        connectedSources: [{ sourceType: "biConnection", sourceId: probed.conn.connectionId }],
      },
    ]);
    expect(slicer, "the model slicer was not created").toBeTruthy();
    sc.slicerId = slicer!.id;
    await eventually(
      () => callModule<Array<{ value: string }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [sc.slicerId]),
      (it) => (it ?? []).some((x) => x.value === EUROPE),
      `the model slicer does not list ${EUROPE}`,
      30_000,
    );

    // ---- The text box, through Canvas > Elements > Text Box.
    const before = await controlRows(page, canvas.index);
    await clickCanvasControl(page, "canvas-insert-textBox");
    await closeCanvasFlyouts(page);
    const after = await eventually(() => controlRows(page, canvas.index), (cs) => cs.length === before.length + 1, "Canvas > Elements > Text Box inserted nothing");
    const tb = after.find((c) => !before.some((b) => b.row === c.row && b.col === c.col))!;
    expect(tb.props.shapeType?.value, "the Text Box insert is not a text box").toBe("textBox");
    sc.textBox = { row: tb.row, col: tb.col };
    const tbRegion = await controlRegion(page, tb.row, tb.col);
    await placeRegion(page, tbRegion.id, TEXT_BOX_AT);
    const moved = await controlRegion(page, tb.row, tb.col);
    expect({ x: moved.floating.x, y: moved.floating.y }, "the text box did not move to its place").toEqual(TEXT_BOX_AT);
    await openPaneOn(page, moved);
    await openPaneTab(page, "properties");
    const text = page.locator('[data-testid="object-pane-build-slot"] [data-testid="control-prop-text"] input').first();
    await expect(text, "the text box's Properties tab has no Text row").toBeVisible({ timeout: 10_000 });
    await text.click();
    await text.fill("Notes");
    await text.press("Enter");
    await eventually(() => controlProps(page, canvas.index, tb.row, tb.col), (p) => p.text === "Notes", "typing Notes in the text box's Properties tab did not persist");

    await deselectAll(page);
    // Every family publishes a container (paint == hit starts here).
    const regions = await liveRegions(page);
    for (const type of [REGION_TYPE.chart, REGION_TYPE.pivot, REGION_TYPE.slicer, REGION_TYPE.control]) {
      const mine = regions.filter((r) => r.type === type);
      expect(mine.length, `no ${type} object is published on the canvas`).toBeGreaterThan(0);
      expect(mine.every((r) => r.hasContainer), `a ${type} region carries no visual container`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  test("J1 a click on the Card opens THE object pane on it at release: Fields | Design | Format, the grid keeps the keyboard, the Card is the only selected object", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const card = await chartRegion(page, s.cardId);
    const state = await openPaneOn(page, card);
    expect(state.regionType, "the pane is not on a chart").toBe(REGION_TYPE.chart);
    expect(await paneTabs(page), "a design-query chart's tabs").toEqual(["Fields", "Design", "Format"]);
    expect(await focusInsideGrid(page), "opening the pane took the keyboard from the grid").toBe(true);
    const sel = await selectedObjects(page);
    expect(sel.map((o) => o.chartId), "the Card is not the only selected object").toEqual([s.cardId]);
    await expect(paneRoot(page)).toHaveAttribute("data-region-id", card.id);
  });

  // -------------------------------------------------------------------------
  test("J2 a MOVED press opens nothing: with the pane closed (not by hand) a drag of the bar chart moves it +20 and leaves the pane closed; a plain click then opens it (positive control); Ctrl+Z puts the chart back", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.cardId));
    await closeObjectPaneQuietly(page);
    expect(await manuallyClosedPanes(page), "closeTaskPane marked the pane closed by hand").not.toContain(OBJECT_PANE_ID);

    const bar0 = await chartRow(page, s.barId);
    const region = await chartRegion(page, s.barId);
    const geo = await readGridGeometry(page);
    const start = await sheetPointToPage(page, region.floating.x + 30, region.floating.y + 30);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 10 * geo.zoom, start.y, { steps: 4 });
    await page.mouse.move(start.x + 20 * geo.zoom, start.y, { steps: 4 });
    await page.mouse.up();
    const moved = await eventually(() => chartRow(page, s.barId), (c) => c.x !== bar0.x, "the drag did not move the bar chart");
    expect(Math.abs(moved.x - (bar0.x + 20)), `the bar chart moved to x=${moved.x}, not ${bar0.x + 20}`).toBeLessThanOrEqual(1);
    expect(moved.y, "a horizontal drag moved the chart vertically").toBe(bar0.y);
    expect(await paneOpenedWithin(page, 900), "a MOVED press opened the object pane").toBeNull();

    // Positive control: the same chart, a click that does not move, opens it.
    await openPaneOn(page, await chartRegion(page, s.barId));

    await undo(page);
    await eventually(() => chartRow(page, s.barId), (c) => c.x === bar0.x, "Ctrl+Z did not put the bar chart back");
  });

  // -------------------------------------------------------------------------
  test("J3 a click on a pivot CELL opens the pane on the pivot: Fields | Design | Format, the lifted field list shows territorygroup in Rows and Revenue in Values, and no pivot-editor pane opens", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const box = await pivotBoxRegion(page, s.pivotId);
    const view = await awPivotView(page, s.pivotId);
    const cell = firstValueCell(view);
    const at = await cellPagePoint(page, s.pivotId, cell.viewRow, cell.viewCol);
    await humanClick(page, at.x, at.y);
    const state = await waitPane(page, (p) => p.open && p.regionId === box.id, "a click on a pivot cell did not open the object pane on the box");
    expect(state.regionType).toBe(REGION_TYPE.pivot);
    expect(state.tabId, "the pivot pane did not open on Fields").toBe("fields");
    expect(await paneTabs(page)).toEqual(["Fields", "Design", "Format"]);
    await expect(page.locator('[data-testid="object-pane-build-slot"] [data-testid="canvas-pivot-build"]'), "the Fields tab hosts no lifted pivot editor").toBeVisible({ timeout: 20_000 });
    const rows = await eventually(() => wellFieldNames(page, "canvas-pivot-build", "Rows"), (n) => !!n && n.length > 0, "the Fields tab's Rows well is empty", 20_000);
    expect(rows!.some((n) => /territorygroup/i.test(n)), `Rows does not list territorygroup: ${JSON.stringify(rows)}`).toBe(true);
    const values = await wellFieldNames(page, "canvas-pivot-build", "Values");
    expect((values ?? []).some((n) => /Revenue/.test(n)), `Values does not list Revenue: ${JSON.stringify(values)}`).toBe(true);
    expect(await openTaskPaneIds(page), "a canvas pivot box opened the pivot-editor pane").not.toContain(PIVOT_EDITOR_PANE_ID);
    // The cell press selected the CELL (D-CELLS), not only the box.
    const st = await visualState(page, s.pivotId);
    expect(st?.cellSelection, "the press did not select the clicked cell").toMatchObject({ anchorRow: cell.viewRow, anchorCol: cell.viewCol });

    // The default style's header, for J10's comparison (the pane stays open: the page is anchored top-left).
    await deselectAll(page);
    const [sample] = await samplePixelGrids(page, [await headerPatch(page, s.pivotId)]);
    s.headerSample = sample;
  });

  // -------------------------------------------------------------------------
  test("J4 Tab retargets the open pane; the X marks it closed by hand, so a click no longer opens it; View > Panels > Show Object pane is a door; Ctrl+1 opens it on Format", async ({ appPage: page, grid }) => {
    const s = need();
    await onCanvas(page);
    const card = await chartRegion(page, s.cardId);
    await openPaneOn(page, card);

    await gridKey(page, "Tab");
    const next = await waitPane(page, (p) => p.open && p.regionId !== null && p.regionId !== card.id, "Tab did not retarget the open pane to the next object");
    const primary = await selectedObjects(page);
    expect(primary.map((o) => o.id), "the pane does not follow the object Tab selected").toContain(next.regionId!);

    await closePaneByHand(page);
    expect(await manuallyClosedPanes(page), "the X did not mark the pane closed by hand").toContain(OBJECT_PANE_ID);
    await clickRegion(page, card);
    expect(await paneOpenedWithin(page, 900), "a click opened a pane the reader closed by hand").toBeNull();

    // View > Panels > Show Object pane (a door).
    await grid.openMenu("View");
    await grid.hoverMenuItem("^Panels");
    await page.locator("button").filter({ hasText: /Show Object pane/ }).first().click();
    await waitPane(page, (p) => p.open && p.regionId === card.id, "View > Panels > Show Object pane did not open the pane on the selected Card");
    // No Escape here: the menu closed on the click and gave the grid the
    // keyboard (restoreFocusToGrid), so an Escape would deselect the Card --
    // and with nothing selected the pane closes, correctly.

    // Ctrl+1 after another X: a door again, on Format.
    await closePaneByHand(page);
    await gridKey(page, "Control+1");
    const formatted = await waitPane(page, (p) => p.open && p.regionId === card.id, "Ctrl+1 on the selected Card did not open the object pane");
    expect(formatted.tabId, "Ctrl+1 did not open the pane on Format").toBe("format");
  });

  // -------------------------------------------------------------------------
  test("J5 the Card's Design tab: Apply writes the new query as ONE 'Edit chart data' step and the Card shows the model's answer; an unchanged draft cannot be applied; Ctrl+Z restores VALUES: [Revenue]", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.cardId));
    await openPaneTab(page, "design");
    const editor = page.locator('[data-testid="chart-design-editor"] .monaco-editor').first();
    await expect(editor, "the Design tab shows no query editor").toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type(SHARE_DSL, { delay: 30 });
    await page.waitForTimeout(800);
    const apply = page.locator('[data-testid="chart-design-apply"]');
    await expect(apply, "a changed draft leaves Apply disabled").toBeEnabled();
    await apply.click();
    await eventually(async () => ((await chartRow(page, s.cardId)).spec.data as { dslText?: string }).dslText, (t) => t === SHARE_DSL, "Apply did not persist the new query", 20_000);
    const expected = await expectedMeasure(page, s.conn.connectionId, SHARE_DSL);
    await eventually(
      () => cachedData(page, s.cardId),
      (d) => !!d && Math.abs((d.series[0]?.values[0] ?? Number.NaN) - expected) < 1e-6,
      `the Card does not show the model's ${SHARE_DSL} = ${expected}`,
      60_000,
    );
    expect((await undoState(page)).undoDescription, "the query edit is not ONE 'Edit chart data' step").toBe("Edit chart data");
    await expect(apply, "Apply is enabled with an unchanged draft (it would write an empty step)").toBeDisabled();

    await undo(page);
    await eventually(async () => ((await chartRow(page, s.cardId)).spec.data as { dslText?: string }).dslText, (t) => t === CARD_DSL, "ONE Ctrl+Z did not restore VALUES: [Revenue]");
    await eventually(() => cachedData(page, s.cardId), (d) => !!d && Math.abs((d.series[0]?.values[0] ?? Number.NaN) - s.total) < 0.01, "after Ctrl+Z the Card does not show the total again", 60_000);
  });

  // -------------------------------------------------------------------------
  test("J6 the Card's Data format: Revenue -> #,##0.00 persists in spec.fieldFormats and the Card WRITES the row's Rust-formatted text (invariant locale); Use source format deletes the key", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.cardId));
    await openFormat(page, "general");
    await expandFormatCard(page, "dataFormat");
    await expect(formatInput(page, "data-Revenue"), "the Data format card has no Revenue row").toBeVisible({ timeout: 15_000 });
    await startTextRecorder(page);
    await selectFormat(page, "data-Revenue", "#,##0.00");
    await eventually(async () => ((await chartRow(page, s.cardId)).spec as { fieldFormats?: Record<string, string> }).fieldFormats?.Revenue, (f) => f === "#,##0.00", "the data format did not persist in spec.fieldFormats");
    const row = await eventually(
      () => cachedData(page, s.cardId),
      (d) => /^[\d,]+\.\d{2}$/.test(d?.displayValues?.[0]?.[0] ?? ""),
      "the Card's data row is not formatted #,##0.00 (invariant locale: 1,234.50-shaped)",
      60_000,
    );
    const formatted = row!.displayValues![0][0];
    await eventually(() => recordedTexts(page), (t) => t.includes(formatted), `the Card did not WRITE its row's formatted text ${formatted}`, 20_000);
    // The pane's preview uses the APP locale (an owner question, open-items): read, not asserted away.
    const preview = await page.locator('[data-field-id="dataFormat.Revenue"] [data-testid="format-data-preview"]').innerText().catch(() => "");
    console.log(`[object-pane-format] J6 Card wrote ${JSON.stringify(formatted)}; the pane's preview reads ${JSON.stringify(preview)}`);

    await page.locator('[data-testid="format-data-Revenue-source"]').click();
    await eventually(async () => ((await chartRow(page, s.cardId)).spec as { fieldFormats?: Record<string, string> }).fieldFormats?.Revenue, (f) => f === undefined, "Use source format did not delete the key");
  });

  // -------------------------------------------------------------------------
  test("J7 the bar chart's Effects: background, transparency, border colour / width / radius, shadow persist in spec.container (theme.background absent); the page shows them; each commit is ONE undo step: N Ctrl+Z restore the container and the pixels, N Ctrl+Y put it back", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await deselectAll(page);
    const bar = await chartRegion(page, s.barId);
    const f = bar.floating;
    const geo = await readGridGeometry(page);
    const px = 2 / geo.zoom; // 2 CSS px in sheet px
    const cornerClip = await sheetClip(page, f.x, f.y, px, px);
    const pageClip = await sheetClip(page, f.x - 20, f.y - 20, px, px);
    const shadowClip = await sheetClip(page, f.x + f.width + 1, f.y + f.height / 2, 3, 4);
    const controlClip = await sheetClip(page, EMPTY_AT.x - 20, EMPTY_AT.y - 20, 10, 10);
    const [cornerBefore, pageRef, shadowBefore, controlBefore] = await samplePixelGrids(page, [cornerClip, pageClip, shadowClip, controlClip]);
    const before = await chartRow(page, s.barId);
    const containerBefore = leaves(containerOf(before.spec));

    await openPaneOn(page, bar);
    await openFormat(page, "general");
    await expandFormatCard(page, "effects");
    let commits = 0;
    const step = async (label: string, done: (c: Record<string, unknown>) => boolean): Promise<void> => {
      commits++;
      await eventually(async () => leaves(containerOf((await chartRow(page, s.barId)).spec)), done, `${label} did not persist in spec.container`);
      expect((await undoState(page)).undoDescription, `${label} is not a "Format Object" step`).toBe("Format Object");
    };
    await commitFormatHex(page, "background.color", "#FFF4E5");
    await step("background #FFF4E5", (c) => String(c["background.color"]).toLowerCase() === "#fff4e5");
    const transparency = await clickSliderMiddle(page, "background.transparency");
    expect(Math.abs(transparency - 50), `the slider's middle is ${transparency}, not 50`).toBeLessThanOrEqual(1);
    await step("transparency", (c) => c["background.transparency"] === transparency);
    if (await setFormatToggle(page, "border.show", true)) await step("border on", (c) => c["border.show"] === true);
    await commitFormatHex(page, "border.color", "#1F4E79");
    await step("border colour", (c) => String(c["border.color"]).toLowerCase() === "#1f4e79");
    await commitFormatNumber(page, "border.width", 2);
    await step("border width", (c) => c["border.width"] === 2);
    await commitFormatNumber(page, "border.radius", 12);
    await step("border radius", (c) => c["border.radius"] === 12);

    // The corner, BEFORE the shadow (a blurred outside shadow reaches it faintly).
    await deselectAll(page);
    const [cornerRounded] = await samplePixelGrids(page, [cornerClip]);
    expect(diffCount(cornerBefore, cornerRounded), "the chart's corner did not change when it was rounded").toBeGreaterThan(0);
    expect(diffCount(cornerRounded, pageRef), "the corner cut by radius 12 is not the page's own background").toBeLessThanOrEqual(2);

    await openPaneOn(page, await chartRegion(page, s.barId));
    await openFormat(page, "general");
    await expandFormatCard(page, "effects");
    await setFormatToggle(page, "shadow.show", true);
    await step("shadow on", (c) => c["shadow.show"] === true);

    const after = await chartRow(page, s.barId);
    expect(leaves(containerOf(after.spec)), "spec.container does not hold every committed leaf").toMatchObject({
      "background.transparency": transparency,
      "border.width": 2,
      "border.radius": 12,
      "shadow.show": true,
    });
    expect((after.spec as { config?: { theme?: { background?: unknown } } }).config?.theme?.background, "the background was written to theme.background too").toBeUndefined();

    await deselectAll(page);
    const [shadowAfter, controlAfter] = await samplePixelGrids(page, [shadowClip, controlClip]);
    expect(diffCount(shadowBefore, shadowAfter), "no shadow outside the chart's bottom-right edge").toBeGreaterThan((shadowAfter.width * shadowAfter.height) / 4);
    expect(diffCount(controlBefore, controlAfter), "pixels changed where nothing was").toBeLessThan(10);

    // N commits = N undo steps: N Ctrl+Z restore exactly, and nothing older.
    for (let i = 0; i < commits; i++) await undo(page);
    await eventually(async () => leaves(containerOf((await chartRow(page, s.barId)).spec)), (c) => JSON.stringify(c) === JSON.stringify(containerBefore), `${commits} Ctrl+Z did not restore the bar chart's container exactly`);
    expect(((await chartRow(page, s.barId)).spec.data as { dslText?: string }).dslText, `${commits} Ctrl+Z undid more than the ${commits} format steps`).toBe(BAR_DSL);
    await deselectAll(page);
    const [cornerUndone, shadowUndone] = await samplePixelGrids(page, [cornerClip, shadowClip]);
    expect(diffCount(cornerBefore, cornerUndone), "after the undo the corner does not look as before").toBeLessThanOrEqual(2);
    expect(diffCount(shadowBefore, shadowUndone), "after the undo the shadow is still painted").toBeLessThanOrEqual(2);

    for (let i = 0; i < commits; i++) await redo(page);
    await eventually(async () => leaves(containerOf((await chartRow(page, s.barId)).spec)), (c) => c["shadow.show"] === true && c["border.radius"] === 12, `${commits} Ctrl+Y did not put the format back`);
  });

  // -------------------------------------------------------------------------
  test("J8 the bar chart's Title card: text, left, not bold -- spec.title holds the text and spec.container.title only align / bold; the chart WRITES the text; a click on the title still walks the ladder to the title and the element card names it", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.barId));
    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await startTextRecorder(page);
    await commitFormatText(page, "title.text", BAR_TITLE);
    await eventually(async () => (await chartRow(page, s.barId)).spec.title, (t) => t === BAR_TITLE, "the title text did not persist in spec.title");
    await selectFormat(page, "title.align", "left");
    await setFormatToggle(page, "title.bold", false);
    const title = await eventually(
      async () => (containerOf((await chartRow(page, s.barId)).spec).title ?? {}) as Record<string, unknown>,
      (t) => t.align === "left" && t.bold === false,
      "align / bold did not persist in spec.container.title",
    );
    for (const k of ["text", "color", "fontSize"]) expect(Object.keys(title), `spec.container.title holds a second spelling of ${k}`).not.toContain(k);
    await eventually(() => recordedTexts(page), (t) => t.includes(BAR_TITLE), "the chart did not WRITE its new title");

    // The ladder: a click on the painted title selects the TITLE.
    const layout = await eventually(
      () => callModule<{ layout?: { elements?: Record<string, { x: number; y: number; width: number; height: number }> } } | null>(page, MOD.CHART_RENDERER, "getCachedChartData", [s.barId]),
      (d) => !!d?.layout?.elements?.title,
      "the bar chart reports no title rect",
    );
    const tRect = layout!.layout!.elements!.title;
    const bar = await chartRegion(page, s.barId);
    const content = await contentRectOf(page, bar.id);
    await clickRegion(page, bar, { dx: content.x - bar.floating.x + tRect.x + tRect.width / 2, dy: content.y - bar.floating.y + tRect.y + tRect.height / 2 });
    const sel = await eventually(
      () => callModule<{ chartId: string | null; level: string; elementId?: string }>(page, MOD.CHART_SELECTION, "getChartSelection"),
      (v) => v.elementId === "title",
      "a click on the chart's title did not select the title (the ladder)",
    );
    expect(sel.chartId).toBe(s.barId);
    await waitPane(page, (p) => p.open && p.regionId === bar.id, "the pane left the bar chart");
    await openFormat(page, "visual");
    await expect(page.locator('[data-testid="chart-format-subject"]'), "the element card does not name the title").toHaveText(/Format Chart Title/, { timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  test("J9 the pivot box's Properties padding 24 and a Title: persisted in canvasFrame.container; a press in the padding band drags the box, a press on the first value cell selects that CELL; the title paints", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const box = await pivotBoxRegion(page, s.pivotId);
    await openPaneOn(page, box, { dx: box.floating.width / 2, dy: box.floating.height / 2 });
    await openFormat(page, "general");
    await expandFormatCard(page, "properties");
    for (const side of ["top", "right", "bottom", "left"]) await commitFormatNumber(page, `padding.${side}`, 24);
    await eventually(
      async () => leaves((await pivotRegion(page, s.pivotId)).canvasFrame?.container),
      (c) => c["padding.top"] === 24 && c["padding.right"] === 24 && c["padding.bottom"] === 24 && c["padding.left"] === 24,
      "padding 24 did not persist in the pivot's canvasFrame.container",
    );
    await expandFormatCard(page, "title");
    await startTextRecorder(page);
    await setFormatToggle(page, "title.show", true);
    await commitFormatText(page, "title.text", PIVOT_TITLE);
    await eventually(
      async () => leaves((await pivotRegion(page, s.pivotId)).canvasFrame?.container),
      (c) => c["title.show"] === true && c["title.text"] === PIVOT_TITLE,
      "the title did not persist in the pivot's canvasFrame.container",
    );
    await eventually(() => recordedTexts(page), (t) => t.includes(PIVOT_TITLE), "the pivot box did not PAINT its title");

    // A press in the padding band is the frame: it drags the box.
    const frame0 = (await pivotRegion(page, s.pivotId)).canvasFrame!;
    const geo = await readGridGeometry(page);
    const band = await sheetPointToPage(page, frame0.x + 10, frame0.y + 10);
    await page.mouse.move(band.x, band.y);
    await page.mouse.down();
    await page.mouse.move(band.x + 16 * geo.zoom, band.y, { steps: 4 });
    await page.mouse.move(band.x + 32 * geo.zoom, band.y, { steps: 4 });
    await page.mouse.up();
    const dragged = await eventually(() => pivotRegion(page, s.pivotId), (r) => (r.canvasFrame?.x ?? frame0.x) !== frame0.x, "a press in the padding band did not drag the box", 10_000);
    expect(Math.abs(dragged.canvasFrame!.x - (frame0.x + 32)), "the band drag did not move the box 32 px").toBeLessThanOrEqual(1);
    await undo(page);
    await eventually(() => pivotRegion(page, s.pivotId), (r) => r.canvasFrame?.x === frame0.x, "Ctrl+Z did not put the box back");

    // A press on the first value cell (content origin + header rows) selects the CELL.
    await page.waitForTimeout(400);
    const view = await awPivotView(page, s.pivotId);
    const cell = firstValueCell(view);
    const at = await cellPagePoint(page, s.pivotId, cell.viewRow, cell.viewCol);
    const content = await contentRectOf(page, (await pivotBoxRegion(page, s.pivotId)).id);
    const rect = (await cellSheetRect(page, s.pivotId, cell.viewRow, cell.viewCol))!;
    expect(rect.x, "the first value cell is not laid out inside the content rect").toBeGreaterThanOrEqual(content.x - 0.5);
    expect(rect.y, "the first value cell is not laid out below the content origin").toBeGreaterThanOrEqual(content.y - 0.5);
    await humanClick(page, at.x, at.y);
    const st = await eventually(() => visualState(page, s.pivotId), (v) => !!v?.cellSelection, "a press on the first value cell selected no cell");
    expect(st!.cellSelection).toMatchObject({ anchorRow: cell.viewRow, anchorCol: cell.viewCol, endRow: cell.viewRow, endCol: cell.viewCol });
    expect((await pivotRegion(page, s.pivotId)).canvasFrame!.x, "the cell press moved the box").toBe(frame0.x);
  });

  // -------------------------------------------------------------------------
  test("J10 the pivot's Visual > Style: PivotStyleMedium9 persists as the region's style and the header row repaints in it", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    // The default-style header, sampled HERE: J9's padding and title moved the
    // cell since J3, and a sample of the old geometry has another clip size.
    expect(s.headerSample, "J3 took no default-style header sample").not.toBeNull();
    await deselectAll(page);
    await page.waitForTimeout(300);
    const [defaultStyled] = await samplePixelGrids(page, [await headerPatch(page, s.pivotId)]);
    const box = await pivotBoxRegion(page, s.pivotId);
    await openPaneOn(page, box, { dx: box.floating.width / 2, dy: box.floating.height / 2 });
    await openFormat(page, "visual");
    await expandFormatCard(page, "pivot-style");
    const gallery = page.locator('[data-testid="pivot-format-style-gallery"]');
    await expect(gallery, "the pivot's Format tab has no style gallery").toBeVisible({ timeout: 10_000 });
    let tile = gallery.locator(`[data-testid="pivot-style-${PIVOT_STYLE}"]`).first();
    if (!(await tile.isVisible().catch(() => false))) {
      await gallery.locator('[data-testid="pivot-style-expand"]').first().click();
      tile = page.locator(`[data-testid="pivot-style-${PIVOT_STYLE}"]`).filter({ visible: true }).first();
    }
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await eventually(async () => (await pivotRegion(page, s.pivotId)).style?.styleId, (id) => id === PIVOT_STYLE, `the gallery pick did not persist ${PIVOT_STYLE}`);
    await deselectAll(page);
    await page.waitForTimeout(500);
    const [styled] = await samplePixelGrids(page, [await headerPatch(page, s.pivotId)]);
    expect(diffCount(defaultStyled, styled), `the header row does not repaint in ${PIVOT_STYLE}`).toBeGreaterThan((styled.width * styled.height) / 3);
  });

  // -------------------------------------------------------------------------
  test("J11 the pivot's Data format #,##0.0 survives a field change in the Fields tab: a value cell has one decimal before AND after year joins the columns (the BI format-loss regression)", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const box = await pivotBoxRegion(page, s.pivotId);
    await openPaneOn(page, box, { dx: box.floating.width / 2, dy: box.floating.height / 2 });
    await openFormat(page, "general");
    await expandFormatCard(page, "dataFormat");
    await expect(formatInput(page, "data-0"), "the pivot's Data format card has no row for its value field").toBeVisible({ timeout: 15_000 });
    await selectFormat(page, "data-0", "__custom__");
    await commitFormatText(page, "data-0-code", "#,##0.0");
    const oneDecimal = (t: string): boolean => /\.\d$/.test(t) && !/\.\d\d$/.test(t);
    await eventually(async () => firstValueCell(await awPivotView(page, s.pivotId)).text, oneDecimal, "the value cells do not show one decimal after #,##0.0", 60_000);

    // Fields: drag year (BI.dim_date) into Columns, the editor's own gesture.
    await openPaneTab(page, "fields");
    const build = page.locator('[data-testid="canvas-pivot-build"]');
    await expect(build).toBeVisible({ timeout: 15_000 });
    const search = build.locator('input[placeholder="Search fields..."]').first();
    await search.fill("year");
    await page.waitForTimeout(500);
    const field = build.locator("span").filter({ hasText: /^year$/ }).first();
    await expect(field, "the field list does not offer BI.dim_date.year").toBeVisible({ timeout: 10_000 });
    const from = await field.boundingBox();
    const to = await wellCentre(page, "canvas-pivot-build", "Columns");
    expect(from && to, "the year field or the Columns well has no box").toBeTruthy();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 12, from!.y + from!.height / 2 + 12, { steps: 4 });
    await page.mouse.move(to!.x, to!.y, { steps: 12 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await eventually(
      async () => (await awPivotView(page, s.pivotId)).rows.some((r) => r.cells.some((c) => c.cellType === "ColumnHeader" && /^\d{4}$/.test(cellText(c)))),
      (v) => v,
      "dragging year into Columns did not put the years on the pivot's columns",
      60_000,
    );
    const after = firstValueCell(await awPivotView(page, s.pivotId));
    expect(oneDecimal(after.text), `after the field change a value cell reads ${JSON.stringify(after.text)}: the data format was lost (C2)`).toBe(true);
    await search.fill("");
  });

  // -------------------------------------------------------------------------
  test("J12 the slicer: Settings single select, Format title text and radius 8 persist; a click on Europe hits Europe (paint == hit) and the Card shows the model's Europe revenue", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const sr = await regionWhere(page, (r) => r.type === REGION_TYPE.slicer && r.data.slicerId === s.slicerId, "the slicer");
    const state = await openPaneOn(page, sr, { dx: sr.floating.width / 2, dy: 12 });
    expect(state.tabId, "a slicer's pane does not open on Settings").toBe("settings");
    expect(await paneTabs(page)).toEqual(["Settings", "Format"]);
    const single = page.locator('[data-testid="slicer-setting-singleSelect"]');
    await expect(single).toBeVisible({ timeout: 10_000 });
    await single.click();
    type SlicerRow = { id: string; selectionMode?: string; headerText?: string | null; container?: Container };
    const slicerRow = async (): Promise<SlicerRow> => (await invoke<SlicerRow[]>(page, "get_all_slicers")).find((x) => x.id === s.slicerId)!;
    await eventually(slicerRow, (r) => r.selectionMode === "single", "Single select did not persist selectionMode single");

    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await commitFormatText(page, "title.text", "Territory group");
    await eventually(slicerRow, (r) => r.headerText === "Territory group", "the slicer's title text did not persist as headerText");
    await expandFormatCard(page, "effects");
    await commitFormatNumber(page, "border.radius", 8);
    await eventually(slicerRow, (r) => leaves(r.container)["border.radius"] === 8, "radius 8 did not persist in the slicer's container");

    const at = await slicerItemPoint(page, s.slicerId, EUROPE);
    await humanClick(page, at.x, at.y);
    await slicerLanded(page);
    await eventually(
      async () => (await callModule<{ selectedItems: string[] | null } | undefined>(page, MOD.SLICER_STORE, "getSlicerById", [s.slicerId]))?.selectedItems ?? null,
      (sel) => JSON.stringify(sel) === JSON.stringify([EUROPE]),
      "the click did not select Europe (paint and hit disagree)",
    );
    await eventually(
      () => cachedData(page, s.cardId),
      (d) => !!d && Math.abs((d.series[0]?.values[0] ?? Number.NaN) - s.byGroup[EUROPE]) < 0.01,
      `the Card does not show the model's Europe revenue ${s.byGroup[EUROPE]}`,
      60_000,
    );
    await callModule(page, MOD.SLICER_STORE, "clickSlicerClearFilter", [s.slicerId]);
    await eventually(() => cachedData(page, s.cardId), (d) => !!d && Math.abs((d.series[0]?.values[0] ?? Number.NaN) - s.total) < 0.01, "clearing the slicer did not bring the total back", 60_000);
  });

  // -------------------------------------------------------------------------
  test("J13 the text box: no fill, no outline, dark left-aligned text -- in its properties and on the page", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const p = await controlProps(page, s.canvasIndex, s.textBox.row, s.textBox.col);
    expect({ fill: p.fill, stroke: p.stroke, strokeWidth: p.strokeWidth, textColor: (p.textColor ?? "").toLowerCase(), textAlign: p.textAlign }, "the text box recipe").toEqual({
      fill: "none",
      stroke: "none",
      strokeWidth: "0",
      textColor: "#252423",
      textAlign: "left",
    });
    await deselectAll(page);
    const r = await controlRegion(page, s.textBox.row, s.textBox.col);
    const f = r.floating;
    const third = f.width / 3;
    const [left, right, edge, pageRef] = await samplePixelGrids(page, [
      await sheetClip(page, f.x + 2, f.y + 4, third - 4, f.height - 8),
      await sheetClip(page, f.x + 2 * third + 2, f.y + 4, third - 4, f.height - 8),
      await sheetClip(page, f.x + 4, f.y, f.width - 8, 1.5),
      await sheetClip(page, f.x + 4, f.y - 12, f.width - 8, 1.5),
    ]);
    expect(luminance(left), `the left third (${luminance(left).toFixed(1)}) is not darker than the right (${luminance(right).toFixed(1)}): the text is not left-aligned`).toBeLessThan(luminance(right) - 2);
    expect(diffCount(edge, pageRef), "the text box paints an outline on its edge").toBeLessThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  test("J14 under Lock Objects the Properties geometry rows are disabled with the lock's sentence while an Effects change still persists", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await clickCanvasControl(page, "canvas-lock-objects");
    await closeCanvasFlyouts(page);
    try {
      await eventually(async () => (await sheetsResult(page)).sheets.find((x) => x.index === s.canvasIndex)?.canvasLayout?.objectsLocked, (v) => v === true, "Lock Objects did not lock the page");
      await openPaneOn(page, await chartRegion(page, s.barId));
      await openFormat(page, "general");
      await expandFormatCard(page, "properties");
      for (const k of ["x", "y", "width", "height"]) await expect(formatInput(page, `geometry-${k}`), `the ${k} row is editable on a locked page`).toBeDisabled();
      await expect(page.locator('[data-testid="object-pane-geometry-reason"]'), "the geometry rows do not say why").toHaveText(/lock/i);
      await expandFormatCard(page, "effects");
      await commitFormatHex(page, "background.color", "#E2F0D9");
      await eventually(async () => String(leaves(containerOf((await chartRow(page, s.barId)).spec))["background.color"]).toLowerCase(), (c) => c === "#e2f0d9", "an Effects change was refused on a locked page");
    } finally {
      await closeObjectPaneQuietly(page).catch(() => undefined);
      await clickCanvasControl(page, "canvas-lock-objects");
      await closeCanvasFlyouts(page);
      await eventually(async () => (await sheetsResult(page)).sheets.find((x) => x.index === s.canvasIndex)?.canvasLayout?.objectsLocked, (v) => !v, "Lock Objects did not unlock the page");
    }
  });

  // -------------------------------------------------------------------------
  test("J15 Delete with a Format-pane button focused deletes nothing (the grid does not have the keyboard); Escape gives it back", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.barId));
    await openFormat(page, "general");
    const header = page.locator('[data-format-card-header="effects"]');
    await header.click();
    await expect(header).toBeFocused();
    await page.keyboard.press("Delete");
    await page.waitForTimeout(800);
    expect((await persistedCharts(page)).some((c) => c.id === s.barId), "Delete in the pane deleted the chart").toBe(true);
    expect(await isGridFocused(page), "the grid has the keyboard while a pane button is focused").toBe(false);
    await page.keyboard.press("Escape");
    await eventually(() => isGridFocused(page), (v) => v, "Escape in the pane did not give the keyboard back to the grid");
    await header.click();
  });

  // -------------------------------------------------------------------------
  test("J16 on Sheet1 a click on the range chart opens no pane; Ctrl+1 opens it on Format; the Data tab's range Sheet1!A1:C5 writes two series as ONE undo step", async ({ appPage: page }) => {
    const s = need();
    await onSheet1(page);
    await closeObjectPaneQuietly(page);
    const r = await chartRegion(page, s.rangeChartId);
    await clickRegion(page, r, { dx: 30, dy: 30 });
    expect(await paneOpenedWithin(page, 900), "a click on a WORKSHEET chart opened the pane").toBeNull();
    await gridKey(page, "Control+1");
    const st = await waitPane(page, (p) => p.open && p.regionId === r.id, "Ctrl+1 on the selected range chart opened no pane");
    expect(st.tabId).toBe("format");
    expect(await paneTabs(page), "a range chart's tabs").toEqual(["Data", "Format"]);
    await openPaneTab(page, "data");
    const input = page.locator('[data-testid="chart-data-range-input"]');
    await expect(input, "the Data tab has no range box").toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill("Sheet1!A1:C5");
    await input.press("Enter");
    const changed = await eventually(
      () => chartRow(page, s.rangeChartId),
      (c) => (c.spec.data as { endCol?: number }).endCol === 2 && ((c.spec as { series?: unknown[] }).series ?? []).length === 2,
      "the range Sheet1!A1:C5 did not persist with two series",
      15_000,
    );
    expect(changed.spec.data as Record<string, unknown>).toMatchObject({ startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    expect((await undoState(page)).undoDescription).toBe("Edit chart data");
    await undo(page);
    await eventually(() => chartRow(page, s.rangeChartId), (c) => (c.spec.data as { endCol?: number }).endCol === 1, "ONE Ctrl+Z did not take the range change back");
    await redo(page);
    await eventually(() => chartRow(page, s.rangeChartId), (c) => (c.spec.data as { endCol?: number }).endCol === 2, "Ctrl+Y did not re-apply the range change");
    await closeObjectPaneQuietly(page);
  });

  // -------------------------------------------------------------------------
  test("J17 Lock aspect ratio: a drag of the bottom-right handle keeps the bar chart's width / height ratio; Ctrl+Z restores its size", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.barId));
    await openFormat(page, "general");
    await expandFormatCard(page, "properties");
    await setFormatToggle(page, "lockAspect", true);
    await eventually(async () => containerOf((await chartRow(page, s.barId)).spec).lockAspect, (v) => v === true, "Lock aspect ratio did not persist");
    const c0 = await chartRow(page, s.barId);
    const geo = await readGridGeometry(page);
    const corner = await sheetPointToPage(page, c0.x + c0.width, c0.y + c0.height);
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 60 * geo.zoom, corner.y + 5 * geo.zoom, { steps: 6 });
    await page.mouse.move(corner.x + 120 * geo.zoom, corner.y + 10 * geo.zoom, { steps: 6 });
    await page.mouse.up();
    const c1 = await eventually(() => chartRow(page, s.barId), (c) => c.width !== c0.width, "the handle drag did not resize the chart");
    expect(c1.width, "the drag did not widen the chart").toBeGreaterThan(c0.width);
    expect(Math.abs(c1.height - (c1.width * c0.height) / c0.width), `the ratio drifted: ${c0.width}x${c0.height} -> ${c1.width}x${c1.height}`).toBeLessThanOrEqual(1);
    await undo(page);
    await eventually(() => chartRow(page, s.barId), (c) => c.width === c0.width && c.height === c0.height, "Ctrl+Z did not restore the chart's size");
  });

  // -------------------------------------------------------------------------
  test("J18 the Card's title bound with fx to =Sheet1!A21: the binding is listed at /spec/title, a typed 77 is what the Card writes, and Remove binding brings the literal title back", async ({ appPage: page, grid }) => {
    const s = need();
    await onSheet1(page);
    await grid.setCellValue(TITLE_CELL, "1");
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.cardId));
    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await bindFormatField(page, "title", "title.text", "/spec/title", `=Sheet1!${TITLE_CELL}`);
    const listed = await callModule<Array<{ path: string }>>(page, "/src/api/objectBindings/index.ts", "listBindings", [{ kind: "chart", id: s.cardId }]);
    expect(listed.map((b) => b.path), "the Card's binding is not listed at /spec/title").toContain("/spec/title");

    await onSheet1(page);
    await grid.setCellValue(TITLE_CELL, "77");
    await startTextRecorder(page);
    await onCanvas(page);
    await eventually(() => recordedTexts(page), (t) => t.includes("77"), "the Card did not WRITE the bound title 77", 30_000);

    await openPaneOn(page, await chartRegion(page, s.cardId));
    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await startTextRecorder(page);
    await removeFormatBinding(page, "title", "title.text", "/spec/title");
    await eventually(() => recordedTexts(page), (t) => t.includes(CARD_TITLE), `after Remove binding the Card does not write its literal title "${CARD_TITLE}"`, 30_000);
    expect((await chartRow(page, s.cardId)).spec.title, "the literal title was overwritten by the binding").toBe(CARD_TITLE);
  });

  // -------------------------------------------------------------------------
  test("J19 bound colours win over the stored ones: the title colour ='#C00000' is the fill the title is written in; the border bound to =Sheet1!A20 paints green, and turns blue when A20 changes -- without any Format commit", async ({ appPage: page, grid }) => {
    const s = need();
    await onSheet1(page);
    await grid.setCellValue(COLOUR_CELL, "#00B050");
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.barId));
    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await startStyledTextRecorder(page);
    await bindFormatField(page, "title", "title.color", "/spec/config/theme/titleColor", '="#C00000"');
    await eventually(
      () => recordedStyledTexts(page),
      (t) => t.some((x) => x.text === BAR_TITLE && x.fill === "#c00000"),
      `the title "${BAR_TITLE}" was not written in the bound #c00000`,
      30_000,
    );
    await expandFormatCard(page, "effects");
    await bindFormatField(page, "effects", "border.color", "/spec/container/border/color", `=Sheet1!${COLOUR_CELL}`);
    const literal = String(leaves(containerOf((await chartRow(page, s.barId)).spec))["border.color"] ?? "");

    const borderColour = async (): Promise<string> => {
      await deselectAll(page);
      await page.waitForTimeout(400);
      const r = await chartRegion(page, s.barId);
      const geo = await readGridGeometry(page);
      const [sample] = await samplePixelGrids(page, [await sheetClip(page, r.floating.x + r.floating.width / 2 - 4, r.floating.y + 0.4 / geo.zoom, 8, 1.2)]);
      return nearestColour(averageRgb(sample), {
        green: "#00B050",
        blue: "#0070C0",
        literal: literal && /^#[0-9a-fA-F]{6}$/.test(literal) ? literal : "#1F4E79",
        background: "#E2F0D9",
        page: "#FFFFFF",
      }).name;
    };
    await eventually(borderColour, (c) => c === "green", "the border does not paint the bound green", 20_000);

    await onSheet1(page);
    await grid.setCellValue(COLOUR_CELL, "#0070C0");
    await onCanvas(page);
    await eventually(borderColour, (c) => c === "blue", "the border did not turn blue when the bound cell changed", 20_000);
    expect(String(leaves(containerOf((await chartRow(page, s.barId)).spec))["border.color"] ?? ""), "the stored border colour changed: something committed").toBe(literal);
  });

  // -------------------------------------------------------------------------
  test("J20 a floating grid: Properties | Format; its title is its name (rename, never fx); no fx on title, show or padding; Effects background persists; padding 12 grows the frame; a pick at the content origin inserts its first cell", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    s.padFr = await createFr(page, PAD_FR_AT.x, PAD_FR_AT.y, "PadFR", { rows: 5, cols: 2 });
    const r0 = await regionWhere(page, (r) => r.type === REGION_TYPE.floatingRange && r.data.frId === s.padFr!.id, "the floating grid PadFR");
    await openPaneOn(page, r0, { dx: 60, dy: 8 });
    expect(await paneTabs(page)).toEqual(["Properties", "Format"]);
    await openFormat(page, "general");
    await expandFormatCard(page, "title");
    await expect(page.locator('[data-testid="format-title-identity"]'), "the title row does not say it is the name").toHaveText("The title is this object's name; rename it");
    await expect(page.locator('[data-testid="format-title-rename"]'), "the title row offers no Rename").toBeVisible();
    await expect(formatInput(page, "title.text"), "the name is editable in place").toBeDisabled();
    for (const id of ["title.text", "title.show"]) await expect(formatRow(page, "title", id), `${id} offers fx`).toHaveAttribute("data-bindable", "false");
    await expandFormatCard(page, "properties");
    for (const side of ["top", "right", "bottom", "left"]) await expect(formatRow(page, "properties", `padding.${side}`), `padding.${side} offers fx`).toHaveAttribute("data-bindable", "false");

    await expandFormatCard(page, "effects");
    await commitFormatHex(page, "background.color", "#F2F2F2");
    type FrRow = { id: string; container?: Container };
    const frRow = async (): Promise<FrRow> => (await invoke<FrRow[]>(page, "list_floating_ranges")).find((x) => x.id === s.padFr!.id)!;
    await eventually(async () => String(leaves((await frRow()).container)["background.color"] ?? "").toLowerCase(), (c) => c === "#f2f2f2", "the background did not persist in the floating grid's container");

    for (const side of ["top", "right", "bottom", "left"]) await commitFormatNumber(page, `padding.${side}`, 12);
    const r1 = await eventually(
      () => regionWhere(page, (r) => r.type === REGION_TYPE.floatingRange && r.data.frId === s.padFr!.id, "PadFR"),
      (r) => Math.round(r.floating.width - r0.floating.width) === 24 && Math.round(r.floating.height - r0.floating.height) === 24,
      "padding 12 did not grow the frame by 24 px each way",
    );

    // A pick: = in a second grid, then a click at PadFR's content origin + its headers.
    await closeObjectPaneQuietly(page);
    const editFr = await createFr(page, EDIT_FR_AT.x, EDIT_FR_AT.y, "EditFR", { rows: 3, cols: 2 });
    const editCell = await frCellPoint(page, editFr, 0, 0);
    await page.mouse.dblclick(editCell.x, editCell.y);
    await eventually(() => frEditorOpen(page), (v) => v, "a double-click on EditFR's A1 opened no editor");
    await page.keyboard.type("=");
    await eventually(() => frEditText(page), (t) => t === "=", "EditFR's edit does not read =");
    const content = await contentRectOf(page, r1.id);
    const target = await sheetPointToPage(
      page,
      content.x + FR_CHROME.rowHeader + FR_CHROME.cellW / 2,
      content.y + FR_CHROME.title + FR_CHROME.colHeader + FR_CHROME.cellH / 2,
    );
    await humanClick(page, target.x, target.y);
    await eventually(() => frEditText(page), (t) => t === "=PadFR!A1", "a pick at PadFR's first cell (content origin + headers) did not insert =PadFR!A1", 10_000);
    await page.keyboard.press("Escape");
    await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel the pick edit");
  });

  // -------------------------------------------------------------------------
  test("J21 a Design-Mode button: Properties (the action row) | Format; its border colour and width persist as borderColor / strokeWidth, each ONE undo step; in run mode its press opens no pane. A shape's background persists as fill and Ctrl+Z restores it", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [true]);
    try {
      const before = await controlRows(page, s.canvasIndex);
      await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-blank");
      await closeCanvasFlyouts(page);
      const after = await eventually(() => controlRows(page, s.canvasIndex), (cs) => cs.length === before.length + 1, "Buttons > Button inserted nothing");
      const btn = after.find((c) => !before.some((b) => b.row === c.row && b.col === c.col))!;
      expect(btn.type).toBe("button");
      await placeRegion(page, (await controlRegion(page, btn.row, btn.col)).id, BUTTON_AT);
      const br = await controlRegion(page, btn.row, btn.col);
      await openPaneOn(page, br, { dx: br.floating.width / 2, dy: br.floating.height / 2 });
      expect(await paneTabs(page)).toEqual(["Properties", "Format"]);
      await openPaneTab(page, "properties");
      await expect(page.locator('[data-testid="object-pane-build-slot"]').getByText("Action", { exact: true }).first(), "the button's Properties tab shows no Action row").toBeVisible({ timeout: 10_000 });

      const p0 = await controlProps(page, s.canvasIndex, btn.row, btn.col);
      await openFormat(page, "general");
      await expandFormatCard(page, "effects");
      await commitFormatHex(page, "border.color", "#1F4E79");
      await eventually(async () => (await controlProps(page, s.canvasIndex, btn.row, btn.col)).borderColor?.toLowerCase(), (c) => c === "#1f4e79", "the border colour did not persist as borderColor");
      await commitFormatNumber(page, "border.width", 2);
      await eventually(async () => (await controlProps(page, s.canvasIndex, btn.row, btn.col)).strokeWidth, (w) => w === "2", "the border width did not persist as strokeWidth");
      expect((await undoState(page)).undoDescription, "the control format is not an undo step").toMatch(/Format/);

      await undo(page);
      const u1 = await eventually(() => controlProps(page, s.canvasIndex, btn.row, btn.col), (p) => p.strokeWidth === p0.strokeWidth, "ONE Ctrl+Z did not take the width back");
      expect(u1.borderColor?.toLowerCase(), "the width's undo also took the colour (two commits merged)").toBe("#1f4e79");
      await undo(page);
      await eventually(() => controlProps(page, s.canvasIndex, btn.row, btn.col), (p) => (p.borderColor ?? "") === (p0.borderColor ?? ""), "the second Ctrl+Z did not take the colour back");
      await redo(page);
      await redo(page);
      await eventually(() => controlProps(page, s.canvasIndex, btn.row, btn.col), (p) => p.borderColor?.toLowerCase() === "#1f4e79" && p.strokeWidth === "2", "Ctrl+Y twice did not re-apply both");

      // Run mode: the press is the button's own; no pane.
      await closeObjectPaneQuietly(page);
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]);
      await page.waitForTimeout(300);
      const runR = await controlRegion(page, btn.row, btn.col);
      await clickRegion(page, runR, { dx: runR.floating.width / 2, dy: runR.floating.height / 2 });
      expect(await paneOpenedWithin(page, 900), "a run-mode button press opened the object pane").toBeNull();
    } finally {
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    }

    // ---- A shape.
    const made = await createShape(page, { sheetIndex: s.canvasIndex, ...SHAPE_AT });
    const sr = await controlRegion(page, made.row, made.col);
    const fill0 = (await controlProps(page, s.canvasIndex, made.row, made.col)).fill ?? "";
    await openPaneOn(page, sr, { dx: sr.floating.width / 2, dy: sr.floating.height / 2 });
    await openFormat(page, "general");
    await expandFormatCard(page, "effects");
    await commitFormatHex(page, "background.color", "#FFC000");
    await eventually(async () => (await controlProps(page, s.canvasIndex, made.row, made.col)).fill?.toLowerCase(), (f) => f === "#ffc000", "the shape's background did not persist as fill");
    await undo(page);
    await eventually(async () => (await controlProps(page, s.canvasIndex, made.row, made.col)).fill ?? "", (f) => f === fill0, "Ctrl+Z did not restore the shape's fill");
  });

  // -------------------------------------------------------------------------
  test("J22 a timeline: Settings | Format, its radius persists in its container; a pivot-sourced chart: the Data tab names the PivotTable, the subtotal toggle persists, Select PivotTable selects the box and shows its Fields", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const tl = await createTimeline(page, { sheetIndex: s.canvasIndex, ...TIMELINE_AT, pivotId: s.rangePivotId, name: "Dates" });
    s.timelineId = tl.id;
    const tr = await regionWhere(page, (r) => r.type === REGION_TYPE.timeline && r.data.timelineId === tl.id, "the timeline");
    const st = await openPaneOn(page, tr, { dx: tr.floating.width / 2, dy: 8 });
    expect(st.tabId, "a timeline's pane does not open on Settings").toBe("settings");
    expect(await paneTabs(page)).toEqual(["Settings", "Format"]);
    await openFormat(page, "general");
    await expandFormatCard(page, "effects");
    await commitFormatNumber(page, "border.radius", 6);
    type TlRow = { id: string; container?: Container };
    await eventually(
      async () => leaves((await invoke<TlRow[]>(page, "get_all_timeline_slicers")).find((x) => x.id === tl.id)?.container)["border.radius"],
      (v) => v === 6,
      "the timeline's radius did not persist in its container",
    );

    // ---- A chart reading the AW pivot.
    s.pivotChartId = await createChart(
      page,
      { mark: "bar", data: { type: "pivot", pivotId: s.pivotId }, hasHeaders: true, seriesOrientation: "columns", categoryIndex: 0, series: [], title: "From the pivot" },
      { sheetIndex: s.canvasIndex, ...PIVOT_CHART_AT, name: "PivotChart" },
      { waitPaint: false },
    );
    const pc = await chartRegion(page, s.pivotChartId);
    const pst = await openPaneOn(page, pc);
    expect(pst.tabId, "a pivot chart's pane does not open on Data").toBe("data");
    await expect(page.locator('[data-testid="chart-pivot-source"]')).toContainText("PivotTable AWPivot", { timeout: 15_000 });
    await page.locator('[data-testid="chart-pivot-subtotals"]').click();
    await eventually(async () => ((await chartRow(page, s.pivotChartId!)).spec.data as { includeSubtotals?: boolean }).includeSubtotals, (v) => v === true, "the subtotal toggle did not persist");
    await page.locator('[data-testid="chart-pivot-select"]').click();
    const box = await pivotBoxRegion(page, s.pivotId);
    await waitPane(page, (p) => p.open && p.regionId === box.id && p.tabId === "fields", "Select PivotTable did not show the box's Fields");
    expect((await selectedObjects(page)).map((o) => o.id), "Select PivotTable did not select the box").toEqual([box.id]);
  });

  // -------------------------------------------------------------------------
  test("J23 a page navigator: Format background #EEEEEE and a border persist as container keys, the item fill does not change and Format offers no Padding; with Properties padding 12 item 0 starts at the content origin and a click on an item navigates", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const c2 = await addCanvas(page);
    await clickSheetTab(page, s.canvasIndex);
    await onCanvas(page);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [true]);
    try {
      const before = await controlRows(page, s.canvasIndex);
      await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-pageNavigator");
      await closeCanvasFlyouts(page);
      const after = await eventually(() => controlRows(page, s.canvasIndex), (cs) => cs.some((c) => c.type === "pageNavigator"), "Page Navigator inserted nothing");
      const nav = after.find((c) => c.type === "pageNavigator" && !before.some((b) => b.row === c.row && b.col === c.col))!;
      await placeRegion(page, (await controlRegion(page, nav.row, nav.col)).id, NAVIGATOR_AT);
      const nr = await controlRegion(page, nav.row, nav.col);
      const fill0 = (await controlProps(page, s.canvasIndex, nav.row, nav.col)).fill;
      await openPaneOn(page, nr, { dx: 6, dy: nr.floating.height / 2 });
      await openFormat(page, "general");
      await expandFormatCard(page, "properties");
      await expect(page.locator('[data-format-card="properties"] [data-field-id^="padding."]'), "the navigator's Format offers Padding (its Properties row owns it)").toHaveCount(0);
      await expandFormatCard(page, "effects");
      await commitFormatHex(page, "background.color", "#EEEEEE");
      await setFormatToggle(page, "border.show", true);
      const p1 = await eventually(
        () => controlProps(page, s.canvasIndex, nav.row, nav.col),
        (p) => (p.containerBackgroundColor ?? "").toLowerCase() === "#eeeeee" && p.containerBorderShow === "true",
        "the navigator's background / border did not persist as container keys",
      );
      expect(p1.fill, "the navigator's item fill changed").toBe(fill0);

      // Properties padding 12 (WP-B's row): item 0 at the content origin.
      await openPaneTab(page, "properties");
      const pad = page.locator('[data-testid="object-pane-build-slot"] [data-testid="control-prop-padding"] input').first();
      await expect(pad, "the navigator's Properties tab has no Padding row").toBeVisible({ timeout: 10_000 });
      await pad.click();
      await pad.fill("12");
      await pad.press("Enter");
      await eventually(() => controlProps(page, s.canvasIndex, nav.row, nav.col), (p) => p.padding === "12", "padding 12 did not persist");
      const navId = await callModule<string>(page, MOD.CONTROLS_FLOATING_STORE, "makeFloatingControlId", [s.canvasIndex, nav.row, nav.col]);
      type NavItem = { sheetId: string; rect: { x: number; y: number; width: number; height: number } };
      const described = await eventually(
        () => callModule<{ items: NavItem[] } | null>(page, MOD.NAV_DESCRIBE, "describePageNavigator", [navId]),
        (d) => !!d && d.items.length >= 2,
        "the navigator does not describe two items",
      );
      const content = await contentRectOf(page, (await controlRegion(page, nav.row, nav.col)).id);
      const item0 = described!.items[0].rect;
      expect(Math.abs(item0.x - content.x), `item 0 starts at x=${item0.x}, the content origin is ${content.x}`).toBeLessThanOrEqual(1);
      expect(Math.abs(item0.y - content.y), `item 0 starts at y=${item0.y}, the content origin is ${content.y}`).toBeLessThanOrEqual(1);

      // Run mode: a click inside item 1 (the second canvas), near its own start.
      await closeObjectPaneQuietly(page);
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]);
      await page.waitForTimeout(300);
      const item1 = described!.items[1].rect;
      const at = await sheetPointToPage(page, item1.x + 4, item1.y + item1.height / 2);
      await humanClick(page, at.x, at.y);
      await eventually(() => activeIndex(page), (i) => i === c2.index, "a click on the navigator's second item did not navigate");
    } finally {
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
      await clickSheetTab(page, s.canvasIndex).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  test("J24 with the pane closed by hand, a pivot value cell's Value Field Settings... opens the object pane on Fields AND the Value Field Settings modal", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openPaneOn(page, await chartRegion(page, s.cardId));
    await closePaneByHand(page);
    expect(await manuallyClosedPanes(page)).toContain(OBJECT_PANE_ID);
    // A RANGE pivot box on C: on a data-model pivot (the AW box) Value Field
    // Settings... is greyed by design ("Not available on a data-model
    // PivotTable yet." -- the open-items row on re-pointing that gate), so the
    // re-pointed canvas route is driven on a range pivot over J1:L5.
    const created = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
      { sourceRange: "Sheet1!J1:L5", destinationCell: "A1", sourceSheet: s.sheet1Index, destinationSheet: s.canvasIndex, hasHeaders: true, name: "RangeBox", canvasFrame: { ...RANGE_BOX_AT, frozenHeaders: true } },
    ]);
    const rangeBoxId = String(created.pivotId);
    await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
      { pivotId: rangeBoxId, rowFields: [{ sourceIndex: 0, name: "Month" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
    ]);
    await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
    expect(await manuallyClosedPanes(page), "creating the pivot box reopened the pane").toContain(OBJECT_PANE_ID);
    const view = await eventually(() => awPivotView(page, rangeBoxId), (v) => { try { firstValueCell(v); return true; } catch { return false; } }, "the range pivot box has no value cell");
    const cell = firstValueCell(view);
    const at = await cellPagePoint(page, rangeBoxId, cell.viewRow, cell.viewCol);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button: "right" });
    await page.waitForTimeout(60);
    await page.mouse.up({ button: "right" });
    await expect(page.locator('[data-pivot-box-menu="0"]'), "the right-click opened no pivot box menu").toBeVisible({ timeout: 10_000 });
    await page.locator('[data-pivot-box-menu="0"] [role="menuitem"][data-item-id="pivot:valueFieldSettings"]').click();
    const box = await pivotBoxRegion(page, rangeBoxId);
    await waitPane(page, (p) => p.open && p.regionId === box.id && p.tabId === "fields", "Value Field Settings... did not open the object pane on the pivot's Fields", 20_000);
    const modal = page.locator("h2", { hasText: /^Value Field Settings$/ });
    await expect(modal, "the Value Field Settings modal is not shown").toBeVisible({ timeout: 20_000 });
    await page
      .locator("div")
      .filter({ has: modal })
      .filter({ has: page.getByRole("button", { name: "Cancel" }) })
      .last()
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(modal).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  test("J10 (reopen) the pivot's style and container survive save and reopen", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const res = await invoke<{ success?: boolean } | null>(page, "save_file", { path: DOC });
    expect(res === null || res?.success !== false, `save_file refused: ${JSON.stringify(res)}`).toBe(true);
    await newFile(page);
    await openFileAtPath(page, DOC);
    await clickSheetTab(page, s.canvasIndex);
    const r = await eventually(() => pivotRegion(page, s.pivotId).catch(() => null), (x) => !!x, "after reopening the canvas holds no AWPivot region", 60_000);
    expect(r!.style?.styleId, "the style did not survive save and reopen").toBe(PIVOT_STYLE);
    const c = leaves(r!.canvasFrame?.container);
    expect(c, "the container did not survive save and reopen").toMatchObject({
      "padding.top": 24,
      "padding.right": 24,
      "padding.bottom": 24,
      "padding.left": 24,
      "title.show": true,
      "title.text": PIVOT_TITLE,
    });
  });
});
