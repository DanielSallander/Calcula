//! FILENAME: app/extensions/AutoFilter/lib/filterEvents.ts
// PURPOSE: Custom event constants for the AutoFilter extension.

export const FilterEvents = {
  /** AutoFilter toggled on/off */
  FILTER_TOGGLED: "autofilter:toggled",
  /** Filter criteria applied to a column */
  FILTER_APPLIED: "autofilter:applied",
  /** Filter criteria cleared from a column */
  FILTER_CLEARED: "autofilter:cleared",
  /** Filter dropdown opened for a column */
  FILTER_DROPDOWN_OPEN: "autofilter:dropdown-open",
  /** Filter dropdown closed */
  FILTER_DROPDOWN_CLOSE: "autofilter:dropdown-close",
  /** Filter state refreshed (e.g., after sheet switch) */
  FILTER_STATE_REFRESHED: "autofilter:state-refreshed",
} as const;
