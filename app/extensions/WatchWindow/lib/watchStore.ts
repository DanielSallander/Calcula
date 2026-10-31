//! FILENAME: app/extensions/WatchWindow/lib/watchStore.ts
// PURPOSE: In-memory state for Watch Window items.
// CONTEXT: Stores watch entries and provides CRUD + refresh operations.

import { getWatchCells, getSheets, columnToLetter } from "@api";
import type { CellData } from "@api";
import { followCell, type StructuralFollowEdit, type StructuralFollowStep } from "@api/structuralFollow";

// ============================================================================
// Types
// ============================================================================

export interface WatchItem {
  /** Unique ID */
  id: string;
  /**
   * Sheet index (0-based), kept CURRENT: renumbered when sheets are moved,
   * inserted or deleted (`applySheetRenumbering`) and re-checked against the
   * sheet's stable id on every refresh (`resyncSheets`).
   */
  sheetIndex: number;
  /**
   * The sheet's STABLE id (`SheetInfo.sheetId`): what the watch follows. A
   * move or a rename never changes it, so Excel's rule holds -- a watch
   * follows its sheet when the sheet is moved, and goes when the sheet is
   * deleted [LIVE 2026-10-30]. Filled in from the index on the first refresh
   * when the caller did not know it.
   */
  sheetId?: string;
  /** Sheet name at time of creation */
  sheetName: string;
  /** Row index (0-based) */
  row: number;
  /** Column index (0-based) */
  col: number;
  /** Named range name, if applicable */
  name: string | null;
  /** Current display value */
  value: string;
  /** Formula string (null if plain value) */
  formula: string | null;
}

// ============================================================================
// State
// ============================================================================

let items: WatchItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Ignore listener errors
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Subscribe to state changes. Returns unsubscribe function.
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Get a snapshot of all watch items.
 */
export function getItems(): readonly WatchItem[] {
  return items;
}

/**
 * Format a cell reference string (e.g. "Sheet1!A1").
 */
export function formatCellRef(sheetName: string, row: number, col: number): string {
  const colLetter = columnToLetter(col);
  return `${sheetName}!${colLetter}${row + 1}`;
}

/**
 * Add a watch for a specific cell.
 */
export function addWatch(
  sheetIndex: number,
  sheetName: string,
  row: number,
  col: number,
  name?: string | null,
  sheetId?: string,
): WatchItem {
  // Prevent duplicate watches on same cell/sheet
  const existing = items.find(
    (w) => w.sheetIndex === sheetIndex && w.row === row && w.col === col,
  );
  if (existing) return existing;

  const item: WatchItem = {
    id: `watch-${nextId++}`,
    sheetIndex,
    sheetName,
    row,
    col,
    name: name ?? null,
    value: "",
    formula: null,
    ...(sheetId ? { sheetId } : {}),
  };
  items = [...items, item];
  notify();
  return item;
}

/**
 * Remove a watch by ID.
 */
export function removeWatch(id: string): void {
  items = items.filter((w) => w.id !== id);
  notify();
}

/**
 * Remove all watches.
 */
export function removeAllWatches(): void {
  items = [];
  notify();
}

/**
 * Refresh all watch item values from the backend.
 */
export async function refreshWatches(): Promise<void> {
  if (items.length === 0) return;

  // Each watch's sheet by its stable id first (moved, renamed or deleted),
  // then the names as they are now.
  let sheetNames: string[] = [];
  try {
    const sheetsResult = await getSheets();
    resyncSheets(sheetsResult.sheets);
    sheetNames = sheetsResult.sheets.map((s) => s.name);
  } catch {
    // Keep existing names
  }
  if (items.length === 0) return;

  const requests: [number, number, number][] = items.map((w) => [
    w.sheetIndex,
    w.row,
    w.col,
  ]);

  try {
    const results = await getWatchCells(requests);
    let changed = false;

    items = items.map((item, i) => {
      const cell: CellData | null = results[i] ?? null;
      const newValue = cell?.display ?? "";
      const newFormula = cell?.formula ?? null;
      const newSheetName =
        item.sheetIndex < sheetNames.length
          ? sheetNames[item.sheetIndex]
          : item.sheetName;

      if (
        item.value !== newValue ||
        item.formula !== newFormula ||
        item.sheetName !== newSheetName
      ) {
        changed = true;
        return { ...item, value: newValue, formula: newFormula, sheetName: newSheetName };
      }
      return item;
    });

    if (changed) {
      notify();
    }
  } catch (err) {
    console.error("[WatchWindow] Failed to refresh:", err);
  }
}

