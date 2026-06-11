//! FILENAME: app/extensions/pivot/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the pivot editor pane.
// CONTEXT: When the user selects a cell within a pivot region, we show the editor.
// When they select outside, we hide it.

import { pivot } from "@api/pivot";
import {
  openTaskPane,
  closeTaskPane,
  getTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  ExtensionRegistry,
  emitAppEvent,
} from "@api";
import type { LayoutConfig, AggregationType } from "@api";
import {
  PIVOT_PANE_ID,
  PivotDesignTabDefinition,
  PIVOT_DESIGN_TAB_ID,
  PivotAnalyzeTabDefinition,
  PIVOT_ANALYZE_TAB_ID,
} from "../manifest";
import type { SourceField, ZoneField, PivotEditorViewData, PivotRegionData } from "../types";
import { PivotEvents } from "../lib/pivotEvents";

// ---------------------------------------------------------------------------
// Module-level state (owned by the pivot extension, not by the shell)
// ---------------------------------------------------------------------------

/** Cached pivot regions for fast local bounds checking. */
let cachedRegions: PivotRegionData[] = [];

/** The currently active pivot ID (set when selection is inside a pivot region).
 *  Exported so ribbon tabs can read it directly on mount without waiting for events. */
let activePivotId: string | null = null;

/** Get the currently active pivot ID. */
export function getActivePivotId(): string | null {
  return activePivotId;
}

/** Flag to prevent closing the pane right after a pivot is created (regions not yet cached). */
let justCreatedPivot = false;

/** Track last checked selection to avoid redundant API calls. */
let lastCheckedSelection: { row: number; col: number } | null = null;

/** Guard against overlapping async checks. */
let checkInProgress = false;

/** Debounce timer for selection changes within a pivot region. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether the contextual pivot ribbon tabs are currently registered. */
let designTabRegistered = false;
let analyzeTabRegistered = false;

// ---------------------------------------------------------------------------
// State mutators (called by other handlers / extension index)
// ---------------------------------------------------------------------------

/**
 * Update the cached pivot regions.
 * Called when a `pivot:regionsUpdated` event fires.
 */
export function updateCachedRegions(regions: PivotRegionData[]): void {
  cachedRegions = Array.isArray(regions) ? regions : [];
  // Regions arrived, so clear the just-created flag
  justCreatedPivot = false;

  // When there are no pivot regions on the current sheet (e.g. after
  // deleting a pivot sheet), unregister the contextual ribbon tabs and
  // close the task pane immediately. Without this, the tabs and pane
  // linger because the selection handler's lastCheckedSelection cache
  // may prevent re-evaluation.
  if (cachedRegions.length === 0) {
    lastCheckedSelection = null;
    if (analyzeTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(PIVOT_ANALYZE_TAB_ID);
      analyzeTabRegistered = false;
    }
    if (designTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(PIVOT_DESIGN_TAB_ID);
      designTabRegistered = false;
    }
    removeTaskPaneContextKey("pivot");
    closeTaskPane(PIVOT_PANE_ID);
  }
}

/**
 * Set the justCreatedPivot flag.
 * Called by pivotCreatedHandler before opening the pane.
 */
export function setJustCreatedPivot(value: boolean): void {
  justCreatedPivot = value;
}

/**
 * Ensure the contextual pivot ribbon tabs are registered.
 * Called by pivotCreatedHandler so the tabs appear immediately on creation,
 * regardless of whether the selection handler has run yet.
 */
