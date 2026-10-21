/**
 * FLOATING GRIDS TAKE EVERY HOME COMMAND (canvas round 2, package P3, owner
 * finding G3, ledger BUG-0516) -- LIVE.
 *
 * Until P3, every Home door refused on a floating grid's cell ("... is not
 * available for a floating range's cells yet"), because Core's selection stays
 * on a sheet cell HIDDEN under the grid and a door that wrote "the selection"
 * wrote that hidden cell (BUG-0185). P3 made the grid a CELL TARGET: a door
 * asks `resolveCellTarget(action, capability)` (@api/cellTarget), passes the
 * explicit `target: CellTargetRef` to the wrapper it already called, and Rust
 * resolves the id once (`cell_target.rs`) and gates the write by the HOST's
 * protection. The grid paints from one styled read (`get_cell_target_cells`)
 * with the sheet's own paint helpers. Design: docs/design/canvas-sheets.md
 * §16.2; open items: docs/design/open-items.md §2.al P3.
 *
 * Every unit tier proved its part with the other parts doubled. This journey
 * drives the REAL ribbon, menus, keys and dialogs against the REAL backend.
 *
 * ASSERTIONS are state (the grid's own styled read, the object row, Sheet1's
 * cells), DOM (aria-pressed, dialogs) and RELATIVE pixel samples
 * (e2e/viewportSample.ts, one unclipped capture) -- never a golden (round-1
 * ruling R14). The witness of the BUG-0185 class is Sheet1!A1: Core's hidden
 * active cell, which no floating-grid gesture may touch.
 *
 * FIXTURE (`setup`, every test, after File > New):
 *   Sheet1 A1:C5 seeded (canvas-live seedSheet1), Core's active cell A1.
 *   Float1 -- a 5 x 4 floating grid at (320, 80) on Sheet1:
 *             A1:A4 = c, a, d, b   B1:B4 = 1234.567, 10, 20, 30   C1 = =B1*2
 *   Sheet1 D1 = =Float1!B3.
 *   The backing sheet is invisible to get_sheets (never a tab).
 *   FG13 only: a canvas Canvas1 with the owner's AdventureWorks model pivot
 *   (rows territorygroup, values [Revenue]) and a 4 x 3 floating grid Float2.
 *   The model is C:\Dropbox\Projekt\Calcula\context_manager\model.json against
 *   Postgres on localhost:5432 (helpers/adventureworks-live.ts). An unreachable
 *   server FAILS FG13; it is never a skip.
 *
 * Every test closes its task panes and proves the container hidden, drops its
 * connection and ends with File > New, all in `finally`.
 *
 * RUNNING IT. Rust changed in this package, so launch manually (E2E_MANUAL=1,
 * no --reporter) with CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target,
 * and confirm global-setup printed a binary built after P3 S5.
 *
 * SABOTAGES for the proof phase (each reverted; first confirm the sabotage
 * CHANGED behaviour -- a no-op sabotage passes):
 *   SB1 StyleTargets::Only also pushes the active sheet       -> FG1 (Sheet1!A1 style changes)
 *   SB2 paintStyledCellBox skips the fill                      -> FG2 (yellow pixel)
 *   SB3 FR_ACTS_ON without "numberFormat"                      -> FG1 (refusal)
 *   SB4 ribbon state reads Core's getCell again                -> FG3
 *   SB5 edit_lines_on_target skips the window patch           -> FG7 (rowCount)
 *   SB6 target_protection_view answers the BACKING sheet's     -> FG12 (Bold lands on a protected host)
 *   SB7 the v11 stamp removed                                  -> FG14
 *   SB8 resolveCellTarget always answers the grid target       -> FG1 (Sheet1!A1 written) and FG2
 *   SB9 the host gate removed from update_floating_range_cell_inner -> FG12 (typing lands)
 *
 * DEVIATIONS FROM THE SPEC TABLE (spec P3 section 5), each for a stated reason:
 *   - FG2: B2 holds the NUMBER 10, which General RIGHT-aligns, so Center moves
 *     its ink toward the cell's centre (leftwards), not "right": asserted as
 *     "closer to the centre than before".
 *   - FG6: `get_all_row_heights` reads the ACTIVE sheet only and no command
 *     reads another sheet's heights, so the leak witness is the HOST sheet's
 *     row heights; the object's map and the frame are asserted directly.
 *   - FG8: Format Painter from Sheet1 INTO a floating grid is REFUSED until
 *     BUG-0513 (no style-index command takes a target); the reverse works.
 *   - FG10: ruling Q4 -- Merge on a floating grid is the sheet's gesture (the
 *     same keep-first-value prompt). A1 already holds the first value, so the
 *     outcome is the spec's: A1 keeps "c", B1 is discarded.
 *   - FG13: [Revenue] is formatted #,##0 (no decimals), so Decrease Decimal on
 *     it would change nothing: Increase Decimal runs first, then Decrease.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures";
import {
  callModule,
  cellAt,
  cellPagePoint,
  cellsOn,
  closeDialogsAndOverlays,
  coreEditOpen,
  createFr,
  dismissToasts,
  eventually,
  executeCommand,
  focusGrid,
  frCell,
  frEditorOpen,
  frList,
  frLocalSelection,
  installAppImport,
  invoke,
  newFile,
  openDialogs,
  sheetPointToPage,
  sheets,
  setFrCell,
  startToastLog,
  styleAt,
  toastMark,
  toastsSince,
  undoState,
  FLOATING_RANGES,
  FORMAT_PAINTER_STATE,
  type AppWindow,
  type FrInfo,
} from "../helpers/edit-harness";
import { answerNativeDialog, appIsRunning, visibleDialogs } from "../helpers/edit-close";
import {
  addCanvas,
  clickCanvasControl,
  closeCanvasFlyouts,
  isDirty,
  openFileAtPath,
  pivotRegions,
  seedSheet1,
  sheetsResult,
  MOD,
} from "../helpers/canvas-live";
import {
  awPivotView,
  connectAdventureWorks,
  createAwCanvasPivot,
  dropAdventureWorks,
  frEditText,
  type AwConnection,
} from "../helpers/adventureworks-live";
import { clickHomeControl, clickHomeMenuRow, closeHomeFlyouts, ensureHomeTab } from "../helpers/homeTab";
import {
  averageRgb,
  closeObjectPaneForGood,
  closeTaskPanes,
  luminance,
  recordedStyledTexts,
  startStyledTextRecorder,
} from "../helpers/object-pane";
import { diffCount, samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOAT1_AT = { x: 320, y: 80 };
const FLOAT1_SIZE = { rows: 5, cols: 4 };
const FLOAT2_AT = { x: 640, y: 80 };
const PIVOT_FRAME = { x: 64, y: 64, width: 480, height: 300 };

const API_CELL_CLIPBOARD = "/src/api/cellClipboard.ts";
const API_LOCALE = "/src/api/locale.ts";
const API_GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const FR_STORE = "/extensions/FloatingRange/lib/floatingRangeStore.ts";
const FR_DIMS = "/extensions/FloatingRange/lib/frDimensions.ts";
const FR_VIEW = "/extensions/FloatingRange/lib/frView.ts";

const CMD = {
  HIDE_ROWS: "core.format.hideRows",
  UNHIDE_ROWS: "core.format.unhideRows",
  AUTOFIT_COLUMN_WIDTH: "core.format.autoFitColumnWidth",
  INSERT_FUNCTION: "core.formula.insertFunction",
} as const;

/** The Merge & Center warning (Excel's words; merge-excel.spec.ts). */
const MERGE_WARNING = "Merging cells only keeps the upper-left value and discards other values.";
/** The floating grid's refusal, any door (frKeyRouting.ts frSelectionRefusal). */
const FR_REFUSAL = /is not available inside a floating grid/;
/** Spec 1.3: the two permanent refusals and the shift refusal. */
const TABLE_REFUSAL =
  "Format as Table is not available inside a floating grid: a floating grid is already a table-like object. Nothing was changed.";
const FILTER_REFUSAL =
  "Filter is not available inside a floating grid: a floating grid is already a table-like object. Nothing was changed.";
const INSERT_CELLS_REFUSAL = /^Insert Cells is not available inside a floating grid yet\./;
/** formatPainterLogic.ts FR_PAINT_INTO_GRID_REFUSAL (BUG-0513, open). */
const PAINT_INTO_GRID_REFUSAL = /Format Painter cannot paint into a floating grid's cells yet/;

const WORK = path.join(os.tmpdir(), "calcula-floating-grid-home");
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TargetCell {
  row: number;
  col: number;
  display?: string;
  formula?: string | null;
  styleIndex?: number;
}

interface TargetRead {
  cells: TargetCell[];
  merges: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
  conditional: Array<{ row: number; col: number; dataBarPercent?: number }>;
  styles: Array<{ index: number; style: Record<string, unknown> }>;
  rules: unknown[];
}

interface FrRow extends FrInfo {
  rowHeights?: Record<string, number>;
  colWidths?: Record<string, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
}

interface Fixture {
  float1: FrInfo;
  sheet1Index: number;
}

