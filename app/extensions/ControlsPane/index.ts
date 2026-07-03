//! FILENAME: app/extensions/ControlsPane/index.ts
// PURPOSE: Controls pane extension entry point — activation and deactivation.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { registerPanel, unregisterPanel } from "@api/ui";
import {
  ControlsPaneManifest,
  ControlsPanePanelDefinition,
  AddFilterDialogDefinition,
  CONTROLS_PANE_TAB_ID,
} from "./manifest";
import { refreshCache, clearCache } from "./lib/filterPaneStore";
import { registerFilterBadge } from "./lib/filterBadge";
import { filterPaneBackend } from "./lib/filterPaneBackend";

let unregisterBadge: (() => void) | null = null;
let removeWindowListeners: (() => void) | null = null;

// ============================================================================
// Extension Module
// ============================================================================

function activate(context: ExtensionContext): void {
  // Bind the capability-scoped backend door before any code can trigger a backend call.
  filterPaneBackend.set(context.invokeBackend);

  console.log("[ControlsPane Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn({
    id: ControlsPaneManifest.id,
    name: ControlsPaneManifest.name,
    version: ControlsPaneManifest.version,
    description: ControlsPaneManifest.description,
  });

  // Register the permanent "Controls" panel (ribbon-placed by default)
  registerPanel(ControlsPanePanelDefinition);

  // Register dialogs
  context.ui.dialogs.register(AddFilterDialogDefinition);

  // Refresh cache on sheet change, and after undo/redo restores ribbon-filter
  // state (the shell fans the ribbonFilter mutation domain out as
  // "filterpane:filters-refreshed").
  const handleRefresh = () => {
    refreshCache();
  };
  window.addEventListener("sheet:activated", handleRefresh);
  window.addEventListener("filterpane:filters-refreshed", handleRefresh);
  removeWindowListeners = () => {
    window.removeEventListener("sheet:activated", handleRefresh);
    window.removeEventListener("filterpane:filters-refreshed", handleRefresh);
  };

  // Track applied filters and show count badge on the Controls tab
  unregisterBadge = registerFilterBadge();

  // Initial cache load
  refreshCache();

  console.log("[ControlsPane Extension] Registered.");
}

function deactivate(): void {
  console.log("[ControlsPane Extension] Deactivating...");
  unregisterBadge?.();
  unregisterBadge = null;
  removeWindowListeners?.();
  removeWindowListeners = null;
  unregisterPanel(CONTROLS_PANE_TAB_ID);
  clearCache();
}

const ControlsPaneExtension: ExtensionModule = {
  manifest: ControlsPaneManifest,
  activate,
  deactivate,
};

export default ControlsPaneExtension;
