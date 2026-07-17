//! FILENAME: app/extensions/Pivot/lib/pivot-api.ts
/**
 * FILENAME: app/extensions/Pivot/lib/pivot-api.ts
 * Pivot Table API
 *
 * TypeScript bindings for the Tauri pivot table commands.
 * Provides a clean async interface for creating, updating, and querying pivot tables.
 * 
 * ARCHITECTURE NOTE: This file uses the API facade (src/api/backend.ts) instead of
 * importing directly from @tauri-apps/api. This ensures extensions go through the
 * sandboxed API layer, maintaining the Microkernel architecture.
 */

import {
  cachePivotView,
  setLoading as _setLoading,
  clearLoading as _clearLoading,
  preserveCurrentView,
  clearPreviousView,
  restorePreviousView,
  isUserCancelled,
  clearUserCancelled,
  startOperation,
  isCurrentOperation,
  getInflightOperation,
  setInflightOperation,
} from "./pivotViewStore";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { emitAppEvent, AppEvents } from "@api";
import { ask } from "@tauri-apps/plugin-dialog";
import type { BiHierarchyMeta } from "@api/backend";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";

/**
 * Pipeline stages (total = 4):
 *   1. Preparing...     (frontend, before IPC)
 *   2. Calculating...   (backend, pivot engine)
 *   3. Preparing response...  (backend, serialization)
 *   4. Updating grid... (backend, grid write)
 */
const TOTAL_STAGES = 4;

/** Set loading state AND trigger an overlay redraw so the indicator appears immediately. */
function setLoading(pivotId: string, stage: string, stageIndex = 0, totalStages = TOTAL_STAGES): void {
  _setLoading(pivotId, stage, stageIndex, totalStages);
  requestOverlayRedraw();
}

/** Clear loading state AND trigger an overlay redraw to remove the indicator. */
function clearLoading(pivotId: string): void {
  _clearLoading(pivotId);
  requestOverlayRedraw();
}

/**
 * Check if a pivot operation overwrote existing cell data.
 * If so, ask the user for confirmation. On cancel, revert the pivot
 * to its previous state and trigger a full grid + pivot refresh.
 * Returns true if the operation should proceed, false if cancelled.
 *
 * Uses `revertPivotOperation` instead of `undo()` because the undo
 * system deadlocks when the pivot CustomRestore handler re-acquires
 * locks already held by the undo transaction processor.
 */
