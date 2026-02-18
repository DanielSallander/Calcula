//! FILENAME: app/extensions/AutoFilter/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data" menu with AutoFilter controls.
// CONTEXT: Menu is hook-based for dynamic checked/disabled states.

import { registerMenu, type MenuDefinition } from "../../../src/api";
import {
  toggleFilter,
  clearAllFilters,
  reapplyFilter,
} from "../lib/filterStore";

/**
 * Build and register the Data menu.
 * Uses action callbacks for dynamic state (checked/disabled).
 */
export function registerDataMenu(): void {
  const dataMenu: MenuDefinition = {
    id: "data",
    label: "Data",
    order: 42,
    items: [
      {
        id: "data:filter",
        label: "Filter",
        shortcut: "Ctrl+Shift+L",
        action: () => {
          toggleFilter();
        },
      },
      {
        id: "data:clearFilter",
        label: "Clear Filter",
        action: () => {
          clearAllFilters();
        },
      },
      {
        id: "data:reapply",
        label: "Reapply",
        action: () => {
          reapplyFilter();
        },
      },
    ],
  };

  registerMenu(dataMenu);
}
