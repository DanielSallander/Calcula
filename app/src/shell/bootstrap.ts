//! FILENAME: app/src/shell/bootstrap.ts
// PURPOSE: Bootstrap function that registers Shell implementations with the API layer.
// CONTEXT: Called once at application startup before extensions are loaded.
// NOTE: This is the Inversion of Control wiring - Shell owns implementations,
//       API defines contracts, this file connects them.

import React from "react";

import {
  registerTaskPaneService,
  registerDialogService,
  registerOverlayService,
  registerActivityBarService,
  registerPanelService,
  registerTaskPaneHooks,
  registerActivityBarHooks,
  registerMenuItem,
  updateMenuItem,
  type TaskPaneService,
  type DialogService,
  type OverlayService,
  type ActivityBarService,
} from "../api/ui";
import {
  getRibbonLabelMode,
  setRibbonLabelMode,
  subscribeToAppearance,
} from "../api/appearance";
import { RibbonIcon } from "../api/ribbonIcons";

import { initKeybindings } from "../api/keybindings";
import { getLocaleSettings } from "../api/locale";
import { listenTauriEvent } from "../api/backend";
import { getGridRegions } from "../api/gridOverlays";
import { onAppEvent, emitAppEvent, AppEvents, type MutationDomain, type MutationRefreshPayload } from "../api/events";
import { WRITEBACK_INDEX_CHANGED_EVENT } from "../api/collaboration";
import { bridgeDirtyStateAnnouncement } from "./dirtyStateBridge";
import { bridgeSheetDisplayFlagsAnnouncement } from "./sheetDisplayFlagsBridge";
import { bridgeUndoStateAnnouncement } from "./undoStateBridge";

import {
  registerExtensionRegistryService,
  registerGridExtensionsService,
  registerGridCommandsService,
  registerSheetExtensionsService,
  type ExtensionRegistryService,
  type GridExtensionsService,
  type GridCommandsService,
  type SheetExtensionsService,
  type GridCommand,
  type CommandGuard,
  type GridMenuContext,
  type GridContextMenuItem,
  type AddInManifest,
  type RibbonTabDefinition,
  type RibbonGroupDefinition,
} from "../api/extensions";

import { useShallow } from "zustand/react/shallow";

// Shell implementations
import { useTaskPaneStore } from "./TaskPane/useTaskPaneStore";
import { TaskPaneExtensions as TaskPaneExtensionsImpl } from "./registries/taskPaneExtensions";
import { DialogExtensions as DialogExtensionsImpl } from "./registries/dialogExtensions";
import { OverlayExtensions as OverlayExtensionsImpl } from "./registries/overlayExtensions";
import { ExtensionRegistry as ExtensionRegistryImpl } from "./registries/ExtensionRegistry";
import { ExtensionManager } from "./registries/ExtensionManager";
import { registerExtensionManager } from "../api/extensionManager";
import {
  gridExtensions as gridExtensionsImpl,
  registerCoreGridContextMenu,
} from "./registries/gridExtensions";
import { gridCommands as gridCommandsImpl } from "../core/lib/gridCommands";
import {
  sheetExtensions as sheetExtensionsImpl,
  registerCoreSheetContextMenu,
} from "./registries/sheetExtensions";
import { ActivityBarExtensions as ActivityBarExtensionsImpl } from "./registries/activityBarExtensions";
import { useActivityBarStore } from "./ActivityBar/useActivityBarStore";
import { panelRegistry, initPanelRegistry } from "./registries/panelRegistry";
import type { PanelDefinition, PanelSectionProps } from "../api/uiTypes";
import { clearSectionWidthCaches, type ShellPanelSection } from "./components/SectionRenderers";
import { clearSectionFitCache } from "./components/useSectionFit";
import { useGridState } from "../api/state";

/** Section icon of a synthesized legacy section (the launcher slot size). */
const LEGACY_SECTION_ICON_SIZE = 24;
/** Panel icon of a synthesized legacy tab (the rail / panel-icon size). */
const LEGACY_PANEL_ICON_SIZE = 20;

/**
 * Wraps a RibbonGroupDefinition component (expects RibbonContext) into a
 * PanelSection component (expects PanelSectionProps). The wrapper provides
 * the RibbonContext from the grid state hook.
 *
 * Synthesized sections are band-native legacy DOM: rendered "inline" in the
 * ribbon (designed for the band — never height-probed/demoted; the
 * width-overflow collapse still measures them and may fold them to launchers
 * when the window is too narrow) and flagged legacyRibbonDom so the sidebar
 * renderer scopes its transposition CSS to exactly these until each tab
 * migrates to @api/layout primitives. They render inside the same cluster
 * chrome as every other section.
 */
