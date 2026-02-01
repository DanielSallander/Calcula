//! FILENAME: app/src/api/ui.ts
// PURPOSE: UI registration APIs for extensions.
// CONTEXT: Extensions use these to register task panes, dialogs, overlays, and MENUS.
// NOTE: Imports from shell/registries, NOT core/registry (per microkernel architecture).

import { TaskPaneExtensions } from "../shell/registries/taskPaneExtensions";
import { DialogExtensions } from "../shell/registries/dialogExtensions";
import { OverlayExtensions } from "../shell/registries/overlayExtensions";
import { useTaskPaneStore } from "../shell/TaskPane/useTaskPaneStore";
import type { TaskPaneViewDefinition, DialogDefinition, OverlayDefinition, AnchorRect } from "./uiTypes";

// Re-export the extension registries
export { TaskPaneExtensions, DialogExtensions, OverlayExtensions };

// Re-export types from the canonical contract layer (api/uiTypes.ts)
export type { TaskPaneViewDefinition, TaskPaneViewProps, TaskPaneContextKey } from "./uiTypes";
export type { DialogDefinition, DialogProps } from "./uiTypes";
export type { OverlayDefinition, OverlayProps, OverlayLayer, AnchorRect } from "./uiTypes";

// ============================================================================
// Menu API Definitions
// ============================================================================

export interface MenuItemDefinition {
  id: string;
  label: string;
  commandId?: string; // The preferred way: execute a registered command
  action?: () => void; // Legacy/Simple way: direct callback
  icon?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  shortcut?: string; // e.g. "Ctrl+S"
  hidden?: boolean;
}

export interface MenuDefinition {
  id: string;
  label: string;
  order: number;
  items: MenuItemDefinition[];
}

// Internal State for Menus (Simple Store Pattern)
// In a future refactor, this could move to shell/registries/MenuRegistry.ts
class MenuRegistry {
  private menus: Map<string, MenuDefinition> = new Map();
  private listeners: Set<() => void> = new Set();

  registerMenu(menu: MenuDefinition) {
    this.menus.set(menu.id, menu);
    this.notify();
  }

  registerMenuItem(menuId: string, item: MenuItemDefinition) {
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

  private notify() {
    this.listeners.forEach((cb) => cb());
  }
}

const menuRegistry = new MenuRegistry();

// ============================================================================
// Menu API Exports
// ============================================================================

/**
 * Register a top-level menu (e.g., "File", "Edit").
 */
export function registerMenu(definition: MenuDefinition): void {
  menuRegistry.registerMenu(definition);
}

/**
 * Add an item to an existing menu.
 */
export function registerMenuItem(menuId: string, item: MenuItemDefinition): void {
  menuRegistry.registerMenuItem(menuId, item);
}

/**
 * Get all registered menus (sorted by order).
 */
export function getMenus(): MenuDefinition[] {
  return menuRegistry.getMenus();
}

/**
 * Subscribe to menu changes (for React components).
 */
export function subscribeToMenus(callback: () => void): () => void {
  return menuRegistry.subscribe(callback);
}

// ============================================================================
// Task Pane API
// ============================================================================

export function registerTaskPane(definition: TaskPaneViewDefinition): void {
  TaskPaneExtensions.registerView(definition);
}

export function unregisterTaskPane(viewId: string): void {
  TaskPaneExtensions.unregisterView(viewId);
}

export function openTaskPane(viewId: string, data?: Record<string, unknown>): void {
  useTaskPaneStore.getState().openPane(viewId, data);
}

export function closeTaskPane(viewId: string): void {
  useTaskPaneStore.getState().closePane(viewId);
}

export function getTaskPane(viewId: string): TaskPaneViewDefinition | undefined {
  return TaskPaneExtensions.getView(viewId);
}

// ============================================================================
// Dialog API
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
// Overlay API
// ============================================================================

export function registerOverlay(definition: OverlayDefinition): void {
  OverlayExtensions.registerOverlay(definition);
}

export function unregisterOverlay(overlayId: string): void {
  OverlayExtensions.unregisterOverlay(overlayId);
}

export function showOverlay(overlayId: string, options: { data?: Record<string, unknown>; anchorRect?: AnchorRect; }): void {
  OverlayExtensions.showOverlay(overlayId, options);
}

export function hideOverlay(overlayId: string): void {
  OverlayExtensions.hideOverlay(overlayId);
}

export function hideAllOverlays(): void {
  OverlayExtensions.hideAllOverlays();
}

// ============================================================================
// Task Pane API - Additional accessors for extensions
// ============================================================================

/**
 * Show the task pane container (not a specific view).
 */
export function showTaskPaneContainer(): void {
  useTaskPaneStore.getState().open();
}

/**
 * Hide the task pane container.
 */
export function hideTaskPaneContainer(): void {
  useTaskPaneStore.getState().close();
}

/**
 * Check if the task pane container is currently open (sync, non-reactive).
 */
export function isTaskPaneContainerOpen(): boolean {
  return useTaskPaneStore.getState().isOpen;
}

/**
 * Get the list of manually closed view IDs.
 */
export function getTaskPaneManuallyClosed(): string[] {
  return useTaskPaneStore.getState().manuallyClosed;
}

/**
 * Clear the manually-closed flag for a specific view.
 */
export function clearTaskPaneManuallyClosed(viewId: string): void {
  useTaskPaneStore.getState().clearManuallyClosed(viewId);
}

/**
 * React hook: is the task pane container open? (reactive)
 */
export function useIsTaskPaneOpen(): boolean {
  return useTaskPaneStore((state) => state.isOpen);
}

/**
 * React hook: get the open action for the task pane container. (reactive)
 */
export function useOpenTaskPaneAction(): () => void {
  return useTaskPaneStore((state) => state.open);
}

/**
 * React hook: get the close action for the task pane container. (reactive)
 */
export function useCloseTaskPaneAction(): () => void {
  return useTaskPaneStore((state) => state.close);
}