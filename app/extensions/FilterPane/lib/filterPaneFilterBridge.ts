//! FILENAME: app/extensions/FilterPane/lib/filterPaneFilterBridge.ts
// PURPOSE: Bridges ribbon filter selection changes to table/pivot filters.

import type { RibbonFilter, SlicerConnection } from "./filterPaneTypes";
import { invokeBackend, updateBiPivotFields, getAllPivotTables } from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";
import { getAllFilters } from "./filterPaneStore";

// ============================================================================
// BI Field Helpers
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

function resolveHierarchyFieldRef(
  name: string,
  lookupColumns: string[],
  biModel: HierarchiesInfo["biModel"],
): BiFieldRef {
  if (name.includes(".")) return parseBiFieldRef(name, lookupColumns);
  if (biModel) {
    const nameLower = name.toLowerCase();
    for (const table of biModel.tables) {
      const col = table.columns.find(
        (c) => c.name.toLowerCase() === nameLower,
      );
      if (col) {
        const fullKey = `${table.name}.${col.name}`;
        return {
          table: table.name,
          column: col.name,
          isLookup: lookupColumns.includes(fullKey),
        };
      }
    }
  }
  return parseBiFieldRef(name, lookupColumns);
}

function parseBiValueFieldRef(name: string): BiValueFieldRef {
  return { measureName: name.replace(/^\[|\]$/g, "") };
}

/**
 * Ensure a BI field is in the pivot cache. If missing, adds it as a slicer
 * field by re-configuring the pivot's BI query.
 */
async function ensureBiFieldInPivotCache(
  pivotId: number,
  fieldName: string,
): Promise<boolean> {
  if (!fieldName.includes(".")) return true;

  try {
    const info = await invokeBackend<HierarchiesInfo>(
      "get_pivot_hierarchies",
      { pivotId },
    );

    const colPart = fieldName.split(".").pop()!;
    if (
      info.hierarchies.some(
        (h) => h.name === colPart || h.name === fieldName,
      )
    ) {
      return true;
    }

    if (!info.biModel) return false;

    // Don't modify a pivot that has no measures configured yet —
    // reconstructing its field config would overwrite user changes.
    if (info.dataHierarchies.length === 0) {
      return false;
    }

    const lookupCols = info.biModel.lookupColumns ?? [];

    const rowFields = info.rowHierarchies
      .filter((h) => h.name !== "Total")
      .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, info.biModel));
    const columnFields = info.columnHierarchies
      .filter((h) => h.name !== "Total")
      .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, info.biModel));
    const valueFields = info.dataHierarchies.map((h) =>
      parseBiValueFieldRef(h.name),
    );
    const filterFields = info.filterHierarchies.map((h) =>
      resolveHierarchyFieldRef(h.name, lookupCols, info.biModel),
    );

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
    console.warn(
      "[FilterPane] Failed to ensure BI field in pivot cache:",
      err,
    );
    return false;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Resolve the effective connected sources for a filter based on its connectionMode.
 * - "manual": uses connectedSources as-is
 * - "bySheet": finds all pivots/tables on the specified sheets
 * - "workbook": finds all pivots/tables in the workbook
 */
async function resolveConnections(
  filter: RibbonFilter,
): Promise<SlicerConnection[]> {
  if (filter.connectionMode === "manual" || !filter.connectionMode) {
    return filter.connectedSources ?? [];
  }

  const connections: SlicerConnection[] = [];

  // Get all pivots
  try {
    const pivots = await getAllPivotTables<
      Array<{ id: number; name: string; sourceRange: string }>
    >();

    if (filter.connectionMode === "workbook") {
      // Include all pivots
      for (const pv of pivots) {
        connections.push({ sourceType: "pivot", sourceId: pv.id });
      }
    } else if (filter.connectionMode === "bySheet") {
      const sheetSet = new Set(filter.connectedSheets ?? []);
      for (const pv of pivots) {
        try {
          const biMeta = await invokeBackend<{
            connectionId: number;
            sheetIndex: number;
          } | null>("get_pivot_bi_metadata", { pivotId: pv.id });
          if (biMeta && sheetSet.has(biMeta.sheetIndex)) {
            connections.push({ sourceType: "pivot", sourceId: pv.id });
          }
        } catch {
          // Non-BI pivot — check via pivot table info
          // For now include all pivots (sheet detection for range pivots TBD)
        }
      }
    }
  } catch {
    // No pivots available
  }

  // Get all tables
  try {
    const tables = await invokeBackend<
      Array<{ id: number; name: string; sheetIndex: number }>
    >("get_all_tables", {});

    if (filter.connectionMode === "workbook") {
      for (const t of tables) {
        connections.push({ sourceType: "table", sourceId: t.id });
      }
    } else if (filter.connectionMode === "bySheet") {
      const sheetSet = new Set(filter.connectedSheets ?? []);
      for (const t of tables) {
        if (sheetSet.has(t.sheetIndex)) {
          connections.push({ sourceType: "table", sourceId: t.id });
        }
      }
    }
  } catch {
    // No tables available
  }

  return connections;
}

