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
//
// ON A FLOATING GRID'S CELLS (P3, owner finding G3): the door asks the
// cell-target question. Entire rows / columns are the GRID's own lines (table
// semantics: its content shifts and its window grows or shrinks) -- capability
// "structure", run through the same row / column grid commands, whose door
// hands the target on. A cell SHIFT asks "shiftCells", which no floating grid
// admits this round (the backend's cell shift is an active-sheet pipeline over
// ~30 per-sheet stores), so it refuses with the grid's own sentence ("Insert
// Cells is not available inside a floating grid yet. Nothing was changed.")
// and never invokes anything.

import { CommandRegistry, CoreCommands } from "@api/commands";
import { alertAsync, confirmAsync } from "@api/dialogs";
import { getGridStateSnapshot, refreshGridData } from "@api/grid";
import {
  insertCellsRange,
  deleteCellsRange,
  insertCopiedCells,
  insertCopiedCellsLabel,
  pendingCopyOfSheetCells,
  PASTE_ONCE,
  pasteTiles,
  type CellShiftResult,
  type ClipboardData,
  type InsertCopiedCellsRequest,
} from "@api/lib";
import { cellTargetFor, resolveCellTarget } from "@api/cellTarget";
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

/** The label a cell SHIFT asks (and is refused) by -- Excel's menu item names. */
export function shiftLabel(mode: CellShiftMode): string {
  return mode === "insert" ? "Insert Cells" : "Delete Cells";
}

/** Where a door acts: the selection, and the size its whole-line rule measures against. */
export interface CellShiftPlace {
  selection: Selection;
  size: { totalRows: number; totalCols: number };
  /** The selection is an OBJECT's cells (a floating grid's), not the sheet's. */
  onObject?: boolean;
}

/**
 * THE DOOR'S QUESTION, asked once per gesture. An owner holding the selection
 * that admits line acts ("structure" -- a floating grid's cells): its selection,
 * measured against its OWN extent. No owner: Core's selection and the sheet.
 * An owner that admits no line act: the shift question is asked so the owner's
 * own sentence is announced, and null (nothing runs, no dialog opens).
 */
export function resolveShiftPlace(mode: CellShiftMode): CellShiftPlace | null {
  const t = cellTargetFor("structure", gestureLabel(mode));
  if ("refusal" in t) {
    // Announce once, through the question the owner explains best.
    resolveCellTarget(shiftLabel(mode), "shiftCells");
    return null;
  }
  if (t.kind === "object") {
    return { selection: t.selection, size: { totalRows: t.bounds.rows, totalCols: t.bounds.cols }, onObject: true };
  }
  const selection = currentSelection();
  return selection ? { selection, size: sheetSize() } : null;
}

/**
 * Run one choice over `selection`. Never throws: every refusal reaches the
 * user (an alert), and the grid is refreshed after a change.
 *
 * Entire row / column runs the row/column grid command (which acts on the
 * rows / columns the selection SPANS). A cell shift calls the backend; when it
 * stops to ask about merges, the user's answer decides (Cancel = nothing).
 */
