//! FILENAME: app/src/api/ui.ts
// PURPOSE: UI registration APIs for extensions.
// CONTEXT: Extensions use these to register task panes, dialogs, overlays, and menus.
// FIX: Uses IoC pattern - Shell registers implementations at startup.
// FIX: Provides facade objects (TaskPaneExtensions, DialogExtensions, OverlayExtensions)
//      that delegate to registered services for backward compatibility.

import type {
  TaskPaneViewDefinition,
  DialogDefinition,
  OverlayDefinition,
  AnchorRect,
  MenuDefinition,
  MenuItemDefinition,
  TaskPaneContextKey,
  StatusBarItemDefinition,
} from "./uiTypes";

// Re-export types from the canonical contract layer (api/uiTypes.ts)
export type {
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
  DialogDefinition,
  DialogProps,
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
  MenuDefinition,
  MenuItemDefinition,
  StatusBarItemDefinition,
  StatusBarAlignment,
} from "./uiTypes";

// ============================================================================
// Service Interfaces (Contracts for Shell to implement)
// ============================================================================

export interface TaskPaneService {
  registerView(definition: TaskPaneViewDefinition): void;
  unregisterView(viewId: string): void;
  getView(viewId: string): TaskPaneViewDefinition | undefined;
  getAllViews(): TaskPaneViewDefinition[];
  getViewsForContext(activeContextKeys: TaskPaneContextKey[]): TaskPaneViewDefinition[];
  openPane(viewId: string, data?: Record<string, unknown>): void;
  closePane(viewId: string): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  getManuallyClosed(): string[];
  markManuallyClosed(viewId: string): void;
  clearManuallyClosed(viewId: string): void;
  addActiveContextKey(key: TaskPaneContextKey): void;
  removeActiveContextKey(key: TaskPaneContextKey): void;
  onRegistryChange(listener: () => void): () => void;
}

export interface DialogService {
  registerDialog(definition: DialogDefinition): void;
  unregisterDialog(dialogId: string): void;
  openDialog(dialogId: string, data?: Record<string, unknown>): void;
  closeDialog(dialogId: string): void;
  getDialog(dialogId: string): DialogDefinition | undefined;
  getVisibleDialogs(): Array<{ definition: DialogDefinition; data?: Record<string, unknown> }>;
  onChange(listener: () => void): () => void;
}

export interface OverlayService {
  registerOverlay(definition: OverlayDefinition): void;
  unregisterOverlay(overlayId: string): void;
  showOverlay(overlayId: string, options: { data?: Record<string, unknown>; anchorRect?: AnchorRect }): void;
  hideOverlay(overlayId: string): void;
  hideAllOverlays(): void;
  getOverlay(overlayId: string): OverlayDefinition | undefined;
  getVisibleOverlays(): Array<{ definition: OverlayDefinition; state: { isVisible: boolean; data?: Record<string, unknown>; anchorRect?: AnchorRect } }>;
  getAllOverlays(): OverlayDefinition[];
  onChange(listener: () => void): () => void;
}

// ============================================================================
// Service Registration (IoC pattern)
// ============================================================================

let taskPaneService: TaskPaneService | undefined;
let dialogService: DialogService | undefined;
let overlayService: OverlayService | undefined;

// React hook providers (optional, registered by Shell)
let useIsTaskPaneOpenHook: () => boolean = () => false;
let useOpenTaskPaneActionHook: () => () => void = () => () => {};
let useCloseTaskPaneActionHook: () => () => void = () => () => {};
let useTaskPaneOpenPaneIdsHook: () => string[] = () => [];
let useTaskPaneManuallyClosedHook: () => string[] = () => [];
let useTaskPaneActiveContextKeysHook: () => TaskPaneContextKey[] = () => [];

/**
 * Register the TaskPane service implementation (called by Shell at startup).
 */
export function registerTaskPaneService(service: TaskPaneService): void {
  taskPaneService = service;
}

/**
 * Register the Dialog service implementation (called by Shell at startup).
 */
export function registerDialogService(service: DialogService): void {
  dialogService = service;
}

/**
 * Register the Overlay service implementation (called by Shell at startup).
 */
export function registerOverlayService(service: OverlayService): void {
  overlayService = service;
}

/**
 * Register React hooks for TaskPane (called by Shell at startup).
 */
export function registerTaskPaneHooks(hooks: {
  useIsOpen: () => boolean;
  useOpenAction: () => () => void;
  useCloseAction: () => () => void;
  useOpenPaneIds?: () => string[];
  useManuallyClosed?: () => string[];
  useActiveContextKeys?: () => TaskPaneContextKey[];
}): void {
  useIsTaskPaneOpenHook = hooks.useIsOpen;
  useOpenTaskPaneActionHook = hooks.useOpenAction;
  useCloseTaskPaneActionHook = hooks.useCloseAction;
  if (hooks.useOpenPaneIds) useTaskPaneOpenPaneIdsHook = hooks.useOpenPaneIds;
  if (hooks.useManuallyClosed) useTaskPaneManuallyClosedHook = hooks.useManuallyClosed;
  if (hooks.useActiveContextKeys) useTaskPaneActiveContextKeysHook = hooks.useActiveContextKeys;
}

