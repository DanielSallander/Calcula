//! FILENAME: app/src/core/lib/autoFitCommands/autoFitCommands.ts
// PURPOSE: Excel's AutoFit Column Width and AutoFit Row Height as COMMANDS over
//          the selection -- the Home tab's Format menu, object scripts, and the
//          Orientation menu's `{ growOnly: true }` after rotating text.
// CONTEXT: The handlers behind the grid commands `autoFitColumnWidth` /
//          `autoFitRowHeight`, which Core's useSpreadsheetSelection registers.
//          AutoFit used to exist only as the header double-click (the clicked
//          column / row, widened to the selected WHOLE columns / rows), which
//          measures every cell of the column; the ribbon commands follow
//          Excel's ribbon rules instead, below. The measuring is the renderer's
//          (gridRenderer/layout/autoFit: fonts, wrap, indents, merges and the
//          extension contributions); this module decides WHAT is measured and
//          WHAT is written, in one undo step.
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-04):
// - AutoFit Column Width on a cell RANGE fits ONLY the selected cells, and may
//   SHRINK the column; WHOLE columns fit every cell in them. A column with
//   nothing selected in it keeps its width. Each column is fitted on its own.
// - AutoFit Row Height fits the WHOLE row whatever is selected in it (a
//   wrapped cell outside the selection still raised the row); an empty row
//   goes back to the standard height.
// - Rows / columns the user HID inside the selection are unhidden and fitted.
// - One Undo restores the whole fit.
// `{ growOnly: true }` (Calcula's, for the Orientation menu): a row / column
// that is too small for its content grows; NOTHING shrinks, an empty row keeps
// its height, and nothing is unhidden -- so rotating text never undoes a size
// the user chose (Excel's automatic row height does the same for rotated text).

import type { CellData, CellTargetRef, DimensionOverrides, GridConfig, Selection } from "../../types";
import {
  setColsHidden,
  setColumnWidths,
  setRowHeights,
  setRowsHidden,
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  getAllStyles,
  getCellsInCols,
  getCellsInRows,
  setColumnWidth as setColumnWidthApi,
  setRowHeight as setRowHeightApi,
} from "../tauri-api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "../undoTransactionOwnership";
import { applyColsHidden, applyRowsHidden, type HiddenDispatch } from "../hiddenRowsCols";
import { measureOptimalColumnWidth, measureOptimalRowHeight } from "../gridRenderer/layout/autoFit";
import { alertAsync } from "../dialogs";
import { getActiveGridTheme } from "../../theme/skinLoader";
import { setColumnWidth, setRowHeight } from "../../state/gridActions";
import { selectionBlocks, type Block } from "../merge/mergeGeometry";
import {
  announceCellTargetObjectChanged,
  getCellTargetCells,
  getCellTargetLines,
  type CellTargetLines,
} from "../../../api/cellTarget";

/** The commands' optional arguments (`CommandRegistry.execute(id, args)`). */
export interface AutoFitArgs {
  /** Grow what is too small; never shrink, reset or unhide anything. */
  growOnly?: boolean;
}

/** `args` as the commands read it: anything but `{ growOnly: true }` is a full fit. */
export function readAutoFitArgs(args: unknown): { growOnly: boolean } {
  return {
    growOnly: typeof args === "object" && args !== null && (args as AutoFitArgs).growOnly === true,
  };
}

/** What a fit needs from the grid that runs it. */
export interface AutoFitCommandHost {
  /** The selection the fit acts on. */
  selection: Selection | null;
  config: Pick<
    GridConfig,
    "totalRows" | "totalCols" | "defaultCellWidth" | "defaultCellHeight" | "minColumnWidth" | "minRowHeight"
  >;
  /** The grid's current sizes and hidden sets (the reducer's mirror). */
  dimensions: DimensionOverrides | undefined;
  /** The grid reducer's dispatch: sizes and unhides are mirrored into it. */
  dispatch: HiddenDispatch;
  /** Announce a size the backend accepted (the app event listeners). */
  onColumnResized(col: number, width: number): void;
  onRowResized(row: number, height: number): void;
  /** Repaint once the fit is done. */
  redraw(): void;
  /**
   * The OBJECT whose lines are fitted (a floating grid's, P3), with its write
   * extent, or absent for the active sheet. With a target the cells are
   * measured from the object's styled read (`getCellTargetCells`) with the
   * SAME measure functions, compared with the object's OWN sizes and hidden
   * lines, and written to the object with `setRowHeights` / `setColumnWidths` /
   * `setRowsHidden` / `setColsHidden` and the target -- never to the sheet's
   * sizes or the reducer's mirror, which describe the host under the object.
   */
  target?: { ref: CellTargetRef; bounds: { rows: number; cols: number } };
}

