//! FILENAME: app/extensions/AutoFilter/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data" menu with AutoFilter controls.
// CONTEXT: The items name their COMMANDS (autofilter.toggle / .clear /
//          .reapply), the same ids the Home tab's Sort & Filter menu runs, so
//          the two surfaces are one implementation. Their checked / disabled
//          state follows @api/autoFilterService's pushed status.

import type { ExtensionContext } from "@api/contract";
import { IconFilter, IconClearFilter, IconReapply, unregisterMenu, updateMenuItem } from "@api";
import { ExtensionCommands } from "@api/commands";
import { onChange, getAutoFilterStatus, type AutoFilterStatus } from "@api/autoFilterService";

const DATA_MENU_ID = "data";

/**
 * Build and register the Data menu.
 *
 * Returns the cleanup for deactivation (X19). Data is SHARED -- Grouping,
 * Subtotals, Solver, Goal Seek, Sorting... add their items to it -- so the
 * cleanup takes back only AutoFilter's own items and leaves the menu for as
 * long as any of theirs is still in it.
 */
export function registerDataMenu(context: ExtensionContext): () => void {
  const status = getAutoFilterStatus();
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
        commandId: ExtensionCommands.FILTER_TOGGLE,
        checked: status.hasFilter,
      },
      {
        id: "data:clearFilter",
        label: "Clear Filter",
        icon: IconClearFilter,
        commandId: ExtensionCommands.FILTER_CLEAR,
        disabled: !status.isDataFiltered,
      },
      {
        id: "data:reapply",
        label: "Reapply",
        icon: IconReapply,
        commandId: ExtensionCommands.FILTER_REAPPLY,
        disabled: !status.isDataFiltered,
      },
    ],
  });
  const unbind = bindDataMenuState();
  return () => {
    unbind();
    unregisterMenu(DATA_MENU_ID, { keepWhileShared: true });
  };
}

/**
 * Keep the three items in step with the filter, the way Excel's Data tab is:
 * Filter shows checked while the sheet has a filter; Clear and Reapply are
 * enabled only while the filter actually hides rows (measured in live Excel
 * 2026-10-04 -- a filter with no criteria leaves both greyed). Patched in place
 * (updateMenuItem), never by re-registering the shared menu. Returns the
 * unsubscribe.
 */
export function bindDataMenuState(): () => void {
  const apply = (status: AutoFilterStatus): void => {
    updateMenuItem(DATA_MENU_ID, "data:filter", { checked: status.hasFilter });
    updateMenuItem(DATA_MENU_ID, "data:clearFilter", { disabled: !status.isDataFiltered });
    updateMenuItem(DATA_MENU_ID, "data:reapply", { disabled: !status.isDataFiltered });
  };
  apply(getAutoFilterStatus());
  return onChange(apply);
}
