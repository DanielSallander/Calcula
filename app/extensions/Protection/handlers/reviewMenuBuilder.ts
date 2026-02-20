//! FILENAME: app/extensions/Protection/handlers/reviewMenuBuilder.ts
// PURPOSE: Register the "Review" menu with protection-related actions.
// CONTEXT: Adds Protect Sheet, Protect Workbook, Cell Protection menu items.

import {
  registerMenu,
  showDialog,
  hideDialog,
  unprotectSheet,
} from "../../../src/api";
import type { MenuDefinition } from "../../../src/api";
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
        refreshMenu();
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
  showDialog(CELL_PROTECTION_DIALOG_ID, {});
}

// ============================================================================
// Menu Registration
// ============================================================================

function buildReviewMenu(): MenuDefinition {
  const sheetProtected = isCurrentSheetProtected();
  const workbookProtected = isCurrentWorkbookProtected();

  return {
    id: "review",
    label: "Review",
    order: 70,
    items: [
      {
        id: "review:protectSheet",
        label: sheetProtected ? "Unprotect Sheet" : "Protect Sheet...",
        action: toggleProtectSheet,
      },
      {
        id: "review:protectWorkbook",
        label: workbookProtected ? "Unprotect Workbook" : "Protect Workbook...",
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
        action: openCellProtectionDialog,
      },
    ],
  };
}

/** Register the Review menu. */
export function registerReviewMenu(): void {
  registerMenu(buildReviewMenu());
}

/** Refresh the Review menu (e.g., after protect/unprotect changes labels). */
export function refreshMenu(): void {
  registerMenu(buildReviewMenu());
}
