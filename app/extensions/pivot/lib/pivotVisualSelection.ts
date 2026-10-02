//! FILENAME: app/extensions/Pivot/lib/pivotVisualSelection.ts
// PURPOSE: The Pivot extension's provider for @api/objectSelection: select,
//          deselect and report canvas pivot boxes for a caller that is NOT a
//          mouse press (a canvas sheet's Tab / Shift+Tab / Escape, its click on
//          the empty page).
// CONTEXT: The mouse route (`floatingObject:selected`) selects the box AND opens
//          the field-list pane, the way clicking into a worksheet pivot does. A
//          keyboard step is not a click: `select` here makes the pivot active
//          (its Analyze/Design tabs appear) and opens nothing. Precedent:
//          Slicer/lib/slicerObjectSelection.ts.

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { isPivotBoxMenuOpen, isPivotChromePressLive } from "./pivotVisualMenuState";
import { canvasObjectRef } from "@api/canvasSheet";
import {
  deselectPivotVisual,
  isPivotVisualSelected,
  selectPivotVisual,
} from "../handlers/selectionHandler";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "./pivotVisualRegions";
import type { PivotRegionData } from "../types";

/** What the provider needs from the extension, injected at registration so
 *  this module stays free of the (large) IPC module. */
export interface PivotVisualSelectionDeps {
  /** Delete one pivot the way its own menu does; rejects on refusal. */
  deletePivot(pivotId: string): Promise<void>;
}

/** The provider object (exported for tests; register it through `registerPivotVisualSelection`). */
export function createPivotVisualSelectionProvider(deps?: PivotVisualSelectionDeps): ObjectSelectionProvider {
  return {
    types: [PIVOT_VISUAL_REGION_TYPE],

    isSelected(region: GridRegion): boolean {
      const id = pivotIdOfVisual(region);
      return id !== null && isPivotVisualSelected(id);
    },

    select(region: GridRegion): void {
      const id = pivotIdOfVisual(region);
      if (id === null) return;
      selectPivotVisual(id, { openPane: false });
    },

    deselectAll(): void {
      // No-op when no box is selected.
      deselectPivotVisual();
    },

    ownsKey(key: ObjectSelectionKey): boolean {
      // A box's right-click menu, while open, owns Escape: it closes itself
      // (a document-capture listener). So does a held chrome press (a +/-, a
      // filter button, Cancel): Escape cancels it (pivotChromePress.ts). A
      // canvas's Escape binding runs EARLIER, in the dispatcher's
      // window-capture listener, and would otherwise deselect the box behind
      // the open menu or under the pointer.
      //
      // Delete / Backspace likewise (BUG-0270 review): the generic object
      // Delete (ObjectPosition lib/selectedObjectKeys.ts) deletes a selected
      // box -- the whole PivotTable -- and stands down only while a family
      // owns the key. The menu takes no focus, so the grid keeps the keyboard
      // while it is open: without this, Delete deleted the PivotTable behind
      // the open menu (or under a held +/- press).
      return (key === "Escape" || key === "Delete") && (isPivotBoxMenuOpen() || isPivotChromePressLive());
    },

    refOf(region: GridRegion) {
      const id = pivotIdOfVisual(region);
      return id === null ? null : canvasObjectRef("pivot", id);
    },

    // The pivot's name, published with its box (publishPivotRegions).
    labelOf(region: GridRegion): string | null {
      if (pivotIdOfVisual(region) === null) return null;
      const name = region.data?.name;
      return typeof name === "string" && name !== "" ? name : null;
    },

    // A canvas-wide Delete (a multi-selection spanning families) hands the
    // pivot boxes their share (wave B, A4) -- the same delete the pivot's own
    // menu runs (the backend's delete joins the seam's one undo step, with
    // the slicers and timelines it cascades into). Resolves once every delete
    // LANDED; REJECTS with the backend's reason when any was refused, so the
    // seam keeps the refused boxes selected and names them.
    async deleteObjects(regions: readonly GridRegion[]): Promise<void> {
      if (!deps) throw new Error("PivotTables cannot be deleted from here.");
      const reasons: string[] = [];
      let deleted = 0;
      for (const region of regions) {
        const pivotId = pivotIdOfVisual(region);
        if (pivotId === null) continue;
        try {
          await deps.deletePivot(pivotId);
          deleted++;
        } catch (err) {
          reasons.push(err instanceof Error ? err.message : String(err));
        }
      }
      // Repaint the boxes that went (their regions re-read on this event).
      if (deleted > 0) window.dispatchEvent(new Event("pivot:refresh"));
      if (reasons.length > 0) throw new Error(Array.from(new Set(reasons)).join(" "));
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerPivotVisualSelection(deps?: PivotVisualSelectionDeps): () => void {
  return registerObjectSelectionProvider(createPivotVisualSelectionProvider(deps));
}

// ---------------------------------------------------------------------------
// A pivot just created ON A CANVAS starts selected
// ---------------------------------------------------------------------------
//
// The create handler registers the Analyze/Design tabs and opens the pane
// without any selection -- on a worksheet the cursor inside the new pivot then
// owns them, and a click elsewhere tears them down. A canvas has no cursor: if
// the new box were not SELECTED, a click on the empty page (which deselects
// through this provider) would find nothing to deselect and leave the tabs and
// the pane addressing a box that is not selected. So the box the create made
// is selected (keyboard semantics: no second pane load) once the region list
// that contains it arrives.

let pendingCreatedPivotId: string | null = null;

/** Remember a pivot the user just created (PIVOT_CREATED). */
export function notePivotCreated(pivotId: string): void {
  pendingCreatedPivotId = pivotId;
}

/**
 * Called with each region list (PIVOT_REGIONS_UPDATED). Selects the pending
 * created pivot's box when it is a canvas pivot; a worksheet pivot (no frame)
 * just clears the pending id. A list that does not contain it yet keeps it
 * pending for the next one.
 */
export function adoptCreatedCanvasPivot(regions: readonly PivotRegionData[]): void {
  if (pendingCreatedPivotId === null) return;
  const created = regions.find((r) => r.pivotId === pendingCreatedPivotId);
  if (!created) return;
  pendingCreatedPivotId = null;
  if (created.canvasFrame != null) {
    selectPivotVisual(created.pivotId, { openPane: false });
  }
}

/** Test/deactivate hook. */
export function resetCreatedPivotTracking(): void {
  pendingCreatedPivotId = null;
}
