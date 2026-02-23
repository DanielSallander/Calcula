//! FILENAME: app/extensions/Tablix/lib/tablixEvents.ts
// PURPOSE: Tablix-specific event constants.
// CONTEXT: Extension-defined events that are NOT part of the Core event system.
// Uses the generic emitAppEvent/onAppEvent from the API with custom strings.

export const TablixEvents = {
  /** Emitted after a new tablix is created */
  TABLIX_CREATED: "app:tablix-created",
  /** Emitted when tablix regions are updated (added/removed/changed) */
  TABLIX_REGIONS_UPDATED: "app:tablix-regions-updated",
  /** Emitted to open the filter dropdown menu for a tablix field */
  TABLIX_OPEN_FILTER_MENU: "app:tablix-open-filter-menu",
} as const;

export type TablixEventType = (typeof TablixEvents)[keyof typeof TablixEvents];