export async function runChoice(
  mode: CellShiftMode,
  selection: Selection,
  choice: CellShiftChoice,
  size: { totalRows: number; totalCols: number } = sheetSize(),
): Promise<void> {
  if (choice === "entireRow" || choice === "entireColumn") {
    // The row / column grid command's own door resolves where it acts (a
    // floating grid's lines, or the sheet's) and hands the target on.
    await CommandRegistry.execute(lineCommand(mode, choice));
    return;
  }
  // A range that spans every column (row) is entire rows (columns) whatever
  // shift was named (Excel's rule, see the header) -- through Core's gesture,
  // so its refusals and guards apply, never the cell shift's whole-line branch.
  const line = wholeLineChoice(selection, size);
  if (line) {
    await CommandRegistry.execute(lineCommand(mode, line));
    return;
  }
  // A cell SHIFT. No owner admits "shiftCells" this round, so on a floating
  // grid's cell this refuses with the grid's sentence and nothing is invoked;
  // on a sheet cell it is the grid target and the shift runs as before.
  const target = resolveCellTarget(shiftLabel(mode), "shiftCells");
  if (target === null) return;
  if (target.kind === "object") {
    // An owner that admitted it would need an object route the backend does
    // not have (insert_cells / delete_cells take no target): never fall
    // through to Core's hidden cell under the object.
    await alertAsync(`${shiftLabel(mode)} is not available for ${target.label}'s cells. Nothing was changed.`);
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

// ============================================================================
// INSERT COPIED CELLS -- Insert while a COPY is pending
// ============================================================================
//
// Live Excel 16 [2026-10-30, clip4/probe-insert.ps1 and probe-insert2.ps1,
// fresh visible instances, Home > Insert > Cells... and Ctrl+Plus]: with a
// copy pending the Cells... row reads "Insert Copied Cells..." and Insert
// makes room for the COPIED block and pastes it there, as one undo step, the
// copy staying pending:
//   - its dialog ("Insert") offers Shift cells right / Shift cells down only;
//   - the room is the copy's size at the selection's top-left (A1:B1 copied
//     into F2 -> F2:G2; F6:F7 copied into F2:F4 -> F2:F3) -- or the whole
//     selection when it is an exact multiple of the copy, which the copy then
//     fills TILED, as a Paste tiles (@api/lib `pasteTiles`) [LIVE round 13,
//     clip5/probe-insert-tile.ps1: F6 into F2:F3 -> f6 twice; F6:F7 into
//     F2:F5 -> f6,f7,f6,f7; rows 6:7 into rows 2:5 -> the pair twice; rows 2:4
//     -> once];
//   - whole rows (columns) selected with whole rows (columns) copied: the
//     copied lines are inserted there, no dialog ("Insert Copied Cells");
//   - whole rows (columns) selected with a block of cells copied, or the other
//     way about: refused, "This selection isn't valid...", nothing changes.
// A cut pending is Excel's "Insert Cut Cells", which is not modelled: Insert
// then runs as it does without a clipboard and ends the cut.

/** The Insert dialog's choices while a copy is pending (Excel's "Insert" over a copy). */
export const INSERT_COPIED_CHOICES = ["right", "down"] as const;

/** Excel's words when the copied block cannot be inserted in the selection's shape [LIVE]. */
export const COPY_AREA_MISMATCH =
  "This selection isn't valid.\n\nMake sure the copy and paste areas don't overlap unless they are the same size and shape.";

/** What Insert does with a copy pending: insert the copied lines, ask the shift for a block, or refuse. */
export type InsertCopiedPlan =
  | { kind: "refused"; message: string }
  | { kind: "lines"; request: Extract<InsertCopiedCellsRequest, { kind: "rows" | "columns" }> }
  | { kind: "cells"; rect: CellRect };

/** The copy's own shape: whole rows, whole columns, or a block of `rows` x `cols` cells. */
function copiedShape(
  clip: ClipboardData,
  size: { totalRows: number; totalCols: number },
): { lines: "rows" | "columns" | null; rows: number; cols: number } {
  const src = selectionRect(clip.sourceSelection);
  const rows = clip.cells.length > 0 ? clip.cells.length : src.endRow - src.startRow + 1;
  const cols = src.endCol - src.startCol + 1;
  if (clip.sourceSelection.type === "rows" || (src.startCol <= 0 && src.endCol >= size.totalCols - 1)) {
    return { lines: "rows", rows, cols };
  }
  if (clip.sourceSelection.type === "columns" || (src.startRow <= 0 && src.endRow >= size.totalRows - 1)) {
    return { lines: "columns", rows, cols };
  }
  return { lines: null, rows, cols };
}

/**
 * Excel's rules for Insert over `selection` with `clip` copied (see above).
 * `forced`: a named "entireRow" / "entireColumn" (a script's INSERT_CELLS
 * `{ shift }`), which inserts lines whatever the selection's shape.
 */
export function planInsertCopied(
  clip: ClipboardData,
  selection: Selection,
  size: { totalRows: number; totalCols: number },
  forced?: "entireRow" | "entireColumn",
): InsertCopiedPlan {
  if (selection.additionalRanges && selection.additionalRanges.length > 0) {
    return { kind: "refused", message: MULTIPLE_SELECTIONS };
  }
  const shape = copiedShape(clip, size);
  const line = forced ?? wholeLineChoice(selection, size);
  const rect = selectionRect(selection);
  if (line === "entireRow") {
    if (shape.lines !== "rows") return { kind: "refused", message: COPY_AREA_MISMATCH };
    // Selected rows that are a multiple of the copied rows take it tiled --
    // asked over the area the copy's own paste then fills (the selected rows x
    // the copied width), so the room and the paste apply the SAME cap: a room
    // the paste would fill only once is made only once (round 15, rev13B).
    const tiles = forced ? PASTE_ONCE : pasteTiles(shape.rows, shape.cols, { ...rect, startCol: 0, endCol: shape.cols - 1 });
    return { kind: "lines", request: { kind: "rows", start: rect.startRow, count: shape.rows * tiles.rows } };
  }
  if (line === "entireColumn") {
    if (shape.lines !== "columns") return { kind: "refused", message: COPY_AREA_MISMATCH };
    const tiles = forced ? PASTE_ONCE : pasteTiles(shape.rows, shape.cols, { ...rect, startRow: 0, endRow: shape.rows - 1 });
    return { kind: "lines", request: { kind: "columns", start: rect.startCol, count: shape.cols * tiles.cols } };
  }
  if (shape.lines !== null) return { kind: "refused", message: COPY_AREA_MISMATCH };
  // The copy's size, or the whole selection when that is a multiple of it.
  const tiles = pasteTiles(shape.rows, shape.cols, rect);
  const room: CellRect = {
    startRow: rect.startRow,
    startCol: rect.startCol,
    endRow: rect.startRow + shape.rows * tiles.rows - 1,
    endCol: rect.startCol + shape.cols * tiles.cols - 1,
  };
  if (room.endRow > size.totalRows - 1 || room.endCol > size.totalCols - 1) {
    return { kind: "refused", message: COPY_AREA_MISMATCH };
  }
  return { kind: "cells", rect: room };
}

/**
 * The right-click menu's Insert item with a copy pending, as Excel's menus
 * word it [LIVE 2026-10-30, clip6/probe-menu.ps1: Shift+F10 on a fresh visible
 * Excel 16, the open menu read through UI Automation]: on a ROW or COLUMN
 * header "Insert Copied Cells" (row 6 or F6 copied, row 2 selected; column F
 * or row 6 copied, column B selected), on cells "Insert Copied Cells..." for a
 * copied block (F6 copied, B2 selected: the dialog follows) and "Insert
 * Copied Cells" for copied whole lines (row 6 copied, B2 selected). Null with
 * no copy pending: the menus keep their own words (Insert... / Insert Row /
 * Insert Column).
 */
export function insertCopiedMenuLabel(selection: { type?: string } | null | undefined): string | null {
  const clip = pendingCopyOfSheetCells();
  if (!clip) return null;
  const onLines = selection?.type === "rows" || selection?.type === "columns";
  const copiedLines = copiedShape(clip, sheetSize()).lines !== null;
  return insertCopiedCellsLabel(onLines || copiedLines);
}

/** The copy Insert would insert: a pending COPY of sheet cells, on the sheet (never a floating grid's selection). */
export function copyToInsert(place: CellShiftPlace): ClipboardData | null {
  if (place.onObject) return null;
  return pendingCopyOfSheetCells();
}

/** Run Insert Copied Cells (one undo step); every refusal reaches the user, and the grid is refreshed after. */
export async function runInsertCopied(request: InsertCopiedCellsRequest): Promise<void> {
  const result = await insertCopiedCells(request);
  if (result.inserted) {
    refreshGridData();
    return;
  }
  if (result.message) await alertAsync(result.message);
}

/**
 * Insert with a copy pending, over `place` (see INSERT COPIED CELLS). A block
 * of cells needs a shift: `shift` when it is known, else `askShift` decides
 * (the dialog; null = no dialog, the shape rule).
 */
export async function runInsertCopiedPlan(
  clip: ClipboardData,
  place: CellShiftPlace,
  shift: "right" | "down" | null,
  forced?: "entireRow" | "entireColumn",
  askShift?: (run: (shift: "right" | "down") => Promise<void>) => void,
): Promise<void> {
  const plan = planInsertCopied(clip, place.selection, place.size, forced);
  if (plan.kind === "refused") {
    await alertAsync(plan.message);
    return;
  }
  if (plan.kind === "lines") {
    await runInsertCopied(plan.request);
    return;
  }
  const run = (s: "right" | "down"): Promise<void> => runInsertCopied({ kind: "cells", ...plan.rect, shift: s });
  if (shift) {
    await run(shift);
    return;
  }
  if (askShift) {
    askShift(run);
    return;
  }
  await run(shapeShift("insert", plan.rect) as "right" | "down");
}

/**
 * INSERT / DELETE: the split buttons' main halves and Ctrl+Plus / Ctrl+Minus.
 * Whole rows -> rows, whole columns -> columns, otherwise cells shifted the
 * way Excel's shape rule says. With a COPY pending, Insert is Insert Copied
 * Cells (the shift by the same shape rule, no dialog).
 */
export async function runMainHalf(mode: CellShiftMode): Promise<void> {
  const place = resolveShiftPlace(mode);
  if (!place) return;
  const { selection, size } = place;
  const copied = mode === "insert" ? copyToInsert(place) : null;
  if (copied) {
    await runInsertCopiedPlan(copied, place, null);
    return;
  }
  const line = wholeLineChoice(selection, size);
  if (line) {
    await runChoice(mode, selection, line, size);
    return;
  }
  await runChoice(mode, selection, shapeShift(mode, selectionRect(selection)), size);
}