/**
 * Follow one coordinate change (or its undo / redo) on any sheet
 * (@api/structuralFollow, with moves): each watch moves with its cell, as
 * Excel's Watch Window entries do [LIVE 2026-10-30: a watch on C5 reads C6
 * after a row is inserted above, Ctrl+Z puts it back on C5, Ctrl+Y on C6; an
 * Insert Cells band moves only the cells inside it; a watch on a cut-pasted
 * cell moves with it, onto the sheet it was pasted on, and Undo moves it
 * back]. A watch whose cell was DELETED -- its row or column deleted, or a
 * pasted block landed on it -- is removed, as Excel's Watch Window drops the
 * entry, and an Undo does not bring it back [LIVE]. The Undo of a move
 * overwrites nothing: a watch on a cell the block returns to stays [LIVE
 * 2026-10-30: C5 cut and pasted onto F8, a watch added on the empty C5,
 * Ctrl+Z -> both watches read C5]. Returns true when anything changed.
 */
export function applyStructuralStep(step: StructuralFollowStep<StructuralFollowEdit>): boolean {
  const { edit, cause } = step;
  const restoresCells = edit.kind === "move" && cause === "undo";
  let changed = false;
  const next: WatchItem[] = [];
  for (const item of items) {
    const moved = followCell(edit, item.sheetIndex, item.row, item.col);
    if (moved === null && restoresCells) {
      next.push(item);
      continue;
    }
    if (moved === null) {
      changed = true;
      continue;
    }
    if (moved.sheetIndex === item.sheetIndex && moved.row === item.row && moved.col === item.col) {
      next.push(item);
      continue;
    }
    changed = true;
    if (moved.sheetIndex === item.sheetIndex) {
      next.push({ ...item, row: moved.row, col: moved.col });
    } else {
      // Pasted on another sheet: its id and name are read on the next refresh.
      const { sheetId: _gone, ...rest } = item;
      next.push({ ...rest, sheetIndex: moved.sheetIndex, row: moved.row, col: moved.col });
    }
  }
  if (changed) {
    items = next;
    notify();
  }
  return changed;
}

/**
 * The sheet list was renumbered (a sheet moved, inserted or deleted;
 * @api/structuralFollow `followSheetRenumbering`): each watch keeps its
 * sheet, and a watch on a deleted sheet goes, as Excel's does [LIVE]. Returns
 * true when anything changed.
 */
export function applySheetRenumbering(renumber: (index: number) => number | null): boolean {
  let changed = false;
  const next: WatchItem[] = [];
  for (const item of items) {
    const index = renumber(item.sheetIndex);
    if (index === null) {
      changed = true;
      continue;
    }
    if (index !== item.sheetIndex) changed = true;
    next.push(index === item.sheetIndex ? item : { ...item, sheetIndex: index });
  }
  if (changed) {
    items = next;
    notify();
  }
  return changed;
}

/**
 * Re-check every watch's sheet against the backend's list, BY ITS STABLE ID:
 * the index and the name are taken from the sheet that carries the id now
 * (moved, renamed), and a watch whose sheet is gone is removed (deleted, as
 * Excel drops it [LIVE]). A watch without an id takes the id of the sheet at
 * its index. A list that carries no ids at all (an older backend) changes
 * nothing. Returns true when anything changed.
 */
export function resyncSheets(sheets: ReadonlyArray<{ index: number; name: string; sheetId?: string }>): boolean {
  if (!sheets.some((s) => s.sheetId)) return false;
  let changed = false;
  const next: WatchItem[] = [];
  for (const item of items) {
    if (item.sheetId) {
      const sheet = sheets.find((s) => s.sheetId === item.sheetId);
      if (!sheet) {
        changed = true;
        continue;
      }
      if (sheet.index !== item.sheetIndex || sheet.name !== item.sheetName) {
        changed = true;
        next.push({ ...item, sheetIndex: sheet.index, sheetName: sheet.name });
      } else {
        next.push(item);
      }
      continue;
    }
    const sheet = sheets.find((s) => s.index === item.sheetIndex);
    if (sheet?.sheetId) {
      changed = true;
      next.push({ ...item, sheetId: sheet.sheetId, sheetName: sheet.name });
    } else {
      next.push(item);
    }
  }
  if (changed) {
    items = next;
    notify();
  }
  return changed;
}

/**
 * Clean up all state.
 */
export function reset(): void {
  items = [];
  listeners.clear();
}
