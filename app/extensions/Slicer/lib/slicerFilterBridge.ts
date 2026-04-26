//! FILENAME: app/extensions/Slicer/lib/slicerFilterBridge.ts
// PURPOSE: Bridges slicer selection changes to table/pivot filters.

import type { Slicer } from "./slicerTypes";
import { invokeBackend, updateBiPivotFields } from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";

// ============================================================================
// BI Pivot Field Helpers
// ============================================================================

interface BiFieldRef {
  table: string;
  column: string;
  isLookup: boolean;
}

interface BiValueFieldRef {
  measureName: string;
}

interface HierarchiesInfo {
  hierarchies: Array<{ index: number; name: string }>;
  rowHierarchies: Array<{ name: string }>;
  columnHierarchies: Array<{ name: string }>;
  dataHierarchies: Array<{ name: string }>;
  filterHierarchies: Array<{ name: string }>;
  biModel?: {
    tables: Array<{ name: string; columns: Array<{ name: string }> }>;
    lookupColumns?: string[];
  };
}

function parseBiFieldRef(name: string, lookupColumns: string[]): BiFieldRef {
  const dotIdx = name.indexOf(".");
  const table = dotIdx >= 0 ? name.substring(0, dotIdx) : "";
  const column = dotIdx >= 0 ? name.substring(dotIdx + 1) : name;
  return { table, column, isLookup: lookupColumns.includes(name) };
}

/**
 * Resolve a hierarchy name (which may be just "column" from the Arrow schema)
 * to a full BiFieldRef by looking up the table name in the BI model.
 */
function resolveHierarchyFieldRef(
  name: string,
  lookupColumns: string[],
  biModel: HierarchiesInfo["biModel"],
): BiFieldRef {
  if (name.includes(".")) {
    return parseBiFieldRef(name, lookupColumns);
  }
  // Bare column name from cache — find which table it belongs to.
  // Case-insensitive since Arrow schema names may differ in casing.
  if (biModel) {
    const nameLower = name.toLowerCase();
    for (const table of biModel.tables) {
      const col = table.columns.find((c: { name: string }) => c.name.toLowerCase() === nameLower);
      if (col) {
        const fullKey = `${table.name}.${col.name}`;
        return { table: table.name, column: col.name, isLookup: lookupColumns.includes(fullKey) };
      }
    }
  }
  console.warn("[Slicer] resolveHierarchyFieldRef: could not resolve table for bare field name:", name);
  return parseBiFieldRef(name, lookupColumns);
}

function parseBiValueFieldRef(name: string): BiValueFieldRef {
  return { measureName: name.replace(/^\[|\]$/g, "") };
}

/**
 * For BI pivots, ensures the slicer's field is in the pivot cache.
 * If the field is missing (e.g. removed from all visible zones), adds it
 * as a filter field by re-configuring the BI pivot query.
 * Returns true if the field is (now) available.
 *
 * For range-based pivots this is a no-op (all source columns are always
 * in the cache).
 */
export async function ensureBiFieldInPivotCache(
  pivotId: number,
  fieldName: string,
): Promise<boolean> {
  // Only BI pivots use "table.column" format
  if (!fieldName.includes(".")) return true;

  try {
    const info = await invokeBackend<HierarchiesInfo>(
      "get_pivot_hierarchies",
      { pivotId },
    );

    // Check if field is already in cache
    const colPart = fieldName.split(".").pop()!;
    if (info.hierarchies.some((h) => h.name === colPart || h.name === fieldName)) {
      return true;
    }

    // Not a BI pivot or no model info — can't auto-add
    if (!info.biModel) return false;

    const lookupCols = info.biModel.lookupColumns ?? [];

    // Reconstruct current field configuration (skip synthetic "Total" field)
    const rowFields = info.rowHierarchies
      .filter((h) => h.name !== "Total")
      .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, info.biModel));
    const columnFields = info.columnHierarchies
      .filter((h) => h.name !== "Total")
      .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, info.biModel));
    const valueFields = info.dataHierarchies.map((h) => parseBiValueFieldRef(h.name));
    const filterFields = info.filterHierarchies.map((h) => resolveHierarchyFieldRef(h.name, lookupCols, info.biModel));

    // Add the missing field as a slicer field — included in the GROUP BY
    // query so it appears in the cache, but NOT shown as a visible filter row.
    await updateBiPivotFields({
      pivotId,
      rowFields,
      columnFields,
      valueFields,
      filterFields,
      slicerFields: [parseBiFieldRef(fieldName, [])],
      lookupColumns: lookupCols,
    });

    window.dispatchEvent(new Event("pivot:refresh"));
    return true;
  } catch (err) {
    console.warn("[Slicer] Failed to ensure BI field in pivot cache:", err);
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply the slicer's current selection as a filter on its data source
 * and all additionally connected sources.
 * For tables: uses AutoFilter column filter values.
 * For pivots: uses pivot field hiddenItems.
 */
/**
 * Called when Report Connections change. Clears filters on removed pivots/tables
 * and applies the slicer's current selection on newly added ones.
 */
export async function syncReportConnections(
  slicer: Slicer,
  oldIds: number[],
  newIds: number[],
): Promise<void> {
  try {
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);

    // Clear filter on disconnected sources
    const removed = oldIds.filter((id) => !newSet.has(id));
    for (const sourceId of removed) {
      try {
        if (slicer.sourceType === "pivot") {
          await applyPivotFilterForSource(sourceId, slicer.fieldName, null, slicer.sheetIndex);
        } else {
          await applyTableFilterForSource(sourceId, slicer.fieldName, null, slicer.sheetIndex);
        }
      } catch (err) {
        console.warn("[Slicer] Failed to clear filter on disconnected source", sourceId, err);
      }
    }

    // Apply current filter on newly connected sources
    const added = newIds.filter((id) => !oldSet.has(id));
    for (const sourceId of added) {
      try {
        if (slicer.sourceType === "pivot") {
          await applyPivotFilterForSource(sourceId, slicer.fieldName, slicer.selectedItems, slicer.sheetIndex);
        } else {
          await applyTableFilterForSource(sourceId, slicer.fieldName, slicer.selectedItems, slicer.sheetIndex);
        }
      } catch (err) {
        console.warn("[Slicer] Failed to apply filter on new connection", sourceId, err);
      }
    }

    if (removed.length > 0 || added.length > 0) {
      emitAppEvent(AppEvents.GRID_DATA_REFRESH);
    }
  } catch (err) {
    console.error("[Slicer] Failed to sync report connections:", err);
  }
}

