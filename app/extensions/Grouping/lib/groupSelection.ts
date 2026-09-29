//! FILENAME: app/extensions/Grouping/lib/groupSelection.ts
// PURPOSE: Group / Ungroup the rows (or, for a column selection, the columns)
//          of Core's selection -- ONCE, for every door: Data > Outline, the
//          grid context menu, and the grouping.group / grouping.ungroup
//          commands the keybinding registry's Alt+Shift+Right / Left run.
// CONTEXT: D4 (BUG-0185 class). While something other than Core's grid owns
//          the selection -- a floating grid's selected cell -- Core's
//          selection is HIDDEN under it, and Data > Group grouped ITS rows.
//          Each action asks @api/selectionOwner first and refuses with one
//          toast. The menu, the context menu and the commands each carried a
//          copy of this logic before; one copy per door is how a door misses
//          a check.

import { refuseIfSelectionOwned } from "@api/selectionOwner";
import {
  performGroupRows,
  performUngroupRows,
  performGroupColumns,
  performUngroupColumns,
} from "./groupingStore";

/** A selection as the doors hand it over (anchor -> active, any direction). */
export interface GroupingSelection {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  type?: string;
}

/** Normalize so startRow <= endRow and startCol <= endCol. */
export function normalizeRange(sel: GroupingSelection): {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    endRow: Math.max(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

/** Group the selection's rows (its columns for a column selection). */
export async function groupSelection(sel: GroupingSelection | null): Promise<void> {
  if (refuseIfSelectionOwned("Group")) return;
  if (!sel) return;
  const norm = normalizeRange(sel);
  if (sel.type === "columns") {
    await performGroupColumns(norm.startCol, norm.endCol);
  } else {
    await performGroupRows(norm.startRow, norm.endRow);
  }
}

/** Ungroup the selection's rows (its columns for a column selection). */
export async function ungroupSelection(sel: GroupingSelection | null): Promise<void> {
  if (refuseIfSelectionOwned("Ungroup")) return;
  if (!sel) return;
  const norm = normalizeRange(sel);
  if (sel.type === "columns") {
    await performUngroupColumns(norm.startCol, norm.endCol);
  } else {
    await performUngroupRows(norm.startRow, norm.endRow);
  }
}
