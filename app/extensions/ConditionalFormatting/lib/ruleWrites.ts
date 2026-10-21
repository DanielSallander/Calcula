//! FILENAME: app/extensions/ConditionalFormatting/lib/ruleWrites.ts
// PURPOSE: The two writes every Conditional Formatting door makes -- add a rule,
//          clear rules from a range -- with the backend's refusal TURNED INTO
//          WORDS instead of a promise nobody handles.
// CONTEXT: The menu awaited `addConditionalFormat` with no catch and the
//          galleries called it fire-and-forget, so a refusal (a protected
//          sheet, an invalid range, a backend that went away) became an
//          unhandled rejection: nothing on screen, an error in the console, and
//          the rules cache still refreshed as if the rule were there. The
//          backend also answers `{ success: false, error }` without throwing,
//          which the callers never read. Both shapes are a refusal here, and a
//          refusal is said once, in a toast, and refreshes nothing.
//
//          The clear returns the backend's COUNT. The handler used to drop it,
//          so "Clear Rules from Selected Cells" over cells whose rule it did not
//          remove did nothing and said nothing; the callers now say so when the
//          count is 0. (Which rules the backend removes -- whole rules inside
//          the range only, or Excel's cut of every overlapping rule -- is the
//          backend's business; a 0 is a 0 either way.)
//
//          P3 (owner finding G3): every write takes an optional cell TARGET --
//          a floating grid's cells. The rule then lives on the object's
//          backing sheet, its ranges in the object's coordinates; the sheet's
//          rules cache is not the object's, so the object is re-read through
//          grid:refresh instead.

import {
  addConditionalFormat,
  clearConditionalFormatsInRange,
  showToast,
} from "@api";
import type { AddCFParams, ConditionalFormatRange } from "@api";
import type { CellTargetRef } from "@api/cellTarget";
import { invalidateAndRefresh } from "./cfStore";

/** The words of a thrown value: an Error's message, a string as-is. */
export function reasonOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "the backend refused it";
}

/** Re-read the rules after a write; a failed re-read is logged, never thrown
 *  (the write itself has already happened). */
export async function refreshAfterWrite(target?: CellTargetRef): Promise<void> {
  if (target) {
    // An object's rules: it re-reads its cells (and their CF) on grid:refresh.
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    return;
  }
  try {
    await invalidateAndRefresh();
  } catch (err) {
    console.error("[ConditionalFormatting] refresh after a write failed:", err);
  }
}

/**
 * Add a rule. Resolves the backend's reason when it refused (a throw or
 * `success: false`), else null -- and NEVER rejects, so a fire-and-forget
 * caller (a gallery pick) cannot leak an unhandled rejection. The caller
 * decides how to show the reason (a toast from a menu, an inline alert in a
 * dialog that stays open).
 */
export async function tryAddRule(params: AddCFParams, target?: CellTargetRef): Promise<string | null> {
  try {
    const result = await addConditionalFormat(params, { target });
    if (result && result.success === false) {
      return result.error || "the backend refused the rule";
    }
  } catch (err) {
    return reasonOf(err);
  }
  await refreshAfterWrite(target);
  return null;
}

/** Add a rule from a menu or a gallery: a refusal is one error toast. */
export async function addRuleReporting(params: AddCFParams, target?: CellTargetRef): Promise<boolean> {
  const refused = await tryAddRule(params, target);
  if (refused !== null) {
    showToast(`Conditional Formatting: the rule was not added -- ${refused}`, { variant: "error" });
    return false;
  }
  return true;
}

/**
 * Clear every rule the backend removes from `range`. Resolves the count
 * removed, or null after a refusal (already reported as one error toast).
 * Never rejects.
 */
export async function clearRulesReporting(
  range: ConditionalFormatRange,
  target?: CellTargetRef,
): Promise<number | null> {
  let removed: unknown;
  try {
    removed = await clearConditionalFormatsInRange(
      range.startRow,
      range.startCol,
      range.endRow,
      range.endCol,
      undefined,
      { target },
    );
  } catch (err) {
    showToast(`Clear Rules: the rules were not cleared -- ${reasonOf(err)}`, { variant: "error" });
    return null;
  }
  await refreshAfterWrite(target);
  return typeof removed === "number" ? removed : null;
}
