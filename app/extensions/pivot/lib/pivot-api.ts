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

/**
 * Pipeline stages (total = 4):
 *   1. Preparing...     (frontend, before IPC)
 *   2. Calculating...   (backend, pivot engine)
 *   3. Preparing response...  (backend, serialization)
 *   4. Updating grid... (backend, grid write)
 */
const TOTAL_STAGES = 4;

/** Set loading state AND trigger an overlay redraw so the indicator appears immediately. */
function setLoading(pivotId: number, stage: string, stageIndex = 0, totalStages = TOTAL_STAGES): void {
  _setLoading(pivotId, stage, stageIndex, totalStages);
  requestOverlayRedraw();
}

/** Clear loading state AND trigger an overlay redraw to remove the indicator. */
function clearLoading(pivotId: number): void {
  _clearLoading(pivotId);
  requestOverlayRedraw();
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
  changePivotDataSource as apiChangePivotDataSource,
  addCalculatedField as apiAddCalculatedField,
  updateCalculatedField as apiUpdateCalculatedField,
  removeCalculatedField as apiRemoveCalculatedField,
  addCalculatedItem as apiAddCalculatedItem,
  removeCalculatedItem as apiRemoveCalculatedItem,
  showReportFilterPages as apiShowReportFilterPages,
} from "@api/backend";

// ============================================================================
// Types
// ============================================================================

export type PivotId = number;

/** Sort order for pivot fields */
export type SortOrder = "asc" | "desc" | "manual" | "source";

/** Aggregation types for value fields */
export type AggregationType =
  | "sum"
  | "count"
  | "average"
  | "min"
  | "max"
  | "countnumbers"
  | "stddev"
  | "stddevp"
  | "var"
  | "varp"
  | "product";

/** How to display calculated values */
export type ShowValuesAs =
  | "normal"
  | "percent_of_total"
  | "percent_of_row"
  | "percent_of_column"
  | "percent_of_parent_row"
  | "percent_of_parent_column"
  | "difference"
  | "percent_difference"
  | "running_total"
  | "percent_of_running_total"
  | "rank_ascending"
  | "rank_descending"
  | "index";

/** Report layout styles */
export type ReportLayout = "compact" | "outline" | "tabular";

/** Where to place multiple value fields */
export type ValuesPosition = "columns" | "rows";

/** Request to create a new pivot table */
export interface CreatePivotRequest {
  /** Source range in A1 notation (e.g., "A1:D100") */
  sourceRange: string;
  /** Destination cell in A1 notation (e.g., "F1") */
  destinationCell: string;
  /** Optional: sheet index for source data (defaults to active sheet) */
  sourceSheet?: number;
  /** Optional: sheet index for destination (defaults to active sheet) */
  destinationSheet?: number;
  /** Whether first row contains headers (default: true) */
  hasHeaders?: boolean;
  /** Optional: friendly name for the pivot table */
  name?: string;
}

/** Field configuration for row/column areas */
export interface PivotFieldConfig {
  /** Source column index (0-based) */
  sourceIndex: number;
  /** Display name */
  name: string;
  /** Sort order */
  sortOrder?: SortOrder;
  /** Whether to show subtotals */
  showSubtotals?: boolean;
  /** Whether field is collapsed (field-level: collapses ALL items) */
  collapsed?: boolean;
  /** Items to hide (filter out) */
  hiddenItems?: string[];
  /** Per-item collapse tracking: specific item labels that are collapsed */
  collapsedItems?: string[];
  /** Whether to show all items (including items with no data) */
  showAllItems?: boolean;
  /** Grouping configuration for this field */
  grouping?: FieldGroupingConfig;
}

/** Value field configuration */
/** Show-as calculation types matching Excel's ShowAsCalculation */
export type ShowAsCalculation =
  | "none"
  | "percentOfGrandTotal"
  | "percentOfRowTotal"
  | "percentOfColumnTotal"
  | "percentOfParentRowTotal"
  | "percentOfParentColumnTotal"
  | "differenceFrom"
  | "percentDifferenceFrom"
  | "runningTotal"
  | "percentOfRunningTotal"
  | "rankAscending"
  | "rankDescending"
  | "index";

