//! FILENAME: app/src/shell/registries/gridExtensions.ts
// PURPOSE: Extension points for grid context menu customization
// CONTEXT: Allows extensions to add context menu items when right-clicking on cells.
//          Follows the same pattern as sheetExtensions.ts for consistency.
// NOTE: GridMenuContext, gridCommands, and isClickWithinSelection are core primitives
//       imported from core/lib/gridCommands. This file adds the extension registry layer.

// Re-export core primitives so existing consumers don't break
export type { GridMenuContext } from "../../core/lib/gridCommands";
export { gridCommands, isClickWithinSelection } from "../../core/lib/gridCommands";
export type { GridCommand } from "../../core/lib/gridCommands";

// Import GridMenuContext for use within this file
import type { GridMenuContext } from "../../core/lib/gridCommands";
import { alertAsync } from "@api/dialogs";

// A context menu item for the grid: @api's type, never a second hand-written
// copy (the two had identical bodies, and a field added to one -- such as
// `disabledReason` -- would silently not exist for the other). Pinned by
// src/api/__tests__/gridMenuContextDrift.test.ts.
export type { GridContextMenuItem } from "@api/extensions";
import type { GridContextMenuItem } from "@api/extensions";

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

// Import gridCommands for use in registerCoreGridContextMenu
import { gridCommands } from "../../core/lib/gridCommands";
import { applyRowsHidden, applyColsHidden, indexRange } from "../../core/lib/hiddenRowsCols";
import { dispatchGridAction } from "@api/gridDispatch";
import { DialogExtensions } from "@api/ui";
import { DimensionInputDialog, DIMENSION_INPUT_DIALOG_ID } from "../dialogs/DimensionInputDialog";
import {
  registerGridFormatCommands,
  openColumnWidthDialog,
  openRowHeightDialog,
  lineRangeLabel,
} from "./gridFormatCommands";

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
   * Resolve a single item: resolve label, disabled, the disabled reason, and
   * recursively process children. The reason is resolved only for an item
   * that resolved DISABLED (a reason on an enabled row would be a stray
   * tooltip); it comes out as a string or undefined, never a function or null.
   */
  private resolveItem(item: GridContextMenuItem, context: GridMenuContext): GridContextMenuItem {
    const disabled = typeof item.disabled === "function" ? item.disabled(context) : item.disabled;
    let disabledReason: string | undefined;
    if (disabled) {
      const reason = typeof item.disabledReason === "function" ? item.disabledReason(context) : item.disabledReason;
      disabledReason = typeof reason === "string" && reason !== "" ? reason : undefined;
    }
    return {
      ...item,
      label: typeof item.label === "function" ? item.label(context) : item.label,
      disabled,
      disabledReason,
      children: item.children
        ? item.children
            .filter((child) => {
              if (child.visible === undefined) return true;
              if (typeof child.visible === "function") return child.visible(context);
              return child.visible;
            })
            .map((child) => this.resolveItem(child, context))
        : undefined,
    };
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
      // Resolve labels, disabled state, and children
      .map((item) => this.resolveItem(item, context));

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

// Default dimensions are now fetched from the backend via getDefaultDimensions().

/** Register the default/core context menu items */
export function registerCoreGridContextMenu(): void {
  // Register the shared Column Width / Row Height / Standard Width dialog
  // (opened below and by the Home tab's Format menu).
  DialogExtensions.registerDialog({
    id: DIMENSION_INPUT_DIALOG_ID,
    component: DimensionInputDialog,
    priority: 300,
  });

  // Excel's Home > Format > Cell Size and Visibility commands (Row Height...,
  // Column Width..., Default Width..., Hide & Unhide Rows / Columns). They act
  // on the SPAN of any selection, where the right-click items below are
  // offered for whole rows / columns only; both share one dialog opener and
  // one writer (gridFormatCommands.ts), so a resize is one undo step from
  // either door.
  registerGridFormatCommands();

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
  // Format Group - Column Width and Row Height
  // -------------------------------------------------------------------------
  gridExtensions.registerContextMenuItem({
    id: "core:columnWidth",
    label: "Column Width...",
    group: GridMenuGroups.FORMAT,
    order: 10,
    // Only visible when columns are selected
    visible: (ctx) => ctx.selection?.type === "columns",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "columns") return;

      // Seeded with the first selected column's width. The writer behind it
      // resizes the whole run in ONE undo step: this loop used to call
      // setColumnWidth bare, one undo entry per column (five columns, five
      // Ctrl+Z), and surfaces a backend refusal (sheet protection) instead of
      // closing silently.
      await openColumnWidthDialog(
        indexRange(ctx.selection.startCol, ctx.selection.endCol),
        lineRangeLabel("columns", ctx.selection.startCol, ctx.selection.endCol),
      );
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:rowHeight",
    label: "Row Height...",
    group: GridMenuGroups.FORMAT,
    order: 20,
    separatorAfter: true,
    // Only visible when rows are selected
    visible: (ctx) => ctx.selection?.type === "rows",
    disabled: false,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "rows") return;

      // Seeded with the first selected row's height; ONE undo step (see
      // Column Width above).
      await openRowHeightDialog(
        indexRange(ctx.selection.startRow, ctx.selection.endRow),
        lineRangeLabel("rows", ctx.selection.startRow, ctx.selection.endRow),
      );
    },
  });

  // -------------------------------------------------------------------------
  // Format Group - Hide/Unhide Rows and Columns
  // -------------------------------------------------------------------------
  // These four go through core/lib/hiddenRowsCols, which calls the BACKEND
  // authority (set_rows_hidden / set_cols_hidden): the hide is persisted in the
  // .cala, recorded as one undo step for the whole range, and marks the document
  // dirty. They used to dispatch a window CustomEvent into the grid reducer and
  // nothing else, so the hide was lost on the next save/reload.
  gridExtensions.registerContextMenuItem({
    id: "core:hideRows",
    label: "Hide",
    group: GridMenuGroups.FORMAT,
    order: 30,
    visible: (ctx) => ctx.selection?.type === "rows",
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "rows") return;

      const rows = indexRange(ctx.selection.startRow, ctx.selection.endRow);
      await applyRowsHidden(rows, true, dispatchGridAction);
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:unhideRows",
    label: "Unhide",
    group: GridMenuGroups.FORMAT,
    order: 31,
    visible: (ctx) => {
      if (ctx.selection?.type !== "rows") return false;
      // Offer Unhide only for USER hides. A filter-hidden or outline-hidden row
      // is not the user's to unhide here — clearing the filter or expanding the
      // group is. (ctx.dimensions.manuallyHiddenRows mirrors the backend set.)
      const userHidden = ctx.dimensions.manuallyHiddenRows;
      if (!userHidden || userHidden.size === 0) return false;

      const minRow = Math.min(ctx.selection.startRow, ctx.selection.endRow);
      const maxRow = Math.max(ctx.selection.startRow, ctx.selection.endRow);

      // Any user-hidden row inside the selected span, including one sandwiched
      // between two selected rows (select rows 1 and 3 to unhide row 2).
      for (const hr of userHidden) {
        if (hr >= minRow && hr <= maxRow) return true;
      }
      return false;
    },
    separatorAfter: true,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "rows") return;

      const rows = indexRange(ctx.selection.startRow, ctx.selection.endRow);
      await applyRowsHidden(rows, false, dispatchGridAction);
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:hideCols",
    label: "Hide",
    group: GridMenuGroups.FORMAT,
    order: 32,
    visible: (ctx) => ctx.selection?.type === "columns",
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "columns") return;

      const cols = indexRange(ctx.selection.startCol, ctx.selection.endCol);
      await applyColsHidden(cols, true, dispatchGridAction);
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    },
  });

  gridExtensions.registerContextMenuItem({
    id: "core:unhideCols",
    label: "Unhide",
    group: GridMenuGroups.FORMAT,
    order: 33,
    visible: (ctx) => {
      if (ctx.selection?.type !== "columns") return false;
      const userHidden = ctx.dimensions.manuallyHiddenCols;
      if (!userHidden || userHidden.size === 0) return false;

      const minCol = Math.min(ctx.selection.startCol, ctx.selection.endCol);
      const maxCol = Math.max(ctx.selection.startCol, ctx.selection.endCol);

      for (const hc of userHidden) {
        if (hc >= minCol && hc <= maxCol) return true;
      }
      return false;
    },
    separatorAfter: true,
    onClick: async (ctx) => {
      if (!ctx.selection || ctx.selection.type !== "columns") return;

      const cols = indexRange(ctx.selection.startCol, ctx.selection.endCol);
      await applyColsHidden(cols, false, dispatchGridAction);
      window.dispatchEvent(new CustomEvent("grid:refresh"));
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
      // The dead `invoke("open_devtools")` that used to lead this handler is
      // gone. There is no such command — it is absent from `generate_handler!`
      // and no `fn open_devtools` exists anywhere in src-tauri — so the call
      // ALWAYS rejected and the catch below ALWAYS ran. Behaviour is unchanged;
      // the pretence is not. Found by backendCommandDrift.test.ts on its first
      // run, which is the whole reason that guard exists: `invoke` takes a
      // string, so nothing else could see it.
      //
      // If DevTools should really open from here, that needs a Rust command
      // (`WebviewWindow::open_devtools`) — a feature, not a repair.
      onClick: async () => {
        void alertAsync("Tip: Use Shift+Right-click to access browser DevTools");
      },
    });
  }
}