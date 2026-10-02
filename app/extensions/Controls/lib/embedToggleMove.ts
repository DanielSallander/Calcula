//! FILENAME: app/extensions/Controls/lib/embedToggleMove.ts
// PURPOSE: The floating -> in-cell toggle's MOVE of a button to its new anchor
//          cell: one backend step (`move_control`) that carries every property,
//          the application's HELD code included (BUG-0257), and re-keys the
//          button's object-script bindings with it.
// CONTEXT: The toggle used to re-create the button at the new cell
//          (`setControlMetadata`) and delete the old one
//          (`removeControlMetadata`). The metadata door is the PASTE door and
//          strips held code, so every toggled button of a working copy lost its
//          application's code and the next push published it empty -- BUG-0257
//          reborn through an everyday gesture. It is a function of its own so a
//          test can pin that the toggle MOVES and never re-creates.

import { moveControl } from "./controlApi";
import { makeFloatingControlId } from "./floatingStore";

/**
 * Move the floating button at `from` into the cell `to` (same sheet), marking
 * it embedded, as ONE undoable backend step. A no-op when the cell is the same.
 * Throws the backend's refusal (another control already at `to`) with nothing
 * changed -- the caller does this FIRST, so a refusal leaves nothing
 * half-toggled.
 */
export async function moveFloatingButtonIntoCell(
  sheetIndex: number,
  from: { row: number; col: number },
  to: { row: number; col: number },
): Promise<void> {
  if (from.row === to.row && from.col === to.col) return;
  await moveControl(sheetIndex, from.row, from.col, to.row, to.col, {
    embedded: { valueType: "static", value: "true" },
  });
  // The backend re-keyed the button's object-script bindings with it
  // (`move_control_core`); follow in this session's registry, so a click at the
  // new cell finds the button's script without a reload. Dynamic, like every
  // other ObjectScriptManager use in Controls: the script host pulls in the
  // worker bootstrap, and Controls activates long before any script does.
  const { ObjectScriptManager } = await import("@api");
  const fromId = makeFloatingControlId(sheetIndex, from.row, from.col);
  const toId = makeFloatingControlId(sheetIndex, to.row, to.col);
  for (const script of ObjectScriptManager.getAllScripts()) {
    if (script.instanceId === fromId) {
      ObjectScriptManager.registerScript({ ...script, instanceId: toId });
    }
  }
}
