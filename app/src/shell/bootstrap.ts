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
  type TaskPaneService,
  type DialogService,
  type OverlayService,
  type ActivityBarService,
} from "../api/ui";

import { initKeybindings } from "../api/keybindings";
import { getLocaleSettings } from "../api/locale";
import { listenTauriEvent } from "../api/backend";

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
} from "../api/extensions";

import { useShallow } from "zustand/react/shallow";

// Shell implementations
import { useTaskPaneStore } from "./TaskPane/useTaskPaneStore";
import { TaskPaneExtensions as TaskPaneExtensionsImpl } from "./registries/taskPaneExtensions";
import { DialogExtensions as DialogExtensionsImpl } from "./registries/dialogExtensions";
import { OverlayExtensions as OverlayExtensionsImpl } from "./registries/overlayExtensions";
import { ExtensionRegistry as ExtensionRegistryImpl } from "./registries/ExtensionRegistry";
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
import type { PanelSection, PanelSectionProps } from "../api/uiTypes";
import type { RibbonGroupDefinition, RibbonTabDefinition as ShellRibbonTabDef } from "./registries/types";
import { useGridState } from "../api/state";

/**
 * Wraps a RibbonGroupDefinition component (expects RibbonContext) into a
 * PanelSection component (expects PanelSectionProps). The wrapper provides
 * the RibbonContext from the grid state hook.
 */
function wrapRibbonGroupAsSection(group: RibbonGroupDefinition): PanelSection {
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
    component: SectionAdapter,
  };
}

/**
 * Wraps an entire ribbon tab component as a single PanelSection.
 */
function wrapRibbonTabAsSection(tab: { id: string; label: string; component: React.ComponentType<any> }): PanelSection {
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
    component: SectionAdapter,
  };
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
      // Wrap the view component as a single section
      const ViewComponent = definition.component;
      panelRegistry.registerPanel({
        id: definition.id,
        title: definition.title,
        icon: definition.icon,
        sections: [{
          id: definition.id + ".main",
          label: definition.title,
          component: ({ placement }) => {
            if (placement === "ribbon") {
              // Sidebar panels in ribbon: force horizontal flow with CSS overrides
              return React.createElement("div", {
                className: "sidebar-panel-in-ribbon",
                style: { height: "100%", overflow: "hidden" },
              },
                React.createElement("style", null, `
                  .sidebar-panel-in-ribbon > div {
                    flex-direction: row !important;
                    height: 100% !important;
                    overflow-x: auto !important;
                    overflow-y: hidden !important;
                    padding: 4px 8px !important;
                    gap: 16px !important;
                    flex-wrap: nowrap !important;
                    align-items: flex-start !important;
                  }
                  .sidebar-panel-in-ribbon > div > div {
                    flex-shrink: 0 !important;
                    min-width: fit-content !important;
                  }
                `),
                React.createElement(ViewComponent, { onClose: undefined, data: undefined, placement }),
              );
            }
            return React.createElement(ViewComponent, { onClose: undefined, data: undefined, placement });
          },
        }],
        defaultPlacement: "sidebar",
        priority: definition.priority,
        sidebarBottom: definition.bottom,
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

  // Extension Registry Service - ribbon tab/group registration routes through PanelRegistry
  const extensionRegistryService: ExtensionRegistryService = {
    registerAddIn: (manifest) => {
      // Store manifest for bookkeeping (dependency checks, getRegisteredAddIns)
      // and register commands. We bypass its ribbon tab/group registration since
      // we route those through PanelRegistry as sections.
      ExtensionRegistryImpl.registerAddIn(manifest);

      // Route ribbon tabs through PanelRegistry with sections
      if (manifest.ribbonTabs) {
        for (const tab of manifest.ribbonTabs) {
          const tabGroups = (manifest.ribbonGroups ?? [])
            .filter((g) => g.tabId === tab.id)
            .sort((a, b) => a.order - b.order);

          // Convert each group to a section, or wrap entire tab as single section
          const sections: PanelSection[] = tabGroups.length > 0
            ? tabGroups.map(wrapRibbonGroupAsSection)
            : [wrapRibbonTabAsSection(tab)];

          panelRegistry.registerPanel({
            id: tab.id,
            title: tab.label,
            icon: null as any,
            sections,
            defaultPlacement: "ribbon",
            ribbonOrder: tab.order,
            ribbonColor: tab.color,
            priority: 1000 - tab.order,
          });
        }
      }
    },
    unregisterAddIn: (addinId) => {
      const manifest = ExtensionRegistryImpl.getRegisteredAddIns().find((m) => m.id === addinId);
      if (manifest) {
        manifest.ribbonTabs?.forEach((tab) => panelRegistry.unregisterPanel(tab.id));
      }
      ExtensionRegistryImpl.unregisterAddIn(addinId);
    },
    registerCommand: (command) => ExtensionRegistryImpl.registerCommand(command),
    getCommand: (commandId) => ExtensionRegistryImpl.getCommand(commandId),
    getAllCommands: () => ExtensionRegistryImpl.getAllCommands(),
    registerRibbonTab: (tab) => {
      // Wrap entire tab component as a single section
      panelRegistry.registerPanel({
        id: tab.id,
        title: tab.label,
        icon: null as any,
        sections: [wrapRibbonTabAsSection(tab)],
        defaultPlacement: "ribbon",
        ribbonOrder: tab.order,
        ribbonColor: tab.color,
        priority: 1000 - tab.order,
      });
    },
    unregisterRibbonTab: (tabId) => panelRegistry.unregisterPanel(tabId),
    registerRibbonGroup: (group) => {
      // Groups registered after their tab — add as a new section to the existing panel
      const panel = panelRegistry.getPanel(group.tabId);
      if (panel) {
        const newSection = wrapRibbonGroupAsSection(group);
        // If panel currently has a single "main" section (wrapped tab), replace it
        // since individual groups are being registered and should take precedence
        const sections = panel.sections.length === 1 && panel.sections[0].id.endsWith(".main")
          ? [newSection]
          : [...panel.sections.filter((s) => s.id !== newSection.id), newSection];
        panelRegistry.registerPanel({ ...panel, sections });
      } else {
        // Tab not registered yet — register directly into ExtensionRegistryImpl
        // (it will be picked up when the tab is registered)
        ExtensionRegistryImpl.registerRibbonGroup(group);
      }
    },
    getRibbonTabs: () => ExtensionRegistryImpl.getRibbonTabs(),
    getRibbonGroupsForTab: (tabId) => ExtensionRegistryImpl.getRibbonGroupsForTab(tabId),
    notifySelectionChange: (selection) => ExtensionRegistryImpl.notifySelectionChange(selection),
    onSelectionChange: (callback) => ExtensionRegistryImpl.onSelectionChange(callback),
    onCellChange: (callback) => ExtensionRegistryImpl.onCellChange(callback),
    onRegistryChange: (callback) => ExtensionRegistryImpl.onRegistryChange(callback),
  };
  registerExtensionRegistryService(extensionRegistryService);

  // Expose extension registry for E2E invariant testing (mirrors __CALCULA_GRID_STATE__)
  (window as any).__CALCULA_EXTENSION_REGISTRY__ = extensionRegistryService;

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

  isBootstrapped = true;
  console.log("[Shell] Bootstrap complete.");
}

/**
 * Check if the Shell has been bootstrapped.
 */
export function isShellBootstrapped(): boolean {
  return isBootstrapped;
}