//! FILENAME: app/extensions/BuiltIn/HomeTab/index.ts
// PURPOSE: Home tab extension - always-visible ribbon tab with quick-access formatting.
// CONTEXT: Registers each formatting group (Clipboard, Font, Alignment, etc.) as a
// separate ribbon group. This enables the sections-based panel system to transpose
// groups between horizontal ribbon layout and vertical sidebar layout.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api/extensions";
import { DialogExtensions } from "@api/ui";
import { HomeTabGroupComponent } from "./components/HomeTabGroupComponent";
import { HomeTabCustomizeDialog } from "./components/HomeTabCustomizeDialog";
import { loadLayout } from "./homeTabConfig";

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
// Group Definitions
// ============================================================================

/** Icons for collapsed ribbon group buttons */
const GROUP_ICONS: Record<string, string> = {
  clipboard: "\u2702",
  font: "A",
  alignment: "\u2261",
  number: "#",
  styles: "\u2728",
  editing: "\u270E",
};

/** Collapse priority per group (lower = collapses first) */
const GROUP_ORDER: Record<string, number> = {
  clipboard: 10,
  font: 20,
  alignment: 30,
  number: 40,
  styles: 50,
  editing: 60,
};

// ============================================================================
// Activation
// ============================================================================

function activate(_context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[HomeTabExtension] Already activated, skipping.");
    return;
  }

  console.log("[HomeTabExtension] Activating...");

  // Register the Home ribbon tab (empty — groups are registered separately)
  ExtensionRegistry.registerRibbonTab({
    id: HOME_TAB_ID,
    label: "Home",
    order: 10,
    // Placeholder component — groups render the actual content
    component: () => null,
  });

  // Register each group from the layout config
  const layout = loadLayout();
  for (const group of layout.groups) {
    const itemIds = group.items;
    ExtensionRegistry.registerRibbonGroup({
      id: `home.${group.id}`,
      tabId: HOME_TAB_ID,
      label: group.label,
      order: GROUP_ORDER[group.id] ?? 99,
      component: ({ context }) =>
        React.createElement(HomeTabGroupComponent, { context, itemIds }),
    });
  }

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
