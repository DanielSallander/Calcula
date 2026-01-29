//! FILENAME: app/src/api/ui.ts
// PURPOSE: UI registration APIs for extensions.
// CONTEXT: Extensions use these to register task panes, dialogs, overlays, and MENUS.

import { TaskPaneExtensions } from "../core/extensions/taskPaneExtensions";
import { DialogExtensions } from "../core/extensions/dialogExtensions";
import { OverlayExtensions } from "../core/extensions/overlayExtensions";
import { useTaskPaneStore } from "../shell/task-pane/useTaskPaneStore";

// Re-export the extension registries
export { TaskPaneExtensions, DialogExtensions, OverlayExtensions };

// Re-export types
export type { TaskPaneViewDefinition, TaskPaneViewProps, TaskPaneContextKey } from "../core/extensions/taskPaneExtensions";
export type { DialogDefinition, DialogProps } from "../core/extensions/dialogExtensions";
export type { OverlayDefinition, OverlayProps, OverlayLayer, AnchorRect } from "../core/extensions/overlayExtensions";

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
// In a future refactor, this could move to core/registries/MenuRegistry.ts
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

export function registerTaskPane(definition: import("../core/extensions/taskPaneExtensions").TaskPaneViewDefinition): void {
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

export function getTaskPane(viewId: string): import("../core/extensions/taskPaneExtensions").TaskPaneViewDefinition | undefined {
  return TaskPaneExtensions.getView(viewId);
}

// ============================================================================
// Dialog API
// ============================================================================

export function registerDialog(definition: import("../core/extensions/dialogExtensions").DialogDefinition): void {
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

export function registerOverlay(definition: import("../core/extensions/overlayExtensions").OverlayDefinition): void {
  OverlayExtensions.registerOverlay(definition);
}

export function unregisterOverlay(overlayId: string): void {
  OverlayExtensions.unregisterOverlay(overlayId);
}

export function showOverlay(overlayId: string, options: { data?: Record<string, unknown>; anchorRect?: import("../core/extensions/overlayExtensions").AnchorRect; }): void {
  OverlayExtensions.showOverlay(overlayId, options);
}

export function hideOverlay(overlayId: string): void {
  OverlayExtensions.hideOverlay(overlayId);
}

export function hideAllOverlays(): void {
  OverlayExtensions.hideAllOverlays();
}