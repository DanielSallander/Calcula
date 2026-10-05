//! FILENAME: app/extensions/GoToSpecial/lib/matchAreas.ts
// PURPOSE: Turn the cells Go To Special FOUND into the selection that holds
//          exactly those cells -- one rectangle per block of matches, never the
//          rectangle AROUND them.
// CONTEXT: The dialog used to select the BOUNDING BOX of the matches as Core's
//          main range and add the individual cells as extra ranges (and only
//          when there were 1000 or fewer). The main range is a real selected
//          range -- Clear Contents, Delete, Fill, Format all act on it -- so
//          "Constants, then Delete", the classic Excel use of this dialog,
//          ALSO cleared every formula inside that box. Pure on purpose: the
//          shape of the selection is the whole defect, and it is asserted here
//          without a grid, a dialog or a backend.

import type { SetSelectionPayload } from "@api/grid";

/** One matched cell, as the backend reports it. */
export interface MatchedCell {
  row: number;
  col: number;
}

/** A rectangle of matched cells (inclusive bounds). */
export interface MatchArea {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * The most areas one Go To Special may select.
 *
 * Excel has no such limit, and nothing here pretends to be Excel about it: a
 * scattered result (a checkerboard of constants) produces one area per cell,
 * and every area is a rectangle the renderer, the hit-tester and each
 * multi-area consumer walk on every frame. Past this many the honest answer
 * is a refusal that says so -- the old answer, a bounding box, selected cells
 * that did NOT match, and that is the one outcome this file exists to rule out.
 */
export const MAX_MATCH_AREAS = 10_000;

/**
 * Group matched cells into rectangles: runs of adjacent columns within a row,
 * then runs of IDENTICAL column spans on consecutive rows merged into one
 * block. Every cell of every returned area is a matched cell, and every
 * matched cell is in exactly one area -- the two properties a selection built
 * from them must have.
 *
 * Excel's own grouping differs in which way it cuts an L-shape (it reported
 * `B1:C1 ; A1:A3` for an L where this reports `A1:C1 ; A2:A3`, measured live
 * 2026-10-04); the cells selected are the same, and the cut is cosmetic.
 *
 * Duplicates are tolerated (a multi-area search can report a cell twice where
 * the areas overlap). Areas come back in reading order: by top row, then left
 * column.
 */
export function groupMatchedCells(cells: readonly MatchedCell[]): MatchArea[] {
  if (cells.length === 0) return [];

  // Row-major, de-duplicated.
  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
  const unique: MatchedCell[] = [];
  for (const c of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last.row !== c.row || last.col !== c.col) unique.push(c);
  }

  const closed: MatchArea[] = [];
  // Open blocks, keyed by their column span, that the previous row extended.
  let open = new Map<string, MatchArea>();

  let i = 0;
  while (i < unique.length) {
    const row = unique[i].row;
    // This row's runs of adjacent columns.
    const runs: Array<{ startCol: number; endCol: number }> = [];
    while (i < unique.length && unique[i].row === row) {
      const startCol = unique[i].col;
      let endCol = startCol;
      i++;
      while (i < unique.length && unique[i].row === row && unique[i].col === endCol + 1) {
        endCol++;
        i++;
      }
      runs.push({ startCol, endCol });
    }

    const next = new Map<string, MatchArea>();
    for (const run of runs) {
      const key = `${run.startCol}:${run.endCol}`;
      const block = open.get(key);
      if (block && block.endRow === row - 1) {
        block.endRow = row;
        open.delete(key);
        next.set(key, block);
      } else {
        next.set(key, { startRow: row, startCol: run.startCol, endRow: row, endCol: run.endCol });
      }
    }
    // Whatever this row did not continue is finished.
    for (const block of open.values()) closed.push(block);
    open = next;
  }
  for (const block of open.values()) closed.push(block);

  return closed.sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol);
}

/**
 * The selection that holds exactly the matched cells: the first area (in
 * reading order) is Core's main range and every other area an additional
 * range. The ACTIVE cell -- Core's `endRow`/`endCol` -- is the first area's
 * top-left cell, the first match, which is the cell Excel makes active (the
 * first cell of the first area). So the main range is written anchor-at-the-
 * far-corner; every consumer normalises a range with min/max.
 *
 * Returns null for no matches, and throws when there are more areas than
 * MAX_MATCH_AREAS (see there).
 */
export function selectionForMatches(cells: readonly MatchedCell[]): SetSelectionPayload | null {
  const areas = groupMatchedCells(cells);
  if (areas.length === 0) return null;
  if (areas.length > MAX_MATCH_AREAS) {
    throw new Error(
      `Go To Special found ${cells.length.toLocaleString("en-US")} cells in ` +
        `${areas.length.toLocaleString("en-US")} separate areas, more than can be selected at once ` +
        `(${MAX_MATCH_AREAS.toLocaleString("en-US")}). Select a smaller range first and try again.`,
    );
  }
  const [first, ...rest] = areas;
  return {
    startRow: first.endRow,
    startCol: first.endCol,
    endRow: first.startRow,
    endCol: first.startCol,
    type: "cells",
    additionalRanges: rest.length > 0 ? rest.map((a) => ({ ...a })) : undefined,
  };
}
