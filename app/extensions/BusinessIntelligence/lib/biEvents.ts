//! FILENAME: app/extensions/BusinessIntelligence/lib/biEvents.ts
// PURPOSE: Custom event constants for the BI extension.

export const BiEvents = {
  MODEL_LOADED: "app:bi-model-loaded",
  CONNECTED: "app:bi-connected",
  TABLES_BOUND: "app:bi-tables-bound",
  QUERY_EXECUTED: "app:bi-query-executed",
  RESULT_INSERTED: "app:bi-result-inserted",
  REFRESHED: "app:bi-refreshed",
} as const;
