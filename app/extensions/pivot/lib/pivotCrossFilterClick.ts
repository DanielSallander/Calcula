//! FILENAME: app/extensions/Pivot/lib/pivotCrossFilterClick.ts
// PURPOSE: A canvas BI pivot box as a cross-filter SOURCE (P4, G4, S7): what a
//          click on one of its cells -- a row header, a column header or a
//          data cell -- does to the page's visual selections
//          (@api/reportFilters). The grammar is the charts' (S6,
//          Charts/handlers/crossFilterClick.ts), Power BI's:
//
//            plain click            replaces EVERY selection on the page with
//                                   this box's one tuple;
//            plain click on the     clears this box's selection;
//            sole selected cell
//            Ctrl+click             toggles the tuple within this box and keeps
//                                   every other source (AND);
//            a cell naming no       does nothing, and says so once per pivot
//            member                 (a grand total, a corner, a filter cell, a
//                                   view that carries no `groupMembers`).
//
//          A cell's MemberPath is its `groupPath` -- [fieldIndex, valueId]
//          pairs, rows then columns -- mapped through the view's
//          `groupMembers` to member KEYS ("Table.Column" + key, P2's one key
//          function). A pair whose field has no `groupMembers` entry is not a
//          model member (the value field, a calculation group's items) and is
//          left out; a pair whose field HAS an entry but whose valueId is not
//          in it names a member the view did not key, and the click filters
//          nothing rather than a narrower tuple the user did not click.
// CONTEXT: Called by the box's cell press at its RELEASE over the press cell
//          (pivotCellPress.ts `onClick`), outside Design Mode, never for a
//          Shift-extend or a drag (pivotVisualOverlay.ts arms it). The press
//          keeps its cell-selection behaviour; this only adds the selection.
//          Pure apart from the seam calls; view state only (no undo, no
//          dirty flag).

import {
  addToCrossFilter,
  clearCrossFilter,
  getCrossFilters,
  setCrossFilter,
  type CrossFilterSelection,
  type MemberCoord,
  type MemberPath,
} from "@api/reportFilters";
import type { PivotCellData, PivotViewResponse } from "./pivot-api";
import { getPivotViewRow } from "./pivotChromeActions";
import { getDisplayedPivotView, pivotVisualRef } from "./pivotCrossFilterView";
import { getPivotBox, pivotBoxSheetId, pivotModelInfo } from "./pivotModelVisuals";

/** What a released cell press did (the tests and the console read it). */
export type PivotCrossFilterClickOutcome = "selected" | "toggled" | "cleared" | "noPaths" | "ignored";

/** The cell types a click cross-filters from (spec S7: headers and data cells). */
const SOURCE_CELL_TYPES = new Set<PivotCellData["cellType"]>(["RowHeader", "ColumnHeader", "Data"]);

/**
 * The member path a cell names under `view`, or null when it names none: not a
 * header or data cell, no group path, a view without `groupMembers`, a model
 * field's valueId the view did not key, an empty path, or a field twice.
 */
export function pivotCellMemberPath(cell: PivotCellData | null | undefined, view: PivotViewResponse | null | undefined): MemberPath | null {
  if (!cell || !view || !SOURCE_CELL_TYPES.has(cell.cellType)) return null;
  const groups = view.groupMembers;
  if (!groups || groups.length === 0 || !cell.groupPath || cell.groupPath.length === 0) return null;
  const path: MemberCoord[] = [];
  for (const [fieldIndex, valueId] of cell.groupPath) {
    const group = groups.find((g) => g.fieldIndex === fieldIndex);
    if (!group) continue; // the value field, a calculation group: not a model member
    const hit = group.members.find(([vid]) => vid === valueId);
    if (!hit) return null;
    path.push({ field: group.fieldKey, key: hit[1] });
  }
  if (path.length === 0) return null;
  if (new Set(path.map((c) => c.field)).size !== path.length) return null;
  return path;
}

/** Pivots already told their cells name no member (one console line each). */
const noPathsNoted = new Set<string>();

/** Forget the "said once" notes (tests). */
export function resetPivotCrossFilterClickNotes(): void {
  noPathsNoted.clear();
}

function noteNoPaths(pivotId: string): void {
  if (noPathsNoted.has(pivotId)) return;
  noPathsNoted.add(pivotId);
  console.warn(
    `[Pivot] PivotTable "${pivotId}": this cell names no model member (a total, or a view without member keys), so the click filters nothing.`,
  );
}

/** Whether `held` is exactly the one tuple `path` names. */
function isSoleTuple(held: CrossFilterSelection, path: MemberPath): boolean {
  if (held.tuples.length !== 1 || held.fields.length !== path.length) return false;
  const tuple = held.tuples[0];
  return held.fields.every((f, i) => {
    const coord = path.find((c) => c.field === f);
    return !!coord && coord.key === tuple[i];
  });
}

/**
 * Run the gesture for one released click on view cell (`viewRow`, `viewCol`)
 * of `pivotId`'s box -- the cell as the box SHOWS it (a box that is itself
 * filtered by another visual shows a filtered view, whose groupPaths its own
 * `groupMembers` key).
 */
export function applyPivotCrossFilterClick(input: {
  pivotId: string;
  viewRow: number;
  viewCol: number;
  ctrl: boolean;
}): PivotCrossFilterClickOutcome {
  const { pivotId, viewRow, viewCol, ctrl } = input;
  const box = getPivotBox(pivotId);
  const info = pivotModelInfo(pivotId);
  if (!box || !box.isModel || !info) return "ignored";
  const pageSheetId = pivotBoxSheetId(box);
  if (!pageSheetId) return "ignored";

  const view = getDisplayedPivotView(pivotId);
  if (!view) return "ignored";
  const cell = getPivotViewRow(pivotId, view, viewRow)?.cells[viewCol] ?? null;
  const path = pivotCellMemberPath(cell, view);
  if (!path) {
    noteNoPaths(pivotId);
    return "noPaths";
  }

  const ref = pivotVisualRef(pivotId);
  const fresh: CrossFilterSelection = {
    source: ref,
    sourceName: box.name,
    pageSheetId,
    connectionId: info.connectionId,
    fields: path.map((c) => c.field),
    tuples: [path.map((c) => c.key)],
  };
  const held = getCrossFilters().find((s) => s.source.kind === ref.kind && s.source.id === ref.id);

  if (ctrl) {
    if (held && held.pageSheetId === pageSheetId && held.connectionId === info.connectionId) {
      addToCrossFilter(ref, path);
    } else {
      setCrossFilter(fresh);
    }
    return "toggled";
  }

  if (held && held.pageSheetId === pageSheetId && isSoleTuple(held, path)) {
    clearCrossFilter(ref);
    return "cleared";
  }

  for (const other of getCrossFilters(pageSheetId)) {
    if (other.source.kind === ref.kind && other.source.id === ref.id) continue;
    clearCrossFilter(other.source);
  }
  setCrossFilter(fresh);
  return "selected";
}
