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

import { cachePivotView } from "./pivotViewStore";

import {
  createPivotTable as apiCreatePivotTable,
  updatePivotFields as apiUpdatePivotFields,
  togglePivotGroup as apiTogglePivotGroup,
  getPivotView as apiGetPivotView,
  deletePivotTable as apiDeletePivotTable,
  getPivotSourceData as apiGetPivotSourceData,
  refreshPivotCache as apiRefreshPivotCache,
  getPivotAtCell as apiGetPivotAtCell,
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
} from "../../../src/api/backend";

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
export interface ValueFieldConfig {
  /** Source column index (0-based) */
  sourceIndex: number;
  /** Display name */
  name: string;
  /** Aggregation type */
  aggregation: AggregationType;
  /** Number format string */
  numberFormat?: string;
  /** Show values as */
  showValuesAs?: ShowValuesAs;
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

/** Cell value types */
export type PivotCellValue =
  | { type: "Empty" }
  | { type: "Number"; data: number }
  | { type: "Text"; data: string }
  | { type: "Boolean"; data: boolean }
  | { type: "Error"; data: string };

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

/** Cell data from the backend */
export interface PivotCellData {
  cellType: PivotCellType;
  value: PivotCellValue;
  formattedValue: string;
  indentLevel: number;
  isBold: boolean;
  isExpandable: boolean;
  isCollapsed: boolean;
  backgroundStyle: BackgroundStyle;
  numberFormat?: string;
  filterFieldIndex?: number;
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
}

/** Zone field info - represents a field assigned to a zone */
export interface ZoneFieldInfo {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  /** Only present for value fields */
  aggregation?: string;
}

/** Current field configuration for the pivot editor */
export interface PivotFieldConfiguration {
  rowFields: ZoneFieldInfo[];
  columnFields: ZoneFieldInfo[];
  valueFields: ZoneFieldInfo[];
  filterFields: ZoneFieldInfo[];
  layout: LayoutConfig;
}

/** Info about a filter dropdown cell position */
export interface FilterZoneInfo {
  row: number;
  col: number;
  fieldIndex: number;
  fieldName: string;
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
  const t0 = performance.now();
  const result = await apiUpdatePivotFields<UpdatePivotFieldsRequest, PivotViewResponse>(request);
  const dt = performance.now() - t0;
  // Cache immediately so refreshPivotViewCache can skip the redundant getPivotView call
  cachePivotView(request.pivotId, result);
  console.log(
    `[PERF][pivot] updatePivotFields pivot_id=${request.pivotId} rows=${result.rowCount}x${result.colCount} | ipc=${dt.toFixed(1)}ms (cached)`
  );
  return result;
}

/**
 * Toggles the expand/collapse state of a pivot group.
 */
export async function togglePivotGroup(
  request: ToggleGroupRequest
): Promise<PivotViewResponse> {
  const t0 = performance.now();
  const result = await apiTogglePivotGroup<ToggleGroupRequest, PivotViewResponse>(request);
  const dt = performance.now() - t0;
  // Cache immediately so refreshPivotViewCache can skip the redundant getPivotView call
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
 * Deletes a pivot table.
 */
export async function deletePivotTable(pivotId: PivotId): Promise<void> {
  return apiDeletePivotTable(pivotId);
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
  return apiRefreshPivotCache<PivotViewResponse>(pivotId);
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
  if (value.type === "Number") {
    return value.data;
  }
  return 0;
}

/**
 * Extracts the display string from a PivotCellValue.
 */
export function getCellDisplayValue(value: PivotCellValue): string {
  switch (value.type) {
    case "Empty":
      return "";
    case "Number":
      return value.data.toString();
    case "Text":
      return value.data;
    case "Boolean":
      return value.data ? "TRUE" : "FALSE";
    case "Error":
      return `#${value.data}`;
  }
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
  const result = await apiUpdatePivotLayout<UpdatePivotLayoutRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
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
  const result = await apiAddPivotHierarchy<AddHierarchyRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Removes a field from a hierarchy.
 */
export async function removePivotHierarchy(
  request: RemoveHierarchyRequest
): Promise<PivotViewResponse> {
  const result = await apiRemovePivotHierarchy<RemoveHierarchyRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Moves a field between hierarchies.
 */
export async function movePivotField(
  request: MoveFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiMovePivotField<MoveFieldRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Sets the aggregation function for a value field.
 */
export async function setPivotAggregation(
  request: SetAggregationRequest
): Promise<PivotViewResponse> {
  const result = await apiSetPivotAggregation<SetAggregationRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Sets the number format for a value field.
 */
export async function setPivotNumberFormat(
  request: SetNumberFormatRequest
): Promise<PivotViewResponse> {
  const result = await apiSetPivotNumberFormat<SetNumberFormatRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Applies a filter to a pivot field.
 */
export async function applyPivotFilter(
  request: ApplyPivotFilterRequest
): Promise<PivotViewResponse> {
  const result = await apiApplyPivotFilter<ApplyPivotFilterRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Clears filters from a pivot field.
 */
export async function clearPivotFilter(
  request: ClearPivotFilterRequest
): Promise<PivotViewResponse> {
  const result = await apiClearPivotFilter<ClearPivotFilterRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Sorts a pivot field by labels.
 */
export async function sortPivotField(
  request: SortPivotFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiSortPivotField<SortPivotFieldRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
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
  const result = await apiSetPivotItemVisibility<SetItemVisibilityRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
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
  const result = await apiSetPivotItemExpanded<SetItemExpandedRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Expands or collapses all items at a specific field level.
 */
export async function expandCollapseLevel(
  request: ExpandCollapseLevelRequest
): Promise<PivotViewResponse> {
  const result = await apiExpandCollapseLevel<ExpandCollapseLevelRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Expands or collapses all fields in the entire pivot table.
 */
export async function expandCollapseAll(
  request: ExpandCollapseAllRequest
): Promise<PivotViewResponse> {
  const result = await apiExpandCollapseAll<ExpandCollapseAllRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
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
  const result = await apiGroupPivotField<GroupFieldRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Creates a manual group on a pivot field.
 */
export async function createManualGroup(
  request: CreateManualGroupRequest
): Promise<PivotViewResponse> {
  const result = await apiCreateManualGroup<CreateManualGroupRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
}

/**
 * Removes all grouping from a pivot field.
 */
export async function ungroupPivotField(
  request: UngroupFieldRequest
): Promise<PivotViewResponse> {
  const result = await apiUngroupPivotField<UngroupFieldRequest, PivotViewResponse>(request);
  cachePivotView(request.pivotId, result);
  return result;
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