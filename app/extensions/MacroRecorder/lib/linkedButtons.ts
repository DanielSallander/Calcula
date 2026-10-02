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
//
//          ONE WRAPPER. The same listing now also feeds the approval screen's
//          "Buttons that run this macro" (phase 3 of BUG-0257), so it is read
//          through `@api/heldButtonCode`'s `listButtonsRunningMacro` -- one
//          wrapper, one wire shape -- rather than a second copy here.

import { listButtonsRunningMacro, type ButtonRunningMacro } from "@api/heldButtonCode";

/** One button that links a macro, located for a human-readable warning. */
export type MacroLinkingControl = Pick<ButtonRunningMacro, "sheetIndex" | "sheetName" | "row" | "col"> &
  Partial<Omit<ButtonRunningMacro, "sheetIndex" | "sheetName" | "row" | "col">>;

/** Every button whose `macroRef` -- live or HELD -- or script action equals `macroId`, across all sheets. */
export async function listControlsReferencingMacro(
  macroId: string,
): Promise<MacroLinkingControl[]> {
  return listButtonsRunningMacro(macroId);
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
  // A HELD link is an application's, and a push publishes it unchanged: deleting
  // the macro here ships buttons naming a macro the application no longer has.
  const held = controls.filter((c) => c.heldBy);
  const heldNote =
    held.length === 0
      ? ""
      : `${
          held.length === controls.length
            ? controls.length === 1
              ? "It holds"
              : "They hold"
            : held.length === 1
              ? "One of them holds"
              : `${held.length} of them hold`
        } the link ` +
        `that came with the application "${held[0].heldBy}", which your next push publishes ` +
        "unchanged -- without this macro, those buttons would name a macro the application " +
        "no longer carries. ";
  return (
    `${controls.length} ${noun} the macro "${macroName}" (${shown.join(", ")}${suffix}). ` +
    "Deleting it leaves them with nothing to run (clicking one will say so). " +
    heldNote +
    "Delete anyway?"
  );
}