async function confirmOverwriteOrUndo(response: PivotViewResponse): Promise<boolean> {
  if (!response.overwrittenCellCount || response.overwrittenCellCount <= 0) {
    return true;
  }
  const confirmed = await ask(
    "A PivotTable report will overwrite existing data. Do you want to continue?",
    { title: "Calcula", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" }
  );
  if (confirmed) {
    return true;
  }
  // Undo the pivot operation by popping the undo entry and restoring the
  // previous definition directly (bypasses the general undo system which
  // deadlocks when the pivot restore handler re-acquires held locks)
  try {
    await apiUndoPivotOverwrite(response.pivotId);
  } catch (e) {
    console.warn("[pivot] undo_pivot_overwrite failed:", e);
  }
  emitAppEvent(AppEvents.GRID_REFRESH);
  window.dispatchEvent(new CustomEvent("pivot:refresh"));
  requestOverlayRedraw();
  return false;
}

import {
  createPivotTable as apiCreatePivotTable,
  updatePivotFields as apiUpdatePivotFields,
  togglePivotGroup as apiTogglePivotGroup,
  getPivotView as apiGetPivotView,
  deletePivotTable as apiDeletePivotTable,
  relocatePivot as apiRelocatePivot,
  getPivotSourceData as apiGetPivotSourceData,
  refreshPivotCache as apiRefreshPivotCache,
  getPivotAtCell as apiGetPivotAtCell,
  getPivotDataFormula as apiGetPivotDataFormula,
  getPivotRegionsForSheet as apiGetPivotRegionsForSheet,
  getPivotFieldUniqueValues as apiGetPivotFieldUniqueValues,
  // New Excel-compatible API functions
  getPivotTableInfo as apiGetPivotTableInfo,
  updatePivotProperties as apiUpdatePivotProperties,
  getPivotLayoutRanges as apiGetPivotLayoutRanges,
  updatePivotLayout as apiUpdatePivotLayout,
  getPivotHierarchies as apiGetPivotHierarchies,
  addPivotHierarchy as apiAddPivotHierarchy,
  removePivotHierarchy as apiRemovePivotHierarchy,
  movePivotField as apiMovePivotField,
  setPivotAggregation as apiSetPivotAggregation,
  setPivotNumberFormat as apiSetPivotNumberFormat,
  applyPivotFilter as apiApplyPivotFilter,
  clearPivotFilter as apiClearPivotFilter,
  sortPivotField as apiSortPivotField,
  getPivotFieldInfo as apiGetPivotFieldInfo,
  setPivotItemVisibility as apiSetPivotItemVisibility,
  getAllPivotTables as apiGetAllPivotTables,
  refreshAllPivotTables as apiRefreshAllPivotTables,
  setPivotItemExpanded as apiSetPivotItemExpanded,
  expandCollapseLevel as apiExpandCollapseLevel,
  expandCollapseAll as apiExpandCollapseAll,
  groupPivotField as apiGroupPivotField,
  createManualGroup as apiCreateManualGroup,
  ungroupPivotField as apiUngroupPivotField,
  drillThroughToSheet as apiDrillThroughToSheet,
  createPivotFromBiModel as apiCreatePivotFromBiModel,
  updateBiPivotFields as apiUpdateBiPivotFields,
  setBiLookupColumns as apiSetBiLookupColumns,
  getPivotCellWindow as apiGetPivotCellWindow,
  cancelPivotOperation as apiCancelPivotOperation,
  revertPivotOperation as apiRevertPivotOperation,
  undoPivotOverwrite as apiUndoPivotOverwrite,
  changePivotDataSource as apiChangePivotDataSource,
  addCalculatedField as apiAddCalculatedField,
  updateCalculatedField as apiUpdateCalculatedField,
  removeCalculatedField as apiRemoveCalculatedField,
  addCalculatedItem as apiAddCalculatedItem,
  removeCalculatedItem as apiRemoveCalculatedItem,
  showReportFilterPages as apiShowReportFilterPages,
} from "@api/backend";
import { pivotBackend } from "./pivotBackend";

// ============================================================================
// API Functions
// ============================================================================

/**
 * Creates a new pivot table from the specified source range.
 */
export async function createPivotTable(
  request: CreatePivotRequest
): Promise<PivotViewResponse> {
  return apiCreatePivotTable<CreatePivotRequest, PivotViewResponse>(request);
}

/**
 * Updates the field configuration of an existing pivot table.
 */
export async function updatePivotFields(
  request: UpdatePivotFieldsRequest
): Promise<PivotViewResponse> {
  // Supersede any in-flight operation for this pivot
  const seq = startOperation(request.pivotId);
  apiCancelPivotOperation(request.pivotId).catch(() => {});
  // Wait for in-flight operation to finish (backend holds exclusive resources like BI engine)
  const prev = getInflightOperation(request.pivotId);
  if (prev) await prev.catch(() => {});

  preserveCurrentView(request.pivotId);
  setLoading(request.pivotId, "Updating...");
  const t0 = performance.now();
  const ipcPromise = apiUpdatePivotFields<UpdatePivotFieldsRequest, PivotViewResponse>(request);
  setInflightOperation(request.pivotId, ipcPromise);
  try {
    const result = await ipcPromise;
    // If superseded by a newer operation, discard this result silently
    if (!isCurrentOperation(request.pivotId, seq)) {
      throw new Error("Pivot operation superseded");
    }
    // If the user cancelled while the IPC was in-flight, revert backend + suppress result
    if (isUserCancelled(request.pivotId)) {
      clearUserCancelled(request.pivotId);
      restorePreviousView(request.pivotId);
      // Revert backend state (definition + grid cells) to pre-operation state
      apiRevertPivotOperation(request.pivotId).catch((e) =>
        console.warn("[pivot] revert failed:", e)
      );
      throw new Error("Pivot operation cancelled");
    }
    // Check if the pivot overwrote existing cell data
    if (result.overwrittenCellCount && result.overwrittenCellCount > 0) {
      const confirmed = await ask(
        "A PivotTable report will overwrite existing data. Do you want to continue?",
        { title: "Calcula", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" }
      );
      if (!confirmed) {
        restorePreviousView(request.pivotId);
        apiUndoPivotOverwrite(request.pivotId).catch((e) =>
          console.warn("[pivot] undo_pivot_overwrite after overwrite cancel failed:", e)
        );
        emitAppEvent(AppEvents.GRID_REFRESH);
        throw new Error("Pivot operation cancelled - would overwrite data");
      }
    }
    const dt = performance.now() - t0;
    cachePivotView(request.pivotId, result);
    clearPreviousView(request.pivotId);
    console.log(
      `[PERF][pivot] updatePivotFields pivot_id=${request.pivotId} rows=${result.rowCount}x${result.colCount} | ipc=${dt.toFixed(1)}ms (cached)`
    );
    return result;
  } catch (err) {
    // Only restore previous view if this is still the current operation
    if (isCurrentOperation(request.pivotId, seq)) {
      restorePreviousView(request.pivotId);
    }
    clearUserCancelled(request.pivotId);
    throw err;
  } finally {
    // Only clear loading if this is still the current operation
    // (a newer operation will have set its own loading state)
    if (isCurrentOperation(request.pivotId, seq)) {
      clearLoading(request.pivotId);
    }
  }
}

/**
 * Toggles the expand/collapse state of a pivot group.
 * This is a fast sync operation — no loading indicator or cancellation needed.
 */
export async function togglePivotGroup(
  request: ToggleGroupRequest
): Promise<PivotViewResponse> {
  const t0 = performance.now();
  const result = await apiTogglePivotGroup<ToggleGroupRequest, PivotViewResponse>(request);
  // Check if expanding overwrote existing cell data
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  const dt = performance.now() - t0;
  cachePivotView(request.pivotId, result);
  console.log(
    `[PERF][pivot] togglePivotGroup pivot_id=${request.pivotId} rows=${result.rowCount}x${result.colCount} | ipc=${dt.toFixed(1)}ms (cached)`
  );
  return result;
}

/**
 * Gets the current view of a pivot table.
 */
export async function getPivotView(pivotId?: PivotId): Promise<PivotViewResponse> {
  const t0 = performance.now();
  const result = await apiGetPivotView<PivotViewResponse>(pivotId);
  const dt = performance.now() - t0;
  console.log(
    `[PERF][pivot] getPivotView pivot_id=${pivotId ?? 'active'} rows=${result.rowCount}x${result.colCount} | ipc=${dt.toFixed(1)}ms`
  );
  return result;
}

/**
 * Fetches a window of cell data from a stored PivotView (scroll-triggered).
 */
export async function getPivotCellWindow(
  pivotId: PivotId,
  startRow: number,
  rowCount: number
): Promise<PivotCellWindowResponse> {
  return apiGetPivotCellWindow<PivotCellWindowResponse>(pivotId, startRow, rowCount);
}

/**
 * Deletes a pivot table.
 */
export async function deletePivotTable(pivotId: PivotId): Promise<void> {
  return apiDeletePivotTable(pivotId);
}

/**
 * Relocate a pivot table to a new destination cell.
 */
export async function relocatePivot(pivotId: PivotId, newRow: number, newCol: number): Promise<void> {
  return apiRelocatePivot(pivotId, newRow, newCol);
}

/**
 * Gets source data for drill-down (detail view).
 */
export async function getPivotSourceData(
  pivotId: PivotId,
  groupPath: GroupPath,
  maxRecords?: number
): Promise<SourceDataResponse> {
  return apiGetPivotSourceData<SourceDataResponse>(pivotId, groupPath, maxRecords);
}

/**
 * Refreshes the pivot cache from current grid data.
 */
export async function refreshPivotCache(pivotId: PivotId): Promise<PivotViewResponse> {
  const seq = startOperation(pivotId);
  apiCancelPivotOperation(pivotId).catch(() => {});
  const prev = getInflightOperation(pivotId);
  if (prev) await prev.catch(() => {});

  preserveCurrentView(pivotId);
  setLoading(pivotId, "Refreshing...");
  const ipcPromise = apiRefreshPivotCache<PivotViewResponse>(pivotId);
  setInflightOperation(pivotId, ipcPromise);
  try {
    const result = await ipcPromise;
    if (!isCurrentOperation(pivotId, seq)) {
      throw new Error("Pivot operation superseded");
    }
    if (isUserCancelled(pivotId)) {
      clearUserCancelled(pivotId);
      restorePreviousView(pivotId);
      apiRevertPivotOperation(pivotId).catch((e) =>
        console.warn("[pivot] revert failed:", e)
      );
      throw new Error("Pivot operation cancelled");
    }
    // Check if refreshing overwrote existing cell data
    if (result.overwrittenCellCount && result.overwrittenCellCount > 0) {
      const confirmed = await ask(
        "A PivotTable report will overwrite existing data. Do you want to continue?",
        { title: "Calcula", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" }
      );
      if (!confirmed) {
        restorePreviousView(pivotId);
        apiUndoPivotOverwrite(pivotId).catch((e) =>
          console.warn("[pivot] undo_pivot_overwrite after overwrite cancel failed:", e)
        );
        emitAppEvent(AppEvents.GRID_REFRESH);
        throw new Error("Pivot operation cancelled - would overwrite data");
      }
    }
    clearPreviousView(pivotId);
    return result;
  } catch (err) {
    if (isCurrentOperation(pivotId, seq)) {
      restorePreviousView(pivotId);
    }
    clearUserCancelled(pivotId);
    throw err;
  } finally {
    if (isCurrentOperation(pivotId, seq)) {
      clearLoading(pivotId);
    }
  }
}

/**
 * Checks if a cell is within a pivot table region.
 */
export async function getPivotAtCell(
  row: number,
  col: number
): Promise<PivotRegionInfo | null> {
  return apiGetPivotAtCell<PivotRegionInfo>(row, col);
}

/**
 * Resolves a pivot cell into GETPIVOTDATA formula arguments.
 * Returns null if the cell is not a data cell in a pivot.
 */
export async function getPivotDataFormula(
  row: number,
  col: number
): Promise<GetPivotDataFormulaResult | null> {
  return apiGetPivotDataFormula<GetPivotDataFormulaResult>(row, col);
}

/**
 * Gets all pivot regions for the current sheet.
 */
export async function getPivotRegionsForSheet(): Promise<PivotRegionData[]> {
  return apiGetPivotRegionsForSheet<PivotRegionData>();
}

/**
 * Gets unique values for a specific field in a pivot table's source data.
 */
export async function getPivotFieldUniqueValues(
  pivotId: PivotId,
  fieldIndex: number
): Promise<FieldUniqueValuesResponse> {
  return apiGetPivotFieldUniqueValues<FieldUniqueValuesResponse>(pivotId, fieldIndex);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extracts the numeric value from a PivotCellValue.
 * Returns 0 for non-numeric values.
 */
export function getCellNumericValue(value: PivotCellValue): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Extracts the display string from a PivotCellValue.
 */
export function getCellDisplayValue(value: PivotCellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value; // string (including "#ERROR" prefixed errors)
}

/**
 * Checks if a cell is a header cell (row or column).
 */
export function isHeaderCell(cellType: PivotCellType): boolean {
  return cellType === "RowHeader" || cellType === "ColumnHeader" || cellType === "Corner"
    || cellType === "RowLabelHeader" || cellType === "ColumnLabelHeader";
}

/**
 * Checks if a cell is a total cell (subtotal or grand total).
 */
export function isTotalCell(cellType: PivotCellType): boolean {
  return (
    cellType === "RowSubtotal" ||
    cellType === "ColumnSubtotal" ||
    cellType === "GrandTotal" ||
    cellType === "GrandTotalRow" ||
    cellType === "GrandTotalColumn"
  );
}

/**
 * Checks if a cell is a filter cell.
 */
export function isFilterCell(cellType: PivotCellType): boolean {
  return cellType === "FilterLabel" || cellType === "FilterDropdown";
}

/**
 * Checks if a row is a data row (not header or total).
 */
export function isDataRow(rowType: PivotRowType): boolean {
  return rowType === "Data";
}

/**
 * Checks if a row is a filter row.
 */
export function isFilterRow(rowType: PivotRowType): boolean {
  return rowType === "FilterRow";
}

/**
 * Creates a default field configuration.
 */
export function createFieldConfig(
  sourceIndex: number,
  name: string,
  options?: Partial<Omit<PivotFieldConfig, "sourceIndex" | "name">>
): PivotFieldConfig {
  return {
    sourceIndex,
    name,
    sortOrder: options?.sortOrder ?? "asc",
    showSubtotals: options?.showSubtotals ?? true,
    collapsed: options?.collapsed ?? false,
    hiddenItems: options?.hiddenItems ?? [],
  };
}

/**
 * Creates a default value field configuration.
 */
export function createValueFieldConfig(
  sourceIndex: number,
  name: string,
  aggregation: AggregationType = "sum",
  options?: Partial<Omit<ValueFieldConfig, "sourceIndex" | "name" | "aggregation">>
): ValueFieldConfig {
  return {
    sourceIndex,
    name,
    aggregation,
    numberFormat: options?.numberFormat,
    showValuesAs: options?.showValuesAs ?? "normal",
  };
}

/**
 * Creates a default layout configuration.
 */
export function createLayoutConfig(
  options?: Partial<LayoutConfig>
): LayoutConfig {
  return {
    showRowGrandTotals: options?.showRowGrandTotals ?? true,
    showColumnGrandTotals: options?.showColumnGrandTotals ?? true,
    reportLayout: options?.reportLayout ?? "compact",
    repeatRowLabels: options?.repeatRowLabels ?? false,
    showEmptyRows: options?.showEmptyRows ?? false,
    showEmptyCols: options?.showEmptyCols ?? false,
    valuesPosition: options?.valuesPosition ?? "columns",
  };
}

// ============================================================================
// NEW EXCEL-COMPATIBLE API FUNCTIONS
// ============================================================================

/**
 * Gets pivot table properties and info.
 */
export async function getPivotTableInfo(pivotId: PivotId): Promise<PivotTableInfo> {
  return apiGetPivotTableInfo<PivotTableInfo>(pivotId);
}

/**
 * Updates pivot table properties.
 */
export async function updatePivotProperties(
  request: UpdatePivotPropertiesRequest
): Promise<PivotTableInfo> {
  return apiUpdatePivotProperties<UpdatePivotPropertiesRequest, PivotTableInfo>(request);
}

/**
 * Changes the pivot table's source data range.
 */
export async function changePivotDataSource(
  request: ChangePivotDataSourceRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Changing data source...");
  try {
    const result = await apiChangePivotDataSource<ChangePivotDataSourceRequest, PivotViewResponse>(request);
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Gets pivot layout ranges (data body, row labels, column labels, filter axis).
 */
export async function getPivotLayoutRanges(pivotId: PivotId): Promise<PivotLayoutRanges> {
  return apiGetPivotLayoutRanges<PivotLayoutRanges>(pivotId);
}

/**
 * Updates pivot layout properties.
 */
export async function updatePivotLayout(
  request: UpdatePivotLayoutRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiUpdatePivotLayout<UpdatePivotLayoutRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Gets all hierarchies info for a pivot table.
 */
export async function getPivotHierarchies(pivotId: PivotId): Promise<PivotHierarchiesInfo> {
  return apiGetPivotHierarchies<PivotHierarchiesInfo>(pivotId);
}

/**
 * Adds a field to a hierarchy (row, column, data, or filter).
 */
export async function addPivotHierarchy(
  request: AddHierarchyRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiAddPivotHierarchy<AddHierarchyRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Removes a field from a hierarchy.
 */
export async function removePivotHierarchy(
  request: RemoveHierarchyRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiRemovePivotHierarchy<RemoveHierarchyRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Moves a field between hierarchies.
 */
export async function movePivotField(
  request: MoveFieldRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiMovePivotField<MoveFieldRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Sets the aggregation function for a value field.
 */
export async function setPivotAggregation(
  request: SetAggregationRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiSetPivotAggregation<SetAggregationRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Sets the number format for a value field.
 */
export async function setPivotNumberFormat(
  request: SetNumberFormatRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiSetPivotNumberFormat<SetNumberFormatRequest, PivotViewResponse>(request);
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Applies a filter to a pivot field.
 */
export async function applyPivotFilter(
  request: ApplyPivotFilterRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Filtering...");
  try {
    const result = await apiApplyPivotFilter<ApplyPivotFilterRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Clears filters from a pivot field.
 */
export async function clearPivotFilter(
  request: ClearPivotFilterRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Filtering...");
  try {
    const result = await apiClearPivotFilter<ClearPivotFilterRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Sorts a pivot field by labels.
 */
export async function sortPivotField(
  request: SortPivotFieldRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Sorting...");
  try {
    const result = await apiSortPivotField<SortPivotFieldRequest, PivotViewResponse>(request);
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Gets pivot field info including items and filters.
 */
export async function getPivotFieldInfo(
  pivotId: PivotId,
  fieldIndex: number
): Promise<PivotFieldInfoResponse> {
  return apiGetPivotFieldInfo<PivotFieldInfoResponse>(pivotId, fieldIndex);
}

/**
 * Sets a pivot item's visibility.
 */
export async function setPivotItemVisibility(
  request: SetItemVisibilityRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Filtering...");
  try {
    const result = await apiSetPivotItemVisibility<SetItemVisibilityRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Gets a list of all pivot tables in the workbook.
 */
export async function getAllPivotTables(): Promise<PivotTableInfo[]> {
  return apiGetAllPivotTables<PivotTableInfo[]>();
}

/**
 * Refreshes all pivot tables in the workbook.
 */
export async function refreshAllPivotTables(): Promise<PivotViewResponse[]> {
  const results = await apiRefreshAllPivotTables<PivotViewResponse[]>();
  for (const result of results) {
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
  }
  return results;
}

// ============================================================================
// EXPAND/COLLAPSE AND GROUPING API FUNCTIONS
// ============================================================================

/**
 * Sets the expand/collapse state of a specific pivot item.
 */
export async function setPivotItemExpanded(
  request: SetItemExpandedRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiSetPivotItemExpanded<SetItemExpandedRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Expands or collapses all items at a specific field level.
 */
export async function expandCollapseLevel(
  request: ExpandCollapseLevelRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiExpandCollapseLevel<ExpandCollapseLevelRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Expands or collapses all fields in the entire pivot table.
 */
export async function expandCollapseAll(
  request: ExpandCollapseAllRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Updating...");
  try {
    const result = await apiExpandCollapseAll<ExpandCollapseAllRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

// ============================================================================
// GROUPING API FUNCTIONS
// ============================================================================

/**
 * Applies grouping (date, number binning, or manual) to a pivot field.
 */
export async function groupPivotField(
  request: GroupFieldRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Grouping...");
  try {
    const result = await apiGroupPivotField<GroupFieldRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Creates a manual group on a pivot field.
 */
export async function createManualGroup(
  request: CreateManualGroupRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Grouping...");
  try {
    const result = await apiCreateManualGroup<CreateManualGroupRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Removes all grouping from a pivot field.
 */
export async function ungroupPivotField(
  request: UngroupFieldRequest
): Promise<PivotViewResponse> {
  setLoading(request.pivotId, "Ungrouping...");
  try {
    const result = await apiUngroupPivotField<UngroupFieldRequest, PivotViewResponse>(request);
    if (!await confirmOverwriteOrUndo(result)) {
      throw new Error("Pivot operation cancelled - would overwrite data");
    }
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

/**
 * Performs a drill-through: creates a new sheet with the matching source data rows.
 * Typically triggered by double-clicking on a data cell in the pivot table.
 */
export async function drillThroughToSheet(
  request: DrillThroughRequest
): Promise<DrillThroughResponse> {
  return apiDrillThroughToSheet<DrillThroughRequest, DrillThroughResponse>(request);
}

/**
 * Set (or clear, with `null`) a BI pivot's drill-through behavior. Persists in
 * the pivot's BI metadata; saved with the workbook and carried into `.calp`.
 */
export async function setPivotDrillBehavior(
  pivotId: PivotId,
  behavior: DrillThroughBehavior | null,
): Promise<void> {
  return pivotBackend.invoke<void>("set_pivot_drill_behavior", { pivotId, behavior });
}

/** Get a BI pivot's current drill-through behavior (`null` = default builtin). */
export async function getPivotDrillBehavior(
  pivotId: PivotId,
): Promise<DrillThroughBehavior | null> {
  return pivotBackend.invoke<DrillThroughBehavior | null>("get_pivot_drill_behavior", { pivotId });
}

/**
 * Fetch a BI pivot's model metadata (tables/columns + measures), used to offer
 * column/attribute pickers. Returns `null` for a non-BI pivot.
 */
export async function getPivotBiMetadata(
  pivotId: PivotId,
): Promise<BiPivotModelInfo | null> {
  return pivotBackend.invoke<BiPivotModelInfo | null>("get_pivot_bi_metadata", { pivotId });
}

/**
 * Fresh connection-level model metadata (same `BiPivotModelInfo` shape a
 * pivot exposes, no pivot required). Used by the perspective picker to show
 * the model's CURRENT perspectives — the copy stored in pivot metadata is a
 * snapshot from pivot creation. Returns null when the connection has no
 * loaded model (e.g. offline before reconnect).
 */
export async function getConnectionBiModel(
  connectionId: string,
): Promise<BiPivotModelInfo | null> {
  return pivotBackend.invoke<BiPivotModelInfo | null>("get_connection_bi_model", {
    connectionId,
  });
}

/**
 * Select the perspective filtering a BI pivot's field-list DISPLAY
 * (null = show all fields). Display-only; persists with the workbook.
 */
export async function setPivotPerspective(
  pivotId: PivotId,
  perspective: string | null,
): Promise<void> {
  return pivotBackend.invoke<void>("set_pivot_perspective", { pivotId, perspective });
}

// ============================================================================
// BI Pivot API Functions
// ============================================================================

/**
 * Creates a new BI pivot from the full model (all tables + measures).
 * The pivot starts empty — data is loaded when the user assigns fields.
 */
export async function createFromBiModel(
  request: CreatePivotFromBiModelRequest
): Promise<PivotViewResponse> {
  const t0 = performance.now();
  const result = await apiCreatePivotFromBiModel<CreatePivotFromBiModelRequest, PivotViewResponse>(request);
  const dt = performance.now() - t0;
  cachePivotView(result.pivotId, result);
  console.log(
    `[PERF][pivot] createFromBiModel pivot_id=${result.pivotId} | ipc=${dt.toFixed(1)}ms (cached)`
  );
  return result;
}

/**
 * Updates field assignments on a BI-backed pivot, triggering a BI engine re-query.
 */
export async function updateBiFields(
  request: UpdateBiPivotFieldsRequest
): Promise<PivotViewResponse> {
  const seq = startOperation(request.pivotId);
  apiCancelPivotOperation(request.pivotId).catch(() => {});
  // Wait for in-flight operation — BI engine is taken out of Mutex during async work,
  // so concurrent operations would fail with "No BI model loaded".
  const prev = getInflightOperation(request.pivotId);
  if (prev) await prev.catch(() => {});

  preserveCurrentView(request.pivotId);
  setLoading(request.pivotId, "Querying data...");
  const t0 = performance.now();
  const ipcPromise = apiUpdateBiPivotFields<UpdateBiPivotFieldsRequest, PivotViewResponse>(request);
  setInflightOperation(request.pivotId, ipcPromise);
  try {
    const result = await ipcPromise;
    if (!isCurrentOperation(request.pivotId, seq)) {
      throw new Error("Pivot operation superseded");
    }
    // If the user cancelled while the IPC was in-flight, revert backend + suppress result
    if (isUserCancelled(request.pivotId)) {
      clearUserCancelled(request.pivotId);
      restorePreviousView(request.pivotId);
      apiRevertPivotOperation(request.pivotId).catch((e) =>
        console.warn("[pivot] revert failed:", e)
      );
      throw new Error("Pivot operation cancelled");
    }
    // Check if the pivot overwrote existing cell data
    if (result.overwrittenCellCount && result.overwrittenCellCount > 0) {
      const confirmed = await ask(
        "A PivotTable report will overwrite existing data. Do you want to continue?",
        { title: "Calcula", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" }
      );
      if (!confirmed) {
        restorePreviousView(request.pivotId);
        apiUndoPivotOverwrite(request.pivotId).catch((e) =>
          console.warn("[pivot] undo_pivot_overwrite after overwrite cancel failed:", e)
        );
        emitAppEvent(AppEvents.GRID_REFRESH);
        throw new Error("Pivot operation cancelled - would overwrite data");
      }
    }
    const dt = performance.now() - t0;
    cachePivotView(request.pivotId, result);
    clearPreviousView(request.pivotId);
    // Trigger overlay refresh so the grid redraws with the new pivot data
    window.dispatchEvent(new CustomEvent("pivot:refresh"));
    console.log(
      `[PERF][pivot] updateBiFields pivot_id=${request.pivotId} rows=${result.rowCount}x${result.colCount} | ipc=${dt.toFixed(1)}ms (cached)`
    );
    return result;
  } catch (err) {
    if (isCurrentOperation(request.pivotId, seq)) {
      restorePreviousView(request.pivotId);
    }
    clearUserCancelled(request.pivotId);
    throw err;
  } finally {
    if (isCurrentOperation(request.pivotId, seq)) {
      clearLoading(request.pivotId);
    }
  }
}

/**
 * Persists the set of LOOKUP columns for a BI pivot without re-querying.
 * Lightweight — only updates metadata, no BI query or grid change.
 */
export async function setBiLookupColumns(
  pivotId: PivotId,
  lookupColumns: string[]
): Promise<void> {
  return apiSetBiLookupColumns(pivotId, lookupColumns);
}

/**
 * Cancels an in-progress pivot operation. The pivot reverts to its previous state.
 */
export async function cancelPivotOperation(pivotId: PivotId): Promise<void> {
  return apiCancelPivotOperation(pivotId);
}

/** Adds a calculated field to a pivot table. */
export async function addCalculatedField(
  request: CalculatedFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiAddCalculatedField<CalculatedFieldRequest, PivotViewResponse>(request);
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  return result;
}

/** Updates an existing calculated field. */
export async function updateCalculatedField(
  request: UpdateCalculatedFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiUpdateCalculatedField<UpdateCalculatedFieldRequest, PivotViewResponse>(request);
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  return result;
}

/** Removes a calculated field from a pivot table. */
export async function removeCalculatedField(
  request: RemoveCalculatedFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiRemoveCalculatedField<RemoveCalculatedFieldRequest, PivotViewResponse>(request);
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  return result;
}

/** Adds a calculated item to a pivot field. */
export async function addCalculatedItem(
  request: CalculatedItemRequest
): Promise<PivotViewResponse> {
  const result = await apiAddCalculatedItem<CalculatedItemRequest, PivotViewResponse>(request);
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  return result;
}

/** Removes a calculated item from a pivot table. */
export async function removeCalculatedItem(
  request: RemoveCalculatedItemRequest
): Promise<PivotViewResponse> {
  const result = await apiRemoveCalculatedItem<RemoveCalculatedItemRequest, PivotViewResponse>(request);
  if (!await confirmOverwriteOrUndo(result)) {
    throw new Error("Pivot operation cancelled - would overwrite data");
  }
  return result;
}

/** Generates one sheet per unique value of a filter field. */
export async function showReportFilterPages(
  pivotId: PivotId,
  filterFieldIndex: number
): Promise<string[]> {
  return apiShowReportFilterPages(pivotId, filterFieldIndex);
}

// ============================================================================
// Pivot DSL API
// ============================================================================

import { processDsl, serialize, type CompileContext, type CompileResult } from '../../_shared/dsl/pivotLayout';
import { getControlValue, type ControlValue } from '@api/controlValues';
import type { DslError } from '../../_shared/dsl/pivotLayout/errors';
import type { SourceField, ZoneField } from '../../_shared/components/types';

/** Result from validating DSL text against a pivot's fields. */
export interface ValidatePivotDslResult {
  /** True when the DSL has no hard errors and can be applied. */
  valid: boolean;
  /** All diagnostics (errors, warnings, info). */
  errors: DslError[];
  /** The compiled zone state (only meaningful when valid=true). */
  compiled?: {
    rows: ZoneField[];
    columns: ZoneField[];
    values: ZoneField[];
    filters: ZoneField[];
    layout: LayoutConfig;
    calculatedFields: CalculatedFieldDef[];
    valueColumnOrder: ValueColumnRefDef[];
  };
}

/** Result from applying DSL text to a pivot. */
export interface ApplyPivotDslResult {
  /** The pivot view after applying the DSL layout. */
  view: PivotViewResponse;
  /** Any warnings produced during compilation. */
  warnings: DslError[];
}

/**
 * Helper: get PivotRegionInfo for a pivot by ID.
 * Looks up the pivot's region on the current sheet, then fetches full info.
 */
async function getPivotRegionById(pivotId: PivotId): Promise<PivotRegionInfo> {
  const regions = await getPivotRegionsForSheet();
  const region = regions.find(r => r.pivotId === pivotId);
  if (!region) throw new Error(`Pivot ${pivotId} not found on current sheet`);
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info) throw new Error(`Pivot ${pivotId} region info not available`);
  return info;
}

/**
 * Build a CompileContext from a PivotRegionInfo.
 * Optionally fetches unique values for filter fields (needed for inclusion filter compilation).
 */
async function buildCompileContext(
  info: PivotRegionInfo,
  fetchFilterValues: boolean,
): Promise<CompileContext> {
  const sourceFields: SourceField[] = info.sourceFields.map(sf => ({
    index: sf.index,
    name: sf.name,
    isNumeric: sf.isNumeric,
    tableName: sf.tableName,
  }));

  const biModel = info.biModel;

  let filterUniqueValues: Map<string, string[]> | undefined;
  if (fetchFilterValues && info.fieldConfiguration.filterFields.length > 0) {
    filterUniqueValues = new Map();
    const promises = info.fieldConfiguration.filterFields.map(async (f) => {
      try {
        const resp = await getPivotFieldUniqueValues(info.pivotId, f.sourceIndex);
        filterUniqueValues!.set(f.name, resp.uniqueValues);
      } catch {
        // Non-critical — serialization will use NOT IN fallback
      }
    });
    await Promise.all(promises);
  }

  return { sourceFields, biModel, filterUniqueValues, resolveControl };
}

/**
 * Field parameters: resolve an `@CONTROL(name)` DSL reference to the named
 * pane control's / ribbon filter's current value as text. A dropdown control
 * listing field names lets the user re-point a pivot zone from the Controls
 * pane (Power BI "field parameter").
 */
function resolveControl(name: string): string | undefined {
  const v: ControlValue | undefined = getControlValue(name);
  if (!v) return undefined;
  switch (v.kind) {
    case 'text':
      return v.value;
    case 'number':
      return String(v.value);
    case 'boolean':
      return v.value ? 'TRUE' : 'FALSE';
    case 'textList':
      return v.value.join(', ');
    default:
      return undefined;
  }
}

/**
 * Get the current pivot layout as DSL text.
 *
 * Serializes the pivot's field configuration (rows, columns, values, filters, layout)
 * into the Pivot Layout Language.
 */
export async function getPivotDsl(pivotId: PivotId): Promise<string> {
  const info = await getPivotRegionById(pivotId);
  const config = info.fieldConfiguration;

  // Convert ZoneFieldInfo[] to ZoneField[] (ZoneFieldInfo is a subset of ZoneField)
  const toZoneFields = (fields: ZoneFieldInfo[]): ZoneField[] =>
    fields.map(f => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      isNumeric: f.isNumeric,
      aggregation: f.aggregation as ZoneField['aggregation'],
      isLookup: f.isLookup,
      hiddenItems: f.hiddenItems,
      customName: f.customName,
    }));

  const rows = toZoneFields(config.rowFields);
  const columns = toZoneFields(config.columnFields);
  const values = toZoneFields(config.valueFields);
  const filters = toZoneFields(config.filterFields);

  // Fetch filter unique values for smarter serialization
  let filterUniqueValues: Map<string, string[]> | undefined;
  if (filters.length > 0) {
    filterUniqueValues = new Map();
    const promises = filters.map(async (f) => {
      try {
        const resp = await getPivotFieldUniqueValues(pivotId, f.sourceIndex);
        filterUniqueValues!.set(f.name, resp.uniqueValues);
      } catch { /* non-critical */ }
    });
    await Promise.all(promises);
  }

  return serialize(rows, columns, values, filters, config.layout, {
    biModel: info.biModel,
    filterUniqueValues,
    calculatedFields: config.calculatedFields,
  });
}

/**
 * Validate DSL text against a pivot's source fields without applying it.
 *
 * Returns whether the DSL is valid and the compiled result (zone state).
 * Use this to preview what a DSL string would produce before applying.
 */
export async function validatePivotDsl(
  pivotId: PivotId,
  dslText: string,
): Promise<ValidatePivotDslResult> {
  const info = await getPivotRegionById(pivotId);
  const ctx = await buildCompileContext(info, true);
  const result = processDsl(dslText, ctx);

  const hasErrors = result.errors.some(e => e.severity === 'error');

  return {
    valid: !hasErrors,
    errors: result.errors,
    compiled: hasErrors ? undefined : {
      rows: result.rows,
      columns: result.columns,
      values: result.values,
      filters: result.filters,
      layout: result.layout,
      calculatedFields: result.calculatedFields,
      valueColumnOrder: result.valueColumnOrder,
    },
  };
}

/**
 * Apply DSL text to a pivot table.
 *
 * Parses, validates, and compiles the DSL, then updates the pivot's field
 * configuration. Handles both regular and BI-backed pivots.
 *
 * Throws if the DSL contains hard parse/validation errors.
 */
export async function applyPivotDsl(
  pivotId: PivotId,
  dslText: string,
): Promise<ApplyPivotDslResult> {
  const info = await getPivotRegionById(pivotId);
  const ctx = await buildCompileContext(info, true);
  const result = processDsl(dslText, ctx);

  // Reject if there are hard errors
  const hardErrors = result.errors.filter(e => e.severity === 'error');
  if (hardErrors.length > 0) {
    const messages = hardErrors.map(e => `Line ${e.location.line}: ${e.message}`);
    throw new Error(`DSL has ${hardErrors.length} error(s):\n${messages.join('\n')}`);
  }

  const warnings = result.errors.filter(e => e.severity !== 'error');

  // Build the update request from compiled zone state (mirrors buildUpdateRequest logic)
  const rowFields: PivotFieldConfig[] = result.rows.map(f => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
  }));

  const columnFields: PivotFieldConfig[] = result.columns.map(f => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
  }));

  const regularValues: ValueFieldConfig[] = [];
  const calcFields: CalculatedFieldDef[] = result.calculatedFields;
  const columnOrder: ValueColumnRefDef[] = result.valueColumnOrder;

  for (const f of result.values) {
    const aggregation = f.aggregation ?? (f.isNumeric ? 'sum' : 'count');
    const isBiField = f.sourceIndex === -1;
    const displayName = isBiField
      ? (f.customName || f.name)
      : (f.customName || f.name);
    regularValues.push({
      sourceIndex: f.sourceIndex,
      name: displayName,
      aggregation,
      numberFormat: f.numberFormat,
      showValuesAs: f.showValuesAs as ShowValuesAs | undefined,
      customName: f.customName || undefined,
    });
  }

  const filterFields: PivotFieldConfig[] = result.filters.map(f => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
    hiddenItems: f.hiddenItems,
  }));

  let view: PivotViewResponse;

  if (info.biModel) {
    // BI pivot: convert to BI-specific request
    const biTableNames = info.biModel.tables.map((t) => t.name);
    const toBiRef = (name: string, isLookup?: boolean): BiFieldRef => {
      const { table, column } = splitBiFieldKey(name, biTableNames);
      return { table, column, isLookup };
    };
    const toBiValueRef = (name: string, customName?: string): BiValueFieldRef => {
      const measureName = name.startsWith('[') && name.endsWith(']')
        ? name.substring(1, name.length - 1) : name;
      return { measureName, customName };
    };
    const isRealBiField = (f: { name: string }) => f.name.includes('.');

    const biRequest: UpdateBiPivotFieldsRequest = {
      pivotId,
      rowFields: rowFields.filter(isRealBiField).map(f => toBiRef(f.name, result.rows.find(r => r.name === f.name)?.isLookup)),
      columnFields: columnFields.filter(isRealBiField).map(f => toBiRef(f.name, result.columns.find(c => c.name === f.name)?.isLookup)),
      valueFields: regularValues.map(f => toBiValueRef(f.name, f.customName)),
      filterFields: filterFields.filter(isRealBiField).map(f => ({
        ...toBiRef(f.name),
        hiddenItems: f.hiddenItems,
      })),
      layout: result.layout,
      lookupColumns: result.lookupColumns,
      calculatedFields: calcFields.length > 0 ? calcFields : undefined,
      valueColumnOrder: columnOrder.length > 0 ? columnOrder : undefined,
      calculationGroup: result.appliedCalcGroup,
    };
    view = await updateBiFields(biRequest);
  } else {
    // Regular pivot
    const request: UpdatePivotFieldsRequest = {
      pivotId,
      rowFields,
      columnFields,
      valueFields: regularValues,
      filterFields,
      layout: result.layout,
      calculatedFields: calcFields.length > 0 ? calcFields : undefined,
      valueColumnOrder: columnOrder.length > 0 ? columnOrder : undefined,
    };
    view = await updatePivotFields(request);
  }

  return { view, warnings };
}

// The Pivot contract types now live in the API facade (@api/pivotTypes) so the
// facade does not import this extension. Imported for local use and re-exported
// for this extension's internal importers (../lib/pivot-api).
import type {
  PivotId,
  SortOrder,
  AggregationType,
  ShowValuesAs,
  ReportLayout,
  ValuesPosition,
  CreatePivotRequest,
  PivotFieldConfig,
  ShowAsCalculation,
  ShowAsRule,
  ValueFieldConfig,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  ToggleGroupRequest,
  PivotCellValue,
  PivotCellType,
  BackgroundStyle,
  PivotRowType,
  PivotColumnType,
  PivotCellData,
  PivotRowData,
  PivotColumnData,
  FilterRowData,
  HeaderFieldSummary,
  PivotRowDescriptorData,
  PivotViewResponse,
  PivotCellWindowResponse,
  SourceDataResponse,
  GroupPath,
  SourceFieldInfo,
  ZoneFieldInfo,
  PivotFieldConfiguration,
  HierarchyConfigInfo,
  FilterZoneInfo,
  BiPivotModelInfo,
  BiModelTable,
  BiCalcGroup,
  BiCalcGroupItem,
  BiModelColumn,
  BiMeasureFieldInfo,
  BiFieldRef,
  BiValueFieldRef,
  CreatePivotFromBiModelRequest,
  UpdateBiPivotFieldsRequest,
  AppliedCalcGroup,
  PivotRegionInfo,
  PivotRegionData,
  GetPivotDataFormulaResult,
  FieldUniqueValuesResponse,
  PivotLayoutType,
  SubtotalLocationType,
  AggregationFunction,
  PivotFilterType,
  SortBy,
  PivotAxis,
  LabelFilterCondition,
  ValueFilterCondition,
  PivotLabelFilter,
  PivotValueFilter,
  PivotManualFilter,
  PivotFilters,
  Subtotals,
  ExtendedLayoutConfig,
  PivotTableInfo,
  RangeInfo,
  PivotLayoutRanges,
  PivotFieldInfoResponse,
  PivotItemInfo,
  DataHierarchyInfo,
  RowColumnHierarchyInfo,
  PivotHierarchiesInfo,
  UpdatePivotPropertiesRequest,
  ChangePivotDataSourceRequest,
  UpdatePivotLayoutRequest,
  AddHierarchyRequest,
  RemoveHierarchyRequest,
  MoveFieldRequest,
  SetAggregationRequest,
  SetNumberFormatRequest,
  ApplyPivotFilterRequest,
  ClearPivotFilterRequest,
  SortPivotFieldRequest,
  SetItemVisibilityRequest,
  DateGroupLevel,
  SetItemExpandedRequest,
  ExpandCollapseLevelRequest,
  ExpandCollapseAllRequest,
  ManualGroupConfig,
  FieldGroupingConfig,
  GroupFieldRequest,
  CreateManualGroupRequest,
  UngroupFieldRequest,
  DrillThroughRequest,
  DrillThroughResponse,
  DrillThroughKind,
  DrillColumnRef,
  DrillOrderBy,
  DrillFilter,
  DrillQueryOverride,
  DrillThroughBehavior,
  CalculatedFieldRequest,
  UpdateCalculatedFieldRequest,
  RemoveCalculatedFieldRequest,
  CalculatedItemRequest,
  RemoveCalculatedItemRequest,
  CalculatedFieldDef,
  ValueColumnRefDef,
  PivotInteractiveBounds,
} from '@api/pivotTypes';
export type {
  PivotId,
  SortOrder,
  AggregationType,
  ShowValuesAs,
  ReportLayout,
  ValuesPosition,
  CreatePivotRequest,
  PivotFieldConfig,
  ShowAsCalculation,
  ShowAsRule,
  ValueFieldConfig,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  ToggleGroupRequest,
  PivotCellValue,
  PivotCellType,
  BackgroundStyle,
  PivotRowType,
  PivotColumnType,
  PivotCellData,
  PivotRowData,
  PivotColumnData,
  FilterRowData,
  HeaderFieldSummary,
  PivotRowDescriptorData,
  PivotViewResponse,
  PivotCellWindowResponse,
  SourceDataResponse,
  GroupPath,
  SourceFieldInfo,
  ZoneFieldInfo,
  PivotFieldConfiguration,
  HierarchyConfigInfo,
  FilterZoneInfo,
  BiPivotModelInfo,
  BiModelTable,
  BiCalcGroup,
  BiCalcGroupItem,
  BiModelColumn,
  BiMeasureFieldInfo,
  BiFieldRef,
  BiValueFieldRef,
  CreatePivotFromBiModelRequest,
  UpdateBiPivotFieldsRequest,
  AppliedCalcGroup,
  PivotRegionInfo,
  PivotRegionData,
  GetPivotDataFormulaResult,
  FieldUniqueValuesResponse,
  PivotLayoutType,
  SubtotalLocationType,
  AggregationFunction,
  PivotFilterType,
  SortBy,
  PivotAxis,
  LabelFilterCondition,
  ValueFilterCondition,
  PivotLabelFilter,
  PivotValueFilter,
  PivotManualFilter,
  PivotFilters,
  Subtotals,
  ExtendedLayoutConfig,
  PivotTableInfo,
  RangeInfo,
  PivotLayoutRanges,
  PivotFieldInfoResponse,
  PivotItemInfo,
  DataHierarchyInfo,
  RowColumnHierarchyInfo,
  PivotHierarchiesInfo,
  UpdatePivotPropertiesRequest,
  ChangePivotDataSourceRequest,
  UpdatePivotLayoutRequest,
  AddHierarchyRequest,
  RemoveHierarchyRequest,
  MoveFieldRequest,
  SetAggregationRequest,
  SetNumberFormatRequest,
  ApplyPivotFilterRequest,
  ClearPivotFilterRequest,
  SortPivotFieldRequest,
  SetItemVisibilityRequest,
  DateGroupLevel,
  SetItemExpandedRequest,
  ExpandCollapseLevelRequest,
  ExpandCollapseAllRequest,
  ManualGroupConfig,
  FieldGroupingConfig,
  GroupFieldRequest,
  CreateManualGroupRequest,
  UngroupFieldRequest,
  DrillThroughRequest,
  DrillThroughResponse,
  DrillThroughKind,
  DrillColumnRef,
  DrillOrderBy,
  DrillFilter,
  DrillQueryOverride,
  DrillThroughBehavior,
  CalculatedFieldRequest,
  UpdateCalculatedFieldRequest,
  RemoveCalculatedFieldRequest,
  CalculatedItemRequest,
  RemoveCalculatedItemRequest,
  CalculatedFieldDef,
  ValueColumnRefDef,
  PivotInteractiveBounds,
};

// IoC: register the implementation into the API facade. Consumers (including
// this extension's own UI) use the `pivot` object from @api/pivot, which
// delegates here. Runs at module load — before any runtime pivot.* call.
import { registerPivotApi } from '@api/pivot';
registerPivotApi({
  create: createPivotTable,
  updateFields: updatePivotFields,
  toggleGroup: togglePivotGroup,
  getView: getPivotView,
  delete: deletePivotTable,
  refreshCache: refreshPivotCache,
  getSourceData: getPivotSourceData,
  getAtCell: getPivotAtCell,
  getDataFormula: getPivotDataFormula,
  getRegionsForSheet: getPivotRegionsForSheet,
  getFieldUniqueValues: getPivotFieldUniqueValues,
  getCellNumericValue,
  getCellDisplayValue,
  isHeaderCell,
  isTotalCell,
  isFilterCell,
  isDataRow,
  isFilterRow,
  createFieldConfig,
  createValueFieldConfig,
  createLayoutConfig,
  getInfo: getPivotTableInfo,
  updateProperties: updatePivotProperties,
  getLayoutRanges: getPivotLayoutRanges,
  updateLayout: updatePivotLayout,
  getHierarchies: getPivotHierarchies,
  addHierarchy: addPivotHierarchy,
  removeHierarchy: removePivotHierarchy,
  moveField: movePivotField,
  setAggregation: setPivotAggregation,
  setNumberFormat: setPivotNumberFormat,
  applyFilter: applyPivotFilter,
  clearFilter: clearPivotFilter,
  sortField: sortPivotField,
  getFieldInfo: getPivotFieldInfo,
  setItemVisibility: setPivotItemVisibility,
  getAll: getAllPivotTables,
  refreshAll: refreshAllPivotTables,
  setItemExpanded: setPivotItemExpanded,
  expandCollapseLevel,
  expandCollapseAll,
  groupPivotField,
  createManualGroup,
  ungroupPivotField,
  drillThroughToSheet,
  createFromBiModel,
  updateBiFields,
  setBiLookupColumns,
});