function wrapRibbonGroupAsSection(group: RibbonGroupDefinition): ShellPanelSection {
  const GroupComponent = group.component;
  const SectionAdapter: React.ComponentType<PanelSectionProps> = () => {
    const state = useGridState();
    const context = {
      selection: state.selection,
      isDisabled: state.editing !== null,
      executeCommand: async () => {},
      refreshCells: async () => {},
    };
    return React.createElement(GroupComponent, { context });
  };
  SectionAdapter.displayName = `SectionAdapter(${group.id})`;
  return {
    id: group.id,
    label: group.label,
    icon: React.createElement(RibbonIcon.Group, { size: LEGACY_SECTION_ICON_SIZE }),
    component: SectionAdapter,
    ribbonPresentation: "inline",
    collapsePriority: group.order,
    legacyRibbonDom: true,
  };
}

/**
 * Wraps an entire ribbon tab component as a single PanelSection.
 * Same legacy contract as wrapRibbonGroupAsSection.
 */
function wrapRibbonTabAsSection(tab: { id: string; label: string; component: React.ComponentType<any> }): ShellPanelSection {
  const TabComponent = tab.component;
  const SectionAdapter: React.ComponentType<PanelSectionProps> = () => {
    const state = useGridState();
    const context = {
      selection: state.selection,
      isDisabled: state.editing !== null,
      executeCommand: async () => {},
      refreshCells: async () => {},
    };
    return React.createElement(TabComponent, { context });
  };
  SectionAdapter.displayName = `TabSection(${tab.id})`;
  return {
    id: tab.id + ".main",
    label: tab.label,
    icon: React.createElement(RibbonIcon.Group, { size: LEGACY_SECTION_ICON_SIZE }),
    component: SectionAdapter,
    ribbonPresentation: "inline",
    legacyRibbonDom: true,
  };
}

/** True when a panel's only section is a whole wrapped legacy tab. */
function isWholeTabPanel(panel: PanelDefinition): boolean {
  return panel.sections.length === 1 && panel.sections[0].id.endsWith(".main");
}

/** Add one legacy group to an already-registered panel as a section. */
function addRibbonGroupToPanel(panel: PanelDefinition, group: RibbonGroupDefinition): void {
  const newSection = wrapRibbonGroupAsSection(group);
  // If the panel currently has a single "main" section (a wrapped tab),
  // replace it: individual groups are being registered and take precedence.
  const sections = isWholeTabPanel(panel)
    ? [newSection]
    : [...panel.sections.filter((s) => s.id !== newSection.id), newSection];
  panelRegistry.registerPanel({ ...panel, sections });
}

/**
 * Register a legacy ribbon tab as a panel. Any groups already PARKED in
 * ExtensionRegistryImpl for this tab (registered before it, or by a manifest)
 * are drained out of the Impl in the same step and become the panel's
 * sections, in their declared order; with none, the whole tab component is
 * one section. Draining is what lets RibbonContainer drop its direct group
 * path: a group left in the Impl used to render there, beside the section
 * renderer, with no measurement and no demotion.
 */
function registerLegacyTabPanel(tab: RibbonTabDefinition): void {
  const adopted = ExtensionRegistryImpl.drainRibbonGroupsForTab(tab.id).map(wrapRibbonGroupAsSection);
  panelRegistry.registerPanel({
    id: tab.id,
    title: tab.label,
    icon: React.createElement(RibbonIcon.Group, { size: LEGACY_PANEL_ICON_SIZE }),
    sections: adopted.length > 0 ? adopted : [wrapRibbonTabAsSection(tab)],
    defaultPlacement: "ribbon",
    ribbonOrder: tab.order,
    ribbonColor: tab.color,
    priority: 1000 - tab.order,
  });
}

/**
 * The legacy ribbon API (`registerRibbonTab`, `registerRibbonGroup`,
 * `AddInManifest.ribbonTabs` / `ribbonGroups`) routed onto panels, so legacy
 * content renders in cluster chrome through the measured section renderer on
 * either surface. Exported for the registry tests; production reaches it only
 * through the ExtensionRegistryService that bootstrapShell registers.
 */