/**
 * Apply a ribbon filter's selection to all its connected sources.
 * Resolves connections dynamically based on connectionMode.
 * After applying, re-applies all OTHER active filters that target the same
 * pivots, because ensureBiFieldInPivotCache can reset the pivot query.
 */
export async function applyRibbonFilter(filter: RibbonFilter): Promise<void> {
  try {
    // If all items are selected (null), there's no filter to apply.
    // Skip entirely to avoid unnecessary pivot resets and flicker.
    if (filter.selectedItems === null) return;

    const connected = await resolveConnections(filter);
    if (connected.length === 0) return;

    // Collect pivot IDs we're applying to
    const affectedPivotIds = new Set<number>();

    for (const conn of connected) {
      try {
        if (conn.sourceType === "pivot") {
          await applyPivotFilterForSource(
            conn.sourceId,
            filter.fieldName,
            filter.selectedItems,
          );
          affectedPivotIds.add(conn.sourceId);
        } else {
          await applyTableFilterForSource(
            conn.sourceId,
            filter.fieldName,
            filter.selectedItems,
          );
        }
      } catch (err) {
        console.warn(
          "[FilterPane] Failed to apply filter to connected source",
          conn,
          err,
        );
      }
    }

    // Re-apply other active ribbon filters that target the same pivots.
    // This is needed because ensureBiFieldInPivotCache may have reset the
    // pivot query, wiping filters from other ribbon filters.
    if (affectedPivotIds.size > 0) {
      const allFilters = getAllFilters();
      for (const other of allFilters) {
        if (other.id === filter.id) continue;
        if (other.selectedItems === null) continue; // no active filter

        const otherConnected = await resolveConnections(other);
        for (const conn of otherConnected) {
          if (conn.sourceType === "pivot" && affectedPivotIds.has(conn.sourceId)) {
            try {
              await applyPivotFilterForSource(
                conn.sourceId,
                other.fieldName,
                other.selectedItems,
              );
            } catch {
              // Best effort
            }
          }
        }
      }
    }

    emitAppEvent(AppEvents.GRID_DATA_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to apply filter:", err);
  }
}

/**
 * Clear a ribbon filter from all its connected sources.
 */
export async function clearRibbonFilter(filter: RibbonFilter): Promise<void> {
  try {
    const connected = await resolveConnections(filter);
    if (connected.length === 0) return;

    for (const conn of connected) {
      try {
        if (conn.sourceType === "pivot") {
          await applyPivotFilterForSource(conn.sourceId, filter.fieldName, null);
        } else {
          await applyTableFilterForSource(conn.sourceId, filter.fieldName, null);
        }
      } catch (err) {
        // Best effort
      }
    }

    emitAppEvent(AppEvents.GRID_DATA_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to clear filter:", err);
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function applyTableFilterForSource(
  tableId: number,
  fieldName: string,
  selectedItems: string[] | null,
): Promise<void> {
  // Find all tables across all sheets to get the correct sheet index
  const allSheetTables: Array<{
    id: number;
    sheetIndex: number;
    columns: Array<{ name: string }>;
    styleOptions: { headerRow: boolean; showFilterButton: boolean };
  }>[] = [];

  // Try sheets 0..20 (reasonable upper bound)
  for (let si = 0; si < 20; si++) {
    try {
      const tables = await invokeBackend<
        Array<{
          id: number;
          sheetIndex: number;
          columns: Array<{ name: string }>;
          styleOptions: { headerRow: boolean; showFilterButton: boolean };
        }>
      >("get_tables_for_sheet", { sheetIndex: si });
      allSheetTables.push(tables);
    } catch {
      break;
    }
  }

  const flatTables = allSheetTables.flat();
  const table = flatTables.find((t) => t.id === tableId);
  if (!table) return;

  const colIndex = table.columns.findIndex((c) => c.name === fieldName);
  if (colIndex < 0) return;

  if (selectedItems === null) {
    await invokeBackend("clear_column_filter", { columnIndex: colIndex });
  } else {
    await invokeBackend("set_column_filter_values", {
      columnIndex: colIndex,
      values: selectedItems,
    });
  }
}

async function resolveFieldIndex(
  pivotId: number,
  fieldName: string,
): Promise<number> {
  try {
    const info = await invokeBackend<{
      hierarchies: Array<{ index: number; name: string }>;
    }>("get_pivot_hierarchies", { pivotId });
    let field = info.hierarchies.find((h) => h.name === fieldName);
    if (!field && fieldName.includes(".")) {
      const colPart = fieldName.split(".").pop()!;
      field = info.hierarchies.find((h) => h.name === colPart);
    }
    return field ? field.index : -1;
  } catch {
    return -1;
  }
}

async function applyPivotFilterForSource(
  pivotId: number,
  fieldName: string,
  selectedItems: string[] | null,
): Promise<void> {
  let fieldIndex = await resolveFieldIndex(pivotId, fieldName);

  // If field not found, try to add it to the cache (BI pivots)
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
