//! FILENAME: app/src/core/lib/fillCommands/fillCommands.ts
// PURPOSE: Excel's Fill Down / Fill Right / Fill Up / Fill Left over the
//          selection: which cells are copied where, and the one backend call.
// CONTEXT: The handlers behind the grid commands `fillDown` / `fillRight` /
//          `fillUp` / `fillLeft` (Ctrl+D, Ctrl+R, the Home tab's Fill menu,
//          object scripts -- all four are script-safe). Core's
//          useSpreadsheetSelection registers them; the rules live here so they
//          can be tested without a grid.
//
//          Before (2026-10-04): each needed at least two rows (columns)
//          selected and silently did nothing on one, and a refusal (a protected
//          sheet, a spilled array, a writeback claim) was only logged.
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-04):
// - Several rows: Fill Down copies the TOP row into the rows below (Fill Up:
//   the bottom row upwards). Several columns: Fill Right copies the LEFT
//   column (Fill Left: the right column).
// - ONE row (a cell, or a row of cells): Fill Down copies the row ABOVE into
//   it, Fill Up the row BELOW; one column: Fill Right copies the column to the
//   LEFT, Fill Left the column to the RIGHT. Value, formula (references
//   shifted) and format; an EMPTY source clears the target.
// - At the sheet's edge (Fill Down in row 1, ...) there is nothing to copy
//   from and the command does nothing.
// - The backend's fill_range is one undo step (it opens one, or joins).
// - A MERGED source (BUG-0768, Excel 16 COM [LIVE] 2026-11-06, lane uimisc
//   probe2): the source band is the leading row (column) WIDENED to the merges
//   it holds -- FillDown of A1:A6 with A1:A2 merged copies A1:A2 and merges
//   A3:A4 and A5:A6 -- and the backend repeats the source's merges down
//   (across) the fill (`fill_merge_pattern`, commands/data.rs), or changes
//   nothing where Excel changes nothing.

import type { CellTargetRef, MergedRegion, Selection, SelectionRange } from "../../types";
import { fillRange, getCellTargetMergedRegions, getMergedRegions } from "../tauri-api";
import { alertAsync } from "../dialogs";
import { cellEvents, cellToChange } from "../cellEvents";

export type FillDirection = "down" | "right" | "up" | "left";

/** Copy `source` over `target` (tiled), as the backend's fill_range does. */
export interface FillPlan {
  source: SelectionRange;
  target: SelectionRange;
}

/** What a fill needs from the grid that runs it. */
export interface FillCommandHost {
  selection: Selection | null;
  /** The sheet's size: Fill Up / Left on the last row / column has no source.
   *  For a target, the object's extent (its last row / column is its edge). */
  totalRows: number;
  totalCols: number;
  /**
   * The OBJECT whose cells both ranges are in (a floating grid's, P3), or
   * absent for the active sheet. The fill then runs on the object's backing
   * cells; its result names backing coordinates, so no active-sheet cell event
   * is emitted (it would alias the host's cell) -- the object re-reads through
   * "grid:refresh".
   */
  target?: CellTargetRef;
}

function range(startRow: number, startCol: number, endRow: number, endCol: number): SelectionRange {
  return { startRow, startCol, endRow, endCol };
}

/** A merged area, as far as the plan needs one. */
type MergeBox = Pick<MergedRegion, "startRow" | "startCol" | "endRow" | "endCol">;

/**
 * Widen a source BAND (lines `lo..hi` along the fill's axis, across `x0..x1`)
 * to every merge it holds, growing away from the target (`grow`): Excel copies
 * a merged leading row whole, so FillDown of A1:A6 with A1:A2 merged copies
 * A1:A2 (BUG-0768). Repeated until no merge sticks out.
 */
function widenBand(
  lo: number,
  hi: number,
  x0: number,
  x1: number,
  rowAxis: boolean,
  grow: "forward" | "backward",
  merges: readonly MergeBox[],
): [number, number] {
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of merges) {
      const [a0, a1, b0, b1] = rowAxis
        ? [m.startRow, m.endRow, m.startCol, m.endCol]
        : [m.startCol, m.endCol, m.startRow, m.endRow];
      if (a1 < lo || a0 > hi || b1 < x0 || b0 > x1) continue;
      if (grow === "forward" && a1 > hi) {
        hi = a1;
        changed = true;
      } else if (grow === "backward" && a0 < lo) {
        lo = a0;
        changed = true;
      }
    }
  }
  return [lo, hi];
}

/**
 * The source and target of a fill over the selection's main range, or null
 * when there is nothing to copy from (no selection, or the sheet's edge).
 * `merges`: the merged areas near the selection; a source band is widened to
 * the merges it holds (see THE RULES).
 */
