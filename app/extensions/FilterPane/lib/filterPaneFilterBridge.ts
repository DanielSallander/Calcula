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
 * Ensure ALL given BI fields are in the pivot cache. If any are missing,
 * adds them all as slicer fields in a single pivot rebuild.
 * This avoids multiple rebuilds that would wipe each other's filters.
 */
async function ensureBiFieldsInPivotCache(
  pivotId: number,
  fieldNames: string[],
): Promise<boolean> {
  // Only BI pivots use "table.column" format
  const biFields = fieldNames.filter((f) => f.includes("."));
  if (biFields.length === 0) return true;

  try {
    const info = await invokeBackend<HierarchiesInfo>(
      "get_pivot_hierarchies",
      { pivotId },
    );

    // Check which fields are missing from the cache
    const missingFields = biFields.filter((fieldName) => {
      const colPart = fieldName.split(".").pop()!;
      return !info.hierarchies.some(
        (h) => h.name === colPart || h.name === fieldName,
      );
    });

    if (missingFields.length === 0) return true;

    if (!info.biModel) return false;

    // Don't modify a pivot that has no measures configured yet
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

    // Add ALL missing fields as slicer fields in one rebuild
    const slicerFields = biFields.map((f) => parseBiFieldRef(f, []));

    await updateBiPivotFields({
      pivotId,
      rowFields,
      columnFields,
      valueFields,
      filterFields,
      slicerFields,
      lookupColumns: lookupCols,
    });

    return true;
  } catch (err) {
    console.warn(
      "[FilterPane] Failed to ensure BI fields in pivot cache:",
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
 * pivots, because adding slicer fields can reset the pivot query.
 */
export async function applyRibbonFilter(filter: RibbonFilter): Promise<void> {
  try {
    // If all items are selected (null), there's no filter to apply.
    // Skip entirely to avoid unnecessary pivot resets and flicker.
    if (filter.selectedItems === null) return;

    const connected = await resolveConnections(filter);
    if (connected.length === 0) return;

    // Collect ALL active filters so we can ensure all fields exist and apply them together
    const allFilters = getAllFilters();
    const activeFilters = allFilters.filter(
      (f) => f.selectedItems !== null,
    );

    // Collect pivot IDs we're applying to
    const affectedPivotIds = new Set<number>();

    // Show loading overlay on affected pivots
    for (const conn of connected) {
      if (conn.sourceType === "pivot") {
        affectedPivotIds.add(conn.sourceId);
        window.dispatchEvent(
          new CustomEvent("pivot:set-loading", {
            detail: { pivotId: conn.sourceId, stage: "Applying filter..." },
          }),
        );
      }
    }

    // For each affected pivot, ensure ALL active filter fields are in the cache
    // in a single rebuild, then apply all filters without intermediate refreshes.
    for (const pivotId of affectedPivotIds) {
      // Collect all field names that need to be in this pivot's cache
      const allFieldNames: string[] = [];
      const filtersForPivot: Array<{ fieldName: string; selectedItems: string[] }> = [];

      // The current filter
      allFieldNames.push(filter.fieldName);
      filtersForPivot.push({
        fieldName: filter.fieldName,
        selectedItems: filter.selectedItems!,
      });

      // Other active filters targeting the same pivot
      for (const other of activeFilters) {
        if (other.id === filter.id) continue;
        const otherConnected = await resolveConnections(other);
        if (otherConnected.some((c) => c.sourceType === "pivot" && c.sourceId === pivotId)) {
          allFieldNames.push(other.fieldName);
          filtersForPivot.push({
            fieldName: other.fieldName,
            selectedItems: other.selectedItems!,
          });
        }
      }

      // Ensure all fields exist in the cache (single rebuild if needed)
      await ensureBiFieldsInPivotCache(pivotId, allFieldNames);

      // Apply all filters without triggering pivot:refresh between them
      for (const f of filtersForPivot) {
        const fieldIndex = await resolveFieldIndex(pivotId, f.fieldName);
        if (fieldIndex < 0) continue;
        await invokeBackend("apply_pivot_filter", {
          request: {
            pivotId,
            fieldIndex,
            filters: { manualFilter: { selectedItems: f.selectedItems } },
          },
        });
      }
    }

    // Apply table filters
    for (const conn of connected) {
      if (conn.sourceType !== "table") continue;
      try {
        await applyTableFilterForSource(
          conn.sourceId,
          filter.fieldName,
          filter.selectedItems,
        );
      } catch (err) {
        console.warn("[FilterPane] Failed to apply table filter", conn, err);
      }
    }

    // Single pivot:refresh after all filters are applied
    if (affectedPivotIds.size > 0) {
      window.dispatchEvent(new Event("pivot:refresh"));
    }

    // Clear loading overlay on affected pivots
    for (const pivotId of affectedPivotIds) {
      window.dispatchEvent(
        new CustomEvent("pivot:clear-loading", { detail: { pivotId } }),
      );
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

    // Show loading overlay on affected pivots
    for (const conn of connected) {
      if (conn.sourceType === "pivot") {
        window.dispatchEvent(
          new CustomEvent("pivot:set-loading", {
            detail: { pivotId: conn.sourceId, stage: "Clearing filter..." },
          }),
        );
      }
    }

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

    // Clear loading overlay
    for (const conn of connected) {
      if (conn.sourceType === "pivot") {
        window.dispatchEvent(
          new CustomEvent("pivot:clear-loading", { detail: { pivotId: conn.sourceId } }),
        );
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
    const added = await ensureBiFieldsInPivotCache(pivotId, [fieldName]);
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
