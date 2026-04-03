//! FILENAME: app/extensions/Protection/index.ts
// PURPOSE: Protection extension entry point. ExtensionModule lifecycle.
// CONTEXT: Activated by the shell during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  hideDialog,
} from "@api";
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
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Protection] Already activated, skipping.");
    return;
  }

  console.log("[Protection] Activating...");

  // 1. Register edit guard (blocks editing locked cells on protected sheets)
  const unregEditGuard = context.grid.editGuards.register(protectionEditGuard);
  cleanupFns.push(unregEditGuard);

  // 2. Register dialogs
  context.ui.dialogs.register({
    id: PROTECTION_WARNING_DIALOG_ID,
    component: ProtectionWarningModal,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(PROTECTION_WARNING_DIALOG_ID));

  context.ui.dialogs.register({
    id: PROTECT_SHEET_DIALOG_ID,
    component: ProtectSheetDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(PROTECT_SHEET_DIALOG_ID));

  context.ui.dialogs.register({
    id: UNPROTECT_SHEET_DIALOG_ID,
    component: UnprotectSheetDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(UNPROTECT_SHEET_DIALOG_ID));

  context.ui.dialogs.register({
    id: PROTECT_WORKBOOK_DIALOG_ID,
    component: ProtectWorkbookDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(PROTECT_WORKBOOK_DIALOG_ID));

  context.ui.dialogs.register({
    id: UNPROTECT_WORKBOOK_DIALOG_ID,
    component: UnprotectWorkbookDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(UNPROTECT_WORKBOOK_DIALOG_ID));

  context.ui.dialogs.register({
    id: CELL_PROTECTION_DIALOG_ID,
    component: CellProtectionDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CELL_PROTECTION_DIALOG_ID));

  // 3. Register "Review" menu with protection items
  registerReviewMenu(context);

  // 4. Register sheet tab context menu modifications for workbook protection
  registerSheetTabProtection();

  // 5. Subscribe to events

  // Sheet changed: refresh protection state and update menu labels
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, async () => {
    await refreshProtectionState();
    refreshMenu(context);
  });
  cleanupFns.push(unsubSheet);

  // 6. Load initial protection state
  refreshProtectionState().then(() => {
    refreshMenu(context);
  });

  isActivated = true;
  console.log("[Protection] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Protection] Deactivating...");

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

  isActivated = false;
  console.log("[Protection] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.protection",
    name: "Protection",
    version: "1.0.0",
    description: "Sheet and workbook protection with password support, cell locking, and edit guards.",
  },
  activate,
  deactivate,
};

export default extension;
