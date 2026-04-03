//! FILENAME: app/extensions/CsvImportExport/index.ts
// PURPOSE: CSV Import/Export extension entry point.
// CONTEXT: Registers import/export dialogs and Data menu items.
//          Called from extensions/index.ts during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { DialogExtensions } from "@api";
import { CsvImportDialog } from "./components/CsvImportDialog";
import { CsvExportDialog } from "./components/CsvExportDialog";
import { registerCsvMenuItems } from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[CsvImportExport] Activating...");

  // 1. Register dialogs
  DialogExtensions.registerDialog({
    id: "csv-import",
    component: CsvImportDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("csv-import"));

  DialogExtensions.registerDialog({
    id: "csv-export",
    component: CsvExportDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("csv-export"));

  // 2. Register menu items in Data menu
  registerCsvMenuItems();

  console.log("[CsvImportExport] Activated successfully.");
}

function deactivate(): void {
  console.log("[CsvImportExport] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CsvImportExport] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[CsvImportExport] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.csv-import-export",
    name: "CSV Import/Export",
    version: "1.0.0",
    description: "Import and export data in CSV format.",
  },
  activate,
  deactivate,
};
export default extension;