export function ensureDesignTabRegistered(): void {
  if (!analyzeTabRegistered) {
    ExtensionRegistry.registerRibbonTab(PivotAnalyzeTabDefinition);
    analyzeTabRegistered = true;
  }
  if (!designTabRegistered) {
    ExtensionRegistry.registerRibbonTab(PivotDesignTabDefinition);
    designTabRegistered = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get all cached pivot regions (for guard checks, etc.).
 */
export function getCachedRegions(): PivotRegionData[] {
  return cachedRegions;
}

/**
 * Shift cached pivot regions when columns are inserted.
 * This keeps cachedRegions in sync with the grid overlay regions
 * so that findPivotRegionAtCell returns correct results immediately.
 */
export function shiftCachedRegionsForColInsert(col: number, count: number): void {
  for (const r of cachedRegions) {
    if (r.startCol >= col) {
      r.startCol += count;
      r.endCol += count;
    } else if (r.endCol >= col) {
      r.endCol += count;
    }
  }
  // Reset so the next selection change re-evaluates against updated regions
  lastCheckedSelection = null;
}

/**
 * Shift cached pivot regions when rows are inserted.
 */
export function shiftCachedRegionsForRowInsert(row: number, count: number): void {
  for (const r of cachedRegions) {
    if (r.startRow >= row) {
      r.startRow += count;
      r.endRow += count;
    } else if (r.endRow >= row) {
      r.endRow += count;
    }
  }
  lastCheckedSelection = null;
}

/**
 * Shift cached pivot regions when columns are deleted.
 */
export function shiftCachedRegionsForColDelete(col: number, count: number): void {
  cachedRegions = cachedRegions.filter((r) => {
    // Remove regions fully within the deleted range
    if (r.startCol >= col && r.endCol < col + count) return false;
    return true;
  });
  for (const r of cachedRegions) {
    if (r.startCol >= col + count) {
      r.startCol -= count;
      r.endCol -= count;
    } else if (r.endCol >= col) {
      r.endCol -= count;
    }
  }
  lastCheckedSelection = null;
}

/**
 * Shift cached pivot regions when rows are deleted.
 */
export function shiftCachedRegionsForRowDelete(row: number, count: number): void {
  cachedRegions = cachedRegions.filter((r) => {
    if (r.startRow >= row && r.endRow < row + count) return false;
    return true;
  });
  for (const r of cachedRegions) {
    if (r.startRow >= row + count) {
      r.startRow -= count;
      r.endRow -= count;
    } else if (r.endRow >= row) {
      r.endRow -= count;
    }
  }
  lastCheckedSelection = null;
}

/**
 * Fast local check if a cell is within any cached pivot region.
 * Exported so other pivot handlers (e.g., context menu) can reuse the cache.
 */
export function findPivotRegionAtCell(
  row: number,
  col: number,
): PivotRegionData | null {
  for (const region of cachedRegions) {
    if (
      row >= region.startRow &&
      row <= region.endRow &&
      col >= region.startCol &&
      col <= region.endCol
    ) {
      return region;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle selection change to show/hide the pivot pane.
 * Called by the ExtensionRegistry.onSelectionChange subscription.
 */
export function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) {
    return;
  }

  const row = selection.endRow;
  const col = selection.endCol;

  // Skip if we already checked this exact cell
  if (
    lastCheckedSelection &&
    lastCheckedSelection.row === row &&
    lastCheckedSelection.col === col
  ) {
    console.log(`[CALP-DIAG] handleSelectionChange(${row},${col}) SKIPPED (same cell)`);
    return;
  }

  // Skip if a check is already in progress
  if (checkInProgress) {
    console.log(`[CALP-DIAG] handleSelectionChange(${row},${col}) SKIPPED (checkInProgress)`);
    return;
  }

  const manuallyClosed = getTaskPaneManuallyClosed();

  // Fast local bounds check using cached regions
  const localPivotRegion = findPivotRegionAtCell(row, col);

  console.log(`[CALP-DIAG] handleSelectionChange(${row},${col}): inPivot=${!!localPivotRegion}, manuallyClosed=${manuallyClosed.includes(PIVOT_PANE_ID)}, cachedRegions=${cachedRegions.length}, analyzeTabRegistered=${analyzeTabRegistered}, lastChecked=${JSON.stringify(lastCheckedSelection)}`);

  if (localPivotRegion === null) {
    // Cell is NOT in any pivot region - close pivot pane if open
    // BUT skip if a pivot was just created (regions not yet cached)
    if (justCreatedPivot) {
      // Register pivot tabs even though regions aren't cached yet —
      // we know the user just created a pivot and is inside it.
      if (!analyzeTabRegistered) {
        ExtensionRegistry.registerRibbonTab(PivotAnalyzeTabDefinition);
        analyzeTabRegistered = true;
      }
      if (!designTabRegistered) {
        ExtensionRegistry.registerRibbonTab(PivotDesignTabDefinition);
        designTabRegistered = true;
      }
      return;
    }
    lastCheckedSelection = { row, col };
    activePivotId = null;
    removeTaskPaneContextKey("pivot");
    closeTaskPane(PIVOT_PANE_ID);
    // Hide the contextual pivot ribbon tabs
    if (analyzeTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(PIVOT_ANALYZE_TAB_ID);
      analyzeTabRegistered = false;
    }
    if (designTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(PIVOT_DESIGN_TAB_ID);
      designTabRegistered = false;
    }
    return;
  }

  // Cell IS in a pivot region - set context key and active pivot ID
  activePivotId = localPivotRegion.pivotId;
  addTaskPaneContextKey("pivot");
  // Show the contextual pivot ribbon tabs
  if (!analyzeTabRegistered) {
    ExtensionRegistry.registerRibbonTab(PivotAnalyzeTabDefinition);
    analyzeTabRegistered = true;
  }
  if (!designTabRegistered) {
    ExtensionRegistry.registerRibbonTab(PivotDesignTabDefinition);
    designTabRegistered = true;
  }

  // Check if manually closed — still need to notify ribbon tabs of the active pivot
  if (manuallyClosed.includes(PIVOT_PANE_ID)) {
    lastCheckedSelection = { row, col };
    // Fetch pivot info for the ribbon tabs even though the pane is closed.
    // Use setTimeout to ensure the ribbon tab components have mounted
    // (they're registered just above, but React needs a tick to render them).
    const region = cachedRegions.find(
      (r) => row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol
    );
    console.log(`[CALP-DIAG] handleSelectionChange: pane manually closed, region=${region ? `pivotId=${region.pivotId}` : 'null'}, scheduling PIVOT_LAYOUT_STATE`);
    if (region) {
      setTimeout(() => {
        emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, {
          pivotId: region.pivotId,
          layout: {},
        });
      }, 50);
    }
    return;
  }

  // Clear any pending debounce
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }

  // Small delay to debounce rapid selection changes within pivot regions
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    checkPivotAtSelection(row, col);
  }, 50);
}

