//! FILENAME: app/extensions/BuiltIn/ObjectPosition/lib/sizePosition.ts
// PURPOSE: The pure half of the Size and Position dialog: what its four boxes
//          start at, and the ONE geometry change their values ask for.
// CONTEXT: Units are LOGICAL px, the units of `GridRegion.floating` -- the same
//          numbers the families persist and the canvas page is measured in, so
//          what the user types is what the backend stores (no zoom, no snap:
//          plan decision D7 -- a typed 100 is 100, never rounded to a grid).
//
//          The rules, in the order they apply:
//            - a box left blank, or not a finite number, keeps the object's
//              current value (the dialog also passes null for a box the user
//              did not change);
//            - width and height only where the object may resize; otherwise the
//              current size stands (a floating grid's size is its rows and
//              columns);
//            - a CHANGED width or height is at least
//              SIZE_AND_POSITION_MIN_SIZE (16); an unchanged one is kept as it
//              is, so moving a smaller object never resizes it;
//            - x and y are at least 0 (the families' own clamp);
//            - on a page (a canvas) the size is capped to the page and the
//              object is kept on it (`clampMoveToPage`), exactly as a drag is;
//            - a result equal to where the object already is asks for nothing.

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectGeometryChange } from "@api/objectGeometry";
import { clampMoveToPage } from "@api/layoutSurface";
import { SIZE_AND_POSITION_MIN_SIZE } from "@api/objectPosition";

/** The dialog's four boxes. `null` is a blank box. */
export interface SizePositionFields {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

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

function given(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

/**
 * The one geometry change `fields` ask of the object behind `region`, or null
 * when they ask for nothing (or the region is not floating). See the header
 * for the rules. `resize` false keeps the current size whatever the boxes say.
 */
export function sizePositionChange(
  region: GridRegion,
  fields: SizePositionFields,
  page: { width: number; height: number } | null,
  opts: { resize: boolean },
): ObjectGeometryChange | null {
  const f = region.floating;
  if (!f) return null;

  let x = given(fields.x) ? fields.x : f.x;
  let y = given(fields.y) ? fields.y : f.y;
  let width = f.width;
  let height = f.height;
  if (opts.resize) {
    if (given(fields.width) && fields.width !== f.width) width = Math.max(SIZE_AND_POSITION_MIN_SIZE, fields.width);
    if (given(fields.height) && fields.height !== f.height) height = Math.max(SIZE_AND_POSITION_MIN_SIZE, fields.height);
  }
  x = Math.max(0, x);
  y = Math.max(0, y);

  if (page) {
    if (opts.resize) {
      width = Math.min(width, page.width);
      height = Math.min(height, page.height);
    }
    const kept = clampMoveToPage({ x, y, width, height }, page);
    x = kept.x;
    y = kept.y;
  }

  if (x === f.x && y === f.y && width === f.width && height === f.height) return null;
  return { region, x, y, width, height, from: { x: f.x, y: f.y, width: f.width, height: f.height } };
}