export async function applySlicerFilter(slicer: Slicer): Promise<void> {
  try {
    const connected = slicer.connectedSourceIds ?? [];

    // No connections — nothing to filter
    if (connected.length === 0) return;

    // Apply filter to ALL connected sources (all equal, no primary)
    for (const sourceId of connected) {
      try {
        if (slicer.sourceType === "pivot") {
          await applyPivotFilterForSource(sourceId, slicer.fieldName, slicer.selectedItems, slicer.sheetIndex);
        } else {
          await applyTableFilterForSource(sourceId, slicer.fieldName, slicer.selectedItems, slicer.sheetIndex);
        }
      } catch (err) {
        console.warn("[Slicer] Failed to apply filter to connected source", sourceId, err);
      }
    }

    // Trigger grid refresh so filtered rows are visible
    emitAppEvent(AppEvents.GRID_DATA_REFRESH);
  } catch (err) {
    console.error("[Slicer] Failed to apply filter:", err);
  }
}

/**
 * Apply a table filter to a specific table source.
 */
async function applyTableFilterForSource(
  tableId: number,
  fieldName: string,
  selectedItems: string[] | null,
  sheetIndex: number,
): Promise<void> {
  const tables = await invokeBackend<Array<{
    id: number;
    columns: Array<{ name: string }>;
    styleOptions: { headerRow: boolean; showFilterButton: boolean };
  }>>("get_tables_for_sheet", { sheetIndex });

  const table = tables.find((t) => t.id === tableId);
  if (!table) {
    console.warn("[Slicer] Table not found:", tableId);
    return;
  }

  const colIndex = table.columns.findIndex((c) => c.name === fieldName);
  if (colIndex < 0) {
    console.warn("[Slicer] Column not found:", fieldName);
    return;
  }

  if (selectedItems === null) {
    await invokeBackend("clear_column_filter", { columnIndex: colIndex });
  } else {
    await invokeBackend("set_column_filter_values", {
      columnIndex: colIndex,
      values: selectedItems,
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
    // Try exact match first, then "table.column" -> "column" fallback
    let field = info.hierarchies.find((h) => h.name === fieldName);
    if (!field && fieldName.includes(".")) {
      const colPart = fieldName.split(".").pop()!;
      field = info.hierarchies.find((h) => h.name === colPart);
    }
    return field ? field.index : -1;
  } catch (err) {
    console.error("[Slicer] Failed to get pivot hierarchies:", err);
    return -1;
  }
}

/**
 * Apply a pivot filter to an additional connected pivot table.
 */
async function applyPivotFilterForSource(
  pivotId: number,
  fieldName: string,
  selectedItems: string[] | null,
  _sheetIndex: number,
): Promise<void> {
  let fieldIndex = await resolveFieldIndex(pivotId, fieldName);

  // If field not found, try to ensure it's in the cache (BI pivots)
  if (fieldIndex < 0) {
    const added = await ensureBiFieldInPivotCache(pivotId, fieldName);
    if (added) {
      fieldIndex = await resolveFieldIndex(pivotId, fieldName);
    }
  }

  if (fieldIndex < 0) return;

  if (selectedItems === null) {
    await invokeBackend("clear_pivot_filter", {
      request: { pivotId, fieldIndex },
    });
  } else {
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

  window.dispatchEvent(new Event("pivot:refresh"));
}
