//! FILENAME: app/extensions/Table/index.ts
// PURPOSE: Table extension entry point.
// CONTEXT: Registers all table functionality with the extension system.

import {
  ExtensionRegistry,
  DialogExtensions,
} from "../../src/api";
import { registerMenu } from "../../src/api/ui";

import {
  TableManifest,
  TableDialogDefinition,
  TABLE_DIALOG_ID,
} from "./manifest";

import {
  handleSelectionChange,
  resetSelectionHandlerState,
} from "./handlers/selectionHandler";
import { buildTableMenu } from "./handlers/tableMenuBuilder";
import { resetTableStore } from "./lib/tableStore";

// ============================================================================
// Extension Lifecycle
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/**
 * Register the table extension.
 * Call this during application initialization.
 */
export function registerTableExtension(): void {
  console.log("[Table Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(TableManifest);

  // Register dialog
  DialogExtensions.registerDialog(TableDialogDefinition);

  // Register the contextual Table menu (initially hidden)
  registerMenu(buildTableMenu(null, true));

  // Subscribe to selection changes to show/hide the Table menu
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  console.log("[Table Extension] Registered successfully");
}

/**
 * Unregister the table extension.
 * Call this during application shutdown or hot reload.
 */
export function unregisterTableExtension(): void {
  console.log("[Table Extension] Unregistering...");

  // Cleanup event listeners
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Reset handler state
  resetSelectionHandlerState();
  resetTableStore();

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(TableManifest.id);
  DialogExtensions.unregisterDialog(TABLE_DIALOG_ID);

  console.log("[Table Extension] Unregistered successfully");
}

// Re-export for convenience
export { TABLE_DIALOG_ID };
