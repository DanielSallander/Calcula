//! FILENAME: app/extensions/DefinedNames/index.ts
// PURPOSE: Extension entry point for Defined Names / Name Manager feature.
// CONTEXT: Registers dialogs and menu items for managing named ranges.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { NameManagerDialog } from "./components/NameManagerDialog";
import { NewNameDialog } from "./components/NewNameDialog";
import { NewFunctionDialog } from "./components/NewFunctionDialog";
import { registerDefinedNamesMenuItems } from "./handlers/formulasMenuItemBuilder";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[DefinedNames] Already activated, skipping.");
    return;
  }

  console.log("[DefinedNames] Activating...");

  // Register the Name Manager dialog
  context.ui.dialogs.register({
    id: "name-manager",
    component: NameManagerDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("name-manager"));

  // Register the New/Edit Name dialog
  context.ui.dialogs.register({
    id: "define-name",
    component: NewNameDialog,
    priority: 51,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("define-name"));

  // Register the New/Edit Function dialog
  context.ui.dialogs.register({
    id: "define-function",
    component: NewFunctionDialog,
    priority: 52,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("define-function"));

  // Register menu items in the Formulas menu
  const cleanupMenus = registerDefinedNamesMenuItems(context);
  cleanupFns.push(cleanupMenus);

  isActivated = true;
  console.log("[DefinedNames] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[DefinedNames] Deactivating...");

  for (const cleanup of cleanupFns) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[DefinedNames] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.defined-names",
    name: "Defined Names",
    version: "1.0.0",
    description: "Name Manager for defining, editing, and managing named ranges and custom functions.",
  },
  activate,
  deactivate,
};

export default extension;
