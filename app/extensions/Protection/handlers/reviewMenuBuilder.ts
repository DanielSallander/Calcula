//! FILENAME: app/extensions/Protection/handlers/reviewMenuBuilder.ts
// PURPOSE: Register the "Review" menu with protection-related actions.
// CONTEXT: Adds Protect Sheet, Protect Workbook, Cell Protection menu items.

import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  unprotectSheet,
  unregisterMenu,
  IconProtectSheet,
  IconProtectWorkbook,
  IconCellProtection,
} from "@api";
import type { MenuDefinition } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import {
  isCurrentSheetProtected,
  currentSheetHasPassword,
  isCurrentWorkbookProtected,
  refreshProtectionState,
} from "../lib/protectionStore";

// ============================================================================
// Dialog IDs (must match index.ts registrations)
// ============================================================================

const PROTECT_SHEET_DIALOG_ID = "protect-sheet-dialog";
const UNPROTECT_SHEET_DIALOG_ID = "unprotect-sheet-dialog";
const PROTECT_WORKBOOK_DIALOG_ID = "protect-workbook-dialog";
const UNPROTECT_WORKBOOK_DIALOG_ID = "unprotect-workbook-dialog";
const CELL_PROTECTION_DIALOG_ID = "cell-protection-dialog";

// ============================================================================
// Menu Actions
// ============================================================================

const REVIEW_MENU_ID = "review";

/** The context while the Review menu is registered; null once it was taken
 *  back, which is what stops a late refresh from building it again. */
let _context: ExtensionContext | null = null;

async function toggleProtectSheet(): Promise<void> {
  if (isCurrentSheetProtected()) {
    // Sheet is protected - unprotect
    if (currentSheetHasPassword()) {
      // Has password - show unprotect dialog
      showDialog(UNPROTECT_SHEET_DIALOG_ID, {});
    } else {
      // No password - unprotect directly
      const result = await unprotectSheet();
      if (result.success) {
        await refreshProtectionState();
        if (_context) {
          refreshMenu(_context);
        }
      }
    }
  } else {
    // Sheet is not protected - show protect dialog
    showDialog(PROTECT_SHEET_DIALOG_ID, {});
  }
}

function toggleProtectWorkbook(): void {
  if (isCurrentWorkbookProtected()) {
    showDialog(UNPROTECT_WORKBOOK_DIALOG_ID, {});
  } else {
    showDialog(PROTECT_WORKBOOK_DIALOG_ID, {});
  }
}

function openCellProtectionDialog(): void {
  // The dialog reads and writes the Locked / Hidden flags of Core's selection
  // -- HIDDEN while something else owns the selection (a floating grid's
  // selected cell) -- so refuse, once (D4, BUG-0185 class).
  if (refuseIfSelectionOwned("Cell Protection")) return;
  showDialog(CELL_PROTECTION_DIALOG_ID, {});
}

// ============================================================================
// Menu Registration
// ============================================================================

function buildReviewMenu(): MenuDefinition {
  const sheetProtected = isCurrentSheetProtected();
  const workbookProtected = isCurrentWorkbookProtected();

  return {
    id: REVIEW_MENU_ID,
    label: "Review",
    order: 70,
    items: [
      {
        id: "review:protectSheet",
        label: sheetProtected ? "Unprotect Sheet" : "Protect Sheet...",
        icon: IconProtectSheet,
        action: toggleProtectSheet,
      },
      {
        id: "review:protectWorkbook",
        label: workbookProtected ? "Unprotect Workbook" : "Protect Workbook...",
        icon: IconProtectWorkbook,
        action: toggleProtectWorkbook,
      },
      {
        id: "review:sep1",
        label: "",
        separator: true,
      },
      {
        id: "review:cellProtection",
        label: "Cell Protection...",
        icon: IconCellProtection,
        action: openCellProtectionDialog,
      },
    ],
  };
}

/**
 * Register the Review menu. Returns the cleanup for deactivation (X19): it
 * takes back Protection's own items, and the menu with them unless another
 * extension still has items in it -- Comments and Notes (the Review
 * extension) add theirs, and must keep them while it is active.
 */
export function registerReviewMenu(context: ExtensionContext): () => void {
  _context = context;
  context.ui.menus.register(buildReviewMenu());
  return () => {
    _context = null;
    unregisterMenu(REVIEW_MENU_ID, { keepWhileShared: true });
  };
}

/**
 * Refresh the Review menu (e.g., after protect/unprotect changes labels).
 * Does nothing once the menu was taken back: a protection refresh still in
 * flight at deactivate resolves AFTER it, and must not build the menu again.
 */
export function refreshMenu(context: ExtensionContext): void {
  if (_context === null) return;
  _context = context;
  context.ui.menus.register(buildReviewMenu());
}
