//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkTypes.ts
// PURPOSE: Type definitions for the Cell Bookmarks extension.
// CONTEXT: Defines Bookmark interface and BookmarkColor type used throughout the extension.

// ============================================================================
// Types
// ============================================================================

/** Available bookmark colors for visual differentiation */
export type BookmarkColor = "blue" | "green" | "orange" | "red" | "purple" | "yellow";

/** All available bookmark colors */
export const BOOKMARK_COLORS: BookmarkColor[] = [
  "blue",
  "green",
  "orange",
  "red",
  "purple",
  "yellow",
];

/** CSS color values for bookmark dots (cell decoration) */
export const BOOKMARK_DOT_COLORS: Record<BookmarkColor, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#ea580c",
  red: "#dc2626",
  purple: "#9333ea",
  yellow: "#ca8a04",
};

/** Subtle background tint colors for highlighted bookmarks (style interceptor) */
export const BOOKMARK_TINT_COLORS: Record<BookmarkColor, string> = {
  blue: "#dbeafe",
  green: "#dcfce7",
  orange: "#ffedd5",
  red: "#fee2e2",
  purple: "#f3e8ff",
  yellow: "#fef9c3",
};

/** A cell bookmark */
export interface Bookmark {
  /** Unique identifier */
  id: string;
  /** Cell row (0-based) */
  row: number;
  /** Cell column (0-based) */
  col: number;
  /** Sheet index, kept CURRENT as sheets are moved, inserted or deleted */
  sheetIndex: number;
  /**
   * The sheet's STABLE id (`SheetInfo.sheetId`): the bookmark follows its
   * sheet by it -- a moved sheet keeps its bookmarks, a deleted one takes them
   * with it, as Excel's Watch Window entries do [LIVE 2026-10-30]. Absent from
   * a bookmark saved before it existed; filled in from the index on load.
   */
  sheetId?: string;
  /** Sheet name at time of bookmark creation */
  sheetName: string;
  /** User-provided label (defaults to cell reference like "A1") */
  label: string;
  /** Visual color indicator */
  color: BookmarkColor;
  /** Creation timestamp (ms) */
  createdAt: number;
}

/** Options for creating a bookmark */
export interface BookmarkCreateOptions {
  label?: string;
  color?: BookmarkColor;
  /** The sheet's stable id, when the caller knows it. */
  sheetId?: string;
}
