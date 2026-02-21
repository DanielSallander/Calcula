//! FILENAME: app/src/api/backend.ts
// PURPOSE: Secure abstraction layer for Tauri backend communication.
// CONTEXT: Extensions must use this API to communicate with the Rust backend.
// Direct use of @tauri-apps/api is forbidden in extensions - it bypasses the sandbox.
// This file is the ONLY place that should import from @tauri-apps/api/core.

import { invoke } from "@tauri-apps/api/core";
import type { CellData } from "../core/types";

// ============================================================================
// Types
// ============================================================================

/** Generic invoke arguments */
export type InvokeArgs = Record<string, unknown>;

// ============================================================================
// Core Invoke API
// ============================================================================

/**
 * Invoke a Tauri command with type safety.
 * This is the ONLY approved way for extensions to call the backend.
 * 
 * @param cmd - The Tauri command name
 * @param args - Optional arguments to pass to the command
 * @returns Promise resolving to the command result
 * @throws Error if the command fails
 * 
 * @example
 * ```ts
 * const result = await invokeBackend<MyResult>("my_command", { param: value });
 * ```
 */
export async function invokeBackend<T>(cmd: string, args: InvokeArgs = {}): Promise<T> {
  return invoke<T>(cmd, args);
}

// ============================================================================
// Pivot Table Commands
// ============================================================================

// Re-export pivot-specific types that extensions need
// These are defined here to keep the API surface clean

export type PivotId = number;

/**
 * Create a new pivot table.
 * @param request - The pivot table creation request
 * @returns The initial pivot view response
 */
export async function createPivotTable<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("create_pivot_table", { request });
}

/**
 * Update pivot table fields.
 * @param request - The field update request
 * @returns The updated pivot view response
 */
export async function updatePivotFields<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("update_pivot_fields", { request });
}

/**
 * Toggle a pivot group's expand/collapse state.
 * @param request - The toggle request
 * @returns The updated pivot view response
 */
export async function togglePivotGroup<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("toggle_pivot_group", { request });
}

/**
 * Get the current view of a pivot table.
 * @param pivotId - Optional pivot ID (uses active pivot if not specified)
 * @returns The current pivot view
 */
export async function getPivotView<TResponse>(
  pivotId?: PivotId
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_view", { pivotId });
}

/**
 * Delete a pivot table.
 * @param pivotId - The pivot table ID to delete
 */
export async function deletePivotTable(pivotId: PivotId): Promise<void> {
  return invoke<void>("delete_pivot_table", { pivotId });
}

/**
 * Get source data for drill-down.
 * @param pivotId - The pivot table ID
 * @param groupPath - The path identifying which cell to drill into
 * @param maxRecords - Maximum records to return
 * @returns The source data rows
 */
export async function getPivotSourceData<TResponse>(
  pivotId: PivotId,
  groupPath: Array<[number, number]>,
  maxRecords?: number
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_source_data", {
    pivotId,
    groupPath,
    maxRecords,
  });
}

/**
 * Refresh the pivot cache from current grid data.
 * @param pivotId - The pivot table ID to refresh
 * @returns The refreshed pivot view
 */
export async function refreshPivotCache<TResponse>(
  pivotId: PivotId
): Promise<TResponse> {
  return invoke<TResponse>("refresh_pivot_cache", { pivotId });
}

/**
 * Check if a cell is within a pivot table region.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns Pivot region info if cell is in a pivot, null otherwise
 */
export async function getPivotAtCell<TResponse>(
  row: number,
  col: number
): Promise<TResponse | null> {
  return invoke<TResponse | null>("get_pivot_at_cell", { row, col });
}

/**
 * Get all pivot regions for the current sheet.
 * @returns Array of pivot region data
 */
export async function getPivotRegionsForSheet<TResponse>(): Promise<TResponse[]> {
  return invoke<TResponse[]>("get_pivot_regions_for_sheet", {});
}

/**
 * Get unique values for a specific field in a pivot table.
 * @param pivotId - The pivot table ID
 * @param fieldIndex - The source field index
 * @returns The unique values response
 */
export async function getPivotFieldUniqueValues<TResponse>(
  pivotId: PivotId,
  fieldIndex: number
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_field_unique_values", {
    pivotId,
    fieldIndex,
  });
}

// ============================================================================
// New Excel-compatible Pivot Table Commands
// ============================================================================

/**
 * Get pivot table properties and info.
 */
export async function getPivotTableInfo<TResponse>(
  pivotId: PivotId
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_table_info", { pivotId });
}

/**
 * Update pivot table properties.
 */
export async function updatePivotProperties<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("update_pivot_properties", { request });
}

/**
 * Get pivot layout ranges (data body, row labels, column labels, filter axis).
 */
export async function getPivotLayoutRanges<TResponse>(
  pivotId: PivotId
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_layout_ranges", { pivotId });
}

/**
 * Update pivot layout properties.
 */
export async function updatePivotLayout<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("update_pivot_layout", { request });
}

/**
 * Get all hierarchies info for a pivot table.
 */
export async function getPivotHierarchies<TResponse>(
  pivotId: PivotId
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_hierarchies", { pivotId });
}

/**
 * Add a field to a hierarchy.
 */
export async function addPivotHierarchy<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("add_pivot_hierarchy", { request });
}

/**
 * Remove a field from a hierarchy.
 */
export async function removePivotHierarchy<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("remove_pivot_hierarchy", { request });
}

/**
 * Move a field between hierarchies.
 */
export async function movePivotField<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("move_pivot_field", { request });
}

/**
 * Set the aggregation function for a value field.
 */
export async function setPivotAggregation<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("set_pivot_aggregation", { request });
}

/**
 * Set the number format for a value field.
 */
export async function setPivotNumberFormat<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("set_pivot_number_format", { request });
}

/**
 * Apply a filter to a pivot field.
 */
export async function applyPivotFilter<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("apply_pivot_filter", { request });
}

/**
 * Clear filters from a pivot field.
 */
export async function clearPivotFilter<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("clear_pivot_filter", { request });
}

/**
 * Sort a pivot field by labels.
 */
export async function sortPivotField<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("sort_pivot_field", { request });
}

/**
 * Get pivot field info including items and filters.
 */
export async function getPivotFieldInfo<TResponse>(
  pivotId: PivotId,
  fieldIndex: number
): Promise<TResponse> {
  return invoke<TResponse>("get_pivot_field_info", { pivotId, fieldIndex });
}

/**
 * Set a pivot item's visibility.
 */
export async function setPivotItemVisibility<TRequest, TResponse>(
  request: TRequest
): Promise<TResponse> {
  return invoke<TResponse>("set_pivot_item_visibility", { request });
}

/**
 * Get a list of all pivot tables in the workbook.
 */
export async function getAllPivotTables<TResponse>(): Promise<TResponse> {
  return invoke<TResponse>("get_all_pivot_tables", {});
}

/**
 * Refresh all pivot tables in the workbook.
 */
export async function refreshAllPivotTables<TResponse>(): Promise<TResponse> {
  return invoke<TResponse>("refresh_all_pivot_tables", {});
}

// ============================================================================
// Clear Range Commands
// ============================================================================

/**
 * Clear apply to options (Excel-compatible).
 */
export type ClearApplyTo =
  | "all"
  | "contents"
  | "formats"
  | "hyperlinks"
  | "removeHyperlinks"
  | "resetContents";

/**
 * Clear a range with options for what to clear.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based, inclusive)
 * @param endCol - End column (0-based, inclusive)
 * @param applyTo - What to clear (default: "all")
 * @returns Result with count and updated cells
 */
