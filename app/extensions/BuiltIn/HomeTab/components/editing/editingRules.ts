//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/editingRules.ts
// PURPOSE: The pure rule behind the Fill menu's greyed rows: when a Fill
//          direction has nothing to copy. (The blocks a selection is made of
//          are `@api/selectionBlocks`, the one split Core's clears and every
//          Home formatting door use; this file's copy was folded into it on
//          2026-10-04.)
// CONTEXT: Kept apart from the components so the rules are tested without
//          React, and so each says where its truth comes from.
//
//          WHY THE RIBBON GREYS ROWS AT ALL. Excel does (measured live, Excel
//          16 build 20430, 2026-10-04, GetEnabledMso in a fresh workbook --
//          scratchpad home-editing-probe/): Fill Down is grey in row 1, Remove
//          Hyperlinks is grey without a link, Clear Comments and Notes without a
//          note or comment. The commands themselves already do NOTHING in those
//          cases (Core's fill has no source; Remove Hyperlinks opens no undo
//          step without a link), so a live row there is a button that silently
//          does nothing -- the one thing a ribbon must never be.

import type { Selection } from "@api/types";

import { normaliseBlock } from "@api/selectionBlocks";

export type FillDirection = "down" | "right" | "up" | "left";

/**
 * What the Fill menu's greying reads: the selection the fill ACTS on and the
 * extent it can go to. A selection owner (a floating grid's cells) answers
 * with its OWN selection and its own window (`bounds`); Core's selection is
 * then hidden and says nothing about the act. "refused": the owner refuses
 * the fill -- the rows stay enabled so the command can say why, once.
 */
export function fillSourceView(
  target:
    | { kind: "grid"; selection: Selection | null }
    | { kind: "object"; selection: Selection; bounds: { rows: number; cols: number } }
    | { refusal: string },
  gridSelection: Selection | null | undefined,
  config: { totalRows: number; totalCols: number },
): { selection: Selection | null | undefined; totalRows: number; totalCols: number } | "refused" {
  if ("refusal" in target) return "refused";
  if (target.kind === "object") {
    return { selection: target.selection, totalRows: target.bounds.rows, totalCols: target.bounds.cols };
  }
  return { selection: gridSelection, totalRows: config.totalRows, totalCols: config.totalCols };
}

/**
 * Whether Fill <direction> has something to copy over the selection's MAIN
 * range (the one range Core's fill acts on).
 *
 * Excel's rule, measured (probe1.out): a direction is greyed exactly when the
 * selection is ONE row (column) on the edge it would copy from --
 *   Down : one row in row 1          Up   : one row in the last row
 *   Right: one column in column A    Left : one column in the last column
 * -- because several rows (columns) copy their OWN first row (column), and one
 * row elsewhere copies its neighbour. A1 greys Down and Right; A1:A3 only
 * Right; A1:C1 only Down; row 1:1 only Down; A1048576 only Up (and
 * A1048575:A1048576 nothing); XFD5 only Left; B2 and B:B nothing.
 *
 * That is also exactly when Core's `fillPlan` (core/lib/fillCommands) returns
 * no plan and the command does nothing, so this greys precisely the rows that
 * would be dead. It is a second statement of that rule, because Core's is not
 * reachable through @api (still true after the 2026-10-04 review wave: the
 * core lane exported the fill PLANNER, @api/fillPatterns' planFillLine, but
 * not this "is there a source" predicate); it should be exported so this copy
 * can go. `totalRows` / `totalCols` are the SHEET's (grid config),
 * not Excel's constants.
 */
export function fillHasSource(
  direction: FillDirection,
  selection: Selection | null | undefined,
  totalRows: number,
  totalCols: number,
): boolean {
  if (!selection) return false;
  const { startRow: r0, startCol: c0, endRow: r1, endCol: c1 } = normaliseBlock(selection);
  switch (direction) {
    case "down":
      return r1 > r0 || r0 > 0;
    case "up":
      return r1 > r0 || r1 < totalRows - 1;
    case "right":
      return c1 > c0 || c0 > 0;
    case "left":
      return c1 > c0 || c1 < totalCols - 1;
  }
}