/** Rule for showing values as a calculation (Excel-compatible) */
export interface ShowAsRule {
  calculation: ShowAsCalculation;
  baseField?: string;
  baseItem?: string;
}

export interface ValueFieldConfig {
  /** Source column index (0-based) */
  sourceIndex: number;
  /** Display name */
  name: string;
  /** Aggregation type */
  aggregation: AggregationType;
  /** Number format string */
  numberFormat?: string;
  /** Show values as (simple string form) */
  showValuesAs?: ShowValuesAs;
  /** Show as rule with base field/item (Excel-compatible form) */
  showAs?: ShowAsRule;
}

/** Layout configuration */
export interface LayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  reportLayout?: ReportLayout;
  repeatRowLabels?: boolean;
  showEmptyRows?: boolean;
  showEmptyCols?: boolean;
  valuesPosition?: ValuesPosition;
  autoFitColumnWidths?: boolean;
}

/** Request to update pivot table fields */
export interface UpdatePivotFieldsRequest {
  /** Pivot table ID */
  pivotId: PivotId;
  /** Row fields (optional - if undefined, keep existing) */
  rowFields?: PivotFieldConfig[];
  /** Column fields (optional) */
  columnFields?: PivotFieldConfig[];
  /** Value fields (optional) */
  valueFields?: ValueFieldConfig[];
  /** Filter fields (optional) */
  filterFields?: PivotFieldConfig[];
  /** Layout options (optional) */
  layout?: LayoutConfig;
}

/** Request to toggle a group's expand/collapse state */
export interface ToggleGroupRequest {
  /** Pivot table ID */
  pivotId: PivotId;
  /** Whether this is a row (true) or column (false) group */
  isRow: boolean;
  /** The field index to toggle */
  fieldIndex: number;
  /** The specific value to toggle (optional - if undefined, toggle all) */
  value?: string;
  /** Full group path for path-specific toggle: [fieldIndex, valueId] pairs.
   *  When provided, only the exact item at this path is toggled. */
  groupPath?: Array<[number, number]>;
}

/** Cell value — untagged for compact IPC serialization.
 * null = empty, number = numeric, string = text (errors prefixed with "#"),
 * boolean = true/false. */
export type PivotCellValue = number | string | boolean | null;

/** Cell type identifiers */
export type PivotCellType =
  | "Data"
  | "RowHeader"
  | "ColumnHeader"
  | "Corner"
  | "RowSubtotal"
  | "ColumnSubtotal"
  | "GrandTotal"
  | "GrandTotalRow"
  | "GrandTotalColumn"
  | "Blank"
  | "FilterLabel"
  | "FilterDropdown"
  | "RowLabelHeader"
  | "ColumnLabelHeader";

/** Background style for cells */
export type BackgroundStyle = 
  | "Normal" 
  | "Alternate" 
  | "Subtotal" 
  | "Total" 
  | "GrandTotal"
  | "Header"
  | "FilterRow";

/** Row type identifiers */
export type PivotRowType = "ColumnHeader" | "Data" | "Subtotal" | "GrandTotal" | "FilterRow";

/** Column type identifiers */
export type PivotColumnType = "RowLabel" | "Data" | "Subtotal" | "GrandTotal";

/** Cell data from the backend.
 * Fields with defaults (indentLevel, isBold, isExpandable, isCollapsed)
 * are omitted from the JSON payload when at their default value to reduce IPC size. */
export interface PivotCellData {
  cellType: PivotCellType;
  value: PivotCellValue;
  formattedValue?: string;
  indentLevel?: number;
  isBold?: boolean;
  isExpandable?: boolean;
  isCollapsed?: boolean;
  backgroundStyle: BackgroundStyle;
  numberFormat?: string;
  filterFieldIndex?: number;
  colSpan?: number;
  /** Group path for drill-down: [fieldIndex, valueId] pairs identifying this cell's data */
  groupPath?: Array<[number, number]>;
}

