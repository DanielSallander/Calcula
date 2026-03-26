//! FILENAME: app/extensions/Slicer/lib/slicerEvents.ts
// PURPOSE: Custom event names for the Slicer extension.

export const SlicerEvents = {
  SLICER_CREATED: "slicer:created",
  SLICER_DELETED: "slicer:deleted",
  SLICER_UPDATED: "slicer:updated",
  SLICER_SELECTION_CHANGED: "slicer:selectionChanged",
} as const;
