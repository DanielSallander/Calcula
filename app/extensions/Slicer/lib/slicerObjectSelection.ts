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
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { canvasObjectRef } from "@api/canvasSheet";
import {
  deselectSlicer,
  isSlicerSelected,
  selectSlicer,
} from "../handlers/selectionHandler";
import { deleteSlicersReporting, getSlicerById } from "./slicerStore";
import { isSlicerContextMenuOpen } from "../handlers/slicerContextMenu";

/** The `GridRegion.type` slicers publish (see slicerStore.syncSlicerRegions). */
export const SLICER_REGION_TYPE = "slicer";

/** The slicer id a published region carries, or null. */
export function slicerIdOf(region: GridRegion): string | null {
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

    // Escape is the slicer's right-click MENU's while it is open: the menu
    // closes itself on it (and consumes it). A canvas's Escape binding asks
    // this first -- it runs earlier and used to deselect the slicer behind
    // the open menu, leaving the menu open (BUG-0196, slicer part).
    ownsKey(key: ObjectSelectionKey): boolean {
      return key === "Escape" && isSlicerContextMenuOpen();
    },

    refOf(region: GridRegion) {
      const id = slicerIdOf(region);
      return id === null ? null : canvasObjectRef("slicer", id);
    },

    // The slicer family holds several (the Ctrl+click set), so a canvas
    // multi-selection keeps every slicer in it -- its ribbon edits them all
    // and its own drag co-moves them. `selectSlicer(id, true)` TOGGLES, so it
    // is only called when the answer is a change.
    addToSelection(region: GridRegion): void {
      const id = slicerIdOf(region);
      if (id === null || isSlicerSelected(id)) return;
      selectSlicer(id, true);
    },

    removeFromSelection(region: GridRegion): void {
      const id = slicerIdOf(region);
      if (id === null || !isSlicerSelected(id)) return;
      selectSlicer(id, true);
    },

    labelOf(region: GridRegion): string | null {
      const id = slicerIdOf(region);
      return id === null ? null : getSlicerById(id)?.name ?? null;
    },

    // A canvas-wide Delete (a multi-selection spanning families) hands the
    // slicers their share (wave B, A4). Resolves once every delete LANDED
    // (the backend's delete joins the seam's one undo step, filter and all);
    // REJECTS with the backend's reason when any was refused, so the seam
    // keeps the refused ones selected and names them.
    async deleteObjects(regions: readonly GridRegion[]): Promise<void> {
      const ids = regions.map(slicerIdOf).filter((id): id is string => id !== null);
      if (ids.length === 0) return;
      const refused = await deleteSlicersReporting(ids, "Delete Objects");
      if (refused.length > 0) {
        throw new Error(Array.from(new Set(refused.map((r) => r.reason))).join(" "));
      }
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerSlicerObjectSelection(): () => void {
  return registerObjectSelectionProvider(createSlicerSelectionProvider());
}
