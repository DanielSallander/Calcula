//! FILENAME: app/extensions/FloatingRange/lib/frCellTarget.ts
// PURPOSE: The floating grid as a CELL TARGET (P3, owner finding G3): the
//          cells it holds right now, in the shape every target-aware door acts
//          on (@api/selectionOwner `OwnedCellTarget`), plus the owner's two
//          acts on its own selection and editor (`selectCells`,
//          `editActiveCell`).
// CONTEXT: While a grid's cell (or the grid itself) is selected, Core's
//          selection stays on a sheet cell HIDDEN under it (BUG-0185). The
//          claim used to be able only to refuse. Now a door asks
//          `resolveCellTarget(action, capability)` and, when the grid admits
//          that kind of act (`actsOn`, lib/frKeyRouting.ts), gets THESE cells
//          and passes their `ref` to the wrapper it already calls; the backend
//          resolves the hidden backing sheet by the id, in one place.
//
//          COORDINATES. Local == backing: the grid's A1 is its backing sheet's
//          A1, so the selection is handed over unchanged (clamped to the
//          content extent the user can reach, grown to whole merges).
//
//          STALE ENTRIES. A selection naming a grid the store no longer holds,
//          or one on another sheet than the one shown, answers null -- a door
//          then refuses; it never falls through to Core's hidden cell.

import type { OwnedCellTarget } from "@api/selectionOwner";
import type { Selection } from "@api/types";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getFloatingRangeById, getFrActiveSheetIndex } from "./floatingRangeStore";
import {
  getLocalSelection,
  getSelectedFloatingRange,
  selectFloatingRange,
  setLocalSelection,
  type FrCellArea,
} from "./frSelection";
import { frContentExtent } from "./frExtent";
import { frTargetRef } from "./frCellReads";
import { frExpandToMerges } from "../rendering/frRenderer";
import { ensureFrCellVisible } from "./frView";
import { getFrEditorCell, isFrEditorOpen, openFrEditor } from "../editor/frEditor";

/** The grid the selection belongs to right now (cells or the object), on the sheet shown; null otherwise. */
function owningGridId(): string | null {
  const id = getLocalSelection()?.frId ?? getSelectedFloatingRange();
  if (!id) return null;
  const entry = getFloatingRangeById(id);
  if (!entry || entry.sheetIndex !== getFrActiveSheetIndex()) return null;
  return id;
}

function clampArea(a: FrCellArea, rows: number, cols: number): FrCellArea {
  const clampR = (r: number) => Math.max(0, Math.min(rows - 1, r));
  const clampC = (c: number) => Math.max(0, Math.min(cols - 1, c));
  return {
    startRow: clampR(Math.min(a.startRow, a.endRow)),
    startCol: clampC(Math.min(a.startCol, a.endCol)),
    endRow: clampR(Math.max(a.startRow, a.endRow)),
    endCol: clampC(Math.max(a.startCol, a.endCol)),
  };
}

/**
 * THE OWNER'S ANSWER (`SelectionOwner.cellTarget`): the cells of the grid that
 * holds the selection, or null.
 *
 *   - `bounds` is the grid's CONTENT extent (window grown to the used range,
 *     capped): the extent the user reaches by scrolling, and the most a door
 *     may act on.
 *   - A selected CELL range: its main rectangle (grown to whole merges, with
 *     the ACTIVE cell -- where F2 edits -- as `activeRow/activeCol`) and any
 *     further areas as `additionalRanges`.
 *   - Only the OBJECT selected: `wholeObject`, the whole window, active (0,0).
 */