/** The closes an owned transaction uses, read when the close runs. */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function themeFonts(): { cellFontFamily: string; cellFontSize: number } {
  const t = getActiveGridTheme();
  return { cellFontFamily: t.cellFontFamily, cellFontSize: t.cellFontSize };
}

function within(index: number, start: number, end: number): boolean {
  return index >= start && index <= end;
}

/** Inclusive [start, end] runs covering every block's rows, merged, ascending. */
function mergedRowRuns(blocks: Block[]): Array<[number, number]> {
  const runs = blocks.map((b): [number, number] => [b.startRow, b.endRow]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && run[0] <= last[1] + 1) last[1] = Math.max(last[1], run[1]);
    else out.push([run[0], run[1]]);
  }
  return out;
}

/** One size to write: a column's width or a row's height. */
interface SizeChange {
  index: number;
  size: number;
}

/**
 * Apply a planned fit as ONE undo step: unhide first, then each size --
 * backend FIRST, reducer after it accepted, so the grid never shows a size the
 * document does not have. A begin that JOINS a script's batch closes nothing.
 * Never throws: a refusal reaches the user.
 */
async function applyFit(
  label: string,
  unhide: number[],
  changes: SizeChange[],
  ops: {
    unhide(indices: number[]): Promise<boolean>;
    write(change: SizeChange): Promise<void>;
  },
): Promise<void> {
  if (unhide.length === 0 && changes.length === 0) return;
  let tx: OwnedUndoTransaction | null = null;
  let landed = 0;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);
    if (unhide.length > 0) {
      // hiddenRowsCols is THE door for a user unhide, and it shows its own
      // refusal; a refused unhide ends the fit here without a second message.
      if (!(await ops.unhide(unhide))) {
        await tx.cancel();
        return;
      }
      landed++;
    }
    for (const change of changes) {
      await ops.write(change);
      landed++;
    }
    await tx.commit();
  } catch (error) {
    console.error(`[autoFitCommands] ${label} failed:`, error);
    // What LANDED is committed, never cancelled: a cancel drops the undo record
    // and keeps the writes, so the sizes already changed could not be undone.
    if (landed > 0) {
      await tx?.commit().catch(() => {});
    } else {
      await tx?.cancel().catch(() => {});
    }
    await alertAsync(messageOf(error));
  }
}

// ============================================================================
// AutoFit Column Width
// ============================================================================

/**
 * Excel's AutoFit Column Width over `host.selection` (every Ctrl+click block).
 * See the file header for the rules.
 */
export async function runAutoFitColumnWidth(host: AutoFitCommandHost, args?: unknown): Promise<void> {
  const blocks = selectionBlocks(host.selection);
  if (blocks.length === 0) return;
  if (host.target) {
    await runTargetAutoFit("cols", host, host.target, blocks, readAutoFitArgs(args).growOnly);
    return;
  }
  const { growOnly } = readAutoFitArgs(args);
  const { config } = host;
  const dims = host.dimensions;

  // The cells to measure, per column (keyed by row, so a cell two blocks share
  // counts once). A WHOLE-column block measures every column it spans even
  // with no cell in it -- an extension's contribution (a pivot overlay) can
  // still ask for a width, as with the header double-click.
  const cellsByCol = new Map<number, Map<number, CellData>>();
  const measureEvenEmpty = new Set<number>();
  let styles;
  try {
    for (const b of blocks) {
      const wholeColumns = b.startRow === 0 && b.endRow >= config.totalRows - 1;
      let cells: CellData[];
      if (wholeColumns) {
        cells = await getCellsInCols(b.startCol, b.endCol);
        for (let c = b.startCol; c <= b.endCol; c++) measureEvenEmpty.add(c);
      } else {
        // Read along the SHORTER side: A1:XFD3 is three rows, not the whole sheet.
        const height = b.endRow - b.startRow + 1;
        const width = b.endCol - b.startCol + 1;
        const read = height <= width ? await getCellsInRows(b.startRow, b.endRow) : await getCellsInCols(b.startCol, b.endCol);
        cells = read.filter((cell) => within(cell.row, b.startRow, b.endRow) && within(cell.col, b.startCol, b.endCol));
      }
      for (const cell of cells) {
        let column = cellsByCol.get(cell.col);
        if (!column) cellsByCol.set(cell.col, (column = new Map()));
        column.set(cell.row, cell);
      }
    }
    styles = cellsByCol.size > 0 || measureEvenEmpty.size > 0 ? await getAllStyles() : [];
  } catch (error) {
    console.error("[autoFitCommands] AutoFit Column Width: reading the selection failed:", error);
    await alertAsync(messageOf(error));
    return;
  }

  // Columns the user hid inside the selection are unhidden (Excel) -- never
  // for growOnly.
  const unhide = growOnly
    ? []
    : [...(dims?.manuallyHiddenCols ?? [])]
        .filter((c) => blocks.some((b) => within(c, b.startCol, b.endCol)))
        .sort((a, b) => a - b);

  const theme = themeFonts();
  const columns = [...new Set([...cellsByCol.keys(), ...measureEvenEmpty])].sort((a, b) => a - b);
  const changes: SizeChange[] = [];
  for (const col of columns) {
    const cells = [...(cellsByCol.get(col)?.values() ?? [])];
    const optimal = measureOptimalColumnWidth(col, cells, styles, theme, config.minColumnWidth);
    // Nothing to fit: Excel leaves the width alone.
    if (optimal === null) continue;
    const current = dims?.columnWidths.get(col) ?? config.defaultCellWidth;
    if (optimal === current) continue;
    if (growOnly && optimal < current) continue;
    changes.push({ index: col, size: optimal });
  }

  await applyFit("AutoFit Column Width", unhide, changes, {
    unhide: (cols) => applyColsHidden(cols, false, host.dispatch),
    write: async ({ index, size }) => {
      await setColumnWidthApi(index, size);
      host.dispatch(setColumnWidth(index, size));
      host.onColumnResized(index, size);
    },
  });
  host.redraw();
}

