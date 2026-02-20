//! FILENAME: app/extensions/Protection/index.ts
// PURPOSE: Protection extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerEditGuard,
  registerDialog,
  unregisterDialog,
  onAppEvent,
  AppEvents,
  hideDialog,
} from "../../src/api";
import { protectionEditGuard, PROTECTION_WARNING_DIALOG_ID } from "./handlers/editGuardHandler";
import { ProtectionWarningModal } from "./components/ProtectionWarningModal";
import { ProtectSheetDialog } from "./components/ProtectSheetDialog";
import { UnprotectSheetDialog } from "./components/UnprotectSheetDialog";
import { ProtectWorkbookDialog } from "./components/ProtectWorkbookDialog";
import { UnprotectWorkbookDialog } from "./components/UnprotectWorkbookDialog";
import { CellProtectionDialog } from "./components/CellProtectionDialog";
import { registerReviewMenu, refreshMenu } from "./handlers/reviewMenuBuilder";
import { registerSheetTabProtection } from "./handlers/sheetTabGuard";
import {
  refreshProtectionState,
  resetProtectionState,
} from "./lib/protectionStore";

// ============================================================================
// Dialog IDs
// ============================================================================

const PROTECT_SHEET_DIALOG_ID = "protect-sheet-dialog";
const UNPROTECT_SHEET_DIALOG_ID = "unprotect-sheet-dialog";
const PROTECT_WORKBOOK_DIALOG_ID = "protect-workbook-dialog";
const UNPROTECT_WORKBOOK_DIALOG_ID = "unprotect-workbook-dialog";
const CELL_PROTECTION_DIALOG_ID = "cell-protection-dialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerProtectionExtension(): void {
  console.log("[Protection] Registering...");

  // 1. Register edit guard (blocks editing locked cells on protected sheets)
  const unregEditGuard = registerEditGuard(protectionEditGuard);
  cleanupFns.push(unregEditGuard);

  // 2. Register dialogs
  registerDialog({
    id: PROTECTION_WARNING_DIALOG_ID,
    component: ProtectionWarningModal,
    priority: 100,
  });
  cleanupFns.push(() => unregisterDialog(PROTECTION_WARNING_DIALOG_ID));

  registerDialog({
    id: PROTECT_SHEET_DIALOG_ID,
    component: ProtectSheetDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(PROTECT_SHEET_DIALOG_ID));

  registerDialog({
    id: UNPROTECT_SHEET_DIALOG_ID,
    component: UnprotectSheetDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(UNPROTECT_SHEET_DIALOG_ID));

  registerDialog({
    id: PROTECT_WORKBOOK_DIALOG_ID,
    component: ProtectWorkbookDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(PROTECT_WORKBOOK_DIALOG_ID));

  registerDialog({
    id: UNPROTECT_WORKBOOK_DIALOG_ID,
    component: UnprotectWorkbookDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(UNPROTECT_WORKBOOK_DIALOG_ID));

  registerDialog({
    id: CELL_PROTECTION_DIALOG_ID,
    component: CellProtectionDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(CELL_PROTECTION_DIALOG_ID));

  // 3. Register "Review" menu with protection items
  registerReviewMenu();

  // 4. Register sheet tab context menu modifications for workbook protection
  registerSheetTabProtection();

  // 5. Subscribe to events

  // Sheet changed: refresh protection state and update menu labels
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, async () => {
    await refreshProtectionState();
    refreshMenu();
  });
  cleanupFns.push(unsubSheet);

  // 6. Load initial protection state
  refreshProtectionState().then(() => {
    refreshMenu();
  });

  console.log("[Protection] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterProtectionExtension(): void {
  console.log("[Protection] Unregistering...");

  // Close all dialogs
  hideDialog(PROTECTION_WARNING_DIALOG_ID);
  hideDialog(PROTECT_SHEET_DIALOG_ID);
  hideDialog(UNPROTECT_SHEET_DIALOG_ID);
  hideDialog(PROTECT_WORKBOOK_DIALOG_ID);
  hideDialog(UNPROTECT_WORKBOOK_DIALOG_ID);
  hideDialog(CELL_PROTECTION_DIALOG_ID);

  // Run cleanup functions
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Protection] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  // Reset state
  resetProtectionState();

  console.log("[Protection] Unregistered.");
}
