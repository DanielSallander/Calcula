//! FILENAME: app/extensions/WatchWindow/lib/watchStore.ts
// PURPOSE: In-memory state for Watch Window items.
// CONTEXT: Stores watch entries and provides CRUD + refresh operations.

import { getWatchCells, getSheets, columnToLetter } from "@api";
import type { CellData } from "@api";

// ============================================================================
// Types
// ============================================================================

export interface WatchItem {
  /** Unique ID */
  id: string;
  /** Sheet index (0-based) */
  sheetIndex: number;
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

  // Also refresh sheet names in case they were renamed
  let sheetNames: string[] = [];
  try {
    const sheetsResult = await getSheets();
    sheetNames = sheetsResult.sheets.map((s) => s.name);
  } catch {
    // Keep existing names
  }

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
 * Clean up all state.
 */
export function reset(): void {
  items = [];
  listeners.clear();
}