// ============================================================================
// AutoFit Row Height
// ============================================================================

/**
 * Excel's AutoFit Row Height over every row `host.selection` spans (every
 * Ctrl+click block). See the file header for the rules.
 */
export async function runAutoFitRowHeight(host: AutoFitCommandHost, args?: unknown): Promise<void> {
  const blocks = selectionBlocks(host.selection);
  if (blocks.length === 0) return;
  if (host.target) {
    await runTargetAutoFit("rows", host, host.target, blocks, readAutoFitArgs(args).growOnly);
    return;
  }
  const { growOnly } = readAutoFitArgs(args);
  const { config } = host;
  const dims = host.dimensions;
  const runs = mergedRowRuns(blocks);
  const inRuns = (row: number) => runs.some(([a, b]) => within(row, a, b));

  // EVERY cell of each spanned row -- the whole row is fitted, not the
  // selected cells (Excel). Read sparsely, so a whole-column selection reaches
  // only the rows that hold something.
  const cellsByRow = new Map<number, CellData[]>();
  let styles;
  try {
    for (const [start, end] of runs) {
      for (const cell of await getCellsInRows(start, end)) {
        const row = cellsByRow.get(cell.row);
        if (row) row.push(cell);
        else cellsByRow.set(cell.row, [cell]);
      }
    }
    styles = await getAllStyles();
  } catch (error) {
    console.error("[autoFitCommands] AutoFit Row Height: reading the selection failed:", error);
    await alertAsync(messageOf(error));
    return;
  }

  const unhide = growOnly
    ? []
    : [...(dims?.manuallyHiddenRows ?? [])].filter(inRuns).sort((a, b) => a - b);

  // The rows that can change: those with content, those with a height of their
  // own (an empty one goes back to the standard height), and those unhidden.
  // An empty row already at the standard height has nothing to change.
  const ownHeights = [...(dims?.rowHeights.keys() ?? [])].filter(inRuns);
  const rows = [...new Set([...cellsByRow.keys(), ...ownHeights, ...unhide])].sort((a, b) => a - b);

  const theme = themeFonts();
  const columnWidths = dims?.columnWidths ?? new Map<number, number>();
  const changes: SizeChange[] = [];
  for (const row of rows) {
    const optimal = measureOptimalRowHeight(
      cellsByRow.get(row) ?? [],
      styles,
      columnWidths,
      config.defaultCellWidth,
      theme,
      config.minRowHeight,
      config.defaultCellHeight,
      row,
    );
    // An empty row resets to the standard height -- unless growing only.
    if (optimal === null && growOnly) continue;
    const target = optimal ?? config.defaultCellHeight;
    const current = dims?.rowHeights.get(row) ?? config.defaultCellHeight;
    if (target === current) continue;
    if (growOnly && target < current) continue;
    changes.push({ index: row, size: target });
  }

  await applyFit("AutoFit Row Height", unhide, changes, {
    unhide: (indices) => applyRowsHidden(indices, false, host.dispatch),
    write: async ({ index, size }) => {
      await setRowHeightApi(index, size);
      host.dispatch(setRowHeight(index, size));
      host.onRowResized(index, size);
    },
  });
  host.redraw();
}

// ============================================================================
// AutoFit on an OBJECT's cells (a floating grid's, P3)
// ============================================================================

