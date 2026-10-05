//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/lib/cellShift.ts
// PURPOSE: Excel's Insert / Delete commands over the selection: what each one
//          decides (rows, columns, or cells shifted which way) and the one runner
//          every door goes through.
// CONTEXT: The Home tab's Insert / Delete split buttons (main half = INSERT /
//          DELETE; "Insert Cells..." / "Delete Cells..." = INSERT_CELLS /
//          DELETE_CELLS), the Ctrl+Plus / Ctrl+Minus keys and the Insert / Delete
//          dialogs all land here, so they cannot disagree about a shape or a
//          refusal. The cell shift itself is the backend's (`insert_cells` /
//          `delete_cells`, commands/structure_cells.rs); entire rows and columns
//          are the row/column grid commands, which act on the rows (columns) the
//          selection spans.
//
// EXCEL'S RULES, measured on live Excel 16 (build 20326, 2026-10-04):
// - A shift that is not named (Range.Insert / Range.Delete with no Shift) is
//   decided by the range's SHAPE: taller than wide shifts sideways (right on
//   insert, left on delete); wider than tall, square or a single cell shifts
//   vertically (down, up). D4:F4 -> down, D4:D6 -> right, D4:E5 -> down, D4 ->
//   down; the same for delete.
// - The Insert and Delete dialogs open with their FIRST option chosen ("Shift
//   cells right" / "Shift cells left") whatever the selection's shape; this
//   module also remembers the last choice for the session.
// - A range that spans every column (row) inserts entire rows (columns), whatever
//   shift was asked for. This module routes those to Core's row / column
//   gesture (wholeLineChoice, by SHAPE), so Select All + Insert meets the
//   gesture's "shifted off the worksheet" refusal.
// - Excel ASKS before unmerging a merged region the shift cuts: "This operation
//   will cause some merged cells to unmerge. Do you wish to continue?" -- OK
//   unmerges and shifts, Cancel changes nothing.

import { CommandRegistry, CoreCommands } from "@api/commands";
import { alertAsync, confirmAsync } from "@api/dialogs";
import { getGridStateSnapshot, refreshGridData } from "@api/grid";
import { insertCellsRange, deleteCellsRange, type CellShiftResult } from "@api/lib";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { DEFAULT_GRID_CONFIG, type GridConfig, type Selection } from "@api/types";

/** Which command family: Insert or Delete. */
export type CellShiftMode = "insert" | "delete";

/** The Insert dialog's four choices (Excel's order). */
export const INSERT_CHOICES = ["right", "down", "entireRow", "entireColumn"] as const;
export type InsertChoice = (typeof INSERT_CHOICES)[number];

/** The Delete dialog's four choices (Excel's order). */
export const DELETE_CHOICES = ["left", "up", "entireRow", "entireColumn"] as const;
export type DeleteChoice = (typeof DELETE_CHOICES)[number];

/** Any choice of either dialog. */
export type CellShiftChoice = InsertChoice | DeleteChoice;

/** Excel's labels for the choices, as its dialogs word them. */
export const CHOICE_LABELS: Record<CellShiftChoice, string> = {
  right: "Shift cells right",
  down: "Shift cells down",
  left: "Shift cells left",
  up: "Shift cells up",
  entireRow: "Entire row",
  entireColumn: "Entire column",
};

/** Excel's sentence for Insert / Delete over a Ctrl+click selection. */
export const MULTIPLE_SELECTIONS = "This command cannot be used on multiple selections.";

/** A rectangle with its corners in order. */
export interface CellRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The selection's (or one of its areas') rectangle, corners in order. */
export function selectionRect(selection: CellRect): CellRect {
  return {
    startRow: Math.min(selection.startRow, selection.endRow),
    startCol: Math.min(selection.startCol, selection.endCol),
    endRow: Math.max(selection.startRow, selection.endRow),
    endCol: Math.max(selection.startCol, selection.endCol),
  };
}

/**
 * Excel's shape rule for a shift nobody named: taller than wide moves
 * sideways, anything else moves vertically (measured; see the header).
 */
export function shapeShift(mode: CellShiftMode, rect: CellRect): "right" | "down" | "left" | "up" {
  const rows = rect.endRow - rect.startRow + 1;
  const cols = rect.endCol - rect.startCol + 1;
  const sideways = rows > cols;
  if (mode === "insert") return sideways ? "right" : "down";
  return sideways ? "left" : "up";
}

/** The `{ shift }` argument of INSERT_CELLS / DELETE_CELLS, or why it is wrong. */
export function readShiftArg(
  mode: CellShiftMode,
  args: unknown,
): { kind: "none" } | { kind: "choice"; choice: CellShiftChoice } | { kind: "invalid"; message: string } {
  if (args === undefined || args === null) return { kind: "none" };
  const shift = (args as { shift?: unknown }).shift;
  if (shift === undefined) return { kind: "none" };
  const allowed: readonly string[] = mode === "insert" ? INSERT_CHOICES : DELETE_CHOICES;
  if (typeof shift === "string" && allowed.includes(shift)) {
    return { kind: "choice", choice: shift as CellShiftChoice };
  }
  return {
    kind: "invalid",
    message: `${mode === "insert" ? "Insert" : "Delete"} Cells does not know the shift "${String(shift)}". Known: ${allowed.join(", ")}.`,
  };
}

