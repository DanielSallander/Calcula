//! FILENAME: app/extensions/Grouping/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Grouping/Outline items in the Data menu and grid context menu.
// CONTEXT: Uses context.ui.menus.registerItem to add to the existing "data" menu.
//          Uses gridExtensions.registerContextMenuItem for right-click menu items.

import type { ExtensionContext } from "@api/contract";
import type { MenuItemDefinition } from "@api/uiTypes";
import {
  gridExtensions,
  type GridContextMenuItem,
  IconOutline,
  IconGroup,
  IconUngroup,
  IconShowLevel,
  IconClearOutline,
  IconOtherOptions,
} from "@api";
import {
  performShowLevel,
  performClearOutline,
  getCurrentOutlineInfo,
} from "../lib/groupingStore";
// Group / Ungroup of Core's selection, shared by every door (menu, context
// menu, commands): it refuses while a selection owner holds the selection.
import { groupSelection, ungroupSelection } from "../lib/groupSelection";

// ============================================================================
// Data Menu Items
// ============================================================================

/**
 * Register Grouping items into the existing "data" menu.
 * Assumes the "data" menu was already created (e.g., by AutoFilter extension).
 * Items are appended after existing filter items.
 * @param context - ExtensionContext for UI registration
 * @param getSelection - function to retrieve the current grid selection
 * @returns the cleanup for deactivation. It takes back Grouping's own
 *   CHILDREN of Outline, never "data:outline" itself: Subtotals adds its item
 *   to the same submenu, which goes with the last child (X18).
 */
export function registerGroupingMenuItems(
  context: ExtensionContext,
  getSelection: () => { startRow: number; endRow: number; startCol: number; endCol: number; type?: string } | null
): () => void {
  // "Outline" submenu grouping all outline/grouping commands
  const outline: MenuItemDefinition = {
    id: "data:outline",
    label: "Outline",
    icon: IconOutline,
    children: [
      {
        id: "data:outline:group",
        label: "Group",
        shortcut: "Alt+Shift+Right",
        icon: IconGroup,
        action: () => groupSelection(getSelection()),
      },
      {
        id: "data:outline:ungroup",
        label: "Ungroup",
        shortcut: "Alt+Shift+Left",
        icon: IconUngroup,
        action: () => ungroupSelection(getSelection()),
      },
      {
        id: "data:outline:showLevel",
        label: "Show Level",
        icon: IconShowLevel,
        children: Array.from({ length: 8 }, (_, i) => i + 1).map((level) => ({
          id: `data:outline:showLevel${level}`,
          label: `Level ${level}`,
          icon: IconShowLevel,
          action: () => {
            performShowLevel(level);
          },
        })),
      },
      {
        id: "data:outline:separator1",
        label: "",
        separator: true,
      },
      {
        id: "data:outline:clearOutline",
        label: "Clear Outline",
        icon: IconClearOutline,
        action: () => {
          performClearOutline();
        },
      },
      {
        id: "data:outline:settings",
        label: "Group Settings...",
        icon: IconOtherOptions,
        action: () => {
          context.ui.dialogs.show("group-settings");
        },
      },
    ],
  };
  // The ids come from the definition itself, so an item added above is taken
  // back without editing a second list.
  const ownChildIds = (outline.children ?? []).map((child) => child.id);
  context.ui.menus.registerItem("data", outline);
  return () => {
    for (const id of ownChildIds) context.ui.menus.unregisterItem("data", id);
  };
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
      onClick: (ctx) => groupSelection(ctx.selection ?? null),
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
      onClick: (ctx) => ungroupSelection(ctx.selection ?? null),
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    for (const id of CONTEXT_ITEM_IDS) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
