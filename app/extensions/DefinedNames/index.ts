//! FILENAME: app/extensions/DefinedNames/index.ts
// PURPOSE: Extension entry point for Defined Names / Name Manager feature.
// CONTEXT: Registers dialogs and menu items for managing named ranges.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { AppEvents, emitAppEvent, listenTauriEvent } from "@api";
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

  // Bridge the backend "named-ranges:refresh" Tauri event (emitted after an
  // OUT-OF-BAND MCP create_named_range) to the NAMED_RANGES_CHANGED app event,
  // so an AI-created name appears live in the Name Manager / NameBox without a
  // reload — mirroring the Charts charts:refresh bridge. (In-app dialogs emit
  // NAMED_RANGES_CHANGED themselves, so this only matters for out-of-band writes.)
  let unlistenNamedRanges: (() => void) | undefined;
  void listenTauriEvent("named-ranges:refresh", () => {
    emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
  }).then((un) => {
    unlistenNamedRanges = un;
  });
  cleanupFns.push(() => unlistenNamedRanges?.());

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
