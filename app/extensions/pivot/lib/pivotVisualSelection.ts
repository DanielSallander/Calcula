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
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { canvasObjectRef } from "@api/canvasSheet";
import {
  deselectPivotVisual,
  isPivotVisualSelected,
  selectPivotVisual,
} from "../handlers/selectionHandler";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "./pivotVisualRegions";
import type { PivotRegionData } from "../types";

/** The provider object (exported for tests; register it through `registerPivotVisualSelection`). */
export function createPivotVisualSelectionProvider(): ObjectSelectionProvider {
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
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerPivotVisualSelection(): () => void {
  return registerObjectSelectionProvider(createPivotVisualSelectionProvider());
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