interface Holder {
  conn: AwConnection | null;
  protected: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function ref(fr: { id: string }): { kind: "floatingRange"; id: string } {
  return { kind: "floatingRange", id: fr.id };
}

/** The grid's styled read (`get_cell_target_cells`), the read its renderer paints from. */
async function targetCells(page: Page, frId: string, rect: { r0: number; c0: number; r1: number; c1: number }): Promise<TargetRead> {
  return invoke<TargetRead>(page, "get_cell_target_cells", {
    target: { kind: "floatingRange", id: frId },
    startRow: rect.r0,
    startCol: rect.c0,
    endRow: rect.r1,
    endCol: rect.c1,
  });
}

async function targetCell(page: Page, frId: string, row: number, col: number): Promise<TargetCell | null> {
  const read = await targetCells(page, frId, { r0: row, c0: col, r1: row, c1: col });
  return read.cells.find((c) => c.row === row && c.col === col) ?? null;
}

async function styleOf(page: Page, index: number): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>(page, "get_style", { index });
}

/** The style of a floating grid's cell (index 0 when the cell is not stored). */
async function frStyle(page: Page, frId: string, row: number, col: number): Promise<Record<string, unknown> & { index: number }> {
  const index = (await targetCell(page, frId, row, col))?.styleIndex ?? 0;
  return { ...(await styleOf(page, index)), index };
}

async function frDisplay(page: Page, frId: string, row: number, col: number): Promise<string> {
  return String((await targetCell(page, frId, row, col))?.display ?? "");
}

/** The object row as the backend holds it (sizes, hidden lines, window). */
async function frRow(page: Page, frId: string): Promise<FrRow> {
  const row = (await frList(page)).find((f) => f.id === frId) as FrRow | undefined;
  if (!row) throw new Error(`floating grid ${frId} is not listed`);
  return row;
}

/** Sheet1!A1's style: the hidden-cell witness. */
async function hostCellStyle(page: Page, row: number, col: number): Promise<number> {
  return (await styleAt(page, row, col)).index;
}

async function decimalSeparator(page: Page): Promise<string> {
  // P2 (app locale) lands after P3 (ruling Q1): until then the async read.
  const s = await callModule<{ decimalSeparator?: string }>(page, API_LOCALE, "getLocaleSettings");
  const sep = String(s?.decimalSeparator ?? "");
  expect(sep.length, "the app locale's decimal separator read empty: a display comparison would prove nothing").toBeGreaterThan(0);
  return sep;
}

/** Digits after the decimal separator of a display ("1234,57" -> 2; no separator -> 0). */
function fractionDigits(display: string, sep: string): number {
  const at = display.lastIndexOf(sep);
  if (at < 0) return 0;
  return /^\d*/.exec(display.slice(at + sep.length))![0].length;
}

/** The digits of a display, for comparing numbers across group separators. */
function digitsOf(display: string): string {
  return display.replace(/[^0-9-]/g, "");
}

// ---------------------------------------------------------------------------
// Geometry and gestures
// ---------------------------------------------------------------------------

/** Page rect of a floating grid's cell, from the entry store's own geometry (sizes, hidden lines, scroll). */
async function frCellRect(page: Page, frId: string, row: number, col: number): Promise<PixelClip> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ id, row, col, mods }) => {
      const w = window as unknown as AppWindow;
      type Entry = { x: number; y: number };
      const store = (await w.__appImport!(mods.store)) as { getFloatingRangeById: (id: string) => Entry | null };
      const dims = (await w.__appImport!(mods.dims)) as {
        localCellOrigin: (e: Entry, r: number, c: number, v?: unknown) => { x: number; y: number };
        frColWidth: (e: Entry, c: number) => number;
        frRowHeight: (e: Entry, r: number) => number;
      };
      const view = (await w.__appImport!(mods.view)) as { getFrView: (e: Entry) => unknown };
      const e = store.getFloatingRangeById(id);
      if (!e) return null;
      const o = dims.localCellOrigin(e, row, col, view.getFrView(e));
      return { sx: e.x + o.x, sy: e.y + o.y, w: dims.frColWidth(e, col), h: dims.frRowHeight(e, row) };
    },
    { id: frId, row, col, mods: { store: FR_STORE, dims: FR_DIMS, view: FR_VIEW } },
  );
  if (!r) throw new Error(`floating grid ${frId} is not in the entry store`);
  const tl = await sheetPointToPage(page, r.sx, r.sy);
  const br = await sheetPointToPage(page, r.sx + r.w, r.sy + r.h);
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

/** The frame height the entry store derives (title + headers + visible rows). */
async function frFrameHeight(page: Page, frId: string): Promise<number> {
  await installAppImport(page);
  return page.evaluate(
    async ({ id, mods }) => {
      const w = window as unknown as AppWindow;
      const store = (await w.__appImport!(mods.store)) as { getFloatingRangeById: (id: string) => unknown };
      const dims = (await w.__appImport!(mods.dims)) as { frameHeight: (e: unknown) => number };
      const e = store.getFloatingRangeById(id);
      if (!e) throw new Error(`floating grid ${id} is not in the entry store`);
      return dims.frameHeight(e);
    },
    { id: frId, mods: { store: FR_STORE, dims: FR_DIMS } },
  );
}

async function redraw(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await callModule(page, API_GRID_OVERLAYS, "requestOverlayRedraw").catch(() => undefined);
  await page.waitForTimeout(400);
}

/** Click a floating grid's cell at its centre (the store's geometry) and wait until it is the grid's selection. */
async function frClick(page: Page, fr: { id: string }, row: number, col: number): Promise<void> {
  const box = await frCellRect(page, fr.id, row, col);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await eventually(
    () => frLocalSelection(page),
    (s) => s !== null && s.frId === fr.id && s.anchorRow === row && s.anchorCol === col,
    `clicking ${fr.id} (${row},${col}) did not select that cell`,
  );
}

/** Select a rectangle of a floating grid's cells: click its first cell, Shift+arrows to its last (the grid's own keys). */
async function frSelect(page: Page, fr: { id: string }, r0: number, c0: number, r1: number, c1: number): Promise<void> {
  await frClick(page, fr, r0, c0);
  await focusGrid(page);
  // Press until the edge is reached, not a fixed count: Shift+Down SKIPS a
  // hidden row, as in Excel, so over a hidden line a fixed count overshoots
  // (found live 2026-10-17: FG6 / FG14 select across hidden row 3). Bounded.
  const edge = async (): Promise<{ row: number; col: number }> => {
    const s = await frLocalSelection(page);
    return { row: s ? Math.max(s.anchorRow, s.endRow) : -1, col: s ? Math.max(s.anchorCol, s.endCol) : -1 };
  };
  for (let i = 0; i < 64 && (await edge()).row < r1; i++) await page.keyboard.press("Shift+ArrowDown");
  for (let i = 0; i < 64 && (await edge()).col < c1; i++) await page.keyboard.press("Shift+ArrowRight");
  await eventually(
    () => frLocalSelection(page),
    (s) => s !== null && s.frId === fr.id && Math.max(s.anchorRow, s.endRow) === r1 && Math.max(s.anchorCol, s.endCol) === c1,
    `the floating grid's selection did not reach (${r1},${c1})`,
  );
}

/** Click a cell of the ACTIVE worksheet as a user does. */
async function sheetClick(page: Page, row: number, col: number, delay = 0): Promise<void> {
  const p = await cellPagePoint(page, row, col);
  await page.mouse.click(p.x, p.y, { delay });
  await page.waitForTimeout(200);
}

async function undoOnce(page: Page): Promise<void> {
  await focusGrid(page);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
}

/** A patch inside a cell, inset from its edges (no gridline, no border). */
function patch(box: PixelClip, dx: number, dy: number, w: number, h: number): PixelClip {
  return { x: box.x + dx, y: box.y + dy, width: w, height: h };
}

/** The x of the dark-ink centroid of a sample (CSS px from its left), or null when it holds no ink. */
function inkCentroidX(s: PixelSample): number | null {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const i = (y * s.width + x) * 4;
      const l = 0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2];
      if (l < 110) {
        sum += x;
        n++;
      }
    }
  }
  return n === 0 ? null : sum / n / s.scale;
}

