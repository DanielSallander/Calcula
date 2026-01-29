/**
 * FILENAME: app/src/core/lib/pivot-api.ts
 * Pivot Table API
 *
 * TypeScript bindings for the Tauri pivot table commands.
 * Provides a clean async interface for creating, updating, and querying pivot tables.
 */

import { invoke } from "@tauri-apps/api/core";

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
 *
 * @param request - Configuration for the new pivot table
 * @returns The initial pivot view
 * @throws Error if creation fails
 *
 * @example
 * ```ts
 * const view = await createPivotTable({
 *   source_range: "A1:D100",
 *   destination_cell: "F1",
 *   has_headers: true,
 * });
 * ```
 */
export async function createPivotTable(
  request: CreatePivotRequest
): Promise<PivotViewResponse> {
  return invoke<PivotViewResponse>("create_pivot_table", { request });
}

/**
 * Updates the field configuration of an existing pivot table.
 *
 * @param request - The fields to update (only specified fields are changed)
 * @returns The updated pivot view
 * @throws Error if update fails or pivot not found
 *
 * @example
 * ```ts
 * const view = await updatePivotFields({
 *   pivot_id: 1,
 *   row_fields: [
 *     { source_index: 0, name: "Region", sort_order: "asc" },
 *   ],
 *   value_fields: [
 *     { source_index: 2, name: "Total Sales", aggregation: "sum" },
 *   ],
 * });
 * ```
 */
export async function updatePivotFields(
  request: UpdatePivotFieldsRequest
): Promise<PivotViewResponse> {
  return invoke<PivotViewResponse>("update_pivot_fields", { request });
}

/**
 * Toggles the expand/collapse state of a pivot group.
 *
 * @param request - Identifies which group to toggle
 * @returns The updated pivot view
 * @throws Error if toggle fails or pivot not found
 *
 * @example
 * ```ts
 * const view = await togglePivotGroup({
 *   pivot_id: 1,
 *   is_row: true,
 *   field_index: 0,
 * });
 * ```
 */
export async function togglePivotGroup(
  request: ToggleGroupRequest
): Promise<PivotViewResponse> {
  return invoke<PivotViewResponse>("toggle_pivot_group", { request });
}

/**
 * Gets the current view of a pivot table.
 *
 * @param pivotId - The pivot table ID (optional, uses active pivot if not specified)
 * @returns The current pivot view
 * @throws Error if pivot not found
 *
 * @example
 * ```ts
 * const view = await getPivotView(1);
 * ```
 */
export async function getPivotView(pivotId?: PivotId): Promise<PivotViewResponse> {
  return invoke<PivotViewResponse>("get_pivot_view", { pivotId });
}

/**
 * Deletes a pivot table.
 *
 * @param pivotId - The pivot table ID to delete
 * @throws Error if pivot not found
 *
 * @example
 * ```ts
 * await deletePivotTable(1);
 * ```
 */
export async function deletePivotTable(pivotId: PivotId): Promise<void> {
  return invoke<void>("delete_pivot_table", { pivotId });
}

/**
 * Gets source data for drill-down (detail view).
 *
 * @param pivotId - The pivot table ID
 * @param groupPath - The path identifying which cell to drill into
 * @param maxRecords - Maximum records to return (default: 1000)
 * @returns The source data rows matching the group path
 * @throws Error if pivot not found
 *
 * @example
 * ```ts
 * const data = await getPivotSourceData(1, [[0, 5]], 100);
 * console.log(data.headers); // ["Region", "Product", "Sales"]
 * console.log(data.rows);    // [["North", "Apples", "100"], ...]
 * ```
 */
export async function getPivotSourceData(
  pivotId: PivotId,
  groupPath: GroupPath,
  maxRecords?: number
): Promise<SourceDataResponse> {
  return invoke<SourceDataResponse>("get_pivot_source_data", {
    pivotId,
    groupPath,
    maxRecords,
  });
}

/**
 * Refreshes the pivot cache from current grid data.
 * Call this when the source data has changed.
 *
 * @param pivotId - The pivot table ID to refresh
 * @returns The refreshed pivot view
 * @throws Error if pivot not found
 *
 * @example
 * ```ts
 * const view = await refreshPivotCache(1);
 * ```
 */
export async function refreshPivotCache(pivotId: PivotId): Promise<PivotViewResponse> {
  return invoke<PivotViewResponse>("refresh_pivot_cache", { pivotId });
}

/**
 * Checks if a cell is within a pivot table region.
 *
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns Pivot region info if cell is in a pivot, null otherwise
 *
 * @example
 * ```ts
 * const info = await getPivotAtCell(5, 10);
 * if (info) {
 *   console.log("Cell is in pivot", info.pivotId);
 * }
 * ```
 */
export async function getPivotAtCell(
  row: number,
  col: number
): Promise<PivotRegionInfo | null> {
  return invoke<PivotRegionInfo | null>("get_pivot_at_cell", { row, col });
}

/**
 * Gets all pivot regions for the current sheet.
 * Used for rendering pivot placeholders.
 *
 * @returns Array of pivot region data
 *
 * @example
 * ```ts
 * const regions = await getPivotRegionsForSheet();
 * for (const region of regions) {
 *   if (region.isEmpty) {
 *     // Draw placeholder
 *   }
 * }
 * ```
 */
export async function getPivotRegionsForSheet(): Promise<PivotRegionData[]> {
  return invoke<PivotRegionData[]>("get_pivot_regions_for_sheet", {});
}

/** Response containing unique values for a field */
export interface FieldUniqueValuesResponse {
  field_index: number;
  field_name: string;
  unique_values: string[];
}

/**
 * Gets unique values for a specific field in a pivot table's source data.
 * Used for filter dropdowns.
 *
 * @param pivotId - The pivot table ID
 * @param fieldIndex - The source field index
 * @returns Array of unique values as strings
 * @throws Error if pivot not found or field index is out of range
 *
 * @example
 * ```ts
 * const values = await getPivotFieldUniqueValues(1, 0);
 * console.log(values.unique_values); // ["North", "South", "East", "West"]
 * ```
 */
export async function getPivotFieldUniqueValues(
  pivotId: PivotId,
  fieldIndex: number
): Promise<FieldUniqueValuesResponse> {
  return invoke<FieldUniqueValuesResponse>("get_pivot_field_unique_values", {
    pivotId,
    fieldIndex,
  });
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