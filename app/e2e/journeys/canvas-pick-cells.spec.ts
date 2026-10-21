/**
 * REFERENCE PICKS ON FLOATING OBJECTS (D-PICK) AND CANVAS PIVOT CELLS (D-CELLS),
 * LIVE, AGAINST THE OWNER'S ADVENTUREWORKS MODEL (WP-A, 2026-10-15).
 *
 * Owner findings F3 and F4 (scratchpad maps/DECISIONS.md):
 *   F3 -- a floating grid in edit mode: clicking a pivot cell (or any other
 *         object's cell) must insert a reference exactly like a grid cell does;
 *         it used to deselect the floating grid and select the pivot.
 *   F4 -- a canvas pivot's cells are selectable (click / Shift / drag), copy a
 *         range, double-click drills through, and a VALUE cell's right-click
 *         carries the full value menu, not only the +/- toggles.
 * Every lane proved its part in jsdom with the backend doubled; this journey
 * drives each one against the REAL backend, the real Postgres model and the
 * real pointer, and asserts state and DOM -- never a golden (the goldens are
 * stale by owner decision, and this display is DPR 2).
 *
 * FIXTURE (per test, built by `setup`). File > New; Sheet1 seeded A1:C5 (Month /
 * Units / Day, canvas-live `seedSheet1`); a canvas ("Canvas1" -- the real name
 * is read back from get_sheets) shown at 70 % zoom so the whole 1280 x 720 page
 * is on screen in the harness's 1218 x 542 grid layer without scrolling it;
 * the owner's AdventureWorks connection; then
 *   P  -- a data-model pivot box: rows territorygroup > territoryname, columns
 *         year, values [Revenue]; frame {64, 64, 640, 360}; created FIRST, so it
 *         sits in the canvas's block 0 and its anchor is A1;
 *   R  -- a RANGE pivot box over Sheet1!A1:C5 (Month rows; Sum of Units, the
 *         calculated field "Double" = 'Sum of Units' * 2 interleaved, Count of
 *         Units); frame {736, 460, 360, 220} -- the range path of Summarize /
 *         Show Values As / the dialogs, which a model pivot cannot carry;
 *   PickFR -- a 6 x 4 floating grid at (736, 64): the edit every pick goes into;
 * and, where a test needs them, W (a windowed customer pivot below P), Float2
 * (a 2 x 2 floating grid holding 1..4) and a range chart. The fixture asserts
 * the transport's `isModel` (P true, R false) every time: it is what lets the
 * value menu decide synchronously on the FIRST right-click.
 *
 * Each test closes the task panes it may have opened and proves the container
 * hidden (a leaked pane narrows the grid for LATER specs), starts a new file and
 * drops its connection, in `finally`.
 *
 * RUNNING IT. A Rust change is in this package (S1: the pivot transport), so
 * launch manually (`E2E_MANUAL=1`, no `--reporter`; memory note "E2E after a
 * Rust change") with CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target,
 * and confirm global-setup printed a binary built after S1. Postgres must be up:
 * an unreachable server FAILS the journey (never a skip).
 *
 * DELIBERATE DEPARTURES FROM THE SPEC TEXT (A-pick-cells.md section 5), each
 * checked against the code:
 *   - Zoom 70 % and a layout that keeps every object on the visible page (the
 *     spec's frames put R and W below the harness's visible grid height).
 *   - The calculated field's formula is spelled `'Sum of Units' * 2`, the
 *     spelling the engine's own tests use (core/pivot-engine/src/engine.rs);
 *     no journey under app/e2e uses a range-pivot calculated field.
 *   - J9: the Home Copy control's test id is `fmt-copy` (home-excel.spec.ts),
 *     not `copy`; the third paste goes to I10 rather than G10 so the three
 *     pastes never overlap.
 *   - J12: Sort on a value cell is a DISABLED PARENT; the box menu opens no
 *     sub-menu under a disabled row (pivotVisualContextMenu.ts buildLevel), so
 *     its two children cannot be reached. The journey asserts the parent's
 *     aria-disabled + reason and that hovering it opens nothing.
 *   - J11: drilling through adds a sheet, and a new sheet ENDS the undo history
 *     (BUG-0005 Excel parity; pivot/commands.rs drill_through_to_sheet_core
 *     calls invalidate_undo_history_for_sheet_structure). "Undo removes the
 *     sheet" therefore cannot happen; J11 asserts the history ended and that
 *     Ctrl+Z brings back no ghost.
 *   - J1's "Clear Filter on the year field" has no menu row on a pivot cell;
 *     it goes through the facade's own `clearFilter` with the model field key.
 *   - J13 does not drive the field-list pane after a menu edit. BUG-0466 (an
 *     open pane undid the menu's edit on its next change) is fixed and proved
 *     at unit level (components/__tests__/pivotEditorReseedElsewhere.test.tsx);
 *     a live step would need the pane's own UI.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { closeObjectPaneForGood } from "../helpers/object-pane";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  barSpec,
  callModule,
  clickEmpty,
  createChart,
  createPivot,
  dismissToasts,
  eventually,
  freeCanvasRect,
  gridKey,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  objects,
  seedSheet1,
  selectedObjects,
  sheetPointToPage,
  sheetsResult,
  startToasts,
  toasts,
  undoState,
  type AppWindow,
} from "../helpers/canvas-live";
import {
  a1,
  awPivotView,
  cellPagePoint,
  cellSheetRect,
  cellText,
  colLetters,
  connectAdventureWorks,
  createAwCanvasPivot,
  createFr,
  dropAdventureWorks,
  escapeRegExp,
  findInView,
  frCell,
  frCellPoint,
  frEditorOpen,
  frEditText,
  rowLabelsOf,
  setFrCell,
  sheetNamePattern,
  visualState,
  type AwConnection,
  type AwPivotCell,
  type AwPivotView,
  type CanvasFrame,
  type FrInfo,
} from "../helpers/adventureworks-live";
import { cellPagePoint as gridCellPoint, clickSheetTab, formulaBarValue } from "../helpers/edit-harness";
import { pivotApi } from "../helpers/pivot-live";
import { clickHomeControl, closeHomeFlyouts, ensureHomeTab } from "../helpers/homeTab";
import { gripRect, hoveredRegionId } from "../helpers/objectGrip";

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const ZOOM_PERCENT = 70;

const P_FRAME: CanvasFrame = { x: 64, y: 64, width: 640, height: 360 };
const R_FRAME: CanvasFrame = { x: 736, y: 460, width: 360, height: 220 };
const W_FRAME: CanvasFrame = { x: 64, y: 440, width: 640, height: 264 };
const FR_AT = { x: 736, y: 64 };
const FLOAT2_AT = { x: 1040, y: 64 };
const CHART_AT = { x: 736, y: 240, width: 280, height: 200 };

const P_ROWS = [
  { table: "BI.dim_territory", column: "territorygroup" },
  { table: "BI.dim_territory", column: "territoryname" },
];
const P_COLUMNS = [{ table: "BI.dim_date", column: "year" }];
const REVENUE = [{ measureName: "Revenue" }];

const API_UI = "/src/api/ui.ts";
const API_GRID = "/src/api/grid.ts";
const API_LIB = "/src/api/lib.ts";
const GPD_TOGGLE = "/extensions/Pivot/lib/getPivotDataToggle.ts";
const PIVOT_STYLES = "/extensions/Pivot/lib/pivotStyles.ts";
/** J9's NON-default PivotTable style: its value cells are grey (#BFBFBF), the default's white. */
const J9_STYLE = "PivotStyleDark1";

/** PIVOT_EDIT_REFUSAL, extensions/Pivot/lib/pivotCanvasCellCommands.ts. */
const EDIT_REFUSAL = "You can't change this part of the PivotTable.";
/** MODEL_PIVOT_REASON, extensions/Pivot/handlers/pivotContextMenu.ts. */
const MODEL_PIVOT_REASON = "Not available on a data-model PivotTable yet.";
/** SORT_BY_VALUE_REASON, same file (BUG-0459). */
const SORT_BY_VALUE_REASON = "Sorting by values is not available yet.";
/** PIVOT_CANVAS_COPY_TOO_LARGE, extensions/Pivot/lib/pivotCanvasCellKeys.ts. */
const COPY_TOO_LARGE = "That selection is too large to copy (more than 200,000 cells).";

interface Scene {
  canvasIndex: number;
  canvasName: string;
  sheet1Index: number;
  conn: AwConnection;
  P: string;
  R: string;
  W: string | null;
  fr: FrInfo;
  float2: FrInfo | null;
  chartId: string | null;
}

/** What `finally` must undo even when `setup` threw half-way. */
interface Holder {
  conn: AwConnection | null;
}

interface Region {
  pivotId: string | number;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isModel: boolean;
  canvasFrame?: CanvasFrame;
}

interface GpdResult {
  dataField: string;
  fieldItemPairs: Array<[string, string]>;
  pivotAnchorRow: number;
  pivotAnchorCol: number;
}

interface TypedCell {
  row: number;
  col: number;
  value: unknown;
  display: string;
  formula: string | null;
}

interface ViewCellRef {
  viewRow: number;
  viewCol: number;
}

// ---------------------------------------------------------------------------
// Reading the app
// ---------------------------------------------------------------------------

async function regions(page: Page): Promise<Region[]> {
  return invoke<Region[]>(page, "get_pivot_regions_for_sheet");
}

async function regionOf(page: Page, pivotId: string): Promise<Region> {
  const r = (await regions(page)).find((x) => String(x.pivotId) === pivotId);
  if (!r) throw new Error(`pivot ${pivotId} has no region on the active sheet`);
  return r;
}

/** The hidden-grid cell a view cell of `region` lives in (pivotVisualReferenceAt's mapping). */
function gridOf(region: Region, at: ViewCellRef): { row: number; col: number } {
  return { row: region.startRow + at.viewRow, col: region.startCol + at.viewCol };
}

async function typedCells(page: Page, sheetIndex: number, r0: number, c0: number, r1: number, c1: number): Promise<TypedCell[]> {
  return invoke<TypedCell[]>(page, "get_range_cells_typed", { sheetIndex, startRow: r0, startCol: c0, endRow: r1, endCol: c1 });
}

async function hiddenCell(page: Page, sheetIndex: number, row: number, col: number): Promise<{ value: unknown; display: string }> {
  const c = (await typedCells(page, sheetIndex, row, col, row, col)).find((x) => x.row === row && x.col === col);
  return { value: c?.value ?? null, display: c?.display ?? "" };
}

/** Display text of a rectangle of any sheet, as a matrix ("" for empty cells). */
async function displaysOf(page: Page, sheetIndex: number, r0: number, c0: number, r1: number, c1: number): Promise<string[][]> {
  const cells = await typedCells(page, sheetIndex, r0, c0, r1, c1);
  const out: string[][] = [];
  for (let r = r0; r <= r1; r++) out.push(new Array(c1 - c0 + 1).fill(""));
  for (const c of cells) out[c.row - r0][c.col - c0] = c.display;
  return out;
}

