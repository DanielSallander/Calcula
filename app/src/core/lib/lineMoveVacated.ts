//! FILENAME: app/src/core/lib/lineMoveVacated.ts
// PURPOSE: A drag of whole rows or columns (moveRows / moveColumns) that lands
//          on PART OF ITSELF -- a block moved up or left by fewer lines than
//          it spans -- written as ONE batch, the way a cell drag is.
// CONTEXT: BUG-0756. The line moves cleared every TARGET line first and wrote
//          the moved cells after; when the target overlapped the source, that
//          clear met the block's own cells -- and over a live data table, part
//          of its body, which the backend refuses ("Can't change part of a
//          data table.") -- so the move failed. Excel [LIVE, Excel 16 over COM,
//          2026-11-06, dtable/probe1.ps1] moves the whole table: `Range("1:4")
//          .Cut Range("A2")` and `Range("K:L").Cut Range("L1")` each left
//          `=TABLE(..)` at the new place, live. Now only the target lines
//          OUTSIDE the source are cleared first; every moved cell carries its
//          MOVE claim (none was cleared from under it), and the cells the move
//          leaves behind inside the target -- or a data-table body cell left
//          anywhere in the source, which would otherwise stand beside the moved
//          body as one table -- are emptied in the SAME batch (as `moveCells`
//          empties its vacated body cells). The move goes either way: a block
//          moved DOWN or RIGHT by fewer lines than it spans is moved too
//          [LIVE: `Range("1:4").Cut Range("A2")`], and every cell it lands on
//          takes its source's look (`overlapStyleResets`).

import { isDataTableFormula } from "./dataTableCopy";

/**
 * The line ranges of the target `[target, target + count)` that are NOT lines
 * of the source `[min, max]`: the ones a move may clear before it writes.
 */
export function targetLinesOutsideSource(min: number, max: number, target: number, count: number): Array<[number, number]> {
  const end = target + count - 1;
  const out: Array<[number, number]> = [];
  if (end < min || target > max) return [[target, end]];
  if (target < min) out.push([target, min - 1]);
  if (end > max) out.push([max + 1, end]);
  return out;
}

/**
 * The target cells of a line move onto PART OF ITSELF that keep a look the
 * move must take away: a cell of the source block that a moved cell lands on,
 * whose own format is not Normal while the moved cell's is. Excel's move gives
 * every cell it lands on its source's whole look [LIVE, Excel 16 over COM,
 * 2026-11-06, dtui/probe1.ps1: rows 1:3 with A2 bold, `Range("2:3").Cut
 * Range("A1")` -- A1 takes A2's bold, A2 takes plain A3's Normal look;
 * `Range("1:2").Cut Range("A2")` -- A3 takes A2's bold, A2 takes plain A1's
 * Normal]. The target lines outside the source were cleared, formats and all,
 * and a cell no write lands on is emptied and reset by `vacatedMoveCells`, so
 * only these overlap cells are left holding their old look.
 * `targetOf` maps a source cell to the "row,col" key it moves to.
 */
export function overlapStyleResets<T extends { row: number; col: number; styleIndex: number }>(
  sourceCells: readonly T[],
  targetOf: (cell: T) => [number, number],
): Array<[number, number]> {
  const styleAt = new Map<string, number>();
  for (const cell of sourceCells) styleAt.set(`${cell.row},${cell.col}`, cell.styleIndex);
  const out: Array<[number, number]> = [];
  for (const cell of sourceCells) {
    if (cell.styleIndex > 0) continue;
    const [row, col] = targetOf(cell);
    if ((styleAt.get(`${row},${col}`) ?? 0) > 0) out.push([row, col]);
  }
  return out;
}

/**
 * The source cells a line move must EMPTY in its batch: those no write lands
 * on that either sit in the target lines (`inTarget`) or are a data-table body
 * cell. `written` holds `"row,col"` of every write the batch makes.
 */
export function vacatedMoveCells<T extends { row: number; col: number; formula?: string | null }>(
  sourceCells: readonly T[],
  written: ReadonlySet<string>,
  inTarget: (row: number, col: number) => boolean,
): T[] {
  return sourceCells.filter(
    (cell) => !written.has(`${cell.row},${cell.col}`) && (inTarget(cell.row, cell.col) || isDataTableFormula(cell.formula)),
  );
}

/** The size and visibility writes a whole-line move owes ({@link movedLineSizes}). */
export interface MovedLineSizes {
  /** Size -> the lines that take it, ascending. */
  sizes: Map<number, number[]>;
  /** Lines to hide AFTER the size writes: their source line was hidden. */
  hide: number[];
  /** Whether a size write lands on a hidden line (the write shows it). */
  showsHidden: boolean;
  /**
   * The lines of `sizes` that are hidden now, ascending: the writes that SHOW
   * them. Written apart from the visible lines, because a batch resize under
   * an AutoFilter's filter mode gives its size to the visible rows only when
   * its runs hold one, and shows hidden rows only when every row of the runs
   * is hidden (Excel's Row Height rule, `set_line_sizes_core`).
   */
  shows: number[];
}

