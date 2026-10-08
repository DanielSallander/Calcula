//! FILENAME: app/extensions/Slicer/lib/slicerClearProvider.ts
// PURPOSE: The Slicer extension's answer to @api/slicerClearService -- "clear
//          every slicer on this sheet" -- for a Clear all slicers button (Canvas
//          contract §4.4, Power BI's Clear all slicers action).
// CONTEXT: Each filtered slicer on the sheet is cleared through
//          `clickSlicerClearFilter`, THE route its own Clear button, Select All
//          and the context menu take: a queued user click, computed from the
//          committed selection when it runs, one landed undo step per slicer
//          (BUG-0187's single-command gesture), its filter cleared on every
//          pivot, table and design-query chart it reaches, and the overwrite
//          question asked when a pivot would be overwritten. Clearing by the
//          backend's `clear_slicer_filter` alone would empty the selection and
//          leave every target filtered.
//
//          ONE STEP PER SLICER, not one for all: the gesture records its own
//          step in the backend and holds no frontend transaction across a
//          model re-query, by design (an unrelated edit during a slow click is
//          its own step). One step for a whole page would need a backend batch
//          command; reported, not invented here.
//
//          A slicer that already shows everything (`selectedItems === null`)
//          is left alone -- "clearing" it would be an undo step that changes
//          nothing.
//
//          Registered by index.ts (one line, beside the page-filter publisher).

import type { SlicerClearProvider } from "@api/slicerClearService";
import { registerSlicerClearProvider } from "@api/slicerClearService";
import { clickSlicerClearFilter, getSlicersForSheet } from "./slicerStore";
import { isSlicerFiltered } from "./slicerClickSelection";
import type { Slicer } from "./slicerTypes";

/** What the provider reads and does, injectable for tests. */
export interface SlicerClearDeps {
  getSlicersForSheet(sheetIndex: number): ReadonlyArray<Pick<Slicer, "id" | "selectedItems">>;
  clickSlicerClearFilter(slicerId: string): Promise<void>;
}

/** The provider over `deps` (the store's own functions by default). */
export function createSlicerClearProvider(
  deps: SlicerClearDeps = { getSlicersForSheet, clickSlicerClearFilter },
): SlicerClearProvider {
  return {
    async clearSlicersOnSheet(sheetIndex: number): Promise<number> {
      const filtered = deps.getSlicersForSheet(sheetIndex).filter((s) => isSlicerFiltered(s));
      for (const slicer of filtered) {
        // One at a time: the store's click queue serialises them anyway, and
        // awaiting each makes the count a count of LANDED clears.
        await deps.clickSlicerClearFilter(slicer.id);
      }
      return filtered.length;
    },
  };
}

/** Register the provider; returns the unregister function for activation's cleanup list. */
export function installSlicerClearProvider(): () => void {
  return registerSlicerClearProvider(createSlicerClearProvider());
}
