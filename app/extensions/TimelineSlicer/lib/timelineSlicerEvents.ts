//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerEvents.ts
// PURPOSE: Custom event names for timeline slicer inter-module communication.

export const TimelineSlicerEvents = {
  TIMELINE_CREATED: "timelineSlicer:created",
  TIMELINE_DELETED: "timelineSlicer:deleted",
  TIMELINE_UPDATED: "timelineSlicer:updated",
  TIMELINE_SELECTION_CHANGED: "timelineSlicer:selectionChanged",
  /**
   * What the store HOLDS changed -- the timeline list (where a timeline's
   * LEVEL lives) or a timeline's periods -- and the cache already holds the
   * new state (a plain Event, no detail). Fired by every re-read and by a
   * reset, whatever caused it: an undo of a level change, a pivot refresh, a
   * script, the ribbon. The keyboard inside a timeline (lib/timelineKeys.ts)
   * ends a focus that no longer resolves AT ONCE, instead of at the next key
   * (M8 review, findings 4 and 9).
   */
  TIMELINE_DATA_CHANGED: "timelineSlicer:dataChanged",
} as const;
