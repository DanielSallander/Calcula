//! FILENAME: app/extensions/Protection/handlers/editGuardHandler.ts
// PURPOSE: Edit guard that blocks cell editing on protected sheets for locked cells.
// CONTEXT: Registered via registerCommitGuard() (see ../index.ts) — NOT
// registerEditGuard, despite this file's original comment. Checks canEditCell()
// before a cell commit is applied.

import {
  canEditCell,
  showDialog,
  type EditGuardResult,
} from "@api";
import { isCurrentSheetProtected } from "../lib/protectionStore";

/** Dialog ID for the protection warning modal. */
export const PROTECTION_WARNING_DIALOG_ID = "protection-warning";

/**
 * Edit guard function for sheet protection.
 * Called by the core useEditing hook before allowing cell editing.
 *
 * Returns `{ blocked: true, message }` to prevent editing.
 * Returns `null` to allow editing (or let the next guard decide).
 */
export async function protectionEditGuard(
  row: number,
  col: number
): Promise<EditGuardResult | null> {
  // Fast path: if sheet is not protected, skip backend call
  if (!isCurrentSheetProtected()) {
    return null;
  }

  try {
    const result = await canEditCell(row, col);

    if (!result.canEdit) {
      const message = result.reason ||
        "The cell or chart you are trying to change is on a protected sheet. " +
        "To make a change, unprotect the sheet. You might be requested to enter a password.";

      // Show the warning dialog
      showDialog(PROTECTION_WARNING_DIALOG_ID, { message });

      return { blocked: true, message };
    }
  } catch (error) {
    console.error("[Protection] Edit guard error:", error);
    // Fail CLOSED. We only reach this branch when the cached flag already says
    // the sheet IS protected — we merely could not determine this cell's
    // status. Allowing the edit would turn any transient backend error into a
    // silent bypass of the only enforcement point sheet protection has.
    const message =
      "Could not verify sheet protection for this cell, so the edit was blocked. " +
      "Unprotect the sheet to edit it.";
    showDialog(PROTECTION_WARNING_DIALOG_ID, { message });
    return { blocked: true, message };
  }

  return null;
}
