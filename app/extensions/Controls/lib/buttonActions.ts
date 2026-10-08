//! FILENAME: app/extensions/Controls/lib/buttonActions.ts
// PURPOSE: What a button's DECLARATIVE action does when the button is clicked
//          (Canvas contract §3/§4.4): go to a page, go back, clear the page's
//          slicers -- Power BI's report-button actions, as properties rather
//          than code (@api/buttonControlService "Declarative actions").
// CONTEXT: The click route (index.ts `handleButtonPress`) asks
//          `tryStoredButtonAction` FIRST: a button whose action the floating
//          store knows performs it here and never reaches the script door
//          (`run_control_action`). That is deliberate and is the whole reason
//          the action is a property: the door is gated by Script Security, and
//          a report reader's navigation button must work with scripting off and
//          on a subscribed (read-only) canvas, where Core still hands a
//          run-mode button's press to `floatingObject:bodyDragStart` ("reading
//          the report is not editing it", overlayMoveHandlers.ts).
//
//          Each action goes through the seam that OWNS it (the Seam Rule):
//          the switch is @api/sheetSwitch's (the same step-for-step switch a
//          tab click makes), the trail is @api/sheetHistory's, and the slicers
//          are their families' (@api/slicerClearService) -- clearing a slicer
//          by its backend id would leave every pivot it filters filtered.
//
//          Every outcome a reader cannot see for themselves is SAID: a page
//          that is gone or hidden, nothing to go back to, slicers that could
//          not be cleared. A click on a navigation button that does nothing and
//          says nothing is indistinguishable from a broken report.

import { getSheets } from "@api/lib";
import { activateSheet } from "@api/sheetSwitch";
import { goBackSheet } from "@api/sheetHistory";
import { clearSlicersOnSheet } from "@api/slicerClearService";
import { showToast } from "@api/notifications";
import type { ButtonAction } from "@api/buttonControlService";
import { getFloatingControl } from "./floatingStore";

export { buttonActionOfControl } from "./buttonActionOfControl";

/** A sheet as `getSheets` lists it, for the resolution below. */
interface PageRow {
  index: number;
  name: string;
  visibility?: string;
  sheetId?: string;
}

/**
 * The page a navigate action means, in THIS workbook: the sheet with its
 * stable id when one has it; otherwise the sheet with its name (a subscriber's
 * sheet ids are its own -- a pull remaps them and keeps the names), exactly
 * first, then ignoring case as sheet names do.
 */
export function resolveNavigateTarget(
  action: Extract<ButtonAction, { kind: "navigate" }>,
  sheets: readonly PageRow[],
): PageRow | null {
  if (action.sheetId) {
    const byId = sheets.find((s) => s.sheetId === action.sheetId);
    if (byId) return byId;
  }
  const exact = sheets.find((s) => s.name === action.sheetName);
  if (exact) return exact;
  const folded = action.sheetName.toLocaleLowerCase();
  return sheets.find((s) => s.name.toLocaleLowerCase() === folded) ?? null;
}

/**
 * Perform `action` for a button on the sheet `buttonSheetIndex`. Never
 * throws: every failure is a toast.
 */
export async function performButtonAction(action: ButtonAction, buttonSheetIndex: number): Promise<void> {
  try {
    switch (action.kind) {
      case "navigate": {
        const { sheets, activeIndex } = await getSheets();
        const target = resolveNavigateTarget(action, sheets as PageRow[]);
        if (!target) {
          showToast(
            `The page "${action.sheetName}" this button goes to is not in this workbook any more. ` +
              "Choose another page in the button's Properties (Action).",
            { variant: "warning" },
          );
          return;
        }
        if ((target.visibility ?? "visible") !== "visible") {
          showToast(`The page "${target.name}" this button goes to is hidden, so the button cannot open it.`, {
            variant: "info",
          });
          return;
        }
        // A page navigator carries a button for the page it sits on: a click
        // there is already where it goes.
        if (target.index === activeIndex) return;
        await activateSheet(target.index);
        return;
      }
      case "back": {
        const outcome = await goBackSheet();
        if (!outcome.moved) {
          showToast("There is no previous page to go back to.", { variant: "info" });
        }
        return;
      }
      case "clearSlicers": {
        try {
          await clearSlicersOnSheet(buttonSheetIndex);
        } catch (err) {
          showToast(`The slicers could not be cleared: ${err instanceof Error ? err.message : String(err)}`, {
            variant: "error",
          });
        }
        return;
      }
    }
  } catch (err) {
    showToast(`The button's action failed: ${err instanceof Error ? err.message : String(err)}`, {
      variant: "error",
    });
  }
}

/**
 * The run-mode click's first question: does the floating store know an action
 * for this button? If so, perform it (fire-and-forget; it says its own
 * failures) and answer true -- the caller must NOT ask the script door. False
 * means "no action here": the door decides, as it always did.
 */
export function tryStoredButtonAction(controlId: string, sheetIndex: number): boolean {
  const action = getFloatingControl(controlId)?.buttonAction;
  if (!action) return false;
  void performButtonAction(action, sheetIndex);
  return true;
}
