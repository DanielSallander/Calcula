//! FILENAME: app/extensions/AutoSum/lib/autoSumPlan.ts
// PURPOSE: Decide what AutoSum does -- open an edit holding a guessed formula,
//          or write totals -- the way Excel decides it. Pure over a cell
//          reader, so every rule is a test (__tests__/autoSumPlan.test.ts).
// CONTEXT: Home tab 2026-10-04 (autosum.insert). Excel's rules here were
//          MEASURED, not recalled: live Excel 16 (build 20430), 2026-10-04,
//          the ribbon's AutoSum driven over fresh workbooks (the probe case
//          names B1..B22 / A1..A23 / M1..M22 are in the test file).
//
//          ONE CELL selected -- Excel opens an EDIT of the active cell holding
//          =FN(guess), so Enter confirms it:
//            - look UP first: skip the blank cells directly above, then take
//              the run of numbers that follows; the range runs from the top of
//              that run down to the cell above the active one, so the blanks in
//              between are inside it (=SUM(A1:A9) from A10 over A1:A2). Text
//              stops the run (a header is left out); a blank INSIDE the
//              numbers stops it too;
//            - when there is nothing numeric above (only blanks to the top, or
//              text first), look LEFT by the same rule;
//            - when the numbers above include SUBTOTALS (=SUM(...) cells), the
//              guess is those subtotals, nearest first: =SUM(A6,A3);
//            - nothing either way: =SUM() with the caret between the brackets.
//          A RANGE selected -- Excel writes the totals at once:
//            - leading rows with no number in them (a header row) and leading
//              columns with no number (a label column) are left out of the
//              ranges, and the selection moves past them;
//            - an EMPTY last row in the selection takes the column totals, an
//              empty last column the row totals; both empty: both, plus a
//              grand total of the column totals in the corner;
//            - otherwise a single row is totalled to its RIGHT, anything taller
//              BELOW each column -- in the first row (or column) beyond the
//              selection that is entirely empty, so one occupied cell moves the
//              whole row of totals;
//            - a selection of EMPTY cells next to numbers gives each cell its
//              own one-cell guess, written directly; a selection with no
//              numbers to total at all opens the one-cell edit instead.
//          SEVERAL areas (Ctrl+click; Go To Special > Blanks then Alt+=): each
//            area by the rules above, in selection order, all in one undo
//            step -- planAutoSumAreas, at the end of this file.
//          Deliberate differences: the edit opens on Core's ACTIVE cell even
//          where Excel moves it (a selection whose numbers are only in its last
//          cell); the guessed range is not in Excel's "point mode" (dragging
//          does not REPLACE it -- edit it, or press Enter to accept it).

import type { TypedCellData } from "@api/lib";

/** The functions AutoSum's menu offers (Sum, Average, Count Numbers, Max, Min). */
export type AutoSumFn = "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN";

export const AUTOSUM_FUNCTIONS: readonly AutoSumFn[] = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"];

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Where the planner reads the sheet (the live reader is lib/liveReader.ts). */
export interface AutoSumCellReader {
  /** The non-empty cells of a rectangle, typed (sparse). */
  read(range: CellRange): Promise<TypedCellData[]>;
  /** The used extent of the sheet (rows/columns beyond it are empty). */
  usedRange(): Promise<{ endRow: number; endCol: number; empty: boolean }>;
}

export type AutoSumPlan =
  /** Open an edit of (row, col) holding `formula`, caret at `caret`. */
  | { kind: "edit"; row: number; col: number; formula: string; caret: number }
  /** Write these formulas (canonical: "," separators) in one undo step, then
   *  select `selection` (normalised). */
  | { kind: "write"; writes: Array<{ row: number; col: number; formula: string }>; selection: CellRange }
  /** Nothing can be done; say why. */
  | { kind: "nothing"; message: string };

