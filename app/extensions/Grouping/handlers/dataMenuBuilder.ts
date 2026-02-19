//! FILENAME: app/extensions/Grouping/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Grouping/Outline items in the Data menu and grid context menu.
// CONTEXT: Uses registerMenuItem to add to the existing "data" menu (created by AutoFilter).
//          Uses gridExtensions.registerContextMenuItem for right-click menu items.

import {
  registerMenuItem,
  gridExtensions,
  type GridContextMenuItem,
} from "../../../src/api";
import {
  performGroupRows,
  performUngroupRows,
  performGroupColumns,
  performUngroupColumns,
  performShowLevel,
  performClearOutline,
  getCurrentOutlineInfo,
} from "../lib/groupingStore";

// ============================================================================
// Helpers
// ============================================================================

/** Normalize a selection range so startRow <= endRow, startCol <= endCol. */
function normalizeRange(sel: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}): { startRow: number; endRow: number; startCol: number; endCol: number } {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    endRow: Math.max(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

// ============================================================================
// Data Menu Items
// ============================================================================

/**
 * Register Grouping items into the existing "data" menu.
 * Assumes the "data" menu was already created (e.g., by AutoFilter extension).
 * Items are appended after existing filter items.
 * @param getSelection - function to retrieve the current grid selection
 */
export function registerGroupingMenuItems(
  getSelection: () => { startRow: number; endRow: number; startCol: number; endCol: number; type?: string } | null
): void {
  // Separator before grouping section
  registerMenuItem("data", {
    id: "data:outline:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:outline:group",
    label: "Group",
    shortcut: "Alt+Shift+Right",
    action: () => {
      const sel = getSelection();
      if (!sel) return;
      const norm = normalizeRange(sel);
      if (sel.type === "columns") {
        performGroupColumns(norm.startCol, norm.endCol);
      } else {
        performGroupRows(norm.startRow, norm.endRow);
      }
    },
  });

  registerMenuItem("data", {
    id: "data:outline:ungroup",
    label: "Ungroup",
    shortcut: "Alt+Shift+Left",
    action: () => {
      const sel = getSelection();
      if (!sel) return;
      const norm = normalizeRange(sel);
      if (sel.type === "columns") {
        performUngroupColumns(norm.startCol, norm.endCol);
      } else {
        performUngroupRows(norm.startRow, norm.endRow);
      }
    },
  });

  // "Show Level" submenu with levels 1–8
  registerMenuItem("data", {
    id: "data:outline:showLevel",
    label: "Show Level",
    children: Array.from({ length: 8 }, (_, i) => i + 1).map((level) => ({
      id: `data:outline:showLevel${level}`,
      label: `Level ${level}`,
      action: () => {
        performShowLevel(level);
      },
    })),
  });

  registerMenuItem("data", {
    id: "data:outline:clearOutline",
    label: "Clear Outline",
    action: () => {
      performClearOutline();
    },
  });
}

// ============================================================================
// Context Menu Items
// ============================================================================

const CONTEXT_ITEM_IDS = [
  "grouping:group",
  "grouping:ungroup",
];

/**
 * Register grouping items in the grid right-click context menu.
 * Auto-detects whether to group rows or columns based on selection type.
 * Returns a cleanup function to unregister them.
 */
export function registerGroupingContextMenuItems(): () => void {
  const items: GridContextMenuItem[] = [
    {
      id: "grouping:group",
      label: "Group",
      group: "grouping",
      order: 200,
      visible: (ctx) => {
        if (!ctx.selection) return false;
        if (ctx.selection.type === "columns") {
          return ctx.selection.startCol !== ctx.selection.endCol;
        }
        return ctx.selection.startRow !== ctx.selection.endRow;
      },
      onClick: async (ctx) => {
        if (!ctx.selection) return;
        const norm = normalizeRange(ctx.selection);
        if (ctx.selection.type === "columns") {
          await performGroupColumns(norm.startCol, norm.endCol);
        } else {
          await performGroupRows(norm.startRow, norm.endRow);
        }
      },
    },
    {
      id: "grouping:ungroup",
      label: "Ungroup",
      group: "grouping",
      order: 201,
      visible: (ctx) => {
        if (!ctx.selection) return false;
        const info = getCurrentOutlineInfo();
        if (!info) return false;
        if (ctx.selection.type === "columns") {
          return info.maxColLevel > 0;
        }
        return info.maxRowLevel > 0;
      },
      onClick: async (ctx) => {
        if (!ctx.selection) return;
        const norm = normalizeRange(ctx.selection);
        if (ctx.selection.type === "columns") {
          await performUngroupColumns(norm.startCol, norm.endCol);
        } else {
          await performUngroupRows(norm.startRow, norm.endRow);
        }
      },
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    for (const id of CONTEXT_ITEM_IDS) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
