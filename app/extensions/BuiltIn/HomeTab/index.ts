//! FILENAME: app/extensions/BuiltIn/HomeTab/index.ts
// PURPOSE: Home tab extension - always-visible ribbon panel with quick-access formatting.
// CONTEXT: Registers ONE location-agnostic panel ("home") whose sections come from the
// user-customizable layout config (Clipboard, Font, Alignment, ...). The shell renders
// the sections horizontally in the ribbon band or vertically in the sidebar; the
// customize dialog re-registers the panel when the layout changes.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { RibbonContext } from "@api/extensions";
import { registerPanel, unregisterPanel, DialogExtensions } from "@api/ui";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import { useGridState } from "@api/state";
import { HomeTabGroupComponent } from "./components/HomeTabGroupComponent";
import { HomeTabCustomizeDialog } from "./components/HomeTabCustomizeDialog";
import { loadLayout } from "./homeTabConfig";

// ============================================================================
// Constants
// ============================================================================

const HOME_TAB_ID = "home";
const HOME_TAB_ORDER = 10;
const HOME_CUSTOMIZE_DIALOG_ID = "home-tab-customize";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let layoutChangedHandler: (() => void) | null = null;

// ============================================================================
// Group Definitions
// ============================================================================

/** Icons per group (shown on launcher buttons when a section is demoted) */
const GROUP_ICONS: Record<string, string> = {
  clipboard: "\u2702",
  font: "A",
  alignment: "\u2261",
  number: "#",
  styles: "\u2728",
  editing: "\u270E",
};

/** Collapse priority per group (lower = collapses to a launcher first) */
const GROUP_ORDER: Record<string, number> = {
  clipboard: 10,
  font: 20,
  alignment: 30,
  number: 40,
  styles: 50,
  editing: 60,
};

// ============================================================================
// Section Building
// ============================================================================

/**
 * Builds a PanelSection component for one layout group. The adapter constructs
 * the RibbonContext from grid state (selection/editing) so the inner group
 * component keeps its existing contract.
 */
function makeSectionComponent(itemIds: string[]): React.ComponentType<PanelSectionProps> {
  const SectionAdapter: React.ComponentType<PanelSectionProps> = () => {
    const state = useGridState();
    const context: RibbonContext = {
      selection: state.selection,
      isDisabled: state.editing !== null,
      executeCommand: async () => {},
      refreshCells: async () => {},
    };
    return React.createElement(HomeTabGroupComponent, { context, itemIds });
  };
  return SectionAdapter;
}

/** Builds the panel sections from the current (possibly customized) layout. */
function buildSections(): PanelSection[] {
  const layout = loadLayout();
  return layout.groups.map((group) => ({
    id: `${HOME_TAB_ID}.${group.id}`,
    label: group.label,
    icon: GROUP_ICONS[group.id] ?? "\u2630",
    component: makeSectionComponent(group.items),
    ribbonPresentation: "inline" as const,
    collapsePriority: GROUP_ORDER[group.id] ?? 99,
  }));
}

/** Registers (or re-registers) the Home panel from the current layout. */
function registerHomePanel(): void {
  registerPanel({
    id: HOME_TAB_ID,
    title: "Home",
    icon: null,
    sections: buildSections(),
    defaultPlacement: "ribbon",
    ribbonOrder: HOME_TAB_ORDER,
    priority: 1000 - HOME_TAB_ORDER,
  });
}

// ============================================================================
// Activation
// ============================================================================

function activate(_context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[HomeTabExtension] Already activated, skipping.");
    return;
  }

  console.log("[HomeTabExtension] Activating...");

  // Register the Home panel (one section per layout group)
  registerHomePanel();

  // Re-register the panel when the customize dialog saves a new layout
  layoutChangedHandler = () => {
    unregisterPanel(HOME_TAB_ID);
    registerHomePanel();
  };
  window.addEventListener("homeTab:layoutChanged", layoutChangedHandler);

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
  if (layoutChangedHandler) {
    window.removeEventListener("homeTab:layoutChanged", layoutChangedHandler);
    layoutChangedHandler = null;
  }
  unregisterPanel(HOME_TAB_ID);
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
