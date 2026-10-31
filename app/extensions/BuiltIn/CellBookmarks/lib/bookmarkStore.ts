//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkStore.ts
// PURPOSE: Module-scoped state management for cell bookmarks.
// CONTEXT: Follows the same pattern as annotationStore.ts, filterStore.ts, etc.
//          Provides CRUD operations and change notification for reactivity.

import type { Bookmark, BookmarkColor, BookmarkCreateOptions } from "./bookmarkTypes";
import { columnToLetter } from "@api";
import { followCell, type StructuralFollowEdit, type StructuralFollowStep } from "@api/structuralFollow";

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
    ...(options?.sheetId ? { sheetId: options.sheetId } : {}),
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
  takenByStructuralEdit.clear();
  displacedByMoveRestore.clear();
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

/**
 * The bookmarks a structural edit DELETED (their cell went with its row or
 * column), by the edit's journal number (@api/structuralFollow), so its Undo
 * can put them back where they were -- as an Undo puts back the notes and
 * comments of the cells it restores -- and its Redo can take them again.
 */
const takenByStructuralEdit = new Map<number, Bookmark[]>();

/**
 * The bookmarks the Undo of a move set aside because a returning bookmark
 * claimed their cell (see applyStructuralStep), by journal number, for the
 * Redo to put back.
 */
const displacedByMoveRestore = new Map<number, Bookmark[]>();

/**
 * Follow one coordinate change (or its undo / redo) on any sheet (BUG-0614):
 * each bookmark moves with its cell -- a row or column edit, an Insert /
 * Delete Cells band, a cut-pasted block (onto the sheet it was pasted on);
 * one whose cell was deleted, or overwritten by a pasted block, leaves the
 * list until that change is undone. The Undo of a move overwrites nothing: a
 * bookmark on a cell the block returns to stays. Returns true when anything
 * changed (the write-through then persists it).
 */
export function applyStructuralStep(step: StructuralFollowStep<StructuralFollowEdit>): boolean {
  const { edit, cause, seq } = step;
  let changed = false;
  const kept: Bookmark[] = [];
  const taken: Bookmark[] = [];
  // The Undo of a MOVE puts cells back; it overwrites nothing. A bookmark on a
  // cell the block returns to -- one added at the emptied source after a
  // cut-paste -- stays where it is, as Excel's Watch Window entry does [LIVE
  // 2026-10-30: C5 cut and pasted onto F8, a watch added on the empty C5,
  // Ctrl+Z -> both watches read C5]. It used to be taken, and a take under an
  // Undo is never given back, so the bookmark was gone for good. (A Redo makes
  // the move again, and overwrites again, as the edit did.)
  const restoresCells = edit.kind === "move" && cause === "undo";
  const stationary: Bookmark[] = [];
  for (const bm of bookmarks.values()) {
    const moved = followCell(edit, bm.sheetIndex, bm.row, bm.col);
    if (moved === null && restoresCells) {
      stationary.push(bm);
      continue;
    }
    if (moved === null) {
      taken.push(bm);
      changed = true;
      continue;
    }
    if (moved.sheetIndex !== bm.sheetIndex || moved.row !== bm.row || moved.col !== bm.col) {
      if (moved.sheetIndex !== bm.sheetIndex) {
        // Pasted on another sheet: its id and name are re-read (resyncSheets).
        bm.sheetIndex = moved.sheetIndex;
        delete bm.sheetId;
      }
      bm.row = moved.row;
      bm.col = moved.col;
      changed = true;
    }
    kept.push(bm);
  }
  if (cause === "undo") {
    // The inverse of a delete re-inserts the lines, so the bookmarks it took
    // fit their own cells again.
    const back = takenByStructuralEdit.get(seq);
    if (back) {
      takenByStructuralEdit.delete(seq);
      kept.push(...back);
      changed = true;
    }
  } else if (taken.length > 0) {
    takenByStructuralEdit.set(seq, taken);
  }
  // A cell holds one bookmark. One that stayed on a cell a moved bookmark
  // returned to (the cut cell had a bookmark of its own) makes way for it and
  // is set aside under this journal number, and the Redo, which moves the
  // block away again, puts it back on its cell.
  const occupied = new Set(kept.map((bm) => makeKey(bm.row, bm.col, bm.sheetIndex)));
  const displaced: Bookmark[] = [];
  for (const bm of stationary) {
    const key = makeKey(bm.row, bm.col, bm.sheetIndex);
    if (occupied.has(key)) {
      displaced.push(bm);
      changed = true;
      continue;
    }
    occupied.add(key);
    kept.push(bm);
  }
  const waiting = displacedByMoveRestore.get(seq);
  if (waiting) {
    displacedByMoveRestore.delete(seq);
    for (const bm of waiting) {
      const key = makeKey(bm.row, bm.col, bm.sheetIndex);
      if (occupied.has(key)) continue;
      occupied.add(key);
      kept.push(bm);
      changed = true;
    }
  }
  if (displaced.length > 0) displacedByMoveRestore.set(seq, displaced);
  if (!changed) return false;
  bookmarks.clear();
  for (const bm of kept) {
    const key = makeKey(bm.row, bm.col, bm.sheetIndex);
    if (!bookmarks.has(key)) bookmarks.set(key, bm);
  }
  notifyChange();
  return true;
}

