//! FILENAME: app/extensions/ModelMenu/index.ts
// PURPOSE: Model menu extension entry point.
// CONTEXT: Registers the "Model" top-level menu — the single home for every
//          Calcula-model (BI) surface. Other extensions append their items:
//            ModelEditor      -> "Model Editor..."            (order 10)
//            CubeFormulas     -> "Calculated Measures..."     (order 11)
//            BusinessIntel.   -> "Connections",
//                                "New Model Connection..."    (order 20-21)
//            BusinessIntel.   -> "PivotTable from Model..."   (order 30)
//            Reports          -> "Report from Design Query...",
//                                "Manage Reports..."          (order 31-32)
//            Distribution     -> "Publish Model as Package..." (order 50)
//          This extension only owns the menu shell and its section separators.
//          Range-based pivot tables stay under Insert > PivotTable... — the
//          Model menu is strictly for model-backed surfaces.

import type { ExtensionModule, ExtensionContext } from "@api/contract";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[ModelMenu] Activating...");

  // Register the "Model" top-level menu (order 44 = between External Data at
  // 43 and Formulas at 45). Section separators are placed via item `order`;
  // contributors slot their items into the sections listed above.
  context.ui.menus.register({
    id: "model",
    label: "Model",
    order: 44,
    items: [
      { id: "model:sep:authoring", label: "", separator: true, order: 19 },
      { id: "model:sep:connections", label: "", separator: true, order: 29 },
      { id: "model:sep:consume", label: "", separator: true, order: 49 },
    ],
  });

  console.log("[ModelMenu] Activated successfully.");
}

function deactivate(): void {
  // Menu is automatically cleaned up by the registry
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.model-menu",
    name: "Model Menu",
    version: "1.0.0",
    description:
      "Model menu consolidating Calcula-model surfaces: model editing, connections, model pivots, reports, and model distribution",
  },
  activate,
  deactivate,
};

export default extension;