/** Sum of the numbers in a rectangle of any sheet (SUM's own rule: text and blanks are skipped). */
async function sumOf(page: Page, sheetIndex: number, r0: number, c0: number, r1: number, c1: number): Promise<number> {
  const cells = await typedCells(page, sheetIndex, r0, c0, r1, c1);
  return cells.reduce((s, c) => (typeof c.value === "number" ? s + c.value : s), 0);
}

async function styleIndexes(page: Page, requests: Array<[number, number, number]>): Promise<number[]> {
  const rows = await invoke<Array<{ styleIndex?: number } | null>>(page, "get_watch_cells", { requests });
  return rows.map((c) => c?.styleIndex ?? 0);
}

/** A style's fill and text colour as the backend reports them (lower-case #rrggbb). */
async function styleColours(page: Page, index: number): Promise<{ background: string; text: string }> {
  const s = await invoke<{ backgroundColor: string; textColor: string }>(page, "get_style", { index });
  return { background: s.backgroundColor.toLowerCase(), text: s.textColor.toLowerCase() };
}

async function selectedSummary(page: Page): Promise<{ ids: string[]; types: string[] }> {
  const sel = await selectedObjects(page);
  return { ids: sel.map((o) => o.id).sort(), types: sel.map((o) => o.type).sort() };
}

async function paneOpen(page: Page): Promise<boolean> {
  return callModule<boolean>(page, API_UI, "isTaskPaneContainerOpen");
}

/** Close the task pane container and PROVE it hidden (the leaked-pane rule). */
async function hidePanes(page: Page): Promise<void> {
  await callModule(page, API_UI, "hideTaskPaneContainer");
  await eventually(() => paneOpen(page), (v) => v === false, "the task pane container is still open after hideTaskPaneContainer");
}

async function nameBox(page: Page): Promise<string> {
  return page.locator('input[aria-label="Name Box"]').first().inputValue();
}

/** The status bar's "Sum:" figure, parsed with the page's own number format (null when not shown). */
async function statusBarSum(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="status-bar"]');
    if (!bar) return null;
    const item = Array.from(bar.querySelectorAll("span")).find(
      (s) => s.children.length === 2 && (s.children[0].textContent ?? "").trim() === "Sum:",
    );
    if (!item) return null;
    const parts = new Intl.NumberFormat(undefined).formatToParts(12345.6);
    const group = (parts.find((p) => p.type === "group")?.value ?? ",").replace(/[\s\u00a0\u202f]/g, "");
    const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
    let t = (item.children[1].textContent ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(/\u2212/g, "-");
    if (group) t = t.split(group).join("");
    t = t.replace(decimal, ".");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  });
}

// ---------------------------------------------------------------------------
// Views: finding cells
// ---------------------------------------------------------------------------

/** The year columns the view shows (ColumnHeader cells reading as a 4-digit year). */
function yearColumns(view: AwPivotView): Array<{ label: string; viewRow: number; viewCol: number }> {
  const out: Array<{ label: string; viewRow: number; viewCol: number }> = [];
  for (const row of view.rows) {
    if (row.rowType !== "ColumnHeader") continue;
    row.cells.forEach((c, i) => {
      const t = cellText(c);
      if (c.cellType === "ColumnHeader" && /^\d{4}$/.test(t) && !out.some((o) => o.viewCol === i)) {
        out.push({ label: t, viewRow: row.viewRow, viewCol: i });
      }
    });
  }
  return out.sort((a, b) => a.viewCol - b.viewCol);
}

/** The year the journey names (`want` when the model has it, else the column at `fallback` from the end). */
function yearOf(view: AwPivotView, want: string, fallback: number): { label: string; viewRow: number; viewCol: number } {
  const years = yearColumns(view);
  if (years.length < 2) throw new Error(`the model pivot shows fewer than two year columns: ${JSON.stringify(years)}`);
  return years.find((y) => y.label === want) ?? years[years.length + fallback];
}

function rowHeaderCell(view: AwPivotView, label: string): ViewCellRef | null {
  const hit = findInView(view, (c) => c.cellType === "RowHeader" && cellText(c) === label);
  return hit ? { viewRow: hit.viewRow, viewCol: hit.viewCol } : null;
}

/** The territories listed under group `group` (rows after its header, deeper indent, until the next group). */
function territoriesUnder(view: AwPivotView, group: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const row of view.rows) {
    const label = row.cells.find((c) => c.cellType === "RowHeader");
    if (!label) continue;
    const text = cellText(label);
    if (text === group) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const indent = label.indentLevel ?? 0;
    if (indent === 0) break;
    out.push(text);
  }
  return out;
}

/** P's leaf row: France when the model has it, else the first territory under Europe. */
function leafRow(view: AwPivotView): { viewRow: number; label: string } {
  const france = rowHeaderCell(view, "France");
  if (france) return { viewRow: france.viewRow, label: "France" };
  const europe = territoriesUnder(view, "Europe");
  const first = europe[0] ? rowHeaderCell(view, europe[0]) : null;
  if (!first) throw new Error(`the model pivot lists no territory under Europe: ${JSON.stringify(rowLabelsOf(view))}`);
  return { viewRow: first.viewRow, label: europe[0] };
}

/** The view column whose ColumnHeader reads `name` (-1 when absent). */
function headerCol(view: AwPivotView, name: string): number {
  for (const row of view.rows) {
    if (row.rowType !== "ColumnHeader") continue;
    const i = row.cells.findIndex((c) => cellText(c) === name);
    if (i >= 0) return i;
  }
  return -1;
}

function cellAt(view: AwPivotView, viewRow: number, viewCol: number): AwPivotCell | undefined {
  return view.rows.find((r) => r.viewRow === viewRow)?.cells[viewCol];
}

/** The raw numbers of `col` in R's month rows (Jan..Apr) and in its grand-total row. */
function monthColumn(view: AwPivotView, col: number): { months: Record<string, number | null>; total: number | null } {
  const months: Record<string, number | null> = {};
  let total: number | null = null;
  for (const row of view.rows) {
    const label = cellText(row.cells[0]);
    const v = row.cells[col]?.value;
    const n = typeof v === "number" ? v : null;
    if (["Jan", "Feb", "Mar", "Apr"].includes(label)) months[label] = n;
    if (row.rowType === "GrandTotal") total = n;
  }
  return { months, total };
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

async function ensureCanvasZoom(page: Page): Promise<void> {
  const geo = await readGridGeometry(page);
  if (Math.abs(geo.zoom - ZOOM_PERCENT / 100) < 0.01) return;
  await callModule(page, API_GRID, "setZoomLevel", [ZOOM_PERCENT]);
  await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - ZOOM_PERCENT / 100) < 0.01, `the canvas did not zoom to ${ZOOM_PERCENT}%`);
  await page.waitForTimeout(200);
}

/** Click a view cell of a box (a hand's click: press, hold, release). */
async function clickViewCell(page: Page, pivotId: string, at: ViewCellRef, opts: { shift?: boolean; right?: boolean } = {}): Promise<void> {
  const p = await cellPagePoint(page, pivotId, at.viewRow, at.viewCol);
  if (opts.shift) await page.keyboard.down("Shift");
  try {
    await humanClick(page, p.x, p.y, opts.right ? "right" : "left");
  } finally {
    if (opts.shift) await page.keyboard.up("Shift");
  }
  await page.waitForTimeout(250);
}

/** Open the floating grid's editor on (row, col) by double-click and type `text`. */
async function startFrEdit(page: Page, fr: FrInfo, row: number, col: number, text: string): Promise<void> {
  const p = await frCellPoint(page, fr, row, col);
  await page.mouse.dblclick(p.x, p.y);
  await eventually(() => frEditorOpen(page), (v) => v, `double-clicking ${fr.name}'s cell (${row},${col}) opened no editor`);
  if (text) await page.keyboard.type(text);
  await eventually(() => frEditText(page), (t) => t === text, `${fr.name}'s edit does not read "${text}"`);
}

/** Remember the internal clipboard as it is now (`clipboardChanged` then answers whether a copy replaced it). */
async function markClipboard(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const w = window as unknown as AppWindow & { __s12Clip?: unknown };
    const m = (await w.__appImport!(mod)) as { getInternalClipboard: () => unknown };
    w.__s12Clip = m.getInternalClipboard();
  }, API_LIB);
}

interface ClipSummary {
  rows: number;
  cols: number;
  sheet: number;
  firstRow: number;
  lastRow: number;
  startCol: number;
}

async function clipboardChanged(page: Page): Promise<ClipSummary | null> {
  return page.evaluate(async (mod) => {
    const w = window as unknown as AppWindow & { __s12Clip?: unknown };
    const m = (await w.__appImport!(mod)) as {
      getInternalClipboard: () => {
        cells: unknown[][];
        sourceRows: number[];
        sourceSheetIndex: number;
        sourceSelection: { startCol: number; endCol: number };
      } | null;
    };
    const cur = m.getInternalClipboard();
    if (!cur || cur === w.__s12Clip) return null;
    return {
      rows: cur.cells.length,
      cols: cur.cells[0]?.length ?? 0,
      sheet: cur.sourceSheetIndex,
      firstRow: cur.sourceRows[0],
      lastRow: cur.sourceRows[cur.sourceRows.length - 1],
      startCol: Math.min(cur.sourceSelection.startCol, cur.sourceSelection.endCol),
    };
  }, API_LIB);
}

// ---- The canvas pivot box's own right-click menu (pivotVisualContextMenu.ts) ----

interface MenuRow {
  id: string;
  label: string;
  disabled: boolean;
  title: string;
}

async function menuRows(page: Page, depth: number): Promise<MenuRow[]> {
  return page.locator(`[data-pivot-box-menu="${depth}"] [role="menuitem"]`).evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute("data-item-id") ?? "",
      label: (e.querySelector("span")?.textContent ?? "").trim(),
      disabled: e.getAttribute("aria-disabled") === "true",
      title: (e as HTMLElement).title ?? "",
    })),
  );
}

/** Right-click a view cell and return the box menu's top level. */
async function openBoxMenu(page: Page, pivotId: string, at: ViewCellRef): Promise<MenuRow[]> {
  await clickViewCell(page, pivotId, at, { right: true });
  await expect(page.locator('[data-pivot-box-menu="0"]'), "the right-click opened no pivot box menu").toBeVisible();
  return menuRows(page, 0);
}