/** Row data from the backend */
export interface PivotRowData {
  viewRow: number;
  rowType: PivotRowType;
  depth: number;
  visible: boolean;
  cells: PivotCellData[];
}

/** Column descriptor from the backend */
export interface PivotColumnData {
  viewCol: number;
  colType: PivotColumnType;
  depth: number;
  widthHint: number;
  /** Longest display string in this column (with indent padding).
   * When present, the frontend measures this single string instead of
   * scanning all rows for column auto-sizing. */
  maxContentSample?: string;
}

/** Filter row metadata */
export interface FilterRowData {
  fieldIndex: number;
  fieldName: string;
  selectedValues: string[];
  uniqueValues: string[];
  displayValue: string;
  viewRow: number;
}

/** Summary info about a row or column field for header filter dropdowns */
export interface HeaderFieldSummary {
  fieldIndex: number;
  fieldName: string;
  hasActiveFilter: boolean;
}

/** Lightweight row descriptor for windowed responses (no cell data). */
export interface PivotRowDescriptorData {
  viewRow: number;
  rowType: PivotRowType;
  depth: number;
  visible: boolean;
}

/** Complete pivot view response */
export interface PivotViewResponse {
  pivotId: PivotId;
  version: number;
  rowCount: number;
  colCount: number;
  rowLabelColCount: number;
  columnHeaderRowCount: number;
  filterRowCount: number;
  filterRows: FilterRowData[];
  rowFieldSummaries: HeaderFieldSummary[];
  columnFieldSummaries: HeaderFieldSummary[];
  rows: PivotRowData[];
  columns: PivotColumnData[];
  /** True when the response contains only a window of cells (large pivots). */
  isWindowed?: boolean;
  /** For windowed responses: total number of rows in the full view. */
  totalRowCount?: number;
  /** For windowed responses: starting row index of the cell window. */
  windowStartRow?: number;
  /** For windowed responses: lightweight descriptors for ALL rows (no cells). */
  rowDescriptors?: PivotRowDescriptorData[];
}

/** Response for a cell window fetch (scroll-triggered). */
export interface PivotCellWindowResponse {
  pivotId: PivotId;
  version: number;
  startRow: number;
  rows: PivotRowData[];
}

/** Source data response for drill-down */
export interface SourceDataResponse {
  pivotId: PivotId;
  headers: string[];
  rows: string[][];
  totalCount: number;
  isTruncated: boolean;
}

/** Group path for drill-down operations */
export type GroupPath = Array<[number, number]>; // [fieldIndex, valueId]

/** Source field info from pivot region check */
export interface SourceFieldInfo {
  index: number;
  name: string;
  isNumeric: boolean;
  tableName?: string;
}

/** Zone field info - represents a field assigned to a zone */
export interface ZoneFieldInfo {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  /** Only present for value fields */
  aggregation?: string;
  /** Whether this is a LOOKUP (attribute) field rather than GROUP. BI pivots only. */
  isLookup?: boolean;
  /** Items hidden by the filter. Only present for filter fields with active filters. */
  hiddenItems?: string[];
}

/** Current field configuration for the pivot editor */
export interface PivotFieldConfiguration {
  rowFields: ZoneFieldInfo[];
  columnFields: ZoneFieldInfo[];
  valueFields: ZoneFieldInfo[];
  filterFields: ZoneFieldInfo[];
  layout: LayoutConfig;
  calculatedFields?: { name: string; formula: string; numberFormat?: string }[];
}

/** Info about a filter dropdown cell position */
export interface FilterZoneInfo {
  row: number;
  col: number;
  fieldIndex: number;
  fieldName: string;
}

/** BI model info for the hierarchical field list */
export interface BiPivotModelInfo {
  /** The connection ID this pivot is associated with. */
  connectionId: number;
  tables: BiModelTable[];
  measures: BiMeasureFieldInfo[];
  /** All columns toggled to LOOKUP mode ("Table.Column" keys) */
  lookupColumns?: string[];
}

