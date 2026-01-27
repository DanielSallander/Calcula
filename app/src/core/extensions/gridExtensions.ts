//! FILENAME: app/src/core/extensions/gridExtensions.ts
// PURPOSE: Extension points for grid context menu customization
// CONTEXT: Allows extensions to add context menu items when right-clicking on cells.
//          Follows the same pattern as sheetExtensions.ts for consistency.
// UPDATE: Added command registry for direct handler invocation instead of keyboard events.
// UPDATE: Insert Row/Column now filter visibility based on selection type.

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
// Command Registry - allows components to register handlers for menu commands
// ============================================================================

/** Command handler function type */
type CommandHandler = () => void | Promise<void>;

/** Available command names */
export type GridCommand = "cut" | "copy" | "paste" | "clearContents" | "insertRow" | "insertColumn" | "deleteRow" | "deleteColumn";

/** Command registry for direct handler invocation */
class GridCommandRegistry {
  private handlers: Map<GridCommand, CommandHandler> = new Map();

  /**
   * Register a command handler.
   * @param command The command name
   * @param handler The handler function
   */
  register(command: GridCommand, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  /**
   * Unregister a command handler.
   * @param command The command name
   */
  unregister(command: GridCommand): void {
    this.handlers.delete(command);
  }

  /**
   * Execute a command if a handler is registered.
   * @param command The command to execute
   * @returns true if the command was executed, false otherwise
   */
  async execute(command: GridCommand): Promise<boolean> {
    const handler = this.handlers.get(command);
    if (handler) {
      await handler();
      return true;
    }
    console.warn(`[GridCommands] No handler registered for command: ${command}`);
    return false;
  }

  /**
   * Check if a command has a registered handler.
   * @param command The command name
   */
  hasHandler(command: GridCommand): boolean {
    return this.handlers.has(command);
  }

  /**
   * Clear all registered handlers (useful for cleanup/testing).
   */
  clear(): void {
    this.handlers.clear();
  }
}

/** Singleton command registry instance */
export const gridCommands = new GridCommandRegistry();

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
      await gridCommands.execute("cut");
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
      await gridCommands.execute("copy");
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
      await gridCommands.execute("paste");
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
      await gridCommands.execute("clearContents");
    },
  });

  // -------------------------------------------------------------------------
  // Insert Group
  // Only visible when appropriate selection type is active
  // -------------------------------------------------------------------------
  gridExtensions.registerContextMenuItem({
    id: "core:insertRow",
    label: "Insert Row",
    group: GridMenuGroups.INSERT,
    order: 10,
    // Only visible when rows are selected (right-click on row header)
    visible: (ctx) => ctx.selection?.type === "rows",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "rows") return;
      
      const startRow = Math.min(ctx.selection.startRow, ctx.selection.endRow);
      const endRow = Math.max(ctx.selection.startRow, ctx.selection.endRow);
      const count = endRow - startRow + 1;
      
      console.log(`[GridMenu] Insert ${count} row(s) at row ${startRow}`);
      await gridCommands.execute("insertRow");
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:insertColumn",
    label: "Insert Column",
    group: GridMenuGroups.INSERT,
    order: 20,
    separatorAfter: true,
    // Only visible when columns are selected (right-click on column header)
    visible: (ctx) => ctx.selection?.type === "columns",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "columns") return;
      
      const startCol = Math.min(ctx.selection.startCol, ctx.selection.endCol);
      const endCol = Math.max(ctx.selection.startCol, ctx.selection.endCol);
      const count = endCol - startCol + 1;
      
      console.log(`[GridMenu] Insert ${count} column(s) at column ${startCol}`);
      await gridCommands.execute("insertColumn");
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:deleteRow",
    label: "Delete Row",
    group: GridMenuGroups.INSERT,
    order: 30,
    // Only visible when rows are selected (right-click on row header)
    visible: (ctx) => ctx.selection?.type === "rows",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "rows") return;
      
      const startRow = Math.min(ctx.selection.startRow, ctx.selection.endRow);
      const endRow = Math.max(ctx.selection.startRow, ctx.selection.endRow);
      const count = endRow - startRow + 1;
      
      console.log(`[GridMenu] Delete ${count} row(s) starting at row ${startRow}`);
      await gridCommands.execute("deleteRow");
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:deleteColumn",
    label: "Delete Column",
    group: GridMenuGroups.INSERT,
    order: 40,
    separatorAfter: true,
    // Only visible when columns are selected (right-click on column header)
    visible: (ctx) => ctx.selection?.type === "columns",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "columns") return;
      
      const startCol = Math.min(ctx.selection.startCol, ctx.selection.endCol);
      const endCol = Math.max(ctx.selection.startCol, ctx.selection.endCol);
      const count = endCol - startCol + 1;
      
      console.log(`[GridMenu] Delete ${count} column(s) starting at column ${startCol}`);
      await gridCommands.execute("deleteColumn");
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
        console.log("[GridMenu] Tip: Use Shift+Right-click for browser context menu with DevTools");
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