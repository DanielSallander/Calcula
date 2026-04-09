//! FILENAME: app/extensions/AutoFilter/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data" menu with AutoFilter controls.
// CONTEXT: Menu is hook-based for dynamic checked/disabled states.

import type { ExtensionContext } from "@api/contract";
import { IconFilter, IconClearFilter, IconReapply } from "@api";
import {
  toggleFilter,
  clearAllFilters,
  reapplyFilter,
} from "../lib/filterStore";

/**
 * Build and register the Data menu.
 * Uses action callbacks for dynamic state (checked/disabled).
 */
export function registerDataMenu(context: ExtensionContext): void {
  context.ui.menus.register({
    id: "data",
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
}
