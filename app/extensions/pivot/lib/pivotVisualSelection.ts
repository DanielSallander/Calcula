//! FILENAME: app/extensions/Pivot/lib/pivotVisualSelection.ts
// PURPOSE: The Pivot extension's provider for @api/objectSelection: select,
//          deselect and report canvas pivot boxes for a caller that is NOT a
//          mouse press (a canvas sheet's Tab / Shift+Tab / Escape, its click on
//          the empty page).
// CONTEXT: Selecting a box makes the pivot active (its Analyze/Design tabs
//          appear) and opens nothing: the box's field list lives in the ONE
//          object pane (WP-C D-PANE), which opens by its own policy (the
//          release of a mouse press) or through a door -- never from a keyboard
//          step. Precedent: Slicer/lib/slicerObjectSelection.ts.

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { isPivotBoxMenuOpen, isPivotCellPressHeld, isPivotChromePressLive } from "./pivotVisualMenuState";
import { clearPivotCellSelection, hasPivotCellSelection } from "./pivotVisualCellSelection";
import { PIVOT_CANVAS_COPY_CELLS_COMMAND, PIVOT_CANVAS_REFUSE_EDIT_COMMAND } from "./pivotCanvasCellCommands";
import { canvasObjectRef } from "@api/canvasSheet";
import { getGridRegions } from "@api/gridOverlays";
import { openObjectPane } from "@api/objectPane";
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
      selectPivotVisual(id);
    },

    deselectAll(): void {
      // No-op when no box is selected. The cells go with the box -- also when
      // no box is selected any more but cells were somehow left behind: an
      // inner selection never outlives its object.
      deselectPivotVisual();
      clearPivotCellSelection();
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
      // A held CELL press (a drag selecting the box's cells, pivotCellPress.ts)
      // likewise: Escape ends the drag and keeps the cells.
      if (
        (key === "Escape" || key === "Delete") &&
        (isPivotBoxMenuOpen() || isPivotChromePressLive() || isPivotCellPressHeld())
      ) {
        return true;
      }
      // SELECTED CELLS (D-CELLS) are an inner selection, like a floating
      // grid's cell: the arrows move them (not the canvas's nudge), Escape
      // clears them first (the canvas's Escape deselects the box only at the
      // second press), the clipboard keys and doors copy them (not the
      // canvas's object copy), and Delete / Backspace REFUSE -- the generic
      // object Delete must never take the key, because for a pivot box it
      // deletes the whole PivotTable (the DELETE HAZARD). Tab is NOT claimed:
      // it keeps cycling the canvas's objects.
      return (
        hasPivotCellSelection() &&
        (key === "Arrow" || key === "Escape" || key === "Clipboard" || key === "Delete")
      );
    },

    // The Copy / Paste DOORS (Home tab, Edit menu) while cells are selected:
    // Copy copies THOSE cells; Paste is refused with the pivot's sentence (a
    // pivot's cells are not edited). Without cells the canvas's object
    // clipboard answers, as before.
    innerClipboardCommand(action: "copy" | "paste"): string | null {
      if (!hasPivotCellSelection()) return null;
      return action === "copy" ? PIVOT_CANVAS_COPY_CELLS_COMMAND : PIVOT_CANVAS_REFUSE_EDIT_COMMAND;
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
// is selected once the region list that contains it arrives -- and, when the
// create was made on the canvas (`notePivotCreated(id, { openPane: true })`),
// the ONE object pane opens on its Fields tab as a door (WP-C D-PANE: a canvas
// pivot's field list is never the worksheet `pivot-editor` pane).

let pendingCreatedPivotId: string | null = null;
/** Whether the pending created pivot's box opens the object pane on Fields. */
let pendingOpensPane = false;

/** Remember a pivot the user just created (PIVOT_CREATED). */
export function notePivotCreated(pivotId: string, opts: { openPane?: boolean } = {}): void {
  pendingCreatedPivotId = pivotId;
  pendingOpensPane = opts.openPane === true;
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
  const openPane = pendingOpensPane;
  pendingOpensPane = false;
  if (created.canvasFrame != null) {
    selectPivotVisual(created.pivotId);
    if (openPane) {
      const box = getGridRegions().find(
        (r) => r.type === PIVOT_VISUAL_REGION_TYPE && pivotIdOfVisual(r) === created.pivotId,
      );
      if (box) openObjectPane({ region: box, tab: "fields", reason: "command" });
    }
  }
}

/** Test/deactivate hook. */
export function resetCreatedPivotTracking(): void {
  pendingCreatedPivotId = null;
  pendingOpensPane = false;
}
