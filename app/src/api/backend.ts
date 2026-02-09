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