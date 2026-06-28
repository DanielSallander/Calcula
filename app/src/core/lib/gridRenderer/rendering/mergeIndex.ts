//! FILENAME: app/src/core/lib/gridRenderer/rendering/mergeIndex.ts
// PURPOSE: Build a slave->master merge index once per render (C3b).
// CONTEXT: Merge geometry is constant for a given cells snapshot, yet the old
//   getMasterCellKey re-scanned the ENTIRE cell cache for EVERY visible cell,
//   every frame (O(visible x cache), x4 with freeze panes). This precomputes the
//   slave->master map in a single O(cache) pass so the per-cell lookup is O(1).
//   The function is the single source of truth for slave detection (it replaced
//   two byte-identical private copies in cells.ts and core.ts).

import { cellKey } from "../../../types";

/** Minimal shape needed to detect a merge master: only the spans matter. */
type SpanCell = { rowSpan?: number; colSpan?: number };

/**
 * Map every merge SLAVE cell key -> its master cell key, in one pass over the
 * cache. A master is any cell with rowSpan>1 or colSpan>1; its slaves are the
 * other cells inside its rowSpan x colSpan rectangle (the master itself is NOT
 * included). Mirrors the old getMasterCellKey semantics for every
 * NON-OVERLAPPING merge state — the only kind the backend permits
 * (merge_commands.rs rejects a selection overlapping an existing merge), so the
 * cell cache never holds overlapping spans. (If two masters did overlap the old
 * per-cell scan returned the FIRST covering master in iteration order and this
 * index the LAST — an unreachable case.) `masterKey` iff the cell is inside a
 * merge region AND is not the master.
 */
export function buildMergeSlaveIndex(cells: Map<string, SpanCell>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    if (rowSpan <= 1 && colSpan <= 1) continue; // not a master

    const parts = key.split(",");
    const masterRow = parseInt(parts[0], 10);
    const masterCol = parseInt(parts[1], 10);

    for (let r = masterRow; r < masterRow + rowSpan; r++) {
      for (let c = masterCol; c < masterCol + colSpan; c++) {
        if (r === masterRow && c === masterCol) continue; // skip the master itself
        index.set(cellKey(r, c), key);
      }
    }
  }
  return index;
}
