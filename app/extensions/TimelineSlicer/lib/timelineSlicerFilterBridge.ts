//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerFilterBridge.ts
// PURPOSE: Bridges timeline slicer selection changes to pivot filters.
// CONTEXT: When the user selects a date range on the timeline, this module
//          fetches the matching date value strings from the backend and
//          applies them as a pivot slicer filter.

import type { TimelineSlicer } from "./timelineSlicerTypes";
import { invokeBackend } from "../../../src/api/backend";
import { emitAppEvent, AppEvents } from "../../../src/api";
import { getTimelineSelectedItems } from "./timeline-slicer-api";

/**
 * Apply the timeline slicer's current selection as a filter on its pivot source.
 * If no selection is active, clears the filter (all dates visible).
 */
export async function applyTimelineFilter(
  timeline: TimelineSlicer,
): Promise<void> {
  try {
    // Get the list of pivot IDs to filter (primary + connected)
    const pivotIds = [
      timeline.sourceId,
      ...timeline.connectedPivotIds.filter((id) => id !== timeline.sourceId),
    ];

    // Get the selected date value strings from the backend
    const selectedItems = await getTimelineSelectedItems(timeline.id);

    for (const pivotId of pivotIds) {
      await applyPivotFilter(pivotId, timeline.fieldName, selectedItems);
    }

    // Trigger grid refresh
    emitAppEvent(AppEvents.GRID_DATA_REFRESH);

    // Notify the Pivot extension to refresh its overlay
    window.dispatchEvent(new Event("pivot:refresh"));
  } catch (err) {
    console.error("[TimelineSlicer] Failed to apply filter:", err);
  }
}

/**
 * Apply a filter on a specific pivot table's date field.
 */
async function applyPivotFilter(
  pivotId: number,
  fieldName: string,
  selectedItems: string[] | null,
): Promise<void> {
  const fieldIndex = await resolveFieldIndex(pivotId, fieldName);
  if (fieldIndex < 0) {
    console.warn(
      "[TimelineSlicer] Could not resolve field index for:",
      fieldName,
    );
    return;
  }

  if (selectedItems === null) {
    // No selection = clear filter
    await invokeBackend("clear_pivot_filter", {
      request: {
        pivotId,
        fieldIndex,
      },
    });
  } else {
    // Apply manual filter with selected date items
    await invokeBackend("apply_pivot_filter", {
      request: {
        pivotId,
        fieldIndex,
        filters: {
          manualFilter: { selectedItems },
        },
      },
    });
  }
}

/**
 * Resolve a pivot field's source index from its name.
 */
async function resolveFieldIndex(
  pivotId: number,
  fieldName: string,
): Promise<number> {
  try {
    const info = await invokeBackend<{
      hierarchies: Array<{ index: number; name: string }>;
    }>("get_pivot_hierarchies", { pivotId });
    const field = info.hierarchies.find((h) => h.name === fieldName);
    return field ? field.index : -1;
  } catch (err) {
    console.error(
      "[TimelineSlicer] Failed to get pivot hierarchies:",
      err,
    );
    return -1;
  }
}