/**
 * Fetch full pivot details for the given cell and open/close the pane.
 */
async function checkPivotAtSelection(
  row: number,
  col: number,
): Promise<void> {
  checkInProgress = true;
  lastCheckedSelection = { row, col };

  const t0 = performance.now();
  try {
    const pivotInfo = await pivot.getAtCell(row, col);
    console.log(`[PERF][pivot-sel] checkPivotAtSelection(${row},${col}) getAtCell=${(performance.now() - t0).toFixed(1)}ms found=${!!pivotInfo}`);

    if (pivotInfo) {
      // Convert source fields from backend format
      const sourceFields: SourceField[] = pivotInfo.sourceFields.map((field) => ({
        index: field.index,
        name: field.name,
        isNumeric: field.isNumeric,
      }));

      const config = pivotInfo.fieldConfiguration;

      const isBiPivot = !!pivotInfo.biModel;

      if (isBiPivot) {
        console.log(`[CALP-DIAG] checkPivotAtSelection: BI pivot detected, pivotId=${pivotInfo.pivotId}, connectionId=${pivotInfo.biModel?.connectionId}, tables=${pivotInfo.biModel?.tables?.length}, measures=${pivotInfo.biModel?.measures?.length}`);
        console.log(`[CALP-DIAG]   row_fields=${config.rowFields.length} [${config.rowFields.map(f => f.name).join(', ')}]`);
        console.log(`[CALP-DIAG]   col_fields=${config.columnFields.length} [${config.columnFields.map(f => f.name).join(', ')}]`);
        console.log(`[CALP-DIAG]   val_fields=${config.valueFields.length} [${config.valueFields.map(f => f.name).join(', ')}]`);
        console.log(`[CALP-DIAG]   sourceFields=${pivotInfo.sourceFields.length}`);
      }

      // For BI pivots, use sourceIndex = -1 so the frontend consistently
      // uses name-based references (not cache column indices)
      const biIdx = isBiPivot ? -1 : undefined;

      // Reconstitute hierarchy fields: replace individual level fields with
      // a single hierarchy ZoneField using the "Table.__hierarchy__.Name" convention.
      const hierarchyConfigs = config.hierarchyConfigs || [];

      const reconstitute = (
        fields: typeof config.rowFields,
        isRow: boolean,
      ): ZoneField[] => {
        const result: ZoneField[] = [];
        const skipIndices = new Set<number>();

        // Mark indices covered by hierarchies and emit a single hierarchy field
        for (const hc of hierarchyConfigs) {
          if (hc.isRow !== isRow) continue;
          for (let i = hc.fieldStart; i < hc.fieldStart + hc.fieldCount; i++) {
            skipIndices.add(i);
          }
          // Find the table from the first level field
          const firstField = fields[hc.fieldStart];
          if (firstField) {
            const dotIdx = firstField.name.indexOf('.');
            const table = dotIdx >= 0 ? firstField.name.substring(0, dotIdx) : '';
            result.push({
              sourceIndex: -3,
              name: `${table}.__hierarchy__.${hc.name}`,
              isNumeric: false,
              customName: `${table}.__hierarchy__.${hc.name}`,
            });
          }
        }

        // Add non-hierarchy fields
        for (let i = 0; i < fields.length; i++) {
          if (skipIndices.has(i)) continue;
          const f = fields[i];
          result.push({
            sourceIndex: biIdx ?? f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
            customName: isBiPivot ? f.name : undefined,
            isLookup: f.isLookup || false,
          });
        }
        return result;
      };

      const initialRows: ZoneField[] = isBiPivot && hierarchyConfigs.length > 0
        ? reconstitute(config.rowFields, true)
        : config.rowFields.map((f) => ({
            sourceIndex: biIdx ?? f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
            customName: isBiPivot ? f.name : undefined,
            isLookup: f.isLookup || false,
          }));

      const initialColumns: ZoneField[] = isBiPivot && hierarchyConfigs.length > 0
        ? reconstitute(config.columnFields, false)
        : config.columnFields.map((f) => ({
            sourceIndex: biIdx ?? f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
            customName: isBiPivot ? f.name : undefined,
            isLookup: f.isLookup || false,
          }));

      const initialValues: ZoneField[] = config.valueFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        aggregation: f.aggregation as AggregationType | undefined,
        customName: f.customName ?? (isBiPivot ? f.name : undefined),
      }));

      const initialFilters: ZoneField[] = config.filterFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        customName: isBiPivot ? f.name : undefined,
        isLookup: f.isLookup || false,
        hiddenItems: f.hiddenItems,
      }));

      const initialLayout: LayoutConfig = {
        showRowGrandTotals: config.layout.showRowGrandTotals,
        showColumnGrandTotals: config.layout.showColumnGrandTotals,
        reportLayout: config.layout.reportLayout,
        repeatRowLabels: config.layout.repeatRowLabels,
        showEmptyRows: config.layout.showEmptyRows,
        showEmptyCols: config.layout.showEmptyCols,
        valuesPosition: config.layout.valuesPosition,
      };

      const paneData: PivotEditorViewData = {
        pivotId: pivotInfo.pivotId,
        sourceFields,
        initialRows,
        initialColumns,
        initialValues,
        initialFilters,
        initialLayout,
        initialCalculatedFields: config.calculatedFields,
        biModel: pivotInfo.biModel,
        sourceTableName: pivotInfo.sourceTableName,
      };

      openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);

      // Notify ribbon tabs after a short delay to ensure they've mounted
      // (ribbon tab registration happens synchronously, but React needs
      // a tick to render the component and subscribe to events).
      setTimeout(() => {
        emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, {
          pivotId: pivotInfo.pivotId,
          layout: paneData.initialLayout,
        });
      }, 50);
    } else {
      closeTaskPane(PIVOT_PANE_ID);
      emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId: null, layout: {} });
    }
  } catch (error) {
    console.error("[Pivot Extension] Failed to check pivot at selection:", error);
  } finally {
    checkInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Force Recheck (called when pane is reopened via View menu)
// ---------------------------------------------------------------------------

/**
 * Force a re-check of the current selection against pivot regions.
 * Resets lastCheckedSelection so the handler re-fetches data.
 * Called when the user reopens the pivot pane via the View menu.
 */
export function forceRecheck(): void {
  const savedSelection = lastCheckedSelection;
  lastCheckedSelection = null;
  checkInProgress = false;
  if (savedSelection) {
    handleSelectionChange({ endRow: savedSelection.row, endCol: savedSelection.col });
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Reset the selection handler state.
 * Called when the extension is unloaded.
 */
export function resetSelectionHandlerState(): void {
  cachedRegions = [];
  justCreatedPivot = false;
  lastCheckedSelection = null;
  checkInProgress = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (analyzeTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(PIVOT_ANALYZE_TAB_ID);
    analyzeTabRegistered = false;
  }
  if (designTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(PIVOT_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}
