//! FILENAME: app/src/api/floatingRangeSpills.ts
// PURPOSE: Typed backend binding for the SPILL ranges on a floating range's
//          backing sheet -- the one read the grid's own `getSpillRanges` cannot
//          answer (it covers the ACTIVE sheet, and a backing sheet is never the
//          active sheet).
// CONTEXT: Wave C, W12 (E3's remainder). The formula bar greys a non-anchor
//          spill cell and shows its anchor's formula (Excel's "ghost"); a
//          selected floating-grid cell had no way to know it was one. The
//          Floating Range extension reads this to publish `spillGhost` on its
//          external cell target (@api/externalEdit). Id-addressed like every
//          other floating-range read: the frontend never handles the backing
//          sheet's index.

import { invokeBackend } from "./backend";
import type { SpillRangeInfo } from "../core/types";

export type { SpillRangeInfo };

/**
 * Every spill on the backing sheet of floating range `id`, in the range's own
 * cell coordinates: an ANCHOR (`originRow`, `originCol`) and the bounding box
 * of the cells it spills into (`endRow`, `endCol`). Rejects for an unknown id.
 */
export function getFloatingRangeSpillRanges(id: string): Promise<SpillRangeInfo[]> {
  return invokeBackend<SpillRangeInfo[]>("get_floating_range_spill_ranges", { id });
}