/** Walk the open box menu by item ids: hover each parent, click the last. */
async function clickBoxMenu(page: Page, ids: string[]): Promise<void> {
  for (let depth = 0; depth < ids.length; depth++) {
    const row = page.locator(`[data-pivot-box-menu="${depth}"] [role="menuitem"][data-item-id="${ids[depth]}"]`);
    await expect(row, `the box menu has no row "${ids[depth]}" at depth ${depth}`).toBeVisible();
    if (depth < ids.length - 1) {
      await row.hover();
      await expect(page.locator(`[data-pivot-box-menu="${depth + 1}"]`), `hovering "${ids[depth]}" opened no sub-menu`).toBeVisible();
    } else {
      await row.click();
    }
  }
  await page.waitForTimeout(300);
}

async function closeBoxMenu(page: Page): Promise<void> {
  if ((await page.locator('[data-pivot-box-menu="0"]').count()) === 0) return;
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-pivot-box-menu="0"]')).toHaveCount(0);
}

// ---- Expected texts ----

function stringLiteral(text: string): string {
  return escapeRegExp(`"${text.replace(/"/g, '""')}"`);
}

/** The GETPIVOTDATA text a pick on a cell inserts, built from the backend's own answer (anchor form). */
function gpdPattern(gpd: GpdResult, sheetName: string): RegExp {
  const anchor = `\\$${colLetters(gpd.pivotAnchorCol)}\\$${gpd.pivotAnchorRow + 1}`;
  let p = `^=GETPIVOTDATA\\(${stringLiteral(gpd.dataField)}[;,]${sheetNamePattern(sheetName)}!${anchor}`;
  for (const [field, item] of gpd.fieldItemPairs) p += `[;,]${stringLiteral(field)}[;,]${stringLiteral(item)}`;
  return new RegExp(`${p}\\)$`);
}

