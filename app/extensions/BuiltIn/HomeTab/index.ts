//! FILENAME: app/extensions/BuiltIn/HomeTab/index.ts
// PURPOSE: Home tab extension - always-visible ribbon tab with quick-access formatting.
// CONTEXT: Replaces the empty ribbon placeholder with a customizable Home tab.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { ExtensionRegistry } from "../../../src/api/extensions";
import { DialogExtensions } from "../../../src/api/ui";
import { HomeTabComponent } from "./components/HomeTabComponent";
import { HomeTabCustomizeDialog } from "./components/HomeTabCustomizeDialog";

// ============================================================================
// Constants
// ============================================================================

const HOME_TAB_ID = "home";
const HOME_CUSTOMIZE_DIALOG_ID = "home-tab-customize";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Activation
// ============================================================================

function activate(_context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[HomeTabExtension] Already activated, skipping.");
    return;
  }

  console.log("[HomeTabExtension] Activating...");

  // Register the Home ribbon tab - always visible, lowest order
  ExtensionRegistry.registerRibbonTab({
    id: HOME_TAB_ID,
    label: "Home",
    order: 10,
    component: HomeTabComponent,
  });

  // Register the customization dialog
  DialogExtensions.registerDialog({
    id: HOME_CUSTOMIZE_DIALOG_ID,
    component: HomeTabCustomizeDialog,
    priority: 150,
  });

  isActivated = true;
  console.log("[HomeTabExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[HomeTabExtension] Deactivating...");
  ExtensionRegistry.unregisterRibbonTab(HOME_TAB_ID);
  DialogExtensions.unregisterDialog(HOME_CUSTOMIZE_DIALOG_ID);
  isActivated = false;
  console.log("[HomeTabExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.home-tab",
    name: "Home Tab",
    version: "1.0.0",
    description: "Always-visible Home ribbon tab with quick-access formatting commands.",
  },
  activate,
  deactivate,
};

export default extension;