/** `blocks` clipped to the object's extent; blocks wholly outside it are dropped. */
function clipToBounds(blocks: Block[], bounds: { rows: number; cols: number }): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const endRow = Math.min(b.endRow, bounds.rows - 1);
    const endCol = Math.min(b.endCol, bounds.cols - 1);
    if (b.startRow > endRow || b.startCol > endCol) continue;
    out.push({ startRow: b.startRow, startCol: b.startCol, endRow, endCol });
  }
  return out;
}

/**
 * The same rules as the sheet's fit, on an object's cells: a column fits the
 * SELECTED cells, a row fits its WHOLE row of the object; lines the object
 * hides inside the selection are unhidden (never for growOnly); one undo step.
 */
async function runTargetAutoFit(
  axis: "rows" | "cols",
  host: AutoFitCommandHost,
  target: { ref: CellTargetRef; bounds: { rows: number; cols: number } },
  selected: Block[],
  growOnly: boolean,
): Promise<void> {
  const label = axis === "cols" ? "AutoFit Column Width" : "AutoFit Row Height";
  const blocks = clipToBounds(selected, target.bounds);
  if (blocks.length === 0) return;
  const { config } = host;

  let lines: CellTargetLines | null;
  let styles;
  const cellsByLine = new Map<number, Map<string, CellData>>();
  try {
    lines = await getCellTargetLines(target.ref);
    if (!lines) return;
    for (const b of blocks) {
      // A column fits the selected cells; a row fits its whole row of the object.
      const rect =
        axis === "cols"
          ? b
          : { startRow: b.startRow, startCol: 0, endRow: b.endRow, endCol: Math.max(0, target.bounds.cols - 1) };
      const read = await getCellTargetCells(target.ref, rect);
      for (const cell of read.cells) {
        const key = axis === "cols" ? cell.col : cell.row;
        let line = cellsByLine.get(key);
        if (!line) cellsByLine.set(key, (line = new Map()));
        line.set(`${cell.row}:${cell.col}`, cell);
      }
    }
    styles = await getAllStyles();
  } catch (error) {
    console.error(`[autoFitCommands] ${label}: reading the floating grid's cells failed:`, error);
    await alertAsync(messageOf(error));
    return;
  }

  const inBlocks = (index: number) =>
    blocks.some((b) => (axis === "cols" ? within(index, b.startCol, b.endCol) : within(index, b.startRow, b.endRow)));
  const hiddenNow = axis === "cols" ? lines.hiddenCols : lines.hiddenRows;
  const unhide = growOnly ? [] : hiddenNow.filter(inBlocks).sort((a, b) => a - b);
  const sizes = axis === "cols" ? lines.colWidths : lines.rowHeights;
  const ownSized = Object.keys(sizes)
    .map(Number)
    .filter((i) => Number.isFinite(i) && inBlocks(i));
  const defaultSize = axis === "cols" ? config.defaultCellWidth : config.defaultCellHeight;

  const theme = themeFonts();
  const columnWidths = new Map<number, number>(
    Object.entries(lines.colWidths).map(([k, v]): [number, number] => [Number(k), v]),
  );
  // The lines that can change: those with content; for rows also those with a
  // height of their own (an empty one goes back to the standard height); and
  // those unhidden.
  const indices = [...new Set([...cellsByLine.keys(), ...(axis === "rows" ? ownSized : []), ...unhide])].sort(
    (a, b) => a - b,
  );
  const changes: SizeChange[] = [];
  for (const index of indices) {
    const cells = [...(cellsByLine.get(index)?.values() ?? [])];
    const optimal =
      axis === "cols"
        ? measureOptimalColumnWidth(index, cells, styles, theme, config.minColumnWidth, false)
        : measureOptimalRowHeight(
            cells,
            styles,
            columnWidths,
            config.defaultCellWidth,
            theme,
            config.minRowHeight,
            config.defaultCellHeight,
            index,
            false,
          );
    let size: number;
    if (optimal === null) {
      // Nothing to fit: a column keeps its width; an empty row goes back to the
      // standard height -- unless growing only.
      if (axis === "cols" || growOnly) continue;
      size = defaultSize;
    } else {
      size = optimal;
    }
    const current = sizes[index] ?? defaultSize;
    if (size === current) continue;
    if (growOnly && size < current) continue;
    changes.push({ index, size });
  }

  const ref = target.ref;
  await applyFit(label, unhide, changes, {
    unhide: async (indices) => {
      if (axis === "cols") await setColsHidden(indices, false, { target: ref });
      else await setRowsHidden(indices, false, { target: ref });
      return true;
    },
    write: async ({ index, size }) => {
      if (axis === "cols") await setColumnWidths([[index, index]], size, { target: ref });
      else await setRowHeights([[index, index]], size, { target: ref });
    },
  });
  announceCellTargetObjectChanged(ref);
  host.redraw();
}
