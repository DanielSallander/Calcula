//! FILENAME: app/src/core/lib/sheetRowsColumns/spans.ts
// PURPOSE: The rows / columns a selection SPANS -- what Excel's Insert Sheet
//          Rows / Columns and Delete Sheet Rows / Columns act on.
// CONTEXT: Excel's commands act on `Selection.EntireRow` (or EntireColumn),
//          whatever the selection's shape: one cell, a range, whole rows, or
//          several Ctrl+click blocks. Calcula's four grid commands returned early
//          unless whole rows (or columns) were selected, so the Home tab's
//          buttons did nothing on an ordinary cell selection while
//          gridCommands.execute still reported success.
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-04):
// - A block spans the rows (columns) between its edges: B3:C4 inserts TWO rows
//   above row 3.
// - Each Ctrl+click block is its own insertion / deletion: A2 + A5 inserts a
//   row above row 2 AND one above row 5 (the data reads 1,_,2,3,4,_,5).
// - Two blocks whose spans share a row (A3 + C3 for the row commands) are
//   refused whole: "Cannot use that command on overlapping selections."
//   Adjacent blocks (A2 + A3) do not overlap.
// No IPC, no state: unit-testable on its own.

import type { Selection } from "../../types";
import { selectionBlocks } from "../merge/mergeGeometry";

/** Which edge of the sheet a structural command works along. */
export type SheetAxis = "rows" | "columns";

/** A run of whole rows (or columns): the first index and how many. */
export interface IndexSpan {
  start: number;
  count: number;
}

/** The spans, in sheet order -- or why there are none to act on. */
export type SpanAnswer = { ok: true; spans: IndexSpan[] } | { ok: false; reason: "overlap" };

/**
 * The rows (`"rows"`) or columns (`"columns"`) every block of `selection`
 * spans, ascending, one span per block. Two blocks that share a row (column)
 * answer `overlap`, which the commands refuse as Excel does. An exact repeat
 * of a block (the same cell Ctrl+clicked twice) is one block, not an overlap
 * (selectionBlocks drops it).
 */
export function sheetSpans(selection: Selection | null | undefined, axis: SheetAxis): SpanAnswer {
  const spans = selectionBlocks(selection)
    .map((b) =>
      axis === "rows"
        ? { start: b.startRow, count: b.endRow - b.startRow + 1 }
        : { start: b.startCol, count: b.endCol - b.startCol + 1 },
    )
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1];
    if (spans[i].start <= previous.start + previous.count - 1) {
      return { ok: false, reason: "overlap" };
    }
  }
  return { ok: true, spans };
}
