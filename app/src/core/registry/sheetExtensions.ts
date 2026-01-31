//! FILENAME: app/src/core/registry/sheetExtensions.ts
// PURPOSE: Extension points for sheet tab customization
// CONTEXT: Allows extensions to extend sheet tab functionality with context menus,
// custom actions, and event handlers.

import type { SheetInfo } from "../lib/tauri-api";

// ============================================================================
// Types for Sheet Extensions
// ============================================================================

/** Context passed to sheet-related extension callbacks */
export interface SheetContext {
  /** The sheet being acted upon */
  sheet: SheetInfo;
  /** Index of the sheet */
  index: number;
  /** Whether this is the active sheet */
  isActive: boolean;
  /** Total number of sheets */
  totalSheets: number;
}

/** A context menu item for sheet tabs */
export interface SheetContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: React.ReactNode;
  /** Whether the item is disabled */
  disabled?: boolean | ((context: SheetContext) => boolean);
  /** Whether to show a separator after this item */
  separatorAfter?: boolean;
  /** Click handler */
  onClick: (context: SheetContext) => void | Promise<void>;
}

/** Event types for sheet operations */
export type SheetEventType =
  | "sheet:beforeSwitch"
  | "sheet:afterSwitch"
  | "sheet:beforeAdd"
  | "sheet:afterAdd"
  | "sheet:beforeDelete"
  | "sheet:afterDelete"
  | "sheet:beforeRename"
  | "sheet:afterRename";

/** Payload for sheet events */
export interface SheetEventPayload {
  type: SheetEventType;
  sheetIndex: number;
  sheetName: string;
  /** For switch events */
  previousIndex?: number;
  /** For rename events */
  previousName?: string;
  /** For add events */
  newIndex?: number;
}

/** Sheet event handler */
export type SheetEventHandler = (payload: SheetEventPayload) => void | Promise<void>;

// ============================================================================
// Sheet Extension Registry
// ============================================================================

class SheetExtensionRegistry {
  private contextMenuItems: Map<string, SheetContextMenuItem> = new Map();
  private eventHandlers: Map<SheetEventType, Set<SheetEventHandler>> = new Map();

  // --------------------------------------------------------------------------
  // Context Menu Items
  // --------------------------------------------------------------------------

  /**
   * Register a context menu item for sheet tabs.
   * @param item The menu item to register
   */
  registerContextMenuItem(item: SheetContextMenuItem): void {
    if (this.contextMenuItems.has(item.id)) {
      console.warn(`[SheetExtensions] Context menu item '${item.id}' already registered, replacing`);
    }
    this.contextMenuItems.set(item.id, item);
    console.log(`[SheetExtensions] Registered context menu item: ${item.id}`);
  }

  /**
   * Unregister a context menu item.
   * @param id The item ID to remove
   */
  unregisterContextMenuItem(id: string): void {
    this.contextMenuItems.delete(id);
  }

  /**
   * Get all registered context menu items.
   */
  getContextMenuItems(): SheetContextMenuItem[] {
    return Array.from(this.contextMenuItems.values());
  }

  /**
   * Get context menu items filtered by context (respecting disabled state).
   */
  getContextMenuItemsForContext(context: SheetContext): SheetContextMenuItem[] {
    return this.getContextMenuItems().map((item) => ({
      ...item,
      disabled:
        typeof item.disabled === "function"
          ? item.disabled(context)
          : item.disabled,
    }));
  }

  // --------------------------------------------------------------------------
  // Event Handlers
  // --------------------------------------------------------------------------

  /**
   * Subscribe to sheet events.
   * @param eventType The event type to subscribe to
   * @param handler The handler function
   * @returns Unsubscribe function
   */
  on(eventType: SheetEventType, handler: SheetEventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }
    this.eventHandlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Emit a sheet event to all subscribers.
   * @param payload The event payload
   */
  async emit(payload: SheetEventPayload): Promise<void> {
    const handlers = this.eventHandlers.get(payload.type);
    if (!handlers || handlers.size === 0) return;

    console.log(`[SheetExtensions] Emitting ${payload.type}`, payload);

    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        console.error(`[SheetExtensions] Error in ${payload.type} handler:`, error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Clear all registered extensions (useful for testing).
   */
  clear(): void {
    this.contextMenuItems.clear();
    this.eventHandlers.clear();
  }
}

// Singleton instance
export const sheetExtensions = new SheetExtensionRegistry();

// ============================================================================
// Built-in Context Menu Items (Core functionality)
// ============================================================================

/** Register the default/core context menu items */
export function registerCoreSheetContextMenu(): void {
  // Rename is a core feature but implemented via extension point for consistency
  sheetExtensions.registerContextMenuItem({
    id: "core:rename",
    label: "Rename",
    onClick: async (context) => {
      const newName = prompt("Enter new sheet name:", context.sheet.name);
      if (newName && newName.trim() !== "" && newName !== context.sheet.name) {
        const event = new CustomEvent("sheet:requestRename", {
          detail: { index: context.index, newName: newName.trim() },
        });
        window.dispatchEvent(event);
      }
    },
  });

  sheetExtensions.registerContextMenuItem({
    id: "core:delete",
    label: "Delete",
    disabled: (context) => context.totalSheets <= 1,
    separatorAfter: true,
    onClick: async (context) => {
      if (context.totalSheets <= 1) return;
      const confirmed = confirm(`Delete sheet "${context.sheet.name}"?`);
      if (confirmed) {
        const event = new CustomEvent("sheet:requestDelete", {
          detail: { index: context.index },
        });
        window.dispatchEvent(event);
      }
    },
  });

  sheetExtensions.registerContextMenuItem({
    id: "core:insertSheet",
    label: "Insert Sheet",
    onClick: async () => {
      const event = new CustomEvent("sheet:requestAdd", { detail: {} });
      window.dispatchEvent(event);
    },
  });
}