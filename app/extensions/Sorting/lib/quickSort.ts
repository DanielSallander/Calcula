//! FILENAME: app/extensions/Sorting/lib/quickSort.ts
// PURPOSE: What Sort A to Z / Sort Z to A / Custom Sort... act on, decided the
//          way Excel decides it, and the quick sort itself.
// CONTEXT: Home tab 2026-10-04 (the sort.ascending / sort.descending /
//          sort.customDialog commands). The Data menu's quick sort ignored the
//          selection -- it always sorted the region around the active cell --
//          and always treated the first row as a header, so an all-text list
//          could never sort its first item. Every rule below was measured in
//          live Excel 16 (build 20430) on 2026-10-04; the cases are named after
//          the probe (C1..C14) and pinned in __tests__/sortCommands.test.ts:
//
//          - ONE cell selected: the block of data around it (the current
//            region), by the active cell's column, with Excel's header guess
//            (C1-C7, C13). Inside a TABLE the table body is sorted with its
//            own header (and never its totals row); inside an AUTOFILTER range,
//            that range with its header row, and the filter is reapplied after
//            -- in both the header is a FACT, where the guess would call a
//            text-over-text header data.
//          - SEVERAL cells: exactly the selection, by the active cell's column;
//            rows outside it and columns beside it stay where they are (C8,
//            C9), with the same header guess on the selection (C11).
//          - ONE COLUMN inside wider data: Excel's Sort Warning -- expand to
//            the block (the default) or continue with the column (C10).
//          - Several separate areas: refused ("This command cannot be used on
//            multiple selections.").
//          - A FLOATING GRID's cells (P3, owner finding G3): the same rules
//            over the object's own cells -- read through @api/cellTarget,
//            sorted with the target. An object holds no table and no
//            AutoFilter, so only the current region and the guess apply.

import {
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  detectDataRegion,
  getRangeCellsTyped,
  getUsedRange,
  sortRange,
  sortRangeByColumn,
  type TypedCellData,
} from "@api/lib";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import type { SortRangeResult } from "@api";
import { getGridStateSnapshot, refreshGridData } from "@api/grid";
import { getTableAtCell } from "@api/backend";
import {
  getAutoFilterStatus,
  hasAutoFilterController,
  requireAutoFilterController,
} from "@api/autoFilterService";
import { showToast } from "@api/notifications";
import {
  resolveCellTarget,
  getCellTargetCellsTyped,
  type CellTarget,
  type CellTargetRef,
} from "@api/cellTarget";
import { askSortWarning } from "./sortWarning";

/** A rectangle, inclusive, normalised (start <= end). */
export interface SortRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** What a sort will act on. */
export interface SortTarget {
  range: SortRange;
  /** Absolute column the quick sort keys on (the active cell's). */
  sortCol: number;
  hasHeaders: boolean;
  /** The range is an AutoFilter's: re-run its criteria after the rows move. */
  reapplyFilter: boolean;
  /**
   * The OBJECT whose cells are sorted (a floating grid's, P3); absent for the
   * active sheet. Every read and the sort itself go through it.
   */
  objectTarget?: CellTargetRef;
}

// ============================================================================
// Excel's header guess
// ============================================================================

/** How many data rows below the first the guess reads (a sample is enough:
 *  the question is whether the first row's TYPES differ from the data's). */
const HEADER_SAMPLE_ROWS = 50;
/** get_range_cells_typed refuses more than this many cells per call. */
const TYPED_READ_CAP = 100_000;

type Kind = "empty" | "text" | "value";

function kindOf(cell: TypedCellData | undefined): Kind {
  if (!cell || cell.type === "empty") return "empty";
  if (cell.type === "text") return cell.value === "" || cell.value === null ? "empty" : "text";
  return "value";
}

/**
 * Excel's guess at "My data has headers", from the cells' TYPES only:
 * the first row is a header when every non-empty cell in it is text AND some
 * column has text on top and a number (or date, logical, error) below. So
 * text over numbers is a header (C1, C5); text over text is not (C2, C7) -- not
 * even with a bold first row (C3: formatting does not decide it); a number in
 * the first row makes it data (C4, C6 -- a row of years over numbers is
 * sorted with the rest, C14). One row has no header.
 */
