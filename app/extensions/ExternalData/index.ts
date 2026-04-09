//! FILENAME: app/extensions/ExternalData/index.ts
// PURPOSE: External Data extension entry point.
// CONTEXT: Registers the "External Data" top-level menu.
//          Other extensions (CsvImportExport, BI) append items to it.

import type { ExtensionModule, ExtensionContext } from "@api/contract";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[ExternalData] Activating...");

  // Register the "External Data" top-level menu (order 43 = right after Data at 42)
  context.ui.menus.register({
    id: "externalData",
    label: "External Data",
    order: 43,
    items: [],
  });

  console.log("[ExternalData] Activated successfully.");
}

function deactivate(): void {
  // Menu is automatically cleaned up by the registry
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.external-data",
    name: "External Data",
    version: "1.0.0",
    description: "External Data menu for import/export and data connections",
  },
  activate,
  deactivate,
};

export default extension;
