//! FILENAME: app/extensions/ControlsPane/lib/controlsPaneEvents.ts
// PURPOSE: Custom event names for pane controls in the Controls pane.
// CONTEXT: Extension-local sibling of FilterPaneEvents (which stays for the
//          ribbon-filter entity family). CONTROL_VALUE_CHANGED_LOCAL is the
//          pane-internal counterpart of the app-wide CONTROL_VALUE_CHANGED
//          facade event (@api/controlValues) — both fire with the same detail.

export const ControlsPaneEvents = {
  CONTROL_CREATED: "paneControl:created",
  CONTROL_DELETED: "paneControl:deleted",
  CONTROL_UPDATED: "paneControl:updated",
  CONTROL_VALUE_CHANGED_LOCAL: "paneControl:valueChanged",
  CONTROLS_REFRESHED: "paneControl:refreshed",
} as const;
