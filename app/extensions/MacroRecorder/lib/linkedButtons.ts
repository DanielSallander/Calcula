//! FILENAME: app/extensions/MacroRecorder/lib/linkedButtons.ts
// PURPOSE: Find the buttons that LINK a given macro, so deleting the macro can
//          warn the user by name instead of silently orphaning them.
// CONTEXT: The link model (a button carries a `macroRef` id, not a copied body)
//          means a macro can have buttons pointing at it. Deleting the macro is
//          allowed — the user may re-point those buttons — but it must not be
//          SILENT: the confirm has to say which buttons will be left with nothing
//          to run. That query is a scan across control metadata on every sheet,
//          which the backend already holds, so it lives there
//          (`list_controls_referencing_macro`) rather than being reconstructed on
//          the frontend from per-sheet control lists.

import { macroRecorderBackend } from "./macroRecorderBackend";

/** One button that links a macro, located for a human-readable warning. */
export interface MacroLinkingControl {
  sheetIndex: number;
  /** The sheet's display name, resolved backend-side. */
  sheetName: string;
  row: number;
  col: number;
}

/** Every control whose `macroRef` equals `macroId`, across all sheets. */
export async function listControlsReferencingMacro(
  macroId: string,
): Promise<MacroLinkingControl[]> {
  return macroRecorderBackend.invoke<MacroLinkingControl[]>(
    "list_controls_referencing_macro",
    { macroId },
  );
}

/** "Sheet1!A1" for a linking control, using its 0-based row/col. */
function toA1(control: MacroLinkingControl): string {
  let col = "";
  let c = control.col;
  do {
    col = String.fromCharCode(65 + (c % 26)) + col;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${control.sheetName}!${col}${control.row + 1}`;
}

/**
 * The confirm message for deleting a macro that ≥1 button links, enumerating the
 * buttons by sheet + A1 anchor. Returns null when nothing links it (caller uses
 * the plain confirm instead).
 *
 * Capped at a handful of anchors in the text so a macro wired to fifty buttons
 * does not produce an unreadable wall; the count is always exact.
 */
export function describeMacroDeletion(
  macroName: string,
  controls: MacroLinkingControl[],
): string | null {
  if (controls.length === 0) return null;
  const shown = controls.slice(0, 6).map(toA1);
  const suffix = controls.length > shown.length ? ", …" : "";
  const noun = controls.length === 1 ? "button links" : "buttons link";
  return (
    `${controls.length} ${noun} the macro "${macroName}" (${shown.join(", ")}${suffix}). ` +
    "Deleting it leaves them with nothing to run (clicking one will say so). " +
    "Delete anyway?"
  );
}