/** The current selection, or null when the grid has none to act on. */
export function currentSelection(): Selection | null {
  return getGridStateSnapshot()?.selection ?? null;
}

/** The sheet's size: the grid's config, or Excel's when the grid has none yet. */
export function sheetSize(): { totalRows: number; totalCols: number } {
  const config = (getGridStateSnapshot() as { config?: Partial<GridConfig> } | null)?.config;
  return {
    totalRows: config?.totalRows ?? DEFAULT_GRID_CONFIG.totalRows,
    totalCols: config?.totalCols ?? DEFAULT_GRID_CONFIG.totalCols,
  };
}

/**
 * Whole rows or whole columns: Excel inserts / deletes the lines, no dialog.
 *
 * Decided by SHAPE, not by `Selection.type`: Select All (Ctrl+A) commits a
 * "cells" selection over the whole sheet, and a cells range that spans every
 * column used to reach the cell shift, whose whole-line branch inserted
 * 1,048,576 rows past Core's row gesture and its "shifted off the worksheet"
 * refusal. A range that spans every column is entire rows (checked first, so
 * Select All is rows, as Core's gesture refuses it); one that spans every row
 * is entire columns. Every Ctrl+click block must span them for the selection
 * to count.
 */
export function wholeLineChoice(
  selection: Selection,
  size: { totalRows: number; totalCols: number } = sheetSize(),
): "entireRow" | "entireColumn" | null {
  if (selection.type === "rows") return "entireRow";
  if (selection.type === "columns") return "entireColumn";
  const blocks = [selection, ...(selection.additionalRanges ?? [])].map(selectionRect);
  if (blocks.every((b) => b.startCol <= 0 && b.endCol >= size.totalCols - 1)) return "entireRow";
  if (blocks.every((b) => b.startRow <= 0 && b.endRow >= size.totalRows - 1)) return "entireColumn";
  return null;
}

/** The grid command an "Entire row" / "Entire column" choice runs. */
function lineCommand(mode: CellShiftMode, choice: "entireRow" | "entireColumn"): string {
  if (mode === "insert") return choice === "entireRow" ? CoreCommands.INSERT_ROW : CoreCommands.INSERT_COLUMN;
  return choice === "entireRow" ? CoreCommands.DELETE_ROW : CoreCommands.DELETE_COLUMN;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The label a refusal names the gesture by. */
export function gestureLabel(mode: CellShiftMode): string {
  return mode === "insert" ? "Insert" : "Delete";
}

/**
 * Run one choice over `selection`. Never throws: every refusal reaches the
 * user (an alert), and the grid is refreshed after a change.
 *
 * Entire row / column runs the row/column grid command (which acts on the
 * rows / columns the selection SPANS). A cell shift calls the backend; when it
 * stops to ask about merges, the user's answer decides (Cancel = nothing).
 */
export async function runChoice(mode: CellShiftMode, selection: Selection, choice: CellShiftChoice): Promise<void> {
  if (choice === "entireRow" || choice === "entireColumn") {
    await CommandRegistry.execute(lineCommand(mode, choice));
    return;
  }
  // A range that spans every column (row) is entire rows (columns) whatever
  // shift was named (Excel's rule, see the header) -- through Core's gesture,
  // so its refusals and guards apply, never the cell shift's whole-line branch.
  const line = wholeLineChoice(selection);
  if (line) {
    await CommandRegistry.execute(lineCommand(mode, line));
    return;
  }
  if (selection.additionalRanges && selection.additionalRanges.length > 0) {
    await alertAsync(MULTIPLE_SELECTIONS);
    return;
  }
  const rect = selectionRect(selection);
  const call = (unmergeCutMerges: boolean): Promise<CellShiftResult> =>
    mode === "insert"
      ? insertCellsRange(rect.startRow, rect.startCol, rect.endRow, rect.endCol, choice as "right" | "down", {
          unmergeCutMerges,
        })
      : deleteCellsRange(rect.startRow, rect.startCol, rect.endRow, rect.endCol, choice as "left" | "up", {
          unmergeCutMerges,
        });
  try {
    let result = await call(false);
    if (!result.applied && result.confirm) {
      if (!(await confirmAsync(result.confirm, { title: gestureLabel(mode), kind: "warning" }))) return;
      result = await call(true);
    }
    if (result.applied) refreshGridData();
  } catch (error) {
    console.error(`[InsertDeleteCells] ${mode} ${choice} failed:`, error);
    await alertAsync(messageOf(error));
  }
}

/**
 * INSERT / DELETE: the split buttons' main halves and Ctrl+Plus / Ctrl+Minus.
 * Whole rows -> rows, whole columns -> columns, otherwise cells shifted the
 * way Excel's shape rule says.
 */
export async function runMainHalf(mode: CellShiftMode): Promise<void> {
  if (refuseIfSelectionOwned(gestureLabel(mode))) return;
  const selection = currentSelection();
  if (!selection) return;
  const line = wholeLineChoice(selection);
  if (line) {
    await runChoice(mode, selection, line);
    return;
  }
  await runChoice(mode, selection, shapeShift(mode, selectionRect(selection)));
}
