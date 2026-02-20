//! FILENAME: app/extensions/DataValidation/lib/validationEvents.ts
// PURPOSE: Custom event name constants for the Data Validation extension.
// CONTEXT: Used for extension-internal communication between components.

export const ValidationEvents = {
  /** Fired when validation rules change (added, removed, updated). */
  VALIDATION_CHANGED: "datavalidation:changed",
  /** Fired when "Circle Invalid Data" is toggled on/off. */
  CIRCLES_TOGGLED: "datavalidation:circles-toggled",
  /** Fired when a list dropdown opens. */
  DROPDOWN_OPEN: "datavalidation:dropdown-open",
  /** Fired when a list dropdown closes. */
  DROPDOWN_CLOSE: "datavalidation:dropdown-close",
  /** Fired when an input prompt tooltip is shown. */
  PROMPT_SHOW: "datavalidation:prompt-show",
  /** Fired when an input prompt tooltip is hidden. */
  PROMPT_HIDE: "datavalidation:prompt-hide",
} as const;
