//! FILENAME: app/extensions/pivot/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the pivot editor pane.
// CONTEXT: When the user selects a cell within a pivot region, we show the editor.
// When they select outside, we hide it.

import { pivot } from "@api/pivot";
import type { PivotRegionInfo } from "@api/pivot";
import {
  openTaskPane,
  closeTaskPane,
  getTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  registerPanel,
  unregisterPanel,
  emitAppEvent,
} from "@api";
import type { LayoutConfig, AggregationType } from "@api";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { notifyObjectSelectionChanged } from "@api/objectSelection";
import {
  PIVOT_PANE_ID,
  PivotDesignPanelDefinition,
  PIVOT_DESIGN_TAB_ID,
  PivotAnalyzePanelDefinition,
  PIVOT_ANALYZE_TAB_ID,
} from "../manifest";
import type { SourceField, ZoneField, PivotEditorViewData, PivotRegionData } from "../types";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";

// ---------------------------------------------------------------------------
// Module-level state (owned by the pivot extension, not by the shell)
// ---------------------------------------------------------------------------

/** Cached pivot regions for fast local bounds checking. */
let cachedRegions: PivotRegionData[] = [];

/** The currently active pivot ID (set when selection is inside a pivot region).
 *  Exported so panel sections can read it directly on mount without waiting for events. */
let activePivotId: string | null = null;

/** Get the currently active pivot ID. */
export function getActivePivotId(): string | null {
  return activePivotId;
}

/**
 * The canvas pivot box (the floating `pivot-visual` object) that is SELECTED,
 * or null. A canvas has no cell selection, so this -- not a cursor inside a
 * region -- is what makes a canvas pivot the active one.
 */
let selectedVisualPivotId: string | null = null;

/** The pivot whose pane the visual route last opened (a repeat press reloads nothing). */
let paneOpenedForVisual: string | null = null;

/** Flag to prevent closing the pane right after a pivot is created (regions not yet cached). */
let justCreatedPivot = false;

/** Track last checked selection to avoid redundant API calls. */
let lastCheckedSelection: { row: number; col: number } | null = null;

/** Guard against overlapping async checks. */
let checkInProgress = false;

/** Debounce timer for selection changes within a pivot region. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether the contextual pivot ribbon panels are currently registered. */
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

  // THE ACTIVE PIVOT MUST STILL EXIST. The contextual Analyze/Design tabs and
  // the editor pane are a function of `activePivotId`, and `handleSelectionChange`
  // only ever runs when the CURSOR moves -- it short-circuits on the cell it
  // checked last. Deleting the pivot under a stationary cursor changes neither,
  // so the tabs outlived the object they addressed.
  //
  // This used to fire only when the sheet had NO regions left, which covered
  // "delete the last pivot" and missed "delete the one the user is in while
  // another survives" -- the identical shape as BUG-0026 on the slicer, and the
  // reason the check is now against the ACTIVE ID rather than the count (§3cd).
  // A backend cascade reaches here the same way a frontend delete does: the
  // `pivot` domain triggers `refreshPivotRegions`, which emits PIVOT_REGIONS_UPDATED.
  //
  // BOTH clauses, and the count one is NOT redundant: `activePivotId` is null
  // whenever the cursor is outside every pivot, and a freshly created pivot
  // registers its tabs (ensureDesignTabRegistered) BEFORE the selection handler
  // has set the active id -- so reconciling on "no active id" alone would
  // unregister the tabs of the pivot the user just made.
  const activeGone =
    activePivotId !== null && !cachedRegions.some((r) => r.pivotId === activePivotId);
  if (cachedRegions.length === 0 || activeGone) {
    deselectPivotContext();
  }
}

/**
 * Tear down everything that addresses the active pivot: the contextual
 * Analyze/Design tabs, the "pivot" context key and the editor pane.
 *
 * ONE implementation, shared by the announcement-driven reconciliation above
 * and the synchronous structural-shift one below — the BUG-0026/BUG-0051
 * family exists because this teardown lived in one reconciliation path and
 * not the other.
 */
