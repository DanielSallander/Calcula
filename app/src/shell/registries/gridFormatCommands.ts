//! FILENAME: app/src/shell/registries/gridFormatCommands.ts
// PURPOSE: Excel's Home > Cells > Format menu, its Cell Size and Visibility
//          halves, as commands:
//            core.format.rowHeight / columnWidth / defaultWidth (the dialogs)
//            core.format.hideRows / hideColumns / unhideRows / unhideColumns
//          and the ONE writer every Row Height / Column Width door shares.
// CONTEXT: Each acts on the rows or columns the SELECTION SPANS, whatever its
//          shape -- a cell range, whole rows, whole columns, several areas --
//          as Excel's do. The right-click equivalents (gridExtensions.ts) are
//          offered only for whole-row / whole-column selections and keep that
//          rule; they share this file's dialog openers and writer.
//
//          ONE CALL, ONE UNDO STEP. A resize is ONE backend call over the span
//          as inclusive runs (`setRowHeights` / `setColumnWidths`, Rust
//          `set_row_heights` / `set_column_widths`), which records ONE compact
//          undo step itself -- an OWNED step, so inside a script's batch it
//          joins. It used to be one `set_row_height` call (and one undo entry,
//          hundreds of bytes each) per line, bracketed here in a transaction:
//          Select All + Column Width was 16,384 IPC round trips.
//
//          THE SPAN LIMITS. Column Width has none any more: a sheet has 16,384
//          columns and the batch sets them all in one call. ROW HEIGHT keeps
//          one, at the same 16,384, for a reason the batch does not remove: the
//          sheet stores an explicit height PER ROW, and that map is what every
//          structural undo snapshot copies, what every dimension refresh sends
//          to the grid (a million rows is ~50 MB of IPC) and what the grid's
//          scroll arithmetic walks. Excel's own answer to "Select All, then Row
//          Height" is a per-sheet DEFAULT row height, which needs a persisted
//          per-sheet field (open item, rust-followup report); until then the
//          bound is "no Row Height stores more heights than Select All +
//          Column Width already does". HIDE keeps its bound too: it sends every
//          index. Unhide is NOT limited: it sends only the user-hidden lines
//          inside the span (read from the backend authority), never the span
//          itself -- which is what makes Excel's "select all, Unhide Rows"
//          idiom work.
//
//          SELECTION OWNERS. Every command here except Default Width writes to
//          Core's selection, so each asks `refuseIfSelectionOwned` FIRST (one
//          toast while a floating grid's cell holds the selection, BUG-0185
//          class). Default Width is a sheet setting, not a selection door.

import { CommandRegistry, CoreCommands } from "@api/commands";
import { showToast } from "@api/notifications";
import { DialogExtensions } from "@api/ui";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import {
  getGridStateSnapshot,
  hideRows,
  hideColumns,
  refreshGridData,
  refreshGridDimensions,
} from "@api/grid";
import { emitAppEvent, AppEvents } from "@api/events";
import { canPerformAction } from "@api/backend";
import {
  setRowHeights,
  setColumnWidths,
  getRowHeight,
  getColumnWidth,
  getDefaultDimensions,
  setDefaultColumnWidth,
  getUserHiddenRows,
  getUserHiddenCols,
} from "../../core/lib/tauri-api";
import { columnToLetter, type Selection } from "../../core/types";
import { DIMENSION_INPUT_DIALOG_ID, type DimensionInputData } from "../dialogs/DimensionInputDialog";

// ============================================================================
// The selection span
// ============================================================================

export type LineAxis = "rows" | "columns";
/** An inclusive run of row or column indices. */
export type LineInterval = [number, number];

/**
 * The most ROWS one Row Height will give a height of their own, and the most
 * lines one Hide sends (every column of a sheet). See the file header: the
 * call is no longer the limit, the per-row stored height is.
 */
export const MAX_LINES_PER_FORMAT_COMMAND = 16_384;

/**
 * The rows (or columns) any area of the selection covers, as merged ascending
 * runs. Overlapping and ADJACENT areas join, so the runs are also what a range
 * label should show.
 */