export async function clearRangeWithOptions<TResult>(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  applyTo: ClearApplyTo = "all"
): Promise<TResult> {
  return invoke<TResult>("clear_range_with_options", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      applyTo,
    },
  });
}

// ============================================================================
// Sort Range Commands
// ============================================================================

/**
 * What to sort on.
 */
export type SortOn = "value" | "cellColor" | "fontColor" | "icon";

/**
 * Sort data option.
 */
export type SortDataOption = "normal" | "textAsNumber";

/**
 * Sort orientation.
 */
export type SortOrientation = "rows" | "columns";

/**
 * A sort field (criterion).
 */
export interface SortField {
  /** Column/row offset from start (0-based) */
  key: number;
  /** Ascending order (default: true) */
  ascending?: boolean;
  /** What to sort on (default: "value") */
  sortOn?: SortOn;
  /** Color for color-based sorting */
  color?: string;
  /** Data option (default: "normal") */
  dataOption?: SortDataOption;
  /** Subfield for rich values */
  subField?: string;
}

/**
 * Sort a range by one or more criteria.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based, inclusive)
 * @param endCol - End column (0-based, inclusive)
 * @param fields - Sort fields (at least one required)
 * @param options - Additional sort options
 * @returns Result with success status and updated cells
 */
export async function sortRange<TResult>(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  fields: SortField[],
  options?: {
    matchCase?: boolean;
    hasHeaders?: boolean;
    orientation?: SortOrientation;
  }
): Promise<TResult> {
  return invoke<TResult>("sort_range", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      fields,
      matchCase: options?.matchCase ?? false,
      hasHeaders: options?.hasHeaders ?? false,
      orientation: options?.orientation ?? "rows",
    },
  });
}

/**
 * Convenience function to sort a range by a single column.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based, inclusive)
 * @param endCol - End column (0-based, inclusive)
 * @param sortColumn - Column to sort by (0-based absolute, will be converted to relative)
 * @param ascending - Sort ascending (default: true)
 * @param hasHeaders - Has header row (default: false)
 * @returns Result with success status and updated cells
 */
export async function sortRangeByColumn<TResult>(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sortColumn: number,
  ascending: boolean = true,
  hasHeaders: boolean = false
): Promise<TResult> {
  return sortRange<TResult>(
    startRow,
    startCol,
    endRow,
    endCol,
    [{ key: sortColumn - startCol, ascending }],
    { hasHeaders }
  );
}

// ============================================================================
// AutoFilter Commands
// ============================================================================

/**
 * What aspect of the cell to filter on.
 */
export type FilterOn =
  | "values"
  | "topItems"
  | "topPercent"
  | "bottomItems"
  | "bottomPercent"
  | "cellColor"
  | "fontColor"
  | "dynamic"
  | "custom"
  | "icon";

/**
 * Dynamic filter criteria for date and average-based filtering.
 */
export type DynamicFilterCriteria =
  | "aboveAverage"
  | "belowAverage"
  | "today"
  | "tomorrow"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "nextWeek"
  | "thisMonth"
  | "lastMonth"
  | "nextMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "nextQuarter"
  | "thisYear"
  | "lastYear"
  | "nextYear"
  | "yearToDate"
  | "allDatesInPeriodJanuary"
  | "allDatesInPeriodFebruary"
  | "allDatesInPeriodMarch"
  | "allDatesInPeriodApril"
  | "allDatesInPeriodMay"
  | "allDatesInPeriodJune"
  | "allDatesInPeriodJuly"
  | "allDatesInPeriodAugust"
  | "allDatesInPeriodSeptember"
  | "allDatesInPeriodOctober"
  | "allDatesInPeriodNovember"
  | "allDatesInPeriodDecember"
  | "allDatesInPeriodQuarter1"
  | "allDatesInPeriodQuarter2"
  | "allDatesInPeriodQuarter3"
  | "allDatesInPeriodQuarter4"
  | "unknown";

/**
 * Operator for combining criterion1 and criterion2 in custom filters.
 */
export type FilterOperator = "and" | "or";

/**
 * Icon filter criteria.
 */
export interface IconFilter {
  iconSet: string;
  iconIndex: number;
}

/**
 * Filter criteria for a column.
 */
export interface FilterCriteria {
  criterion1?: string;
  criterion2?: string;
  filterOn: FilterOn;
  dynamicCriteria?: DynamicFilterCriteria;
  operator?: FilterOperator;
  color?: string;
  icon?: IconFilter;
  values: string[];
  filterOutBlanks: boolean;
}

/**
 * AutoFilter info returned from the backend.
 */
export interface AutoFilterInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  enabled: boolean;
  isDataFiltered: boolean;
  criteria: (FilterCriteria | null)[];
}

/**
 * Result of an AutoFilter operation.
 */
export interface AutoFilterResult {
  success: boolean;
  autoFilter?: AutoFilterInfo;
  error?: string;
  hiddenRows: number[];
  visibleRows: number[];
}

/**
 * Unique value with count.
 */
export interface UniqueValue {
  value: string;
  count: number;
}

/**
 * Result of getting unique values for filtering.
 */
export interface UniqueValuesResult {
  success: boolean;
  values: UniqueValue[];
  hasBlanks: boolean;
  error?: string;
}

/**
 * Apply an AutoFilter to a range.
 * @param startRow - Start row (0-based, typically header row)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based)
 * @param endCol - End column (0-based)
 * @param columnIndex - Optional column to apply filter to (relative, 0-based)
 * @param criteria - Optional filter criteria for the column
 * @returns Result with hidden/visible rows
 */
export async function applyAutoFilter(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  columnIndex?: number,
  criteria?: Partial<FilterCriteria>
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("apply_auto_filter", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      columnIndex,
      criteria: criteria
        ? {
            filterOn: criteria.filterOn ?? "values",
            criterion1: criteria.criterion1,
            criterion2: criteria.criterion2,
            dynamicCriteria: criteria.dynamicCriteria,
            operator: criteria.operator,
            color: criteria.color,
            icon: criteria.icon,
            values: criteria.values ?? [],
            filterOutBlanks: criteria.filterOutBlanks ?? false,
          }
        : undefined,
    },
  });
}

/**
 * Clear filter criteria for a specific column.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @returns Result with updated hidden/visible rows
 */
export async function clearColumnCriteria(
  columnIndex: number
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("clear_column_criteria", { columnIndex });
}

/**
 * Clear all filter criteria but keep the AutoFilter range.
 * @returns Result with all rows now visible
 */
export async function clearAutoFilterCriteria(): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("clear_auto_filter_criteria", {});
}

/**
 * Reapply the AutoFilter (refresh filtering with current data).
 * @returns Result with updated hidden/visible rows
 */
export async function reapplyAutoFilter(): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("reapply_auto_filter", {});
}

/**
 * Remove the AutoFilter from the sheet entirely.
 * @returns Result with all rows now visible
 */
export async function removeAutoFilter(): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("remove_auto_filter", {});
}

/**
 * Get the current AutoFilter for the active sheet.
 * @returns AutoFilter info or null if none exists
 */
export async function getAutoFilter(): Promise<AutoFilterInfo | null> {
  return invoke<AutoFilterInfo | null>("get_auto_filter", {});
}

/**
 * Get the AutoFilter range for the active sheet.
 * @returns Tuple [startRow, startCol, endRow, endCol] or null if no AutoFilter
 */
export async function getAutoFilterRange(): Promise<
  [number, number, number, number] | null
