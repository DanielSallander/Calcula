//! FILENAME: app/extensions/Pivot/lib/pivotCanvasCellCommands.ts
// PURPOSE: The command ids of a canvas pivot box's CELL keys (D-CELLS) and the
//          one sentence a refused edit says. Constants only, so the box's
//          object-selection provider (pivotVisualSelection.ts, which names the
//          Copy / Paste DOOR commands through `innerClipboardCommand`) and the
//          edit guard in index.ts can import them without pulling in the keys
//          module (pivotCanvasCellKeys.ts) that registers the commands.

import type { PivotCellStep } from "./pivotCellNavigation";

/** Copy the selected cells (Ctrl+C, Ctrl+Insert, Home > Copy, Edit > Copy, the box menu's Copy). */
export const PIVOT_CANVAS_COPY_CELLS_COMMAND = "pivot.canvasCells.copy";

/** Refuse an edit of the selected cells: Delete, Backspace, Ctrl+X, Ctrl+V, Ctrl+D -- and the Paste DOOR. */
export const PIVOT_CANVAS_REFUSE_EDIT_COMMAND = "pivot.canvasCells.refuseEdit";

/** Clear the cell selection (Escape); the box stays selected. */
export const PIVOT_CANVAS_CLEAR_CELLS_COMMAND = "pivot.canvasCells.clear";

/** Select the selected box's whole content (Ctrl+A). */
export const PIVOT_CANVAS_SELECT_ALL_COMMAND = "pivot.canvasCells.selectAll";

/**
 * The ONE sentence a refused edit of a pivot's cells says -- on a worksheet
 * (the edit guard in index.ts) and on a canvas (the refusal keys) alike.
 */
export const PIVOT_EDIT_REFUSAL = "You can't change this part of the PivotTable.";

/**
 * The command id of an arrow step: "pivot.canvasCells.move<Dir>" (the active
 * cell moves, the selection collapses onto it) or "pivot.canvasCells.extend<Dir>"
 * (the selection's far corner moves; Shift+arrow).
 */
export function pivotCanvasMoveCommand(dir: PivotCellStep, extend: boolean): string {
  const name = dir.charAt(0).toUpperCase() + dir.slice(1);
  return `pivot.canvasCells.${extend ? "extend" : "move"}${name}`;
}
