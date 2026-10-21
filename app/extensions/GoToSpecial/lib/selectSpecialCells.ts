//! FILENAME: app/extensions/GoToSpecial/lib/selectSpecialCells.ts
// PURPOSE: ONE search-and-select for every door to Go To Special: the dialog's
//          OK button and the `goToSpecial.select { criteria }` command that
//          Excel's Find & Select quick items (Formulas, Notes, Conditional
//          Formatting, Constants, Data Validation) run.
// CONTEXT: The search lived inside the dialog's OK handler, so the quick items
//          had nothing to call but the dialog -- which cannot open pre-set --
//          and would have inherited its bounding-box selection (see
//          matchAreas.ts). Moved here so the two doors cannot select
//          differently.
//          P3 (owner finding G3): on a floating grid's cells it searches the
//          OBJECT's cells (goToSpecial with its target, clipped to its extent)
//          and selects the matches in the object (selectTargetCells; several
//          areas ride the selection's additionalRanges).

import {
  goToSpecial,
  getGridStateSnapshot,
  setSelection,
  scrollToCell,
  type GoToSpecialCriteria,
} from "@api/grid";
import { dispatchGridAction } from "@api/gridDispatch";
import { getUsedRange } from "@api/lib";
import { showToast } from "@api/notifications";
import { resolveCellTarget, selectTargetCells, type CellTargetRef } from "@api/cellTarget";
import { selectionForMatches, type MatchedCell, type MatchArea } from "./matchAreas";

/** Every criteria the backend (and @api/grid) accepts, for validating a command's args. */
export const GO_TO_SPECIAL_CRITERIA: readonly GoToSpecialCriteria[] = [
  "blanks",
  "formulas",
  "constants",
  "errors",
  "comments",
  "notes",
  "conditionalFormats",
  "dataValidation",
  "lastCell",
];

export function isGoToSpecialCriteria(value: unknown): value is GoToSpecialCriteria {
  return typeof value === "string" && (GO_TO_SPECIAL_CRITERIA as readonly string[]).includes(value);
}

/**
 * The criteria the backend answers by visiting EVERY cell of the range it is
 * given. The others walk a collection (comments, notes, rules) and cost
 * nothing per empty cell.
 */
const SCANNED_CRITERIA: ReadonlySet<GoToSpecialCriteria> = new Set([
  "blanks",
  "formulas",
  "constants",
  "errors",
]);

/** What happened, for a caller that wants to say so (the dialog's status line). */
export type SelectSpecialOutcome =
  | { kind: "selected"; cells: number; areas: number }
  | { kind: "none" }
  | { kind: "refused"; message: string };

/** Excel's own sentence when nothing matches. */
export const NO_CELLS_FOUND = "No cells were found.";

interface SelectionLike {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  additionalRanges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
}

function normalise(r: { startRow: number; startCol: number; endRow: number; endCol: number }): MatchArea {
  return {
    startRow: Math.min(r.startRow, r.endRow),
    startCol: Math.min(r.startCol, r.endCol),
    endRow: Math.max(r.startRow, r.endRow),
    endCol: Math.max(r.startCol, r.endCol),
  };
}

/**
 * Where to search, Excel's rule: ONE selected cell searches the whole sheet
 * (null); anything more searches inside what is selected -- every area of a
 * multi-area selection, not just Core's main range, which is all the dialog
 * used to look at.
 */
export function searchAreasFor(selection: SelectionLike | null | undefined): MatchArea[] | null {
  if (!selection) return null;
  const areas = [selection, ...(selection.additionalRanges ?? [])].map(normalise);
  const single =
    areas.length === 1 &&
    areas[0].startRow === areas[0].endRow &&
    areas[0].startCol === areas[0].endCol;
  return single ? null : areas;
}

/**
 * Clip a search area to the sheet's used extent, for the criteria the backend
 * answers cell by cell. A whole selected column is a million rows and Select
 * All is seventeen billion cells; the backend's own whole-sheet search already
 * stops at the used extent, and a selection can ask for nothing beyond it
 * either (there is nothing there but blanks Excel does not report: it limits
 * Blanks to the used range too). Returns null when nothing is left.
 */