> {
  return invoke<[number, number, number, number] | null>(
    "get_auto_filter_range",
    {}
  );
}

/**
 * Get all hidden (filtered) rows for the active sheet.
 * @returns Array of hidden row indices
 */
export async function getHiddenRows(): Promise<number[]> {
  return invoke<number[]>("get_hidden_rows", {});
}

/**
 * Check if a specific row is hidden by the AutoFilter.
 * @param row - Row index (0-based)
 * @returns true if row is filtered/hidden
 */
export async function isRowFiltered(row: number): Promise<boolean> {
  return invoke<boolean>("is_row_filtered", { row });
}

/**
 * Get unique values for a column in the AutoFilter range.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @returns Unique values with counts
 */
export async function getFilterUniqueValues(
  columnIndex: number
): Promise<UniqueValuesResult> {
  return invoke<UniqueValuesResult>("get_filter_unique_values", { columnIndex });
}

/**
 * Set filter criteria for a column using value selection.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @param values - Values to include in filter
 * @param includeBlanks - Whether to include blank cells
 * @returns Result with updated hidden/visible rows
 */
export async function setColumnFilterValues(
  columnIndex: number,
  values: string[],
  includeBlanks: boolean = false
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("set_column_filter_values", {
    columnIndex,
    values,
    includeBlanks,
  });
}

/**
 * Set a custom filter for a column.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @param criterion1 - First criterion (e.g., ">=100", "=*text*")
 * @param criterion2 - Optional second criterion
 * @param operator - Operator to combine criteria ("and" or "or")
 * @returns Result with updated hidden/visible rows
 */
export async function setColumnCustomFilter(
  columnIndex: number,
  criterion1: string,
  criterion2?: string,
  operator?: FilterOperator
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("set_column_custom_filter", {
    columnIndex,
    criterion1,
    criterion2,
    operator,
  });
}

/**
 * Set a top/bottom filter for a column.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @param filterOn - Filter type ("topItems", "topPercent", "bottomItems", "bottomPercent")
 * @param value - Number of items or percentage
 * @returns Result with updated hidden/visible rows
 */
export async function setColumnTopBottomFilter(
  columnIndex: number,
  filterOn: "topItems" | "topPercent" | "bottomItems" | "bottomPercent",
  value: number
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("set_column_top_bottom_filter", {
    columnIndex,
    filterOn,
    value,
  });
}

/**
 * Set a dynamic filter for a column.
 * @param columnIndex - Column index (relative to AutoFilter range, 0-based)
 * @param dynamicCriteria - Dynamic filter type (e.g., "aboveAverage", "today")
 * @returns Result with updated hidden/visible rows
 */
export async function setColumnDynamicFilter(
  columnIndex: number,
  dynamicCriteria: DynamicFilterCriteria
): Promise<AutoFilterResult> {
  return invoke<AutoFilterResult>("set_column_dynamic_filter", {
    columnIndex,
    dynamicCriteria,
  });
}

// ============================================================================
// Hyperlink Commands
// ============================================================================

/**
 * The type of hyperlink target.
 */
export type HyperlinkType = "url" | "file" | "internalReference" | "email";

/**
 * Internal reference details for sheet/cell navigation.
 */
export interface InternalReference {
  sheetName?: string;
  cellReference: string;
}

/**
 * A hyperlink attached to a cell.
 */
export interface Hyperlink {
  row: number;
  col: number;
  sheetIndex: number;
  linkType: HyperlinkType;
  target: string;
  internalRef?: InternalReference;
  displayText?: string;
  tooltip?: string;
}

/**
 * Result of a hyperlink operation.
 */
export interface HyperlinkResult {
  success: boolean;
  hyperlink?: Hyperlink;
  error?: string;
}

/**
 * Indicator for cells with hyperlinks (for rendering).
 */
export interface HyperlinkIndicator {
  row: number;
  col: number;
  linkType: HyperlinkType;
  tooltip?: string;
}

/**
 * Parameters for adding a hyperlink.
 */
export interface AddHyperlinkParams {
  row: number;
  col: number;
  linkType: HyperlinkType;
  target: string;
  displayText?: string;
  tooltip?: string;
  sheetName?: string;
  cellReference?: string;
  emailSubject?: string;
}

/**
 * Parameters for updating a hyperlink.
 */
export interface UpdateHyperlinkParams {
  row: number;
  col: number;
  target?: string;
  displayText?: string;
  tooltip?: string;
}

/**
 * Add a hyperlink to a cell.
 * @param params - Hyperlink parameters
 * @returns Result with the created hyperlink
 */
export async function addHyperlink(
  params: AddHyperlinkParams
): Promise<HyperlinkResult> {
  return invoke<HyperlinkResult>("add_hyperlink", { params });
}

/**
 * Update an existing hyperlink.
 * @param params - Update parameters
 * @returns Result with the updated hyperlink
 */
export async function updateHyperlink(
  params: UpdateHyperlinkParams
): Promise<HyperlinkResult> {
  return invoke<HyperlinkResult>("update_hyperlink", { params });
}

/**
 * Remove a hyperlink from a cell.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns Result with the removed hyperlink
 */
export async function removeHyperlink(
  row: number,
  col: number
): Promise<HyperlinkResult> {
  return invoke<HyperlinkResult>("remove_hyperlink", { row, col });
}

/**
 * Get hyperlink at a specific cell.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns The hyperlink or null if none exists
 */
export async function getHyperlink(
  row: number,
  col: number
): Promise<Hyperlink | null> {
  return invoke<Hyperlink | null>("get_hyperlink", { row, col });
}

/**
 * Get all hyperlinks in the current sheet.
 * @returns Array of hyperlinks
 */
export async function getAllHyperlinks(): Promise<Hyperlink[]> {
  return invoke<Hyperlink[]>("get_all_hyperlinks", {});
}

/**
 * Get hyperlink indicators for rendering.
 * @returns Array of indicators showing which cells have hyperlinks
 */
export async function getHyperlinkIndicators(): Promise<HyperlinkIndicator[]> {
  return invoke<HyperlinkIndicator[]>("get_hyperlink_indicators", {});
}

/**
 * Get hyperlinks within a specific range.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based)
 * @param endCol - End column (0-based)
 * @returns Array of hyperlink indicators in the range
 */
