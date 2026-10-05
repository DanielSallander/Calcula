//! FILENAME: app/extensions/FillSeries/lib/runSeries.ts
// PURPOSE: Run Fill > Series... over Core's selection: read the lines, plan
//          each (lib/seriesPlan.ts; AutoFill through the fill handle's own
//          engine, @api/fillPatterns), and write everything in ONE undo step.
// CONTEXT: Home tab 2026-10-04 (fill.series). The dialog
//          (components/SeriesDialog.tsx) calls `runSeries` on OK; the refusals
//          are asked again here because the selection can change while the
//          dialog is open.

import { getGridStateSnapshot, refreshGridData } from "@api/grid";
import {
  getRangeCellsTyped,
  getViewportCells,
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  type TypedCellData,
} from "@api/lib";
import type { CellData } from "@api/types";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import {
  planFillLine,
  processPendingFills,
  type FillLineCell,
  type PendingFill,
} from "@api/fillPatterns";
import { selectionRefusalFor } from "@api/selectionOwner";
import {
  planSeriesLine,
  cellsToStop,
  type SeriesLineCell,
  type SeriesOptions,
  type SeriesWrite,
} from "./seriesPlan";

const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/** Excel's last row and column (0-based). */
const MAX_ROW = 1_048_575;
const MAX_COL = 16_383;
/** The most cells one Series may write (get_range_cells_typed's own cap). */
export const MAX_SERIES_CELLS = 100_000;

