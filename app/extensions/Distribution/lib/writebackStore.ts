// FILENAME: app/extensions/Distribution/lib/writebackStore.ts
// PURPOSE: Frontend cache for the writeback region index.
// CONTEXT: The Distribution extension fetches the index from the backend
// and caches it for fast guard evaluation. The cache is replaced atomically
// on subscription state changes to avoid race windows.

import { getWritebackRegions, type WritebackRegionEntry } from "@api/distribution";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Snapshot of writeback regions, replaced atomically. */
let snapshot: WritebackRegionEntry[] = [];

/** Whether we have writeback regions in the current snapshot. */
let hasRegions = false;

/** Current active sheet index — updated by the extension on sheet change events. */
let activeSheetIndex = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a cell is within any writeback region on the given sheet index.
 * Uses the current snapshot — no async call.
 */
export function isWritebackCell(sheetIndex: number, row: number, col: number): boolean {
  if (!hasRegions) return false;
  for (const r of snapshot) {
    if (r.sheetIndex === sheetIndex && row >= r.rowStart && row <= r.rowEnd && col >= r.colStart && col <= r.colEnd) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a range overlaps any writeback region on the given sheet index.
 * Returns true if any cell in the range is in a writeback region.
 */
export function rangeOverlapsWriteback(
  sheetIndex: number,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): boolean {
  if (!hasRegions) return false;
  for (const r of snapshot) {
    if (
      r.sheetIndex === sheetIndex &&
      startRow <= r.rowEnd && endRow >= r.rowStart &&
      startCol <= r.colEnd && endCol >= r.colStart
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the current snapshot has any writeback regions. */
export function hasWritebackRegions(): boolean {
  return hasRegions;
}

/**
 * Fetch the writeback index from the backend and atomically replace
 * the local snapshot. This is the only way the snapshot changes.
 * Returns the new snapshot.
 */
export async function refreshWritebackSnapshot(): Promise<WritebackRegionEntry[]> {
  const regions = await getWritebackRegions();
  // Atomic replacement — no intermediate empty state
  snapshot = regions;
  hasRegions = regions.length > 0;
  return regions;
}

/** Update the active sheet index (called on sheet change events). */
export function setActiveSheetIndex(index: number): void {
  activeSheetIndex = index;
}

/** Get the current active sheet index for guard evaluation. */
export function getActiveSheetIndex(): number {
  return activeSheetIndex;
}

/** Clear the snapshot (used on deactivation). */
export function resetWritebackSnapshot(): void {
  snapshot = [];
  hasRegions = false;
  activeSheetIndex = 0;
}
