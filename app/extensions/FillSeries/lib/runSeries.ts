//! FILENAME: app/extensions/FillSeries/lib/runSeries.ts
// PURPOSE: Run Fill > Series... over Core's selection: read the lines, plan
//          each (lib/seriesPlan.ts; AutoFill through the fill handle's own
//          engine, @api/fillPatterns), and write everything in ONE undo step.
// CONTEXT: Home tab 2026-10-04 (fill.series). The dialog
//          (components/SeriesDialog.tsx) calls `runSeries` on OK; the refusals
//          are asked again here because the selection can change while the
//          dialog is open.
//          P3 (owner finding G3): the series fills the cells the door targets
//          -- Core's selection, or a floating grid's own cells, read through
//          @api/cellTarget and written with the target. The question is asked
//          SILENTLY here (cellTargetFor): the dialog shows the sentence itself.

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
import {
  cellTargetFor,
  getCellTargetCells,
  getCellTargetCellsTyped,
  targetRefOf,
  type CellTarget,
} from "@api/cellTarget";
import {
  planSeriesLine,
  cellsToStop,
  type SeriesLineCell,
  type SeriesOptions,
  type SeriesWrite,
} from "./seriesPlan";
import { formatNumber } from "@api/locale";

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

/** Where a Series writes: the target the door resolved and its (normalised) range. */
export interface SeriesPlace {
  target: CellTarget;
  range: Range;
}

/**
 * Where a Series over `t` would write, or why it cannot run right now.
 * Shared with the command (which resolved `t` out loud).
 */
export function seriesPlaceFor(t: CellTarget): SeriesPlace | { refusal: string } {
  let sel: (Range & { additionalRanges?: unknown[] }) | null | undefined;
  if (t.kind === "object") {
    // An object's cells are an ordinary (backing) sheet's, wherever the
    // object sits -- a canvas page included.
    sel = t.selection;
  } else {
    const snapshot = getGridStateSnapshot();
    if (snapshot?.surface === "canvas") {
      return { refusal: "Series is not available on a canvas sheet: it holds objects, not cells." };
    }
    sel = snapshot?.selection;
  }
  if (!sel) return { refusal: "Select the cells to fill first." };
  if ((sel.additionalRanges?.length ?? 0) > 0) return { refusal: "This command cannot be used on multiple selections." };
  return {
    target: t,
    range: {
      startRow: Math.min(sel.startRow, sel.endRow),
      startCol: Math.min(sel.startCol, sel.endCol),
      endRow: Math.max(sel.startRow, sel.endRow),
      endCol: Math.max(sel.startCol, sel.endCol),
    },
  };
}

/** `seriesPlaceFor` over the target asked SILENTLY (the dialog shows the sentence). */
export function seriesPlace(): SeriesPlace | { refusal: string } {
  const t = cellTargetFor("content", "Series");
  return "refusal" in t ? { refusal: t.refusal } : seriesPlaceFor(t);
}

/** Typed cells of `r` on the place's cells (the object's own, or the active sheet's). */
function readTyped(t: CellTarget, r: Range): Promise<TypedCellData[]> {
  const ref = targetRefOf(t);
  return ref ? getCellTargetCellsTyped(ref, r) : getRangeCellsTyped(r.startRow, r.startCol, r.endRow, r.endCol);
}

/** Display / formula / style cells of `r` on the place's cells. */
async function readStyled(t: CellTarget, r: Range): Promise<CellData[]> {
  const ref = targetRefOf(t);
  if (ref) return (await getCellTargetCells(ref, r)).cells;
  return getViewportCells(r.startRow, r.startCol, r.endRow, r.endCol);
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
  const place = seriesPlace();
  if ("refusal" in place) return place.refusal;
  const t = place.target;
  let range = place.range;
  const columns = opts.seriesIn === "columns";
  // The last row / column the series may reach: the sheet's, or the object's
  // write extent (a cell past it cannot hold a value).
  const lastRow = t.kind === "object" ? t.bounds.rows - 1 : MAX_ROW;
  const lastCol = t.kind === "object" ? t.bounds.cols - 1 : MAX_COL;

  const lone = range.startRow === range.endRow && range.startCol === range.endCol;
  if (lone && opts.type !== "autofill") {
    // A lone cell runs on to the Stop value (Excel's own behaviour); without
    // one there is nothing to fill.
    if (opts.stop === null) return "Select the cells to fill, or enter a Stop value.";
    const [start] = await readTyped(t, {
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: range.startRow,
      endCol: range.startCol,
    });
    if (!start || start.type !== "number" || typeof start.value !== "number") {
      return "The selected cell holds no number to start the series from.";
    }
    const room = columns ? lastRow - range.startRow + 1 : lastCol - range.startCol + 1;
    const length = cellsToStop(start.value, opts, Math.min(room, MAX_SERIES_CELLS));
    if (length <= 1) return null;
    range = columns
      ? { ...range, endRow: range.startRow + length - 1 }
      : { ...range, endCol: range.startCol + length - 1 };
  }

  const count = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  if (count > MAX_SERIES_CELLS) {
    return `Series fills at most ${formatNumber(MAX_SERIES_CELLS, { grouping: true, decimals: 0 })} cells at once; select a smaller range.`;
  }

  const lines = linesOf(range, columns);
  let updates: Array<{ row: number; col: number; value: string; styleIndex?: number; invariant?: boolean }>;
  try {
    if (opts.type === "autofill") {
      const view = await readStyled(t, range);
      const byKey = new Map(view.map((c) => [`${c.row},${c.col}`, c]));
      updates = await planAutoFill(lines, byKey);
    } else {
      const typed = await readTyped(t, range);
      const typedAt = new Map(typed.map((c) => [`${c.row},${c.col}`, c]));
      // The start cells' styles (the format the series carries, D18).
      const starts = columns
        ? await readStyled(t, { startRow: range.startRow, startCol: range.startCol, endRow: range.startRow, endCol: range.endCol })
        : await readStyled(t, { startRow: range.startRow, startCol: range.startCol, endRow: range.endRow, endCol: range.startCol });
      const styleAt = new Map(starts.map((c) => [`${c.row},${c.col}`, c.styleIndex ?? 0]));
      const writes: SeriesWrite[] = [];
      for (const line of lines) {
        const cells: SeriesLineCell[] = line.map((at) => {
          const typedCell = typedAt.get(`${at.row},${at.col}`);
          return {
            ...at,
            kind: kindOf(typedCell),
            value: typedCell && typedCell.type === "number" && typeof typedCell.value === "number" ? typedCell.value : null,
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
    await updateCellsBatch(updates, { target: targetRefOf(t) });
  } catch (err) {
    await tx.cancel().catch(() => {});
    return messageOf(err);
  }
  await tx.commit();
  refreshGridData();
  return null;
}
