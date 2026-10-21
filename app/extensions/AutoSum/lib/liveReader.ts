//! FILENAME: app/extensions/AutoSum/lib/liveReader.ts
// PURPOSE: The planner's cell reader over the real workbook: typed cells (the
//          number 5 is not the text "5") through @api/lib, and the used extent.
// CONTEXT: get_range_cells_typed refuses more than 100,000 cells per call, so a
//          tall read is split into row bands. The used extent is read once per
//          AutoSum (it cannot change while the plan is being made).

import { getRangeCellsTyped, getUsedRange, type TypedCellData } from "@api/lib";
import { getCellTargetCellsTyped, type CellTargetRef } from "@api/cellTarget";
import type { AutoSumCellReader, CellRange } from "./autoSumPlan";

/** get_range_cells_typed's own cap. */
const TYPED_READ_CAP = 100_000;

export function createLiveReader(): AutoSumCellReader {
  let used: Promise<{ endRow: number; endCol: number; empty: boolean }> | null = null;
  return {
    async read(range: CellRange): Promise<TypedCellData[]> {
      const width = range.endCol - range.startCol + 1;
      const band = Math.max(1, Math.floor(TYPED_READ_CAP / Math.max(1, width)));
      const out: TypedCellData[] = [];
      for (let row = range.startRow; row <= range.endRow; row += band) {
        const last = Math.min(range.endRow, row + band - 1);
        out.push(...(await getRangeCellsTyped(row, range.startCol, last, range.endCol)));
      }
      return out;
    },
    usedRange() {
      used ??= getUsedRange().then((u) => ({ endRow: u.endRow, endCol: u.endCol, empty: u.empty }));
      return used;
    },
  };
}

/**
 * The planner's reader over an OBJECT's cells (a floating grid's, P3): the
 * typed read of the object's own cells through @api/cellTarget (never
 * `getRangeCellsTyped`, which reads the ACTIVE sheet under the object). The
 * used extent is the object's write extent: cells past it cannot be reached,
 * so a total that would land there is refused by the command.
 */
export function createTargetReader(ref: CellTargetRef, bounds: { rows: number; cols: number }): AutoSumCellReader {
  const lastRow = Math.trunc(bounds.rows) - 1;
  const lastCol = Math.trunc(bounds.cols) - 1;
  return {
    async read(range: CellRange): Promise<TypedCellData[]> {
      const r0 = Math.max(0, Math.min(range.startRow, range.endRow));
      const r1 = Math.min(lastRow, Math.max(range.startRow, range.endRow));
      const c0 = Math.max(0, Math.min(range.startCol, range.endCol));
      const c1 = Math.min(lastCol, Math.max(range.startCol, range.endCol));
      if (r0 > r1 || c0 > c1) return [];
      return getCellTargetCellsTyped(ref, { startRow: r0, startCol: c0, endRow: r1, endCol: c1 });
    },
    async usedRange() {
      return { endRow: Math.max(0, lastRow), endCol: Math.max(0, lastCol), empty: lastRow < 0 || lastCol < 0 };
    },
  };
}
