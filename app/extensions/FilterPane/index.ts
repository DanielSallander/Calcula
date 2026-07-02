//! FILENAME: app/extensions/FilterPane/index.ts
// PURPOSE: Filter Pane extension entry point — activation and deactivation.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { registerPanel, unregisterPanel } from "@api/ui";
import {
  FilterPaneManifest,
  FilterPanePanelDefinition,
  AddFilterDialogDefinition,
  FILTER_PANE_TAB_ID,
} from "./manifest";
import { refreshCache, clearCache } from "./lib/filterPaneStore";
import { registerFilterBadge } from "./lib/filterBadge";
import { filterPaneBackend } from "./lib/filterPaneBackend";

let unregisterBadge: (() => void) | null = null;

// ============================================================================
// Extension Module
// ============================================================================

function activate(context: ExtensionContext): void {
  // Bind the capability-scoped backend door before any code can trigger a backend call.
  filterPaneBackend.set(context.invokeBackend);

  console.log("[FilterPane Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn({
    id: FilterPaneManifest.id,
    name: FilterPaneManifest.name,
    version: FilterPaneManifest.version,
    description: FilterPaneManifest.description,
  });

  // Register the permanent "Filters" panel (ribbon-placed by default)
  registerPanel(FilterPanePanelDefinition);

  // Register dialogs
  context.ui.dialogs.register(AddFilterDialogDefinition);

  // Refresh cache on sheet change
  const handleSheetChange = () => {
    refreshCache();
  };
  window.addEventListener("sheet:activated", handleSheetChange);

  // Track applied filters and show count badge on the Filters tab
  unregisterBadge = registerFilterBadge();

  // Initial cache load
  refreshCache();

  console.log("[FilterPane Extension] Registered.");
}

function deactivate(): void {
  console.log("[FilterPane Extension] Deactivating...");
  unregisterBadge?.();
  unregisterBadge = null;
  unregisterPanel(FILTER_PANE_TAB_ID);
  clearCache();
}

const FilterPaneExtension: ExtensionModule = {
  manifest: FilterPaneManifest,
  activate,
  deactivate,
};

export default FilterPaneExtension;
