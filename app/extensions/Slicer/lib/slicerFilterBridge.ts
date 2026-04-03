//! FILENAME: app/extensions/Slicer/lib/slicerFilterBridge.ts
// PURPOSE: Bridges slicer selection changes to table/pivot filters.

import type { Slicer } from "./slicerTypes";
import { invokeBackend } from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";

/**
 * Apply the slicer's current selection as a filter on its data source.
 * For tables: uses AutoFilter column filter values.
 * For pivots: uses pivot field hiddenItems.
 */
export async function applySlicerFilter(slicer: Slicer): Promise<void> {
  try {
    if (slicer.sourceType === "table") {
      await applyTableFilter(slicer);
    } else {
      await applyPivotFilter(slicer);
    }
    // Trigger grid refresh so filtered rows are visible
    emitAppEvent(AppEvents.GRID_DATA_REFRESH);
  } catch (err) {
    console.error("[Slicer] Failed to apply filter:", err);
  }
}

async function applyTableFilter(slicer: Slicer): Promise<void> {
  // Get table info to find the column index
  const tables = await invokeBackend<Array<{
    id: number;
    columns: Array<{ name: string }>;
    styleOptions: { headerRow: boolean; showFilterButton: boolean };
  }>>("get_tables_for_sheet", { sheetIndex: slicer.sheetIndex });

  const table = tables.find((t) => t.id === slicer.sourceId);
  if (!table) {
    console.warn("[Slicer] Table not found:", slicer.sourceId);
    return;
  }

  const colIndex = table.columns.findIndex((c) => c.name === slicer.fieldName);
  if (colIndex < 0) {
    console.warn("[Slicer] Column not found:", slicer.fieldName);
    return;
  }

  if (slicer.selectedItems === null) {
    // All selected = clear the filter for this column
    await invokeBackend("clear_column_filter", { columnIndex: colIndex });
  } else {
    // Set filter to show only selected items
    await invokeBackend("set_column_filter_values", {
      columnIndex: colIndex,
      values: slicer.selectedItems,
    });
  }
}

async function applyPivotFilter(slicer: Slicer): Promise<void> {
  // Resolve field index from field name using pivot hierarchies
  const fieldIndex = await resolveFieldIndex(slicer.sourceId, slicer.fieldName);
  if (fieldIndex < 0) {
    console.warn("[Slicer] Could not resolve field index for:", slicer.fieldName);
    return;
  }

  if (slicer.selectedItems === null) {
    // All selected = clear the filter on this field
    await invokeBackend("clear_pivot_filter", {
      request: {
        pivotId: slicer.sourceId,
        fieldIndex,
      },
    });
  } else {
    // Apply manual filter with selected items
    // The backend computes hidden_items = all_values - selected_items
    await invokeBackend("apply_pivot_filter", {
      request: {
        pivotId: slicer.sourceId,
        fieldIndex,
        filters: {
          manualFilter: { selectedItems: slicer.selectedItems },
        },
      },
    });
  }

  // Notify the Pivot extension to refresh its overlay regions with the new view data.
  // The backend updated the grid cells, but the Pivot overlay renderer needs to
  // refetch the styled view to repaint correctly.
  window.dispatchEvent(new Event("pivot:refresh"));
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
    console.error("[Slicer] Failed to get pivot hierarchies:", err);
    return -1;
  }
}