export const legacyRibbonRouting = {
  /** A legacy tab: one panel, adopting any groups parked before it. */
  registerRibbonTab(tab: RibbonTabDefinition): void {
    registerLegacyTabPanel(tab);
  },

  /**
   * A legacy group. After its tab: added to the tab's panel as a section
   * (unchanged behaviour). Before its tab: parked in the Impl, and adopted
   * when the tab registers.
   */
  registerRibbonGroup(group: RibbonGroupDefinition): void {
    const panel = panelRegistry.getPanel(group.tabId);
    if (panel) {
      addRibbonGroupToPanel(panel, group);
    } else {
      ExtensionRegistryImpl.registerRibbonGroup(group);
    }
  },

  /**
   * An add-in manifest. The Impl keeps the manifest for bookkeeping
   * (dependency checks, getRegisteredAddIns) and registers its commands; it
   * also parks the manifest's tabs and groups, which are adopted here:
   * - each tab becomes a panel whose sections are its groups (the manifest's
   *   own plus any parked earlier), drained from the Impl;
   * - the raw tab the Impl registered under the same id is overwritten by the
   *   panel's ribbon projection — and removed when the panel lives in the
   *   sidebar, where nothing overwrites it, or the tab would show twice;
   * - a group aimed at another add-in's tab that is already registered joins
   *   that panel as a section; one whose tab is not there yet stays parked.
   */
  registerAddIn(manifest: AddInManifest): void {
    ExtensionRegistryImpl.registerAddIn(manifest);

    const ownTabIds = new Set((manifest.ribbonTabs ?? []).map((t) => t.id));
    for (const tab of manifest.ribbonTabs ?? []) {
      registerLegacyTabPanel(tab);
      if (panelRegistry.getPlacement(tab.id) !== "ribbon") {
        ExtensionRegistryImpl.unregisterRibbonTab(tab.id);
      }
    }

    for (const group of manifest.ribbonGroups ?? []) {
      if (ownTabIds.has(group.tabId)) continue;
      const panel = panelRegistry.getPanel(group.tabId);
      if (!panel || !ExtensionRegistryImpl.hasRibbonGroup(group.id)) continue;
      ExtensionRegistryImpl.unregisterRibbonGroup(group.id);
      addRibbonGroupToPanel(panel, group);
    }
  },

  /** Undo registerAddIn: its panels, the sections it added to other add-ins'
   *  panels, and the Impl's bookkeeping. */
  unregisterAddIn(addinId: string): void {
    const manifest = ExtensionRegistryImpl.getRegisteredAddIns().find((m) => m.id === addinId);
    if (manifest) {
      const ownTabIds = new Set((manifest.ribbonTabs ?? []).map((t) => t.id));
      manifest.ribbonTabs?.forEach((tab) => panelRegistry.unregisterPanel(tab.id));
      for (const group of manifest.ribbonGroups ?? []) {
        if (ownTabIds.has(group.tabId)) continue;
        const panel = panelRegistry.getPanel(group.tabId);
        if (!panel || !panel.sections.some((s) => s.id === group.id)) continue;
        panelRegistry.registerPanel({
          ...panel,
          sections: panel.sections.filter((s) => s.id !== group.id),
        });
      }
    }
    ExtensionRegistryImpl.unregisterAddIn(addinId);
  },
};

// ============================================================================
// Ribbon appearance wiring
// ============================================================================

/** View-menu item id of the group-label preference. */
const RIBBON_LABELS_MENU_ITEM_ID = "view.ribbonGroupLabels";
/** Menu icon size (the menu bar's icon column). */
const MENU_ICON_SIZE = 16;

/**
 * Ties the ribbon to the appearance preferences:
 * - a skin, token or label-mode change clears the ribbon's measurement caches
 *   (their first production callers): a demotion or a width measured under
 *   one skin's radii and one label mode is not evidence under another, and
 *   the next mount must re-measure instead of replaying it;
 * - the View menu gets "Show Ribbon Group Labels", a checked item that
 *   follows the preference however it was changed (this menu, the ribbon's
 *   context menu, the Appearance page).
 */
function wireRibbonAppearance(): void {
  const clearRibbonMeasurements = (): void => {
    clearSectionFitCache();
    clearSectionWidthCaches();
  };
  onAppEvent(AppEvents.APPEARANCE_CHANGED, clearRibbonMeasurements);

  let labelsChecked = getRibbonLabelMode() === "show";
  registerMenuItem("view", {
    id: RIBBON_LABELS_MENU_ITEM_ID,
    label: "Show Ribbon Group Labels",
    icon: React.createElement(RibbonIcon.Text, { size: MENU_ICON_SIZE }),
    checked: labelsChecked,
    action: () => {
      setRibbonLabelMode(getRibbonLabelMode() === "show" ? "hide" : "show");
    },
  });

  // The loader's own subscription fires for EVERY re-apply, including ones
  // that never emit APPEARANCE_CHANGED (a late registerSkin of the active
  // skin, an accessibility override).
  subscribeToAppearance(() => {
    clearRibbonMeasurements();
    const next = getRibbonLabelMode() === "show";
    if (next !== labelsChecked) {
      labelsChecked = next;
      updateMenuItem("view", RIBBON_LABELS_MENU_ITEM_ID, { checked: next });
    }
  });
}