// ============================================================================
// Menu Registry (Internal State - self-contained in API)
// ============================================================================

class MenuRegistry {
  private menus: Map<string, MenuDefinition> = new Map();
  private listeners: Set<() => void> = new Set();

  registerMenu(menu: MenuDefinition): void {
    this.menus.set(menu.id, menu);
    this.notify();
  }

  registerMenuItem(menuId: string, item: MenuItemDefinition): void {
    const menu = this.menus.get(menuId);
    if (menu) {
      menu.items.push(item);
      this.notify();
    } else {
      console.warn(`[MenuRegistry] Cannot register item. Menu '${menuId}' not found.`);
    }
  }

  getMenus(): MenuDefinition[] {
    return Array.from(this.menus.values()).sort((a, b) => a.order - b.order);
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

const menuRegistry = new MenuRegistry();

// ============================================================================
// Menu API Exports
// ============================================================================

export function registerMenu(definition: MenuDefinition): void {
  menuRegistry.registerMenu(definition);
}

export function registerMenuItem(menuId: string, item: MenuItemDefinition): void {
  menuRegistry.registerMenuItem(menuId, item);
}

export function getMenus(): MenuDefinition[] {
  return menuRegistry.getMenus();
}

export function subscribeToMenus(callback: () => void): () => void {
  return menuRegistry.subscribe(callback);
}

// ============================================================================
// TaskPaneExtensions Facade (for backward compatibility)
// ============================================================================

export const TaskPaneExtensions = {
  registerView(definition: TaskPaneViewDefinition): void {
    if (!taskPaneService) {
      console.warn("[API] TaskPaneService not registered. Call registerTaskPaneService first.");
      return;
    }
    taskPaneService.registerView(definition);
  },

  unregisterView(viewId: string): void {
    taskPaneService?.unregisterView(viewId);
  },

  getView(viewId: string): TaskPaneViewDefinition | undefined {
    return taskPaneService?.getView(viewId);
  },

  getAllViews(): TaskPaneViewDefinition[] {
    return taskPaneService?.getAllViews() ?? [];
  },

  getViewsForContext(activeContextKeys: TaskPaneContextKey[]): TaskPaneViewDefinition[] {
    return taskPaneService?.getViewsForContext(activeContextKeys) ?? [];
  },

  onRegistryChange(listener: () => void): () => void {
    return taskPaneService?.onRegistryChange(listener) ?? (() => {});
  },

  clear(): void {
    // No-op for API facade - Shell owns the actual registry
    console.warn("[API] TaskPaneExtensions.clear() is not supported via API facade");
  },
};

// ============================================================================
// DialogExtensions Facade (for backward compatibility)
// ============================================================================

export const DialogExtensions = {
  registerDialog(definition: DialogDefinition): void {
    if (!dialogService) {
      console.warn("[API] DialogService not registered. Call registerDialogService first.");
      return;
    }
    dialogService.registerDialog(definition);
  },

  unregisterDialog(dialogId: string): void {
    dialogService?.unregisterDialog(dialogId);
  },

  openDialog(dialogId: string, data?: Record<string, unknown>): void {
    dialogService?.openDialog(dialogId, data);
  },

  closeDialog(dialogId: string): void {
    dialogService?.closeDialog(dialogId);
  },

  getDialog(dialogId: string): DialogDefinition | undefined {
    return dialogService?.getDialog(dialogId);
  },

  getVisibleDialogs(): Array<{ definition: DialogDefinition; data?: Record<string, unknown> }> {
    return dialogService?.getVisibleDialogs() ?? [];
  },

  onChange(listener: () => void): () => void {
    return dialogService?.onChange(listener) ?? (() => {});
  },
};

// ============================================================================
// OverlayExtensions Facade (for backward compatibility)
// ============================================================================

export const OverlayExtensions = {
  registerOverlay(definition: OverlayDefinition): void {
    if (!overlayService) {
      console.warn("[API] OverlayService not registered. Call registerOverlayService first.");
      return;
    }
    overlayService.registerOverlay(definition);
  },

  unregisterOverlay(overlayId: string): void {
    overlayService?.unregisterOverlay(overlayId);
  },

  showOverlay(overlayId: string, options?: { data?: Record<string, unknown>; anchorRect?: AnchorRect }): void {
    overlayService?.showOverlay(overlayId, options ?? {});
  },

  hideOverlay(overlayId: string): void {
    overlayService?.hideOverlay(overlayId);
  },

  hideAllOverlays(): void {
    overlayService?.hideAllOverlays();
  },

  getOverlay(overlayId: string): OverlayDefinition | undefined {
    return overlayService?.getOverlay(overlayId);
  },

  getVisibleOverlays(): Array<{ definition: OverlayDefinition; state: { isVisible: boolean; data?: Record<string, unknown>; anchorRect?: AnchorRect } }> {
    return overlayService?.getVisibleOverlays() ?? [];
  },

  getAllOverlays(): OverlayDefinition[] {
    return overlayService?.getAllOverlays() ?? [];
  },

  onChange(listener: () => void): () => void {
    return overlayService?.onChange(listener) ?? (() => {});
  },
};

// ============================================================================
// Task Pane Function API (convenience wrappers)
// ============================================================================

export function registerTaskPane(definition: TaskPaneViewDefinition): void {
  TaskPaneExtensions.registerView(definition);
}

export function unregisterTaskPane(viewId: string): void {
  TaskPaneExtensions.unregisterView(viewId);
}

export function openTaskPane(viewId: string, data?: Record<string, unknown>): void {
  taskPaneService?.openPane(viewId, data);
}

export function closeTaskPane(viewId: string): void {
  taskPaneService?.closePane(viewId);
}

export function getTaskPane(viewId: string): TaskPaneViewDefinition | undefined {
  return TaskPaneExtensions.getView(viewId);
}

export function showTaskPaneContainer(): void {
  taskPaneService?.open();
}

export function hideTaskPaneContainer(): void {
  taskPaneService?.close();
}

export function isTaskPaneContainerOpen(): boolean {
  return taskPaneService?.isOpen() ?? false;
}

export function getTaskPaneManuallyClosed(): string[] {
  return taskPaneService?.getManuallyClosed() ?? [];
}

export function clearTaskPaneManuallyClosed(viewId: string): void {
  taskPaneService?.clearManuallyClosed(viewId);
}

export function markTaskPaneManuallyClosed(viewId: string): void {
  taskPaneService?.markManuallyClosed(viewId);
}

export function addTaskPaneContextKey(key: TaskPaneContextKey): void {
  taskPaneService?.addActiveContextKey(key);
}

export function removeTaskPaneContextKey(key: TaskPaneContextKey): void {
  taskPaneService?.removeActiveContextKey(key);
}

// React hooks (delegate to registered implementations)
// Default no-op hooks are used before shell initialization completes
export function useIsTaskPaneOpen(): boolean {
  return useIsTaskPaneOpenHook();
}

export function useOpenTaskPaneAction(): () => void {
  return useOpenTaskPaneActionHook();
}

export function useCloseTaskPaneAction(): () => void {
  return useCloseTaskPaneActionHook();
}

export function useTaskPaneOpenPaneIds(): string[] {
  return useTaskPaneOpenPaneIdsHook();
}

export function useTaskPaneManuallyClosed(): string[] {
  return useTaskPaneManuallyClosedHook();
}

export function useTaskPaneActiveContextKeys(): TaskPaneContextKey[] {
  return useTaskPaneActiveContextKeysHook();
}

// ============================================================================
// Dialog Function API (convenience wrappers)
// ============================================================================

export function registerDialog(definition: DialogDefinition): void {
  DialogExtensions.registerDialog(definition);
}

export function unregisterDialog(dialogId: string): void {
  DialogExtensions.unregisterDialog(dialogId);
}

export function showDialog(dialogId: string, data?: Record<string, unknown>): void {
  DialogExtensions.openDialog(dialogId, data);
}

export function hideDialog(dialogId: string): void {
  DialogExtensions.closeDialog(dialogId);
}

// ============================================================================
// Overlay Function API (convenience wrappers)
// ============================================================================

export function registerOverlay(definition: OverlayDefinition): void {
  OverlayExtensions.registerOverlay(definition);
}

export function unregisterOverlay(overlayId: string): void {
  OverlayExtensions.unregisterOverlay(overlayId);
}

export function showOverlay(overlayId: string, options: { data?: Record<string, unknown>; anchorRect?: AnchorRect }): void {
  OverlayExtensions.showOverlay(overlayId, options);
}

export function hideOverlay(overlayId: string): void {
  OverlayExtensions.hideOverlay(overlayId);
}

export function hideAllOverlays(): void {
  OverlayExtensions.hideAllOverlays();
}

// ============================================================================
// Status Bar Registry (Self-contained, like MenuRegistry)
// ============================================================================

class StatusBarRegistry {
  private items: Map<string, StatusBarItemDefinition> = new Map();
  private listeners: Set<() => void> = new Set();

  registerItem(definition: StatusBarItemDefinition): void {
    this.items.set(definition.id, definition);
    this.notify();
  }

  unregisterItem(id: string): void {
    if (this.items.delete(id)) {
      this.notify();
    }
  }

  getItems(): StatusBarItemDefinition[] {
    return Array.from(this.items.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

const statusBarRegistry = new StatusBarRegistry();

// ============================================================================
// Status Bar API Exports
// ============================================================================

export function registerStatusBarItem(definition: StatusBarItemDefinition): void {
  statusBarRegistry.registerItem(definition);
}

export function unregisterStatusBarItem(id: string): void {
  statusBarRegistry.unregisterItem(id);
}

export function getStatusBarItems(): StatusBarItemDefinition[] {
  return statusBarRegistry.getItems();
}

export function subscribeToStatusBar(callback: () => void): () => void {
  return statusBarRegistry.subscribe(callback);
}