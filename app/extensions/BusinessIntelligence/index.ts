//! FILENAME: app/extensions/BusinessIntelligence/index.ts
// PURPOSE: BI extension registration — edit guards, events, ribbon, task pane.
// CONTEXT: Follows the standard Calcula extension lifecycle pattern.

import {
  ExtensionRegistry,
  TaskPaneExtensions,
  registerEditGuard,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  openTaskPane,
  gridExtensions,
  GridMenuGroups,
} from "../../src/api";
import type { GridMenuContext } from "../../src/api";

import { BiManifest, BiPaneDefinition, BI_PANE_ID } from "./manifest";
import { getRegionAtCell } from "./lib/bi-api";

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

  // 4. Register context menu item to open the BI pane
  gridExtensions.registerContextMenuItem({
    id: "bi.openPane",
    label: "Business Intelligence...",
    group: GridMenuGroups.DATA,
    order: 900,
    onClick: (_context: GridMenuContext) => {
      addTaskPaneContextKey("bi");
      openTaskPane(BI_PANE_ID);
    },
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
  gridExtensions.unregisterContextMenuItem("bi.openPane");
  TaskPaneExtensions.unregisterView(BI_PANE_ID);
  ExtensionRegistry.unregisterAddIn(BiManifest.id);

  console.log("[BI Extension] Unregistered");
}
