//! FILENAME: app/extensions/AutoSum/lib/liveReader.ts
// PURPOSE: The planner's cell reader over the real workbook: typed cells (the
//          number 5 is not the text "5") through @api/lib, and the used extent.
// CONTEXT: get_range_cells_typed refuses more than 100,000 cells per call, so a
//          tall read is split into row bands. The used extent is read once per
//          AutoSum (it cannot change while the plan is being made).

import { getRangeCellsTyped, getUsedRange, type TypedCellData } from "@api/lib";
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
