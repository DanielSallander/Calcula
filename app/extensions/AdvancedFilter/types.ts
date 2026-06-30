//! FILENAME: app/extensions/AdvancedFilter/types.ts
// PURPOSE: Type definitions for the Advanced Filter extension.
// CONTEXT: Excel-style Advanced Filter with criteria range, copy-to, and unique records.

/**
 * Action to perform when applying the advanced filter.
 */
export type AdvancedFilterAction = "filterInPlace" | "copyToLocation";

/**
 * Parameters for an Advanced Filter operation.
 */
export interface AdvancedFilterParams {
  /** The data range (list range) including headers. [startRow, startCol, endRow, endCol] */
  listRange: [number, number, number, number];
  /** The criteria range including headers. [startRow, startCol, endRow, endCol] */
  criteriaRange: [number, number, number, number];
  /** Whether to filter in place or copy matching rows to another location */
  action: AdvancedFilterAction;
  /** Destination start cell for "copy to" mode. [row, col] */
  copyTo?: [number, number];
  /** Whether to return only unique records */
  uniqueRecordsOnly: boolean;
}

// NOTE: criterion parsing + row matching (operator, value, wildcard, AND/OR rows)
// now live SERVER-SIDE in Rust (autofilter.rs run_advanced_filter; "Rust owns
// computation"). The former TS `ParsedCriterion` / `CriteriaRow` types are retired.

/**
 * Result of an Advanced Filter operation.
 */
export interface AdvancedFilterResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Number of matching rows */
  matchCount: number;
  /** Number of rows hidden (filter in place) or copied (copy to) */
  affectedRows: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Data passed to the Advanced Filter dialog.
 */
export interface AdvancedFilterDialogData {
  /** Pre-filled list range as "A1:D10" style string */
  listRange?: string;
  /** Pre-filled criteria range */
  criteriaRange?: string;
}