export async function getHyperlinksInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<HyperlinkIndicator[]> {
  return invoke<HyperlinkIndicator[]>("get_hyperlinks_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Check if a cell has a hyperlink.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns true if the cell has a hyperlink
 */
export async function hasHyperlink(row: number, col: number): Promise<boolean> {
  return invoke<boolean>("has_hyperlink", { row, col });
}

/**
 * Clear all hyperlinks in a range.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based)
 * @param endCol - End column (0-based)
 * @returns Number of hyperlinks removed
 */
export async function clearHyperlinksInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  return invoke<number>("clear_hyperlinks_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Move a hyperlink from one cell to another.
 * @param fromRow - Source row (0-based)
 * @param fromCol - Source column (0-based)
 * @param toRow - Destination row (0-based)
 * @param toCol - Destination column (0-based)
 * @returns Result with the moved hyperlink
 */
export async function moveHyperlink(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number
): Promise<HyperlinkResult> {
  return invoke<HyperlinkResult>("move_hyperlink", {
    fromRow,
    fromCol,
    toRow,
    toCol,
  });
}

// ============================================================================
// Protection Commands
// ============================================================================

/**
 * Sheet protection options - what users can do when sheet is protected.
 */
export interface SheetProtectionOptions {
  allowSelectLockedCells: boolean;
  allowSelectUnlockedCells: boolean;
  allowFormatCells: boolean;
  allowFormatColumns: boolean;
  allowFormatRows: boolean;
  allowInsertColumns: boolean;
  allowInsertRows: boolean;
  allowInsertHyperlinks: boolean;
  allowDeleteColumns: boolean;
  allowDeleteRows: boolean;
  allowSort: boolean;
  allowAutoFilter: boolean;
  allowPivotTables: boolean;
  allowEditObjects: boolean;
  allowEditScenarios: boolean;
}

/**
 * Default protection options.
 */
export const DEFAULT_PROTECTION_OPTIONS: SheetProtectionOptions = {
  allowSelectLockedCells: true,
  allowSelectUnlockedCells: true,
  allowFormatCells: false,
  allowFormatColumns: false,
  allowFormatRows: false,
  allowInsertColumns: false,
  allowInsertRows: false,
  allowInsertHyperlinks: false,
  allowDeleteColumns: false,
  allowDeleteRows: false,
  allowSort: false,
  allowAutoFilter: false,
  allowPivotTables: false,
  allowEditObjects: false,
  allowEditScenarios: false,
};

/**
 * A range that can be edited even when the sheet is protected.
 */
export interface AllowEditRange {
  title: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  passwordHash?: string;
  passwordSalt?: string;
}

/**
 * Sheet-level protection settings.
 */
export interface SheetProtection {
  protected: boolean;
  passwordHash?: string;
  passwordSalt?: string;
  options: SheetProtectionOptions;
  allowEditRanges: AllowEditRange[];
}

/**
 * Cell-level protection properties.
 */
export interface CellProtection {
  locked: boolean;
  formulaHidden: boolean;
}

/**
 * Default cell protection (locked, formula visible).
 */
export const DEFAULT_CELL_PROTECTION: CellProtection = {
  locked: true,
  formulaHidden: false,
};

/**
 * Result of a protection operation.
 */
export interface ProtectionResult {
  success: boolean;
  protection?: SheetProtection;
  error?: string;
}

/**
 * Result of checking if an action can be performed.
 */
export interface ProtectionCheckResult {
  canEdit: boolean;
  reason?: string;
}

/**
 * Protection status summary.
 */
export interface ProtectionStatus {
  isProtected: boolean;
  hasPassword: boolean;
  options: SheetProtectionOptions;
  allowEditRangeCount: number;
}

/**
 * Parameters for protecting a sheet.
 */
export interface ProtectSheetParams {
  password?: string;
  options?: SheetProtectionOptions;
}

/**
 * Parameters for adding an allow-edit range.
 */
export interface AddAllowEditRangeParams {
  title: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  password?: string;
}

/**
 * Parameters for setting cell protection.
 */
export interface SetCellProtectionParams {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  locked?: boolean;
  formulaHidden?: boolean;
}

/**
 * Protect the current sheet.
 * @param params - Protection parameters
 * @returns Result with the protection settings
 */
export async function protectSheet(
  params: ProtectSheetParams = {}
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("protect_sheet", { params });
}

/**
 * Unprotect the current sheet.
 * @param password - Password if the sheet is password-protected
 * @returns Result with the updated protection settings
 */
export async function unprotectSheet(
  password?: string
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("unprotect_sheet", { password });
}

/**
 * Update protection options for the current sheet.
 * @param options - New protection options
 * @returns Result with the updated protection settings
 */
export async function updateProtectionOptions(
  options: SheetProtectionOptions
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("update_protection_options", { options });
}

/**
 * Add an allow-edit range to the current sheet.
 * @param params - Range parameters
 * @returns Result with the updated protection settings
 */
export async function addAllowEditRange(
  params: AddAllowEditRangeParams
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("add_allow_edit_range", { params });
}

/**
 * Remove an allow-edit range by title.
 * @param title - Title of the range to remove
 * @returns Result with the updated protection settings
 */
export async function removeAllowEditRange(
  title: string
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("remove_allow_edit_range", { title });
}

/**
 * Get all allow-edit ranges for the current sheet.
 * @returns Array of allow-edit ranges
 */
export async function getAllowEditRanges(): Promise<AllowEditRange[]> {
  return invoke<AllowEditRange[]>("get_allow_edit_ranges", {});
}

/**
 * Get protection status for the current sheet.
 * @returns Protection status summary
 */
export async function getProtectionStatus(): Promise<ProtectionStatus> {
  return invoke<ProtectionStatus>("get_protection_status", {});
}

/**
 * Check if the current sheet is protected.
 * @returns true if the sheet is protected
 */
export async function isSheetProtected(): Promise<boolean> {
  return invoke<boolean>("is_sheet_protected", {});
}

/**
 * Check if a specific cell can be edited.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns Check result with reason if blocked
 */
export async function canEditCell(
  row: number,
  col: number
): Promise<ProtectionCheckResult> {
  return invoke<ProtectionCheckResult>("can_edit_cell", { row, col });
}

/**
 * Check if a specific action can be performed.
 * @param action - Action name (e.g., "formatCells", "insertRows")
 * @returns Check result with reason if blocked
 */
export async function canPerformAction(
  action: string
): Promise<ProtectionCheckResult> {
  return invoke<ProtectionCheckResult>("can_perform_action", { action });
}

/**
 * Set cell protection for a range.
 * @param params - Cell protection parameters
 * @returns Result
 */
export async function setCellProtection(
  params: SetCellProtectionParams
): Promise<ProtectionResult> {
  return invoke<ProtectionResult>("set_cell_protection", { params });
}

/**
 * Get cell protection for a specific cell.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns Cell protection settings
 */
export async function getCellProtection(
  row: number,
  col: number
): Promise<CellProtection> {
  return invoke<CellProtection>("get_cell_protection", { row, col });
}

/**
 * Verify password for an allow-edit range.
 * @param title - Range title
 * @param password - Password to verify
 * @returns true if password is correct
 */
export async function verifyEditRangePassword(
  title: string,
  password: string
): Promise<boolean> {
  return invoke<boolean>("verify_edit_range_password", { title, password });
}

// ============================================================================
// Workbook Protection Commands
// ============================================================================

/**
 * Workbook protection status summary.
 */
export interface WorkbookProtectionStatus {
  isProtected: boolean;
  hasPassword: boolean;
}

/**
 * Result of a workbook protection operation.
 */
export interface WorkbookProtectionResult {
  success: boolean;
  error?: string;
}

/**
 * Protect the workbook structure (prevent adding/deleting/renaming/moving sheets).
 * @param password - Optional password for protection
 * @returns Result of the operation
 */
export async function protectWorkbook(
  password?: string
): Promise<WorkbookProtectionResult> {
  return invoke<WorkbookProtectionResult>("protect_workbook", { password });
}

/**
 * Unprotect the workbook structure.
 * @param password - Password if the workbook is password-protected
 * @returns Result of the operation
 */
export async function unprotectWorkbook(
  password?: string
): Promise<WorkbookProtectionResult> {
  return invoke<WorkbookProtectionResult>("unprotect_workbook", { password });
}

/**
 * Check if the workbook is protected.
 * @returns true if the workbook structure is protected
 */
export async function isWorkbookProtected(): Promise<boolean> {
  return invoke<boolean>("is_workbook_protected", {});
}

/**
 * Get workbook protection status.
 * @returns Workbook protection status summary
 */
export async function getWorkbookProtectionStatus(): Promise<WorkbookProtectionStatus> {
  return invoke<WorkbookProtectionStatus>("get_workbook_protection_status", {});
}

// ============================================================================
// Grouping (Outline) Commands
// ============================================================================

/**
 * Maximum outline level (Excel limit is 8).
 */
export const MAX_OUTLINE_LEVEL = 8;

/**
 * Position of summary row/column relative to detail.
 */
export type SummaryPosition = "belowRight" | "aboveLeft";

/**
 * Outline settings for a sheet.
 */
export interface OutlineSettings {
  summaryRowPosition: SummaryPosition;
  summaryColPosition: SummaryPosition;
  showOutlineSymbols: boolean;
  autoStyles: boolean;
}

/**
 * Default outline settings.
 */
export const DEFAULT_OUTLINE_SETTINGS: OutlineSettings = {
  summaryRowPosition: "belowRight",
  summaryColPosition: "belowRight",
  showOutlineSymbols: true,
  autoStyles: false,
};

/**
 * A row group (horizontal outline).
 */
export interface RowGroup {
  startRow: number;
  endRow: number;
  level: number;
  collapsed: boolean;
}

/**
 * A column group (vertical outline).
 */
export interface ColumnGroup {
  startCol: number;
  endCol: number;
  level: number;
  collapsed: boolean;
}

/**
 * Complete outline data for a sheet.
 */
export interface SheetOutline {
  rowGroups: RowGroup[];
  columnGroups: ColumnGroup[];
  settings: OutlineSettings;
  maxRowLevel: number;
  maxColLevel: number;
}

/**
 * Result of a grouping operation.
 */
export interface GroupResult {
  success: boolean;
  outline?: SheetOutline;
  error?: string;
  hiddenRowsChanged: number[];
  hiddenColsChanged: number[];
}

/**
 * Row outline symbol for rendering.
 */
export interface RowOutlineSymbol {
  row: number;
  level: number;
  isCollapsed: boolean;
  isButtonRow: boolean;
  isHidden: boolean;
}

/**
 * Column outline symbol for rendering.
 */
export interface ColOutlineSymbol {
  col: number;
  level: number;
  isCollapsed: boolean;
  isButtonCol: boolean;
  isHidden: boolean;
}

/**
 * Complete outline info for a viewport.
 */
export interface OutlineInfo {
  rowSymbols: RowOutlineSymbol[];
  colSymbols: ColOutlineSymbol[];
  maxRowLevel: number;
  maxColLevel: number;
  settings: OutlineSettings;
}

/**
 * Parameters for grouping rows.
 */
export interface GroupRowsParams {
  startRow: number;
  endRow: number;
}

/**
 * Parameters for grouping columns.
 */
export interface GroupColumnsParams {
  startCol: number;
  endCol: number;
}

/**
 * Group rows (create or increment outline level).
 * @param params - Row range parameters
 * @returns Result with the updated outline
 */
export async function groupRows(params: GroupRowsParams): Promise<GroupResult> {
  return invoke<GroupResult>("group_rows", { params });
}

/**
 * Ungroup rows (remove or decrement outline level).
 * @param startRow - Start row (0-based)
 * @param endRow - End row (0-based)
 * @returns Result with the updated outline
 */
export async function ungroupRows(
  startRow: number,
  endRow: number
): Promise<GroupResult> {
  return invoke<GroupResult>("ungroup_rows", { startRow, endRow });
}

/**
 * Group columns (create or increment outline level).
 * @param params - Column range parameters
 * @returns Result with the updated outline
 */
export async function groupColumns(
  params: GroupColumnsParams
): Promise<GroupResult> {
  return invoke<GroupResult>("group_columns", { params });
}

/**
 * Ungroup columns (remove or decrement outline level).
 * @param startCol - Start column (0-based)
 * @param endCol - End column (0-based)
 * @returns Result with the updated outline
 */
export async function ungroupColumns(
  startCol: number,
  endCol: number
): Promise<GroupResult> {
  return invoke<GroupResult>("ungroup_columns", { startCol, endCol });
}

/**
 * Collapse a row group.
 * @param row - Row within the group to collapse
 * @returns Result with hidden rows
 */
export async function collapseRowGroup(row: number): Promise<GroupResult> {
  return invoke<GroupResult>("collapse_row_group", { row });
}

/**
 * Expand a row group.
 * @param row - Row within the group to expand
 * @returns Result with visible rows
 */
export async function expandRowGroup(row: number): Promise<GroupResult> {
  return invoke<GroupResult>("expand_row_group", { row });
}

/**
 * Collapse a column group.
 * @param col - Column within the group to collapse
 * @returns Result with hidden columns
 */
export async function collapseColumnGroup(col: number): Promise<GroupResult> {
  return invoke<GroupResult>("collapse_column_group", { col });
}

/**
 * Expand a column group.
 * @param col - Column within the group to expand
 * @returns Result with visible columns
 */
export async function expandColumnGroup(col: number): Promise<GroupResult> {
  return invoke<GroupResult>("expand_column_group", { col });
}

/**
 * Show/hide rows and columns up to a specific outline level.
 * @param rowLevel - Row level to show (undefined = don't change)
 * @param colLevel - Column level to show (undefined = don't change)
 * @returns Result with hidden rows/columns changes
 */
export async function showOutlineLevel(
  rowLevel?: number,
  colLevel?: number
): Promise<GroupResult> {
  return invoke<GroupResult>("show_outline_level", { rowLevel, colLevel });
}

/**
 * Get outline info for a viewport.
 * @param startRow - Start row
 * @param endRow - End row
 * @param startCol - Start column
 * @param endCol - End column
 * @returns Outline info for the viewport
 */
export async function getOutlineInfo(
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number
): Promise<OutlineInfo> {
  return invoke<OutlineInfo>("get_outline_info", {
    startRow,
    endRow,
    startCol,
    endCol,
  });
}

/**
 * Get outline settings for the current sheet.
 * @returns Outline settings
 */
export async function getOutlineSettings(): Promise<OutlineSettings> {
  return invoke<OutlineSettings>("get_outline_settings", {});
}

/**
 * Set outline settings for the current sheet.
 * @param settings - New outline settings
 * @returns Result with the updated outline
 */
export async function setOutlineSettings(
  settings: OutlineSettings
): Promise<GroupResult> {
  return invoke<GroupResult>("set_outline_settings", { settings });
}

/**
 * Clear all outline/grouping for the current sheet.
 * @returns Result with previously hidden rows/columns
 */
export async function clearOutline(): Promise<GroupResult> {
  return invoke<GroupResult>("clear_outline", {});
}

/**
 * Check if a row is hidden due to grouping.
 * @param row - Row index (0-based)
 * @returns true if row is hidden
 */
export async function isRowHiddenByGroup(row: number): Promise<boolean> {
  return invoke<boolean>("is_row_hidden_by_group", { row });
}

/**
 * Check if a column is hidden due to grouping.
 * @param col - Column index (0-based)
 * @returns true if column is hidden
 */
export async function isColHiddenByGroup(col: number): Promise<boolean> {
  return invoke<boolean>("is_col_hidden_by_group", { col });
}

/**
 * Get all hidden rows due to grouping.
 * @returns Array of hidden row indices
 */
export async function getHiddenRowsByGroup(): Promise<number[]> {
  return invoke<number[]>("get_hidden_rows_by_group", {});
}

/**
 * Get all hidden columns due to grouping.
 * @returns Array of hidden column indices
 */
export async function getHiddenColsByGroup(): Promise<number[]> {
  return invoke<number[]>("get_hidden_cols_by_group", {});
}

// ============================================================================
// Conditional Formatting Commands
// ============================================================================

/**
 * How to interpret the value for color scales, data bars, icon sets.
 */
export type CFValueType =
  | "number"
  | "percent"
  | "formula"
  | "percentile"
  | "min"
  | "max"
  | "autoMin"
  | "autoMax";

/**
 * A point in a color scale.
 */
export interface ColorScalePoint {
  valueType: CFValueType;
  value?: number;
  formula?: string;
  color: string;
}

/**
 * Color scale rule (2 or 3 color).
 */
export interface ColorScaleRule {
  type: "colorScale";
  minPoint: ColorScalePoint;
  midPoint?: ColorScalePoint;
  maxPoint: ColorScalePoint;
}

/**
 * Data bar direction.
 */
export type DataBarDirection = "context" | "leftToRight" | "rightToLeft";

/**
 * Data bar axis position.
 */
export type DataBarAxisPosition = "automatic" | "cellMidpoint" | "none";

/**
 * Data bar rule.
 */
export interface DataBarRule {
  type: "dataBar";
  minValueType: CFValueType;
  minValue?: number;
  maxValueType: CFValueType;
  maxValue?: number;
  fillColor: string;
  borderColor?: string;
  negativeFillColor?: string;
  negativeBorderColor?: string;
  axisColor?: string;
  axisPosition: DataBarAxisPosition;
  direction: DataBarDirection;
  showValue: boolean;
  gradientFill: boolean;
}

/**
 * Icon set types.
 */
export type IconSetType =
  | "threeArrows"
  | "threeArrowsGray"
  | "threeFlags"
  | "threeTrafficLights1"
  | "threeTrafficLights2"
  | "threeSigns"
  | "threeSymbols"
  | "threeSymbols2"
  | "threeStars"
  | "threeTriangles"
  | "fourArrows"
  | "fourArrowsGray"
  | "fourRating"
  | "fourTrafficLights"
  | "fourRedToBlack"
  | "fiveArrows"
  | "fiveArrowsGray"
  | "fiveRating"
  | "fiveQuarters"
  | "fiveBoxes";

/**
 * Threshold operator for icon sets.
 */
export type ThresholdOperator = "greaterThan" | "greaterThanOrEqual";

/**
 * Icon set threshold.
 */
export interface IconSetThreshold {
  valueType: CFValueType;
  value: number;
  operator: ThresholdOperator;
}

/**
 * Icon set rule.
 */
export interface IconSetRule {
  type: "iconSet";
  iconSet: IconSetType;
  thresholds: IconSetThreshold[];
  reverseIcons: boolean;
  showIconOnly: boolean;
}

/**
 * Cell value comparison operator.
 */
export type CellValueOperator =
  | "equal"
  | "notEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "between"
  | "notBetween";

/**
 * Cell value rule.
 */
export interface CellValueRule {
  type: "cellValue";
  operator: CellValueOperator;
  value1: string;
  value2?: string;
}

/**
 * Text rule type.
 */
export type TextRuleType = "contains" | "notContains" | "beginsWith" | "endsWith";

/**
 * Contains text rule.
 */
export interface ContainsTextRule {
  type: "containsText";
  ruleType: TextRuleType;
  text: string;
}

/**
 * Top/bottom rule type.
 */
export type TopBottomType = "topItems" | "topPercent" | "bottomItems" | "bottomPercent";

/**
 * Top/bottom rule.
 */
export interface TopBottomRule {
  type: "topBottom";
  ruleType: TopBottomType;
  rank: number;
}

/**
 * Above/below average rule type.
 */
export type AverageRuleType =
  | "aboveAverage"
  | "belowAverage"
  | "equalOrAboveAverage"
  | "equalOrBelowAverage"
  | "oneStdDevAbove"
  | "oneStdDevBelow"
  | "twoStdDevAbove"
  | "twoStdDevBelow"
  | "threeStdDevAbove"
  | "threeStdDevBelow";

/**
 * Above/below average rule.
 */
export interface AboveAverageRule {
  type: "aboveAverage";
  ruleType: AverageRuleType;
}

/**
 * Time period for date-based rules.
 */
export type TimePeriod =
  | "today"
  | "yesterday"
  | "tomorrow"
  | "last7Days"
  | "thisWeek"
  | "lastWeek"
  | "nextWeek"
  | "thisMonth"
  | "lastMonth"
  | "nextMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "nextQuarter"
  | "thisYear"
  | "lastYear"
  | "nextYear";

/**
 * Time period rule.
 */
export interface TimePeriodRule {
  type: "timePeriod";
  period: TimePeriod;
}

/**
 * Expression/formula rule.
 */
export interface ExpressionRule {
  type: "expression";
  formula: string;
}

/**
 * Simple rules without parameters.
 */
export interface DuplicateValuesRule {
  type: "duplicateValues";
}

export interface UniqueValuesRule {
  type: "uniqueValues";
}

export interface BlankCellsRule {
  type: "blankCells";
}

export interface NoBlanksRule {
  type: "noBlanks";
}

export interface ErrorCellsRule {
  type: "errorCells";
}

export interface NoErrorsRule {
  type: "noErrors";
}

/**
 * All conditional format rule types.
 */
export type ConditionalFormatRule =
  | ColorScaleRule
  | DataBarRule
  | IconSetRule
  | CellValueRule
  | ContainsTextRule
  | TopBottomRule
  | AboveAverageRule
  | TimePeriodRule
  | ExpressionRule
  | DuplicateValuesRule
  | UniqueValuesRule
  | BlankCellsRule
  | NoBlanksRule
  | ErrorCellsRule
  | NoErrorsRule;

/**
 * The format/style to apply when a rule matches.
 */
export interface ConditionalFormat {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  numberFormat?: string;
}

/**
 * A range where conditional formatting applies.
 */
export interface ConditionalFormatRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * A complete conditional format definition.
 */
export interface ConditionalFormatDefinition {
  id: number;
  priority: number;
  rule: ConditionalFormatRule;
  format: ConditionalFormat;
  ranges: ConditionalFormatRange[];
  stopIfTrue: boolean;
  enabled: boolean;
}

/**
 * Result of a conditional formatting operation.
 */
export interface CFResult {
  success: boolean;
  rule?: ConditionalFormatDefinition;
  error?: string;
}

/**
 * Evaluated conditional format for a cell.
 */
export interface CellConditionalFormat {
  row: number;
  col: number;
  format: ConditionalFormat;
  dataBarPercent?: number;
  iconIndex?: number;
  colorScaleColor?: string;
}

/**
 * Result of evaluating conditional formats for a range.
 */
export interface EvaluateCFResult {
  cells: CellConditionalFormat[];
}

/**
 * Parameters for adding a conditional format.
 */
export interface AddCFParams {
  rule: ConditionalFormatRule;
  format: ConditionalFormat;
  ranges: ConditionalFormatRange[];
  stopIfTrue?: boolean;
}

/**
 * Parameters for updating a conditional format.
 */
export interface UpdateCFParams {
  ruleId: number;
  rule?: ConditionalFormatRule;
  format?: ConditionalFormat;
  ranges?: ConditionalFormatRange[];
  stopIfTrue?: boolean;
  enabled?: boolean;
}

/**
 * Add a conditional format rule.
 * @param params - Rule parameters
 * @returns Result with the created rule
 */
export async function addConditionalFormat(
  params: AddCFParams
): Promise<CFResult> {
  return invoke<CFResult>("add_conditional_format", { params });
}

/**
 * Update a conditional format rule.
 * @param params - Update parameters
 * @returns Result with the updated rule
 */
export async function updateConditionalFormat(
  params: UpdateCFParams
): Promise<CFResult> {
  return invoke<CFResult>("update_conditional_format", { params });
}

/**
 * Delete a conditional format rule.
 * @param ruleId - ID of the rule to delete
 * @returns Result
 */
export async function deleteConditionalFormat(
  ruleId: number
): Promise<CFResult> {
  return invoke<CFResult>("delete_conditional_format", { ruleId });
}

/**
 * Reorder conditional format rules.
 * @param ruleIds - Rule IDs in new priority order
 * @returns Result
 */
export async function reorderConditionalFormats(
  ruleIds: number[]
): Promise<CFResult> {
  return invoke<CFResult>("reorder_conditional_formats", { ruleIds });
}

/**
 * Get a specific conditional format rule.
 * @param ruleId - ID of the rule
 * @returns The rule or null if not found
 */
export async function getConditionalFormat(
  ruleId: number
): Promise<ConditionalFormatDefinition | null> {
  return invoke<ConditionalFormatDefinition | null>("get_conditional_format", {
    ruleId,
  });
}

/**
 * Get all conditional format rules for the current sheet.
 * @returns Array of rules sorted by priority
 */
export async function getAllConditionalFormats(): Promise<
  ConditionalFormatDefinition[]
> {
  return invoke<ConditionalFormatDefinition[]>("get_all_conditional_formats", {});
}

/**
 * Evaluate conditional formats for a range.
 * Returns computed styles for each cell in the range.
 * @param startRow - Start row
 * @param startCol - Start column
 * @param endRow - End row
 * @param endCol - End column
 * @returns Evaluated formats for cells in range
 */
export async function evaluateConditionalFormats(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<EvaluateCFResult> {
  return invoke<EvaluateCFResult>("evaluate_conditional_formats", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Clear conditional formats in a range.
 * @param startRow - Start row
 * @param startCol - Start column
 * @param endRow - End row
 * @param endCol - End column
 * @returns Number of rules removed
 */
export async function clearConditionalFormatsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  return invoke<number>("clear_conditional_formats_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

// ============================================================================
// Table Commands
// ============================================================================

/**
 * Function to use in a table's totals row.
 */
export type TotalsRowFunction =
  | "none"
  | "average"
  | "count"
  | "countNumbers"
  | "max"
  | "min"
  | "sum"
  | "stdDev"
  | "var"
  | "custom";

/**
 * Style options for table formatting.
 */
export interface TableStyleOptions {
  bandedRows: boolean;
  bandedColumns: boolean;
  headerRow: boolean;
  totalRow: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  showFilterButton: boolean;
}

/**
 * Default table style options.
 */
export const DEFAULT_TABLE_STYLE_OPTIONS: TableStyleOptions = {
  bandedRows: true,
  bandedColumns: false,
  headerRow: true,
  totalRow: false,
  firstColumn: false,
  lastColumn: false,
  showFilterButton: true,
};

/**
 * A column in a table.
 */
export interface TableColumn {
  id: number;
  name: string;
  totalsRowFunction: TotalsRowFunction;
  totalsRowFormula?: string;
  calculatedFormula?: string;
}

/**
 * A table definition.
 */
export interface Table {
  id: number;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: TableColumn[];
  styleOptions: TableStyleOptions;
  styleName: string;
  autoFilterId?: number;
}

/**
 * Result of a table operation.
 */
export interface TableResult {
  success: boolean;
  table?: Table;
  error?: string;
}

/**
 * Resolved structured reference.
 */
export interface ResolvedStructuredRef {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Result of resolving a structured reference.
 */
export interface StructuredRefResult {
  success: boolean;
  resolved?: ResolvedStructuredRef;
  error?: string;
}

/**
 * Parameters for creating a table.
 */
export interface CreateTableParams {
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  hasHeaders?: boolean;
  styleOptions?: TableStyleOptions;
  styleName?: string;
}

/**
 * Parameters for resizing a table.
 */
export interface ResizeTableParams {
  tableId: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Parameters for updating table style.
 */
export interface UpdateTableStyleParams {
  tableId: number;
  styleOptions?: TableStyleOptions;
  styleName?: string;
}

/**
 * Parameters for setting totals row function.
 */
export interface SetTotalsRowFunctionParams {
  tableId: number;
  columnName: string;
  function: TotalsRowFunction;
  customFormula?: string;
}

/**
 * Create a new table.
 * @param params - Table creation parameters
 * @returns Result with the created table
 */
export async function createTable(params: CreateTableParams): Promise<TableResult> {
  return invoke<TableResult>("create_table", { params });
}

/**
 * Delete a table.
 * @param tableId - ID of the table to delete
 * @returns Result
 */
export async function deleteTable(tableId: number): Promise<TableResult> {
  return invoke<TableResult>("delete_table", { tableId });
}

/**
 * Rename a table.
 * @param tableId - ID of the table
 * @param newName - New table name
 * @returns Result with the updated table
 */
export async function renameTable(
  tableId: number,
  newName: string
): Promise<TableResult> {
  return invoke<TableResult>("rename_table", { tableId, newName });
}

/**
 * Update table style options.
 * @param params - Style update parameters
 * @returns Result with the updated table
 */
export async function updateTableStyle(
  params: UpdateTableStyleParams
): Promise<TableResult> {
  return invoke<TableResult>("update_table_style", { params });
}

/**
 * Add a column to a table.
 * @param tableId - ID of the table
 * @param columnName - Name of the new column
 * @param position - Optional position (0-based), defaults to end
 * @returns Result with the updated table
 */
export async function addTableColumn(
  tableId: number,
  columnName: string,
  position?: number
): Promise<TableResult> {
  return invoke<TableResult>("add_table_column", { tableId, columnName, position });
}

/**
 * Remove a column from a table.
 * @param tableId - ID of the table
 * @param columnName - Name of the column to remove
 * @returns Result with the updated table
 */
export async function removeTableColumn(
  tableId: number,
  columnName: string
): Promise<TableResult> {
  return invoke<TableResult>("remove_table_column", { tableId, columnName });
}

/**
 * Rename a table column.
 * @param tableId - ID of the table
 * @param oldName - Current column name
 * @param newName - New column name
 * @returns Result with the updated table
 */
export async function renameTableColumn(
  tableId: number,
  oldName: string,
  newName: string
): Promise<TableResult> {
  return invoke<TableResult>("rename_table_column", { tableId, oldName, newName });
}

/**
 * Set totals row function for a column.
 * @param params - Function parameters
 * @returns Result with the updated table
 */
export async function setTotalsRowFunction(
  params: SetTotalsRowFunctionParams
): Promise<TableResult> {
  return invoke<TableResult>("set_totals_row_function", { params });
}

/**
 * Toggle totals row visibility.
 * @param tableId - ID of the table
 * @param show - Whether to show the totals row
 * @returns Result with the updated table
 */
export async function toggleTotalsRow(
  tableId: number,
  show: boolean
): Promise<TableResult> {
  return invoke<TableResult>("toggle_totals_row", { tableId, show });
}

/**
 * Resize a table.
 * @param params - Resize parameters
 * @returns Result with the updated table
 */
export async function resizeTable(params: ResizeTableParams): Promise<TableResult> {
  return invoke<TableResult>("resize_table", { params });
}

/**
 * Convert a table to a range (removes table but keeps data).
 * @param tableId - ID of the table
 * @returns Result
 */
export async function convertToRange(tableId: number): Promise<TableResult> {
  return invoke<TableResult>("convert_to_range", { tableId });
}

/**
 * Get a table by ID.
 * @param tableId - ID of the table
 * @returns The table or null if not found
 */
export async function getTable(tableId: number): Promise<Table | null> {
  return invoke<Table | null>("get_table", { tableId });
}

/**
 * Get a table by name.
 * @param name - Name of the table
 * @returns The table or null if not found
 */
export async function getTableByName(name: string): Promise<Table | null> {
  return invoke<Table | null>("get_table_by_name", { name });
}

/**
 * Get the table at a specific cell.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 * @returns The table or null if not found
 */
export async function getTableAtCell(
  row: number,
  col: number
): Promise<Table | null> {
  return invoke<Table | null>("get_table_at_cell", { row, col });
}

/**
 * Get all tables on the current sheet.
 * @returns Array of tables
 */
export async function getAllTables(): Promise<Table[]> {
  return invoke<Table[]>("get_all_tables", {});
}

/**
 * Resolve a structured reference (e.g., "Table1[Column1]").
 * @param reference - The structured reference string
 * @returns Result with the resolved range
 */
export async function resolveStructuredReference(
  reference: string
): Promise<StructuredRefResult> {
  return invoke<StructuredRefResult>("resolve_structured_reference", { reference });
}

// ============================================================================
// Remove Duplicates
// ============================================================================

/**
 * Result of the remove_duplicates command.
 */
export interface RemoveDuplicatesResult {
  success: boolean;
  duplicatesRemoved: number;
  uniqueRemaining: number;
  updatedCells: CellData[];
  error: string | null;
}

/**
 * Remove duplicate rows from a range based on specified key columns.
 * Keeps the first occurrence of each unique combination.
 * @param startRow - Start row (0-based)
 * @param startCol - Start column (0-based)
 * @param endRow - End row (0-based, inclusive)
 * @param endCol - End column (0-based, inclusive)
 * @param keyColumns - Absolute column indices to use as duplicate keys
 * @param hasHeaders - Whether the first row is a header
 * @returns Result with counts and updated cells
 */
export async function removeDuplicates(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  keyColumns: number[],
  hasHeaders: boolean,
): Promise<RemoveDuplicatesResult> {
  return invoke<RemoveDuplicatesResult>("remove_duplicates", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      keyColumns,
      hasHeaders,
    },
  });
}

// ============================================================================
// Goal Seek (single-variable solver)
// ============================================================================

/** Parameters for the goal_seek command. */
export interface GoalSeekParams {
  /** Row of the target cell (must contain a formula), 0-based */
  targetRow: number;
  /** Column of the target cell, 0-based */
  targetCol: number;
  /** The numeric value we want the target cell to evaluate to */
  targetValue: number;
  /** Row of the variable cell (must be a constant), 0-based */
  variableRow: number;
  /** Column of the variable cell, 0-based */
  variableCol: number;
  /** Maximum number of iterations (default: 100) */
  maxIterations?: number;
  /** Convergence tolerance (default: 0.001) */
  tolerance?: number;
}

/** Result of the goal_seek command. */
export interface GoalSeekResult {
  /** Whether a solution was found within tolerance */
  foundSolution: boolean;
  /** The final value placed in the variable cell */
  variableValue: number;
  /** The final evaluated value of the target cell */
  targetResult: number;
  /** Number of iterations performed */
  iterations: number;
  /** The original value of the variable cell (for reverting) */
  originalVariableValue: number;
  /** Updated cells (the variable cell + target cell + any dependents) */
  updatedCells: CellData[];
  /** Error message if goal seek failed validation */
  error: string | null;
}

/**
 * Run Goal Seek: iteratively adjust a variable cell until a target formula
 * evaluates to the desired value.
 * @param params - Goal seek parameters
 * @returns Result with solution status and updated cells
 */
export async function goalSeek(
  params: GoalSeekParams,
): Promise<GoalSeekResult> {
  return invoke<GoalSeekResult>("goal_seek", { params });
}

// ============================================================================
// Tracing (Trace Precedents / Trace Dependents)
// ============================================================================

/** A single cell reference in a trace result. */
export interface TraceCellRef {
  row: number;
  col: number;
  /** Whether this cell currently displays an error value */
  isError: boolean;
  /** The display value (for UI tooltips) */
  display: string;
}

/** A contiguous range grouped for visual compactness. */
export interface TraceRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Whether any cell in this range has an error value */
  hasError: boolean;
}

/** A cross-sheet reference in a trace result. */
export interface TraceCrossSheetRef {
  sheetName: string;
  sheetIndex: number;
  row: number;
  col: number;
  /** Whether this cell has an error */
  isError: boolean;
}

/** Result of tracing precedents or dependents for a single cell. */
export interface TraceResult {
  /** The cell being traced */
  sourceRow: number;
  sourceCol: number;
  /** Same-sheet individual cell references */
  cells: TraceCellRef[];
  /** Same-sheet range references (grouped contiguous regions) */
  ranges: TraceRange[];
  /** Cross-sheet references */
  crossSheetRefs: TraceCrossSheetRef[];
  /** Whether the source cell itself is in error */
  sourceIsError: boolean;
}

/**
 * Trace Precedents: get cells and ranges that supply data TO the given cell's formula.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 */
export async function tracePrecedents(
  row: number,
  col: number,
): Promise<TraceResult> {
  return invoke<TraceResult>("trace_precedents", { row, col });
}

/**
 * Trace Dependents: get formula cells that rely ON the given cell.
 * @param row - Row index (0-based)
 * @param col - Column index (0-based)
 */
export async function traceDependents(
  row: number,
  col: number,
): Promise<TraceResult> {
  return invoke<TraceResult>("trace_dependents", { row, col });
}

// ============================================================================
// Evaluate Formula (step-by-step formula debugger)
// ============================================================================

/** State returned by every evaluate-formula command. */
export interface EvalStepState {
  sessionId: string;
  formulaDisplay: string;
  underlineStart: number;
  underlineEnd: number;
  canEvaluate: boolean;
  canStepIn: boolean;
  canStepOut: boolean;
  isComplete: boolean;
  cellReference: string;
  stepInTarget: string | null;
  evaluationResult: string | null;
  error: string | null;
}

/**
 * Initialize evaluate-formula session for the given cell.
 * Returns an error state if the cell has no formula.
 */
export async function evalFormulaInit(
  row: number,
  col: number,
): Promise<EvalStepState> {
  return invoke<EvalStepState>("eval_formula_init", { row, col });
}

/**
 * Evaluate the currently underlined sub-expression and advance.
 */
export async function evalFormulaEvaluate(
  sessionId: string,
): Promise<EvalStepState> {
  return invoke<EvalStepState>("eval_formula_evaluate", { sessionId });
}

/**
 * Step into a referenced cell's formula (push a stack frame).
 */
export async function evalFormulaStepIn(
  sessionId: string,
): Promise<EvalStepState> {
  return invoke<EvalStepState>("eval_formula_step_in", { sessionId });
}

/**
 * Step out of the current cell's formula back to the caller (pop frame).
 */
export async function evalFormulaStepOut(
  sessionId: string,
): Promise<EvalStepState> {
  return invoke<EvalStepState>("eval_formula_step_out", { sessionId });
}

/**
 * Restart evaluation from the beginning (re-parse original formula).
 */
export async function evalFormulaRestart(
  sessionId: string,
): Promise<EvalStepState> {
  return invoke<EvalStepState>("eval_formula_restart", { sessionId });
}

/**
 * Close and clean up the evaluation session.
 */
export async function evalFormulaClose(
  sessionId: string,
): Promise<boolean> {
  return invoke<boolean>("eval_formula_close", { sessionId });
}