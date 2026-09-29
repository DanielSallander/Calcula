//! FILENAME: app/extensions/AutoFilter/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data" menu with AutoFilter controls.
// CONTEXT: Menu is hook-based for dynamic checked/disabled states.

import type { ExtensionContext } from "@api/contract";
import { IconFilter, IconClearFilter, IconReapply, unregisterMenu } from "@api";
import {
  toggleFilter,
  clearAllFilters,
  reapplyFilter,
} from "../lib/filterStore";

const DATA_MENU_ID = "data";

/**
 * Build and register the Data menu.
 * Uses action callbacks for dynamic state (checked/disabled).
 *
 * Returns the cleanup for deactivation (X19). Data is SHARED -- Grouping,
 * Subtotals, Solver, Goal Seek, Sorting... add their items to it -- so the
 * cleanup takes back only AutoFilter's own items and leaves the menu for as
 * long as any of theirs is still in it.
 */
export function registerDataMenu(context: ExtensionContext): () => void {
  context.ui.menus.register({
    id: DATA_MENU_ID,
    label: "Data",
    order: 42,
    items: [
      {
        id: "data:filter",
        label: "Filter",
        shortcut: "Ctrl+Shift+L",
        icon: IconFilter,
        action: () => {
          toggleFilter();
        },
      },
      {
        id: "data:clearFilter",
        label: "Clear Filter",
        icon: IconClearFilter,
        action: () => {
          clearAllFilters();
        },
      },
      {
        id: "data:reapply",
        label: "Reapply",
        icon: IconReapply,
        action: () => {
          reapplyFilter();
        },
      },
    ],
  });
  return () => unregisterMenu(DATA_MENU_ID, { keepWhileShared: true });
}
