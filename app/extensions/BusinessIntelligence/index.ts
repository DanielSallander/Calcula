//! FILENAME: app/extensions/BusinessIntelligence/index.ts
// PURPOSE: BI extension registration — edit guards, events, ribbon, task pane.
// CONTEXT: Follows the standard Calcula extension lifecycle pattern.

import {
  ExtensionRegistry,
  TaskPaneExtensions,
  DialogExtensions,
  registerEditGuard,
  registerMenuItem,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  openTaskPane,
} from "../../src/api";

import { BiManifest, BiPaneDefinition, BI_PANE_ID } from "./manifest";
import { getRegionAtCell } from "./lib/bi-api";
import { ModelDialog } from "./components/ModelDialog";

const MODEL_DIALOG_ID = "bi:modelDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

// ============================================================================
// Registration
// ============================================================================

export function registerBiExtension(): void {
  console.log("[BI Extension] Registering...");

  // 1. Register manifest
  ExtensionRegistry.registerAddIn(BiManifest);

  // 2. Register task pane view
  TaskPaneExtensions.registerView(BiPaneDefinition);

  // 3. Register edit guard — blocks edits in BI locked regions
  cleanupFunctions.push(
    registerEditGuard(async (row, col) => {
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
  DialogExtensions.registerDialog({
    id: MODEL_DIALOG_ID,
    component: ModelDialog,
    priority: 100,
  });
  cleanupFunctions.push(() => DialogExtensions.unregisterDialog(MODEL_DIALOG_ID));

  // 6. Register "Get Data" submenu in the Data menu
  registerMenuItem("data", {
    id: "data:getData",
    label: "Get Data",
    children: [
      {
        id: "data:getData:calculaModel",
        label: "Calcula Model...",
        action: () => {
          DialogExtensions.openDialog(MODEL_DIALOG_ID);
        },
      },
    ],
  });

  console.log("[BI Extension] Registered");
}

export function unregisterBiExtension(): void {
  console.log("[BI Extension] Unregistering...");

  // Run all cleanup functions
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Remove context key
  removeTaskPaneContextKey("bi");

  // Unregister from registries
  DialogExtensions.unregisterDialog(MODEL_DIALOG_ID);
  TaskPaneExtensions.unregisterView(BI_PANE_ID);
  ExtensionRegistry.unregisterAddIn(BiManifest.id);

  console.log("[BI Extension] Unregistered");
}
