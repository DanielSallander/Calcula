//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerFilterBridge.ts
// PURPOSE: Bridges timeline slicer selection changes to pivot filters.
// CONTEXT: When the user selects a date range on the timeline, this module
//          fetches the matching date value strings from the backend and
//          applies them as a pivot slicer filter.

import type { TimelineSlicer } from "./timelineSlicerTypes";
import type { PivotViewResponse } from "@api/pivotTypes";
import type { PivotOverwriteTally } from "@api/pivotOverwrite";
import {
  clearPivotFilter,
  applyPivotFilter,
  getPivotHierarchies,
} from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";
import { getTimelineSelectedItems } from "./timeline-slicer-api";

/** How {@link applyTimelineFilter} runs. */
export interface ApplyTimelineFilterOptions {
  /** Note every pivot response here, for the gesture's ONE "will overwrite
   *  existing data" question (`@api/pivotOverwrite`). */
  overwrites?: PivotOverwriteTally;
  /** A RE-APPLY of a selection a take-back already restored: every request
   *  carries `reconcile: true`, so the backend records NOTHING for it. */
  reconcile?: boolean;
}

/**
 * Apply the timeline slicer's current selection as a filter on its pivot source.
 * If no selection is active, clears the filter (all dates visible).
 */
export async function applyTimelineFilter(
  timeline: TimelineSlicer,
  options: ApplyTimelineFilterOptions = {},
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
      await applyTimelinePivotFilter(pivotId, timeline.fieldName, selectedItems, options);
    }

    // Trigger grid refresh
    emitAppEvent(AppEvents.GRID_REFRESH);

    // Notify the Pivot extension to refresh its overlay
    window.dispatchEvent(new Event("pivot:refresh"));
  } catch (err) {
    console.error("[TimelineSlicer] Failed to apply filter:", err);
  }
}

/**
 * Apply a filter on a specific pivot table's date field. (Named distinctly from
 * the imported `applyPivotFilter` backend wrapper it delegates to.)
 */
async function applyTimelinePivotFilter(
  pivotId: string,
  fieldName: string,
  selectedItems: string[] | null,
  options: ApplyTimelineFilterOptions,
): Promise<void> {
  const fieldIndex = await resolveFieldIndex(pivotId, fieldName);
  if (fieldIndex < 0) {
    console.warn(
      "[TimelineSlicer] Could not resolve field index for:",
      fieldName,
    );
    return;
  }

  const quiet = options.reconcile ? { reconcile: true } : {};
  // A pivot the filter grows over the user's cells records a step holding
  // them; its response is noted for the gesture's one question. (Awaited on
  // its own line: `overwrites?.note(await ...)` would skip the WRITE.)
  let response: PivotViewResponse;
  if (selectedItems === null) {
    // No selection = clear filter
    response = await clearPivotFilter<unknown, PivotViewResponse>({
      pivotId,
      fieldIndex,
      ...quiet,
    });
  } else {
    // Apply manual filter with selected date items
    response = await applyPivotFilter<unknown, PivotViewResponse>({
      pivotId,
      fieldIndex,
      filters: {
        manualFilter: { selectedItems },
      },
      ...quiet,
    });
  }
  options.overwrites?.note(response);
}

/**
 * Resolve a pivot field's source index from its name.
 */
async function resolveFieldIndex(
  pivotId: string,
  fieldName: string,
): Promise<number> {
  try {
    const info = await getPivotHierarchies<{
      hierarchies: Array<{ index: number; name: string }>;
    }>(pivotId);
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
