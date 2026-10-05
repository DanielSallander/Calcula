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

import type { Selection, SelectionRange } from "../../types";
import { fillRange } from "../tauri-api";
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
  /** The sheet's size: Fill Up / Left on the last row / column has no source. */
  totalRows: number;
  totalCols: number;
}

function range(startRow: number, startCol: number, endRow: number, endCol: number): SelectionRange {
  return { startRow, startCol, endRow, endCol };
}

/**
 * The source and target of a fill over the selection's main range, or null
 * when there is nothing to copy from (no selection, or the sheet's edge).
 */
export function fillPlan(
  direction: FillDirection,
  selection: Selection | null | undefined,
  totalRows: number,
  totalCols: number,
): FillPlan | null {
  if (!selection) return null;
  const r0 = Math.min(selection.startRow, selection.endRow);
  const r1 = Math.max(selection.startRow, selection.endRow);
  const c0 = Math.min(selection.startCol, selection.endCol);
  const c1 = Math.max(selection.startCol, selection.endCol);

  switch (direction) {
    case "down":
      if (r1 > r0) return { source: range(r0, c0, r0, c1), target: range(r0 + 1, c0, r1, c1) };
      if (r0 === 0) return null;
      return { source: range(r0 - 1, c0, r0 - 1, c1), target: range(r0, c0, r1, c1) };
    case "up":
      if (r1 > r0) return { source: range(r1, c0, r1, c1), target: range(r0, c0, r1 - 1, c1) };
      if (r1 >= totalRows - 1) return null;
      return { source: range(r1 + 1, c0, r1 + 1, c1), target: range(r0, c0, r1, c1) };
    case "right":
      if (c1 > c0) return { source: range(r0, c0, r1, c0), target: range(r0, c0 + 1, r1, c1) };
      if (c0 === 0) return null;
      return { source: range(r0, c0 - 1, r1, c0 - 1), target: range(r0, c0, r1, c1) };
    case "left":
      if (c1 > c0) return { source: range(r0, c1, r1, c1), target: range(r0, c0, r1, c1 - 1) };
      if (c1 >= totalCols - 1) return null;
      return { source: range(r0, c1 + 1, r1, c1 + 1), target: range(r0, c0, r1, c1) };
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
  const plan = fillPlan(direction, host.selection, host.totalRows, host.totalCols);
  if (!plan) return;
  const { source: s, target: t } = plan;
  try {
    // ONE IPC call: the backend tiles the source over the target and shifts
    // formula references by each target cell's offset.
    const updatedCells = await fillRange(
      s.startRow, s.startCol, s.endRow, s.endCol,
      t.startRow, t.startCol, t.endRow, t.endCol,
    );
    if (updatedCells.length > 0) {
      cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
    }
  } catch (error) {
    console.error(`[fillCommands] Fill ${direction} failed:`, error);
    await alertAsync(messageOf(error));
  }
}
