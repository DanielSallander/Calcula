//! FILENAME: app/src/shell/SheetTabs/sheetDeletePolicy.ts
// PURPOSE: Whether deleting a sheet asks first. Excel deletes a BLANK sheet
//          without a word and asks ("Microsoft Excel will permanently delete
//          this sheet. Do you want to continue?") about one that holds
//          anything; Calcula asked about every sheet.
// CONTEXT: Deleting a sheet ENDS the undo history (BUG-0005, Excel parity) and
//          cannot be taken back, so the two ways of being wrong are not equal:
//          "blank" when it was not is unrecoverable loss, "has something" when
//          it had nothing is one extra click. Every doubt answers "ask":
//            - a canvas (it IS its objects, which hold no cells);
//            - a sheet that is not the active one: its floating objects
//              (charts, shapes, slicers, controls) register as grid regions
//              only while their sheet is showing, so the backend's answer is
//              all that can be known about it, and that is not "nothing";
//            - a read that failed, or an answer that is not a boolean.
//          "Blank" is the BACKEND's answer (`sheet_is_blank`, through @api/lib's
//          isSheetBlank), asked of EVERY sheet-keyed store: cells and formats,
//          sizes, merges, notes, comments, hyperlinks, validation, conditional
//          formats, filters, tables, sheet-scoped names, protection, the print
//          area and the objects placed on it. This rule used to read
//          `get_used_range`, which sees cells only, so a sheet holding just a
//          note, a whole-number validation rule or a highlight-cells CF rule
//          was deleted without a question and without undo (review finding,
//          2026-10-04). One backend answer cannot miss a store added later the
//          way a list of front-end reads would. The registered grid regions
//          are still consulted as well: an object of the active sheet that
//          lives in a front-end store answers "ask" even if the backend does
//          not know it.

import { isSheetBlank } from "../../api/lib";
import { getGridRegions } from "../../api/gridOverlays";

/** What the rule needs to know; null = could not be told. */
export interface DeleteConfirmationFacts {
  kind?: "worksheet" | "canvas";
  /** The sheet is the one on screen (its objects are registered). */
  isActive: boolean;
  /** The backend found nothing in any sheet-keyed store (`sheet_is_blank`). */
  sheetBlank: boolean | null;
  /** Grid regions registered for the active sheet (objects, pivots, tables). */
  objectCount: number | null;
}

/** The rule: delete without asking ONLY a provably blank active worksheet. */
export function deleteNeedsConfirmation(facts: DeleteConfirmationFacts): boolean {
  if (facts.kind === "canvas") return true;
  if (!facts.isActive) return true;
  if (facts.sheetBlank !== true) return true;
  if (facts.objectCount === null || facts.objectCount > 0) return true;
  return false;
}

/**
 * Read the facts for one sheet and apply the rule. Never throws: a failed
 * read is an unknown, and an unknown asks.
 */
export async function sheetDeleteNeedsConfirmation(
  sheet: { index: number; kind?: "worksheet" | "canvas" },
  isActive: boolean,
): Promise<boolean> {
  if (sheet.kind === "canvas" || !isActive) {
    return deleteNeedsConfirmation({ kind: sheet.kind, isActive, sheetBlank: null, objectCount: null });
  }
  let sheetBlank: boolean | null = null;
  try {
    const answer: unknown = await isSheetBlank(sheet.index);
    // Only a real boolean is an answer; anything else is a doubt, and asks.
    sheetBlank = typeof answer === "boolean" ? answer : null;
  } catch (err) {
    console.warn("[SheetTabs] could not ask whether the sheet is blank; asking before the delete:", err);
  }
  let objectCount: number | null = null;
  try {
    objectCount = getGridRegions().length;
  } catch (err) {
    console.warn("[SheetTabs] could not read the sheet's objects; asking before the delete:", err);
  }
  return deleteNeedsConfirmation({ kind: sheet.kind, isActive, sheetBlank, objectCount });
}
