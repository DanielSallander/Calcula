//! FILENAME: app/extensions/BuiltIn/HomeTab/index.ts
// PURPOSE: Home tab extension - always-visible ribbon panel with quick-access formatting.
// CONTEXT: Registers ONE location-agnostic panel ("home") whose sections come from the
// user-customizable layout config (Clipboard, Font, Alignment, ...). The shell renders
// the sections horizontally in the ribbon band or vertically in the sidebar; the
// customize dialog re-registers the panel when the layout changes.
//
// The entry point to that dialog is a View-menu item. It is deliberately NOT a
// ribbon gear: the tab strip has no right-aligned surface, a gear would need a
// sidebar-projection equivalent, and it would change ~9 committed screenshots.
// `registerMenuItem` is a first-class extension API (30+ extensions use it), so
// this needs no shell change, no API change and turns no golden red.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { RibbonContext } from "@api/extensions";
import {
  registerPanel,
  unregisterPanel,
  registerMenuItem,
  unregisterMenuItem,
  showDialog,
  DialogExtensions,
} from "@api/ui";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import { useGridState } from "@api/state";
import { HomeTabGroupComponent } from "./components/HomeTabGroupComponent";
import { HomeTabCustomizeDialog } from "./components/HomeTabCustomizeDialog";
import {
  groupIconFor,
  HomeTabCustomizeIcon,
  LAUNCHER_ICON_SIZE,
} from "./components/homeTabIcons";
import { loadLayout, type HomeTabLayout } from "./homeTabConfig";

// ============================================================================
// Constants
// ============================================================================

const HOME_TAB_ID = "home";
const HOME_TAB_ORDER = 10;
const HOME_CUSTOMIZE_DIALOG_ID = "home-tab-customize";
const VIEW_MENU_ID = "view";
const CUSTOMIZE_MENU_ITEM_ID = "view.customizeHomeTab";

/** Fallback demotion order for a group that names none (user-created groups).
 *  Higher = collapses LAST, so a custom group survives the squeeze. */
const DEFAULT_COLLAPSE_PRIORITY = 99;

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let layoutChangedHandler: (() => void) | null = null;

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

/**
 * Builds the panel sections from a layout.
 *
 * Icon and collapse order come from the LAYOUT (`iconId`, `collapsePriority`),
 * not from side tables here. Two parallel lookup tables keyed by group id used
 * to live in this file and had already drifted from DEFAULT_LAYOUT once.
 */
export function buildSections(layout: HomeTabLayout): PanelSection[] {
  return layout.groups.map((group) => ({
    id: `${HOME_TAB_ID}.${group.id}`,
    label: group.label,
    icon: groupIconFor(group, LAUNCHER_ICON_SIZE),
    component: makeSectionComponent(group.items),
    ribbonPresentation: "inline" as const,
    collapsePriority: group.collapsePriority ?? DEFAULT_COLLAPSE_PRIORITY,
  }));
}

/** Registers (or re-registers) the Home panel from the current layout. */
function registerHomePanel(): void {
  registerPanel({
    id: HOME_TAB_ID,
    title: "Home",
    icon: null,
    sections: buildSections(loadLayout()),
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

  // Re-register the panel when the customize dialog saves a new layout.
  //
  // REGISTER IN PLACE — do NOT unregister first. `registerPanel` upserts by id
  // (the panel registry `set`s, and `registerRibbonTab` overwrites), so a bare
  // re-register replaces the tab without it ever being absent. Unregistering
  // first made the Home tab momentarily NOT EXIST, and the ribbon's active-tab
  // reconciliation reacts to that: when the current tab disappears it falls
  // back to the first non-contextual tab. So the user pressed Save in
  // "Customize Home Tab..." and was dumped onto Page Layout, with their newly
  // customised Home tab off screen — the re-register that followed put the tab
  // back but could not take the selection back, because by then "pageLayout"
  // was a perfectly valid current tab.
  layoutChangedHandler = () => {
    registerHomePanel();
  };
  window.addEventListener("homeTab:layoutChanged", layoutChangedHandler);

  // Register the customization dialog
  DialogExtensions.registerDialog({
    id: HOME_CUSTOMIZE_DIALOG_ID,
    component: HomeTabCustomizeDialog,
    priority: 150,
  });

  // The entry point. Without it the dialog is registered, listening and
  // unreachable: a saved layout still applies at startup but nobody can
  // change it back.
  registerMenuItem(VIEW_MENU_ID, {
    id: CUSTOMIZE_MENU_ITEM_ID,
    label: "Customize Home Tab...",
    icon: React.createElement(HomeTabCustomizeIcon, { size: 14 }),
    order: 90,
    action: () => showDialog(HOME_CUSTOMIZE_DIALOG_ID),
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
  unregisterMenuItem(VIEW_MENU_ID, CUSTOMIZE_MENU_ITEM_ID);
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