/** A plain reference to one cell of `sheetName`, `$` allowed but not required. */
function plainRefPattern(sheetName: string, row: number, col: number, prefix = "="): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}${sheetNamePattern(sheetName)}!\\$?${colLetters(col)}\\$?${row + 1}$`);
}

function showsRefError(c: unknown): boolean {
  return JSON.stringify(c ?? null).includes("#REF!");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function setup(page: Page, holder: Holder, opts: { windowed?: boolean; float2?: boolean; chart?: boolean } = {}): Promise<Scene> {
  await installAppImport(page);
  await newFile(page);
  await seedSheet1(page);
  const first = await sheetsResult(page);
  const sheet1 = first.sheets[first.activeIndex];

  const canvas = await addCanvas(page);
  const canvasIndex = canvas.index;
  const canvasName = (await sheetsResult(page)).sheets.find((s) => s.index === canvasIndex)?.name ?? canvas.name;
  await ensureCanvasZoom(page);
  await hidePanes(page);

  const conn = await connectAdventureWorks(page, `AdventureWorks (pick-cells ${RUN})`);
  holder.conn = conn;

  // P first: block 0, anchor A1.
  const P = await createAwCanvasPivot(page, {
    canvasIndex,
    connectionId: conn.connectionId,
    frame: P_FRAME,
    rows: P_ROWS,
    columns: P_COLUMNS,
    values: REVENUE,
    name: "ModelP",
  });

  const R = await createPivot(page, { destinationSheet: canvasIndex, canvasFrame: R_FRAME, name: "RangeR" });
  await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
    {
      pivotId: R,
      rowFields: [{ sourceIndex: 0, name: "Month" }],
      valueFields: [
        { sourceIndex: 1, name: "Sum of Units", aggregation: "sum" },
        { sourceIndex: 1, name: "Count of Units", aggregation: "count" },
      ],
      calculatedFields: [{ name: "Double", formula: "'Sum of Units' * 2" }],
      valueColumnOrder: [
        { type: "value", index: 0 },
        { type: "calculated", index: 0 },
        { type: "value", index: 1 },
      ],
    },
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));

  let W: string | null = null;
  if (opts.windowed) {
    W = await createAwCanvasPivot(page, {
      canvasIndex,
      connectionId: conn.connectionId,
      frame: W_FRAME,
      rows: [{ table: "BI.dim_customer", column: "fullname" }],
      columns: [],
      values: REVENUE,
      name: "CustomersW",
    });
  }

  const fr = await createFr(page, FR_AT.x, FR_AT.y, "PickFR", { rows: 6, cols: 4 });
  let float2: FrInfo | null = null;
  if (opts.float2) {
    float2 = await createFr(page, FLOAT2_AT.x, FLOAT2_AT.y, "Float2", { rows: 2, cols: 2 });
    await setFrCell(page, float2.id, 0, 0, "1");
    await setFrCell(page, float2.id, 0, 1, "2");
    await setFrCell(page, float2.id, 1, 0, "3");
    await setFrCell(page, float2.id, 1, 1, "4");
  }
  let chartId: string | null = null;
  if (opts.chart) {
    chartId = await createChart(page, barSpec(sheet1.sheetId, "Units"), { sheetIndex: canvasIndex, ...CHART_AT, name: "PickChart" });
  }

  // The transport (S1): every region says whether it is a model pivot -- known
  // synchronously, so the value menu never guesses.
  const regs = await eventually(
    () => regions(page),
    (rs) => [P, R, ...(W ? [W] : [])].every((id) => rs.some((r) => String(r.pivotId) === id && !!r.canvasFrame)),
    "the canvas pivots' regions were never all published",
    30_000,
  );
  expect(regs.find((r) => String(r.pivotId) === P)?.isModel, "P (data model) is not reported isModel === true").toBe(true);
  expect(regs.find((r) => String(r.pivotId) === R)?.isModel, "R (range) is not reported isModel === false").toBe(false);
  if (W) expect(regs.find((r) => String(r.pivotId) === W)?.isModel, "W (data model) is not reported isModel === true").toBe(true);

  // Both boxes painted with cells.
  await eventually(() => cellSheetRect(page, P, 1, 0), (r) => r !== null, "P never painted its cells", 60_000);
  await eventually(() => cellSheetRect(page, R, 1, 0), (r) => r !== null, "R never painted its cells", 30_000);
  if (W) await eventually(() => cellSheetRect(page, W!, 1, 0), (r) => r !== null, "W never painted its cells", 60_000);

  // Nothing selected, no pane open, the whole page on screen: every test starts from the same state.
  await hidePanes(page);
  await ensureCanvasZoom(page);
  const free = await freeCanvasRect(page, { width: 16, height: 16 });
  await clickEmpty(page, free.x + 8, free.y + 8);
  await eventually(() => selectedObjects(page), (s) => s.length === 0, "precondition: a click on the empty page left something selected");
  await hidePanes(page);

  return { canvasIndex, canvasName, sheet1Index: sheet1.index, conn, P, R, W, fr, float2, chartId };
}

async function cleanup(page: Page, holder: Holder): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.keyboard.up("Shift").catch(() => undefined);
  await page.mouse.up().catch(() => undefined);
  await callModule(page, GPD_TOGGLE, "setGenerateGetPivotData", [true]).catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
  await callModule(page, API_UI, "hideTaskPaneContainer").catch(() => undefined);
  await newFile(page).catch(() => undefined);
  await dropAdventureWorks(page, holder.conn);
  holder.conn = null;
  // The leaked-pane rule: prove the container hidden before the next spec runs.
  await callModule(page, API_UI, "hideTaskPaneContainer").catch(() => undefined);
  await eventually(() => paneOpen(page), (v) => v === false, "cleanup: the task pane container is still open");
}

// WP-C (D-PANE): on a canvas a click opens the ONE object pane at its release,
// and a docked pane narrows the grid. This journey predates the pane and asserts
// nothing about it, so every test starts with the pane closed AS IF BY HAND
// (helpers/object-pane.ts). Per test, not once: the fixture's per-test task-pane
// reset clears the "closed by hand" mark, and Playwright runs this hook after it.
test.beforeEach(async ({ appPage }) => {
  await closeObjectPaneForGood(appPage);
});

// ===========================================================================

test.describe("reference picks on floating objects and canvas pivot cells (WP-A), live on AdventureWorks", () => {
  test.describe.configure({ timeout: 300_000 });

  test("J1 GETPIVOTDATA pick: = in a floating grid, a click on a model pivot's value inserts GETPIVOTDATA on the pivot's ANCHOR qualified with the canvas, the floating grid stays selected and nothing else happens; the committed value is the cell's; naming a year the pivot no longer shows is #REF! and comes back with the filter", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      await hidePanes(page);
      const view = await awPivotView(page, s.P);
      const y13 = yearOf(view, "2013", -2);
      const y14 = yearOf(view, "2014", -1);
      const leaf = leafRow(view);
      const target: ViewCellRef = { viewRow: leaf.viewRow, viewCol: y13.viewCol };
      expect(typeof cellAt(view, target.viewRow, target.viewCol)?.value, `precondition: ${leaf.label} x ${y13.label} is a number`).toBe("number");
      const region = await regionOf(page, s.P);
      const g = gridOf(region, target);

      // What the backend says a pick on that cell names (the interceptor asks the same command).
      const gpd = await invoke<GpdResult | null>(page, "get_pivot_data_formula", { row: g.row, col: g.col });
      expect(gpd, "get_pivot_data_formula answered nothing for a value cell of the canvas pivot").toBeTruthy();
      expect([gpd!.pivotAnchorRow, gpd!.pivotAnchorCol], "P (block 0) is not anchored at A1").toEqual([0, 0]);

      await startFrEdit(page, s.fr, 0, 0, "=");
      const before = await selectedSummary(page);
      expect(before.types, "precondition: the floating grid is the selection while it edits").toEqual(["floating-range"]);
      await startToasts(page);

      await clickViewCell(page, s.P, target);
      const text = await eventually(() => frEditText(page), (t) => t.startsWith("=GETPIVOTDATA("), "a pick on the model pivot's value inserted no GETPIVOTDATA", 15_000);
      expect(text, "the pick is not GETPIVOTDATA on the pivot's ANCHOR, qualified with the canvas").toMatch(gpdPattern(gpd!, s.canvasName));
      expect(await frEditorOpen(page), "the pick ended the floating grid's edit").toBe(true);
      expect(await selectedSummary(page), "the pick changed the canvas object selection").toEqual(before);
      expect((await visualState(page, s.P))?.selected, "the pick selected the pivot box").toBe(false);
      expect(await paneOpen(page), "the pick opened a task pane").toBe(false);
      expect(await toasts(page), "the pick raised a toast").toEqual([]);

      await page.keyboard.press("Enter");
      const hidden = await hiddenCell(page, s.canvasIndex, g.row, g.col);
      expect(typeof hidden.value, `precondition: the hidden-grid cell ${a1(g.row, g.col)} holds a number`).toBe("number");
      const committed = await eventually(
        () => frCell(page, s.fr.id, 0, 0),
        (c) => !!c && c.formula !== null && typeof c.value === "number",
        "PickFR A1 did not calculate the GETPIVOTDATA it stored",
        20_000,
      );
      expect(Number(committed!.value), `PickFR A1 = ${JSON.stringify(committed)} is not the pivot's own number`).toBeCloseTo(Number(hidden.value), 6);
      const n2013 = Number(hidden.value);

      // ---- Staleness, Excel's answer: Keep Only the other year -> #REF!; clear the filter -> the number again.
      const header14 = { viewRow: y14.viewRow, viewCol: y14.viewCol };
      await openBoxMenu(page, s.P, header14);
      await clickBoxMenu(page, ["pivot:filter", "pivot:filter:keepOnly"]);
      await eventually(
        () => awPivotView(page, s.P),
        (v) => {
          const ys = yearColumns(v);
          return ys.length === 1 && ys[0].label === y14.label;
        },
        `Keep Only Selected Items on ${y14.label} did not leave one year column`,
        60_000,
      );
      await eventually(() => frCell(page, s.fr.id, 0, 0), (c) => showsRefError(c), `PickFR A1 (GETPIVOTDATA naming ${y13.label}) does not show #REF! once the pivot no longer shows that year`, 30_000);

      await pivotApi(page, "clearFilter", { pivotId: s.P, biFieldKey: "BI.dim_date.year" }, 120_000);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      await eventually(() => awPivotView(page, s.P), (v) => yearColumns(v).some((y) => y.label === y13.label), `clearing the year filter did not bring ${y13.label} back`, 60_000);
      const back = await eventually(
        () => frCell(page, s.fr.id, 0, 0),
        (c) => !!c && typeof c.value === "number" && Math.abs(c.value - n2013) < 1e-6,
        `PickFR A1 did not return to ${n2013} once ${y13.label} was shown again`,
        30_000,
      );
      expect(Number(back!.value)).toBeCloseTo(n2013, 6);
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J2 plain references: a row label inserts a plain reference to its hidden-grid cell (GETPIVOTDATA on), and with Generate GetPivotData OFF a value inserts one too; each committed value is the hidden grid's", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const region = await regionOf(page, s.P);
      const europe = rowHeaderCell(view, "Europe");
      expect(europe, `precondition: P lists Europe (${JSON.stringify(rowLabelsOf(view))})`).toBeTruthy();
      const ge = gridOf(region, europe!);

      await startFrEdit(page, s.fr, 1, 0, "=");
      await clickViewCell(page, s.P, europe!);
      const labelRef = await eventually(() => frEditText(page), (t) => t !== "=", "a pick on the Europe label inserted nothing", 10_000);
      expect(labelRef, "a label pick is not a plain reference to its hidden-grid cell").toMatch(plainRefPattern(s.canvasName, ge.row, ge.col));
      await page.keyboard.press("Enter");
      const europeHidden = await hiddenCell(page, s.canvasIndex, ge.row, ge.col);
      await eventually(
        () => frCell(page, s.fr.id, 1, 0),
        (c) => !!c && c.formula !== null && String(c.value) === String(europeHidden.value),
        `PickFR A2 does not show the label "${String(europeHidden.value)}"`,
        15_000,
      );

      await callModule(page, GPD_TOGGLE, "setGenerateGetPivotData", [false]);
      const y13 = yearOf(view, "2013", -2);
      const leaf = leafRow(view);
      const value: ViewCellRef = { viewRow: leaf.viewRow, viewCol: y13.viewCol };
      const gv = gridOf(region, value);
      await startFrEdit(page, s.fr, 2, 0, "=");
      await clickViewCell(page, s.P, value);
      const valueRef = await eventually(() => frEditText(page), (t) => t !== "=", "a pick on a value (toggle OFF) inserted nothing", 10_000);
      expect(valueRef, "with Generate GetPivotData OFF a value pick is not a plain reference").toMatch(plainRefPattern(s.canvasName, gv.row, gv.col));
      expect(valueRef).not.toContain("GETPIVOTDATA");
      await page.keyboard.press("Enter");
      const hidden = await hiddenCell(page, s.canvasIndex, gv.row, gv.col);
      const got = await eventually(() => frCell(page, s.fr.id, 2, 0), (c) => !!c && typeof c.value === "number", "PickFR A3 did not calculate the plain reference", 15_000);
      expect(Number(got!.value)).toBeCloseTo(Number(hidden.value), 6);
    } finally {
      await callModule(page, GPD_TOGGLE, "setGenerateGetPivotData", [true]).catch(() => undefined);
      await cleanup(page, holder);
    }
  });

  test("J3 a pick DRAG across pivot cells inserts the hidden-grid range (never GETPIVOTDATA), Core's preview names the box and the rectangle while the button is held, and the SUM is the rectangle's", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const region = await regionOf(page, s.P);
      const y13 = yearOf(view, "2013", -2);
      const leaf = leafRow(view);
      const from: ViewCellRef = { viewRow: leaf.viewRow, viewCol: y13.viewCol };
      const via: ViewCellRef = { viewRow: leaf.viewRow, viewCol: y13.viewCol + 1 };
      const to: ViewCellRef = { viewRow: leaf.viewRow + 1, viewCol: y13.viewCol + 1 };
      const g1 = gridOf(region, from);
      const g2 = gridOf(region, to);

      await startFrEdit(page, s.fr, 1, 0, "=SUM(");
      const p1 = await cellPagePoint(page, s.P, from.viewRow, from.viewCol);
      const pv = await cellPagePoint(page, s.P, via.viewRow, via.viewCol);
      const p2 = await cellPagePoint(page, s.P, to.viewRow, to.viewCol);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      let preview: { regionId: string; range: { space: string; startRow: number; startCol: number; endRow: number; endCol: number } } | null = null;
      try {
        await page.mouse.move(pv.x, pv.y, { steps: 4 });
        await page.mouse.move(p2.x, p2.y, { steps: 4 });
        preview = await eventually(
          () => callModule<typeof preview>(page, MOD.GRID_OVERLAYS, "getFloatingReferencePickPreview"),
          (v) => !!v && Math.max(v.range.startRow, v.range.endRow) === g2.row && Math.max(v.range.startCol, v.range.endCol) === g2.col,
          "while the pick drag is held, Core's preview does not cover the dragged rectangle",
          5_000,
        );
      } finally {
        await page.mouse.up();
      }
      expect(preview!.regionId, "the preview does not name P's box").toBe(`pivot-visual-${s.P}`);
      expect(preview!.range.space).toBe("sheet");
      expect(
        [
          Math.min(preview!.range.startRow, preview!.range.endRow),
          Math.min(preview!.range.startCol, preview!.range.endCol),
          Math.max(preview!.range.startRow, preview!.range.endRow),
          Math.max(preview!.range.startCol, preview!.range.endCol),
        ],
        "the preview's rectangle is not the dragged hidden-grid rectangle",
      ).toEqual([g1.row, g1.col, g2.row, g2.col]);

      const rangeText = new RegExp(
        `^=SUM\\(${sheetNamePattern(s.canvasName)}!\\$?${colLetters(g1.col)}\\$?${g1.row + 1}:\\$?${colLetters(g2.col)}\\$?${g2.row + 1}$`,
      );
      const text = await eventually(() => frEditText(page), (t) => t !== "=SUM(", "the pick drag inserted nothing", 10_000);
      expect(text, "a pick drag over pivot cells is not the hidden-grid range").toMatch(rangeText);
      expect(text).not.toContain("GETPIVOTDATA");
      expect(await callModule(page, MOD.GRID_OVERLAYS, "getFloatingReferencePickPreview"), "the preview outlived the drag").toBeNull();

      await page.keyboard.type(")");
      await page.keyboard.press("Enter");
      const expected = await sumOf(page, s.canvasIndex, g1.row, g1.col, g2.row, g2.col);
      const got = await eventually(() => frCell(page, s.fr.id, 1, 0), (c) => !!c && typeof c.value === "number", "the SUM over the picked range did not calculate", 15_000);
      expect(Number(got!.value), "the SUM is not the picked rectangle's").toBeCloseTo(expected, 6);
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J4 floating grid to floating grid: a pick drag over Float2 inserts =SUM(Float2!A1:B2 (10), and a pick on the editing grid's own cell inserts =PickFR!B1", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder, { float2: true });
      await startFrEdit(page, s.fr, 2, 0, "=SUM(");
      const p1 = await frCellPoint(page, s.float2!, 0, 0);
      const p2 = await frCellPoint(page, s.float2!, 1, 1);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      try {
        await page.mouse.move(p2.x, p2.y, { steps: 6 });
      } finally {
        await page.mouse.up();
      }
      await eventually(() => frEditText(page), (t) => t === "=SUM(Float2!A1:B2", "a pick drag over Float2 did not insert =SUM(Float2!A1:B2", 10_000);
      await page.keyboard.type(")");
      await page.keyboard.press("Enter");
      const sum = await eventually(() => frCell(page, s.fr.id, 2, 0), (c) => !!c && typeof c.value === "number", "=SUM(Float2!A1:B2) did not calculate", 15_000);
      expect(Number(sum!.value)).toBe(10);

      // A pick on the editing grid's OWN cell.
      await startFrEdit(page, s.fr, 3, 0, "=");
      const own = await frCellPoint(page, s.fr, 0, 1);
      await humanClick(page, own.x, own.y);
      await eventually(() => frEditText(page), (t) => t === "=PickFR!B1", "a pick on PickFR's own B1 did not insert =PickFR!B1", 10_000);
      await page.keyboard.press("Escape");
      await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel the self-pick edit");
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J5 inert targets: while a floating grid picks, a press on a chart and a press on the empty page insert nothing, select nothing and keep the floating grid selected; Escape cancels", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder, { chart: true });
      await startFrEdit(page, s.fr, 4, 0, "=SUM(");
      const before = await selectedSummary(page);
      const chart = (await objects(page)).find((o) => o.chartId === s.chartId);
      expect(chart, "precondition: the chart is published on the canvas").toBeTruthy();

      const body = await sheetPointToPage(page, chart!.x + chart!.w / 2, chart!.y + chart!.h / 2);
      await humanClick(page, body.x, body.y);
      await page.waitForTimeout(500);
      expect(await frEditText(page), "a press on the chart changed the pick text").toBe("=SUM(");
      expect(await frEditorOpen(page), "a press on the chart ended the edit").toBe(true);
      expect(await selectedSummary(page), "a press on the chart changed the selection").toEqual(before);
      expect((await objects(page)).find((o) => o.chartId === s.chartId)?.selected, "the chart got selected during a pick").toBe(false);

      const free = await freeCanvasRect(page, { width: 16, height: 16 });
      await clickEmpty(page, free.x + 8, free.y + 8);
      await page.waitForTimeout(300);
      expect(await frEditText(page), "a press on the empty page changed the pick text").toBe("=SUM(");
      expect(await frEditorOpen(page), "a press on the empty page ended the edit").toBe(true);
      expect(await selectedSummary(page), "a press on the empty page changed the selection").toEqual(before);

      await page.keyboard.press("Escape");
      await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel the edit");
      const stored = await frCell(page, s.fr.id, 4, 0);
      expect(stored?.formula ?? null, "Escape stored the formula").toBeNull();
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J6 a DOUBLE-click on a pivot value during a pick inserts ONE GETPIVOTDATA and drills nothing; the floating grid stays selected, the box is not", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const target: ViewCellRef = { viewRow: leafRow(view).viewRow, viewCol: yearOf(view, "2013", -2).viewCol };
      const sheetsBefore = await sheetsResult(page);

      await startFrEdit(page, s.fr, 5, 0, "=");
      const p = await cellPagePoint(page, s.P, target.viewRow, target.viewCol);
      await page.mouse.dblclick(p.x, p.y);
      const text = await eventually(() => frEditText(page), (t) => t.startsWith("=GETPIVOTDATA("), "the double-click inserted no GETPIVOTDATA", 15_000);
      await page.waitForTimeout(1500);
      const settled = await frEditText(page);
      expect(settled.split("GETPIVOTDATA(").length - 1, `the double-click inserted GETPIVOTDATA more than once: ${settled}`).toBe(1);
      expect(settled).toBe(text);
      const sheetsAfter = await sheetsResult(page);
      expect(sheetsAfter.sheets.length, "the double-click drilled through (a sheet was added)").toBe(sheetsBefore.sheets.length);
      expect(sheetsAfter.activeIndex, "the double-click left the canvas").toBe(s.canvasIndex);
      expect((await selectedSummary(page)).types, "the floating grid is no longer the selection").toEqual(["floating-range"]);
      expect((await visualState(page, s.P))?.selected, "the double-click selected the pivot box").toBe(false);
      await page.keyboard.press("Escape");
      await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel the edit");
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J7 cell selection: click / Shift+click / drag select cells (the box does not move), the Name Box shows the hidden-grid address, the formula bar the raw value, the status bar the rectangle's Sum; arrows move and extend; Escape clears the cells then the box; Ctrl+A selects the content", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const region = await regionOf(page, s.P);
      const y13 = yearOf(view, "2013", -2);
      const leaf = leafRow(view);
      const c1: ViewCellRef = { viewRow: leaf.viewRow, viewCol: y13.viewCol };
      const c2: ViewCellRef = { viewRow: leaf.viewRow + 1, viewCol: y13.viewCol + 1 };
      const g1 = gridOf(region, c1);
      const g2 = gridOf(region, c2);
      const sheetRe = sheetNamePattern(s.canvasName);

      // ---- Click: the box AND that cell.
      await clickViewCell(page, s.P, c1);
      const st1 = await eventually(() => visualState(page, s.P), (v) => !!v?.selected && v.cellSelection !== null, "a click on a cell did not select the box and the cell");
      expect(st1!.cellSelection).toMatchObject({ anchorRow: c1.viewRow, anchorCol: c1.viewCol, endRow: c1.viewRow, endCol: c1.viewCol });
      await eventually(() => nameBox(page), (t) => new RegExp(`^${sheetRe}!${a1(g1.row, g1.col)}$`).test(t), `the Name Box does not show ${s.canvasName}!${a1(g1.row, g1.col)}`);
      const raw = cellAt(view, c1.viewRow, c1.viewCol)?.value;
      // The bar shows the UNFORMATTED value (General) in the APP locale since round 2 (P2):
      // "3816543,327616..." under sv-SE. Read it back with the locale's decimal mark and no
      // group separator (a formatted "3 816 543" would fail both).
      const loc = await invoke<{ decimalSeparator: string; thousandsSeparator: string }>(page, "get_locale_settings", {});
      const rawInBar = (t: string): boolean => {
        if (typeof raw !== "number") return t === String(raw ?? "");
        if (!/^-?\d+$/.test(t.split(loc.decimalSeparator).join(""))) return false;
        if (t.split(loc.decimalSeparator).length > 2) return false;
        return Math.abs(Number(t.split(loc.decimalSeparator).join(".")) - raw) < 1e-6;
      };
      await eventually(() => formulaBarValue(page), rawInBar, `the formula bar does not show the raw value ${String(raw)} in the app locale (decimal ${JSON.stringify(loc.decimalSeparator)}, no grouping)`);

      // ---- Shift+click: a rectangle.
      await clickViewCell(page, s.P, c2, { shift: true });
      const st2 = await eventually(() => visualState(page, s.P), (v) => v?.cellSelection?.endRow === c2.viewRow && v?.cellSelection?.endCol === c2.viewCol, "Shift+click did not extend the cell selection");
      expect(st2!.cellSelection).toMatchObject({ anchorRow: c1.viewRow, anchorCol: c1.viewCol });
      await eventually(
        () => nameBox(page),
        (t) => new RegExp(`^${sheetRe}!${a1(g1.row, g1.col)}:${a1(g2.row, g2.col)}$`).test(t),
        `the Name Box does not show ${s.canvasName}!${a1(g1.row, g1.col)}:${a1(g2.row, g2.col)}`,
      );
      const expectedSum = await sumOf(page, s.canvasIndex, g1.row, g1.col, g2.row, g2.col);
      await eventually(
        () => statusBarSum(page),
        (n) => n !== null && Math.abs(n - Math.round(expectedSum * 100) / 100) < 0.011,
        `the status bar's Sum is not the rectangle's ${expectedSum}`,
        10_000,
      );

      // ---- Drag: the selection follows; the box stays where it is.
      const frameBefore = (await regionOf(page, s.P)).canvasFrame;
      const d1 = await cellPagePoint(page, s.P, c2.viewRow, c2.viewCol);
      const d2 = await cellPagePoint(page, s.P, c1.viewRow, c1.viewCol - 1);
      await page.mouse.move(d1.x, d1.y);
      await page.mouse.down();
      try {
        await page.mouse.move(d2.x, d2.y, { steps: 8 });
      } finally {
        await page.mouse.up();
      }
      await eventually(
        () => visualState(page, s.P),
        (v) => v?.cellSelection?.anchorRow === c2.viewRow && v?.cellSelection?.anchorCol === c2.viewCol && v?.cellSelection?.endRow === c1.viewRow && v?.cellSelection?.endCol === c1.viewCol - 1,
        "a drag across cells did not select from the press to the release",
      );
      await page.waitForTimeout(400);
      expect((await regionOf(page, s.P)).canvasFrame, "a drag across cells moved the box").toEqual(frameBefore);

      // ---- Arrows: ArrowDown moves the active cell to the next shown row; Shift+ArrowRight extends.
      await clickViewCell(page, s.P, c1);
      await eventually(() => visualState(page, s.P), (v) => v?.cellSelection?.anchorRow === c1.viewRow && v?.cellSelection?.endRow === c1.viewRow, "precondition: the click did not re-anchor");
      const nextShown = view.rows.find((r) => r.viewRow > c1.viewRow && r.visible !== false)?.viewRow;
      expect(nextShown, "precondition: a shown row below the leaf").toBeDefined();
      await gridKey(page, "ArrowDown");
      await eventually(
        () => visualState(page, s.P),
        (v) => v?.cellSelection?.anchorRow === nextShown && v?.cellSelection?.endRow === nextShown && v?.cellSelection?.anchorCol === c1.viewCol,
        "ArrowDown did not move the active cell to the next shown row",
      );
      await gridKey(page, "Shift+ArrowRight");
      await eventually(
        () => visualState(page, s.P),
        (v) => v?.cellSelection?.anchorRow === nextShown && v?.cellSelection?.anchorCol === c1.viewCol && v?.cellSelection?.endCol === c1.viewCol + 1,
        "Shift+ArrowRight did not extend the selection by one column",
      );

      // ---- Escape ladder.
      await gridKey(page, "Escape");
      await eventually(() => visualState(page, s.P), (v) => v?.cellSelection === null && v?.selected === true, "the first Escape did not clear the cells and keep the box");
      await gridKey(page, "Escape");
      await eventually(() => selectedObjects(page), (o) => o.length === 0, "the second Escape did not deselect the box");

      // ---- Ctrl+A: the whole content.
      await clickViewCell(page, s.P, c1);
      await eventually(() => visualState(page, s.P), (v) => v?.cellSelection !== null, "precondition: no cell selected before Ctrl+A");
      await gridKey(page, "Control+a");
      const shown = view.rows.filter((r) => r.visible !== false).map((r) => r.viewRow);
      await eventually(
        () => visualState(page, s.P),
        (v) =>
          v?.cellSelection?.anchorRow === shown[0] &&
          v?.cellSelection?.anchorCol === 0 &&
          v?.cellSelection?.endRow === shown[shown.length - 1] &&
          v?.cellSelection?.endCol === view.colCount - 1,
        "Ctrl+A did not select the box's whole content",
      );
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J8 the DELETE HAZARD: with cells selected, Delete, Backspace, Ctrl+X and Ctrl+V each refuse with the pivot's sentence; the PivotTable and its box survive", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const leaf = leafRow(view);
      const y13 = yearOf(view, "2013", -2);
      await clickViewCell(page, s.P, { viewRow: leaf.viewRow, viewCol: y13.viewCol });
      await clickViewCell(page, s.P, { viewRow: leaf.viewRow + 1, viewCol: y13.viewCol + 1 }, { shift: true });
      await eventually(() => visualState(page, s.P), (v) => v?.cellSelection?.endRow === leaf.viewRow + 1, "precondition: the cells are not selected");

      for (const combo of ["Delete", "Backspace", "Control+x", "Control+v"]) {
        await dismissToasts(page);
        await page.waitForTimeout(300);
        await startToasts(page);
        await gridKey(page, combo);
        await eventually(() => toasts(page), (t) => t.some((x) => x.text.includes(EDIT_REFUSAL)), `${combo} with pivot cells selected did not refuse with "${EDIT_REFUSAL}"`, 5_000);
        expect((await regions(page)).some((r) => String(r.pivotId) === s.P), `${combo} deleted the PivotTable`).toBe(true);
        expect((await objects(page)).some((o) => o.id === `pivot-visual-${s.P}`), `${combo} removed the box`).toBe(true);
        expect((await visualState(page, s.P))?.cellSelection, `${combo} dropped the cell selection`).not.toBeNull();
      }
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J9 copy: Ctrl+C, Home > Copy and the box menu's Copy each copy the selected cells from the hidden grid -- pasted on Sheet1 the displays and a value cell's style are the hidden grid's, in the box's NON-default style colours", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const leaf = leafRow(view);
      expect(view.colCount, "precondition: P shows at least 5 columns").toBeGreaterThanOrEqual(5);

      // ---- A NON-default PivotTable style (ruling R3, WP-C S10b). The style is
      // persisted on the pivot, the hidden grid is rewritten in its colours, and
      // the box resolves the same colours from the same preset file
      // (resolvePivotStyleOverrides, the rule the backend mirrors) -- so a paste
      // carries the colours the box shows, not the default style's.
      await invoke(page, "update_pivot_properties", { request: { pivotId: s.P, style: { styleId: J9_STYLE, themeOverrides: {} } } });
      expect((await regionOf(page, s.P)) as unknown as { style?: { styleId?: string } }, "the region does not carry the chosen style to the box").toMatchObject({
        style: { styleId: J9_STYLE },
      });
      const boxTheme = await callModule<Record<string, string>>(page, PIVOT_STYLES, "resolvePivotStyleOverrides", [J9_STYLE, null]);
      const defaultTheme = await callModule<Record<string, string>>(page, PIVOT_STYLES, "resolvePivotStyleOverrides", [null, null]);
      const boxValue = { background: boxTheme.valueBackground.toLowerCase(), text: boxTheme.valueText.toLowerCase() };
      expect(boxValue.background, `precondition: ${J9_STYLE}'s value cells look like the default style's`).not.toBe(defaultTheme.valueBackground.toLowerCase());
      {
        const region = await regionOf(page, s.P);
        const hiddenValueCell: [number, number, number] = [s.canvasIndex, region.startRow + leaf.viewRow, region.startCol + 1];
        await eventually(
          async () => styleColours(page, (await styleIndexes(page, [hiddenValueCell]))[0]),
          (c) => c.background === boxValue.background && c.text === boxValue.text,
          `the hidden grid's value cell did not take ${J9_STYLE}'s colours ${JSON.stringify(boxValue)}`,
          10_000,
        );
      }

      /** Select a 2 x 3 rectangle of view cells; returns its hidden-grid corners. */
      const selectRect = async (r0: number, c0: number): Promise<{ r0: number; c0: number; r1: number; c1: number }> => {
        await ensureCanvasZoom(page);
        await clickViewCell(page, s.P, { viewRow: r0, viewCol: c0 });
        await clickViewCell(page, s.P, { viewRow: r0 + 1, viewCol: c0 + 2 }, { shift: true });
        await eventually(
          () => visualState(page, s.P),
          (v) => v?.cellSelection?.anchorRow === r0 && v?.cellSelection?.anchorCol === c0 && v?.cellSelection?.endRow === r0 + 1 && v?.cellSelection?.endCol === c0 + 2,
          `precondition: the 2 x 3 rectangle at view (${r0},${c0}) is not selected`,
        );
        const region = await regionOf(page, s.P);
        return { r0: region.startRow + r0, c0: region.startCol + c0, r1: region.startRow + r0 + 1, c1: region.startCol + c0 + 2 };
      };
      const landed = async (how: string): Promise<void> => {
        const c = await eventually(() => clipboardChanged(page), (v) => v !== null, `${how} put nothing on the clipboard`, 15_000);
        expect([c!.rows, c!.cols, c!.sheet], `${how} did not copy the 2 x 3 rectangle of the canvas`).toEqual([2, 3, s.canvasIndex]);
      };
      const pasteAndCompare = async (how: string, src: { r0: number; c0: number; r1: number; c1: number }, dst: { row: number; col: number }): Promise<void> => {
        const want = await displaysOf(page, s.canvasIndex, src.r0, src.c0, src.r1, src.c1);
        await clickSheetTab(page, s.sheet1Index);
        const at = await gridCellPoint(page, dst.row, dst.col);
        await humanClick(page, at.x, at.y);
        await page.waitForTimeout(200);
        await gridKey(page, "Control+v");
        await eventually(
          () => displaysOf(page, s.sheet1Index, dst.row, dst.col, dst.row + 1, dst.col + 2),
          (got) => JSON.stringify(got) === JSON.stringify(want),
          `${how}: the paste on Sheet1 at ${a1(dst.row, dst.col)} does not show the hidden grid's ${JSON.stringify(want)}`,
          15_000,
        );
        const [srcStyle, dstStyle] = await styleIndexes(page, [
          [s.canvasIndex, src.r0, src.c0 + 1],
          [s.sheet1Index, dst.row, dst.col + 1],
        ]);
        expect(dstStyle, `${how}: the pasted value cell does not carry the hidden grid's style`).toBe(srcStyle);
        expect(await styleColours(page, dstStyle), `${how}: the pasted value cell does not wear the box's ${J9_STYLE} colours`).toEqual(boxValue);
        await clickSheetTab(page, s.canvasIndex);
        await ensureCanvasZoom(page);
        await eventually(() => cellSheetRect(page, s.P, 1, 0), (r) => r !== null, "the box did not repaint after returning to the canvas", 20_000);
      };

      // ---- Ctrl+C.
      const a = await selectRect(leaf.viewRow, 0);
      await markClipboard(page);
      await gridKey(page, "Control+c");
      await landed("Ctrl+C");
      await pasteAndCompare("Ctrl+C", a, { row: 9, col: 0 });

      // ---- Home > Copy.
      const b = await selectRect(leaf.viewRow + 1, 1);
      await markClipboard(page);
      await ensureHomeTab(page);
      await clickHomeControl(page, "fmt-copy");
      await closeHomeFlyouts(page);
      await landed("Home > Copy");
      await pasteAndCompare("Home > Copy", b, { row: 9, col: 4 });

      // ---- The box menu's Copy (a right-click INSIDE the selection keeps it).
      const c = await selectRect(leaf.viewRow, 2);
      await markClipboard(page);
      const rows = await openBoxMenu(page, s.P, { viewRow: leaf.viewRow, viewCol: 2 });
      expect(rows.map((r) => r.label), "the box menu offers no Copy").toContain("Copy");
      expect((await visualState(page, s.P))?.cellSelection, "the right-click inside the selection re-anchored it").toMatchObject({
        anchorRow: leaf.viewRow,
        anchorCol: 2,
        endRow: leaf.viewRow + 1,
        endCol: 4,
      });
      await clickBoxMenu(page, ["pivot:copy"]);
      await landed("the box menu's Copy");
      await pasteAndCompare("the box menu's Copy", c, { row: 9, col: 8 });
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J10 moving the box: the left border band drags it (64 px, one undo step, size unchanged), the hover grip drags it, and a Ctrl+click on the band adds it to a chart selection", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder, { chart: true });
      const frame0 = (await regionOf(page, s.P)).canvasFrame!;
      const view = await awPivotView(page, s.P);
      const leaf = leafRow(view);
      const frameNow = async () => (await regionOf(page, s.P)).canvasFrame!;

      // ---- Selected first, so Core's resize handles are live: dy = 16 keeps clear of the w handle and the corners.
      await clickViewCell(page, s.P, { viewRow: leaf.viewRow, viewCol: 1 });
      await eventually(() => visualState(page, s.P), (v) => !!v?.selected, "precondition: a cell click did not select the box");
      const geo = await readGridGeometry(page);
      const band = await sheetPointToPage(page, frame0.x + 2, frame0.y + 16);
      await page.mouse.move(band.x, band.y);
      await page.mouse.down();
      try {
        await page.mouse.move(band.x + 32 * geo.zoom, band.y, { steps: 4 });
        await page.mouse.move(band.x + 64 * geo.zoom, band.y, { steps: 4 });
      } finally {
        await page.mouse.up();
      }
      const moved = await eventually(frameNow, (f) => f.x === frame0.x + 64, "a drag from the left border band did not move the box by 64 px", 10_000);
      expect([moved.y, moved.width, moved.height], "the band drag resized or shifted the box").toEqual([frame0.y, frame0.width, frame0.height]);
      await gridKey(page, "Control+z");
      await eventually(frameNow, (f) => f.x === frame0.x, "one Ctrl+Z did not put the box back", 10_000);

      // ---- The hover grip.
      const free = await freeCanvasRect(page, { width: 16, height: 16 });
      await clickEmpty(page, free.x + 8, free.y + 8);
      const inside = await cellPagePoint(page, s.P, leaf.viewRow, 1);
      await page.mouse.move(inside.x, inside.y, { steps: 3 });
      const regionId = `pivot-visual-${s.P}`;
      const grip = await eventually(() => gripRect(page, regionId), (g) => g.shown, "hovering the box showed no grip", 5_000);
      // Onto the grip the way a hand does (moving-objects hoverBodyThen): from
      // just inside the edge the grip sits on, straight across it. The hover
      // grip shows only while the box is Core's hovered object, and a path that
      // leaves the box beside the grip (the first run went diagonally from the
      // inner cell and crossed the top edge right of the grip) ends the hover,
      // so the press lands on the empty page.
      const edgeY = grip.placement === "above" ? grip.y + grip.height : grip.y;
      const inward = grip.placement === "above" ? 1 : -1;
      await page.mouse.move(grip.centre.x, edgeY + inward * 30, { steps: 4 });
      await eventually(() => hoveredRegionId(page), (id) => id === regionId, "the point under the grip did not keep the box hovered");
      await page.mouse.move(grip.centre.x, edgeY + inward * 4, { steps: 3 });
      await page.mouse.move(grip.centre.x, grip.centre.y, { steps: 4 });
      await eventually(() => gripRect(page, regionId), (g) => g.shown, "the grip hid as the pointer reached it", 5_000);
      await page.mouse.down();
      try {
        await page.mouse.move(grip.centre.x + 32 * geo.zoom, grip.centre.y, { steps: 4 });
        await page.mouse.move(grip.centre.x + 64 * geo.zoom, grip.centre.y, { steps: 4 });
      } finally {
        await page.mouse.up();
      }
      const gripped = await eventually(frameNow, (f) => f.x === frame0.x + 64, "a drag of the hover grip did not move the box by 64 px", 10_000);
      expect([gripped.width, gripped.height]).toEqual([frame0.width, frame0.height]);
      await gridKey(page, "Control+z");
      await eventually(frameNow, (f) => f.x === frame0.x, "Ctrl+Z did not undo the grip drag", 10_000);

      // ---- Ctrl+click on the band adds the box to a chart selection (a cell is content, not a selection toggle).
      await clickEmpty(page, free.x + 8, free.y + 8);
      const chart = (await objects(page)).find((o) => o.chartId === s.chartId)!;
      const chartAt = await sheetPointToPage(page, chart.x + chart.w / 2, chart.y + chart.h / 2);
      await humanClick(page, chartAt.x, chartAt.y);
      await eventually(() => selectedSummary(page), (v) => JSON.stringify(v.types) === JSON.stringify(["chart"]), "precondition: the chart is not the selection");
      const f = await frameNow();
      const bandMid = await sheetPointToPage(page, f.x + 2, f.y + f.height / 2);
      await page.keyboard.down("Control");
      try {
        await humanClick(page, bandMid.x, bandMid.y);
      } finally {
        await page.keyboard.up("Control");
      }
      await eventually(
        () => selectedSummary(page),
        (v) => JSON.stringify(v.types) === JSON.stringify(["chart", "pivot-visual"]),
        "a Ctrl+click on the box's border band did not add the box to the chart selection",
      );
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J11 drill: a double-click on a value of an UNSELECTED box drills through to a new active sheet with a header row and data, without an error toast; the new sheet ends the undo history (Excel parity)", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const europe = rowHeaderCell(view, "Europe");
      expect(europe, "precondition: P lists Europe").toBeTruthy();
      const target: ViewCellRef = { viewRow: europe!.viewRow, viewCol: yearOf(view, "2013", -2).viewCol };
      expect(typeof cellAt(view, target.viewRow, target.viewCol)?.value, "precondition: the Europe row shows a value for the year").toBe("number");
      expect((await visualState(page, s.P))?.selected, "precondition: the box is not selected").toBe(false);
      const before = await sheetsResult(page);
      await startToasts(page);

      const p = await cellPagePoint(page, s.P, target.viewRow, target.viewCol);
      await page.mouse.dblclick(p.x, p.y);
      const after = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.length === before.sheets.length + 1 && r.activeIndex !== s.canvasIndex,
        "the double-click did not drill through to a new active sheet",
        120_000,
      );
      const drill = after.activeIndex;
      const head = await typedCells(page, drill, 0, 0, 1, 15);
      expect(head.filter((c) => c.row === 0 && c.display !== "").length, "the drill sheet has no header row").toBeGreaterThan(0);
      expect(head.filter((c) => c.row === 1 && c.display !== "").length, "the drill sheet has no data row").toBeGreaterThan(0);
      expect((await toasts(page)).filter((t) => t.variant === "error"), "the drill raised an error toast").toEqual([]);

      expect((await undoState(page)).canUndo, "a drill-through sheet did not end the undo history (BUG-0005 parity)").toBe(false);
      await gridKey(page, "Control+z");
      await page.waitForTimeout(500);
      expect((await sheetsResult(page)).sheets.length, "Ctrl+Z after the drill changed the sheets").toBe(after.sheets.length);
      await hidePanes(page);
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J12 value-cell menu: on the model pivot the value items show, Summarize is absent and the model-gated items say why; on the range pivot (never selected) Summarize is there and enabled on the FIRST right-click; Collapse/Expand on a value acts on its row item; Keep Only on a numeric year header keeps that year", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const view = await awPivotView(page, s.P);
      const y13 = yearOf(view, "2013", -2);
      const leaf = leafRow(view);

      const rows = await openBoxMenu(page, s.P, { viewRow: leaf.viewRow, viewCol: y13.viewCol });
      const labels = rows.map((r) => r.label);
      for (const want of ["Copy", "Number Format...", 'Remove "Revenue"', "Show Values As", "Show Details", "Value Field Settings...", "Expand/Collapse", "Sort"]) {
        expect(labels, `the value menu lacks "${want}"`).toContain(want);
      }
      expect(labels, "Summarize Values By showed on a data-model pivot").not.toContain("Summarize Values By");
      const sort = rows.find((r) => r.id === "pivot:sortByValue");
      expect(sort?.disabled, "Sort on a value is not greyed").toBe(true);
      expect(sort?.title, "Sort on a value does not say why it is greyed").toBe(SORT_BY_VALUE_REASON);
      await page.locator('[data-pivot-box-menu="0"] [role="menuitem"][data-item-id="pivot:sortByValue"]').hover();
      await page.waitForTimeout(300);
      expect(await page.locator('[data-pivot-box-menu="1"]').count(), "a greyed Sort opened its sub-menu").toBe(0);
      for (const id of ["pivot:numberFormat", "pivot:showValuesAs", "pivot:valueFieldSettings"]) {
        const row = rows.find((r) => r.id === id);
        expect(row?.disabled, `${id} is not greyed on a data-model pivot`).toBe(true);
        expect(row?.title, `${id} does not say why`).toBe(MODEL_PIVOT_REASON);
      }
      await closeBoxMenu(page);

      // ---- The RANGE pivot, never selected before: the first right-click already knows it is a range pivot.
      expect((await visualState(page, s.R))?.selected, "precondition: R was selected before").toBe(false);
      const rView = await awPivotView(page, s.R);
      const sumCol = headerCol(rView, "Sum of Units");
      const jan = rowHeaderCell(rView, "Jan");
      expect(sumCol >= 0 && !!jan, "precondition: R shows Jan and Sum of Units").toBe(true);
      const rRows = await openBoxMenu(page, s.R, { viewRow: jan!.viewRow, viewCol: sumCol });
      const summarize = rRows.find((r) => r.id === "pivot:summarizeBy");
      expect(summarize, "Summarize Values By is missing on the first right-click of a range pivot").toBeTruthy();
      expect(summarize!.disabled, "Summarize Values By is greyed on a range pivot").toBe(false);
      for (const id of ["pivot:numberFormat", "pivot:showValuesAs", "pivot:valueFieldSettings"]) {
        expect(rRows.find((r) => r.id === id)?.disabled, `${id} is greyed on a range pivot`).toBe(false);
      }
      await closeBoxMenu(page);

      // ---- Collapse / Expand on a value of the Europe row act on Europe.
      const europe = rowHeaderCell(view, "Europe");
      const territories = territoriesUnder(view, "Europe");
      expect(europe && territories.length > 0, `precondition: Europe and its territories (${JSON.stringify(rowLabelsOf(view))})`).toBe(true);
      expect(typeof cellAt(view, europe!.viewRow, y13.viewCol)?.value, "precondition: the Europe row shows a value for the year").toBe("number");
      await openBoxMenu(page, s.P, { viewRow: europe!.viewRow, viewCol: y13.viewCol });
      await clickBoxMenu(page, ["pivot:expandCollapse", "pivot:ec:collapse"]);
      await eventually(
        () => awPivotView(page, s.P),
        (v) => territories.every((t) => !rowLabelsOf(v).includes(t)) && rowLabelsOf(v).includes("Europe"),
        "Collapse on a value of the Europe row did not collapse Europe",
        60_000,
      );
      const collapsed = await awPivotView(page, s.P);
      const europeNow = rowHeaderCell(collapsed, "Europe")!;
      await openBoxMenu(page, s.P, { viewRow: europeNow.viewRow, viewCol: yearOf(collapsed, y13.label, -2).viewCol });
      await clickBoxMenu(page, ["pivot:expandCollapse", "pivot:ec:expand"]);
      await eventually(
        () => awPivotView(page, s.P),
        (v) => territories.every((t) => rowLabelsOf(v).includes(t)),
        "Expand on a value of the Europe row did not bring its territories back",
        60_000,
      );

      // ---- Keep Only on the NUMERIC column header (the label fix).
      const expanded = await awPivotView(page, s.P);
      const h13 = yearOf(expanded, y13.label, -2);
      await openBoxMenu(page, s.P, { viewRow: h13.viewRow, viewCol: h13.viewCol });
      await clickBoxMenu(page, ["pivot:filter", "pivot:filter:keepOnly"]);
      await eventually(
        () => awPivotView(page, s.P),
        (v) => {
          const ys = yearColumns(v);
          return ys.length === 1 && ys[0].label === y13.label;
        },
        `Keep Only Selected Items on the year header ${y13.label} did not leave that one year`,
        60_000,
      );
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J13 Summarize / Show Values As / Remove on the RANGE pivot keep the calculated column in its place and the rows untouched; Remove works on the model pivot too; Ctrl+Z restores", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const v0 = await awPivotView(page, s.R);
      const sumCol = headerCol(v0, "Sum of Units");
      const dblCol = headerCol(v0, "Double");
      const cntCol = headerCol(v0, "Count of Units");
      expect(sumCol >= 0 && dblCol > sumCol && cntCol > dblCol, `precondition: R's columns are Sum, Double, Count in that order (${sumCol}, ${dblCol}, ${cntCol})`).toBe(true);
      const labels0 = rowLabelsOf(v0);
      const sum0 = monthColumn(v0, sumCol);
      const dbl0 = monthColumn(v0, dblCol);
      expect(sum0.months, "precondition: R's Sum of Units per month").toEqual({ Jan: 10, Feb: 40, Mar: 20, Apr: 30 });
      expect(sum0.total).toBe(100);
      const jan = rowHeaderCell(v0, "Jan")!;
      const onSum: ViewCellRef = { viewRow: jan.viewRow, viewCol: sumCol };
      const keepsShape = (v: AwPivotView, what: string) => {
        expect(headerCol(v, "Double"), `${what} moved the calculated column`).toBe(dblCol);
        expect(monthColumn(v, dblCol).months, `${what} changed the calculated column's numbers`).toEqual(dbl0.months);
        expect(rowLabelsOf(v), `${what} changed the rows`).toEqual(labels0);
      };

      // ---- Summarize Values By > Max, then > Sum.
      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:summarizeBy", "pivot:summarizeBy:max"]);
      const vMax = await eventually(() => awPivotView(page, s.R), (v) => monthColumn(v, sumCol).total === 40, "Summarize Values By > Max did not make the grand total the maximum (40)", 30_000);
      expect(monthColumn(vMax, sumCol).months, "Max per month is not the seeded month's units").toEqual({ Jan: 10, Feb: 40, Mar: 20, Apr: 30 });
      keepsShape(vMax, "Summarize > Max");
      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:summarizeBy", "pivot:summarizeBy:sum"]);
      keepsShape(await eventually(() => awPivotView(page, s.R), (v) => monthColumn(v, sumCol).total === 100, "Summarize > Sum did not restore the total 100", 30_000), "Summarize > Sum");

      // ---- Show Values As > % of Grand Total, then No Calculation.
      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:showValuesAs", "pivot:showValuesAs:percent_of_total"]);
      const vPct = await eventually(
        () => awPivotView(page, s.R),
        (v) => {
          const t = monthColumn(v, sumCol).total;
          return t !== null && Math.abs(t - 1) < 1e-9;
        },
        "Show Values As > % of Grand Total did not make the grand total 1",
        30_000,
      );
      for (const [m, n] of Object.entries(monthColumn(vPct, sumCol).months)) {
        expect(n !== null && n <= 1, `${m} shows ${String(n)}, not a share of the grand total`).toBe(true);
      }
      expect(headerCol(vPct, "Double"), "% of Grand Total moved the calculated column").toBe(dblCol);
      expect(rowLabelsOf(vPct)).toEqual(labels0);
      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:showValuesAs", "pivot:showValuesAs:normal"]);
      const vNorm = await eventually(() => awPivotView(page, s.R), (v) => monthColumn(v, sumCol).total === 100, "No Calculation did not restore the units", 30_000);
      expect(monthColumn(vNorm, sumCol).months).toEqual(sum0.months);
      keepsShape(vNorm, "No Calculation");

      // ---- Remove "Count of Units"; Ctrl+Z brings it back.
      const removeRows = await openBoxMenu(page, s.R, { viewRow: jan.viewRow, viewCol: cntCol });
      expect(removeRows.map((r) => r.label)).toContain('Remove "Count of Units"');
      await clickBoxMenu(page, ["pivot:removeValueField"]);
      const vRemoved = await eventually(() => awPivotView(page, s.R), (v) => headerCol(v, "Count of Units") === -1, 'Remove "Count of Units" did not remove the column', 30_000);
      expect(headerCol(vRemoved, "Sum of Units") >= 0 && headerCol(vRemoved, "Double") > headerCol(vRemoved, "Sum of Units"), "Remove broke the Sum, Double order").toBe(true);
      expect(rowLabelsOf(vRemoved), "Remove touched the rows").toEqual(labels0);
      await gridKey(page, "Control+z");
      await eventually(() => awPivotView(page, s.R), (v) => headerCol(v, "Count of Units") === cntCol, "Ctrl+Z did not bring Count of Units back in its place", 30_000);

      // ---- The model pivot: Remove "Revenue"; Ctrl+Z.
      const pv = await awPivotView(page, s.P);
      const pLabels = rowLabelsOf(pv);
      const leaf = leafRow(pv);
      const pRows = await openBoxMenu(page, s.P, { viewRow: leaf.viewRow, viewCol: yearOf(pv, "2013", -2).viewCol });
      expect(pRows.map((r) => r.label)).toContain('Remove "Revenue"');
      await clickBoxMenu(page, ["pivot:removeValueField"]);
      const hasData = (v: AwPivotView) => v.rows.some((r) => r.cells.some((c) => c.cellType === "Data"));
      const pGone = await eventually(() => awPivotView(page, s.P), (v) => !hasData(v), 'Remove "Revenue" left value cells in the model pivot', 60_000);
      expect(rowLabelsOf(pGone), 'Remove "Revenue" touched the model pivot\'s rows').toEqual(pLabels);
      await gridKey(page, "Control+z");
      await eventually(() => awPivotView(page, s.P), (v) => hasData(v), 'Ctrl+Z did not bring "Revenue" back', 60_000);
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J14 dialog route on the range pivot: Value Field Settings... shows the Value Field Settings modal for Sum of Units, and Number Format... the Number Format modal", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder);
      const v = await awPivotView(page, s.R);
      const onSum: ViewCellRef = { viewRow: rowHeaderCell(v, "Jan")!.viewRow, viewCol: headerCol(v, "Sum of Units") };
      const modalOf = (title: string) =>
        page
          .locator("div")
          .filter({ has: page.locator("h2", { hasText: new RegExp(`^${escapeRegExp(title)}$`) }) })
          .filter({ has: page.getByRole("button", { name: "Cancel" }) })
          .last();

      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:valueFieldSettings"]);
      const vfs = modalOf("Value Field Settings");
      await expect(vfs, "Value Field Settings... showed no Value Field Settings modal").toBeVisible({ timeout: 20_000 });
      const words = await vfs.evaluate((el) =>
        [el.textContent ?? "", ...Array.from(el.querySelectorAll("input")).flatMap((i) => [(i as HTMLInputElement).value, (i as HTMLInputElement).placeholder])].join(" | "),
      );
      expect(words, "the modal is not about Sum of Units").toContain("Sum of Units");
      await vfs.getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator("h2", { hasText: /^Value Field Settings$/ })).toHaveCount(0);
      await hidePanes(page);

      await openBoxMenu(page, s.R, onSum);
      await clickBoxMenu(page, ["pivot:numberFormat"]);
      const nf = modalOf("Number Format");
      await expect(nf, "Number Format... showed no Number Format modal").toBeVisible({ timeout: 20_000 });
      await nf.getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator("h2", { hasText: /^Number Format$/ })).toHaveCount(0);
      await hidePanes(page);
    } finally {
      await cleanup(page, holder);
    }
  });

  test("J15 windowed pivot: deep in a scrolled customer pivot the value menu, Keep Only on the row label and a GETPIVOTDATA pick all name the right customer; copying the whole content is bounded (it completes within 15 s and pastes its first and last rows, or says it is too large)", async ({
    appPage: page,
  }) => {
    const holder: Holder = { conn: null };
    try {
      const s = await setup(page, holder, { windowed: true });
      const W = s.W!;
      const v0 = await awPivotView(page, W);
      expect(v0.isWindowed, "the customer pivot is not windowed").toBe(true);

      // ---- Wheel the box deep.
      const centre = await sheetPointToPage(page, W_FRAME.x + W_FRAME.width / 2, W_FRAME.y + W_FRAME.height / 2);
      await page.mouse.move(centre.x, centre.y);
      for (let i = 0; i < 80; i++) {
        const st = await visualState(page, W);
        if ((st?.scroll.top ?? 0) >= 350 * 20) break;
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(80);
      }
      const st = await eventually(() => visualState(page, W), (x) => (x?.scroll.top ?? 0) >= 350 * 20, "the wheel did not scroll the customer pivot past view row 350", 15_000);
      await page.waitForTimeout(800);
      let deep = -1;
      for (let r = Math.floor(st!.scroll.top / 20); r < Math.floor(st!.scroll.top / 20) + 30; r++) {
        if ((await cellSheetRect(page, W, r, 1)) !== null) {
          deep = r;
          break;
        }
      }
      expect(deep, "no value cell of the scrolled customer pivot is shown").toBeGreaterThanOrEqual(350);
      const win = await callModule<{ rows: Array<{ cells: AwPivotCell[] }> }>(page, MOD.PIVOT_API, "getPivotCellWindow", [W, deep, 1]);
      const customer = cellText(win.rows[0]?.cells[0]);
      expect(customer, `precondition: view row ${deep} names a customer`).not.toBe("");

      const valueRows = await openBoxMenu(page, W, { viewRow: deep, viewCol: 1 });
      for (const want of ["Show Details", "Value Field Settings..."]) {
        expect(valueRows.map((r) => r.label), `the windowed value menu lacks "${want}"`).toContain(want);
      }
      await closeBoxMenu(page);

      await openBoxMenu(page, W, { viewRow: deep, viewCol: 0 });
      await clickBoxMenu(page, ["pivot:filter", "pivot:filter:keepOnly"]);
      const only = await eventually(
        () => awPivotView(page, W),
        (v) => {
          const names = rowLabelsOf(v).filter((t) => t !== "Grand Total");
          return names.length === 1 && names[0] === customer;
        },
        `Keep Only Selected Items on "${customer}" (view row ${deep}) did not leave exactly that customer`,
        60_000,
      );
      const customerRow = rowHeaderCell(only, customer)!;

      await startFrEdit(page, s.fr, 0, 0, "=");
      await clickViewCell(page, W, { viewRow: customerRow.viewRow, viewCol: 1 });
      const text = await eventually(() => frEditText(page), (t) => t.startsWith("=GETPIVOTDATA("), "a pick on the filtered customer's value inserted no GETPIVOTDATA", 15_000);
      expect(text, "the GETPIVOTDATA pick does not name the customer").toContain(`"${customer.replace(/"/g, '""')}"`);
      await page.keyboard.press("Escape");
      await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel the pick edit");

      // ---- The copy bound: the whole content, timed.
      await pivotApi(page, "clearFilter", { pivotId: W, biFieldKey: "BI.dim_customer.fullname" }, 120_000);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const full = await eventually(() => awPivotView(page, W), (v) => v.isWindowed === true, "clearing the customer filter did not bring the windowed pivot back", 60_000);
      let shownCell: ViewCellRef | null = null;
      const top = Math.floor(((await visualState(page, W))?.scroll.top ?? 0) / 20);
      for (let r = Math.max(1, top); r < top + 30 && !shownCell; r++) {
        if ((await cellSheetRect(page, W, r, 1)) !== null) shownCell = { viewRow: r, viewCol: 1 };
      }
      expect(shownCell, "no value cell of the customer pivot is shown after clearing the filter").not.toBeNull();
      await clickViewCell(page, W, shownCell!);
      await gridKey(page, "Control+a");
      const all = await eventually(() => visualState(page, W), (x) => !!x?.cellSelection && x.cellSelection.endRow > 1000, "Ctrl+A did not select the customer pivot's content");
      const sel = all!.cellSelection!;
      const cellCount = (Math.abs(sel.endRow - sel.anchorRow) + 1) * (Math.abs(sel.endCol - sel.anchorCol) + 1);

      await markClipboard(page);
      await dismissToasts(page);
      await startToasts(page);
      const t0 = Date.now();
      await gridKey(page, "Control+c");
      const outcome = await eventually(
        async (): Promise<{ kind: "copied"; clip: ClipSummary } | { kind: "tooLarge" } | { kind: "failed"; text: string } | null> => {
          const clip = await clipboardChanged(page);
          if (clip) return { kind: "copied", clip };
          const ts = await toasts(page);
          if (ts.some((t) => t.text.includes(COPY_TOO_LARGE))) return { kind: "tooLarge" };
          const failed = ts.find((t) => /Copy failed|could not be read/.test(t.text));
          return failed ? { kind: "failed", text: failed.text } : null;
        },
        (v) => v !== null,
        `copying ${cellCount} cells neither completed nor said it was too large within 15 s`,
        15_000,
      );
      const elapsed = Date.now() - t0;
      console.log(`[canvas-pick-cells] J15 copy of the whole customer pivot: ${cellCount} cells (${full.totalRowCount ?? "?"} view rows), outcome ${outcome!.kind}, ${elapsed} ms`);
      expect(outcome!.kind, `the copy failed: ${JSON.stringify(outcome)}`).not.toBe("failed");
      if (outcome!.kind === "tooLarge") {
        expect(cellCount, "the copy said 'too large' for fewer than 200,000 cells").toBeGreaterThan(200_000);
        return;
      }
      const clip = (outcome as { kind: "copied"; clip: ClipSummary }).clip;
      expect(elapsed, "the whole-pivot copy took longer than 15 s").toBeLessThanOrEqual(15_000);
      const firstWant = await displaysOf(page, s.canvasIndex, clip.firstRow, clip.startCol, clip.firstRow, clip.startCol + clip.cols - 1);
      const lastWant = await displaysOf(page, s.canvasIndex, clip.lastRow, clip.startCol, clip.lastRow, clip.startCol + clip.cols - 1);
      await clickSheetTab(page, s.sheet1Index);
      const h1 = await gridCellPoint(page, 0, 7);
      await humanClick(page, h1.x, h1.y);
      await gridKey(page, "Control+v");
      await eventually(
        () => displaysOf(page, s.sheet1Index, clip.rows - 1, 7, clip.rows - 1, 7 + clip.cols - 1),
        (got) => JSON.stringify(got) === JSON.stringify(lastWant),
        `the paste on Sheet1 did not reproduce the last copied row ${JSON.stringify(lastWant)}`,
        120_000,
      );
      expect(await displaysOf(page, s.sheet1Index, 0, 7, 0, 7 + clip.cols - 1), "the paste on Sheet1 did not reproduce the first copied row").toEqual(firstWant);
    } finally {
      await cleanup(page, holder);
    }
  });
});
