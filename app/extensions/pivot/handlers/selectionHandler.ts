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

// ---------------------------------------------------------------------------
// Module-level state (owned by the pivot extension, not by the shell)
// ---------------------------------------------------------------------------

/** Cached pivot regions for fast local bounds checking. */
let cachedRegions: PivotRegionData[] = [];

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
    return;
  }

  // Skip if a check is already in progress
  if (checkInProgress) {
    console.log(`[PERF][pivot-sel] handleSelectionChange(${row},${col}) SKIPPED (checkInProgress)`);
    return;
  }

  const manuallyClosed = getTaskPaneManuallyClosed();

  // Fast local bounds check using cached regions
  const localPivotRegion = findPivotRegionAtCell(row, col);

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

  // Cell IS in a pivot region - set context key (even if manually closed,
  // so the View menu knows we're in a pivot area)
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

  // Check if manually closed
  if (manuallyClosed.includes(PIVOT_PANE_ID)) {
    lastCheckedSelection = { row, col };
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

      // For BI pivots, use sourceIndex = -1 so the frontend consistently
      // uses name-based references (not cache column indices)
      const biIdx = isBiPivot ? -1 : undefined;

      const initialRows: ZoneField[] = config.rowFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        customName: isBiPivot ? f.name : undefined,
        isLookup: f.isLookup || false,
      }));

      const initialColumns: ZoneField[] = config.columnFields.map((f) => ({
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
        customName: isBiPivot ? f.name : undefined,
      }));

      const initialFilters: ZoneField[] = config.filterFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        customName: isBiPivot ? f.name : undefined,
        isLookup: f.isLookup || false,
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
        biModel: pivotInfo.biModel,
      };

      openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
    } else {
      closeTaskPane(PIVOT_PANE_ID);
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
