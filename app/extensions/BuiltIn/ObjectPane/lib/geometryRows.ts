//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/geometryRows.ts
// PURPOSE: The Properties card's X / Y / Width / Height rows: the ONE geometry
//          change a typed box asks for, with Lock aspect ratio applied.
// CONTEXT: The same rules as the Size and Position dialog, read from the same
//          places: `sizePositionChange` and `sizeAndPositionAvailability`
//          (@api/objectPosition -- Core's own drag refusals, the page clamp,
//          the 16 px minimum) and `applyAspectLock` (@api/aspectLock -- the
//          rule Core's resize drag uses). A typed Width is the RIGHT edge moving
//          (the height follows, the top stays); a typed Height is the BOTTOM
//          edge (the width follows, the left stays). When the page then cuts
//          one side, the other shrinks to match (`fit: "shrink"`), so the ratio
//          survives the clamp.

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectGeometryChange } from "@api/objectGeometry";
import { applyAspectLock, type AspectLockEdges } from "@api/aspectLock";
import {
  SIZE_AND_POSITION_MIN_SIZE,
  sizePositionChange,
  type SizeAndPositionAvailability,
  type SizePositionFields,
} from "@api/objectPosition";

export type GeometryKey = "x" | "y" | "width" | "height";

function edgesFor(key: "width" | "height"): AspectLockEdges {
  return { left: false, top: false, right: key === "width", bottom: key === "height" };
}

/**
 * The change one typed geometry box asks for, or null (nothing to do: the
 * object may not move, the box is blank, or the value is where it already is).
 */
export function geometryChangeFor(
  region: GridRegion,
  key: GeometryKey,
  value: number | null,
  lockAspect: boolean,
  availability: SizeAndPositionAvailability,
): ObjectGeometryChange | null {
  const f = region.floating;
  if (!f || !availability.move || value === null || !Number.isFinite(value)) return null;
  const opts = { resize: availability.resize };
  const fields: SizePositionFields = { x: null, y: null, width: null, height: null };
  fields[key] = value;

  const sized = key === "width" || key === "height";
  const locked = lockAspect && availability.resize && sized && value > 0 && f.width > 0 && f.height > 0;
  if (!locked) return sizePositionChange(region, fields, availability.page, opts);

  const edges = edgesFor(key as "width" | "height");
  const orig = { x: f.x, y: f.y, width: f.width, height: f.height };
  const typed = { ...orig, [key]: value };
  const kept = applyAspectLock(orig, typed, edges, SIZE_AND_POSITION_MIN_SIZE);
  let change = sizePositionChange(
    region,
    { x: null, y: null, width: kept.width, height: kept.height },
    availability.page,
    opts,
  );
  if (!change) return null;
  // A page clamp may have cut one side: shrink the other to keep the ratio.
  const fitted = applyAspectLock(orig, change, edges, SIZE_AND_POSITION_MIN_SIZE, { fit: "shrink" });
  if (fitted.width !== change.width || fitted.height !== change.height) {
    change = sizePositionChange(
      region,
      { x: null, y: null, width: fitted.width, height: fitted.height },
      availability.page,
      opts,
    );
  }
  return change;
}
