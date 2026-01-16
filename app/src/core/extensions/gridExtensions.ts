// FILENAME: core/extensions/gridExtensions.ts
// PURPOSE: Extension points for grid context menu customization
// CONTEXT: Allows extensions to add context menu items when right-clicking on cells.
//          Follows the same pattern as sheetExtensions.ts for consistency.

import type { Selection } from "../types";

// ============================================================================
// Types for Grid Context Menu Extensions
// ============================================================================

/** Context passed to grid context menu callbacks */
export interface GridMenuContext {
  /** The current selection */
  selection: Selection | null;
  /** The cell that was right-clicked (may differ from selection start) */
  clickedCell: { row: number; col: number } | null;
  /** Whether the clicked cell is within the current selection */
  isWithinSelection: boolean;
  /** Active sheet index */
  sheetIndex: number;
  /** Active sheet name */
  sheetName: string;
}

/** A context menu item for the grid */
export interface GridContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional keyboard shortcut hint (display only) */
  shortcut?: string;
  /** Optional icon */
  icon?: React.ReactNode;
  /** Group for organizing items (items in same group stay together) */
  group?: string;
  /** Order within the group (lower = higher in menu) */
  order?: number;
  /** Whether the item is disabled */
  disabled?: boolean | ((context: GridMenuContext) => boolean);
  /** Whether the item is visible */
  visible?: boolean | ((context: GridMenuContext) => boolean);
  /** Whether to show a separator after this item */
  separatorAfter?: boolean;
  /** Click handler */
  onClick: (context: GridMenuContext) => void | Promise<void>;
}

/** Groups for organizing menu items */
export const GridMenuGroups = {
  CLIPBOARD: "clipboard",
  EDIT: "edit",
  INSERT: "insert",
  FORMAT: "format",
  DATA: "data",
  DEVELOPER: "developer",
} as const;

/** Default group order */
const GROUP_ORDER: Record<string, number> = {
  [GridMenuGroups.CLIPBOARD]: 0,
  [GridMenuGroups.EDIT]: 100,
  [GridMenuGroups.INSERT]: 200,
  [GridMenuGroups.FORMAT]: 300,
  [GridMenuGroups.DATA]: 400,
  [GridMenuGroups.DEVELOPER]: 900,
};

// ============================================================================
// Grid Extension Registry
// ============================================================================

class GridExtensionRegistry {
  private contextMenuItems: Map<string, GridContextMenuItem> = new Map();
  private changeListeners: Set<() => void> = new Set();

  // --------------------------------------------------------------------------
  // Context Menu Items
  // --------------------------------------------------------------------------

  /**
   * Register a context menu item for the grid.
   * @param item The menu item to register
   */
  registerContextMenuItem(item: GridContextMenuItem): void {
    if (this.contextMenuItems.has(item.id)) {
      console.warn(`[GridExtensions] Context menu item '${item.id}' already registered, replacing`);
    }
    this.contextMenuItems.set(item.id, item);
    console.log(`[GridExtensions] Registered context menu item: ${item.id}`);
    this.notifyChange();
  }

  /**
   * Register multiple context menu items at once.
   * @param items The menu items to register
   */
  registerContextMenuItems(items: GridContextMenuItem[]): void {
    items.forEach((item) => this.registerContextMenuItem(item));
  }

  /**
   * Unregister a context menu item.
   * @param id The item ID to remove
   */
  unregisterContextMenuItem(id: string): void {
    if (this.contextMenuItems.delete(id)) {
      this.notifyChange();
    }
  }

  /**
   * Get all registered context menu items (unfiltered, unsorted).
   */
  getContextMenuItems(): GridContextMenuItem[] {
    return Array.from(this.contextMenuItems.values());
  }

  /**
   * Get context menu items filtered and sorted for display.
   * @param context The current grid context
   */
  getContextMenuItemsForContext(context: GridMenuContext): GridContextMenuItem[] {
    const items = this.getContextMenuItems()
      // Filter by visibility
      .filter((item) => {
        if (item.visible === undefined) return true;
        if (typeof item.visible === "function") return item.visible(context);
        return item.visible;
      })
      // Resolve disabled state
      .map((item) => ({
        ...item,
        disabled:
          typeof item.disabled === "function"
            ? item.disabled(context)
            : item.disabled,
      }));

    // Sort by group then by order within group
    return items.sort((a, b) => {
      const groupA = a.group || "zzz";
      const groupB = b.group || "zzz";
      const groupOrderA = GROUP_ORDER[groupA] ?? 500;
      const groupOrderB = GROUP_ORDER[groupB] ?? 500;

      if (groupOrderA !== groupOrderB) {
        return groupOrderA - groupOrderB;
      }

      const orderA = a.order ?? 50;
      const orderB = b.order ?? 50;
      return orderA - orderB;
    });
  }

