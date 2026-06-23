// FILENAME: app/extensions/Distribution/lib/writebackStore.ts
// PURPOSE: Frontend cache for the writeback region index.
// CONTEXT: The Distribution extension fetches the index from the backend
// and caches it for fast guard evaluation. The cache is replaced atomically
// on subscription state changes to avoid race windows.

import {
  getWritebackRegions,
  getWritebackLayer,
  reconcileWriteback,
  type WritebackRegionEntry,
  type WritebackSubmission,
} from "@api/distribution";

/** Cell writeback status: not-yet-filled, local unsent edit, sent & awaiting
 * the publisher's decision, accepted, or rejected (needs revision). */
export type WritebackCellState =
  | "empty"
  | "draft"
  | "submitted"
  | "approved"
  | "rejected";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Snapshot of writeback regions, replaced atomically. */
let snapshot: WritebackRegionEntry[] = [];

/** Whether we have writeback regions in the current snapshot. */
let hasRegions = false;

/** Current active sheet index — updated by the extension on sheet change events. */
let activeSheetIndex = 0;

/** Cached drafts for visual treatment lookup. Refreshed alongside the snapshot. */
let drafts: WritebackSubmission[] = [];

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
  const [regions, layer] = await Promise.all([
    getWritebackRegions(),
    // Reconcile first so cell states reflect the publisher's approve/reject
    // decisions (the return leg). Falls back to the plain layer if reconcile
    // fails (e.g. offline registry), and to empty if that fails too.
    reconcileWriteback()
      .catch(() => getWritebackLayer())
      .catch(() => ({ formatVersion: 1, drafts: [] })),
  ]);
  // Atomic replacement — no intermediate empty state
  snapshot = regions;
  hasRegions = regions.length > 0;
  drafts = layer.drafts;
  return regions;
}

/**
 * Get the region entry covering a given cell, or null if not in a writeback region.
 */
export function getRegionForCell(
  sheetIndex: number,
  row: number,
  col: number,
): WritebackRegionEntry | null {
  if (!hasRegions) return null;
  for (const r of snapshot) {
    if (r.sheetIndex === sheetIndex && row >= r.rowStart && row <= r.rowEnd && col >= r.colStart && col <= r.colEnd) {
      return r;
    }
  }
  return null;
}

/**
 * Get the writeback state for a cell: "empty" | "draft" | "submitted" |
 * "approved" | "rejected". Returns null if the cell is not in a writeback
 * region. Matches the draft by REGION + cell (not cell alone) so a same-named
 * coordinate in another sheet's region can't bleed in.
 */
export function getWritebackCellState(
  sheetIndex: number,
  row: number,
  col: number,
): WritebackCellState | null {
  const region = getRegionForCell(sheetIndex, row, col);
  if (!region) return null;
  const draft = drafts.find(
    (d) => d.regionId === region.regionId && d.cellRow === row && d.cellCol === col,
  );
  if (!draft) return "empty";
  // draft.state is "draft" | "submitted" | "approved" | "rejected".
  return draft.state;
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
  drafts = [];
}