/** Put the bookmarks back in the map under the keys their (new) coordinates name. */
function rekey(list: Bookmark[]): void {
  bookmarks.clear();
  for (const bm of list) {
    const key = makeKey(bm.row, bm.col, bm.sheetIndex);
    if (!bookmarks.has(key)) bookmarks.set(key, bm);
  }
}

/**
 * The sheet list was renumbered (a sheet moved, inserted or deleted;
 * @api/structuralFollow `followSheetRenumbering`): each bookmark keeps its
 * sheet, and the bookmarks of a deleted sheet go with it. Returns true when
 * anything changed (the write-through then persists it).
 */
export function applySheetRenumbering(renumber: (index: number) => number | null): boolean {
  let changed = false;
  const kept: Bookmark[] = [];
  for (const bm of bookmarks.values()) {
    const index = renumber(bm.sheetIndex);
    if (index === null) {
      changed = true;
      continue;
    }
    if (index !== bm.sheetIndex) {
      bm.sheetIndex = index;
      changed = true;
    }
    kept.push(bm);
  }
  if (!changed) return false;
  rekey(kept);
  notifyChange();
  return true;
}

/**
 * Re-check every bookmark's sheet against the backend's list, BY ITS STABLE
 * ID: index and name come from the sheet that carries the id now (moved,
 * renamed); a bookmark whose sheet is gone is removed (deleted). One without
 * an id takes the id of the sheet at its index (a file saved before ids were
 * kept). A list with no ids at all (an older backend) changes nothing.
 * Returns true when anything changed.
 */
export function resyncSheets(sheets: ReadonlyArray<{ index: number; name: string; sheetId?: string }>): boolean {
  if (!sheets.some((s) => s.sheetId)) return false;
  let changed = false;
  const kept: Bookmark[] = [];
  for (const bm of bookmarks.values()) {
    if (bm.sheetId) {
      const sheet = sheets.find((s) => s.sheetId === bm.sheetId);
      if (!sheet) {
        changed = true;
        continue;
      }
      if (sheet.index !== bm.sheetIndex || sheet.name !== bm.sheetName) {
        bm.sheetIndex = sheet.index;
        bm.sheetName = sheet.name;
        changed = true;
      }
    } else {
      const sheet = sheets.find((s) => s.index === bm.sheetIndex);
      if (sheet?.sheetId) {
        bm.sheetId = sheet.sheetId;
        bm.sheetName = sheet.name;
        changed = true;
      }
    }
    kept.push(bm);
  }
  if (!changed) return false;
  rekey(kept);
  notifyChange();
  return true;
}

/** Subscribe to bookmark changes. Returns cleanup function. */
export function onChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
