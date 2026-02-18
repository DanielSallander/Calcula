//! FILENAME: app/extensions/AutoFilter/types.ts
// PURPOSE: Type definitions for the AutoFilter extension.
// CONTEXT: Used internally by the AutoFilter extension.

import type { AutoFilterInfo } from "../../src/api";

/**
 * Module-level state for the AutoFilter extension.
 */
export interface FilterState {
  /** Current AutoFilter info from the backend (null if no filter) */
  autoFilterInfo: AutoFilterInfo | null;
  /** Whether the AutoFilter is active (dropdowns visible) */
  isActive: boolean;
  /** Which column's dropdown is currently open (null if none) */
  openDropdownCol: number | null;
}

/**
 * Data passed to the filter dropdown overlay.
 */
export interface FilterDropdownData {
  /** Absolute column index in the grid */
  absoluteCol: number;
  /** Column index relative to the AutoFilter range (0-based) */
  relativeCol: number;
  /** Column header display name (e.g., "A", "B", etc.) */
  columnName: string;
  /** Unique values for this column */
  uniqueValues: string[];
  /** Whether the column has blank cells */
  hasBlanks: boolean;
  /** Currently selected (checked) values, or null for "all selected" */
  selectedValues: string[] | null;
  /** Whether blanks are currently included */
  includeBlanks: boolean;
}
