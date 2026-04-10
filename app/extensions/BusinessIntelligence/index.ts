//! FILENAME: app/extensions/BusinessIntelligence/index.ts
// PURPOSE: BI extension entry point (ExtensionModule pattern).
//          Registers edit guards, events, ribbon, task pane, and dialogs.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  TaskPaneExtensions,
  removeTaskPaneContextKey,
  IconConnections,
  IconGetData,
} from "@api";

import {
  BiManifest,
  BiPaneDefinition,
  BI_PANE_ID,
  ConnectionsPaneDefinition,
  CONNECTIONS_PANE_ID,
} from "./manifest";
import { getRegionAtCell } from "./lib/bi-api";
import { ModelDialog } from "./components/ModelDialog";

const MODEL_DIALOG_ID = "bi:modelDialog";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFunctions: Array<() => void> = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[BI Extension] Already activated, skipping.");
    return;
  }

  console.log("[BI Extension] Activating...");

  // 1. Register manifest
  ExtensionRegistry.registerAddIn(BiManifest);

  // 2. Register task pane views
  TaskPaneExtensions.registerView(BiPaneDefinition);
  TaskPaneExtensions.registerView(ConnectionsPaneDefinition);

  // 3. Register edit guard - blocks edits in BI locked regions
  cleanupFunctions.push(
    context.grid.editGuards.register(async (row, col) => {
      try {
        const region = await getRegionAtCell(row, col);
        if (region) {
          return {
            blocked: true,
            message:
              "This cell is part of a BI query result and cannot be edited. Use the BI pane to refresh the data.",
          };
        }
      } catch (error) {
        console.error("[BI Extension] Failed to check BI region:", error);
      }
      return null;
    }),
  );

  // 4. Register Model Dialog (for "Get Data > Calcula Model")
  context.ui.dialogs.register({
    id: MODEL_DIALOG_ID,
    component: ModelDialog,
    priority: 100,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(MODEL_DIALOG_ID));

  // 5. Register "Connections" menu item in External Data menu
  context.ui.menus.registerItem("externalData", {
    id: "externalData:connections",
    label: "Connections",
    icon: IconConnections,
    action: () => {
      context.ui.taskPanes.addContextKey("connections");
      context.ui.taskPanes.open(CONNECTIONS_PANE_ID);
    },
  });

  // 6. Register "Get Data" submenu in the External Data menu
  context.ui.menus.registerItem("externalData", {
    id: "externalData:getData",
    label: "Get Data",
    icon: IconGetData,
    children: [
      {
        id: "externalData:getData:calculaModel",
        label: "Calcula Model...",
        action: () => {
          context.ui.dialogs.show(MODEL_DIALOG_ID);
        },
      },
    ],
  });

  isActivated = true;
  console.log("[BI Extension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[BI Extension] Deactivating...");

  // Run all cleanup functions
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions.length = 0;

  // Remove context keys
  removeTaskPaneContextKey("bi");
  removeTaskPaneContextKey("connections");

  // Unregister from registries
  TaskPaneExtensions.unregisterView(BI_PANE_ID);
  TaskPaneExtensions.unregisterView(CONNECTIONS_PANE_ID);
  ExtensionRegistry.unregisterAddIn(BiManifest.id);

  isActivated = false;
  console.log("[BI Extension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.business-intelligence",
    name: "Business Intelligence",
    version: "1.0.0",
    description: "BI engine integration with data connections, queries, and model loading.",
  },
  activate,
  deactivate,
};

export default extension;