export function guessHasHeaders(cells: readonly TypedCellData[], range: SortRange): boolean {
  if (range.endRow <= range.startRow) return false;
  const at = new Map<string, TypedCellData>();
  for (const c of cells) at.set(`${c.row},${c.col}`, c);

  let topCells = 0;
  let textOverValue = false;
  const lastRow = Math.min(range.endRow, range.startRow + HEADER_SAMPLE_ROWS);
  for (let col = range.startCol; col <= range.endCol; col++) {
    const top = kindOf(at.get(`${range.startRow},${col}`));
    if (top === "empty") continue;
    if (top !== "text") return false;
    topCells++;
    if (textOverValue) continue;
    for (let row = range.startRow + 1; row <= lastRow; row++) {
      if (kindOf(at.get(`${row},${col}`)) === "value") {
        textOverValue = true;
        break;
      }
    }
  }
  return topCells > 0 && textOverValue;
}

/**
 * Read the cells the guess needs (the first row plus a sample below it) and
 * guess. `objectTarget`: read the object's own cells, not the active sheet's.
 */
async function readAndGuessHeaders(range: SortRange, objectTarget?: CellTargetRef): Promise<boolean> {
  if (range.endRow <= range.startRow) return false;
  const cols = range.endCol - range.startCol + 1;
  const rowsWanted = Math.min(range.endRow - range.startRow + 1, HEADER_SAMPLE_ROWS + 1);
  const rows = Math.max(2, Math.min(rowsWanted, Math.floor(TYPED_READ_CAP / Math.max(1, cols))));
  const sample = {
    startRow: range.startRow,
    startCol: range.startCol,
    endRow: Math.min(range.endRow, range.startRow + rows - 1),
    endCol: range.endCol,
  };
  const cells = objectTarget
    ? await getCellTargetCellsTyped(objectTarget, sample)
    : await getRangeCellsTyped(sample.startRow, sample.startCol, sample.endRow, sample.endCol);
  return guessHasHeaders(cells, range);
}

// ============================================================================
// What to sort
// ============================================================================

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

const inside = (row: number, col: number, r: SortRange): boolean =>
  row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol;

/**
 * The block ONE cell sorts: its table's body, else its AutoFilter range, else
 * the current region (with the header guess). Null when the cell sits in no
 * data at all.
 */
async function blockAround(row: number, col: number): Promise<SortTarget | null> {
  let table: Awaited<ReturnType<typeof getTableAtCell>> = null;
  try {
    table = await getTableAtCell(row, col);
  } catch {
    table = null;
  }
  if (table) {
    const headerRow = table.styleOptions?.headerRow !== false;
    const totalRow = table.styleOptions?.totalRow === true;
    return {
      range: {
        startRow: table.startRow,
        startCol: table.startCol,
        endRow: table.endRow - (totalRow ? 1 : 0),
        endCol: table.endCol,
      },
      sortCol: col,
      hasHeaders: headerRow,
      reapplyFilter: getAutoFilterStatus().hasFilter,
    };
  }

  if (getAutoFilterStatus().hasFilter && hasAutoFilterController()) {
    try {
      const filter = await requireAutoFilterController().get();
      if (filter && inside(row, col, filter)) {
        return {
          range: { startRow: filter.startRow, startCol: filter.startCol, endRow: filter.endRow, endCol: filter.endCol },
          sortCol: col,
          hasHeaders: true,
          reapplyFilter: true,
        };
      }
    } catch {
      // No filter after all: fall through to the region.
    }
  }

  const region = await detectDataRegion(row, col);
  if (!region) return null;
  const range = { startRow: region[0], startCol: region[1], endRow: region[2], endCol: region[3] };
  return { range, sortCol: col, hasHeaders: await readAndGuessHeaders(range), reapplyFilter: false };
}

/**
 * Decide what the sort acts on, from Core's selection -- asking Excel's Sort
 * Warning when one column is selected inside wider data. Null when there is
 * nothing to sort or the user cancelled; refusals are announced here.
 *
 * `action` is the user-facing name of the door ("Sort A to Z", "Custom Sort").
 */
