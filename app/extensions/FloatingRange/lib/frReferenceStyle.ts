//! FILENAME: app/extensions/FloatingRange/lib/frReferenceStyle.ts
// PURPOSE: A floating grid's formulas SHOWN and EDITED in the workbook's
//          reference style: R1C1 text in the formula bar and the cell editor
//          when the workbook uses R1C1, stored as A1 -- the grid's own rule.
// CONTEXT: E3 (open-items 2.af row 5). Core's formula bar and in-cell editor
//          show a formula in R1C1, relative to its cell, when File > Options >
//          Formulas > R1C1 is on (FormulaInput.tsx, useEditing startEdit), and
//          convert what was edited back to A1 before writing (useEditing
//          commitEdit). A floating grid's cell showed and edited A1 text
//          whatever the style, so one workbook showed two notations.
//
//          A local (row, col) of a floating grid IS its backing sheet's cell
//          (the window starts at the backing sheet's origin), so relative
//          references are measured from it exactly as Core measures them.
//
// THE STYLE. Core's grid state holds it, and only REFERENCE_STYLE_CHANGED
// changes it (Layout.tsx dispatches it into the state). The snapshot catches up
// on the next render, so the announcement itself is kept here until then --
// the publisher re-publishes on the event and must read the NEW style.

import { getGridStateSnapshot } from "@api/grid";
import { formulaA1ToR1C1, formulaR1C1ToA1 } from "@api/externalEdit";

export type FrReferenceStyle = "A1" | "R1C1";

let announced: FrReferenceStyle | null = null;

/** The workbook's reference style right now. */
export function frReferenceStyle(): FrReferenceStyle {
  if (announced !== null) return announced;
  return getGridStateSnapshot()?.referenceStyle === "R1C1" ? "R1C1" : "A1";
}

/** Record a REFERENCE_STYLE_CHANGED announcement (ahead of the snapshot). */
export function noteReferenceStyleAnnounced(style: unknown): void {
  announced = style === "R1C1" ? "R1C1" : style === "A1" ? "A1" : null;
}

/** Forget the announcement (uninstall, tests): the snapshot answers again. */
export function resetAnnouncedReferenceStyle(): void {
  announced = null;
}

/** What a cell SHOWS for its stored text (`formula ?? display`): R1C1 in R1C1 mode. */
export function frDisplayText(stored: string, row: number, col: number): string {
  if (frReferenceStyle() !== "R1C1" || !stored.startsWith("=")) return stored;
  return formulaA1ToR1C1(stored, row, col);
}

/** What is STORED for what an editor holds: back to A1 in R1C1 mode. */
export function frStoredText(edited: string, row: number, col: number): string {
  if (frReferenceStyle() !== "R1C1" || !edited.startsWith("=")) return edited;
  return formulaR1C1ToA1(edited, row, col);
}
