//! FILENAME: app/extensions/ControlsPane/lib/filterPaneFilterBridge.ts
// PURPOSE: Bridges ribbon filter selection changes to the BI pivots backed
//          by the filter's model connection. Only pivots on the SAME
//          connection are ever targeted — a filter from one Calcula model
//          never touches pivots of another model.

import type { RibbonFilter } from "./filterPaneTypes";
import { updateBiPivotFields } from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";
import { filterPaneBackend } from "./filterPaneBackend";
import { getAllFilters } from "./filterPaneStore";
import { getPivotsForBiConnection } from "./filterPaneApi";

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
  pivotId: string,
  fieldNames: string[],
): Promise<boolean> {
  // Only BI pivots use "table.column" format
  const biFields = fieldNames.filter((f) => f.includes("."));
  if (biFields.length === 0) return true;

  try {
    const info = await filterPaneBackend.invoke<HierarchiesInfo>(
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
 * Resolve the pivots a filter applies to, based on its connectionMode.
 * Candidates are ALWAYS limited to the BI pivots backed by the filter's
 * model connection:
 * - "manual": the user-selected subset (stale/foreign ids dropped)
 * - "bySheet": the connection's pivots on the specified sheets
 * - "workbook": all of the connection's pivots
 */
async function resolveTargetPivots(filter: RibbonFilter): Promise<string[]> {
  let candidates;
  try {
    candidates = await getPivotsForBiConnection(filter.connectionId);
  } catch {
    return [];
  }

  const mode = filter.connectionMode ?? "manual";
  if (mode === "manual") {
    const selected = new Set(filter.connectedPivots ?? []);
    return candidates.filter((p) => selected.has(p.id)).map((p) => p.id);
  }
  if (mode === "bySheet") {
    const sheetSet = new Set(filter.connectedSheets ?? []);
    return candidates.filter((p) => sheetSet.has(p.sheetIndex)).map((p) => p.id);
  }
  return candidates.map((p) => p.id);
}

/**
 * Apply a ribbon filter's selection to all its target pivots.
 * Resolves targets dynamically based on connectionMode.
 * After applying, re-applies all OTHER active filters that target the same
 * pivots, because adding slicer fields can reset the pivot query.
 */
export async function applyRibbonFilter(filter: RibbonFilter): Promise<void> {
  try {
    // If all items are selected (null), there's no filter to apply.
    // Skip entirely to avoid unnecessary pivot resets and flicker.
    if (filter.selectedItems === null) return;

    const targetPivotIds = await resolveTargetPivots(filter);
    if (targetPivotIds.length === 0) return;

    // Collect ALL active filters so we can ensure all fields exist and apply them together
    const allFilters = getAllFilters();
    const activeFilters = allFilters.filter(
      (f) => f.selectedItems !== null,
    );

    // Resolve targets of the other active filters once (used per pivot below)
    const otherTargets = new Map<string, string[]>();
    for (const other of activeFilters) {
      if (other.id === filter.id) continue;
      otherTargets.set(other.id, await resolveTargetPivots(other));
    }

    // Show loading overlay on affected pivots; the finally guarantees the
    // overlays clear even when an apply step throws mid-way.
    for (const pivotId of targetPivotIds) {
      window.dispatchEvent(
        new CustomEvent("pivot:set-loading", {
          detail: { pivotId, stage: "Applying filter..." },
        }),
      );
    }

    try {
      // For each affected pivot, ensure ALL active filter fields are in the cache
      // in a single rebuild, then apply all filters without intermediate refreshes.
      for (const pivotId of targetPivotIds) {
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
          if ((otherTargets.get(other.id) ?? []).includes(pivotId)) {
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
          await filterPaneBackend.invoke("apply_pivot_filter", {
            request: {
              pivotId,
              fieldIndex,
              filters: { manualFilter: { selectedItems: f.selectedItems } },
            },
          });
        }
      }

      // Single pivot:refresh after all filters are applied
      window.dispatchEvent(new Event("pivot:refresh"));
    } finally {
      for (const pivotId of targetPivotIds) {
        window.dispatchEvent(
          new CustomEvent("pivot:clear-loading", { detail: { pivotId } }),
        );
      }
    }

    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to apply filter:", err);
  }
}

/**
 * Clear a ribbon filter from all its target pivots.
 */
export async function clearRibbonFilter(filter: RibbonFilter): Promise<void> {
  try {
    const targetPivotIds = await resolveTargetPivots(filter);
    if (targetPivotIds.length === 0) return;

    // Show loading overlay on affected pivots; cleared in the finally so a
    // failure mid-way can't leave a pivot stuck behind the overlay.
    for (const pivotId of targetPivotIds) {
      window.dispatchEvent(
        new CustomEvent("pivot:set-loading", {
          detail: { pivotId, stage: "Clearing filter..." },
        }),
      );
    }

    try {
      for (const pivotId of targetPivotIds) {
        try {
          await applyPivotFilterForSource(pivotId, filter.fieldName, null);
        } catch (err) {
          // Best effort
        }
      }
    } finally {
      for (const pivotId of targetPivotIds) {
        window.dispatchEvent(
          new CustomEvent("pivot:clear-loading", { detail: { pivotId } }),
        );
      }
    }

    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to clear filter:", err);
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function resolveFieldIndex(
  pivotId: string,
  fieldName: string,
): Promise<number> {
  try {
    const info = await filterPaneBackend.invoke<{
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
  pivotId: string,
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
    await filterPaneBackend.invoke("clear_pivot_filter", {
      request: { pivotId, fieldIndex },
    });
  } else {
    await filterPaneBackend.invoke("apply_pivot_filter", {
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