// ============================================================================
// Sort & Filter's row labels
// ============================================================================
//
// Excel relabels Home > Sort & Filter's two sort rows by what the sort key
// holds -- the commands are the same. Measured live (Excel 16 build 20430,
// 2026-10-04, UI Automation on the open menu of a fresh off-screen instance;
// scratchpad fix-home-probe/sortlabels.out, sortlabels2.out):
//
//   ONE CELL selected: the active cell's own value. A number, a number
//   formula, a time (hh:mm), TRUE, a percent, a currency -> Smallest to
//   Largest; a date (=DATE(...) or a typed yyyy-mm-dd) -> Oldest to Newest;
//   text, a formula giving text, an EMPTY cell -> A to Z.
//
//   A RANGE: the active cell's column over the range, not the active cell.
//   Any text there -> A to Z (A1:A3 = 42, a date, "text" with the NUMBER
//   active); all dates -> Oldest to Newest; otherwise -> Smallest to Largest
//   (dates mixed with numbers, either one active, are numbers). A text first
//   row over non-text data is a HEADER and does not count: F1:F4 = "Header",
//   20, 30, 40 is Smallest to Largest even with the header active. Empty
//   cells do not count.

/** What a sort key holds, as far as the labels go. */
export type SortValueKind = "text" | "number" | "date";

/** Excel's two row labels per kind. */
export const SORT_LABELS: Readonly<Record<SortValueKind, { ascending: string; descending: string }>> = {
  text: { ascending: "Sort A to Z", descending: "Sort Z to A" },
  number: { ascending: "Sort Smallest to Largest", descending: "Sort Largest to Smallest" },
  date: { ascending: "Sort Oldest to Newest", descending: "Sort Newest to Oldest" },
};

/** One non-empty cell of the sort key's column, as the menu read it. */
export interface SortKeyCell {
  row: number;
  kind: SortValueKind;
}

/**
 * The labels' kind for the key column's non-empty `cells` (any order), the
 * block's `topRow`, and whether the selection is ONE cell (see above).
 */
export function sortKindOf(cells: readonly SortKeyCell[], topRow: number, single: boolean): SortValueKind {
  const data = [...cells].sort((a, b) => a.row - b.row);
  if (single) return data[0]?.kind ?? "text";
  // A header: text on the block's top row over data that is not all text.
  if (data.length > 1 && data[0].row === topRow && data[0].kind === "text" && data.slice(1).some((c) => c.kind !== "text")) {
    data.shift();
  }
  if (data.length === 0 || data.some((c) => c.kind === "text")) return "text";
  return data.every((c) => c.kind === "date") ? "date" : "number";
}

/** The backend's display names that are NOT a date (get_style reports a
 *  name for every typed format and the raw code for a custom one). */
const NOT_DATE_NAME = /^(General|Time|Number|Currency|Accounting|Percentage|Scientific|Fraction)\b/;

/**
 * Whether a cell's number format (as get_style names it) shows a DATE: the
 * backend's "Date (...)" names, the regional `[$-x-sysdate]` handle, and a
 * custom code with a year or day token outside quotes, escapes and brackets.
 * A time-only code is not a date (Excel labels a time cell Smallest to
 * Largest); a date-time code is.
 */
export function isDateFormatName(numberFormat: string): boolean {
  if (numberFormat.startsWith("Date (")) return true;
  if (NOT_DATE_NAME.test(numberFormat)) return false;
  if (/x-sysdate/i.test(numberFormat)) return true;
  const code = numberFormat
    .replace(/"[^"]*"/g, "")
    .replace(/\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[yd]/i.test(code);
}
