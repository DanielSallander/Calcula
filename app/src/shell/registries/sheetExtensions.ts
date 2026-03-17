//! FILENAME: app/src/shell/registries/sheetExtensions.ts
// PURPOSE: Extension points for sheet tab customization
// CONTEXT: Allows extensions to extend sheet tab functionality with context menus,
// custom actions, and event handlers.
// NOTE: Moved from core/registry to shell/registries per microkernel architecture.

import type { SheetInfo } from "../../core/lib/tauri-api";

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

/** Tab color presets for the color picker */
const TAB_COLORS = [
  { label: "Red", value: "#e74c3c" },
  { label: "Orange", value: "#f39c12" },
  { label: "Yellow", value: "#f1c40f" },
  { label: "Green", value: "#2ecc71" },
  { label: "Blue", value: "#3498db" },
  { label: "Purple", value: "#9b59b6" },
  { label: "Pink", value: "#e91e8b" },
  { label: "Teal", value: "#1abc9c" },
  { label: "No Color", value: "" },
];

/** Register the default/core context menu items */
export function registerCoreSheetContextMenu(): void {
  // Rename
  sheetExtensions.registerContextMenuItem({
    id: "core:rename",
    label: "Rename",
    onClick: async (context) => {
      const newName = prompt("Enter new sheet name:", context.sheet.name);
      if (newName && newName.trim() !== "" && newName !== context.sheet.name) {
        window.dispatchEvent(new CustomEvent("sheet:requestRename", {
          detail: { index: context.index, newName: newName.trim() },
        }));
      }
    },
  });

  // Delete
  sheetExtensions.registerContextMenuItem({
    id: "core:delete",
    label: "Delete",
    disabled: (context) => context.totalSheets <= 1,
    separatorAfter: true,
    onClick: async (context) => {
      if (context.totalSheets <= 1) return;
      window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
        detail: { index: context.index },
      }));
    },
  });

  // Insert
  sheetExtensions.registerContextMenuItem({
    id: "core:insertSheet",
    label: "Insert Sheet",
    onClick: async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: {} }));
    },
  });

  // Duplicate (Copy)
  sheetExtensions.registerContextMenuItem({
    id: "core:copySheet",
    label: "Duplicate Sheet",
    separatorAfter: true,
    onClick: async (context) => {
      window.dispatchEvent(new CustomEvent("sheet:requestCopy", {
        detail: { index: context.index },
      }));
    },
  });

  // Move Left
  sheetExtensions.registerContextMenuItem({
    id: "core:moveLeft",
    label: "Move Left",
    disabled: (context) => context.index === 0,
    onClick: async (context) => {
      if (context.index > 0) {
        window.dispatchEvent(new CustomEvent("sheet:requestMove", {
          detail: { fromIndex: context.index, toIndex: context.index - 1 },
        }));
      }
    },
  });

  // Move Right
  sheetExtensions.registerContextMenuItem({
    id: "core:moveRight",
    label: "Move Right",
    disabled: (context) => context.index === context.totalSheets - 1,
    separatorAfter: true,
    onClick: async (context) => {
      if (context.index < context.totalSheets - 1) {
        window.dispatchEvent(new CustomEvent("sheet:requestMove", {
          detail: { fromIndex: context.index, toIndex: context.index + 1 },
        }));
      }
    },
  });

  // Hide
  sheetExtensions.registerContextMenuItem({
    id: "core:hideSheet",
    label: "Hide Sheet",
    disabled: (context) => context.totalSheets <= 1,
    onClick: async (context) => {
      window.dispatchEvent(new CustomEvent("sheet:requestHide", {
        detail: { index: context.index },
      }));
    },
  });

  // Unhide
  sheetExtensions.registerContextMenuItem({
    id: "core:unhideSheet",
    label: "Unhide Sheet...",
    separatorAfter: true,
    onClick: async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestUnhide", { detail: {} }));
    },
  });

  // Tab Color
  sheetExtensions.registerContextMenuItem({
    id: "core:tabColor",
    label: "Tab Color",
    onClick: async (context) => {
      const colorNames = TAB_COLORS.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
      const choice = prompt(
        `Select tab color for "${context.sheet.name}":\n\n${colorNames}\n\nEnter number (or hex color):`,
      );
      if (choice === null) return;

      const trimmed = choice.trim();
      let color = "";
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= TAB_COLORS.length) {
        color = TAB_COLORS[num - 1].value;
      } else if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
        color = trimmed;
      } else if (trimmed === "") {
        color = "";
      } else {
        alert("Invalid color. Use a number from the list or a hex color like #ff0000.");
        return;
      }

      window.dispatchEvent(new CustomEvent("sheet:requestTabColor", {
        detail: { index: context.index, color },
      }));
    },
  });
}