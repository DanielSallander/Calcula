//! FILENAME: app/extensions/GoToSpecial/index.ts
// PURPOSE: Go To Special extension entry point.
// CONTEXT: Registers the dialog for selecting cells by type.
//          Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { GoToSpecialDialog } from "./components/GoToSpecialDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[GoToSpecial] Activating...");

  context.ui.dialogs.register({
    id: "go-to-special",
    component: GoToSpecialDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("go-to-special"));

  console.log("[GoToSpecial] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[GoToSpecial] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[GoToSpecial] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[GoToSpecial] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.go-to-special",
    name: "Go To Special",
    version: "1.0.0",
    description: "Select cells by type (formulas, constants, blanks, etc.).",
  },
  activate,
  deactivate,
};

export default extension;