export function frCellTarget(): OwnedCellTarget | null {
  const id = owningGridId();
  if (!id) return null;
  const entry = getFloatingRangeById(id);
  if (!entry) return null;
  const extent = frContentExtent(entry);
  const base = {
    ref: frTargetRef(id),
    bounds: { rows: extent.rows, cols: extent.cols },
    label: entry.name,
  };

  const local = getLocalSelection();
  if (!local || local.frId !== id) {
    const whole: Selection = {
      startRow: 0,
      startCol: 0,
      endRow: Math.min(entry.rows, extent.rows) - 1,
      endCol: Math.min(entry.cols, extent.cols) - 1,
      type: "cells",
      activeRow: 0,
      activeCol: 0,
    };
    return { ...base, selection: whole, wholeObject: true };
  }

  const activeRow = Math.max(0, Math.min(extent.rows - 1, local.anchorRow));
  const activeCol = Math.max(0, Math.min(extent.cols - 1, local.anchorCol));
  const main = clampArea(
    frExpandToMerges(id, {
      startRow: local.anchorRow,
      startCol: local.anchorCol,
      endRow: local.endRow,
      endCol: local.endCol,
    }),
    extent.rows,
    extent.cols,
  );
  const extra = (local.areas ?? []).map((a) => clampArea(frExpandToMerges(id, a), extent.rows, extent.cols));
  const selection: Selection = {
    startRow: main.startRow,
    startCol: main.startCol,
    endRow: main.endRow,
    endCol: main.endCol,
    type: "cells",
    activeRow,
    activeCol,
    ...(extra.length > 0 ? { additionalRanges: extra } : {}),
  };
  return { ...base, selection, wholeObject: false };
}

/**
 * Replace the grid's own cell selection (`SelectionOwner.selectCells`): a Find
 * match, a Go To Special result (several areas ride `additionalRanges`), a
 * paste result. The ACTIVE cell is `activeRow/activeCol` (else `endRow/endCol`,
 * the one active-cell rule); the main rectangle keeps it as its anchor.
 * Clamped to the content extent; the active cell is scrolled into view.
 */
export function frSelectCells(selection: Selection): void {
  const id = owningGridId();
  if (!id) return;
  const entry = getFloatingRangeById(id);
  if (!entry) return;
  const extent = frContentExtent(entry);
  const rect = clampArea(selection, extent.rows, extent.cols);
  const clampR = (r: number) => Math.max(rect.startRow, Math.min(rect.endRow, r));
  const clampC = (c: number) => Math.max(rect.startCol, Math.min(rect.endCol, c));
  const anchorRow = clampR(selection.activeRow ?? selection.endRow);
  const anchorCol = clampC(selection.activeCol ?? selection.endCol);
  // The FR model keeps the active cell as the anchor and the OTHER corner as
  // the moving end, so the rectangle survives whenever the active cell is on
  // its edge (always, for a merge or a single cell).
  const endRow = anchorRow - rect.startRow <= rect.endRow - anchorRow ? rect.endRow : rect.startRow;
  const endCol = anchorCol - rect.startCol <= rect.endCol - anchorCol ? rect.endCol : rect.startCol;
  const areas = (selection.additionalRanges ?? []).map((a) => clampArea(a, extent.rows, extent.cols));
  selectFloatingRange(id);
  setLocalSelection({ frId: id, anchorRow, anchorCol, endRow, endCol, ...(areas.length > 0 ? { areas } : {}) });
  ensureFrCellVisible(entry, anchorRow, anchorCol);
  requestOverlayRedraw();
}

/**
 * Open the grid's OWN in-cell editor on its active cell, seeded with `text`
 * (`SelectionOwner.editActiveCell`: Insert Function's "=", AutoSum's guess).
 * True only when the editor is open on that cell afterwards.
 */
export function frEditActiveCell(text: string): boolean {
  const local = getLocalSelection();
  const id = owningGridId();
  if (!local || !id || local.frId !== id) return false;
  const entry = getFloatingRangeById(id);
  if (!entry) return false;
  ensureFrCellVisible(entry, local.anchorRow, local.anchorCol);
  openFrEditor(id, local.anchorRow, local.anchorCol, text);
  const editing = getFrEditorCell();
  return (
    isFrEditorOpen() &&
    editing !== null &&
    editing.frId === id &&
    editing.row === local.anchorRow &&
    editing.col === local.anchorCol
  );
}
