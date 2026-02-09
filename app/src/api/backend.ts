//! FILENAME: app/src/api/backend.ts
// PURPOSE: Secure abstraction layer for Tauri backend communication.
// CONTEXT: Extensions must use this API to communicate with the Rust backend.
// Direct use of @tauri-apps/api is forbidden in extensions - it bypasses the sandbox.
// This file is the ONLY place that should import from @tauri-apps/api/core.

import { invoke } from "@tauri-apps/api/core";

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