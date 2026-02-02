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