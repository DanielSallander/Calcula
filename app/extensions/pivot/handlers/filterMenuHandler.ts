//! FILENAME: app/extensions/pivot/handlers/filterMenuHandler.ts
// PURPOSE: Handles pivot:openFilterMenu events to show the filter dropdown.
// CONTEXT: When a user clicks a filter dropdown cell in a pivot table,
// this handler fetches the unique values and shows the filter overlay.

import {
  getPivotAtCell,
  getPivotFieldUniqueValues,
  updatePivotFields,
  OverlayExtensions,
} from "../../../src/api";
import { PIVOT_FILTER_OVERLAY_ID } from "../manifest";

/**
 * State for tracking the current filter menu.
 * Needed to pass the apply callback to the overlay.
 */
let currentFilterState: {
  pivotId: number;
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
}): Promise<void> {
  const { fieldIndex, fieldName, row, col, anchorX, anchorY } = detail;

  console.log("[Pivot Extension] Opening filter menu:", { fieldIndex, fieldName, row, col });

  try {
    // Find the pivot at this cell to get pivotId
    const pivotInfo = await getPivotAtCell(row, col);
    if (!pivotInfo) {
      console.warn("[Pivot Extension] No pivot found at filter cell");
      return;
    }

    console.log("[Pivot Extension] Found pivot:", pivotInfo.pivotId);

    // Get unique values for this field
    let allValues: string[] = [];
    try {
      const valuesResponse = await getPivotFieldUniqueValues(pivotInfo.pivotId, fieldIndex);
      console.log("[Pivot Extension] Got unique values:", valuesResponse);
      allValues = valuesResponse?.uniqueValues ?? [];
    } catch (valuesError) {
      console.error("[Pivot Extension] Failed to get unique values:", valuesError);
      // Continue with empty array - user will see "No matching values"
    }

    // All values are selected by default
    const selectedValues = [...allValues];

    // Store current filter state for the apply callback
    currentFilterState = {
      pivotId: pivotInfo.pivotId,
      fieldIndex,
      fieldName,
    };

    // Show the filter overlay
    OverlayExtensions.showOverlay(PIVOT_FILTER_OVERLAY_ID, {
      data: {
        fieldName,
        fieldIndex,
        uniqueValues: allValues,
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
    // Update the pivot with the new filter configuration
    await updatePivotFields({
      pivot_id: currentFilterState.pivotId,
      filter_fields: [
        {
          source_index: fieldIndex,
          name: currentFilterState.fieldName,
          hidden_items: hiddenItems.length > 0 ? hiddenItems : undefined,
        },
      ],
    });

    // Hide the overlay
    OverlayExtensions.hideOverlay(PIVOT_FILTER_OVERLAY_ID);

    // Clear state
    currentFilterState = null;

    // Trigger grid refresh
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[Pivot Extension] Failed to apply filter:", error);
  }
}
