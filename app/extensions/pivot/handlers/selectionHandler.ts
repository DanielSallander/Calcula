//! FILENAME: app/extensions/pivot/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the pivot editor pane.
// CONTEXT: When the user selects a cell within a pivot region, we show the editor.
// When they select outside, we hide it.

import { getPivotAtCell } from "../../../src/api";
import type { LayoutConfig, AggregationType } from "../../../src/api";
import { useTaskPaneStore } from "../../../src/shell/task-pane";
import { PIVOT_PANE_ID } from "../manifest";
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

// ---------------------------------------------------------------------------
// State mutators (called by other handlers / extension index)
// ---------------------------------------------------------------------------

/**
 * Update the cached pivot regions.
 * Called when a `pivot:regionsUpdated` event fires.
 */
export function updateCachedRegions(regions: PivotRegionData[]): void {
  cachedRegions = regions;
  // Regions arrived, so clear the just-created flag
  justCreatedPivot = false;
}

/**
 * Set the justCreatedPivot flag.
 * Called by pivotCreatedHandler before opening the pane.
 */
export function setJustCreatedPivot(value: boolean): void {
  justCreatedPivot = value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fast local check if a cell is within any cached pivot region.
 */
function findPivotRegionAtCell(
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
    return;
  }

  const { manuallyClosed, openPane, closePane } = useTaskPaneStore.getState();

  // Fast local bounds check using cached regions
  const localPivotRegion = findPivotRegionAtCell(row, col);

  if (localPivotRegion === null) {
    // Cell is NOT in any pivot region - close pivot pane if open
    // BUT skip if a pivot was just created (regions not yet cached)
    if (justCreatedPivot) {
      return;
    }
    lastCheckedSelection = { row, col };
    closePane(PIVOT_PANE_ID);
    return;
  }

  // Cell IS in a pivot region - check if manually closed
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
    checkPivotAtSelection(row, col, openPane, closePane);
  }, 50);
}

/**
 * Fetch full pivot details for the given cell and open/close the pane.
 */
async function checkPivotAtSelection(
  row: number,
  col: number,
  openPane: (viewId: string, data?: Record<string, unknown>) => void,
  closePane: (viewId: string) => void,
): Promise<void> {
  checkInProgress = true;
  lastCheckedSelection = { row, col };

  try {
    const pivotInfo = await getPivotAtCell(row, col);

    if (pivotInfo) {
      // Convert source fields from backend format
      const sourceFields: SourceField[] = pivotInfo.sourceFields.map((field) => ({
        index: field.index,
        name: field.name,
        isNumeric: field.isNumeric,
      }));

      const config = pivotInfo.fieldConfiguration;

      const initialRows: ZoneField[] = config.rowFields.map((f) => ({
        sourceIndex: f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
      }));

      const initialColumns: ZoneField[] = config.columnFields.map((f) => ({
        sourceIndex: f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
      }));

      const initialValues: ZoneField[] = config.valueFields.map((f) => ({
        sourceIndex: f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        aggregation: f.aggregation as AggregationType | undefined,
      }));

      const initialFilters: ZoneField[] = config.filterFields.map((f) => ({
        sourceIndex: f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
      }));

      const initialLayout: LayoutConfig = {
        show_row_grand_totals: config.layout.show_row_grand_totals,
        show_column_grand_totals: config.layout.show_column_grand_totals,
        report_layout: config.layout.report_layout,
        repeat_row_labels: config.layout.repeat_row_labels,
        show_empty_rows: config.layout.show_empty_rows,
        show_empty_cols: config.layout.show_empty_cols,
        values_position: config.layout.values_position,
      };

      const paneData: PivotEditorViewData = {
        pivotId: pivotInfo.pivotId,
        sourceFields,
        initialRows,
        initialColumns,
        initialValues,
        initialFilters,
        initialLayout,
      };

      openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
    } else {
      closePane(PIVOT_PANE_ID);
    }
  } catch (error) {
    console.error("[Pivot Extension] Failed to check pivot at selection:", error);
  } finally {
    checkInProgress = false;
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
}