export function deselectPivotContext(): void {
  lastCheckedSelection = null;
  activePivotId = null;
  const hadVisual = selectedVisualPivotId !== null;
  if (hadVisual) {
    selectedVisualPivotId = null;
    // The selection frame is painted by the box itself.
    requestOverlayRedraw();
  }
  paneOpenedForVisual = null;
  if (analyzeTabRegistered) {
    unregisterPanel(PIVOT_ANALYZE_TAB_ID);
    analyzeTabRegistered = false;
  }
  if (designTabRegistered) {
    unregisterPanel(PIVOT_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
  removeTaskPaneContextKey("pivot");
  closeTaskPane(PIVOT_PANE_ID);
  // A canvas pivot box left the selection: the canvas-wide selection set
  // (@api/objectSelection) follows every family's own selection.
  if (hadVisual) notifyObjectSelectionChanged();
}

/**
 * The SYNCHRONOUS half of the reconciliation, for the structural-delete path.
 *
 * A row/column delete that fully covers a pivot region removes the pivot in
 * the backend (`shift_pivot_regions_for_row_delete`, structure.rs) — a second
 * pivot-delete path that never goes near `deletePivotTable`, exactly as
 * convert-to-range was a second table-delete path (BUG-0051). The extension's
 * ROWS_DELETED/COLUMNS_DELETED handlers DELIBERATELY do not call
 * `refreshPivotRegions` (a concurrent in-flight refresh could overwrite the
 * sync shift with pre-shift data), so `updateCachedRegions` never runs on this
 * path, `handleSelectionChange` never runs under a stationary cursor, and the
 * Analyze/Design tabs would outlive the pivot they address. The UI's own row
 * delete needs a whole-ROW selection (which moves the cursor out of the pivot
 * first), but a script's `api.deleteRows` or a macro replay deletes rows while
 * the cursor stays wherever the user left it.
 *
 * Only the ACTIVE-id rule, deliberately: an empty cache with a null active id
 * is the just-created-pivot state (`ensureDesignTabRegistered` runs before any
 * selection sets the id), and tearing down on the count alone would kill the
 * tabs of the pivot the user just made — the vacuity case the reconciliation
 * tests pin.
 */
function reconcileActivePivotAfterShift(): void {
  const activeGone =
    activePivotId !== null && !cachedRegions.some((r) => r.pivotId === activePivotId);
  if (activeGone) {
    deselectPivotContext();
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
 * Ensure the contextual pivot ribbon panels are registered.
 * Called by pivotCreatedHandler so the tabs appear immediately on creation,
 * regardless of whether the selection handler has run yet.
 */
export function ensureDesignTabRegistered(): void {
  if (!analyzeTabRegistered) {
    registerPanel(PivotAnalyzePanelDefinition);
    analyzeTabRegistered = true;
  }
  if (!designTabRegistered) {
    registerPanel(PivotDesignPanelDefinition);
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
  // The filter above may have removed the ACTIVE pivot's region — the backend
  // deleted the pivot with it, and nothing else reconciles on this path.
  reconcileActivePivotAfterShift();
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
  // The filter above may have removed the ACTIVE pivot's region — the backend
  // deleted the pivot with it, and nothing else reconciles on this path.
  reconcileActivePivotAfterShift();
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
      // Register pivot panels even though regions aren't cached yet —
      // we know the user just created a pivot and is inside it.
      if (!analyzeTabRegistered) {
        registerPanel(PivotAnalyzePanelDefinition);
        analyzeTabRegistered = true;
      }
      if (!designTabRegistered) {
        registerPanel(PivotDesignPanelDefinition);
        designTabRegistered = true;
      }
      return;
    }
    lastCheckedSelection = { row, col };
    activePivotId = null;
    selectedVisualPivotId = null;
    paneOpenedForVisual = null;
    removeTaskPaneContextKey("pivot");
    closeTaskPane(PIVOT_PANE_ID);
    // Hide the contextual pivot ribbon panels
    if (analyzeTabRegistered) {
      unregisterPanel(PIVOT_ANALYZE_TAB_ID);
      analyzeTabRegistered = false;
    }
    if (designTabRegistered) {
      unregisterPanel(PIVOT_DESIGN_TAB_ID);
      designTabRegistered = false;
    }
    return;
  }

  // Cell IS in a pivot region - set context key and active pivot ID
  activePivotId = localPivotRegion.pivotId;
  selectedVisualPivotId = null;
  paneOpenedForVisual = null;
  addTaskPaneContextKey("pivot");
  // Show the contextual pivot ribbon panels
  if (!analyzeTabRegistered) {
    registerPanel(PivotAnalyzePanelDefinition);
    analyzeTabRegistered = true;
  }
  if (!designTabRegistered) {
    registerPanel(PivotDesignPanelDefinition);
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
      showPivotPane(pivotInfo);
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

/**
 * Build the field-list pane data from the backend's pivot info. Shared by the
 * cell route (a cursor inside a worksheet pivot) and the object route (a
 * selected canvas pivot box).
 */
export function buildPivotPaneData(pivotInfo: PivotRegionInfo): PivotEditorViewData {
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
        const table = firstField.name.includes('.')
          ? splitBiFieldKey(firstField.name, pivotInfo.biModel?.tables.map((t) => t.name)).table
          : '';
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

  // hiddenItems ride along on row/column chips too (a placed calculation
  // group's item subset lives there like a field filter).
  const initialRows: ZoneField[] = isBiPivot && hierarchyConfigs.length > 0
    ? reconstitute(config.rowFields, true)
    : config.rowFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        customName: isBiPivot ? f.name : undefined,
        isLookup: f.isLookup || false,
        hiddenItems: f.hiddenItems,
      }));

  const initialColumns: ZoneField[] = isBiPivot && hierarchyConfigs.length > 0
    ? reconstitute(config.columnFields, false)
    : config.columnFields.map((f) => ({
        sourceIndex: biIdx ?? f.sourceIndex,
        name: f.name,
        isNumeric: f.isNumeric,
        customName: isBiPivot ? f.name : undefined,
        isLookup: f.isLookup || false,
        hiddenItems: f.hiddenItems,
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

  return paneData;
}

/** Open the field-list pane for `pivotInfo` and tell the ribbon tabs which pivot is active. */
function showPivotPane(pivotInfo: PivotRegionInfo): void {
  const paneData = buildPivotPaneData(pivotInfo);
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
}

// ---------------------------------------------------------------------------
// Canvas pivot boxes (the object route)
// ---------------------------------------------------------------------------

/** Whether the canvas pivot box of `pivotId` is the selected object. */
export function isPivotVisualSelected(pivotId: string): boolean {
  return selectedVisualPivotId !== null && selectedVisualPivotId === pivotId;
}

/** The selected canvas pivot box's pivot id, or null. */
export function getSelectedVisualPivotId(): string | null {
  return selectedVisualPivotId;
}

/**
 * Select a canvas pivot box: it becomes the ACTIVE pivot (the Analyze/Design
 * tabs address it, the "pivot" pane context key is set) exactly as a cursor
 * inside a worksheet pivot makes it -- a canvas has no cell selection, so
 * `handleSelectionChange` never runs there.
 *
 * `openPane`: a mouse press opens the field-list pane (unless the user closed
 * it by hand, which the cell route honours too); a keyboard selection (Tab on
 * the canvas) does not -- `select` in the object-selection seam means select
 * and nothing else. `force` reloads the pane even when this box already had it.
 */
export function selectPivotVisual(
  pivotId: string,
  opts: { openPane: boolean; force?: boolean },
): void {
  const wasSelected = selectedVisualPivotId === pivotId;
  selectedVisualPivotId = pivotId;
  activePivotId = pivotId;
  lastCheckedSelection = null;
  addTaskPaneContextKey("pivot");
  ensureDesignTabRegistered();
  if (!wasSelected) {
    requestOverlayRedraw();
    // The pivot box's selection chokepoint for the canvas-wide set.
    notifyObjectSelectionChanged();
  }

  const manuallyClosed = getTaskPaneManuallyClosed().includes(PIVOT_PANE_ID);
  // A pane already showing ANOTHER box's fields follows the selection even on
  // a keyboard step: that is keeping an open pane truthful, not opening one.
  const paneShowsAnotherBox = paneOpenedForVisual !== null && paneOpenedForVisual !== pivotId;
  if ((opts.openPane || paneShowsAnotherBox) && !manuallyClosed) {
    if (paneOpenedForVisual === pivotId && wasSelected && !opts.force) return;
    const region = cachedRegions.find((r) => r.pivotId === pivotId);
    if (region) {
      paneOpenedForVisual = pivotId;
      void openPaneForVisual(pivotId, region.startRow, region.startCol);
      return;
    }
  }

  if (!wasSelected || opts.force) {
    // Tell the ribbon tabs the active pivot even without the pane (the same
    // thing the cell route does when the pane was closed by hand).
    setTimeout(() => {
      if (selectedVisualPivotId !== pivotId) return;
      emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId, layout: {} });
    }, 50);
  }
}

/**
 * Load the pane for a canvas pivot. The backend resolves `getAtCell` on the
 * ACTIVE sheet, which is the canvas, so the hidden-grid anchor addresses it.
 */
async function openPaneForVisual(pivotId: string, anchorRow: number, anchorCol: number): Promise<void> {
  try {
    const pivotInfo = await pivot.getAtCell(anchorRow, anchorCol);
    // The user may have selected something else while the fetch was in flight.
    if (selectedVisualPivotId !== pivotId) return;
    if (pivotInfo) {
      showPivotPane(pivotInfo);
    } else {
      paneOpenedForVisual = null;
    }
  } catch (error) {
    paneOpenedForVisual = null;
    console.error("[Pivot Extension] Failed to load the canvas pivot's field list:", error);
  }
}

/** Deselect the canvas pivot box (no-op when none is selected). */
export function deselectPivotVisual(): void {
  if (selectedVisualPivotId === null) return;
  deselectPivotContext();
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
    return;
  }
  // On a canvas there is no cell to re-check: re-open from the selected box.
  if (selectedVisualPivotId !== null) {
    selectPivotVisual(selectedVisualPivotId, { openPane: true, force: true });
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
  activePivotId = null;
  selectedVisualPivotId = null;
  paneOpenedForVisual = null;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (analyzeTabRegistered) {
    unregisterPanel(PIVOT_ANALYZE_TAB_ID);
    analyzeTabRegistered = false;
  }
  if (designTabRegistered) {
    unregisterPanel(PIVOT_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}
