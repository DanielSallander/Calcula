//! FILENAME: app/extensions/BusinessIntelligence/lib/biEvents.ts
// PURPOSE: Custom event constants for the BI extension.

export const BiEvents = {
  CONNECTION_CREATED: "app:bi-connection-created",
  CONNECTION_DELETED: "app:bi-connection-deleted",
  CONNECTION_UPDATED: "app:bi-connection-updated",
  CONNECTION_STATUS_CHANGED: "app:bi-connection-status-changed",
  QUERY_EXECUTED: "app:bi-query-executed",
  RESULT_INSERTED: "app:bi-result-inserted",
  REFRESHED: "app:bi-refreshed",
} as const;
