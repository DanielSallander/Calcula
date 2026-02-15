//! FILENAME: app/src/shell/bootstrap.ts
// PURPOSE: Bootstrap function that registers Shell implementations with the API layer.
// CONTEXT: Called once at application startup before extensions are loaded.
// NOTE: This is the Inversion of Control wiring - Shell owns implementations,
//       API defines contracts, this file connects them.

import {
  registerTaskPaneService,
  registerDialogService,
  registerOverlayService,
  registerTaskPaneHooks,
  type TaskPaneService,
  type DialogService,
  type OverlayService,
} from "../api/ui";

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
  type GridMenuContext,
  type GridContextMenuItem,
} from "../api/extensions";

import { shallow } from "zustand/shallow";

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
      (state) => state.openPanes.map((p) => p.viewId),
      shallow,
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

  // =========================================================================
  // Register Extension Services
  // =========================================================================

  // Extension Registry Service
  const extensionRegistryService: ExtensionRegistryService = {
    registerAddIn: (manifest) => ExtensionRegistryImpl.registerAddIn(manifest),
    unregisterAddIn: (addinId) => ExtensionRegistryImpl.unregisterAddIn(addinId),
    registerCommand: (command) => ExtensionRegistryImpl.registerCommand(command),
    getCommand: (commandId) => ExtensionRegistryImpl.getCommand(commandId),
    getAllCommands: () => ExtensionRegistryImpl.getAllCommands(),
    registerRibbonTab: (tab) => ExtensionRegistryImpl.registerRibbonTab(tab),
    unregisterRibbonTab: (tabId) => ExtensionRegistryImpl.unregisterRibbonTab(tabId),
    registerRibbonGroup: (group) => ExtensionRegistryImpl.registerRibbonGroup(group),
    getRibbonTabs: () => ExtensionRegistryImpl.getRibbonTabs(),
    getRibbonGroupsForTab: (tabId) => ExtensionRegistryImpl.getRibbonGroupsForTab(tabId),
    notifySelectionChange: (selection) => ExtensionRegistryImpl.notifySelectionChange(selection),
    onSelectionChange: (callback) => ExtensionRegistryImpl.onSelectionChange(callback),
    onCellChange: (callback) => ExtensionRegistryImpl.onCellChange(callback),
    onRegistryChange: (callback) => ExtensionRegistryImpl.onRegistryChange(callback),
  };
  registerExtensionRegistryService(extensionRegistryService);

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

  isBootstrapped = true;
  console.log("[Shell] Bootstrap complete.");
}

/**
 * Check if the Shell has been bootstrapped.
 */
export function isShellBootstrapped(): boolean {
  return isBootstrapped;
}