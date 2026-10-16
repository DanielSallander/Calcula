//! FILENAME: app/extensions/BuiltIn/ObjectPosition/lib/sizePosition.ts
// PURPOSE: The pure half of the Size and Position dialog: what its four boxes
//          start at, and the ONE geometry change their values ask for.
// CONTEXT: Units are LOGICAL px, the units of `GridRegion.floating` -- the same
//          numbers the families persist and the canvas page is measured in, so
//          what the user types is what the backend stores (no zoom, no snap:
//          plan decision D7 -- a typed 100 is 100, never rounded to a grid).
//
//          The change itself (`sizePositionChange`) lives in @api/objectPosition
//          since WP-C S6: the object pane's Properties card types the same four
//          boxes, and two copies of "what a typed geometry asks for" would
//          drift on the first new rule. Its rules are listed there. This file
//          keeps the dialog's own bookkeeping (start values, what changed) and
//          re-exports the change under its old name, so the dialog and its
//          tests read one function.

import type { GridRegion } from "@api/gridOverlays";
import type { SizePositionFields } from "@api/objectPosition";

export { sizePositionChange } from "@api/objectPosition";
export type { SizePositionFields } from "@api/objectPosition";

/** What the boxes start at: the object's current rectangle (all null for a non-floating region). */
export function initialFields(region: GridRegion): SizePositionFields {
  const f = region.floating;
  if (!f) return { x: null, y: null, width: null, height: null };
  return { x: f.x, y: f.y, width: f.width, height: f.height };
}

/** The boxes the user CHANGED from `initial`; every other box is null ("keep"). */
export function changedFields(initial: SizePositionFields, fields: SizePositionFields): SizePositionFields {
  const pick = (k: keyof SizePositionFields): number | null => (fields[k] === initial[k] ? null : fields[k]);
  return { x: pick("x"), y: pick("y"), width: pick("width"), height: pick("height") };
}