export async function decideSortTarget(action: string): Promise<SortTarget | null> {
  // It reads (and rewrites) the cells the door targets: Core's selection, or
  // a floating grid's own cells (P3). Any other owner of the selection -- a
  // selected object -- refuses, announced once (D4).
  const t = resolveCellTarget(action, "sort");
  if (t === null) return null;
  if (t.kind === "object") return decideObjectSortTarget(t);
  const snapshot = getGridStateSnapshot();
  if (snapshot?.surface === "canvas") {
    showToast(`${action} is not available on a canvas sheet: it holds objects, not cells.`, { variant: "info" });
    return null;
  }
  const sel = snapshot?.selection;
  if (!sel) return null;
  if ((sel.additionalRanges?.length ?? 0) > 0) {
    showToast("This command cannot be used on multiple selections.", { variant: "info" });
    return null;
  }

  // Core's ACTIVE cell is the selection's end corner.
  const activeRow = sel.endRow;
  const activeCol = sel.endCol;
  let range: SortRange = {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };

  // Whole columns / rows: the data stops at the used extent (Excel sorts a
  // selected column's data, not a million empty rows).
  if (sel.type === "columns" || sel.type === "rows" || range.endRow - range.startRow > 100_000) {
    const used = await getUsedRange();
    if (used.empty) return null;
    range = {
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: Math.min(range.endRow, used.endRow),
      endCol: Math.min(range.endCol, used.endCol),
    };
    if (range.endRow < range.startRow || range.endCol < range.startCol) return null;
  }

  const oneRow = range.startRow === range.endRow;
  const oneCol = range.startCol === range.endCol;

  // One cell -- and one row, which has nothing to reorder on its own -- sorts
  // the block around the active cell.
  if (oneRow) {
    const block = await blockAround(activeRow, activeCol);
    if (!block) showToast("There is no data here to sort.", { variant: "info" });
    return block;
  }

  // One column inside wider data: Excel's Sort Warning (C10).
  if (oneCol) {
    const region = await detectDataRegion(activeRow, activeCol);
    const wider = region !== null && (region[1] < range.startCol || region[3] > range.endCol);
    if (wider) {
      const choice = await askSortWarning();
      if (choice === "cancel") return null;
      if (choice === "expand") return blockAround(activeRow, activeCol);
    }
  }

  return {
    range,
    sortCol: Math.min(Math.max(activeCol, range.startCol), range.endCol),
    hasHeaders: await readAndGuessHeaders(range),
    reapplyFilter: false,
  };
}

// ============================================================================
// What to sort inside an object (a floating grid's cells, P3)
// ============================================================================

/** A sparse set of the object's non-empty cells, keyed "row,col". */
type FilledCells = Set<string>;

async function filledCellsOf(ref: CellTargetRef, bounds: { rows: number; cols: number }): Promise<FilledCells> {
  const filled: FilledCells = new Set();
  if (bounds.rows <= 0 || bounds.cols <= 0) return filled;
  const cells = await getCellTargetCellsTyped(ref, {
    startRow: 0,
    startCol: 0,
    endRow: bounds.rows - 1,
    endCol: bounds.cols - 1,
  });
  for (const c of cells) if (kindOf(c) !== "empty") filled.add(`${c.row},${c.col}`);
  return filled;
}

/**
 * Excel's CURRENT REGION around (row, col) over a sparse cell set: the
 * rectangle grown while any cell touching its edge (diagonals included) holds
 * something, never past `bounds`. Null when the cell and every neighbour are
 * empty (there is no data here).
 */
export function currentRegionIn(
  filled: ReadonlySet<string>,
  row: number,
  col: number,
  bounds: { rows: number; cols: number },
): SortRange | null {
  const has = (r: number, c: number) => r >= 0 && c >= 0 && r < bounds.rows && c < bounds.cols && filled.has(`${r},${c}`);
  let r0 = row;
  let r1 = row;
  let c0 = col;
  let c1 = col;
  let grew = true;
  while (grew) {
    grew = false;
    for (let c = c0 - 1; c <= c1 + 1; c++) {
      if (has(r0 - 1, c)) { r0--; grew = true; break; }
    }
    for (let c = c0 - 1; c <= c1 + 1; c++) {
      if (has(r1 + 1, c)) { r1++; grew = true; break; }
    }
    for (let r = r0 - 1; r <= r1 + 1; r++) {
      if (has(r, c0 - 1)) { c0--; grew = true; break; }
    }
    for (let r = r0 - 1; r <= r1 + 1; r++) {
      if (has(r, c1 + 1)) { c1++; grew = true; break; }
    }
  }
  if (r0 === r1 && c0 === c1 && !has(row, col)) return null;
  return { startRow: r0, startCol: c0, endRow: r1, endCol: c1 };
}

