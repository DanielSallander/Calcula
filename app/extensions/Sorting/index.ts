//! FILENAME: app/extensions/Sorting/index.ts
// PURPOSE: Sorting extension entry point.
// CONTEXT: Registers the Sort dialog, Excel's Sort Warning, the sort commands
//          (sort.ascending / sort.descending / sort.customDialog -- the Home
//          tab's Sort & Filter menu and the Data menu run the same ids) and the
//          Data menu items. Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { SortDialog } from "./components/SortDialog";
import { SortWarningDialog } from "./components/SortWarningDialog";
import { registerSortMenuItems } from "./handlers/dataMenuBuilder";
import { registerSortCommands, SORT_DIALOG_ID } from "./lib/sortCommands";
import { SORT_WARNING_DIALOG_ID } from "./lib/sortWarning";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Sorting] Activating...");

  // 1. Register dialogs
  context.ui.dialogs.register({
    id: SORT_DIALOG_ID,
    component: SortDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(SORT_DIALOG_ID));

  // Above the Sort dialog: Custom Sort asks it BEFORE that dialog opens.
  context.ui.dialogs.register({
    id: SORT_WARNING_DIALOG_ID,
    component: SortWarningDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(SORT_WARNING_DIALOG_ID));

  // 2. The commands every door runs
  cleanupFns.push(registerSortCommands(context.commands));

  // 3. Register menu items in Data menu
  cleanupFns.push(registerSortMenuItems(context));

  console.log("[Sorting] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Sorting] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Sorting] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Sorting] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.sorting",
    name: "Sorting",
    version: "1.0.0",
    description: "Sort data by columns with quick sort and custom multi-level sort dialog.",
  },
  activate,
  deactivate,
};

export default extension;