export interface BiModelTable {
  name: string;
  columns: BiModelColumn[];
}

export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
}

export interface BiMeasureFieldInfo {
  name: string;
  table: string;
  sourceColumn: string;
  aggregation: string;
}

/** BI field reference (table + column) */
export interface BiFieldRef {
  table: string;
  column: string;
  /** When true, this field is a lookup column (resolved post-aggregation). */
  isLookup?: boolean;
}

/** BI value field reference (measure name) */
export interface BiValueFieldRef {
  measureName: string;
}

/** Request to create a BI model pivot */
export interface CreatePivotFromBiModelRequest {
  destinationCell: string;
  destinationSheet?: number;
  name?: string;
  /** The connection ID to use for this BI pivot. */
  connectionId: number;
}

/** Request to update BI pivot field assignments */
export interface UpdateBiPivotFieldsRequest {
  pivotId: PivotId;
  rowFields: BiFieldRef[];
  columnFields: BiFieldRef[];
  valueFields: BiValueFieldRef[];
  filterFields: BiFieldRef[];
  /** Fields needed only by slicers — included in the query but not shown as visible filter rows */
  slicerFields?: BiFieldRef[];
  layout?: LayoutConfig;
  /** All columns toggled to LOOKUP mode, including those not in zones */
  lookupColumns?: string[];
}

/** Pivot region info returned when checking if a cell is in a pivot */
export interface PivotRegionInfo {
  pivotId: PivotId;
  isEmpty: boolean;
  sourceFields: SourceFieldInfo[];
  /** Current field configuration - which fields are in which zones */
  fieldConfiguration: PivotFieldConfiguration;
  /** Filter zones: position info for each filter dropdown cell */
  filterZones: FilterZoneInfo[];
  /** BI model info - present only for BI-backed pivots */
  biModel?: BiPivotModelInfo;
}

/** Pivot region data for rendering placeholders */
export interface PivotRegionData {
  pivotId: PivotId;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
}

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

