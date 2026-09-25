//! FILENAME: app/extensions/Slicer/lib/slicerObjectSelection.ts
// PURPOSE: The Slicer's provider for @api/objectSelection — select, deselect
//          and report slicers for a caller that is NOT a mouse press (a canvas
//          sheet's Tab / Shift+Tab / Escape, its click on the empty page).
// CONTEXT: The mouse route (`floatingObject:selected` in index.ts) arms a
//          PENDING CLICK that the next mouseup anywhere completes as a click on
//          the slicer's item under the pointer, and it reads the Ctrl state of
//          the last real mouse press. Neither belongs to a keyboard selection:
//          this provider selects exactly one slicer (never additive), shows the
//          contextual Slicer tab the way a click does, and arms nothing.

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import {
  deselectSlicer,
  isSlicerSelected,
  selectSlicer,
} from "../handlers/selectionHandler";

/** The `GridRegion.type` slicers publish (see slicerStore.syncSlicerRegions). */
export const SLICER_REGION_TYPE = "slicer";

/** The slicer id a published region carries, or null. */
function slicerIdOf(region: GridRegion): string | null {
  const id = region.data?.slicerId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The provider object (exported for tests; register it through
 *  `registerSlicerObjectSelection`). */
export function createSlicerSelectionProvider(): ObjectSelectionProvider {
  return {
    types: [SLICER_REGION_TYPE],

    isSelected(region: GridRegion): boolean {
      const id = slicerIdOf(region);
      return id !== null && isSlicerSelected(id);
    },

    select(region: GridRegion): void {
      const id = slicerIdOf(region);
      if (id === null) return;
      // Exclusive (additive = false): a keyboard step selects ONE object. The
      // handler ignores an id the store does not hold.
      selectSlicer(id, false);
    },

    deselectAll(): void {
      // No-op (and no repaint) when nothing is selected.
      deselectSlicer();
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerSlicerObjectSelection(): () => void {
  return registerObjectSelectionProvider(createSlicerSelectionProvider());
}
