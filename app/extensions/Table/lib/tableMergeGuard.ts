//! FILENAME: app/extensions/Table/lib/tableMergeGuard.ts
// PURPOSE: Excel refuses to merge cells of a table: every Merge command is
//          disabled when the selection touches one, even half of one.
// CONTEXT: Registered on the four merge grid commands (mergeCells,
//          mergeCenter, mergeAcross, unmergeCells) through the feature-neutral
//          gridCommands.registerGuard door -- the ribbon, Ctrl+M and scripts
//          all pass through it. The Home tab also greys its Merge button from
//          the published "table" grid regions; this guard is the backstop for
//          every other way in.

import type { Selection } from "@api/types";

/** What the refusal says. */
export const TABLE_MERGE_REFUSAL = "Cells in a table can't be merged. Convert the table to a range first.";

/** The grid commands this guard sits on. */
export const TABLE_MERGE_GUARDED_COMMANDS = ["mergeCells", "mergeCenter", "mergeAcross", "unmergeCells"] as const;

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
 * `true` when no block of the selection touches a table, else the refusal.
 * EVERY block is checked (a Ctrl+click selection merges each block), not just
 * the main range.
 */
export function tableMergeGuard(selection: Selection | null, tables: readonly Rect[]): true | string {
  if (!selection || tables.length === 0) return true;
  const blocks: Rect[] = [selection, ...(selection.additionalRanges ?? [])];
  return blocks.some((b) => tables.some((t) => overlaps(b, t))) ? TABLE_MERGE_REFUSAL : true;
}
