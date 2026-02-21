//! FILENAME: app/extensions/DefinedNames/index.ts
// PURPOSE: Extension entry point for Defined Names / Name Manager feature.
// CONTEXT: Registers dialogs and menu items for managing named ranges.

import { DialogExtensions } from "../../src/api";
import { NameManagerDialog } from "./components/NameManagerDialog";
import { NewNameDialog } from "./components/NewNameDialog";
import { registerDefinedNamesMenuItems } from "./handlers/formulasMenuItemBuilder";

const cleanupFns: (() => void)[] = [];

/**
 * Register the DefinedNames extension.
 */
export function registerDefinedNamesExtension(): void {
  console.log("[DefinedNames] Registering extension...");

  // Register the Name Manager dialog
  DialogExtensions.registerDialog({
    id: "name-manager",
    component: NameManagerDialog,
    priority: 50,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("name-manager"));

  // Register the New/Edit Name dialog
  DialogExtensions.registerDialog({
    id: "define-name",
    component: NewNameDialog,
    priority: 51,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("define-name"));

  // Register menu items in the Formulas menu
  const cleanupMenus = registerDefinedNamesMenuItems();
  cleanupFns.push(cleanupMenus);

  console.log("[DefinedNames] Extension registered.");
}

/**
 * Unregister the DefinedNames extension.
 */
export function unregisterDefinedNamesExtension(): void {
  console.log("[DefinedNames] Unregistering extension...");
  for (const cleanup of cleanupFns) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupFns.length = 0;
  console.log("[DefinedNames] Extension unregistered.");
}