/** Result of resolving a pivot cell into GETPIVOTDATA formula arguments. */
export interface GetPivotDataFormulaResult {
  dataField: string;
  fieldItemPairs: [string, string][];
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

/** Response containing unique values for a field */
export interface FieldUniqueValuesResponse {
  fieldIndex: number;
  fieldName: string;
  uniqueValues: string[];
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
// NEW EXCEL-COMPATIBLE TYPES
// ============================================================================

/** Pivot layout type (Excel: PivotLayoutType) */
export type PivotLayoutType = "compact" | "tabular" | "outline";

/** Subtotal location type (Excel: SubtotalLocationType) */
export type SubtotalLocationType = "atTop" | "atBottom" | "off";

/** Aggregation function (Excel: AggregationFunction) */
export type AggregationFunction =
  | "automatic"
  | "sum"
  | "count"
  | "average"
  | "max"
  | "min"
  | "product"
  | "countNumbers"
  | "standardDeviation"
  | "standardDeviationP"
  | "variance"
  | "varianceP";

/** Show as calculation type (Excel: ShowAsCalculation) */
export type ShowAsCalculation =
  | "none"
  | "percentOfGrandTotal"
  | "percentOfRowTotal"
  | "percentOfColumnTotal"
  | "percentOfParentRowTotal"
  | "percentOfParentColumnTotal"
  | "differenceFrom"
  | "percentDifferenceFrom"
  | "runningTotal"
  | "percentOfRunningTotal"
  | "rankAscending"
  | "rankDescending"
  | "index";

/** Pivot filter type (Excel: PivotFilterType) */
export type PivotFilterType = "unknown" | "value" | "manual" | "label" | "date";

/** Sort direction (Excel: SortBy) */
export type SortBy = "ascending" | "descending";

/** Pivot axis (Excel: PivotAxis) */
export type PivotAxis = "unknown" | "row" | "column" | "data" | "filter";

/** Label filter condition */
export type LabelFilterCondition =
  | "beginsWith"
  | "endsWith"
  | "contains"
  | "doesNotContain"
  | "equals"
  | "doesNotEqual"
  | "greaterThan"
  | "greaterThanOrEqualTo"
  | "lessThan"
  | "lessThanOrEqualTo"
  | "between";

/** Value filter condition */
export type ValueFilterCondition =
  | "equals"
  | "doesNotEqual"
  | "greaterThan"
  | "greaterThanOrEqualTo"
  | "lessThan"
  | "lessThanOrEqualTo"
  | "between"
  | "topN"
  | "bottomN"
  | "topNPercent"
  | "bottomNPercent";

/** Label filter for text-based filtering */
export interface PivotLabelFilter {
  condition: LabelFilterCondition;
  substring?: string;
  lowerBound?: string;
  upperBound?: string;
  exclusive?: boolean;
}

/** Value filter for numeric filtering */
export interface PivotValueFilter {
  condition: ValueFilterCondition;
  comparator?: number;
  lowerBound?: number;
  upperBound?: number;
  value?: number;
  selectionType?: string;
  exclusive?: boolean;
}

/** Manual filter for explicit item selection */
export interface PivotManualFilter {
  selectedItems: string[];
}

/** Combined pivot filters for a field */
export interface PivotFilters {
  dateFilter?: unknown; // Date filter (not fully implemented yet)
  labelFilter?: PivotLabelFilter;
  manualFilter?: PivotManualFilter;
  valueFilter?: PivotValueFilter;
}

/** Show as rule for calculated display */
export interface ShowAsRule {
  calculation: ShowAsCalculation;
  baseField?: string;
  baseItem?: string;
}

/** Subtotals configuration for a pivot field */
export interface Subtotals {
  automatic?: boolean;
  average?: boolean;
  count?: boolean;
  countNumbers?: boolean;
  max?: boolean;
  min?: boolean;
  product?: boolean;
  standardDeviation?: boolean;
  standardDeviationP?: boolean;
  sum?: boolean;
  variance?: boolean;
  varianceP?: boolean;
}

/** Extended layout configuration with Excel properties */
export interface ExtendedLayoutConfig extends LayoutConfig {
  autoFormat?: boolean;
  preserveFormatting?: boolean;
  showFieldHeaders?: boolean;
  enableFieldList?: boolean;
  emptyCellText?: string;
  fillEmptyCells?: boolean;
  subtotalLocation?: SubtotalLocationType;
  altTextTitle?: string;
  altTextDescription?: string;
}

/** Pivot table info response */
export interface PivotTableInfo {
  id: PivotId;
  name: string;
  sourceRange: string;
  destination: string;
  allowMultipleFiltersPerField: boolean;
  enableDataValueEditing: boolean;
  refreshOnOpen: boolean;
  useCustomSortLists: boolean;
  hasHeaders: boolean;
  sourceTableName?: string;
}

/** Range information */
export interface RangeInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  address: string;
}

/** Pivot layout ranges response */
export interface PivotLayoutRanges {
  range?: RangeInfo;
  dataBodyRange?: RangeInfo;
  columnLabelRange?: RangeInfo;
  rowLabelRange?: RangeInfo;
  filterAxisRange?: RangeInfo;
}

/** Pivot field info including items and filters */
export interface PivotFieldInfoResponse {
  id: number;
  name: string;
  showAllItems: boolean;
  filters: PivotFilters;
  isFiltered: boolean;
  subtotals: Subtotals;
  items: PivotItemInfo[];
}

/** Pivot item info */
export interface PivotItemInfo {
  id: number;
  name: string;
  isExpanded: boolean;
  visible: boolean;
}

/** Data hierarchy info */
export interface DataHierarchyInfo {
  id: number;
  name: string;
  fieldIndex: number;
  summarizeBy: AggregationFunction;
  numberFormat?: string;
  position: number;
  showAs?: ShowAsRule;
}

/** Row/Column hierarchy info */
export interface RowColumnHierarchyInfo {
  id: number;
  name: string;
  fieldIndex: number;
  position: number;
}

/** All hierarchies info response */
export interface PivotHierarchiesInfo {
  hierarchies: SourceFieldInfo[];
  rowHierarchies: RowColumnHierarchyInfo[];
  columnHierarchies: RowColumnHierarchyInfo[];
  dataHierarchies: DataHierarchyInfo[];
  filterHierarchies: RowColumnHierarchyInfo[];
}

// ============================================================================
// NEW REQUEST TYPES
// ============================================================================

/** Request to update pivot properties */
export interface UpdatePivotPropertiesRequest {
  pivotId: PivotId;
  name?: string;
  allowMultipleFiltersPerField?: boolean;
  enableDataValueEditing?: boolean;
  refreshOnOpen?: boolean;
  useCustomSortLists?: boolean;
}

/** Request to change pivot data source range */
export interface ChangePivotDataSourceRequest {
  pivotId: PivotId;
  sourceRange: string;
  sourceSheet?: number;
}

/** Request to update pivot layout */
export interface UpdatePivotLayoutRequest {
  pivotId: PivotId;
  layout: ExtendedLayoutConfig;
}

/** Request to add a field to a hierarchy */
export interface AddHierarchyRequest {
  pivotId: PivotId;
  fieldIndex: number;
  axis: PivotAxis;
  position?: number;
  name?: string;
  aggregation?: AggregationFunction;
}

/** Request to remove a field from a hierarchy */
export interface RemoveHierarchyRequest {
  pivotId: PivotId;
  axis: PivotAxis;
  position: number;
}

/** Request to move a field to a different hierarchy */
export interface MoveFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  targetAxis: PivotAxis;
  position?: number;
}

