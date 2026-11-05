//! FILENAME: app/src/core/lib/ctrlEnterFill.ts
// PURPOSE: Ctrl+Enter: the typed entry in EVERY cell of EVERY block of the
//          selection, a formula moved relative to the ACTIVE cell -- which
//          cells, and what each one receives.
// CONTEXT: Excel's rules, measured live (Excel 16):
//          - every area (2026-11-04, lane multiarea probe2, BUG-0396): "=B1"
//            Ctrl+Enter over A1:A2, C3, E5:F5 with A1 active writes A1 =B1,
//            A2 =B2, C3 =D3, E5 =F5, F5 =G5 -- each cell's formula shifted by its
//            offset from the active cell, as a relative copy shifts it; with C3
//            active, C3 =B1 and A1 / A2 =#REF! (moved off the sheet). The shift
//            is the backend's own fill shifter (`shiftFormulasBatch`, the one
//            Fill Down and the fill handle use): ONE call for the whole
//            selection.
//          - which cells (2026-11-05, lane uic probe1..probe3, rev-ui-4): a
//            merged area takes the entry in its top-left cell only -- B2:C2
//            merged inside A1:C3, `7` Ctrl+Enter leaves C2 empty. While the
//            sheet is in FILTER MODE (@api/autoFilterService
//            isActiveSheetFilterMode) every HIDDEN row and column of the
//            selection is skipped -- the filter's rows, rows hidden by hand
//            inside or outside the filtered range, even under criteria that hide
//            nothing; otherwise hidden rows and columns (by hand, a collapsed
//            outline) are filled like any other.
//          - what each cell gets (rev-ui-5): THE ACTIVE CELL'S ENTRY DECIDES FOR
//            EVERY CELL. `+B1` over A1:A2 writes A1 =+B1, A2 =+B2 (the leading
//            sign starts a formula, typed spelling kept); `=B1` with a
//            Text-formatted ACTIVE cell writes the TEXT "=B1" in A1 and in the
//            General A2; with a Text-formatted A2 instead, A2 gets the formula
//            =B2; `5` puts the NUMBER 5 in a Text-formatted A2; `007` with a
//            Text-formatted active cell puts the text "007" in the General A2.
//          So the kind of entry is never decided here: the active cell's entry
//          is WRITTEN FIRST, through the backend's own typed-entry ladder
//          (core/engine/src/typed_entry.rs -- a leading `+` / `-`, the Text
//          format, the apostrophe, the locale's numbers and dates), and every
//          other cell then receives what that cell became. A frontend copy of
//          the ladder (this file once tested `startsWith("=")` alone, so `+B1`
//          reached every cell unshifted) would drift on the first rung either
//          side learned.

import type { CellUpdateInput, FormulaShiftInput } from "./tauri-api";
import type { CellData, CellValueType, MergedRegion } from "../types";
import type { Block } from "./merge/mergeGeometry";

interface Cell {
  row: number;
  col: number;
}

/** What keeps a cell of the selection out of the fill. */
export interface CtrlEnterSkips {
  /** Merged areas touching the selection: only each one's top-left cell is written. */
  merges: readonly MergedRegion[];
  /** Rows / columns left out (the sheet's hidden lines, in filter mode); null: none. */
  hiddenRows: ReadonlySet<number> | null;
  hiddenCols: ReadonlySet<number> | null;
}

/**
 * The cells Ctrl+Enter writes: every cell of `blocks`, each once, in block
 * order (overlapping blocks are written once), less the non-top-left cells of
 * a merged area and the skipped rows and columns.
 */
export function ctrlEnterCells(blocks: readonly Block[], skips: CtrlEnterSkips): Cell[] {
  const slave = (row: number, col: number): boolean =>
    skips.merges.some(
      (m) =>
        row >= m.startRow && row <= m.endRow && col >= m.startCol && col <= m.endCol &&
        (row !== m.startRow || col !== m.startCol),
    );
  const cells: Cell[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    for (let row = b.startRow; row <= b.endRow; row++) {
      if (skips.hiddenRows?.has(row)) continue;
      for (let col = b.startCol; col <= b.endCol; col++) {
        if (skips.hiddenCols?.has(col)) continue;
        const key = `${row},${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (slave(row, col)) continue;
        cells.push({ row, col });
      }
    }
  }
  return cells;
}

/** The writes and reads the fill needs (the live ones are tauri-api's). */
export interface CtrlEnterDeps {
  /** updateCellsBatch: the cells written (and the dependents recalculated). */
  write(updates: CellUpdateInput[]): Promise<CellData[]>;
  /** shiftFormulasBatch: each formula moved by its delta. */
  shift(inputs: FormulaShiftInput[]): Promise<string[]>;
  /** The value type the ACTIVE cell holds now (get_range_cells_typed). */
  typeAt(row: number, col: number): Promise<CellValueType>;
}

/**
 * Write `value` -- the entry typed into `anchor`, the active cell -- into
 * `cells` the way Excel's Ctrl+Enter does (see the header): the active cell
 * first, through the backend's typed-entry ladder, then every other cell with
 * what the active cell became. Returns the cells the writes reported.
 *
 * The active cell is written even when the list leaves it out (it is the cell
 * being edited). Both writes belong in ONE undo step -- the caller holds it.
 */
export async function ctrlEnterFill(
  value: string,
  cells: readonly Cell[],
  anchor: Cell,
  deps: CtrlEnterDeps,
): Promise<CellData[]> {
  const first = await deps.write([{ row: anchor.row, col: anchor.col, value }]);
  const others = cells.filter((c) => c.row !== anchor.row || c.col !== anchor.col);
  if (others.length === 0) return first;

  const stored = first.find((c) => c.row === anchor.row && c.col === anchor.col && c.sheetIndex == null);
  let updates: CellUpdateInput[];
  if (stored?.formula) {
    // A FORMULA, in the spelling typed: `+B1` is the formula =+B1 (the backend
    // put the `=` in front of it), moved for each cell. `pasted`: the active
    // cell already decided the kind, so a Text-formatted cell takes the
    // formula too (Excel [LIVE]).
    const text = value.trim();
    const formula = text.startsWith("=") ? text : `=${text}`;
    const shifted = await deps.shift(
      others.map(({ row, col }) => ({
        formula,
        rowDelta: row - anchor.row,
        colDelta: col - anchor.col,
        sourceRow: anchor.row,
        sourceCol: anchor.col,
      })),
    );
    if (shifted.length !== others.length) {
      throw new Error("Ctrl+Enter: the formula could not be adjusted for every selected cell.");
    }
    updates = others.map(({ row, col }, i) => ({ row, col, value: shifted[i], pasted: true }));
  } else if ((await deps.typeAt(anchor.row, anchor.col)) === "text") {
    // TEXT in the active cell (a Text-formatted active cell, an apostrophe, or
    // plain words) is text in every cell: behind the apostrophe escape, which
    // stores the rest verbatim, so `007` or `=B1` stays the text the active
    // cell shows even in a General cell. An entry that already starts with the
    // escape is sent as typed (it means the same thing in every cell).
    const escaped = value.trimStart().startsWith("'") ? value : `'${value.trim()}`;
    updates = others.map(({ row, col }) => ({ row, col, value: escaped }));
  } else {
    // A number, a date, TRUE / FALSE, an error, or nothing: the same entry in
    // every cell, `pasted` so a Text-formatted cell takes the number too.
    updates = others.map(({ row, col }) => ({ row, col, value, pasted: true }));
  }
  const rest = await deps.write(updates);
  return [...first, ...rest];
}
