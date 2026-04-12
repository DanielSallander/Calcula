//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/viewBookmarkTypes.ts
// PURPOSE: Type definitions for View Bookmarks (Power BI-style state snapshots).
// CONTEXT: View bookmarks capture/restore selected view state dimensions (filters, zoom, scroll, etc.).

import type { BookmarkColor } from "./bookmarkTypes";
import type {
  SelectionType,
  ViewMode,
  FilterCriteria,
} from "@api";

// ============================================================================
// Dimension Flags
// ============================================================================

/** Which view-state dimensions a view bookmark captures/restores. */
export interface ViewStateDimensions {
  selection?: boolean;
  viewport?: boolean;
  zoom?: boolean;
  activeSheet?: boolean;
  viewMode?: boolean;
  showFormulas?: boolean;
  freezeConfig?: boolean;
  splitConfig?: boolean;
  hiddenRows?: boolean;
  hiddenCols?: boolean;
  columnWidths?: boolean;
  rowHeights?: boolean;
  autoFilter?: boolean;
}

/** Default dimensions enabled when creating a new view bookmark. */
export const DEFAULT_VIEW_DIMENSIONS: ViewStateDimensions = {
  selection: true,
  activeSheet: true,
  zoom: true,
  autoFilter: true,
  viewport: true,
};

/** Human-readable labels for each dimension. */
export const DIMENSION_LABELS: Record<keyof ViewStateDimensions, string> = {
  selection: "Selection",
  viewport: "Scroll Position",
  zoom: "Zoom Level",
  activeSheet: "Active Sheet",
  viewMode: "View Mode",
  showFormulas: "Show Formulas",
  freezeConfig: "Freeze Panes",
  splitConfig: "Split Window",
  hiddenRows: "Hidden Rows",
  hiddenCols: "Hidden Columns",
  columnWidths: "Column Widths",
  rowHeights: "Row Heights",
  autoFilter: "Filters",
};

// ============================================================================
// State Snapshot
// ============================================================================

/** Serializable additional selection range. */
export interface SnapshotRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Serializable selection state. */
export interface SelectionSnapshot {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: SelectionType;
  additionalRanges?: SnapshotRange[];
}

/** Serializable AutoFilter state (range + per-column criteria). */
export interface AutoFilterSnapshot {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  criteria: (FilterCriteria | null)[];
}

/**
 * Captured view state snapshot.
 * Only fields corresponding to enabled dimensions are populated.
 */
export interface ViewStateSnapshot {
  selection?: SelectionSnapshot;
  viewport?: { scrollX: number; scrollY: number };
  zoom?: number;
  activeSheet?: { index: number; name: string };
  viewMode?: ViewMode;
  showFormulas?: boolean;
  freezeConfig?: { freezeRow: number | null; freezeCol: number | null };
  splitConfig?: { splitRow: number | null; splitCol: number | null };
  hiddenRows?: number[];
  hiddenCols?: number[];
  /** Sparse map: only columns with custom widths (col index -> px). */
  columnWidths?: Record<number, number>;
  /** Sparse map: only rows with custom heights (row index -> px). */
  rowHeights?: Record<number, number>;
  autoFilter?: AutoFilterSnapshot | null;
}

// ============================================================================
// View Bookmark
// ============================================================================

/** A view bookmark that captures and restores application view state. */
export interface ViewBookmark {
  /** Unique identifier (format: "vb-{n}") */
  id: string;
  /** User-provided label */
  label: string;
  /** Optional description */
  description?: string;
  /** Visual color indicator */
  color: BookmarkColor;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last update timestamp (ms) */
  updatedAt: number;
  /** Which dimensions are captured */
  dimensions: ViewStateDimensions;
  /** The captured state values */
  snapshot: ViewStateSnapshot;
  /** Optional script ID to run when this bookmark is activated */
  onActivateScriptId?: string;
}

/** Options for creating a view bookmark. */
export interface ViewBookmarkCreateOptions {
  label: string;
  description?: string;
  color?: BookmarkColor;
  dimensions?: ViewStateDimensions;
  onActivateScriptId?: string;
}
