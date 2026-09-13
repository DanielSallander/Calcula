//! FILENAME: app/extensions/Sorting/types.ts
// PURPOSE: Type definitions for the Advanced Sort dialog extension.
// CONTEXT: Local types used by the Sort dialog state and components.

import type { SortOn, SortDataOption, SortOrientation, IconSetType } from "@api/lib";

/**
 * A single sort level (criterion) in the dialog.
 */
export interface SortLevel {
  /** Unique ID for React key and state management */
  id: string;
  /** Column (or row) offset from range start (0-based) */
  columnKey: number;
  /** What cell attribute to sort on */
  sortOn: SortOn;
  /** true = ascending (A-Z / smallest-to-largest), false = descending */
  ascending: boolean;
  /** CSS color string when sortOn is "cellColor" or "fontColor" */
  color?: string;
  /**
   * Which icon to bring to the top when `sortOn` is "icon".
   *
   * BOTH HALVES ARE REQUIRED. An index is meaningless without the set it
   * indexes into — that was BUG-0107 — so this mirrors `SortField.icon`
   * exactly rather than carrying a bare number.
   *
   * The dialog offered "Conditional Formatting Icon" for a long time while
   * having nowhere to put the answer, so the backend (which implements icon
   * sorting and requires the icon to be named) refused every such sort with
   * "names no icon. Choose which icon to bring to the top." — a correct message
   * about a choice the UI never offered. That is the dead half of BUG-0104.
   */
  icon?: { iconSet: IconSetType; iconIndex: number };
  /** Data option: normal or treat text as numbers */
  dataOption: SortDataOption;
  /** Custom sort order: built-in list name or comma-separated values */
  customOrder?: string;
}

/**
 * Full state of the Sort dialog.
 */
export interface SortDialogState {
  /** Ordered list of sort levels (priority queue) */
  levels: SortLevel[];
  /** Whether the first row/column of the range is a header */
  hasHeaders: boolean;
  /** Whether sorting is case-sensitive */
  caseSensitive: boolean;
  /** Sort orientation: rows (top-to-bottom) or columns (left-to-right) */
  orientation: SortOrientation;
  /** Data range coordinates (0-based) */
  rangeStartRow: number;
  rangeStartCol: number;
  rangeEndRow: number;
  rangeEndCol: number;
  /** Display names for columns (header values or A, B, C letters) */
  columnHeaders: string[];
  /** The currently selected level ID (for move/delete operations) */
  selectedLevelId: string | null;
}

/** Maximum number of sort levels allowed (Excel supports 64) */
export const MAX_SORT_LEVELS = 64;
