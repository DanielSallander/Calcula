//! FILENAME: app/extensions/CanvasSheet/lib/layoutRefs.ts
// PURPOSE: Tell the families which object identities a canvas's layout still
//          NAMES -- its `locked` and `zOrder` refs, live or dead -- through
//          @api/objectSelection's layout-ref source.
// CONTEXT: The layout names an object by its ref (`{ kind, id }`) and keeps
//          the ref after the object is deleted: a delete does not prune the
//          layout's refs, and must not -- the delete's undo step restores the
//          OBJECT, not the layout lists, so Ctrl+Z of the delete brings the
//          object back under the same ref, and only a ref still in the lists
//          finds its lock and its paint slot again. (Stacking and lock changes
//          are undoable steps of their own since W5; a delete is not one.)
//
//          A control's ref is its ANCHOR cell (`control:<row>:<col>`), and a
//          new control is handed the next free anchor -- which, after the
//          newest control was deleted, is the deleted one's own. So a shape
//          copied, deleted and pasted (a canvas has no Cut) came back LOCKED
//          and in the dead shape's slot of the paint order (wave C review).
//          Controls' anchor allocator asks this source and skips every anchor
//          the layout names; ids that are never reused (a chart's UUID) need
//          not ask.

import type { CanvasObjectRef } from "@api";
import { registerLayoutRefSource } from "@api/objectSelection";
import { canvasAt } from "./canvasSheetStore";

/** Every ref the layout of `sheetIndex` names ([] on a worksheet). */
export function canvasLayoutRefs(sheetIndex: number): CanvasObjectRef[] {
  const entry = canvasAt(sheetIndex);
  if (!entry) return [];
  return [...(entry.layout.locked ?? []), ...(entry.layout.zOrder ?? [])];
}

/** Register the source; returns the cleanup. */
export function installCanvasLayoutRefs(): () => void {
  return registerLayoutRefSource(canvasLayoutRefs);
}
