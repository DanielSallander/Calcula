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
  source_range: string;
  /** Destination cell in A1 notation (e.g., "F1") */
  destination_cell: string;
  /** Optional: sheet index for source data (defaults to active sheet) */
  source_sheet?: number;
  /** Optional: sheet index for destination (defaults to active sheet) */
  destination_sheet?: number;
  /** Whether first row contains headers (default: true) */
  has_headers?: boolean;
}

/** Field configuration for row/column areas */
export interface PivotFieldConfig {
  /** Source column index (0-based) */
  source_index: number;
  /** Display name */
  name: string;
  /** Sort order */
  sort_order?: SortOrder;
  /** Whether to show subtotals */
  show_subtotals?: boolean;
  /** Whether field is collapsed */
  collapsed?: boolean;
  /** Items to hide (filter out) */
  hidden_items?: string[];
}

/** Value field configuration */
export interface ValueFieldConfig {
  /** Source column index (0-based) */
  source_index: number;
  /** Display name */
  name: string;
  /** Aggregation type */
  aggregation: AggregationType;
  /** Number format string */
  number_format?: string;
  /** Show values as */
  show_values_as?: ShowValuesAs;
}

/** Layout configuration */
export interface LayoutConfig {
  show_row_grand_totals?: boolean;
  show_column_grand_totals?: boolean;
  report_layout?: ReportLayout;
  repeat_row_labels?: boolean;
  show_empty_rows?: boolean;
  show_empty_cols?: boolean;
  values_position?: ValuesPosition;
}

/** Request to update pivot table fields */
export interface UpdatePivotFieldsRequest {
  /** Pivot table ID */
  pivot_id: PivotId;
  /** Row fields (optional - if undefined, keep existing) */
  row_fields?: PivotFieldConfig[];
  /** Column fields (optional) */
  column_fields?: PivotFieldConfig[];
  /** Value fields (optional) */
  value_fields?: ValueFieldConfig[];
  /** Filter fields (optional) */
  filter_fields?: PivotFieldConfig[];
  /** Layout options (optional) */
  layout?: LayoutConfig;
}

/** Request to toggle a group's expand/collapse state */
export interface ToggleGroupRequest {
  /** Pivot table ID */
  pivot_id: PivotId;
  /** Whether this is a row (true) or column (false) group */
  is_row: boolean;
  /** The field index to toggle */
  field_index: number;
  /** The specific value to toggle (optional - if undefined, toggle all) */
  value?: string;
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
  | "FilterDropdown";

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
  cell_type: PivotCellType;
  value: PivotCellValue;
  formatted_value: string;
  indent_level: number;
  is_bold: boolean;
  is_expandable: boolean;
  is_collapsed: boolean;
  background_style: BackgroundStyle;
  number_format?: string;
  filter_field_index?: number;
}

/** Row data from the backend */
export interface PivotRowData {
  view_row: number;
  row_type: PivotRowType;
  depth: number;
  visible: boolean;
  cells: PivotCellData[];
}

/** Column descriptor from the backend */
export interface PivotColumnData {
  view_col: number;
  col_type: PivotColumnType;
  depth: number;
  width_hint: number;
}

/** Filter row metadata */
export interface FilterRowData {
  field_index: number;
  field_name: string;
  selected_values: string[];
  unique_values: string[];
  display_value: string;
  view_row: number;
}

/** Complete pivot view response */
export interface PivotViewResponse {
  pivot_id: PivotId;
  version: number;
  row_count: number;
  col_count: number;
  row_label_col_count: number;
  column_header_row_count: number;
  filter_row_count: number;
  filter_rows: FilterRowData[];
  rows: PivotRowData[];
  columns: PivotColumnData[];
}

/** Source data response for drill-down */
export interface SourceDataResponse {
  pivot_id: PivotId;
  headers: string[];
  rows: string[][];
  total_count: number;
  is_truncated: boolean;
}

/** Group path for drill-down operations */
export type GroupPath = Array<[number, number]>; // [field_index, value_id]

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
  return apiUpdatePivotFields<UpdatePivotFieldsRequest, PivotViewResponse>(request);
}

/**
 * Toggles the expand/collapse state of a pivot group.
 */
export async function togglePivotGroup(
  request: ToggleGroupRequest
): Promise<PivotViewResponse> {
  return apiTogglePivotGroup<ToggleGroupRequest, PivotViewResponse>(request);
}

/**
 * Gets the current view of a pivot table.
 */
export async function getPivotView(pivotId?: PivotId): Promise<PivotViewResponse> {
  return apiGetPivotView<PivotViewResponse>(pivotId);
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
  return cellType === "RowHeader" || cellType === "ColumnHeader" || cellType === "Corner";
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
  options?: Partial<Omit<PivotFieldConfig, "source_index" | "name">>
): PivotFieldConfig {
  return {
    source_index: sourceIndex,
    name,
    sort_order: options?.sort_order ?? "asc",
    show_subtotals: options?.show_subtotals ?? true,
    collapsed: options?.collapsed ?? false,
    hidden_items: options?.hidden_items ?? [],
  };
}

/**
 * Creates a default value field configuration.
 */
export function createValueFieldConfig(
  sourceIndex: number,
  name: string,
  aggregation: AggregationType = "sum",
  options?: Partial<Omit<ValueFieldConfig, "source_index" | "name" | "aggregation">>
): ValueFieldConfig {
  return {
    source_index: sourceIndex,
    name,
    aggregation,
    number_format: options?.number_format,
    show_values_as: options?.show_values_as ?? "normal",
  };
}

/**
 * Creates a default layout configuration.
 */
export function createLayoutConfig(
  options?: Partial<LayoutConfig>
): LayoutConfig {
  return {
    show_row_grand_totals: options?.show_row_grand_totals ?? true,
    show_column_grand_totals: options?.show_column_grand_totals ?? true,
    report_layout: options?.report_layout ?? "compact",
    repeat_row_labels: options?.repeat_row_labels ?? false,
    show_empty_rows: options?.show_empty_rows ?? false,
    show_empty_cols: options?.show_empty_cols ?? false,
    values_position: options?.values_position ?? "columns",
  };
}