/** Request to set aggregation function */
export interface SetAggregationRequest {
  pivotId: PivotId;
  valueFieldIndex: number;
  summarizeBy: AggregationFunction;
}

/** Request to set number format */
export interface SetNumberFormatRequest {
  pivotId: PivotId;
  valueFieldIndex: number;
  numberFormat: string;
}

/** Request to apply filters to a pivot field */
export interface ApplyPivotFilterRequest {
  pivotId: PivotId;
  fieldIndex: number;
  filters: PivotFilters;
}

/** Request to clear pivot field filters */
export interface ClearPivotFilterRequest {
  pivotId: PivotId;
  fieldIndex: number;
  filterType?: PivotFilterType;
}

/** Request to sort a pivot field */
export interface SortPivotFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  sortBy: SortBy;
  valuesHierarchy?: string;
  pivotItemScope?: string[];
}

/** Request to set pivot item visibility */
export interface SetItemVisibilityRequest {
  pivotId: PivotId;
  fieldIndex: number;
  itemName: string;
  visible: boolean;
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
  return apiRefreshAllPivotTables<PivotViewResponse[]>();
}

// ============================================================================
// EXPAND/COLLAPSE AND GROUPING TYPES
// ============================================================================

/** Date group level for date grouping */
export type DateGroupLevel = "year" | "quarter" | "month" | "week" | "day";

/** Manual group definition */
export interface ManualGroupConfig {
  name: string;
  members: string[];
}

/** Grouping configuration for a field */
export type FieldGroupingConfig =
  | { type: "None" }
  | { type: "DateGrouping"; levels: DateGroupLevel[] }
  | { type: "NumberBinning"; start: number; end: number; interval: number }
  | {
      type: "ManualGrouping";
      groups: ManualGroupConfig[];
      ungroupedName?: string;
    };

/** Request to set a pivot item's expand/collapse state */
export interface SetItemExpandedRequest {
  pivotId: PivotId;
  fieldIndex: number;
  itemName: string;
  isExpanded: boolean;
}

/** Request to expand or collapse all items at a specific field level */
export interface ExpandCollapseLevelRequest {
  pivotId: PivotId;
  isRow: boolean;
  fieldIndex: number;
  expand: boolean;
}

