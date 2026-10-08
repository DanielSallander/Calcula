//! FILENAME: app/extensions/CanvasSheet/lib/canvasLocks.ts
// PURPOSE: Which objects a canvas LOCKS: the layout's `locked` refs, asked by
//          region.
// CONTEXT: A locked object stays selectable but cannot be moved or resized --
//          not by a drag (Core asks the layout surface's `isLocked`, answered
//          from here), not by align/distribute, not by the arrow-key nudge
//          and not as a member of a group drag. The layout names objects by
//          their stable ref (`{ kind, id }`, @api/canvasSheet) and each family
//          names its regions the same way through its object-selection
//          provider (`objectRefOf`), so this is the one join between the two.
//
//          The page's own LOCK OBJECTS (`isFixedOnLayout`, below) locks every
//          object at once, on top of the per-object list.
//
//          The ref-key set is cached per layout object (the store replaces the
//          layout on every write), because Core asks during every press and
//          the resize scan asks on every pointer move.

import type { CanvasLayout } from "@api";
import type { GridRegion } from "@api/gridOverlays";
import { objectRefOf } from "@api/objectSelection";
import { canvasObjectRefKey, canvasObjectsLocked } from "@api/canvasSheet";
import { getGridStateSnapshot } from "@api/grid";
import { canvasAt } from "./canvasSheetStore";

const keysByLayout = new WeakMap<CanvasLayout, ReadonlySet<string>>();

/** The layout's locked refs as `kind:id` keys. Pure (cached per layout). */
export function lockedKeysOf(layout: CanvasLayout): ReadonlySet<string> {
  let keys = keysByLayout.get(layout);
  if (!keys) {
    keys = new Set((layout.locked ?? []).map(canvasObjectRefKey));
    keysByLayout.set(layout, keys);
  }
  return keys;
}

/** Whether `layout` locks the object behind `region` (an unnamed object never is). */
export function isLockedOnLayout(layout: CanvasLayout, region: GridRegion): boolean {
  const keys = lockedKeysOf(layout);
  if (keys.size === 0) return false;
  const ref = objectRefOf(region);
  return ref !== null && keys.has(canvasObjectRefKey(ref));
}

/** Whether the ACTIVE canvas locks the object behind `region` (false on a worksheet). */
export function isLockedOnActiveCanvas(region: GridRegion): boolean {
  const entry = canvasAt(getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0);
  return entry !== null && isLockedOnLayout(entry.layout, region);
}

/**
 * Whether the object behind `region` may NOT move or resize on `layout`: the
 * whole page's Lock Objects (Power BI's View > Lock objects, @api/canvasSheet
 * `canvasObjectsLocked`) or the object's own Lock. This is the answer Core
 * gets through the layout surface's `isLocked`, and the one the arrange verbs
 * (align, distribute, nudge, group drag) ask through `isArrangeMovable`.
 *
 * The padlock MARK stays per-object (`isLockedOnLayout`): with the page locked,
 * every selection would otherwise carry a padlock that says nothing the View
 * group's pressed Lock Objects toggle does not already say.
 */
export function isFixedOnLayout(layout: CanvasLayout, region: GridRegion): boolean {
  return canvasObjectsLocked(layout) || isLockedOnLayout(layout, region);
}

/** `isFixedOnLayout` for the ACTIVE canvas (false on a worksheet). */
export function isFixedOnActiveCanvas(region: GridRegion): boolean {
  const entry = canvasAt(getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0);
  return entry !== null && isFixedOnLayout(entry.layout, region);
}
