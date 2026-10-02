//! FILENAME: app/extensions/Slicer/lib/slicerEvents.ts
// PURPOSE: Custom event names for the Slicer extension.

export const SlicerEvents = {
  SLICER_CREATED: "slicer:created",
  SLICER_DELETED: "slicer:deleted",
  SLICER_UPDATED: "slicer:updated",
  SLICER_SELECTION_CHANGED: "slicer:selectionChanged",
  /**
   * What the store HOLDS changed -- the slicer list or a slicer's items -- and
   * the cache already holds the new state (a plain Event, no detail). Fired by
   * every re-read and by a reset, whatever caused it: an undo, a pivot
   * refresh, a script. The keyboard inside a slicer (lib/slicerKeys.ts) ends a
   * focus that no longer has an item to stand on AT ONCE, instead of at the
   * next key (M8 review, findings 4 and 9).
   */
  SLICER_DATA_CHANGED: "slicer:dataChanged",
} as const;