/** `decideSortTarget` over an OBJECT's cells: the same rules, the object's data. */
async function decideObjectSortTarget(t: Extract<CellTarget, { kind: "object" }>): Promise<SortTarget | null> {
  const sel = t.selection;
  if ((sel.additionalRanges?.length ?? 0) > 0) {
    showToast("This command cannot be used on multiple selections.", { variant: "info" });
    return null;
  }
  const ref = t.ref;
  const activeRow = sel.activeRow ?? sel.endRow;
  const activeCol = sel.activeCol ?? sel.endCol;
  const range: SortRange = {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.min(Math.max(sel.startRow, sel.endRow), t.bounds.rows - 1),
    endCol: Math.min(Math.max(sel.startCol, sel.endCol), t.bounds.cols - 1),
  };
  if (range.endRow < range.startRow || range.endCol < range.startCol) return null;

  let filled: FilledCells | null = null;
  const regionAround = async (): Promise<SortRange | null> => {
    filled ??= await filledCellsOf(ref, t.bounds);
    return currentRegionIn(filled, activeRow, activeCol, t.bounds);
  };
  const blockAt = async (): Promise<SortTarget | null> => {
    const region = await regionAround();
    if (!region) return null;
    return {
      range: region,
      sortCol: activeCol,
      hasHeaders: await readAndGuessHeaders(region, ref),
      reapplyFilter: false,
      objectTarget: ref,
    };
  };

  if (range.startRow === range.endRow) {
    const block = await blockAt();
    if (!block) showToast("There is no data here to sort.", { variant: "info" });
    return block;
  }

  if (range.startCol === range.endCol) {
    const region = await regionAround();
    const wider = region !== null && (region.startCol < range.startCol || region.endCol > range.endCol);
    if (wider) {
      const choice = await askSortWarning();
      if (choice === "cancel") return null;
      if (choice === "expand") return blockAt();
    }
  }

  return {
    range,
    sortCol: Math.min(Math.max(activeCol, range.startCol), range.endCol),
    hasHeaders: await readAndGuessHeaders(range, ref),
    reapplyFilter: false,
    objectTarget: ref,
  };
}

// ============================================================================
// The quick sort
// ============================================================================

/** The closes the sort's owned transaction makes (read when the close runs). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * Sort A to Z (ascending) or Z to A. The backend records the sort as ONE undo
 * step of its own; a refusal (a protected range, a merge that would split) is
 * shown, never logged and swallowed.
 *
 * Inside an AutoFilter range the sort and the filter's reapply are ONE undo
 * step: both record an entry, and as two steps the first Ctrl+Z put the old
 * hidden-row INDEX set back over the sorted rows, hiding the wrong records
 * until a second Ctrl+Z. The owned transaction closes only what its own begin
 * opened (inside a script's batch it joins, and the batch closes it); what
 * landed is committed, never cancelled -- a cancel drops the undo record and
 * keeps the sorted rows.
 */
export async function runQuickSort(ascending: boolean): Promise<void> {
  const action = ascending ? "Sort A to Z" : "Sort Z to A";
  let target: SortTarget | null;
  try {
    target = await decideSortTarget(action);
  } catch (err) {
    showToast(messageOf(err), { variant: "error" });
    return;
  }
  if (!target) return;

  const { range, sortCol, hasHeaders } = target;
  if (target.objectTarget) {
    // An object's cells: ONE backend sort (its own undo step); no filter.
    try {
      const result = await sortRange<SortRangeResult>(
        range.startRow,
        range.startCol,
        range.endRow,
        range.endCol,
        [{ key: sortCol - range.startCol, ascending }],
        { hasHeaders },
        { target: target.objectTarget },
      );
      if (result && result.success === false) {
        showToast(result.error || `${action} was refused.`, { variant: "error" });
        return;
      }
    } catch (err) {
      showToast(messageOf(err), { variant: "error" });
      return;
    }
    refreshGridData();
    return;
  }
  const reapply = target.reapplyFilter && hasAutoFilterController();
  let tx: OwnedUndoTransaction | null = null;
  try {
    if (reapply) tx = ownUndoTransaction(await beginUndoTransaction(action), UNDO_CLOSES);
    const result = await sortRangeByColumn<SortRangeResult>(
      range.startRow,
      range.startCol,
      range.endRow,
      range.endCol,
      sortCol,
      ascending,
      hasHeaders,
    );
    if (result && result.success === false) {
      await tx?.cancel().catch(() => {});
      showToast(result.error || `${action} was refused.`, { variant: "error" });
      return;
    }
  } catch (err) {
    await tx?.cancel().catch(() => {});
    showToast(messageOf(err), { variant: "error" });
    return;
  }
  refreshGridData();

  // Rows moved under the filter: re-run its criteria so the hidden set follows
  // the data, as the filter dropdown's own sort does -- inside the sort's step.
  if (reapply) {
    try {
      await requireAutoFilterController().reapply();
    } catch (err) {
      console.warn("[Sorting] Reapplying the filter after a sort failed:", err);
    }
    await tx?.commit().catch((err) => console.error("[Sorting] Closing the sort's undo step failed:", err));
  }
}
