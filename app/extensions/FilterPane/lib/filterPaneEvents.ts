//! FILENAME: app/extensions/FilterPane/lib/filterPaneEvents.ts
// PURPOSE: Custom event names for the Filter Pane extension.

export const FilterPaneEvents = {
  FILTER_CREATED: "ribbonFilter:created",
  FILTER_DELETED: "ribbonFilter:deleted",
  FILTER_UPDATED: "ribbonFilter:updated",
  FILTER_SELECTION_CHANGED: "ribbonFilter:selectionChanged",
  FILTERS_REFRESHED: "ribbonFilter:refreshed",
} as const;
