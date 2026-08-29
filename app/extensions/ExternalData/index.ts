//! FILENAME: app/extensions/ExternalData/index.ts
// PURPOSE: External Data extension entry point.
// CONTEXT: Registers the "External Data" top-level menu — import/export and
//          data connections only. Other extensions append items to it:
//          CsvImportExport ("Get Data") and Distribution ("Refresh Data").
//          Model-specific surfaces live in the "Model" menu (ModelMenu ext);
//          .calp packaging and writeback are their own top-level menus
//          ("Distribution" order 46, "Writeback" order 47, both owned by the
//          Distribution extension) rather than a submenu here.

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
