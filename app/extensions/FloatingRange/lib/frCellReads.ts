//! FILENAME: app/extensions/FloatingRange/lib/frCellReads.ts
// PURPOSE: Read a rectangle of a floating range's cells in bands the backend
//          will accept.
// CONTEXT: `get_floating_range_cells` delegates to `get_range_cells_typed`,
//          which REFUSES a read of more than MAX_TYPED_RANGE_CELLS (100,000)
//          cells (commands/data.rs). The renderer used to read the whole window
//          in one call, so a window of 1000 rows by 101 columns or more never
//          painted a single value -- the call failed every frame. The paint now
//          reads only what is on screen (frRenderer), but a rectangle can still
//          be large (a whole-column Delete over the extent, an extreme zoom-out),
//          so every read goes through here and is cut into row bands that each
//          stay inside the limit. Bands are read in order and concatenated; the
//          sparse typed payload only carries cells that exist.

import { getFloatingRangeCells } from "@api/floatingRanges";
import type { TypedCellData } from "@api/lib";

/** The backend's per-read ceiling (MAX_TYPED_RANGE_CELLS; the test is `count > max`). */
export const FR_MAX_READ_CELLS = 100_000;

/** An inclusive rectangle of local cells. */
export interface FrCellRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Read `rect` (inclusive) in row bands of at most FR_MAX_READ_CELLS cells. */
export async function readFrCells(frId: string, rect: FrCellRect): Promise<TypedCellData[]> {
  if (rect.endRow < rect.startRow || rect.endCol < rect.startCol) return [];
  const cols = rect.endCol - rect.startCol + 1;
  const bandRows = Math.max(1, Math.floor(FR_MAX_READ_CELLS / cols));
  if (rect.endRow - rect.startRow + 1 <= bandRows) {
    return getFloatingRangeCells(frId, rect.startRow, rect.startCol, rect.endRow, rect.endCol);
  }
  const out: TypedCellData[] = [];
  for (let r = rect.startRow; r <= rect.endRow; r += bandRows) {
    const band = await getFloatingRangeCells(
      frId,
      r,
      rect.startCol,
      Math.min(rect.endRow, r + bandRows - 1),
      rect.endCol,
    );
    for (const cell of band) out.push(cell);
  }
  return out;
}
