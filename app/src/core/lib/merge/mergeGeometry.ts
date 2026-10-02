//! FILENAME: app/src/core/lib/merge/mergeGeometry.ts
// PURPOSE: Pure rectangle arithmetic for the Merge menu: the selection's
//          blocks, whether they overlap, which merged regions touch them.
// CONTEXT: Excel acts on EVERY block of a Ctrl+click selection independently,
//          and does nothing at all when two blocks overlap. These helpers turn
//          a Selection into those blocks and answer the questions the gestures
//          (mergeGestures.ts) and the ribbon's pressed state (mergeState.ts)
//          ask. No IPC, no state: unit-testable on its own.

import type { MergedRegion, Selection, SelectionRange } from "../../types";

/** A normalised rectangle (start <= end on both axes). */
export type Block = SelectionRange;

/** `r` with start <= end on both axes. */
export function normaliseBlock(r: SelectionRange): Block {
  return {
    startRow: Math.min(r.startRow, r.endRow),
    startCol: Math.min(r.startCol, r.endCol),
    endRow: Math.max(r.startRow, r.endRow),
    endCol: Math.max(r.startCol, r.endCol),
  };
}

/**
 * Every block of the selection: the main range plus each Ctrl+click range,
 * normalised. A block that repeats an earlier one EXACTLY (the same cell
 * Ctrl+clicked twice) is dropped, so a duplicate click does not read as two
 * overlapping blocks and silently cancel the command.
 */
export function selectionBlocks(sel: Selection | null | undefined): Block[] {
  if (!sel) return [];
  const all = [...(sel.additionalRanges ?? []), sel].map(normaliseBlock);
  const out: Block[] = [];
  for (const b of all) {
    if (!out.some((o) => sameBlock(o, b))) out.push(b);
  }
  return out;
}

export function sameBlock(a: Block, b: Block): boolean {
  return (
    a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol
  );
}

/** Whether two rectangles share at least one cell. */
export function intersects(a: SelectionRange, b: SelectionRange): boolean {
  const x = normaliseBlock(a);
  const y = normaliseBlock(b);
  return !(x.endRow < y.startRow || x.startRow > y.endRow || x.endCol < y.startCol || x.startCol > y.endCol);
}

/** Whether any two of `blocks` share a cell (Excel then merges nothing). */
export function blocksOverlap(blocks: Block[]): boolean {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (intersects(blocks[i], blocks[j])) return true;
    }
  }
  return false;
}

/** The merged regions that intersect any of `blocks`, each listed once. */
export function regionsTouching(blocks: Block[], regions: MergedRegion[]): MergedRegion[] {
  return regions.filter((r) => blocks.some((b) => intersects(b, r)));
}

/** The smallest rectangle holding every block (null for no blocks). */
export function boundingBox(blocks: Block[]): Block | null {
  if (blocks.length === 0) return null;
  return blocks.reduce((acc, b) => ({
    startRow: Math.min(acc.startRow, b.startRow),
    startCol: Math.min(acc.startCol, b.startCol),
    endRow: Math.max(acc.endRow, b.endRow),
    endCol: Math.max(acc.endCol, b.endCol),
  }));
}

export function isSingleCell(b: Block): boolean {
  return b.startRow === b.endRow && b.startCol === b.endCol;
}

/** Number of cells in a rectangle. */
export function cellCount(b: SelectionRange): number {
  const n = normaliseBlock(b);
  return (n.endRow - n.startRow + 1) * (n.endCol - n.startCol + 1);
}

/** The row indices of a rectangle, start to end. */
export function rowsOf(b: SelectionRange): number[] {
  const n = normaliseBlock(b);
  const out: number[] = [];
  for (let r = n.startRow; r <= n.endRow; r++) out.push(r);
  return out;
}

/** The column indices of a rectangle, start to end. */
export function colsOf(b: SelectionRange): number[] {
  const n = normaliseBlock(b);
  const out: number[] = [];
  for (let c = n.startCol; c <= n.endCol; c++) out.push(c);
  return out;
}
