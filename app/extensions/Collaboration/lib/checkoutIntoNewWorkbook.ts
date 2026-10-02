//! FILENAME: app/extensions/Collaboration/lib/checkoutIntoNewWorkbook.ts
// PURPOSE: The remedy a refused checkout names: open the application for
//          editing in a NEW, empty workbook, where nothing it carries can
//          collide with anything (BUG-0264).
// CONTEXT: `calp_checkout` refuses, before writing anything, when the
//          application carries a macro, notebook or defined name with the same
//          identity as one the open workbook already holds -- opened there, the
//          workbook's copy would be kept and the application's dropped, and the
//          next push would publish the workbook's copy as the application's
//          (`app/src-tauri/src/checkout_collisions.rs`). The refusal starts with
//          CALP_CHECKOUT_COLLISION, and the Open for Editing dialog offers this
//          as a button beside it.
//
//          A new workbook REPLACES the open one in this window, exactly like
//          File > New, so unsaved changes are asked about first -- and the
//          question fails closed: a dialog that cannot be shown, or a Cancel,
//          leaves the workbook open and opens nothing.

import { checkoutApplication, type CheckoutParams, type CheckoutResponse } from "@api";
import { workbook } from "@api/system";
import { confirmAsync } from "@api/dialogs";

/** The prefix of the backend's collision refusal (`CHECKOUT_COLLISION_CODE`). */
export const CHECKOUT_COLLISION_CODE = "CALP_CHECKOUT_COLLISION";

/** Is this checkout error the collision refusal, whose remedy is a new workbook? */
export function isCheckoutCollisionRefusal(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes(CHECKOUT_COLLISION_CODE);
}

/** The question asked when the open workbook has unsaved changes. */
export const UNSAVED_CHANGES_QUESTION =
  "This workbook has unsaved changes. Opening the application in a new workbook closes this one " +
  "without saving it -- save it first if you want to keep them.\n\n" +
  "Open the application in a new workbook anyway?";

/**
 * Start a new, empty workbook and open the application for editing in it.
 * Resolves to `null` when the user chose to keep the open workbook (nothing
 * was changed); throws what the checkout throws.
 */
export async function checkoutIntoNewWorkbook(params: CheckoutParams): Promise<CheckoutResponse | null> {
  if (await workbook.isModified()) {
    // AWAITED: the Tauri confirm is a Promise, and `!promise` is always false.
    const proceed = await confirmAsync(UNSAVED_CHANGES_QUESTION, {
      title: "Unsaved changes",
      kind: "warning",
    });
    if (!proceed) return null;
  }
  await workbook.new();
  return checkoutApplication(params);
}