export function clipToUsedExtent(
  area: MatchArea,
  used: { endRow: number; endCol: number; empty: boolean },
): MatchArea | null {
  if (used.empty) return null;
  const clipped = {
    startRow: area.startRow,
    startCol: area.startCol,
    endRow: Math.min(area.endRow, used.endRow),
    endCol: Math.min(area.endCol, used.endCol),
  };
  if (clipped.endRow < clipped.startRow || clipped.endCol < clipped.startCol) return null;
  return clipped;
}

/**
 * An OBJECT to search instead of the active sheet (a floating grid's cells,
 * P3): its target, and its extent (the cells a search may reach).
 */
export interface SpecialCellsObject {
  ref: CellTargetRef;
  bounds: { rows: number; cols: number };
}

/**
 * Search (within the given areas, or the whole sheet -- or the whole OBJECT)
 * and return every match. With `object`, every criterion is answered over the
 * object's cells (the backend clips to its extent, "lastCell" included) and a
 * scanned area is clipped to the object's extent, never the active sheet's
 * used range.
 */
export async function findSpecialCells(
  criteria: GoToSpecialCriteria,
  areas: MatchArea[] | null,
  object?: SpecialCellsObject,
): Promise<MatchedCell[]> {
  const target = object?.ref;
  if (areas === null || criteria === "lastCell") {
    return (await goToSpecial(criteria, undefined, { target })).cells;
  }
  let searchIn = areas;
  if (SCANNED_CRITERIA.has(criteria)) {
    const used = object
      ? { endRow: object.bounds.rows - 1, endCol: object.bounds.cols - 1, empty: object.bounds.rows <= 0 || object.bounds.cols <= 0 }
      : await getUsedRange();
    searchIn = areas
      .map((a) => clipToUsedExtent(a, used))
      .filter((a): a is MatchArea => a !== null);
  }
  const found: MatchedCell[] = [];
  for (const area of searchIn) {
    const result = await goToSpecial(criteria, area, { target });
    found.push(...result.cells);
  }
  return found;
}

/**
 * Select the cells that match `criteria`, the way Excel's Go To Special and
 * its Find & Select quick items do: exactly the matching cells, the first
 * match active and scrolled into view. Nothing changes when nothing matches
 * (Excel says "No cells were found.").
 *
 * `announce`: whether this function shows the outcome itself (a command has
 * no surface of its own); the dialog passes false and writes its status line.
 */
export async function selectSpecialCells(
  criteria: GoToSpecialCriteria,
  options: { announce?: boolean } = {},
): Promise<SelectSpecialOutcome> {
  const announce = options.announce !== false;
  const refuse = (message: string): SelectSpecialOutcome => {
    if (announce) showToast(message, { variant: "info" });
    return { kind: "refused", message };
  };

  // It searches (inside) the target's selection and REPLACES it: Core's, or
  // a floating grid's own (P3). Any other owner of the selection -- whose
  // Core selection is hidden -- refuses with its sentence (D4, BUG-0185).
  const t = resolveCellTarget("Go To Special", "read");
  if (t === null) {
    return { kind: "refused", message: "The selection belongs to an object." };
  }
  let matches: MatchedCell[];
  if (t.kind === "object") {
    matches = await findSpecialCells(criteria, searchAreasFor(t.selection), { ref: t.ref, bounds: t.bounds });
  } else {
    const snapshot = getGridStateSnapshot();
    // A canvas sheet holds objects, not cells (the View menu's Go To Special is
    // disabled there for the same reason).
    if (snapshot?.surface === "canvas") {
      return refuse("Go To Special is not available on a canvas sheet: it holds objects, not cells.");
    }
    matches = await findSpecialCells(criteria, searchAreasFor(snapshot?.selection));
  }
  let payload;
  try {
    payload = selectionForMatches(matches);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  if (!payload) {
    if (announce) showToast(NO_CELLS_FOUND, { variant: "info" });
    return { kind: "none" };
  }

  if (t.kind === "object") {
    selectTargetCells(t, {
      ...payload,
      type: payload.type ?? "cells",
      activeRow: payload.endRow,
      activeCol: payload.endCol,
    });
  } else {
    dispatchGridAction(setSelection(payload));
    dispatchGridAction(scrollToCell(payload.endRow, payload.endCol, false));
  }
  return {
    kind: "selected",
    cells: matches.length,
    areas: 1 + (payload.additionalRanges?.length ?? 0),
  };
}
