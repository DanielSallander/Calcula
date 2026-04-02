//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerEvents.ts
// PURPOSE: Custom event names for timeline slicer inter-module communication.

export const TimelineSlicerEvents = {
  TIMELINE_CREATED: "timelineSlicer:created",
  TIMELINE_DELETED: "timelineSlicer:deleted",
  TIMELINE_UPDATED: "timelineSlicer:updated",
  TIMELINE_SELECTION_CHANGED: "timelineSlicer:selectionChanged",
} as const;
