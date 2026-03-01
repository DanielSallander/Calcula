//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkStore.ts
// PURPOSE: Module-scoped state management for cell bookmarks.
// CONTEXT: Follows the same pattern as annotationStore.ts, filterStore.ts, etc.
//          Provides CRUD operations and change notification for reactivity.

import type { Bookmark, BookmarkColor, BookmarkCreateOptions } from "./bookmarkTypes";
import { columnToLetter } from "../../../../src/api";

// ============================================================================
// Internal State
// ============================================================================

/** Bookmarks keyed by "sheetIndex:row,col" */
const bookmarks = new Map<string, Bookmark>();

/** Whether background highlight tinting is enabled */
let highlightEnabled = false;

/** Current active sheet index (updated via events) */
let currentSheetIndex = 0;

/** Change listeners for reactivity (task pane, status bar) */
const changeListeners = new Set<() => void>();

/** Counter for generating unique IDs */
let nextId = 1;

// ============================================================================
// Helpers
// ============================================================================

function makeKey(row: number, col: number, sheetIndex: number): string {
  return `${sheetIndex}:${row},${col}`;
}

function generateId(): string {
  return `bm-${nextId++}`;
}

function notifyChange(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[CellBookmarks] Error in change listener:", error);
    }
  }
}

/** Create a cell reference string like "A1" or "Sheet2!B5" */
function cellRef(row: number, col: number, sheetIndex: number, sheetName: string): string {
  const colLetter = columnToLetter(col);
  const rowNum = row + 1;
  if (sheetIndex === currentSheetIndex) {
    return `${colLetter}${rowNum}`;
  }
  return `${sheetName}!${colLetter}${rowNum}`;
}

// ============================================================================
// Public API
// ============================================================================

/** Add a bookmark at the specified cell */
export function addBookmark(
  row: number,
  col: number,
  sheetIndex: number,
  sheetName: string,
  options?: BookmarkCreateOptions
): Bookmark {
  const key = makeKey(row, col, sheetIndex);
  const existing = bookmarks.get(key);
  if (existing) {
    return existing;
  }

  const bookmark: Bookmark = {
    id: generateId(),
    row,
    col,
    sheetIndex,
    sheetName,
    label: options?.label || cellRef(row, col, sheetIndex, sheetName),
    color: options?.color || "blue",
    createdAt: Date.now(),
  };

  bookmarks.set(key, bookmark);
  notifyChange();
  return bookmark;
}

/** Remove a bookmark at the specified cell. Returns true if one was removed. */
export function removeBookmark(row: number, col: number, sheetIndex: number): boolean {
  const key = makeKey(row, col, sheetIndex);
  const removed = bookmarks.delete(key);
  if (removed) {
    notifyChange();
  }
  return removed;
}

/** Remove a bookmark by its ID. Returns true if found and removed. */
export function removeBookmarkById(id: string): boolean {
  for (const [key, bm] of bookmarks) {
    if (bm.id === id) {
      bookmarks.delete(key);
      notifyChange();
      return true;
    }
  }
  return false;
}

/** Remove all bookmarks */
export function removeAllBookmarks(): void {
  if (bookmarks.size === 0) return;
  bookmarks.clear();
  notifyChange();
}

/** Update a bookmark's label and/or color */
export function updateBookmark(id: string, updates: { label?: string; color?: BookmarkColor }): boolean {
  for (const bm of bookmarks.values()) {
    if (bm.id === id) {
      if (updates.label !== undefined) bm.label = updates.label;
      if (updates.color !== undefined) bm.color = updates.color;
      notifyChange();
      return true;
    }
  }
  return false;
}

/** Get a bookmark at a specific cell, or undefined */
export function getBookmarkAt(row: number, col: number, sheetIndex?: number): Bookmark | undefined {
  const sheet = sheetIndex ?? currentSheetIndex;
  return bookmarks.get(makeKey(row, col, sheet));
}

/** Check if a bookmark exists at a specific cell */
export function hasBookmarkAt(row: number, col: number, sheetIndex?: number): boolean {
  const sheet = sheetIndex ?? currentSheetIndex;
  return bookmarks.has(makeKey(row, col, sheet));
}

/** Get all bookmarks as an array */
export function getAllBookmarks(): Bookmark[] {
  return Array.from(bookmarks.values());
}

/** Get bookmarks for a specific sheet */
export function getBookmarksForSheet(sheetIndex: number): Bookmark[] {
  return Array.from(bookmarks.values()).filter((bm) => bm.sheetIndex === sheetIndex);
}

/** Get total bookmark count */
export function getBookmarkCount(): number {
  return bookmarks.size;
}

/** Get bookmarks sorted by sheet, row, then col (for navigation) */
export function getSortedBookmarks(): Bookmark[] {
  return Array.from(bookmarks.values()).sort((a, b) => {
    if (a.sheetIndex !== b.sheetIndex) return a.sheetIndex - b.sheetIndex;
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });
}

/** Set the current active sheet index */
export function setCurrentSheet(sheetIndex: number): void {
  currentSheetIndex = sheetIndex;
}

/** Get the current active sheet index */
export function getCurrentSheet(): number {
  return currentSheetIndex;
}

/** Check if highlight mode is on */
export function isHighlightEnabled(): boolean {
  return highlightEnabled;
}

/** Toggle highlight mode and return the new state */
export function toggleHighlight(): boolean {
  highlightEnabled = !highlightEnabled;
  notifyChange();
  return highlightEnabled;
}

/** Subscribe to bookmark changes. Returns cleanup function. */
export function onChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
