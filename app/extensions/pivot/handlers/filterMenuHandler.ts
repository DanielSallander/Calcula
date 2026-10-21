//! FILENAME: app/extensions/pivot/handlers/filterMenuHandler.ts
// PURPOSE: Handles pivot:openFilterMenu events to show the filter dropdown.
// CONTEXT: When a user clicks a filter dropdown cell in a pivot table,
// this handler fetches the unique values and shows the filter overlay.
//          A request from a canvas pivot BOX's cell while the box shows a
//          filtered view (P4 S7, pivotCrossFilterView.ts) is REFUSED: the
//          box's cells and field indices are the transient view's. From the
//          field list, a PivotChart (which names its pivot) or the ribbon the
//          menu opens on the real pivot as before.

import { pivot } from "@api/pivot";
import { getGridRegions } from "@api/gridOverlays";
import { OverlayExtensions, emitAppEvent } from "@api";
import type { MemberRef } from "@api/pivotMembers";
import { PIVOT_FILTER_OVERLAY_ID } from "../manifest";
import { getCachedPivotView } from "../lib/pivotViewStore";
import { refuseWhileFiltered } from "../lib/pivotCrossFilterView";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "../lib/pivotVisualRegions";

/** The pivot whose canvas box holds hidden-grid cell (row, col), or null. */
function boxPivotAt(row: number, col: number): string | null {
  for (const r of getGridRegions()) {
    if (r.type !== PIVOT_VISUAL_REGION_TYPE) continue;
    if (row < r.startRow || row > r.endRow || col < r.startCol || col > r.endCol) continue;
    const id = pivotIdOfVisual(r);
    if (id) return id;
  }
  return null;
}
import { PivotEvents } from "../../_shared/lib/pivotEvents";

/**
 * State for tracking the current filter menu.
 * Needed to pass the apply callback to the overlay.
 */
let currentFilterState: {
  pivotId: string;
  fieldIndex: number;
  fieldName: string;
} | null = null;

/**
 * Handle the pivot:openFilterMenu event.
 * Opens the filter dropdown overlay with the field's unique values.
 */
export async function handleOpenFilterMenu(detail: {
  fieldIndex: number;
  fieldName: string;
  row: number;
  col: number;
  anchorX: number;
  anchorY: number;
  pivotId?: string;
}): Promise<void> {
  const { fieldIndex, fieldName, row, col, anchorX, anchorY } = detail;

  console.log("[Pivot Extension] Opening filter menu:", { fieldIndex, fieldName, row, col });

  try {
    // Use provided pivotId (e.g. from PivotChart) or find pivot at cell
    let resolvedPivotId = detail.pivotId;
    if (resolvedPivotId == null) {
      // Opened from a cell of a FILTERED box: refused (and said) before
      // anything is asked of the backend.
      const boxPivotId = boxPivotAt(row, col);
      if (boxPivotId !== null && refuseWhileFiltered(boxPivotId)) return;
      const pivotInfo = await pivot.getAtCell(row, col);
      if (!pivotInfo) {
        console.warn("[Pivot Extension] No pivot found at filter cell");
        return;
      }
      resolvedPivotId = pivotInfo.pivotId;
    }

    console.log("[Pivot Extension] Found pivot:", resolvedPivotId);

    // The field's members: the overlay SHOWS labels and selects KEYS.
    let members: MemberRef[] = [];
    try {
      const valuesResponse = await pivot.getFieldUniqueValues(resolvedPivotId, fieldIndex);
      console.log("[Pivot Extension] Got unique values:", valuesResponse);
      members = valuesResponse?.members ?? [];
    } catch (valuesError) {
      console.error("[Pivot Extension] Failed to get unique values:", valuesError);
      // Continue with empty array - user will see "No matching values"
    }

    // Use previously saved filter state if available, otherwise default to all selected
    const cachedView = getCachedPivotView(resolvedPivotId);
    const filterRowMeta = cachedView?.filterRows?.find(
      (fr) => fr.fieldIndex === fieldIndex
    );
    const selectedValues = filterRowMeta?.selectedValues ?? members.map((m) => m.key);

    // Store current filter state for the apply callback
    currentFilterState = {
      pivotId: resolvedPivotId,
      fieldIndex,
      fieldName,
    };

    // Show the filter overlay
    OverlayExtensions.showOverlay(PIVOT_FILTER_OVERLAY_ID, {
      data: {
        fieldName,
        fieldIndex,
        members,
        selectedValues,
        onApply: handleApplyFilter,
      },
      anchorRect: {
        x: anchorX,
        y: anchorY,
        width: 150,
        height: 24,
      },
    });
  } catch (error) {
    console.error("[Pivot Extension] Failed to open filter menu:", error);
  }
}

/**
 * Apply the filter selection.
 */
async function handleApplyFilter(
  fieldIndex: number,
  selectedValues: string[],
  hiddenItems: string[]
): Promise<void> {
  if (!currentFilterState) {
    console.warn("[Pivot Extension] No current filter state");
    return;
  }

  console.log("[Pivot Extension] Applying filter:", { fieldIndex, selectedValues, hiddenItems });

  try {
    // Filter THIS field only. This used to send `update_pivot_fields` with a
    // one-entry filterFields list, and that command REPLACES the whole zone:
    // every other report filter left the pivot, with its own filter
    // (review3 finding 2). apply/clear_pivot_filter patch one field and keep
    // the rest; they also carry the overwrite prompt and the undo step.
    if (hiddenItems.length === 0) {
      await pivot.clearFilter({ pivotId: currentFilterState.pivotId, fieldIndex });
    } else {
      await pivot.applyFilter({
        pivotId: currentFilterState.pivotId,
        fieldIndex,
        filters: { manualFilter: { selectedItems: selectedValues } },
      });
    }

    // Notify the PivotEditor so it can update its zone state
    emitAppEvent(PivotEvents.PIVOT_FILTER_APPLIED, {
      pivotId: currentFilterState.pivotId,
      fieldIndex,
      fieldName: currentFilterState.fieldName,
      hiddenItems: hiddenItems.length > 0 ? hiddenItems : undefined,
      allValues: [...selectedValues, ...hiddenItems],
    });

    // Hide the overlay
    OverlayExtensions.hideOverlay(PIVOT_FILTER_OVERLAY_ID);

    // Clear state
    currentFilterState = null;

    // Trigger pivot and grid refresh
    window.dispatchEvent(new Event("pivot:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    window.dispatchEvent(new CustomEvent("styles:refresh"));
  } catch (error) {
    console.error("[Pivot Extension] Failed to apply filter:", error);
  }
}