/** How many columns of a sample hold a non-white pixel (a data bar's reach). */
function colouredColumns(s: PixelSample): number {
  let cols = 0;
  for (let x = 0; x < s.width; x++) {
    for (let y = 0; y < s.height; y++) {
      const i = (y * s.width + x) * 4;
      if (s.data[i] < 235 || s.data[i + 1] < 235 || s.data[i + 2] < 235) {
        cols++;
        break;
      }
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// What the app SAID
// ---------------------------------------------------------------------------

/**
 * The one sentence a refused gesture said: a toast, or a native alert (the
 * row/column gestures refuse through `alertAsync`), which is dismissed here.
 */
async function saidOnce(page: Page, mark: number, label: string, timeoutMs = 6000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await toastsSince(page, mark);
    if (t.length > 0) return t.map((x) => x.message).join(" | ");
    if (appIsRunning() && visibleDialogs().length > 0) {
      const v = answerNativeDialog("Calcula", { action: "ok" }, 3000);
      if (!v.notFound) return v.text;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${label}: nothing was said (no toast, no native alert)`);
}

/** No floating-grid refusal since `mark` (the door ACTED). */
async function expectNoRefusal(page: Page, mark: number, door: string): Promise<void> {
  await page.waitForTimeout(400);
  const t = await toastsSince(page, mark);
  expect(t.filter((x) => FR_REFUSAL.test(x.message) || /not available/i.test(x.message)).map((x) => x.message), `${door}: refused`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Protection (the Protect Sheet dialog's own call)
// ---------------------------------------------------------------------------

async function protectHost(page: Page, holder: Holder, opts: { allowFormatRows?: boolean } = {}): Promise<void> {
  const res = await callModule<{ success: boolean; error?: string }>(page, MOD.BACKEND, "protectSheet", [
    {
      options: {
        allowSelectLockedCells: true,
        allowSelectUnlockedCells: true,
        allowFormatCells: false,
        allowFormatColumns: false,
        allowFormatRows: opts.allowFormatRows === true,
        allowInsertColumns: false,
        allowInsertRows: false,
        allowInsertHyperlinks: false,
        allowDeleteColumns: false,
        allowDeleteRows: false,
        allowSort: false,
        allowAutoFilter: false,
        allowPivotTables: false,
        allowEditObjects: false,
        allowEditScenarios: false,
      },
    },
  ]);
  if (!res.success) throw new Error(`protect_sheet refused: ${res.error}`);
  holder.protected = true;
  await callModule(page, MOD.PROTECTION_STORE, "refreshProtectionState");
}

async function unprotectHost(page: Page, holder: Holder): Promise<void> {
  const res = await callModule<{ success: boolean; error?: string }>(page, MOD.BACKEND, "unprotectSheet", []);
  if (!res.success) throw new Error(`unprotect_sheet refused: ${res.error}`);
  holder.protected = false;
  await callModule(page, MOD.PROTECTION_STORE, "refreshProtectionState");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function manifestVersion(file: string): number {
  if (!fs.existsSync(file)) throw new Error(`nothing was saved at ${file}`);
  const raw = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const bytes = raw["manifest.json"];
  if (!bytes) throw new Error(`${file} has no manifest.json (entries: ${Object.keys(raw).join(", ")})`);
  return (JSON.parse(new TextDecoder().decode(bytes)) as { formatVersion: number }).formatVersion;
}

async function saveTo(page: Page, file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  await invoke(page, "save_file", { path: file }, 60_000);
  await eventually(async () => fs.existsSync(file), (v) => v, `save_file wrote nothing at ${file}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function setup(page: Page): Promise<Fixture> {
  await newFile(page);
  const panes = await closeTaskPanes(page);
  expect(panes.isOpen, "setup: a task pane is still open after closing them").toBe(false);
  await startToastLog(page);
  await seedSheet1(page);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  const s = await sheetsResult(page);
  const sheet1Index = s.sheets[s.activeIndex].index;
  await ensureHomeTab(page);

  const float1 = await createFr(page, FLOAT1_AT.x, FLOAT1_AT.y, "Float1", FLOAT1_SIZE);
  const seed: Array<[number, number, string]> = [
    [0, 0, "c"],
    [1, 0, "a"],
    [2, 0, "d"],
    [3, 0, "b"],
    [0, 1, "1234.567"],
    [1, 1, "10"],
    [2, 1, "20"],
    [3, 1, "30"],
    [0, 2, "=B1*2"],
  ];
  for (const [r, c, v] of seed) await setFrCell(page, float1.id, r, c, v);
  await invoke(page, "update_cell", { row: 0, col: 3, value: "=Float1!B3" });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(400);

  // Core's active cell is A1: the hidden-cell witness.
  await sheetClick(page, 0, 0);
  // The backing sheet is never a tab.
  const listed = await sheets(page);
  expect(listed.sheets.some((x) => x.index === float1.backingSheetIndex), "the floating grid's backing sheet is listed by get_sheets").toBe(false);
  expect(await cellsOn(page, [[sheet1Index, 0, 3]]), "Sheet1!D1 = Float1!B3 did not read the grid").toEqual(["20"]);
  await eventually(() => frCell(page, float1.id, 0, 2), (c) => c !== null && String(c.formula ?? "").replace(/\s/g, "") === "=B1*2", "Float1!C1 was not seeded");
  return { float1, sheet1Index };
}

async function teardown(page: Page, holder: Holder): Promise<{ isOpen: boolean; openPanes: number }> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await closeHomeFlyouts(page).catch(() => undefined);
  await closeCanvasFlyouts(page).catch(() => undefined);
  await closeDialogsAndOverlays(page).catch(() => undefined);
  for (const d of appIsRunning() ? visibleDialogs() : []) answerNativeDialog(d.title, { action: "cancel" }, 2_000);
  if (holder.protected) await unprotectHost(page, holder).catch(() => undefined);
  await callModule(page, FORMAT_PAINTER_STATE, "clearFormatPainterState").catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
  await dropAdventureWorks(page, holder.conn);
  holder.conn = null;
  const panes = await closeTaskPanes(page).catch(() => ({ isOpen: true, openPanes: -1 }));
  await newFile(page).catch(() => undefined);
  return panes;
}

test.beforeEach(async ({ appPage }) => {
  await closeObjectPaneForGood(appPage);
});

// ===========================================================================
// The journeys
// ===========================================================================

test.describe("floating grids take every Home command (round 2 P3, G3)", () => {
  test("FG1 owner case: Decrease Decimal on Float1!B1 acts on the grid -- one fewer fraction digit in the app locale, the grid paints what the read says, Sheet1!A1 untouched, dirty, one undo step names it, Ctrl+Z restores", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const sep = await decimalSeparator(page);
      const before = await frDisplay(page, float1.id, 0, 1);
      expect(fractionDigits(before, sep), `precondition: B1 shows 1234.567 with three decimals in the app locale (${before})`).toBe(3);
      const a1Style = await hostCellStyle(page, 0, 0);
      // The SAME coordinates on the active sheet: a write routed to the active
      // sheet as well as the backing one lands on Sheet1!B1, not on A1 (found
      // live 2026-10-17: sabotage SB1 left A1 alone and passed).
      const b1HostStyle = await hostCellStyle(page, 0, 1);

      // A clean document first, so "dirty" means THIS gesture.
      await saveTo(page, path.join(WORK, `fg1-${RUN}.cala`));
      expect(await isDirty(page), "precondition: the saved document is clean").toBe(false);

      await frClick(page, float1, 0, 1);
      await startStyledTextRecorder(page);
      const mark = await toastMark(page);
      await clickHomeControl(page, "fmt-decreaseDecimal");
      const after = await eventually(() => frDisplay(page, float1.id, 0, 1), (d) => d !== before, "Decrease Decimal did not change Float1!B1");
      await expectNoRefusal(page, mark, "Decrease Decimal");
      expect(fractionDigits(after, sep), `Decrease Decimal: "${before}" -> "${after}" is not one fraction digit fewer`).toBe(2);
      const b1 = await targetCell(page, float1.id, 0, 1);
      expect(String((await styleOf(page, b1?.styleIndex ?? 0)).numberFormat ?? ""), "the backing B1 carries no format with two decimals").toMatch(/0[.,]00|\(2 decimals\)/);
      // The grid PAINTS the styled read's display.
      await redraw(page);
      await eventually(() => recordedStyledTexts(page), (t) => t.some((x) => x.text === after), `the grid never painted "${after}"`);
      // The hidden-cell witness.
      expect(await hostCellStyle(page, 0, 0), "Sheet1!A1's style changed (the hidden cell was written)").toBe(a1Style);
      expect(await hostCellStyle(page, 0, 1), "Sheet1!B1's style changed (the write also reached the active sheet at the grid's coordinates)").toBe(b1HostStyle);
      expect(await isDirty(page), "Decrease Decimal on the grid did not dirty the document").toBe(true);
      expect(String((await undoState(page)).undoDescription ?? ""), "the undo step does not name the format").toMatch(/Decimal|Format/i);

      await undoOnce(page);
      await eventually(() => frDisplay(page, float1.id, 0, 1), (d) => d === before, "one Ctrl+Z did not restore Float1!B1's display");
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG1").toBe(false);
  });

  test("FG2 Bold, Fill yellow, All Borders, Center and Wrap on Float1!B2:C3 -- the backing styles carry each flag; pixels: B2 is yellow and C4 is not, the shared B2/C2 edge is darker than the fill, Center moves the ink toward the centre; Sheet1!A1 untouched", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const a1Style = await hostCellStyle(page, 0, 0);
      const cells: Array<[number, number]> = [
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
      ];
      await frSelect(page, float1, 1, 1, 2, 2);
      const mark = await toastMark(page);

      await clickHomeControl(page, "fmt-bold");
      await eventually(async () => (await Promise.all(cells.map(([r, c]) => frStyle(page, float1.id, r, c)))).every((s) => s.bold === true), (v) => v, "Bold did not reach every cell of B2:C3");

      await clickHomeControl(page, "fmt-backgroundColor-options");
      const hex = page.locator('[data-testid="fmt-backgroundColor-popover-hex"]').filter({ visible: true }).first();
      await hex.fill("#FFFF00");
      await hex.press("Enter");
      await eventually(
        async () => (await Promise.all(cells.map(([r, c]) => frStyle(page, float1.id, r, c)))).every((s) => String(s.backgroundColor).toLowerCase().includes("ffff00")),
        (v) => v,
        "Fill yellow did not reach every cell of B2:C3",
      );
      await closeHomeFlyouts(page);

      await clickHomeMenuRow(page, "fmt-borders-options", "fmt-borders-all");
      await eventually(
        async () => {
          const s = await frStyle(page, float1.id, 1, 1);
          const right = s.borderRight as { style?: string } | undefined;
          return !!right && !!right.style && right.style !== "none";
        },
        (v) => v,
        "All Borders put no right border on B2",
      );

      // Ink before Center (B2 holds the number 10: General right-aligns it).
      await frClick(page, float1, 0, 3); // park the selection away from B2:C3
      await redraw(page);
      const b2 = await frCellRect(page, float1.id, 1, 1);
      const [inkBefore] = await samplePixelGrids(page, [patch(b2, 2, 2, b2.width - 4, b2.height - 4)]);
      const xBefore = inkCentroidX(inkBefore);
      expect(xBefore, "precondition: B2 shows no ink before Center").not.toBeNull();

      await frSelect(page, float1, 1, 1, 2, 2);
      await clickHomeControl(page, "fmt-alignCenter");
      await clickHomeControl(page, "fmt-wrapText");
      await eventually(
        async () => (await Promise.all(cells.map(([r, c]) => frStyle(page, float1.id, r, c)))).every((s) => s.textAlign === "center" && s.wrapText === true),
        (v) => v,
        "Center and Wrap did not reach every cell of B2:C3",
      );
      await expectNoRefusal(page, mark, "Bold / Fill / Borders / Center / Wrap");

      // ---- Pixels (one unclipped capture). ----
      await frClick(page, float1, 0, 3);
      await redraw(page);
      const b2Now = await frCellRect(page, float1.id, 1, 1);
      const c4 = await frCellRect(page, float1.id, 3, 2);
      const edgeX = b2Now.x + b2Now.width - 1.5;
      const [b2Fill, c4Fill, edge, inkAfter] = await samplePixelGrids(page, [
        patch(b2Now, 3, 3, 6, 3),
        patch(c4, 3, 3, 6, 3),
        { x: edgeX, y: b2Now.y + 3, width: 3, height: 4 },
        patch(b2Now, 2, 2, b2Now.width - 4, b2Now.height - 4),
      ]);
      const [r, g, b] = averageRgb(b2Fill);
      expect(r > 200 && g > 200 && b < 80, `B2's interior is not yellow: rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`).toBe(true);
      const [r4, g4, b4] = averageRgb(c4Fill);
      expect(b4 > 150, `C4 (outside B2:C3) is yellow too: rgb(${r4.toFixed(0)},${g4.toFixed(0)},${b4.toFixed(0)})`).toBe(true);
      expect(luminance(edge), "the B2/C2 shared edge is not darker than the fill (no border painted)").toBeLessThan(luminance(b2Fill) - 20);
      const xAfter = inkCentroidX(inkAfter);
      expect(xAfter, "B2 shows no ink after Center").not.toBeNull();
      const centre = b2Now.width / 2 - 2;
      expect(Math.abs(xAfter! - centre), `Center did not move B2's ink toward the centre (before ${xBefore}, after ${xAfter}, centre ${centre})`).toBeLessThan(Math.abs(xBefore! - centre) - 2);

      expect(await hostCellStyle(page, 0, 0), "Sheet1!A1's style changed").toBe(a1Style);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG2").toBe(false);
  });

  test("FG3 the ribbon's state follows the floating grid's cell: Bold pressed on a bold B2, not on Sheet1!A2 or a plain B4", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      await frClick(page, float1, 1, 1);
      await clickHomeControl(page, "fmt-bold");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => s.bold === true, "precondition: B2 did not turn bold");
      const pressed = () => page.locator('[data-testid="fmt-bold"]').filter({ visible: true }).first().getAttribute("aria-pressed");

      await frClick(page, float1, 3, 1);
      await frClick(page, float1, 1, 1);
      await expect.poll(pressed, { timeout: 5_000, message: "Bold is not pressed on the bold floating-grid cell B2" }).toBe("true");
      await sheetClick(page, 1, 0);
      await expect.poll(pressed, { timeout: 5_000, message: "Bold is still pressed on the plain Sheet1!A2" }).toBe("false");
      await frClick(page, float1, 3, 1);
      await expect.poll(pressed, { timeout: 5_000, message: "Bold is pressed on the plain floating-grid cell B4" }).toBe("false");
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG3").toBe(false);
  });

  test("FG4 Clear Formats on B2:C3 removes the fill (pixel back to white); Delete on B2:B4 empties the cells as ONE undo step", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      await frSelect(page, float1, 1, 1, 2, 2);
      await clickHomeControl(page, "fmt-backgroundColor-options");
      const hex = page.locator('[data-testid="fmt-backgroundColor-popover-hex"]').filter({ visible: true }).first();
      await hex.fill("#FFFF00");
      await hex.press("Enter");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => String(s.backgroundColor).toLowerCase().includes("ffff00"), "precondition: B2 was not filled");
      await closeHomeFlyouts(page);

      await frSelect(page, float1, 1, 1, 2, 2);
      await clickHomeMenuRow(page, "fmt-clear", "fmt-clear-formats");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => !String(s.backgroundColor ?? "").toLowerCase().includes("ffff00"), "Clear Formats left B2's fill");
      expect(await frDisplay(page, float1.id, 1, 1), "Clear Formats cleared B2's VALUE").toBe("10");
      await frClick(page, float1, 0, 3);
      await redraw(page);
      const b2 = await frCellRect(page, float1.id, 1, 1);
      const [fill] = await samplePixelGrids(page, [patch(b2, 3, 3, 6, 3)]);
      const [r, g, b] = averageRgb(fill);
      expect(r > 225 && g > 225 && b > 225, `B2 is not back to white after Clear Formats: rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`).toBe(true);

      // Delete on B2:B4: ONE undo step restores all three.
      await frSelect(page, float1, 1, 1, 3, 1);
      const depth = (await undoState(page)).undoDepth;
      await focusGrid(page);
      await page.keyboard.press("Delete");
      await eventually(
        async () => [await frDisplay(page, float1.id, 1, 1), await frDisplay(page, float1.id, 2, 1), await frDisplay(page, float1.id, 3, 1)],
        (v) => v.every((x) => x === ""),
        "Delete did not empty B2:B4",
      );
      expect((await undoState(page)).undoDepth, "Delete on three cells is not ONE undo step").toBe(depth + 1);
      await undoOnce(page);
      await eventually(
        async () => [await frDisplay(page, float1.id, 1, 1), await frDisplay(page, float1.id, 2, 1), await frDisplay(page, float1.id, 3, 1)],
        (v) => v.join("|") === "10|20|30",
        "one Ctrl+Z did not restore all three of B2:B4",
      );
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG4").toBe(false);
  });

  test("FG5 Sort A to Z on Float1!A1:B4: A reads a,b,c,d and the B values travel with their rows; Sheet1!D1 keeps =Float1!B3 and now reads 1234.567 (Excel's sort moves values, never references)", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1, sheet1Index } = await setup(page);
      const sep = await decimalSeparator(page);
      await frSelect(page, float1, 0, 0, 3, 1);
      const mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-sortFilter", "fmt-sortFilter-ascending");
      await eventually(
        async () => Promise.all([0, 1, 2, 3].map((r) => frDisplay(page, float1.id, r, 0))),
        (v) => v.join(",") === "a,b,c,d",
        "Sort A to Z did not order Float1!A1:A4",
      );
      await expectNoRefusal(page, mark, "Sort A to Z");
      const b = await Promise.all([0, 1, 2, 3].map((r) => frDisplay(page, float1.id, r, 1)));
      expect(b.map(digitsOf), `the B values did not travel with their rows (${b.join(" | ")})`).toEqual(["10", "30", "1234567", "20"]);
      expect(fractionDigits(b[2], sep), "B3's display lost its decimals").toBe(3);
      const d1 = await cellAt(page, 0, 3);
      expect(String(d1?.formula ?? "").replace(/\s/g, ""), "Sort rewrote Sheet1!D1's reference (Excel's sort never does)").toMatch(/^=Float1!B3$/i);
      expect(digitsOf((await cellsOn(page, [[sheet1Index, 0, 3]]))[0]), "Sheet1!D1 does not read the value that travelled into B3").toBe("1234567");
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG5").toBe(false);
  });

  test("FG6 line sizes and hide: Row Height 40 px on row 2 sets the OBJECT's map and grows the frame by 20, the host's heights untouched; Hide Rows on row 3 hides it (row 4's text moves up), Unhide restores; AutoFit sets a column width; on a protected host Format Rows decides", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const hostHeights = await invoke<unknown[]>(page, "get_all_row_heights");
      const frameBefore = await frFrameHeight(page, float1.id);

      const rowHeightDialog = async (points: string): Promise<void> => {
        await clickHomeMenuRow(page, "fmt-formatMenu", "fmt-formatMenu-rowHeight");
        await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "core:dimension-input"), "Row Height opened no dialog");
        const input = page.locator('input[inputmode="decimal"]').filter({ visible: true }).first();
        await input.fill(points);
        await input.press("Enter");
        await page.waitForTimeout(500);
      };

      // Row Height: 30 pt = 40 px (the dialog speaks points, like Excel).
      await frClick(page, float1, 1, 1);
      await rowHeightDialog("30");
      await eventually(async () => (await frRow(page, float1.id)).rowHeights?.["1"], (h) => h === 40, "Row Height did not set the object's rowHeights[1] = 40");
      await eventually(() => frFrameHeight(page, float1.id), (h) => Math.abs(h - (frameBefore + 20)) < 0.5, "the frame did not grow by 20 px");
      expect(await invoke<unknown[]>(page, "get_all_row_heights"), "Row Height on the grid changed the HOST sheet's row heights").toEqual(hostHeights);

      // Hide Rows on row 3: row 4's text takes the old row-3 band.
      await frClick(page, float1, 0, 3);
      await redraw(page);
      const band3 = await frCellRect(page, float1.id, 2, 0);
      const band4 = await frCellRect(page, float1.id, 3, 0);
      const wide = (b: PixelClip): PixelClip => ({ x: b.x + 2, y: b.y + 2, width: b.width * 2 - 4, height: b.height - 4 });
      const [row3Before, row4Before] = await samplePixelGrids(page, [wide(band3), wide(band4)]);
      expect(diffCount(row3Before, row4Before), "precondition: rows 3 and 4 paint alike, so the hide could not be seen").toBeGreaterThan(10);

      await frClick(page, float1, 2, 1);
      await executeCommand(page, CMD.HIDE_ROWS);
      await eventually(async () => (await frRow(page, float1.id)).hiddenRows ?? [], (h) => JSON.stringify(h) === "[2]", "Hide Rows did not set the object's hiddenRows = [2]");
      await frClick(page, float1, 0, 3);
      await redraw(page);
      const [row3After] = await samplePixelGrids(page, [wide(band3)]);
      const total = row3After.width * row3After.height;
      expect(diffCount(row3After, row4Before), "the old row-3 band does not show row 4 after the hide").toBeLessThan(total * 0.05);

      await frSelect(page, float1, 1, 1, 3, 1);
      await executeCommand(page, CMD.UNHIDE_ROWS);
      await eventually(async () => (await frRow(page, float1.id)).hiddenRows ?? [], (h) => h.length === 0, "Unhide Rows did not clear the object's hidden rows");

      // AutoFit Column Width on A: a width from the text.
      await frClick(page, float1, 0, 0);
      await executeCommand(page, CMD.AUTOFIT_COLUMN_WIDTH);
      await eventually(async () => (await frRow(page, float1.id)).colWidths?.["0"], (w) => typeof w === "number" && w > 0, "AutoFit set no width on the object's column A");

      // Protected host, Format Rows ALLOWED (Edit Objects not): Row Height still works.
      await protectHost(page, holder, { allowFormatRows: true });
      await frClick(page, float1, 1, 1);
      await rowHeightDialog("15");
      await eventually(async () => (await frRow(page, float1.id)).rowHeights?.["1"], (h) => h === 20, "Row Height on a protected host with Format Rows allowed did not apply");
      await unprotectHost(page, holder);

      // Format Rows NOT allowed: refused, nothing changes.
      await protectHost(page, holder, { allowFormatRows: false });
      await frClick(page, float1, 1, 1);
      const mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-formatMenu", "fmt-formatMenu-rowHeight");
      // Wait for the door's answer -- its dialog, or a refusal said at once. The
      // old `() => true` read the dialogs before the menu row's dialog had
      // opened, so nothing was typed and the test waited for a refusal that
      // only the DIALOG's OK can produce (found live 2026-10-17).
      const answer = await eventually(
        async () => ({ dialogs: await openDialogs(page), said: await toastsSince(page, mark) }),
        (a) => a.dialogs.some((x) => x.id === "core:dimension-input") || a.said.length > 0,
        "Row Height on a protected host neither opened its dialog nor said why",
      );
      if (answer.dialogs.some((x) => x.id === "core:dimension-input")) {
        const input = page.locator('input[inputmode="decimal"]').filter({ visible: true }).first();
        await input.fill("30");
        await input.press("Enter");
      }
      const said = await saidOnce(page, mark, "Row Height on a protected host without Format Rows");
      expect(said, "the refusal does not say the sheet is protected").toMatch(/protect/i);
      expect((await frRow(page, float1.id)).rowHeights?.["1"], "Row Height applied on a protected host without Format Rows").toBe(20);
      await unprotectHost(page, holder);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG6").toBe(false);
  });

  test("FG7 table-like structure: Insert Sheet Rows at B2 grows the window to 6, shifts the content and re-points Sheet1!D1 to =Float1!B4; one Ctrl+Z restores all three; deleting every row refuses; inserting past 1000 rows refuses", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      await frClick(page, float1, 1, 1);
      const mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-insertCells-options", "fmt-insertCells-rows");
      await eventually(async () => (await frRow(page, float1.id)).rowCount, (n) => n === 6, "Insert Sheet Rows did not grow the window to 6 rows");
      await expectNoRefusal(page, mark, "Insert Sheet Rows");
      expect(await frDisplay(page, float1.id, 1, 1), "the inserted row 2 is not empty").toBe("");
      expect(await frDisplay(page, float1.id, 2, 1), "the content did not shift down").toBe("10");
      await eventually(async () => String((await cellAt(page, 0, 3))?.formula ?? "").replace(/\s/g, ""), (f) => /^=Float1!B4$/i.test(f), "Sheet1!D1 was not re-pointed to =Float1!B4");

      await undoOnce(page);
      await eventually(async () => (await frRow(page, float1.id)).rowCount, (n) => n === 5, "one Ctrl+Z did not restore the window's 5 rows");
      expect(await frDisplay(page, float1.id, 1, 1), "one Ctrl+Z did not restore B2").toBe("10");
      await eventually(async () => String((await cellAt(page, 0, 3))?.formula ?? "").replace(/\s/g, ""), (f) => /^=Float1!B3$/i.test(f), "one Ctrl+Z did not restore Sheet1!D1's formula");

      // Deleting EVERY row of the window refuses.
      await frSelect(page, float1, 0, 0, 4, 0);
      const m2 = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-deleteCells-options", "fmt-deleteCells-rows");
      expect(await saidOnce(page, m2, "Delete Sheet Rows over every row"), "deleting every row did not refuse with the last-row rule").toMatch(/keeps at least one row/);
      expect((await frRow(page, float1.id)).rowCount, "a refused delete changed the window").toBe(5);

      // Past the 1000-row cap: a 1000-row window takes no inserted row.
      await callModule(page, FLOATING_RANGES, "updateFloatingRange", [float1.id, { rowCount: 1000 }]);
      await eventually(async () => (await frRow(page, float1.id)).rowCount, (n) => n === 1000, "precondition: the window did not grow to 1000 rows");
      await frClick(page, float1, 1, 1);
      const m3 = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-insertCells-options", "fmt-insertCells-rows");
      expect(await saidOnce(page, m3, "Insert Sheet Rows at the cap"), "inserting past 1000 rows did not refuse").toMatch(/holds at most 1000 rows/);
      expect((await frRow(page, float1.id)).rowCount, "a refused insert changed the window").toBe(1000);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG7").toBe(false);
  });

  test("FG8 clipboard: Float1!C1 (=B1*2) pasted on Sheet1!F12 reads =E12*2; Sheet1!A1:A2 pasted into Float1!D1 lands on the grid; Paste Special Values onto D2; Format Painter from bold B2 to Sheet1!A3 paints, and from Sheet1 into the grid refuses (BUG-0513)", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1, sheet1Index } = await setup(page);
      // Grid -> sheet: the relative reference shifts on BACKING coordinates.
      await frClick(page, float1, 0, 2);
      await focusGrid(page);
      await page.keyboard.press("Control+c");
      // F12, not F5: at this display F5 (sheet px 320..384 x 80..100) lies UNDER
      // Float1's title bar (320.., 80..), so the "sheet click" landed on the grid
      // and the paste went back into Float1!C1 (found live 2026-10-17). Row 12
      // starts at 220, below the grid's frame (80 + 136).
      await sheetClick(page, 11, 5);
      await focusGrid(page);
      await page.keyboard.press("Control+v");
      await eventually(async () => String((await cellAt(page, 11, 5))?.formula ?? "").replace(/\s/g, ""), (f) => /^=E12\*2$/i.test(f), "Float1!C1 pasted on Sheet1!F12 does not read =E12*2");
      await page.keyboard.press("Escape");

      // Sheet -> grid: lands on the grid, not on Core's hidden cell.
      const a1Before = (await cellsOn(page, [[sheet1Index, 0, 0]]))[0];
      await sheetClick(page, 0, 0);
      await page.keyboard.down("Shift");
      await sheetClick(page, 1, 0);
      await page.keyboard.up("Shift");
      await focusGrid(page);
      await page.keyboard.press("Control+c");
      await frClick(page, float1, 0, 3);
      await focusGrid(page);
      await page.keyboard.press("Control+v");
      await eventually(
        async () => [await frDisplay(page, float1.id, 0, 3), await frDisplay(page, float1.id, 1, 3)],
        (v) => v[0] === "Month" && v[1] === "Jan",
        "Sheet1!A1:A2 did not land in Float1!D1:D2",
      );
      expect((await cellsOn(page, [[sheet1Index, 0, 0]]))[0], "the paste wrote Sheet1!A1").toBe(a1Before);
      await page.keyboard.press("Escape");

      // Paste Special > Values onto D2: C1's VALUE, no formula.
      await frClick(page, float1, 0, 2);
      await focusGrid(page);
      await page.keyboard.press("Control+c");
      await frClick(page, float1, 1, 3);
      await clickHomeMenuRow(page, "fmt-paste-options", "fmt-paste-values");
      await eventually(() => frCell(page, float1.id, 1, 3), (c) => c !== null && !c.formula && digitsOf(String(c.display ?? c.value ?? "")) === "2469134", "Paste Values did not write C1's value into Float1!D2");
      await page.keyboard.press("Escape");

      // Format Painter: grid -> sheet paints.
      await frClick(page, float1, 1, 1);
      await clickHomeControl(page, "fmt-bold");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => s.bold === true, "precondition: B2 did not turn bold");
      await clickHomeControl(page, "fmt-formatPainter");
      await eventually(() => callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"), (v) => v, "Format Painter did not arm on the grid's B2");
      await sheetClick(page, 2, 0, 150);
      await eventually(() => styleAt(page, 2, 0), (s) => s.bold === true, "Format Painter from Float1!B2 did not bold Sheet1!A3");

      // Sheet -> grid: refused until BUG-0513 (no style-index command takes a target).
      await sheetClick(page, 2, 0);
      await clickHomeControl(page, "fmt-formatPainter");
      await eventually(() => callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"), (v) => v, "Format Painter did not arm on Sheet1!A3");
      const mark = await toastMark(page);
      await frClick(page, float1, 3, 0);
      const said = await saidOnce(page, mark, "Format Painter into the grid");
      expect(said, "painting into the grid did not say why it refused").toMatch(PAINT_INTO_GRID_REFUSAL);
      expect((await frStyle(page, float1.id, 3, 0)).bold, "Format Painter painted into the grid's A4 anyway").not.toBe(true);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG8").toBe(false);
  });

  test("FG9 editing: Fill Down B1 to B1:B2; AutoSum at B5 writes =SUM(B1:B4); Insert Function opens the FLOATING-GRID editor, never Core's", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const b1 = await frDisplay(page, float1.id, 0, 1);
      await frSelect(page, float1, 0, 1, 1, 1);
      await clickHomeMenuRow(page, "fmt-fill", "fmt-fill-down");
      await eventually(() => frDisplay(page, float1.id, 1, 1), (d) => d === b1, "Fill Down did not copy B1 into B2");

      await frClick(page, float1, 4, 1);
      await clickHomeControl(page, "fmt-autoSum");
      await eventually(
        async () => ((await frEditorOpen(page)) ? (await frEditText(page)).replace(/\s/g, "") : String((await frCell(page, float1.id, 4, 1))?.formula ?? "")),
        (t) => /^=SUM\(B1:B4\)$/i.test(t),
        "AutoSum at B5 did not propose =SUM(B1:B4)",
      );
      if (await frEditorOpen(page)) await page.keyboard.press("Enter");
      await eventually(async () => String((await frCell(page, float1.id, 4, 1))?.formula ?? "").replace(/\s/g, ""), (f) => /^=SUM\(B1:B4\)$/i.test(f), "AutoSum did not write =SUM(B1:B4) into B5");

      await frClick(page, float1, 4, 3);
      await executeCommand(page, CMD.INSERT_FUNCTION);
      await eventually(async () => (await frEditorOpen(page)) && (await frEditText(page)).length > 0, (v) => v, "Insert Function did not open the floating grid's editor");
      expect(await coreEditOpen(page), "Insert Function opened Core's hidden cell's editor").toBe(false);
      await page.keyboard.press("Escape");
      await closeDialogsAndOverlays(page);
      await page.keyboard.press("Escape");
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG9").toBe(false);
  });

  test("FG10 Merge & Center on Float1!A1:B1 (Q4: the sheet's gesture): the warning, A1 keeps c, B1 empty, centred; no gridline at the old A1/B1 boundary; clicking the B1 half selects A1:B1; ONE Ctrl+Z restores", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const b1Before = await frDisplay(page, float1.id, 0, 1);
      // The old boundary: a thin strip in the row's top, where no glyph reaches.
      await frClick(page, float1, 2, 3);
      await redraw(page);
      const a1Box = await frCellRect(page, float1.id, 0, 0);
      const strip: PixelClip = { x: a1Box.x + a1Box.width - 1.5, y: a1Box.y + 2, width: 3, height: 3 };
      const [lineBefore] = await samplePixelGrids(page, [strip]);

      await frSelect(page, float1, 0, 0, 0, 1);
      await clickHomeControl(page, "fmt-mergeCells");
      const yes = answerNativeDialog("Calcula", { action: "ok" });
      expect(yes.notFound, `no merge warning appeared (driver: ${yes.raw})`).toBe(false);
      expect(yes.text).toContain(MERGE_WARNING);
      await eventually(
        async () => (await targetCells(page, float1.id, { r0: 0, c0: 0, r1: 0, c1: 3 })).merges,
        (m) => m.some((x) => x.startRow === 0 && x.startCol === 0 && x.endRow === 0 && x.endCol === 1),
        "A1:B1 is not merged on the grid",
      );
      expect(await frDisplay(page, float1.id, 0, 0), "A1 did not keep its value").toBe("c");
      expect(await frDisplay(page, float1.id, 0, 1), "B1's value survived the merge").toBe("");
      expect((await frStyle(page, float1.id, 0, 0)).textAlign, "the merge is not centred").toBe("center");

      await frClick(page, float1, 2, 3);
      await redraw(page);
      const [lineAfter] = await samplePixelGrids(page, [strip]);
      expect(luminance(lineAfter), "a gridline is still drawn at the old A1/B1 boundary inside the merge").toBeGreaterThan(luminance(lineBefore) + 10);

      // Clicking the B1 half selects the whole merge, A1 active.
      const b1Box = await frCellRect(page, float1.id, 0, 1);
      await page.mouse.click(b1Box.x + b1Box.width * 0.75, b1Box.y + b1Box.height / 2);
      await eventually(
        () => frLocalSelection(page),
        (s) => s !== null && s.anchorRow === 0 && s.anchorCol === 0 && Math.max(s.anchorCol, s.endCol) === 1,
        "clicking the B1 half did not select A1:B1 with A1 active",
      );

      await undoOnce(page);
      await eventually(
        async () => (await targetCells(page, float1.id, { r0: 0, c0: 0, r1: 0, c1: 3 })).merges.length,
        (n) => n === 0,
        "one Ctrl+Z did not remove the merge",
      );
      expect(await frDisplay(page, float1.id, 0, 1), "one Ctrl+Z did not restore B1").toBe(b1Before);
      expect((await frStyle(page, float1.id, 0, 0)).textAlign, "one Ctrl+Z did not remove the centring").not.toBe("center");
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG10").toBe(false);
  });

  test("FG11 Conditional Formatting on Float1!B2:B4: Greater Than 15 marks B3 and B4 (state and pixels), not B2; Data Bars reach further on B4 than on B2; Sheet1 has NO rules", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      await frSelect(page, float1, 1, 1, 3, 1);
      await clickHomeControl(page, "fmt-conditionalFormatting");
      const highlight = page.getByTestId("cf:highlightCells").filter({ visible: true }).first();
      await highlight.waitFor({ state: "visible", timeout: 5_000 });
      await highlight.click();
      const greater = page.getByTestId("cf:greaterThan").filter({ visible: true }).first();
      await greater.waitFor({ state: "visible", timeout: 5_000 });
      await greater.click();
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "cf-quick-dialog"), "Greater Than opened no dialog");
      // The value field has the focus (autoFocus): type the threshold, Enter is OK.
      await page.waitForTimeout(300);
      await page.keyboard.press("Control+a");
      await page.keyboard.type("15");
      await page.keyboard.press("Enter");
      const marked = await eventually(
        async () => (await targetCells(page, float1.id, { r0: 0, c0: 0, r1: 4, c1: 3 })).conditional.map((x) => `${x.row},${x.col}`).sort(),
        (v) => v.includes("2,1") && v.includes("3,1"),
        "Greater Than 15 marked neither B3 nor B4",
      );
      expect(marked, "Greater Than 15 marked B2 (10)").not.toContain("1,1");
      expect(await invoke<unknown[]>(page, "get_all_conditional_formats"), "the rule landed on Sheet1").toEqual([]);

      await frClick(page, float1, 0, 3);
      await redraw(page);
      const [b2, b3, b4] = await Promise.all([1, 2, 3].map((r) => frCellRect(page, float1.id, r, 1)));
      const [p2, p3, p4] = await samplePixelGrids(page, [patch(b2, 3, 3, 6, 3), patch(b3, 3, 3, 6, 3), patch(b4, 3, 3, 6, 3)]);
      expect(diffCount(p2, p3), "B3 paints like B2: no conditional fill").toBeGreaterThan((p3.width * p3.height) / 2);
      expect(diffCount(p3, p4), "B3 and B4 do not paint the same rule").toBeLessThan((p3.width * p3.height) / 4);
      const [lr, lg, lb] = averageRgb(p2);
      expect(lr > 225 && lg > 225 && lb > 225, "B2 (10) is filled though 10 is not > 15").toBe(true);

      // Data Bars on B2:B4 (clear the highlight first so only the bars paint).
      await frSelect(page, float1, 1, 1, 3, 1);
      await clickHomeControl(page, "fmt-conditionalFormatting");
      const clear = page.getByTestId("cf:clearRules").filter({ visible: true }).first();
      await clear.waitFor({ state: "visible", timeout: 5_000 });
      await clear.click();
      const fromSelection = page.getByTestId("cf:clearFromSelection").filter({ visible: true }).first();
      await fromSelection.waitFor({ state: "visible", timeout: 5_000 });
      await fromSelection.click();
      await eventually(async () => (await targetCells(page, float1.id, { r0: 0, c0: 0, r1: 4, c1: 3 })).conditional.length, (n) => n === 0, "the highlight rule was not cleared");
      await frSelect(page, float1, 1, 1, 3, 1);
      await clickHomeControl(page, "fmt-conditionalFormatting");
      const bars = page.getByTestId("cf:dataBars").filter({ visible: true }).first();
      await bars.waitFor({ state: "visible", timeout: 5_000 });
      await bars.click();
      await page.locator('button[title^="Gradient"]').filter({ visible: true }).first().click();
      await eventually(
        async () => (await targetCells(page, float1.id, { r0: 1, c0: 1, r1: 3, c1: 1 })).conditional.filter((x) => typeof x.dataBarPercent === "number").length,
        (n) => n === 3,
        "Data Bars produced no bar for B2:B4",
      );
      // A band across the middle of each cell: the bar's reach (the right-aligned digits are alike in both).
      await frClick(page, float1, 0, 3);
      await redraw(page);
      const [q2, q4] = await samplePixelGrids(page, [patch(b2, 1, b2.height / 2 - 1, b2.width - 2, 2), patch(b4, 1, b4.height / 2 - 1, b4.width - 2, 2)]);
      expect(colouredColumns(q4), "B4's bar does not reach further than B2's").toBeGreaterThan(colouredColumns(q2) + 3);
      expect(await invoke<unknown[]>(page, "get_all_conditional_formats"), "a rule landed on Sheet1").toEqual([]);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG11").toBe(false);
  });

  test("FG12 refusals and protection: Format as Table and Filter say why and change nothing; on a protected host Bold and typing are refused, after Unprotect both work; Find d finds Float1!A3; Insert Cells (shift down) refuses", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      const { float1 } = await setup(page);
      const depth0 = (await undoState(page)).undoDepth;

      // Format as Table.
      await frClick(page, float1, 1, 1);
      let mark = await toastMark(page);
      await clickHomeControl(page, "fmt-formatAsTable");
      const gallery = page.getByTestId("format-as-table-gallery").filter({ visible: true }).first();
      await gallery.waitFor({ state: "visible", timeout: 5_000 });
      await gallery.locator('[role="option"]').first().click();
      expect(await saidOnce(page, mark, "Format as Table"), "Format as Table did not refuse with its sentence").toContain(TABLE_REFUSAL);
      await closeDialogsAndOverlays(page);

      // Filter.
      await frClick(page, float1, 1, 1);
      mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-sortFilter", "fmt-sortFilter-filter");
      expect(await saidOnce(page, mark, "Filter"), "Filter did not refuse with its sentence").toContain(FILTER_REFUSAL);
      expect(await invoke(page, "get_auto_filter"), "Filter put an AutoFilter on Sheet1").toBeNull();
      expect((await undoState(page)).undoDepth, "a refusal added an undo step").toBe(depth0);

      // Protected host: Bold refused, the style unchanged.
      await protectHost(page, holder);
      await frClick(page, float1, 1, 1);
      const styleBefore = (await frStyle(page, float1.id, 1, 1)).index;
      mark = await toastMark(page);
      await clickHomeControl(page, "fmt-bold");
      expect(await saidOnce(page, mark, "Bold on a protected host"), "Bold on a protected host did not say so").toMatch(/protect/i);
      expect((await frStyle(page, float1.id, 1, 1)).index, "Bold landed on a protected host's floating grid").toBe(styleBefore);

      // Typing through the grid's own editor is gated by the HOST too (BUG-0512).
      await frClick(page, float1, 1, 1);
      await focusGrid(page);
      await page.keyboard.type("99");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      expect(await frDisplay(page, float1.id, 1, 1), "typing landed in a protected host's floating grid").toBe("10");
      await page.keyboard.press("Escape");
      await dismissToasts(page);

      // Positive control: unprotected, both work.
      await unprotectHost(page, holder);
      await frClick(page, float1, 1, 1);
      await clickHomeControl(page, "fmt-bold");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => s.bold === true, "Bold did not work after Unprotect");
      await frClick(page, float1, 1, 1);
      await focusGrid(page);
      await page.keyboard.type("99");
      await page.keyboard.press("Enter");
      await eventually(() => frDisplay(page, float1.id, 1, 1), (d) => d === "99", "typing did not work after Unprotect");

      // Find "d" with a grid cell selected: the grid's A3, selected IN the grid.
      await frClick(page, float1, 0, 0);
      await clickHomeMenuRow(page, "fmt-findSelect", "fmt-findSelect-find");
      const search = page.locator('input[placeholder="Search..."]').filter({ visible: true }).first();
      await search.waitFor({ state: "visible", timeout: 5_000 });
      await search.fill("d");
      await page.waitForTimeout(500);
      await search.press("Enter");
      await eventually(
        () => frLocalSelection(page),
        (s) => s !== null && s.frId === float1.id && s.anchorRow === 2 && s.anchorCol === 0,
        "Find d did not select Float1!A3 inside the grid",
      );
      await page.keyboard.press("Escape");
      await closeDialogsAndOverlays(page);

      // Insert Cells with a shift: refused, nothing changes.
      await frClick(page, float1, 1, 1);
      const before = await Promise.all([1, 2, 3].map((r) => frDisplay(page, float1.id, r, 1)));
      mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-insertCells-options", "fmt-insertCells-cells");
      const dialog = page.getByTestId("insert-cells-dialog");
      if (await dialog.isVisible().catch(() => false)) {
        await page.getByTestId("cell-shift-option-down").click();
        await page.getByTestId("cell-shift-ok").click();
      }
      expect(await saidOnce(page, mark, "Insert Cells (shift down)"), "Insert Cells did not refuse with its sentence").toMatch(INSERT_CELLS_REFUSAL);
      expect(await Promise.all([1, 2, 3].map((r) => frDisplay(page, float1.id, r, 1))), "a refused Insert Cells shifted the grid").toEqual(before);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG12").toBe(false);
  });

  test("FG13 canvas host + AdventureWorks: the model pivot's first three [Revenue] values copied into Float2 equal the pivot's; Increase / Decrease Decimal on them paint the read's display in the app locale; Lock Objects refuses Insert Sheet Rows in Float2 while Bold still works", async ({
    appPage: page,
  }) => {
    test.setTimeout(420_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    try {
      await setup(page);
      const sep = await decimalSeparator(page);
      const canvas = await addCanvas(page);
      const conn = await connectAdventureWorks(page, `AdventureWorks (floating-grid-home ${RUN})`);
      holder.conn = conn;
      const pivotId = await createAwCanvasPivot(page, {
        canvasIndex: canvas.index,
        connectionId: conn.connectionId,
        frame: PIVOT_FRAME,
        rows: [{ table: "BI.dim_territory", column: "territorygroup" }],
        columns: [],
        values: [{ measureName: "Revenue" }],
        name: "AwRevenue",
      });
      const float2 = await createFr(page, FLOAT2_AT.x, FLOAT2_AT.y, "Float2", { rows: 4, cols: 3 });

      // The pivot's first three value cells, in its hidden grid.
      const view = await awPivotView(page, pivotId);
      const vc = view.rowLabelColCount;
      const valueRows = view.rows.filter((r) => r.visible && !/total/i.test(r.rowType) && typeof r.cells[vc]?.value === "number").map((r) => r.viewRow);
      expect(valueRows.length, `the AW pivot shows fewer than three value rows: ${JSON.stringify(view.rows.map((r) => r.rowType))}`).toBeGreaterThanOrEqual(3);
      const [v0, v1, v2] = valueRows;
      expect([v1 - v0, v2 - v1], "the first three value rows are not adjacent").toEqual([1, 1]);
      const region = (await pivotRegions(page)).find((r) => String(r.pivotId) === String(pivotId));
      if (!region) throw new Error("the AW pivot has no region on the canvas");
      const r0 = region.startRow + v0;
      const col = region.startCol + vc;
      const hidden = await invoke<Array<{ row: number; col: number; display: string }>>(page, "get_range_cells_typed", {
        sheetIndex: canvas.index,
        startRow: r0,
        startCol: col,
        endRow: r0 + 2,
        endCol: col,
      });
      const want = [0, 1, 2].map((i) => digitsOf(hidden.find((c) => c.row === r0 + i)?.display ?? ""));
      expect(want.every((d) => d.length > 0), `the pivot's hidden value cells read empty: ${JSON.stringify(hidden)}`).toBe(true);

      // Copy through the pivot box's own primitive (WP-A), paste into Float2!A1.
      const copied = await callModule<{ copied: boolean }>(page, API_CELL_CLIPBOARD, "copyCellRange", [{ startRow: r0, startCol: col, endRow: r0 + 2, endCol: col }]);
      expect(copied.copied, "copyCellRange copied nothing from the pivot box").toBe(true);
      await frClick(page, float2, 0, 0);
      await focusGrid(page);
      await page.keyboard.press("Control+v");
      await eventually(
        async () => Promise.all([0, 1, 2].map(async (r) => digitsOf(await frDisplay(page, float2.id, r, 0)))),
        (got) => got.join("|") === want.join("|"),
        `Float2!A1:A3 does not equal the pivot's values ${want.join(", ")}`,
        20_000,
      );

      // Increase, then Decrease Decimal ([Revenue] is #,##0: Decrease alone would change nothing).
      await ensureHomeTab(page);
      await frSelect(page, float2, 0, 0, 2, 0);
      await startStyledTextRecorder(page);
      let mark = await toastMark(page);
      await clickHomeControl(page, "fmt-increaseDecimal");
      const up = await eventually(() => frDisplay(page, float2.id, 0, 0), (d) => fractionDigits(d, sep) === 1, "Increase Decimal did not show one decimal in the app locale");
      await expectNoRefusal(page, mark, "Increase Decimal");
      // "21 143 338,0" is wider than Float2's default 64 px column, so the grid
      // rightly paints "#######" there, as Excel does for a number that does not
      // fit (found live 2026-10-17). AutoFit the column (the selection is still
      // A1:A3) so the painted text can be compared with the read.
      await executeCommand(page, CMD.AUTOFIT_COLUMN_WIDTH);
      await eventually(async () => (await frRow(page, float2.id)).colWidths?.["0"], (w) => typeof w === "number" && w > 70, "AutoFit did not widen Float2's column A");
      await redraw(page);
      await eventually(() => recordedStyledTexts(page), (t) => t.some((x) => x.text === up), `Float2 never painted "${up}"`);
      await frSelect(page, float2, 0, 0, 2, 0);
      mark = await toastMark(page);
      await clickHomeControl(page, "fmt-decreaseDecimal");
      const down = await eventually(() => frDisplay(page, float2.id, 0, 0), (d) => fractionDigits(d, sep) === 0, "Decrease Decimal did not drop the decimal");
      await expectNoRefusal(page, mark, "Decrease Decimal");
      await redraw(page);
      await eventually(() => recordedStyledTexts(page), (t) => t.some((x) => x.text === down), `Float2 never painted "${down}"`);

      // Lock Objects: the window cannot change (Insert Sheet Rows refused) but Bold still works.
      await clickCanvasControl(page, "canvas-lock-objects");
      await eventually(
        async () => (await sheetsResult(page)).sheets.find((x) => x.index === canvas.index) as unknown as { canvasLayout?: { objectsLocked?: boolean } },
        (s) => s?.canvasLayout?.objectsLocked === true,
        "Lock Objects did not lock the page",
      );
      await closeCanvasFlyouts(page);
      await ensureHomeTab(page);
      const rowsBefore = (await frRow(page, float2.id)).rowCount;
      await frClick(page, float2, 1, 1);
      mark = await toastMark(page);
      await clickHomeMenuRow(page, "fmt-insertCells-options", "fmt-insertCells-rows");
      expect(await saidOnce(page, mark, "Insert Sheet Rows on a locked page"), "Insert Sheet Rows on a locked page did not name Lock Objects").toMatch(/Lock Objects/);
      expect((await frRow(page, float2.id)).rowCount, "a locked page's floating grid grew").toBe(rowsBefore);
      await frClick(page, float2, 1, 1);
      await clickHomeControl(page, "fmt-bold");
      await eventually(() => frStyle(page, float2.id, 1, 1), (s) => s.bold === true, "Bold did not work on a locked page's floating grid");
      await clickCanvasControl(page, "canvas-lock-objects");
      await closeCanvasFlyouts(page);
    } finally {
      panes = await teardown(page, holder);
    }
    expect(panes.isOpen, "a task pane leaked out of FG13").toBe(false);
  });

  test("FG14 save, reopen, version: Float1's bold, merge, CF rule and hidden row survive a save and reopen; with a hidden row the manifest says 11, unhidden and re-saved it is below 11", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    const holder: Holder = { conn: null, protected: false };
    let panes = { isOpen: false, openPanes: 0 };
    const withHidden = path.join(WORK, `fg14-hidden-${RUN}.cala`);
    const unhidden = path.join(WORK, `fg14-unhidden-${RUN}.cala`);
    try {
      const { float1 } = await setup(page);
      // Bold B2.
      await frClick(page, float1, 1, 1);
      await clickHomeControl(page, "fmt-bold");
      await eventually(() => frStyle(page, float1.id, 1, 1), (s) => s.bold === true, "Bold did not bold B2");
      // Merge C3:D3 (empty: no warning).
      await frSelect(page, float1, 2, 2, 2, 3);
      await clickHomeControl(page, "fmt-mergeCells");
      if (appIsRunning() && visibleDialogs().length > 0) answerNativeDialog("Calcula", { action: "ok" }, 3_000);
      await eventually(async () => (await targetCells(page, float1.id, { r0: 0, c0: 0, r1: 4, c1: 3 })).merges.length, (n) => n === 1, "C3:D3 was not merged");
      // A CF rule on B2:B4 through the Home door (it lands on the backing sheet).
      await frSelect(page, float1, 1, 1, 3, 1);
      await clickHomeControl(page, "fmt-conditionalFormatting");
      const highlight = page.getByTestId("cf:highlightCells").filter({ visible: true }).first();
      await highlight.waitFor({ state: "visible", timeout: 5_000 });
      await highlight.click();
      const greater = page.getByTestId("cf:greaterThan").filter({ visible: true }).first();
      await greater.waitFor({ state: "visible", timeout: 5_000 });
      await greater.click();
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "cf-quick-dialog"), "Greater Than opened no dialog");
      await page.waitForTimeout(300);
      await page.keyboard.press("Control+a");
      await page.keyboard.type("15");
      await page.keyboard.press("Enter");
      await eventually(() => invoke<unknown[]>(page, "get_all_conditional_formats", { target: ref(float1) }), (r) => r.length === 1, "no CF rule on the grid");
      // Hide row 3.
      await frClick(page, float1, 2, 0);
      await executeCommand(page, CMD.HIDE_ROWS);
      await eventually(async () => (await frRow(page, float1.id)).hiddenRows ?? [], (h) => JSON.stringify(h) === "[2]", "Hide Rows did not hide row 3");

      await saveTo(page, withHidden);
      expect(manifestVersion(withHidden), "a floating grid with a hidden row did not stamp format version 11").toBe(11);

      await newFile(page);
      await openFileAtPath(page, withHidden);
      const reopened = await eventually(() => frList(page), (l) => l.some((f) => f.name === "Float1"), "Float1 did not come back");
      const f1 = reopened.find((f) => f.name === "Float1")!;
      await eventually(() => frStyle(page, f1.id, 1, 1), (s) => s.bold === true, "B2's bold did not survive");
      expect((await targetCells(page, f1.id, { r0: 0, c0: 0, r1: 4, c1: 3 })).merges, "the merge did not survive").toEqual([
        { startRow: 2, startCol: 2, endRow: 2, endCol: 3 },
      ]);
      expect((await invoke<unknown[]>(page, "get_all_conditional_formats", { target: ref(f1) })).length, "the CF rule did not survive").toBe(1);
      expect((await frRow(page, f1.id)).hiddenRows, "the hidden row did not survive").toEqual([2]);

      // Unhide and re-save: below 11 again.
      await sheetClick(page, 0, 0);
      await frSelect(page, f1, 1, 0, 3, 0);
      await executeCommand(page, CMD.UNHIDE_ROWS);
      await eventually(async () => (await frRow(page, f1.id)).hiddenRows ?? [], (h) => h.length === 0, "Unhide Rows did not unhide row 3");
      await saveTo(page, unhidden);
      expect(manifestVersion(unhidden), "a workbook whose floating grids hide nothing still stamps version 11").toBeLessThan(11);
    } finally {
      panes = await teardown(page, holder);
      for (const f of [withHidden, unhidden]) fs.rmSync(f, { force: true });
    }
    expect(panes.isOpen, "a task pane leaked out of FG14").toBe(false);
  });
});
