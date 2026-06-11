//! FILENAME: app/extensions/FilterPane/lib/filterBadge.ts
// PURPOSE: Updates the badge on the "Filters" tab showing the count of applied filters.
// CONTEXT: A filter is "applied" when selectedItems !== null (same rule as the
//          filter card's visual indicator). Badge hides when no filters are applied.

import { PanelExtensions } from "@api";
import { FilterPaneEvents } from "./filterPaneEvents";
import { getAllFilters } from "./filterPaneStore";
import { FILTER_PANE_TAB_ID } from "../manifest";

function updateBadge(): void {
  const appliedCount = getAllFilters().filter((f) => f.selectedItems !== null).length;
  PanelExtensions.setBadge(FILTER_PANE_TAB_ID, appliedCount > 0 ? String(appliedCount) : null);
}

/**
 * Start tracking applied-filter count and reflect it as a badge on the
 * Filters tab. Returns a cleanup function that stops tracking and clears
 * the badge.
 */
export function registerFilterBadge(): () => void {
  const events: string[] = [
    FilterPaneEvents.FILTER_CREATED,
    FilterPaneEvents.FILTER_DELETED,
    FilterPaneEvents.FILTER_UPDATED,
    FilterPaneEvents.FILTER_SELECTION_CHANGED,
    FilterPaneEvents.FILTERS_REFRESHED,
  ];
  for (const eventName of events) {
    window.addEventListener(eventName, updateBadge);
  }

  // Initial state (cache may already be loaded)
  updateBadge();

  return () => {
    for (const eventName of events) {
      window.removeEventListener(eventName, updateBadge);
    }
    PanelExtensions.setBadge(FILTER_PANE_TAB_ID, null);
  };
}