export function fillPlan(
  direction: FillDirection,
  selection: Selection | null | undefined,
  totalRows: number,
  totalCols: number,
  merges: readonly MergeBox[] = [],
): FillPlan | null {
  if (!selection) return null;
  const r0 = Math.min(selection.startRow, selection.endRow);
  const r1 = Math.max(selection.startRow, selection.endRow);
  const c0 = Math.min(selection.startCol, selection.endCol);
  const c1 = Math.max(selection.startCol, selection.endCol);

  switch (direction) {
    case "down": {
      if (r1 > r0) {
        const [, e] = widenBand(r0, r0, c0, c1, true, "forward", merges);
        return e >= r1 ? null : { source: range(r0, c0, e, c1), target: range(e + 1, c0, r1, c1) };
      }
      if (r0 === 0) return null;
      const [s] = widenBand(r0 - 1, r0 - 1, c0, c1, true, "backward", merges);
      return { source: range(s, c0, r0 - 1, c1), target: range(r0, c0, r1, c1) };
    }
    case "up": {
      if (r1 > r0) {
        const [s] = widenBand(r1, r1, c0, c1, true, "backward", merges);
        return s <= r0 ? null : { source: range(s, c0, r1, c1), target: range(r0, c0, s - 1, c1) };
      }
      if (r1 >= totalRows - 1) return null;
      const [, e] = widenBand(r1 + 1, r1 + 1, c0, c1, true, "forward", merges);
      return { source: range(r1 + 1, c0, e, c1), target: range(r0, c0, r1, c1) };
    }
    case "right": {
      if (c1 > c0) {
        const [, e] = widenBand(c0, c0, r0, r1, false, "forward", merges);
        return e >= c1 ? null : { source: range(r0, c0, r1, e), target: range(r0, e + 1, r1, c1) };
      }
      if (c0 === 0) return null;
      const [s] = widenBand(c0 - 1, c0 - 1, r0, r1, false, "backward", merges);
      return { source: range(r0, s, r1, c0 - 1), target: range(r0, c0, r1, c1) };
    }
    case "left": {
      if (c1 > c0) {
        const [s] = widenBand(c1, c1, r0, r1, false, "backward", merges);
        return s <= c0 ? null : { source: range(r0, s, r1, c1), target: range(r0, c0, r1, s - 1) };
      }
      if (c1 >= totalCols - 1) return null;
      const [, e] = widenBand(c1 + 1, c1 + 1, r0, r1, false, "forward", merges);
      return { source: range(r0, c1 + 1, r1, e), target: range(r0, c0, r1, c1) };
    }
  }
}

/** Whether any merge meets the rectangle. */
function meetsMerge(r: SelectionRange, merges: readonly MergeBox[]): boolean {
  return merges.some(
    (m) => !(m.endRow < r.startRow || m.startRow > r.endRow || m.endCol < r.startCol || m.startCol > r.endCol),
  );
}

/**
 * The merged areas around the selection that can widen its source band: one
 * read of the selection grown by one line each way (the neighbour a one-line
 * fill copies from) -- a merge that reaches into that frame is returned whole.
 * An object target (a floating grid) reads its OWN merges, as its fill
 * repeats them (`fill_range_on_target`). Empty when they cannot be read: the
 * plan is then the plain band.
 */
async function mergesNear(host: FillCommandHost): Promise<MergeBox[]> {
  const sel = host.selection;
  if (!sel) return [];
  try {
    const frame = {
      startRow: Math.max(0, Math.min(sel.startRow, sel.endRow) - 1),
      startCol: Math.max(0, Math.min(sel.startCol, sel.endCol) - 1),
      endRow: Math.max(sel.startRow, sel.endRow) + 1,
      endCol: Math.max(sel.startCol, sel.endCol) + 1,
    };
    const regions = host.target
      ? await getCellTargetMergedRegions(host.target, {
          ...frame,
          endRow: Math.min(frame.endRow, host.totalRows - 1),
          endCol: Math.min(frame.endCol, host.totalCols - 1),
        })
      : await getMergedRegions(frame);
    return Array.isArray(regions) ? regions : [];
  } catch (error) {
    console.warn("[fillCommands] the merged cells could not be read; filling the plain band:", error);
    return [];
  }
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run one of Excel's four fills over `host.selection`. Never throws: a
 * refusal reaches the user as an alert.
 */
export async function runFillCommand(direction: FillDirection, host: FillCommandHost): Promise<void> {
  if (!host.selection) return;
  const merges = await mergesNear(host);
  const plan = fillPlan(direction, host.selection, host.totalRows, host.totalCols, merges);
  if (!plan) return;
  const { source: s, target: t } = plan;
  try {
    // ONE IPC call: the backend tiles the source over the target and shifts
    // formula references by each target cell's offset.
    if (host.target) {
      await fillRange(
        s.startRow, s.startCol, s.endRow, s.endCol,
        t.startRow, t.startCol, t.endRow, t.endCol,
        { target: host.target },
      );
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      return;
    }
    const updatedCells = await fillRange(
      s.startRow, s.startCol, s.endRow, s.endCol,
      t.startRow, t.startCol, t.endRow, t.endCol,
    );
    if (updatedCells.length > 0) {
      cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
      // A merged source's merges were repeated (BUG-0768): the grid re-reads
      // its merged areas.
      if (meetsMerge(s, merges)) window.dispatchEvent(new CustomEvent("grid:refresh"));
    }
  } catch (error) {
    console.error(`[fillCommands] Fill ${direction} failed:`, error);
    await alertAsync(messageOf(error));
  }
}
