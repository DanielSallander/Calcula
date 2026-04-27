//! FILENAME: app/extensions/FilterPane/index.ts
// PURPOSE: Filter Pane extension entry point — activation and deactivation.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { ExtensionRegistry } from "@api";
import {
  FilterPaneManifest,
  FilterPaneTabDefinition,
  AddFilterDialogDefinition,
  FILTER_PANE_TAB_ID,
} from "./manifest";
import { refreshCache, clearCache } from "./lib/filterPaneStore";

// ============================================================================
// Extension Module
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[FilterPane Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn({
    id: FilterPaneManifest.id,
    name: FilterPaneManifest.name,
    version: FilterPaneManifest.version,
    description: FilterPaneManifest.description,
  });

  // Register the permanent ribbon tab (always visible)
  ExtensionRegistry.registerRibbonTab(FilterPaneTabDefinition);

  // Register dialogs
  context.ui.dialogs.register(AddFilterDialogDefinition);

  // Refresh cache on sheet change
  const handleSheetChange = () => {
    refreshCache();
  };
  window.addEventListener("sheet:activated", handleSheetChange);

  // Initial cache load
  refreshCache();

  console.log("[FilterPane Extension] Registered.");
}

function deactivate(): void {
  console.log("[FilterPane Extension] Deactivating...");
  ExtensionRegistry.unregisterRibbonTab(FILTER_PANE_TAB_ID);
  clearCache();
}

const FilterPaneExtension: ExtensionModule = {
  manifest: FilterPaneManifest,
  activate,
  deactivate,
};

export default FilterPaneExtension;
