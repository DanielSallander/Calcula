//! FILENAME: app/extensions/Table/lib/tableEvents.ts
// PURPOSE: Event constants for the Table extension.
// CONTEXT: Used for cross-component communication via the app event system.

export const TableEvents = {
  /** Emitted after a new table is created */
  TABLE_CREATED: "app:table-created",
  /** Emitted when table definitions are updated (options changed, deleted, etc.) */
  TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
  /** Emitted by the selection handler to broadcast current table state to the ribbon tab */
  TABLE_STATE: "app:table-state",
  /** Emitted by the ribbon tab to request the current table state */
  TABLE_REQUEST_STATE: "app:table-request-state",
} as const;

export type TableEventType = (typeof TableEvents)[keyof typeof TableEvents];