/** Request to expand or collapse all fields in the pivot table */
export interface ExpandCollapseAllRequest {
  pivotId: PivotId;
  expand: boolean;
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
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

// ============================================================================
// GROUPING TYPES
// ============================================================================

/** Manual group configuration */
export interface ManualGroupConfig {
  name: string;
  members: string[];
}

/** Grouping configuration for a pivot field (tagged union via "type" key) */
export type FieldGroupingConfig =
  | { type: "none" }
  | { type: "dateGrouping"; levels: DateGroupLevel[] }
  | { type: "numberBinning"; start: number; end: number; interval: number }
  | { type: "manualGrouping"; groups: ManualGroupConfig[]; ungroupedName?: string };

/** Request to apply grouping to a field */
export interface GroupFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  grouping: FieldGroupingConfig;
}

/** Request to create a manual group on a field */
export interface CreateManualGroupRequest {
  pivotId: PivotId;
  fieldIndex: number;
  groupName: string;
  memberItems: string[];
}

/** Request to remove grouping from a field */
export interface UngroupFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
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
    cachePivotView(request.pivotId, result);
    return result;
  } finally {
    clearLoading(request.pivotId);
  }
}

// ============================================================================
// Drill-Through (creates new sheet with matching source data)
// ============================================================================

/** Request for drill-through to a new sheet. */
export interface DrillThroughRequest {
  pivotId: PivotId;
  groupPath: Array<[number, number]>;
  maxRecords?: number;
}

/** Response from drill-through operation. */
export interface DrillThroughResponse {
  sheetName: string;
  sheetIndex: number;
  rowCount: number;
  colCount: number;
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
    const dt = performance.now() - t0;
    cachePivotView(request.pivotId, result);
    clearPreviousView(request.pivotId);
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

// ============================================================================
// Calculated Fields / Items
// ============================================================================

export interface CalculatedFieldRequest {
  pivotId: number;
  name: string;
  formula: string;
  numberFormat?: string;
}

export interface UpdateCalculatedFieldRequest {
  pivotId: number;
  fieldIndex: number;
  name: string;
  formula: string;
  numberFormat?: string;
}

export interface RemoveCalculatedFieldRequest {
  pivotId: number;
  fieldIndex: number;
}

export interface CalculatedItemRequest {
  pivotId: number;
  fieldIndex: number;
  name: string;
  formula: string;
}

export interface RemoveCalculatedItemRequest {
  pivotId: number;
  itemIndex: number;
}

/** Adds a calculated field to a pivot table. */
export async function addCalculatedField(
  request: CalculatedFieldRequest
): Promise<PivotViewResponse> {
  return apiAddCalculatedField<CalculatedFieldRequest, PivotViewResponse>(request);
}

/** Updates an existing calculated field. */
export async function updateCalculatedField(
  request: UpdateCalculatedFieldRequest
): Promise<PivotViewResponse> {
  return apiUpdateCalculatedField<UpdateCalculatedFieldRequest, PivotViewResponse>(request);
}

/** Removes a calculated field from a pivot table. */
export async function removeCalculatedField(
  request: RemoveCalculatedFieldRequest
): Promise<PivotViewResponse> {
  return apiRemoveCalculatedField<RemoveCalculatedFieldRequest, PivotViewResponse>(request);
}

/** Adds a calculated item to a pivot field. */
export async function addCalculatedItem(
  request: CalculatedItemRequest
): Promise<PivotViewResponse> {
  return apiAddCalculatedItem<CalculatedItemRequest, PivotViewResponse>(request);
}

/** Removes a calculated item from a pivot table. */
export async function removeCalculatedItem(
  request: RemoveCalculatedItemRequest
): Promise<PivotViewResponse> {
  return apiRemoveCalculatedItem<RemoveCalculatedItemRequest, PivotViewResponse>(request);
}

/** Generates one sheet per unique value of a filter field. */
export async function showReportFilterPages(
  pivotId: PivotId,
  filterFieldIndex: number
): Promise<string[]> {
  return apiShowReportFilterPages(pivotId, filterFieldIndex);
}