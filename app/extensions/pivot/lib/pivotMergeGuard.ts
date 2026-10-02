//! FILENAME: app/extensions/Pivot/lib/pivotMergeGuard.ts
// PURPOSE: Merging or unmerging cells of a PivotTable is refused: a refresh
//          rewrites the pivot's whole area, including the label merges it
//          writes itself, so a merge made by hand would be silently undone (or
//          would break the pivot's own).
// CONTEXT: Registered on the four merge grid commands through the
//          feature-neutral gridCommands.registerGuard door, with Excel's own
//          PivotTable refusal text (the one the structural guards already
//          show). NOT VERIFIED against Excel for merges specifically -- Excel's
//          merge behaviour inside a PivotTable was not researched; recorded in
//          docs/design/open-items.md.

import type { Selection } from "@api/types";

/** The grid commands this guard sits on. */
export const PIVOT_MERGE_GUARDED_COMMANDS = ["mergeCells", "mergeCenter", "mergeAcross", "unmergeCells"] as const;

interface Rect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  const top = Math.min(a.startRow, a.endRow);
  const bottom = Math.max(a.startRow, a.endRow);
  const left = Math.min(a.startCol, a.endCol);
  const right = Math.max(a.startCol, a.endCol);
  return !(bottom < b.startRow || top > b.endRow || right < b.startCol || left > b.endCol);
}

/**
 * `true` when no block of the selection touches a pivot region on this sheet,
 * else `refusal`. EVERY block is checked (the existing structural guards read
 * only the main range; a Ctrl+click selection merges each block).
 */
export function pivotMergeGuard(
  selection: Selection | null,
  regions: readonly Rect[],
  refusal: string,
): true | string {
  if (!selection || regions.length === 0) return true;
  const blocks: Rect[] = [selection, ...(selection.additionalRanges ?? [])];
  return blocks.some((b) => regions.some((r) => overlaps(b, r))) ? refusal : true;
}