/**
 * The line sizes a move of whole rows (or columns) `[min, max]` to `target`
 * carries. Excel's move takes each line's height (width) and its hidden state
 * with it, and the lines it leaves behind go back to the standard size, shown
 * [LIVE, Excel 16 over COM, 2026-11-06, dtcf4/probe1.ps1: row 2 at 30 pt,
 * `Range("2:2").Cut Range("A5")` -- row 5 is 30 (it was 40), row 2 standard;
 * rows 2:3 at 30 / 20, `.Cut Range("A3")` -- rows 3 / 4 are 30 / 20, row 2
 * standard; rows 2:4 with row 3 hidden, `.Cut Range("A10")` -- row 11 hidden,
 * row 3 shown; a hidden target row 12 under `Range("2:2").Cut` is shown at row
 * 2's 30; columns the same: `Range("B:B").Cut Range("D1")` gives D column B's
 * width and B the standard; a cell block `Range("A2:B2").Cut` moves no size].
 * `sizes` holds the lines' own sizes (a line absent from it has `standard`),
 * `hidden` the lines HIDDEN, whatever hid them: Excel keeps one hidden flag per
 * line, and its move treats a line a filter or a collapsed outline group hides
 * exactly as one hidden by hand [LIVE, Excel 16 over COM, 2026-11-06,
 * misc5/probe1.ps1: an AutoFilter hiding row 4, `Range("3:5").Cut
 * Range("A20")` -- row 21 hidden, row 4 shown; rows 3:5 grouped and
 * collapsed, `Range("2:6").Cut Range("A20")` -- rows 21:23 hidden, 3:5 shown;
 * a filter-hidden target row 4 under `Range("9:9").Cut Range("A4")` and an
 * outline-hidden target row 11 under `Range("2:2").Cut Range("A11")` are
 * shown, at the source's size or the standard one]. Only lines whose size or
 * visibility changes are written. (The moved outline LEVEL is not carried:
 * the moved line is hidden by hand at its new place.)
 */
export function movedLineSizes(
  min: number,
  max: number,
  target: number,
  sizes: ReadonlyMap<number, number>,
  standard: number,
  hidden: ReadonlySet<number>,
): MovedLineSizes {
  const count = max - min + 1;
  const end = target + count - 1;
  // A size of 0 or less is a hidden line's, never one to carry.
  const sizeOf = (line: number): number => {
    const size = sizes.get(line);
    return size !== undefined && size > 0 ? size : standard;
  };
  const inSource = (line: number): boolean => line >= min && line <= max;
  const inTarget = (line: number): boolean => line >= target && line <= end;
  // Only a line with its own size or hidden, in the source or the target, can
  // change: every other target line takes a standard line onto a standard one.
  const marked = new Set<number>([...sizes.keys(), ...hidden]);
  const plan = new Map<number, { size: number; hidden: boolean }>();
  for (const line of marked) {
    if (inSource(line)) plan.set(target + (line - min), { size: sizeOf(line), hidden: hidden.has(line) });
  }
  for (const line of marked) {
    if (inTarget(line) && !plan.has(line)) {
      const source = min + (line - target);
      plan.set(line, { size: sizeOf(source), hidden: hidden.has(source) });
    }
  }
  for (const line of marked) {
    if (inSource(line) && !inTarget(line)) plan.set(line, { size: standard, hidden: false });
  }
  const out: MovedLineSizes = { sizes: new Map(), hide: [], showsHidden: false, shows: [] };
  for (const line of [...plan.keys()].sort((a, b) => a - b)) {
    const want = plan.get(line)!;
    const isHidden = hidden.has(line);
    if (want.hidden && isHidden && want.size === sizeOf(line)) continue;
    if (want.size !== sizeOf(line) || isHidden) {
      const lines = out.sizes.get(want.size) ?? [];
      lines.push(line);
      out.sizes.set(want.size, lines);
      if (isHidden) {
        out.showsHidden = true;
        out.shows.push(line);
      }
    }
    if (want.hidden) out.hide.push(line);
  }
  return out;
}

/**
 * The batch resizes a {@link MovedLineSizes} plan is written with: per size,
 * the lines visible now in one write and the lines it SHOWS (`shows`) in
 * another. One write mixing them would, under filter mode (an AutoFilter with
 * criteria or an advanced filter in place), give the size to the visible rows
 * only and leave the hidden ones hidden (Excel's Row Height rule), where
 * Excel's move shows them. The hidden-only write shows them out of either
 * filter's hidden set, in the move's undo step [LIVE, Excel 16 over COM,
 * 2026-11-06, misc6/probe.ps1: an advanced filter hiding row 4,
 * `Range("3:5").Cut Range("A20")` -- row 4 shown, row 21 hidden;
 * `Rows(4:4).RowHeight = 30` alone shows it too].
 */
export function lineSizeWrites(plan: MovedLineSizes): Array<[number, Array<[number, number]>]> {
  const shows = new Set(plan.shows);
  const out: Array<[number, Array<[number, number]>]> = [];
  for (const [size, lines] of plan.sizes) {
    const visible = lines.filter((line) => !shows.has(line));
    const hidden = lines.filter((line) => shows.has(line));
    if (visible.length > 0) out.push([size, lineRuns(visible)]);
    if (hidden.length > 0) out.push([size, lineRuns(hidden)]);
  }
  return out;
}

/** Ascending lines as inclusive `[first, last]` runs. */
export function lineRuns(lines: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}