interface Range {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Why a Series cannot run right now, or null. Shared with the command. */
export function seriesRefusal(): string | null {
  const owned = selectionRefusalFor("Series");
  if (owned !== null) return owned;
  const snapshot = getGridStateSnapshot();
  if (snapshot?.surface === "canvas") return "Series is not available on a canvas sheet: it holds objects, not cells.";
  const sel = snapshot?.selection;
  if (!sel) return "Select the cells to fill first.";
  if ((sel.additionalRanges?.length ?? 0) > 0) return "This command cannot be used on multiple selections.";
  return null;
}

export function selectedRange(): Range | null {
  const sel = getGridStateSnapshot()?.selection;
  if (!sel) return null;
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

function kindOf(cell: TypedCellData | undefined): SeriesLineCell["kind"] {
  if (!cell || cell.type === "empty") return "empty";
  if (cell.type === "number") return "number";
  if (cell.type === "text" && (cell.value === "" || cell.value === null)) return "empty";
  return "text";
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The lines of `range` in the chosen direction, as cell coordinates. */
function linesOf(range: Range, columns: boolean): Array<Array<{ row: number; col: number }>> {
  const lines: Array<Array<{ row: number; col: number }>> = [];
  if (columns) {
    for (let col = range.startCol; col <= range.endCol; col++) {
      const line = [];
      for (let row = range.startRow; row <= range.endRow; row++) line.push({ row, col });
      lines.push(line);
    }
  } else {
    for (let row = range.startRow; row <= range.endRow; row++) {
      const line = [];
      for (let col = range.startCol; col <= range.endCol; col++) line.push({ row, col });
      lines.push(line);
    }
  }
  return lines;
}

/**
 * AutoFill, the fill handle's way: per line, the leading run of filled cells
 * is the source and the rest of the line is filled from it -- through the
 * handle's OWN per-line plan (`planFillLine`: the formula-filtered inference,
 * the fill index, the cycling source), then its formula shifting and source
 * styles. Nothing is decided here: this loop was a copy, and the copy had
 * dropped the formula filter (review finding (j), 2026-10-04).
 */
async function planAutoFill(
  lines: Array<Array<{ row: number; col: number }>>,
  cells: Map<string, CellData>,
): Promise<Array<{ row: number; col: number; value: string; styleIndex?: number }>> {
  const pending: PendingFill[] = [];
  for (const line of lines) {
    const source: FillLineCell[] = [];
    for (const at of line) {
      const cell = cells.get(`${at.row},${at.col}`);
      const value = cell ? cell.formula || cell.display || "" : "";
      if (value === "") break;
      source.push({ ...at, value, styleIndex: cell?.styleIndex ?? 0 });
    }
    if (source.length === 0 || source.length >= line.length) continue;
    pending.push(...planFillLine({ source, targets: line.slice(source.length) }));
  }
  if (pending.length === 0) return [];
  return processPendingFills(pending);
}

/**
 * Fill the selection with the series `opts` describes. Resolves to null on
 * success, or the sentence to show (the dialog keeps itself open with it).
 */
export async function runSeries(opts: SeriesOptions): Promise<string | null> {
  const refusal = seriesRefusal();
  if (refusal !== null) return refusal;
  let range = selectedRange();
  if (!range) return "Select the cells to fill first.";
  const columns = opts.seriesIn === "columns";

  const lone = range.startRow === range.endRow && range.startCol === range.endCol;
  if (lone && opts.type !== "autofill") {
    // A lone cell runs on to the Stop value (Excel's own behaviour); without
    // one there is nothing to fill.
    if (opts.stop === null) return "Select the cells to fill, or enter a Stop value.";
    const [start] = await getRangeCellsTyped(range.startRow, range.startCol, range.startRow, range.startCol);
    if (!start || start.type !== "number" || typeof start.value !== "number") {
      return "The selected cell holds no number to start the series from.";
    }
    const room = columns ? MAX_ROW - range.startRow + 1 : MAX_COL - range.startCol + 1;
    const length = cellsToStop(start.value, opts, Math.min(room, MAX_SERIES_CELLS));
    if (length <= 1) return null;
    range = columns
      ? { ...range, endRow: range.startRow + length - 1 }
      : { ...range, endCol: range.startCol + length - 1 };
  }

  const count = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  if (count > MAX_SERIES_CELLS) {
    return `Series fills at most ${MAX_SERIES_CELLS.toLocaleString("en-US")} cells at once; select a smaller range.`;
  }

  const lines = linesOf(range, columns);
  let updates: Array<{ row: number; col: number; value: string; styleIndex?: number; invariant?: boolean }>;
  try {
    if (opts.type === "autofill") {
      const view = await getViewportCells(range.startRow, range.startCol, range.endRow, range.endCol);
      const byKey = new Map(view.map((c) => [`${c.row},${c.col}`, c]));
      updates = await planAutoFill(lines, byKey);
    } else {
      const typed = await getRangeCellsTyped(range.startRow, range.startCol, range.endRow, range.endCol);
      const typedAt = new Map(typed.map((c) => [`${c.row},${c.col}`, c]));
      // The start cells' styles (the format the series carries, D18).
      const starts = columns
        ? await getViewportCells(range.startRow, range.startCol, range.startRow, range.endCol)
        : await getViewportCells(range.startRow, range.startCol, range.endRow, range.startCol);
      const styleAt = new Map(starts.map((c) => [`${c.row},${c.col}`, c.styleIndex ?? 0]));
      const writes: SeriesWrite[] = [];
      for (const line of lines) {
        const cells: SeriesLineCell[] = line.map((at) => {
          const t = typedAt.get(`${at.row},${at.col}`);
          return {
            ...at,
            kind: kindOf(t),
            value: t && t.type === "number" && typeof t.value === "number" ? t.value : null,
            styleIndex: styleAt.get(`${at.row},${at.col}`) ?? 0,
          };
        });
        writes.push(...planSeriesLine(cells, opts));
      }
      // Canonical numbers ("0.5" in every locale): skip delocalising.
      updates = writes.map((w) => ({ ...w, invariant: true }));
    }
  } catch (err) {
    return messageOf(err);
  }
  if (updates.length === 0) return null;

  // ONE undo step, closed only by the begin that opened it.
  const tx = ownUndoTransaction(await beginUndoTransaction("Series"), UNDO_CLOSES);
  try {
    await updateCellsBatch(updates);
  } catch (err) {
    await tx.cancel().catch(() => {});
    return messageOf(err);
  }
  await tx.commit();
  refreshGridData();
  return null;
}
