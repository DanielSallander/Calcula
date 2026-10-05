//! FILENAME: app/extensions/Pivot/lib/pivotStructuralGuard.ts
// PURPOSE: Insert / Delete Sheet Rows / Columns that would cut into a
//          PivotTable are refused -- for EVERY block of the selection.
// CONTEXT: Registered on the four row/column grid commands through the
//          feature-neutral gridCommands.registerGuard door, with Excel's own
//          PivotTable refusal text (index.ts passes it in).
//
//          The four commands act on the rows / columns EVERY Ctrl+click block
//          spans (Excel's Insert Sheet Rows over A2 + A5 inserts a row above
//          row 2 AND one above row 5; core/lib/sheetRowsColumns since the Home
//          tab programme, 2026-10-04). The guards used to read only the main
//          range, which was right while the commands did too: with a cell
//          outside a pivot selected and a cell inside it Ctrl+clicked, Delete
//          Sheet Rows was let through here and the pivot's row went -- only
//          the backend's own handling stood behind it. So every block is
//          judged now, exactly as pivotMergeGuard.ts judges the merges.
//
//          Each block keeps the rule the guard always applied to the main
//          range, unchanged:
//            - INSERT is refused only strictly inside a pivot: an insertion at
//              a pivot's first row (column) shifts the whole pivot down
//              (right), which is safe;
//            - DELETE is refused on any overlap: deleting any pivot row
//              (column) is destructive.
//          Judging each block against the regions AS THEY STAND is exact,
//          because Core applies the blocks bottom-up (right-to-left): a lower
//          block's insertion or deletion never moves a pivot that sits above a
//          higher block, so every block meets the pivots where they are now.
//
//          The regions are read when a guard RUNS (a getter), never captured at
//          activation, so a pivot created later is guarded too.

import type { Selection } from "@api/types";

/** The grid commands this guard sits on. */
export const PIVOT_STRUCTURAL_GUARDED_COMMANDS = ["insertRow", "deleteRow", "insertColumn", "deleteColumn"] as const;

export type PivotStructuralCommand = (typeof PIVOT_STRUCTURAL_GUARDED_COMMANDS)[number];

interface Rect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The slice of the gridCommands door this module needs (injected for tests). */
export interface StructuralGuardDoor {
  registerGuard(commands: PivotStructuralCommand[], guard: (selection: Selection | null) => true | string): () => void;
}

/** Every block of the selection: the main range and each Ctrl+click block. */
function selectionBlocks(selection: Selection): Rect[] {
  return [selection, ...(selection.additionalRanges ?? [])];
}

/** Whether ONE block, on ONE command's axis, cuts into `region` (the rules above). */
function blockCutsInto(command: PivotStructuralCommand, block: Rect, region: Rect): boolean {
  const rows = command === "insertRow" || command === "deleteRow";
  const first = rows ? Math.min(block.startRow, block.endRow) : Math.min(block.startCol, block.endCol);
  const last = rows ? Math.max(block.startRow, block.endRow) : Math.max(block.startCol, block.endCol);
  const regionFirst = rows ? region.startRow : region.startCol;
  const regionLast = rows ? region.endRow : region.endCol;
  if (command === "insertRow" || command === "insertColumn") {
    // Strictly inside: the insertion point (or any line the block spans past
    // it) lies within the pivot below its first line.
    return first <= regionLast && last > regionFirst;
  }
  return first <= regionLast && last >= regionFirst;
}

/**
 * `true` when no block of the selection cuts into a pivot region on this sheet
 * for `command`, else `refusal`.
 */
export function pivotStructuralGuard(
  command: PivotStructuralCommand,
  selection: Selection | null,
  regions: readonly Rect[],
  refusal: string,
): true | string {
  if (!selection || regions.length === 0) return true;
  const cuts = selectionBlocks(selection).some((block) =>
    regions.some((region) => blockCutsInto(command, block, region)),
  );
  return cuts ? refusal : true;
}

/**
 * Register one guard per row/column command (each judging its own command's
 * rule over every block). Returns the release of all four.
 */
export function registerPivotStructuralGuards(
  door: StructuralGuardDoor,
  regions: () => readonly Rect[],
  refusal: string,
): () => void {
  const releases = PIVOT_STRUCTURAL_GUARDED_COMMANDS.map((command) =>
    door.registerGuard([command], (selection) => pivotStructuralGuard(command, selection, regions(), refusal)),
  );
  return () => {
    for (const release of releases) release();
  };
}
