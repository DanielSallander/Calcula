//! FILENAME: app/extensions/ConditionalFormatting/lib/cfEvents.ts
// PURPOSE: Extension-internal event constants for conditional formatting.

export const CFEvents = {
  RULES_CHANGED: "cf:rules-changed",
  EVALUATION_UPDATED: "cf:evaluation-updated",
} as const;
