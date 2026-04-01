//! FILENAME: app/extensions/CsvImportExport/index.ts
// PURPOSE: CSV Import/Export extension entry point.
// CONTEXT: Registers import/export dialogs and Data menu items.
//          Called from extensions/index.ts during app initialization.

import { DialogExtensions } from "../../src/api";
import { CsvImportDialog } from "./components/CsvImportDialog";
import { CsvExportDialog } from "./components/CsvExportDialog";
import { registerCsvMenuItems } from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerCsvImportExportExtension(): void {
  console.log("[CsvImportExport] Registering...");

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

  console.log("[CsvImportExport] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterCsvImportExportExtension(): void {
  console.log("[CsvImportExport] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CsvImportExport] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[CsvImportExport] Unregistered.");
}
