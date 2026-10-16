/**
 * Plumbing for the live journeys that run against the owner's AdventureWorks
 * model (`journeys/canvas-pick-cells.spec.ts`, WP-A: reference picks on floating
 * objects (D-PICK) and canvas pivot cells (D-CELLS)).
 *
 * THE FIXTURE IS THE OWNER'S OWN. The model file is
 * C:\Dropbox\Projekt\Calcula\context_manager\model.json (a `{ formatVersion,
 * model }` bundle, source id `Adventureworks`, kind postgres) against Postgres
 * at localhost:5432 (postgres/postgres, database `Adventureworks`). A server
 * that cannot be reached FAILS the caller -- never a skip: a proof that quietly
 * ran without its fixture is not a proof.
 *
 * Everything here drives or reads the RUNNING app through its own routes (the
 * `@api/pivot` facade, the backend's own commands, the pivot extension's
 * journey hook `__CALCULA_PIVOT__`, the floating-grid helpers of
 * edit-harness.ts). Nothing in here asserts; the spec decides.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import { bounded, eventually, invoke, sheetPointToPage, type AppWindow } from "./canvas-live";
import { pivotApi } from "./pivot-live";
import { formulaBarValue, frEditorText } from "./edit-harness";

// The floating-grid recipes the pick journeys share live in edit-harness.ts
// (frCell, frCellPoint, createFr, ...); re-exported here so a journey on the
// AdventureWorks fixture has ONE import for its plumbing.
export {
  createFr,
  frCell,
  frCellPoint,
  frEditorOpen,
  frEditorText,
  frLocalSelection,
  setFrCell,
  type FrInfo,
} from "./edit-harness";

// ---------------------------------------------------------------------------
// The model and its connection
// ---------------------------------------------------------------------------

export const AW_MODEL_PATH = "C:\\Dropbox\\Projekt\\Calcula\\context_manager\\model.json";
export const AW_SOURCE_ID = "Adventureworks";
export const AW_CONNECTION_STRING = "postgresql://postgres:postgres@localhost:5432/Adventureworks";

/** The sentence an unreachable server fails with (a HARD failure, never `test.skip`). */
export const AW_UNREACHABLE =
  "Postgres AdventureWorks at localhost:5432 is not reachable -- start it; this journey is the live proof and must not be skipped";

export interface AwConnection {
  connectionId: string;
  name: string;
}

/** A backend call that may legitimately take long (a model connect, a big query). */
async function invokeSlow<T = unknown>(page: Page, cmd: string, args: unknown, ms = 180_000): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), { c: cmd, a: args }) as Promise<T>,
    ms,
  );
}

/**
 * Create a connection holding the owner's model and connect its Postgres
 * source. Throws `AW_UNREACHABLE` (with the backend's own words) when the
 * server does not answer.
 */
export async function connectAdventureWorks(page: Page, name: string): Promise<AwConnection> {
  const bundle = JSON.parse(fs.readFileSync(AW_MODEL_PATH, "utf8")) as Record<string, unknown>;
  const info = await invokeSlow<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: bundle },
  });
  try {
    await invokeSlow(page, "bi_model_connect_source", {
      connectionId: info.id,
      sourceId: AW_SOURCE_ID,
      connectionString: AW_CONNECTION_STRING,
      remember: false,
    });
  } catch (e) {
    await invoke(page, "bi_delete_connection", { connectionId: info.id }).catch(() => undefined);
    throw new Error(`${AW_UNREACHABLE} (${String(e).slice(0, 400)})`);
  }
  return { connectionId: info.id, name };
}