export function selectionLineIntervals(selection: Selection, axis: LineAxis): LineInterval[] {
  const areas = [selection, ...(selection.additionalRanges ?? [])];
  const runs: LineInterval[] = areas
    .map((a): LineInterval =>
      axis === "rows"
        ? [Math.min(a.startRow, a.endRow), Math.max(a.startRow, a.endRow)]
        : [Math.min(a.startCol, a.endCol), Math.max(a.startCol, a.endCol)],
    )
    .sort((x, y) => x[0] - y[0]);
  const merged: LineInterval[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] <= last[1] + 1) last[1] = Math.max(last[1], run[1]);
    else merged.push([run[0], run[1]]);
  }
  return merged;
}

function lineCount(runs: readonly LineInterval[]): number {
  return runs.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0);
}

function expand(runs: readonly LineInterval[]): number[] {
  const out: number[] = [];
  for (const [lo, hi] of runs) for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** Lines (any order, repeats allowed) as merged ascending runs. */
function runsOf(lines: readonly number[]): LineInterval[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const runs: LineInterval[] = [];
  for (const line of sorted) {
    const last = runs[runs.length - 1];
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else runs.push([line, line]);
  }
  return runs;
}

/** "4", "4:7", "B", "B:D" -- several runs joined with ", " (display only). */
function rangeLabel(axis: LineAxis, runs: readonly LineInterval[]): string {
  const name = (i: number) => (axis === "rows" ? String(i + 1) : columnToLetter(i));
  return runs.map(([lo, hi]) => (lo === hi ? name(lo) : `${name(lo)}:${name(hi)}`)).join(", ");
}

function refuse(message: string): void {
  showToast(message, { variant: "info" });
}

/** The span of Core's selection on `axis`, or null (no selection). */
function selectionSpan(axis: LineAxis): LineInterval[] | null {
  const selection = getGridStateSnapshot()?.selection ?? null;
  if (!selection) return null;
  return selectionLineIntervals(selection, axis);
}

/** Refuse a span beyond the limit; true when refused. */
function refuseOversizedSpan(action: string, axis: LineAxis, runs: readonly LineInterval[]): boolean {
  const count = lineCount(runs);
  if (count <= MAX_LINES_PER_FORMAT_COMMAND) return false;
  const what = axis === "rows" ? "rows" : "columns";
  refuse(
    `${action} can change at most ${MAX_LINES_PER_FORMAT_COMMAND.toLocaleString("en-US")} ${what} at once; ` +
      `this selection spans ${count.toLocaleString("en-US")}. Select fewer ${what}.`,
  );
  return true;
}

// ============================================================================
// The one writer (both doors)
// ============================================================================

/**
 * Set every line of `runs` to `px` in ONE backend call (one undo step, which
 * the backend records), then have the grid re-read the sizes. A refusal (a
 * protected sheet) is shown and changes nothing -- the backend gates before it
 * writes.
 */
async function applyLineSizes(axis: LineAxis, runs: readonly LineInterval[], px: number): Promise<void> {
  if (runs.length === 0) return;
  const label = axis === "rows" ? "Row Height" : "Column Width";
  let landed = false;
  try {
    if (axis === "rows") await setRowHeights(runs, px);
    else await setColumnWidths(runs, px);
    landed = true;
  } catch (err) {
    console.error(`[gridFormatCommands] ${label} failed:`, err);
    void alertAsync(err instanceof Error ? err.message : String(err));
  }

  refreshGridDimensions();
  refreshGridData();
  if (landed) {
    // ONE announcement per gesture (not one per line): its listeners --
    // pinned controls re-deriving their pixel positions -- re-read every
    // geometry anyway, and 16,384 of them would each start that work again.
    const sheetIndex = getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
    const first = runs[0][0];
    if (axis === "rows") emitAppEvent(AppEvents.ROW_RESIZED, { sheetIndex, row: first, height: px });
    else emitAppEvent(AppEvents.COLUMN_RESIZED, { sheetIndex, col: first, width: px });
  }
}

/** Row Height for `rows`, ONE call and ONE undo step (both the Home tab and the right-click door). */
export function applyRowHeights(rows: readonly number[], px: number): Promise<void> {
  return applyLineSizes("rows", runsOf(rows), px);
}

/** Column Width for `cols`, ONE call and ONE undo step. */
export function applyColumnWidths(cols: readonly number[], px: number): Promise<void> {
  return applyLineSizes("columns", runsOf(cols), px);
}

// ============================================================================
// Dialog openers (both doors)
// ============================================================================

function openDimensionDialog(data: DimensionInputData): void {
  DialogExtensions.openDialog(DIMENSION_INPUT_DIALOG_ID, data as unknown as Record<string, unknown>);
}

/** Open Row Height on `runs`, seeded with the first row's current height. */
async function openRowHeightDialogOnRuns(runs: readonly LineInterval[], label: string): Promise<void> {
  if (runs.length === 0) return;
  const defaults = await getDefaultDimensions();
  const currentPx = (await getRowHeight(runs[0][0])) ?? defaults.defaultRowHeight;
  openDimensionDialog({
    mode: "rowHeight",
    currentPx,
    rangeLabel: label,
    onResult: (px) => applyLineSizes("rows", runs, px),
  });
}

/** Open Column Width on `runs`, seeded with the first column's current width. */
async function openColumnWidthDialogOnRuns(runs: readonly LineInterval[], label: string): Promise<void> {
  if (runs.length === 0) return;
  const defaults = await getDefaultDimensions();
  const currentPx = (await getColumnWidth(runs[0][0])) ?? defaults.defaultColumnWidth;
  openDimensionDialog({
    mode: "columnWidth",
    currentPx,
    rangeLabel: label,
    onResult: (px) => applyLineSizes("columns", runs, px),
  });
}

/** Open Row Height for `rows`, seeded with the first row's current height. */
export async function openRowHeightDialog(rows: readonly number[], label: string): Promise<void> {
  await openRowHeightDialogOnRuns(runsOf(rows), label);
}

/** Open Column Width for `cols`, seeded with the first column's current width. */
export async function openColumnWidthDialog(cols: readonly number[], label: string): Promise<void> {
  await openColumnWidthDialogOnRuns(runsOf(cols), label);
}

/** The labels a right-click door shows for a single run. */
export function lineRangeLabel(axis: LineAxis, start: number, end: number): string {
  return rangeLabel(axis, [[Math.min(start, end), Math.max(start, end)]]);
}

// ============================================================================
// Commands
// ============================================================================

async function sizeCommand(axis: LineAxis): Promise<void> {
  const action = axis === "rows" ? "Row Height" : "Column Width";
  if (refuseIfSelectionOwned(action)) return;
  const runs = selectionSpan(axis);
  if (!runs || runs.length === 0) return;
  // Rows only: a column span can never pass the bound (a sheet has 16,384
  // columns), and the batch sets any number of them in one call.
  if (axis === "rows" && refuseOversizedSpan(action, axis, runs)) return;
  const label = rangeLabel(axis, runs);
  if (axis === "rows") await openRowHeightDialogOnRuns(runs, label);
  else await openColumnWidthDialogOnRuns(runs, label);
}

/**
 * Excel's Default Width... (the Standard Width dialog). The backend's
 * `set_default_column_width` is gated by the sheet's "format columns"
 * protection option (as `set_column_width` is) and is the authority; it is
 * asked here FIRST as well, so a protected sheet refuses before the dialog
 * opens (Excel greys the item) -- a failed read refuses rather than guess.
 *
 * Named divergence: Calcula's standard width is ONE value for the whole
 * workbook (AppState.default_column_width), where Excel keeps one per sheet.
 */
async function defaultWidthCommand(): Promise<void> {
  let allowed = false;
  try {
    allowed = (await canPerformAction("formatColumns")).canEdit === true;
  } catch (err) {
    console.error("[gridFormatCommands] could not read the sheet's protection:", err);
  }
  if (!allowed) {
    refuse("The sheet is protected: its columns cannot be formatted. Unprotect the sheet to change the standard width.");
    return;
  }
  const defaults = await getDefaultDimensions();
  openDimensionDialog({
    mode: "defaultWidth",
    currentPx: defaults.defaultColumnWidth,
    onResult: async (px) => {
      try {
        await setDefaultColumnWidth(px);
      } catch (err) {
        void alertAsync(err instanceof Error ? err.message : String(err));
        return;
      }
      // The grid reads the standard width from the backend (Spreadsheet's
      // `dimensions:refresh` handler); untold, nothing moves until a reload.
      refreshGridDimensions();
      refreshGridData();
    },
  });
}

/**
 * Hide every line of the span (the backend authority records it as one undo
 * step, persists it and marks the document dirty -- core/lib/hiddenRowsCols).
 */
async function hideCommand(axis: LineAxis): Promise<void> {
  const action = axis === "rows" ? "Hide Rows" : "Hide Columns";
  if (refuseIfSelectionOwned(action)) return;
  const runs = selectionSpan(axis);
  if (!runs || runs.length === 0) return;
  if (refuseOversizedSpan(action, axis, runs)) return;
  const lines = expand(runs);
  if (axis === "rows") await hideRows(lines, true);
  else await hideColumns(lines, true);
  refreshGridData();
}

/**
 * Unhide the USER-hidden lines inside the span -- read from the backend, the
 * authority -- and nothing else: a row a filter or an outline hides is not the
 * user's to unhide here (clearing the filter or expanding the group is), the
 * rule the right-click Unhide follows. Nothing hidden in the span: nothing
 * happens (Excel).
 */
async function unhideCommand(axis: LineAxis): Promise<void> {
  const action = axis === "rows" ? "Unhide Rows" : "Unhide Columns";
  if (refuseIfSelectionOwned(action)) return;
  const runs = selectionSpan(axis);
  if (!runs || runs.length === 0) return;
  let userHidden: number[];
  try {
    userHidden = axis === "rows" ? await getUserHiddenRows() : await getUserHiddenCols();
  } catch (err) {
    console.error(`[gridFormatCommands] ${action}: could not read the hidden ${axis}:`, err);
    void alertAsync(err instanceof Error ? err.message : String(err));
    return;
  }
  const inSpan = userHidden.filter((i) => runs.some(([lo, hi]) => i >= lo && i <= hi));
  if (inSpan.length === 0) return;
  if (axis === "rows") await hideRows(inSpan, false);
  else await hideColumns(inSpan, false);
  refreshGridData();
}

/**
 * Register the seven commands. Called once by `registerCoreGridContextMenu`
 * (bootstrap); returns the cleanup (tests). One `register(CoreCommands.X, ...)`
 * per command, spelled out, for the source-reading shortcut census.
 *
 * None is script-safe: scripts have their own audited dimension and
 * visibility APIs, and a dialog-opening command is no script's door.
 */
export function registerGridFormatCommands(): () => void {
  CommandRegistry.register(CoreCommands.ROW_HEIGHT, () => sizeCommand("rows"));
  CommandRegistry.register(CoreCommands.COLUMN_WIDTH, () => sizeCommand("columns"));
  CommandRegistry.register(CoreCommands.DEFAULT_WIDTH, () => defaultWidthCommand());
  CommandRegistry.register(CoreCommands.HIDE_ROWS, () => hideCommand("rows"));
  CommandRegistry.register(CoreCommands.HIDE_COLUMNS, () => hideCommand("columns"));
  CommandRegistry.register(CoreCommands.UNHIDE_ROWS, () => unhideCommand("rows"));
  CommandRegistry.register(CoreCommands.UNHIDE_COLUMNS, () => unhideCommand("columns"));
  return () => {
    for (const id of [
      CoreCommands.ROW_HEIGHT,
      CoreCommands.COLUMN_WIDTH,
      CoreCommands.DEFAULT_WIDTH,
      CoreCommands.HIDE_ROWS,
      CoreCommands.HIDE_COLUMNS,
      CoreCommands.UNHIDE_ROWS,
      CoreCommands.UNHIDE_COLUMNS,
    ]) {
      CommandRegistry.unregister(id);
    }
  };
}