let isBootstrapped = false;

/**
 * Bootstrap the Shell by registering all service implementations with the API layer.
 * This must be called once before any extensions are loaded or API functions are used.
 */
export function bootstrapShell(): void {
  if (isBootstrapped) {
    console.log("[Shell] Already bootstrapped, skipping.");
    return;
  }

  console.log("[Shell] Bootstrapping...");

  // =========================================================================
  // Register UI Services
  // =========================================================================

  // TaskPane Service - wraps the Zustand store and TaskPaneExtensions registry
  const taskPaneService: TaskPaneService = {
    registerView: (definition) => TaskPaneExtensionsImpl.registerView(definition),
    unregisterView: (viewId) => TaskPaneExtensionsImpl.unregisterView(viewId),
    getView: (viewId) => TaskPaneExtensionsImpl.getView(viewId),
    getAllViews: () => TaskPaneExtensionsImpl.getAllViews(),
    getViewsForContext: (keys) => TaskPaneExtensionsImpl.getViewsForContext(keys),
    openPane: (viewId, data) => useTaskPaneStore.getState().openPane(viewId, data),
    closePane: (viewId) => useTaskPaneStore.getState().closePane(viewId),
    open: () => useTaskPaneStore.getState().open(),
    close: () => useTaskPaneStore.getState().close(),
    isOpen: () => useTaskPaneStore.getState().isOpen,
    getManuallyClosed: () => useTaskPaneStore.getState().manuallyClosed,
    markManuallyClosed: (viewId) => useTaskPaneStore.getState().markManuallyClosed(viewId),
    clearManuallyClosed: (viewId) => useTaskPaneStore.getState().clearManuallyClosed(viewId),
    addActiveContextKey: (key) => useTaskPaneStore.getState().addActiveContextKey(key),
    removeActiveContextKey: (key) => useTaskPaneStore.getState().removeActiveContextKey(key),
    onRegistryChange: (listener) => TaskPaneExtensionsImpl.onRegistryChange(listener),
  };
  registerTaskPaneService(taskPaneService);

  // TaskPane React hooks
  registerTaskPaneHooks({
    useIsOpen: () => useTaskPaneStore((state) => state.isOpen),
    useOpenAction: () => useTaskPaneStore((state) => state.open),
    useCloseAction: () => useTaskPaneStore((state) => state.close),
    useOpenPaneIds: () => useTaskPaneStore(
      useShallow((state) => state.openPanes.map((p) => p.viewId)),
    ),
    useManuallyClosed: () => useTaskPaneStore((state) => state.manuallyClosed),
    useActiveContextKeys: () => useTaskPaneStore((state) => state.activeContextKeys),
  });

  // Dialog Service - maps getOpenDialogs to getVisibleDialogs
  const dialogService: DialogService = {
    registerDialog: (definition) => DialogExtensionsImpl.registerDialog(definition),
    unregisterDialog: (dialogId) => DialogExtensionsImpl.unregisterDialog(dialogId),
    openDialog: (dialogId, data) => DialogExtensionsImpl.openDialog(dialogId, data),
    closeDialog: (dialogId) => DialogExtensionsImpl.closeDialog(dialogId),
    getDialog: (dialogId) => DialogExtensionsImpl.getDialog(dialogId),
    getVisibleDialogs: () => {
      // Map from Shell's getOpenDialogs format to API's expected format
      return DialogExtensionsImpl.getOpenDialogs().map(({ definition, state }) => ({
        definition,
        data: state.data,
      }));
    },
    onChange: (listener) => DialogExtensionsImpl.onChange(listener),
  };
  registerDialogService(dialogService);

  // Overlay Service
  const overlayService: OverlayService = {
    registerOverlay: (definition) => OverlayExtensionsImpl.registerOverlay(definition),
    unregisterOverlay: (overlayId) => OverlayExtensionsImpl.unregisterOverlay(overlayId),
    showOverlay: (overlayId, options) => OverlayExtensionsImpl.showOverlay(overlayId, options),
    hideOverlay: (overlayId) => OverlayExtensionsImpl.hideOverlay(overlayId),
    hideAllOverlays: () => OverlayExtensionsImpl.hideAllOverlays(),
    getOverlay: (overlayId) => OverlayExtensionsImpl.getOverlay(overlayId),
    getVisibleOverlays: () => OverlayExtensionsImpl.getVisibleOverlays(),
    getAllOverlays: () => OverlayExtensionsImpl.getAllOverlays(),
    onChange: (listener) => OverlayExtensionsImpl.onChange(listener),
  };
  registerOverlayService(overlayService);

  // ActivityBar Service - routes registerView through PanelRegistry
  const activityBarService: ActivityBarService = {
    registerView: (definition) => {
      // Wrap the view component as a single section. Sidebar-origin views are
      // full-height vertical content (trees, editors, settings) — declared
      // "launcher" so the ribbon never probe-mounts them: their ribbon
      // projection is one launcher button opening the view in a flyout at
      // sidebar geometry. onClose/data/hidden flow through intact.
      const ViewComponent = definition.component;
      panelRegistry.registerPanel({
        id: definition.id,
        title: definition.title,
        icon: definition.icon,
        sections: [{
          id: definition.id + ".main",
          label: definition.title,
          icon: definition.icon,
          ribbonPresentation: "launcher",
          component: ({ placement, onClose, data }) =>
            React.createElement(ViewComponent, { onClose, data, placement }),
        }],
        defaultPlacement: "sidebar",
        priority: definition.priority,
        sidebarBottom: definition.bottom,
        hidden: definition.hidden,
        movable: true,
      });
    },
    unregisterView: (viewId) => panelRegistry.unregisterPanel(viewId),
    getView: (viewId) => ActivityBarExtensionsImpl.getView(viewId),
    getAllViews: () => ActivityBarExtensionsImpl.getAllViews(),
    openView: (viewId, data) => panelRegistry.openPanel(viewId, data),
    closeView: () => useActivityBarStore.getState().close(),
    toggle: (viewId) => useActivityBarStore.getState().toggle(viewId),
    isOpen: () => useActivityBarStore.getState().isOpen,
    getActiveViewId: () => useActivityBarStore.getState().activeViewId,
    onRegistryChange: (listener) => ActivityBarExtensionsImpl.onRegistryChange(listener),
  };
  registerActivityBarService(activityBarService);

  // ActivityBar React hooks
  registerActivityBarHooks({
    useIsOpen: () => useActivityBarStore((state) => state.isOpen),
    useActiveViewId: () => useActivityBarStore((state) => state.activeViewId),
  });

  // =========================================================================
  // Initialize Panel Registry (must be before extension services that route through it)
  // =========================================================================

  // Inject downstream dependencies so PanelRegistry can project into renderers
  // without circular imports.
  initPanelRegistry({
    activityBar: {
      registerView: (def) => ActivityBarExtensionsImpl.registerView(def),
      unregisterView: (id) => ActivityBarExtensionsImpl.unregisterView(id),
    },
    extensionRegistry: {
      registerRibbonTab: (tab) => ExtensionRegistryImpl.registerRibbonTab(tab),
      unregisterRibbonTab: (tabId) => ExtensionRegistryImpl.unregisterRibbonTab(tabId),
    },
    getActivityBarStore: () => useActivityBarStore.getState(),
  });

  // Panel Service - location-agnostic panel system
  registerPanelService(panelRegistry);

  // =========================================================================
  // Register Extension Services
  // =========================================================================

  // Extension Registry Service - ribbon tab/group registration routes through
  // PanelRegistry as measured sections (legacyRibbonRouting above).
  const extensionRegistryService: ExtensionRegistryService = {
    registerAddIn: (manifest) => legacyRibbonRouting.registerAddIn(manifest),
    unregisterAddIn: (addinId) => legacyRibbonRouting.unregisterAddIn(addinId),
    registerCommand: (command) => ExtensionRegistryImpl.registerCommand(command),
    getCommand: (commandId) => ExtensionRegistryImpl.getCommand(commandId),
    getAllCommands: () => ExtensionRegistryImpl.getAllCommands(),
    registerRibbonTab: (tab) => legacyRibbonRouting.registerRibbonTab(tab),
    unregisterRibbonTab: (tabId) => panelRegistry.unregisterPanel(tabId),
    registerRibbonGroup: (group) => legacyRibbonRouting.registerRibbonGroup(group),
    getRibbonTabs: () => ExtensionRegistryImpl.getRibbonTabs(),
    getRibbonGroupsForTab: (tabId) => ExtensionRegistryImpl.getRibbonGroupsForTab(tabId),
    notifySelectionChange: (selection) => ExtensionRegistryImpl.notifySelectionChange(selection),
    onSelectionChange: (callback) => ExtensionRegistryImpl.onSelectionChange(callback),
    onCellChange: (callback) => ExtensionRegistryImpl.onCellChange(callback),
    onRegistryChange: (callback) => ExtensionRegistryImpl.onRegistryChange(callback),
  };
  registerExtensionRegistryService(extensionRegistryService);

  // Register the host ExtensionManager behind its @api interface (IoC) so the
  // ExtensionsManager extension reaches it via getExtensionManager() — no api->shell.
  registerExtensionManager(ExtensionManager);

  // Expose extension registry for E2E invariant testing (mirrors __CALCULA_GRID_STATE__)
  (window as any).__CALCULA_EXTENSION_REGISTRY__ = extensionRegistryService;

  // Expose the panel registry for E2E placement setup/teardown (tests reset a
  // panel's persisted placement deterministically instead of via UI clicks).
  (window as any).__CALCULA_PANEL_REGISTRY__ = panelRegistry;

  // Expose the grid OVERLAY registry for the E2E residue guard
  // (e2e/tests/zz-workbook-residue.spec.ts). It is the only way to ask the
  // running app what floating objects are on the grid: a dynamic import of
  // gridOverlays.ts through the dev __calcImport bridge yields a SECOND module
  // instance with its own empty region list, so a guard built on that reads
  // zero regions no matter what is actually painted -- it passes vacuously,
  // which is worse than not existing. Measured, not assumed: the probe that
  // found this reported `regions: []` while a play pill was visibly on screen.
  (window as any).__CALCULA_GRID_OVERLAYS__ = { getGridRegions };

  // Grid Extensions Service - adapts Shell types to API types
  const gridExtensionsService: GridExtensionsService = {
    registerContextMenuItem: (item: GridContextMenuItem) => {
      gridExtensionsImpl.registerContextMenuItem(item as Parameters<typeof gridExtensionsImpl.registerContextMenuItem>[0]);
    },
    registerContextMenuItems: (items: GridContextMenuItem[]) => {
      gridExtensionsImpl.registerContextMenuItems(items as Parameters<typeof gridExtensionsImpl.registerContextMenuItems>[0]);
    },
    unregisterContextMenuItem: (id) => gridExtensionsImpl.unregisterContextMenuItem(id),
    getContextMenuItems: () => {
      return gridExtensionsImpl.getContextMenuItems() as GridContextMenuItem[];
    },
    getContextMenuItemsForContext: (context: GridMenuContext) => {
      return gridExtensionsImpl.getContextMenuItemsForContext(
        context as Parameters<typeof gridExtensionsImpl.getContextMenuItemsForContext>[0]
      ) as GridContextMenuItem[];
    },
    onChange: (callback) => gridExtensionsImpl.onChange(callback),
  };
  registerGridExtensionsService(gridExtensionsService);

  // Grid Commands Service
  const gridCommandsService: GridCommandsService = {
    register: (command: GridCommand, handler: () => void | Promise<void>) => {
      gridCommandsImpl.register(command, handler);
    },
    execute: (command: GridCommand) => gridCommandsImpl.execute(command),
    hasHandler: (command: GridCommand) => gridCommandsImpl.hasHandler(command),
    registerGuard: (commands: GridCommand[], guard: CommandGuard) =>
      gridCommandsImpl.registerGuard(commands, guard),
    setSelection: (selection) => gridCommandsImpl.setSelection(selection),
  };
  registerGridCommandsService(gridCommandsService);

  // Sheet Extensions Service
  const sheetExtensionsService: SheetExtensionsService = {
    registerContextMenuItem: (item) => sheetExtensionsImpl.registerContextMenuItem(item),
    unregisterContextMenuItem: (id) => sheetExtensionsImpl.unregisterContextMenuItem(id),
    getContextMenuItems: () => sheetExtensionsImpl.getContextMenuItems(),
    getContextMenuItemsForContext: (context) => sheetExtensionsImpl.getContextMenuItemsForContext(context),
  };
  registerSheetExtensionsService(sheetExtensionsService);

  // =========================================================================
  // Register Core Context Menus
  // =========================================================================

  registerCoreGridContextMenu();
  registerCoreSheetContextMenu();

  // Ribbon <-> appearance: measurement-cache clears on skin/label changes and
  // the View menu's "Show Ribbon Group Labels" item.
  wireRibbonAppearance();

  // Initialize centralized keybinding system
  initKeybindings();

  // Eagerly load locale settings so getCachedLocale() is available
  // for formula autocomplete hints and other synchronous locale consumers.
  getLocaleSettings();

  // C1a: bridge the backend "grid:refresh" Tauri event (emitted after an
  // OUT-OF-BAND cell write — e.g. an MCP/AI set_cell_value or run_script that
  // routed through the undoable edit pipeline) to the window "grid:refresh"
  // event the grid + extensions already re-fetch on. Registered once here at the
  // shell layer (not in any extension) so a single re-fetch fires; mirrors the
  // Charts extension's "charts:refresh" bridge.
  void listenTauriEvent("grid:refresh", () => {
    window.dispatchEvent(new Event("grid:refresh"));
  }).catch(() => {
    // No Tauri runtime (e.g. a non-webview/test context) — the bridge is a
    // no-op there; in-app writes still refresh through their return values.
  });

  // Workbook OPEN no longer blocks on HTTP registries: it walks local
  // registries inline and hands the HTTP ones to a worker
  // (calp_commands::rebuild_writeback_index_deferring_http). This bridge is how
  // the panes, the cell tints and the script host's cached copy of the index
  // learn that the deferred half finally landed — without it the regions are
  // installed in the backend but nothing on screen re-reads them, which looks
  // exactly like a package that declares no writeback.
  void listenTauriEvent("collaboration:writeback-index-changed", () => {
    emitAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, {});
  }).catch(() => {
    // No Tauri runtime (test context) — no deferred rebuild to bridge.
  });

  // 2f: bridge the backend's workbook dirty-state announcement, so the
  // title-bar asterisk tracks a mutation that never touched the frontend.
  // Layout.tsx already re-titles on DIRTY_STATE_CHANGED; see
  // shell/dirtyStateBridge.ts for why the backend side is ONE event.
  void bridgeDirtyStateAnnouncement();

  // 2g: bridge the backend's per-sheet DISPLAY FLAGS announcement, so the
  // renderer follows the authority when the authority is moved by something
  // other than the View menu (a script, an MCP tool, a package pull, an E2E
  // spec). See shell/sheetDisplayFlagsBridge.ts for the defect this closes.
  void bridgeSheetDisplayFlagsAnnouncement();

  // Bridge the backend's undo/redo AVAILABILITY announcement, so the ribbon's
  // Undo/Redo buttons and the Edit menu items reflect a stack the user really
  // has. The announcement comes from inside the undo store's own lock guard, so
  // a backend-only mutation (script, MCP tool, package pull, scheduled job)
  // greys the buttons exactly like a typed edit. See shell/undoStateBridge.ts.
  void bridgeUndoStateAnnouncement();

  // Model-extensibility Phase 1: bridge the Rust-emitted BI model lifecycle
  // events onto the @api event bus. The backend is the single emitter (its
  // model-install choke points fire exactly once per edit); this bridge is the
  // single re-emitter, so extension subscribers see each event once.
  void listenTauriEvent("bi:model-changed", (payload) => {
    emitAppEvent(AppEvents.BI_MODEL_CHANGED, payload);
  }).catch(() => {
    // No Tauri runtime (test context) — no BI backend, nothing to bridge.
  });
  void listenTauriEvent("bi:refresh-completed", (payload) => {
    emitAppEvent(AppEvents.BI_REFRESH_COMPLETED, payload);
  }).catch(() => {
    // No Tauri runtime (test context) — no BI backend, nothing to bridge.
  });

  // Tier-7 core-purity: Core no longer dispatches feature-named refresh events on
  // undo/redo/commit — it emits ONE generic MUTATION_REFRESH carrying a list of
  // change DOMAINS. This Shell-side translator (the orchestrator IS allowed to know
  // features) fans each domain out to the concrete per-feature refresh events the
  // extensions already listen to, so the extension subscribers are unchanged. Runs
  // synchronously within the same dispatch, so refresh timing is preserved.
  const MUTATION_DOMAIN_EVENTS: Record<MutationDomain, string[]> = {
    styles: ["styles:refresh"],
    pivot: ["pivot:refresh"],
    // TWO events, one domain. `ObjectKind::Slicer` and
    // `ObjectKind::TimelineSlicer` both map to "slicer" in
    // `app/src-tauri/src/object_deps.rs`, because a timeline whose pivot was
    // deleted is the same ghost overlay a canvas slicer is — and they are two
    // extensions with two caches. While this listed only the canvas slicer's
    // event, the domain's promise was true by accident: every route that
    // announced "slicer" happened to announce "pivot" as well, which is the
    // only event the TimelineSlicer extension was listening to.
    slicer: ["slicers:refresh", "timelineslicers:refresh"],
    ribbonFilter: ["filterpane:filters-refreshed"],
    paneControl: ["controlspane:controls-refreshed"],
    // "protection:refresh" is security-relevant, not cosmetic: the Protection
    // extension caches whether the active sheet is protected, and its edit
    // guard skips the backend check entirely when that cache reads "false".
    // Protection commands are undoable, so an undo can flip the backend record
    // with no sheet change — without this the cache would stay stale and the
    // guard would wave edits through on a re-protected sheet.
    // "insights:refresh": the Insights extension persists overlay comments in
    // its extension-data blob undoably; an undo restores the blob and this is
    // what tells the extension to re-read it.
    objects: ["charts:refresh", "sparklines:refresh", AppEvents.TABLE_DEFINITIONS_UPDATED, "animation:refresh", "grid:refresh", "protection:refresh", "insights:refresh"],
    // The four backend-state refresh announcements, reached from the UNDO
    // direction. Their forward routes emit them from the IPC wrapper; undo
    // and redo do not go through those wrappers at all (one `undo` command
    // restores every domain at once), so the Rust result reports the domains
    // it touched and they are translated to the very same events the
    // extensions already listen to.
    outline: [AppEvents.OUTLINE_CHANGED],
    hyperlinks: [AppEvents.HYPERLINKS_CHANGED],
    validations: [AppEvents.VALIDATIONS_CHANGED],
    annotations: [AppEvents.ANNOTATIONS_CHANGED],
    controls: [AppEvents.CONTROLS_CHANGED, "grid:refresh"],
    // Undoing an add/delete/reorder of a conditional-formatting rule changes
    // the rule LIST, not just the values it paints — the extension has to
    // re-read it, which is what CONDITIONAL_FORMATS_CHANGED asks for.
    conditionalFormats: [AppEvents.CONDITIONAL_FORMATS_CHANGED],
    // The sheet COLLECTION changed (added / renamed / moved / deleted). TWO
    // events: "sheets:refresh" reloads the tab bar's list, and SHEET_CHANGED is
    // what every per-sheet extension cache (conditional formats, validations,
    // annotations, controls, protection) already re-reads on -- and their entries
    // were just remapped by `remap_sheet_keyed_stores` under them. Dispatched
    // WITHOUT a detail, as every domain event is; each SHEET_CHANGED consumer
    // guards on `typeof detail?.sheetIndex === "number"` before using it.
    sheets: ["sheets:refresh", AppEvents.SHEET_CHANGED],
    namedRanges: [AppEvents.NAMED_RANGES_CHANGED],
    // Floating range object rows (geometry/window/existence). The extension
    // reloads its row store on the CHANGED event; grid:refresh repaints the
    // overlay (and refetches cells — an undone resize can reveal cells the
    // cache never held).
    floatingRanges: [AppEvents.FLOATING_RANGES_CHANGED, "grid:refresh"],
    // Geometry. `dimensions:refresh` is the bare window event the Spreadsheet
    // already listens to (`Spreadsheet.tsx`) and that every FORWARD dimension
    // route dispatches — `grid.ts` after a width/height write, and
    // `gridExtensions.ts` after an extension's. Undo was the one direction that
    // never fired it, because these restore kinds announced no domain at all.
    dimensions: ["dimensions:refresh"],
  };
  const fanOutDomains = (domains: readonly MutationDomain[] | undefined): void => {
    const fired = new Set<string>();
    for (const domain of domains ?? []) {
      for (const evt of MUTATION_DOMAIN_EVENTS[domain] ?? []) {
        if (fired.has(evt)) continue; // de-dupe if domains ever share an event
        fired.add(evt);
        window.dispatchEvent(new CustomEvent(evt));
      }
    }
  };
  onAppEvent<MutationRefreshPayload>(AppEvents.MUTATION_REFRESH, (payload) => {
    fanOutDomains(payload?.domains);
  });

  // §3cd: THE BACKEND-INITIATED HALF of the same announcement.
  //
  // A mutation the FRONTEND starts announces on the way back, and
  // `cascadeAnnouncementCensus.test.ts` proves every delete route does. A
  // mutation started INSIDE the backend — an MCP tool driven by an AI client,
  // with no frontend call to return from — has nothing to hook that onto, so
  // `object_deps::announce_cascade` emits the identical payload as a Tauri
  // event and it lands in the SAME translator. One mapping from domains to
  // feature events, reached from both directions; the alternative was the
  // per-kind bespoke Tauri events that preceded this, one of which
  // ("sheets:refresh") nothing had ever listened to.
  void listenTauriEvent<MutationRefreshPayload>("mutation:refresh", (payload) => {
    fanOutDomains(payload?.domains);
  }).catch(() => {
    // No Tauri runtime (test context) — nothing backend-initiated to bridge.
  });

  isBootstrapped = true;
  console.log("[Shell] Bootstrap complete.");
}

/**
 * Check if the Shell has been bootstrapped.
 */
export function isShellBootstrapped(): boolean {
  return isBootstrapped;
}