  // --------------------------------------------------------------------------
  // Change Notification
  // --------------------------------------------------------------------------

  /**
   * Subscribe to registry changes.
   * @param callback Called when items are added/removed
   * @returns Unsubscribe function
   */
  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }

  private notifyChange(): void {
    this.changeListeners.forEach((cb) => cb());
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Clear all registered items (useful for testing).
   */
  clear(): void {
    this.contextMenuItems.clear();
    this.notifyChange();
  }

  /**
   * Check if any items are registered.
   */
  hasItems(): boolean {
    return this.contextMenuItems.size > 0;
  }
}

// Singleton instance
export const gridExtensions = new GridExtensionRegistry();

// ============================================================================
// Built-in Context Menu Items (Core functionality)
// ============================================================================

/** Register the default/core context menu items */
export function registerCoreGridContextMenu(): void {
  // -------------------------------------------------------------------------
  // Clipboard Group
  // -------------------------------------------------------------------------
  gridExtensions.registerContextMenuItem({
    id: "core:cut",
    label: "Cut",
    shortcut: "Ctrl+X",
    group: GridMenuGroups.CLIPBOARD,
    order: 10,
    disabled: (ctx) => !ctx.selection,
    onClick: async () => {
      // Dispatch keyboard event to trigger existing cut handler
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", ctrlKey: true, bubbles: true })
      );
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:copy",
    label: "Copy",
    shortcut: "Ctrl+C",
    group: GridMenuGroups.CLIPBOARD,
    order: 20,
    disabled: (ctx) => !ctx.selection,
    onClick: async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true })
      );
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:paste",
    label: "Paste",
    shortcut: "Ctrl+V",
    group: GridMenuGroups.CLIPBOARD,
    order: 30,
    separatorAfter: true,
    onClick: async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true })
      );
    },
  });

  // -------------------------------------------------------------------------
  // Edit Group
  // -------------------------------------------------------------------------
  gridExtensions.registerContextMenuItem({
    id: "core:clearContents",
    label: "Clear Contents",
    shortcut: "Delete",
    group: GridMenuGroups.EDIT,
    order: 10,
    disabled: (ctx) => !ctx.selection,
    separatorAfter: true,
    onClick: async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true })
      );
    },
  });

  // -------------------------------------------------------------------------
  // Insert Group (placeholders for future implementation)
  // -------------------------------------------------------------------------
  gridExtensions.registerContextMenuItem({
    id: "core:insertRow",
    label: "Insert Row",
    group: GridMenuGroups.INSERT,
    order: 10,
    disabled: true, // TODO: Implement
    onClick: async (ctx) => {
      console.log("[GridMenu] Insert row at:", ctx.clickedCell?.row);
      // TODO: Implement row insertion
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:insertColumn",
    label: "Insert Column",
    group: GridMenuGroups.INSERT,
    order: 20,
    disabled: true, // TODO: Implement
    separatorAfter: true,
    onClick: async (ctx) => {
      console.log("[GridMenu] Insert column at:", ctx.clickedCell?.col);
      // TODO: Implement column insertion
    },
  });

  // -------------------------------------------------------------------------
  // Developer Group (only in dev mode)
  // -------------------------------------------------------------------------
  if (import.meta.env.DEV) {
    gridExtensions.registerContextMenuItem({
      id: "core:devTools",
      label: "Developer Tools",
      shortcut: "Shift+RClick",
      group: GridMenuGroups.DEVELOPER,
      order: 10,
      onClick: async () => {
        // Inform user about the shortcut
        console.log("[GridMenu] Tip: Use Shift+Right-click for browser context menu with DevTools");
        // Try Tauri devtools command if available
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("open_devtools");
        } catch {
          alert("Tip: Use Shift+Right-click to access browser DevTools");
        }
      },
    });
  }
}

// ============================================================================
// Helper to check if click is within selection
// ============================================================================

export function isClickWithinSelection(
  row: number,
  col: number,
  selection: Selection | null
): boolean {
  if (!selection) return false;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}