//! FILENAME: app/extensions/CanvasSheet/lib/objectLabel.ts
// PURPOSE: Publish what the canvas's selected object(s) are called, for the
//          Name Box: the object's name for one ("Slicer_Region", "Sales"), "N
//          objects" for a multi-selection, nothing for none.
// CONTEXT: ONE publisher for every family. The canvas already follows the
//          selection set (@api/objectSelection), and each family names its own
//          objects through its provider's `labelOf` -- so no family publishes
//          anything, and a new family gets a label by answering `labelOf`.
//
//          A worksheet publishes nothing: its Name Box keeps showing the cell
//          address (and a chart's rung, which @api/chartSelection carries), as
//          it always has.
//
//          Re-published on every selection change, on every region change
//          (a rename re-publishes the region with its new name; a sheet switch
//          publishes the next sheet's objects) and when the canvas store
//          changes. The registry tells its readers only when the label moved.

import { getGridStateSnapshot } from "@api/grid";
import { onRegionChange, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  objectLabelOf,
  onObjectSelectionChanged,
} from "@api/objectSelection";
import { publishObjectLabel, type ObjectLabel } from "@api/objectSelectionLabel";

/** The registry source this extension publishes under. */
export const CANVAS_OBJECT_LABEL_SOURCE = "canvasSheet";

/** "1 object" / "3 objects". */
export function objectCountLabel(count: number): string {
  return `${count} ${count === 1 ? "object" : "objects"}`;
}

/**
 * The label for a selection: null for none, the object's own name for one
 * (null when it has none), "N objects" for several. Pure over the providers.
 */
export function canvasSelectionLabel(members: readonly GridRegion[]): ObjectLabel | null {
  if (members.length === 0) return null;
  if (members.length === 1) {
    const text = objectLabelOf(members[0]);
    return text === null ? null : { text, count: 1 };
  }
  return { text: objectCountLabel(members.length), count: members.length };
}

/** Publish the ACTIVE sheet's label (null on a worksheet). */
export function publishCanvasObjectLabel(): void {
  const onCanvas = getGridStateSnapshot()?.surface === "canvas";
  publishObjectLabel(
    CANVAS_OBJECT_LABEL_SOURCE,
    onCanvas ? canvasSelectionLabel(getSelectedObjectRegions()) : null,
  );
}

/** Follow the selection and the regions; returns the cleanups. */
export function installCanvasObjectLabel(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  cleanups.push(onObjectSelectionChanged(publishCanvasObjectLabel));
  cleanups.push(onRegionChange(() => publishCanvasObjectLabel()));
  cleanups.push(() => publishObjectLabel(CANVAS_OBJECT_LABEL_SOURCE, null));
  publishCanvasObjectLabel();
  return cleanups;
}