/** Drop the connection (cleanup; never throws). */
export async function dropAdventureWorks(page: Page, conn: AwConnection | null): Promise<void> {
  if (!conn) return;
  await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Canvas pivots
// ---------------------------------------------------------------------------

export interface BiFieldRef {
  table: string;
  column: string;
}

export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the box last painted, as the pivot extension's journey hook reports it. */
export interface PivotVisualState {
  box: { x: number; y: number; width: number; height: number };
  scroll: { top: number; left: number };
  selected: boolean;
  cellSelection: { pivotId: string; anchorRow: number; anchorCol: number; endRow: number; endCol: number } | null;
}

/** `__CALCULA_PIVOT__.getVisualState(pivotId)`: null while the box has not painted. */
export async function visualState(page: Page, pivotId: string): Promise<PivotVisualState | null> {
  return page.evaluate((id) => {
    const hook = (window as unknown as { __CALCULA_PIVOT__?: { getVisualState: (id: string) => unknown } }).__CALCULA_PIVOT__;
    return (hook?.getVisualState(id) ?? null) as never;
  }, pivotId);
}

/**
 * Where view cell (`viewRow`, `viewCol`) of a box is SHOWN, in SHEET px (the
 * visible part only); null when it is scrolled away, hidden or not painted.
 */
export async function cellSheetRect(page: Page, pivotId: string, viewRow: number, viewCol: number): Promise<CanvasFrame | null> {
  return page.evaluate(
    ({ id, r, c }) => {
      const hook = (window as unknown as { __CALCULA_PIVOT__?: { cellSheetRect: (id: string, r: number, c: number) => unknown } }).__CALCULA_PIVOT__;
      return (hook?.cellSheetRect(id, r, c) ?? null) as never;
    },
    { id: pivotId, r: viewRow, c: viewCol },
  );
}

/** Page (client) pixel at the centre of a box's view cell; throws when the cell is not shown. */
export async function cellPagePoint(page: Page, pivotId: string, viewRow: number, viewCol: number): Promise<{ x: number; y: number }> {
  const rect = await eventually(
    () => cellSheetRect(page, pivotId, viewRow, viewCol),
    (r) => r !== null && r.width > 2 && r.height > 2,
    `view cell (${viewRow},${viewCol}) of pivot ${pivotId} is not shown in its box`,
    10_000,
  );
  return sheetPointToPage(page, rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
}

/**
 * Create a data-model pivot as a box on canvas `canvasIndex` and give it its
 * fields (the `fixall-pivot.spec.ts` model-pivot recipe plus the canvas frame of
 * `canvas-live.ts` createPivot); returns once the box has painted.
 */
export async function createAwCanvasPivot(
  page: Page,
  opts: {
    canvasIndex: number;
    connectionId: string;
    frame: CanvasFrame;
    rows: BiFieldRef[];
    columns: BiFieldRef[];
    values: Array<{ measureName: string }>;
    name?: string;
  },
): Promise<string> {
  const v = await pivotApi<{ pivotId: string }>(
    page,
    "createFromBiModel",
    {
      destinationSheet: opts.canvasIndex,
      connectionId: opts.connectionId,
      destinationCell: "A1",
      ...(opts.name ? { name: opts.name } : {}),
      canvasFrame: { ...opts.frame, frozenHeaders: true },
    },
    180_000,
  );
  const pivotId = String(v.pivotId);
  await pivotApi(
    page,
    "updateBiFields",
    { pivotId, rowFields: opts.rows, columnFields: opts.columns, valueFields: opts.values, filterFields: [] },
    180_000,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
  await eventually(() => visualState(page, pivotId), (s) => s !== null, `the canvas pivot ${pivotId} never painted a box`, 60_000);
  return pivotId;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface AwPivotCell {
  cellType: string;
  value: unknown;
  formattedValue?: string;
  indentLevel?: number;
  isExpandable?: boolean;
  isCollapsed?: boolean;
  valueFieldIndex?: number;
}

export interface AwPivotRow {
  viewRow: number;
  rowType: string;
  visible: boolean;
  cells: AwPivotCell[];
}

export interface AwPivotView {
  pivotId: string;
  version: number;
  rowCount: number;
  colCount: number;
  rowLabelColCount: number;
  columnHeaderRowCount: number;
  rows: AwPivotRow[];
  isWindowed?: boolean;
  totalRowCount?: number;
  valueFieldNames?: string[];
}

/** The full view (or, for a windowed pivot, its descriptors plus the first window) through the facade. */
export async function awPivotView(page: Page, pivotId: string): Promise<AwPivotView> {
  return pivotApi<AwPivotView>(page, "getView", pivotId, 120_000);
}

/** A cell's text: its formatted value, else its raw value ("" for null). */
export function cellText(c: AwPivotCell | undefined): string {
  if (!c) return "";
  if (c.formattedValue !== undefined && c.formattedValue !== null && c.formattedValue !== "") return String(c.formattedValue);
  return c.value === null || c.value === undefined ? "" : String(c.value);
}

/** The first cell of the view satisfying `predicate`, with its view coordinates (rows in order, then columns). */
export async function findViewCell(
  page: Page,
  pivotId: string,
  predicate: (cell: AwPivotCell, viewRow: number, viewCol: number, row: AwPivotRow) => boolean,
): Promise<{ viewRow: number; viewCol: number; cell: AwPivotCell } | null> {
  const view = await awPivotView(page, pivotId);
  return findInView(view, predicate);
}

/** `findViewCell` over a view already read. */
export function findInView(
  view: AwPivotView,
  predicate: (cell: AwPivotCell, viewRow: number, viewCol: number, row: AwPivotRow) => boolean,
): { viewRow: number; viewCol: number; cell: AwPivotCell } | null {
  for (const row of view.rows) {
    for (let c = 0; c < row.cells.length; c++) {
      if (predicate(row.cells[c], row.viewRow, c, row)) return { viewRow: row.viewRow, viewCol: c, cell: row.cells[c] };
    }
  }
  return null;
}

/** Every row label the view shows (the RowHeader cells' texts, rows in order). */
export function rowLabelsOf(view: AwPivotView): string[] {
  const out: string[] = [];
  for (const row of view.rows) {
    for (const c of row.cells) if (c.cellType === "RowHeader") out.push(cellText(c));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The floating-grid edit
// ---------------------------------------------------------------------------

/**
 * The text of the live floating-grid edit: its in-cell textarea, else the
 * formula bar that hosts it (moved here from fixall-edit.spec.ts, which now
 * imports it).
 */
export async function frEditText(page: Page): Promise<string> {
  const t = await frEditorText(page);
  if (t !== null) return t;
  return formulaBarValue(page);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** 0-based column -> letters (0 -> A, 999 -> ALL). */
export function colLetters(col: number): string {
  let s = "";
  let c = col + 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

/** 0-based (row, col) -> "B5". */
export function a1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** A regex fragment matching a sheet name as a formula spells it: bare, or quoted. */
export function sheetNamePattern(name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = name.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${esc}|'${quoted}')`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
