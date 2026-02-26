//! FILENAME: app/extensions/pivot/lib/pivotEvents.ts
// PURPOSE: Pivot-specific event constants.
// CONTEXT: Extension-defined events that are NOT part of the Core event system.
// Uses the generic emitAppEvent/onAppEvent from the API with custom strings.

export const PivotEvents = {
  /** Emitted after a new pivot table is created */
  PIVOT_CREATED: "app:pivot-created",
  /** Emitted when pivot regions are updated (added/removed/changed) */
  PIVOT_REGIONS_UPDATED: "app:pivot-regions-updated",
  /** Emitted to open the filter dropdown menu for a pivot field */
  PIVOT_OPEN_FILTER_MENU: "app:pivot-open-filter-menu",
  /** Emitted to open the header filter dropdown (Row Labels / Column Labels) */
  PIVOT_OPEN_HEADER_FILTER_MENU: "app:pivot-open-header-filter-menu",
  /** Emitted by the PivotEditor to broadcast current layout state to the Design tab */
  PIVOT_LAYOUT_STATE: "app:pivot-layout-state",
  /** Emitted by the Design tab when the user changes a layout option */
  PIVOT_LAYOUT_CHANGED: "app:pivot-layout-changed",
} as const;

export type PivotEventType = (typeof PivotEvents)[keyof typeof PivotEvents];