/** Excel's last row and column (0-based). */
const MAX_ROW = 1_048_575;
const MAX_COL = 16_383;
/** Rows (or columns) read per call while scanning for a guess or a free row. */
const SCAN_CHUNK = 512;
/** A selection bigger than this is clipped to the used extent first. */
const CLIP_CELLS = 200_000;

// ============================================================================
// References
// ============================================================================

function colLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellRef(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** "A1:A3", or "A3" for a single cell (Excel writes =SUM(A3), not =SUM(A3:A3)). */
export function rangeRef(r: CellRange): string {
  const a = cellRef(r.startRow, r.startCol);
  return r.startRow === r.endRow && r.startCol === r.endCol ? a : `${a}:${cellRef(r.endRow, r.endCol)}`;
}

function formulaOf(fn: AutoSumFn, refs: readonly string[], separator: string): string {
  return `=${fn}(${refs.join(separator)})`;
}

// ============================================================================
// Cell kinds
// ============================================================================

type Kind = "empty" | "number" | "text";

function kindOf(cell: TypedCellData | undefined): Kind {
  if (!cell || cell.type === "empty") return "empty";
  if (cell.type === "text" && (cell.value === "" || cell.value === null)) return "empty";
  // A computed error sits in a column of computed numbers: it does not end
  // the run the way a label does.
  if (cell.type === "number" || cell.type === "error") return "number";
  return "text";
}

const SUBTOTAL = /^=\s*SUM\s*\(/i;

class CellMap {
  private readonly cells = new Map<string, TypedCellData>();
  constructor(list: readonly TypedCellData[]) {
    for (const c of list) this.cells.set(`${c.row},${c.col}`, c);
  }
  get(row: number, col: number): TypedCellData | undefined {
    return this.cells.get(`${row},${col}`);
  }
  kind(row: number, col: number): Kind {
    return kindOf(this.get(row, col));
  }
}

// ============================================================================
// The one-cell guess
// ============================================================================

/**
 * Walk one line of cells toward the sheet's edge (`at(i)` for i = 0, 1, ...;
 * i = 0 is the cell next to the target) and answer the run Excel totals: the
 * index range [near, far] of the cells to total (near = 0, so the skipped
 * blanks are inside it) plus the subtotal cells in it, or null.
 *
 * The FIRST number met decides what the run is. A subtotal: the guess is the
 * subtotals (B10), walking on through the plain numbers between them. A plain
 * number: the run of numbers, which a subtotal ENDS -- A1:A3, A4 =SUM(A1:A3),
 * A5:A7 gives =SUM(A5:A7) in A8 (measured live, R1), never =SUM(A4). Several
 * areas are planned against the totals the earlier areas wrote, so Go To
 * Special > Blanks then AutoSum depends on this stop.
 */
async function walkLine(
  length: number,
  readChunk: (from: number, to: number) => Promise<CellMap>,
  coordOf: (i: number) => { row: number; col: number },
): Promise<{ far: number; subtotals: number[] } | null> {
  let i = 0;
  let phase: "blanks" | "numbers" = "blanks";
  let collecting = false;
  let far = -1;
  const subtotals: number[] = [];
  while (i < length) {
    const to = Math.min(length - 1, i + SCAN_CHUNK - 1);
    const chunk = await readChunk(i, to);
    for (; i <= to; i++) {
      const { row, col } = coordOf(i);
      const kind = chunk.kind(row, col);
      const formula = chunk.get(row, col)?.formula ?? null;
      const subtotal = kind === "number" && formula !== null && SUBTOTAL.test(formula);
      if (phase === "blanks") {
        if (kind === "empty") continue;
        if (kind === "text") return null;
        phase = "numbers";
        collecting = subtotal;
      }
      if (kind !== "number") return { far, subtotals };
      // A plain run stops at the subtotal above it (R1).
      if (subtotal && !collecting) return { far, subtotals };
      far = i;
      if (subtotal) subtotals.push(i);
    }
  }
  return phase === "numbers" ? { far, subtotals } : null;
}

/**
 * Excel's one-cell guess for (row, col): the references to total, or null when
 * there is nothing to guess. Above first, then left (see the header).
 */
export async function guessSingleCell(
  row: number,
  col: number,
  reader: AutoSumCellReader,
): Promise<string[] | null> {
  const used = await reader.usedRange();
  if (used.empty) return null;

  // ABOVE: rows row-1, row-2, ... 0. Rows past the used extent are blank, so
  // the walk starts at the extent's last row; the blank rows it did not read
  // are still inside the range (it always ends at the row above the target).
  if (row > 0 && col <= used.endCol) {
    const start = Math.min(row - 1, used.endRow);
    const length = start + 1;
    const found = await walkLine(
      length,
      async (from, to) =>
        new CellMap(await reader.read({ startRow: start - to, startCol: col, endRow: start - from, endCol: col })),
      (i) => ({ row: start - i, col }),
    );
    if (found) {
      if (found.subtotals.length > 0) {
        return found.subtotals.map((i) => cellRef(start - i, col));
      }
      return [rangeRef({ startRow: start - found.far, startCol: col, endRow: row - 1, endCol: col })];
    }
  }

  // LEFT: cols col-1, ... 0, by the same rule.
  if (col > 0 && row <= used.endRow) {
    const start = Math.min(col - 1, used.endCol);
    const length = start + 1;
    const found = await walkLine(
      length,
      async (from, to) =>
        new CellMap(await reader.read({ startRow: row, startCol: start - to, endRow: row, endCol: start - from })),
      (i) => ({ row, col: start - i }),
    );
    if (found) {
      if (found.subtotals.length > 0) {
        return found.subtotals.map((i) => cellRef(row, start - i));
      }
      return [rangeRef({ startRow: row, startCol: start - found.far, endRow: row, endCol: col - 1 })];
    }
  }
  return null;
}

async function editPlan(
  fn: AutoSumFn,
  row: number,
  col: number,
  reader: AutoSumCellReader,
  listSeparator: string,
): Promise<Extract<AutoSumPlan, { kind: "edit" }>> {
  const refs = (await guessSingleCell(row, col, reader)) ?? [];
  const formula = formulaOf(fn, refs, listSeparator);
  return { kind: "edit", row, col, formula, caret: formula.length - 1 };
}

// ============================================================================
// A range
// ============================================================================

function normalise(sel: CellRange): CellRange {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

function hasNumberIn(map: CellMap, r: CellRange): boolean {
  for (let row = r.startRow; row <= r.endRow; row++) {
    for (let col = r.startCol; col <= r.endCol; col++) {
      if (map.kind(row, col) === "number") return true;
    }
  }
  return false;
}

function isEmptyIn(map: CellMap, r: CellRange): boolean {
  for (let row = r.startRow; row <= r.endRow; row++) {
    for (let col = r.startCol; col <= r.endCol; col++) {
      if (map.kind(row, col) !== "empty") return false;
    }
  }
  return true;
}

/** The first row below `block` whose cells in the block's columns are all empty. */
async function firstEmptyRowBelow(block: CellRange, reader: AutoSumCellReader): Promise<number | null> {
  const used = await reader.usedRange();
  let row = block.endRow + 1;
  while (row <= MAX_ROW) {
    if (row > used.endRow) return row;
    const to = Math.min(MAX_ROW, row + SCAN_CHUNK - 1);
    const map = new CellMap(await reader.read({ startRow: row, startCol: block.startCol, endRow: to, endCol: block.endCol }));
    for (; row <= to; row++) {
      if (isEmptyIn(map, { startRow: row, startCol: block.startCol, endRow: row, endCol: block.endCol })) return row;
    }
  }
  return null;
}

/** The first column right of `block` whose cells in the block's rows are all empty. */
async function firstEmptyColRight(block: CellRange, reader: AutoSumCellReader): Promise<number | null> {
  const used = await reader.usedRange();
  let col = block.endCol + 1;
  while (col <= MAX_COL) {
    if (col > used.endCol) return col;
    const to = Math.min(MAX_COL, col + SCAN_CHUNK - 1);
    const map = new CellMap(await reader.read({ startRow: block.startRow, startCol: col, endRow: block.endRow, endCol: to }));
    for (; col <= to; col++) {
      if (isEmptyIn(map, { startRow: block.startRow, startCol: col, endRow: block.endRow, endCol: col })) return col;
    }
  }
  return null;
}

function bounding(a: CellRange, cells: ReadonlyArray<{ row: number; col: number }>): CellRange {
  const out = { ...a };
  for (const c of cells) {
    out.startRow = Math.min(out.startRow, c.row);
    out.startCol = Math.min(out.startCol, c.col);
    out.endRow = Math.max(out.endRow, c.row);
    out.endCol = Math.max(out.endCol, c.col);
  }
  return out;
}

/**
 * The plan for AutoSum over Core's selection. `selection` is Core's: the
 * anchor at (startRow, startCol), the ACTIVE cell at (endRow, endCol).
 * `listSeparator` spells an edit's arguments in the user's locale (an edit is
 * text the user reads and confirms); written formulas are canonical.
 */
export async function planAutoSum(
  fn: AutoSumFn,
  selection: CellRange,
  reader: AutoSumCellReader,
  listSeparator: string,
): Promise<AutoSumPlan> {
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  let rng = normalise(selection);

  if (rng.startRow === rng.endRow && rng.startCol === rng.endCol) {
    return editPlan(fn, activeRow, activeCol, reader, listSeparator);
  }

  // A whole column (or Select All) is a million rows; the data stops at the
  // used extent, one row/column past which a total can still go.
  const cells = (rng.endRow - rng.startRow + 1) * (rng.endCol - rng.startCol + 1);
  if (cells > CLIP_CELLS) {
    const used = await reader.usedRange();
    if (used.empty) return editPlan(fn, activeRow, activeCol, reader, listSeparator);
    rng = {
      startRow: rng.startRow,
      startCol: rng.startCol,
      endRow: Math.min(rng.endRow, used.endRow + 1),
      endCol: Math.min(rng.endCol, used.endCol + 1),
    };
  }

  const map = new CellMap(await reader.read(rng));

  // No number anywhere in the selection.
  if (!hasNumberIn(map, rng)) {
    if (isEmptyIn(map, rng)) {
      // Empty cells beside numbers: each gets its own one-cell guess (M16, M17).
      const writes: Array<{ row: number; col: number; formula: string }> = [];
      if ((rng.endRow - rng.startRow + 1) * (rng.endCol - rng.startCol + 1) <= 1000) {
        for (let row = rng.startRow; row <= rng.endRow; row++) {
          for (let col = rng.startCol; col <= rng.endCol; col++) {
            const refs = await guessSingleCell(row, col, reader);
            if (refs) writes.push({ row, col, formula: formulaOf(fn, refs, ",") });
          }
        }
      }
      if (writes.length > 0) return { kind: "write", writes, selection: rng };
    }
    return editPlan(fn, activeRow, activeCol, reader, listSeparator);
  }

  // Leave out leading rows, then leading columns, that hold no number (a
  // header row, a label column).
  let startRow = rng.startRow;
  while (!hasNumberIn(map, { startRow, startCol: rng.startCol, endRow: startRow, endCol: rng.endCol })) startRow++;
  let startCol = rng.startCol;
  while (!hasNumberIn(map, { startRow, startCol, endRow: rng.endRow, endCol: startCol })) startCol++;
  const block: CellRange = { startRow, startCol, endRow: rng.endRow, endCol: rng.endCol };

  // What is left is one cell: the one-cell edit (M13).
  if (block.startRow === block.endRow && block.startCol === block.endCol) {
    return editPlan(fn, activeRow, activeCol, reader, listSeparator);
  }

  const writes: Array<{ row: number; col: number; formula: string }> = [];
  const total = (row: number, col: number, over: CellRange): void => {
    writes.push({ row, col, formula: formulaOf(fn, [rangeRef(over)], ",") });
  };

  const lastRowEmpty =
    block.endRow > block.startRow &&
    isEmptyIn(map, { startRow: block.endRow, startCol: block.startCol, endRow: block.endRow, endCol: block.endCol });
  const lastColEmpty =
    block.endCol > block.startCol &&
    isEmptyIn(map, { startRow: block.startRow, startCol: block.endCol, endRow: block.endRow, endCol: block.endCol });

  if (lastRowEmpty || lastColEmpty) {
    const inner: CellRange = {
      startRow: block.startRow,
      startCol: block.startCol,
      endRow: lastRowEmpty ? block.endRow - 1 : block.endRow,
      endCol: lastColEmpty ? block.endCol - 1 : block.endCol,
    };
    // Row totals in the empty last column.
    if (lastColEmpty) {
      for (let row = inner.startRow; row <= inner.endRow; row++) {
        const over = { startRow: row, startCol: inner.startCol, endRow: row, endCol: inner.endCol };
        if (hasNumberIn(map, over)) total(row, block.endCol, over);
      }
    }
    // Column totals in the empty last row.
    if (lastRowEmpty) {
      for (let col = inner.startCol; col <= inner.endCol; col++) {
        const over = { startRow: inner.startRow, startCol: col, endRow: inner.endRow, endCol: col };
        if (hasNumberIn(map, over)) total(block.endRow, col, over);
      }
    }
    // Both: the corner totals the column totals (Excel's D4 =SUM(A4:C4)).
    if (lastRowEmpty && lastColEmpty) {
      total(block.endRow, block.endCol, {
        startRow: block.endRow,
        startCol: inner.startCol,
        endRow: block.endRow,
        endCol: inner.endCol,
      });
    }
  } else if (block.startRow === block.endRow) {
    // One row: its total to the right, in the first empty cell.
    const col = await firstEmptyColRight(block, reader);
    if (col === null) return { kind: "nothing", message: "There is no room to the right of the selection for a total." };
    total(block.startRow, col, block);
  } else {
    // A column or a block: a total under every column with numbers, in the
    // first row below that is empty across the block.
    const row = await firstEmptyRowBelow(block, reader);
    if (row === null) return { kind: "nothing", message: "There is no room below the selection for the totals." };
    for (let col = block.startCol; col <= block.endCol; col++) {
      const over = { startRow: block.startRow, startCol: col, endRow: block.endRow, endCol: col };
      if (hasNumberIn(map, over)) total(row, col, over);
    }
  }

  if (writes.length === 0) {
    return { kind: "nothing", message: "There are no numbers in the selection to total." };
  }
  return { kind: "write", writes, selection: bounding(block, writes) };
}

// ============================================================================
// Several areas (Ctrl+click, Go To Special > Blanks)
// ============================================================================

/** AutoSum over a selection of one or more areas. */
export type AutoSumAreasPlan =
  /** Open an edit of (row, col) holding `formula` -- nothing is written. */
  | { kind: "edit"; row: number; col: number; formula: string; caret: number }
  /** Write these formulas in ONE undo step, then select `selections` (one per
   *  area, in the selection's order, normalised). */
  | { kind: "write"; writes: Array<{ row: number; col: number; formula: string }>; selections: CellRange[] }
  /** Nothing can be done; say why. */
  | { kind: "nothing"; message: string };

/**
 * `reader` with `writes` already on the sheet: what a later area sees of the
 * totals the earlier ones wrote (each written cell is a number whose formula
 * is the total, so a later guess can take it as a subtotal).
 */
function withWrites(
  reader: AutoSumCellReader,
  writes: ReadonlyArray<{ row: number; col: number; formula: string }>,
): AutoSumCellReader {
  if (writes.length === 0) return reader;
  const inside = (w: { row: number; col: number }, r: CellRange) =>
    w.row >= r.startRow && w.row <= r.endRow && w.col >= r.startCol && w.col <= r.endCol;
  return {
    async read(range) {
      const written = writes.filter((w) => inside(w, range));
      const taken = new Set(written.map((w) => `${w.row},${w.col}`));
      const base = (await reader.read(range)).filter((c) => !taken.has(`${c.row},${c.col}`));
      return [
        ...base,
        ...written.map((w): TypedCellData => ({
          row: w.row,
          col: w.col,
          value: 0,
          display: "0",
          formula: w.formula,
          type: "number",
        })),
      ];
    },
    async usedRange() {
      const used = await reader.usedRange();
      let endRow = used.empty ? 0 : used.endRow;
      let endCol = used.empty ? 0 : used.endCol;
      for (const w of writes) {
        endRow = Math.max(endRow, w.row);
        endCol = Math.max(endCol, w.col);
      }
      return { endRow, endCol, empty: false };
    },
  };
}

/**
 * The plan for AutoSum over every area of Core's selection, `areas[0]` being
 * the main one (its END is the active cell). Measured live in Excel 16 (build
 * 20430, 2026-10-04; cases P1..P11, Q1..Q7, R1..R3 in the test file):
 *   - one area is exactly planAutoSum;
 *   - several: each area by the one-area rules, IN SELECTION ORDER, each
 *     against the sheet as the earlier areas left it (Q2: areas A4 then A6
 *     over A1:A3 write A4 =SUM(A1:A3) and A6 =SUM(A4); A6 then A4 write A6
 *     =SUM(A1:A5)). A one-cell area with a guess is WRITTEN (P4), where one
 *     selected cell alone opens an edit;
 *   - one area with nothing to total sends the whole gesture to an edit and
 *     nothing is written (P5, P10, Q3) -- Excel's edit target was not readable
 *     over COM; Calcula edits the active cell with its own guess, as for one
 *     cell;
 *   - every total is one undo step, and each area stays selected, grown over
 *     its totals (P3, Q6).
 * A later area that totals into a cell an earlier one wrote replaces it.
 * Known difference (unmeasured beyond Q4): Excel placed an OVERLAPPING later
 * area's total in the cell the earlier area had just filled; here the later
 * area sees that cell occupied and moves one row on.
 */
export async function planAutoSumAreas(
  fn: AutoSumFn,
  areas: readonly CellRange[],
  reader: AutoSumCellReader,
  listSeparator: string,
): Promise<AutoSumAreasPlan> {
  if (areas.length === 0) return { kind: "nothing", message: "There is no selection to total." };
  const main = areas[0];
  if (areas.length === 1) {
    const plan = await planAutoSum(fn, main, reader, listSeparator);
    return plan.kind === "write" ? { kind: "write", writes: plan.writes, selections: [plan.selection] } : plan;
  }

  // Nothing written yet, so the active cell's own guess, against the sheet.
  const activeEdit = () => editPlan(fn, main.endRow, main.endCol, reader, listSeparator);
  const written = new Map<string, { row: number; col: number; formula: string }>();
  const selections: CellRange[] = [];
  for (const area of areas) {
    const sheet = withWrites(reader, [...written.values()]);
    const rng = normalise(area);
    if (rng.startRow === rng.endRow && rng.startCol === rng.endCol) {
      const refs = await guessSingleCell(rng.startRow, rng.startCol, sheet);
      if (!refs) return activeEdit();
      written.set(`${rng.startRow},${rng.startCol}`, {
        row: rng.startRow,
        col: rng.startCol,
        formula: formulaOf(fn, refs, ","),
      });
      selections.push(rng);
      continue;
    }
    const plan = await planAutoSum(fn, area, sheet, ",");
    if (plan.kind === "edit") return activeEdit();
    if (plan.kind === "nothing") return plan;
    for (const w of plan.writes) written.set(`${w.row},${w.col}`, w);
    selections.push(plan.selection);
  }
  return { kind: "write", writes: [...written.values()], selections };
}
