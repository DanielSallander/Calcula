//! FILENAME: app/extensions/TimelineSlicer/lib/insertTimelinePlan.ts
// PURPOSE: Where the Insert Timeline dialog puts the timelines it creates.
// CONTEXT: A caller that has already decided WHERE (a canvas sheet's Insert,
//          from a snapped rectangle) passes `dialogData.placement =
//          { x, y, width?, height? }` in sheet pixels on the ACTIVE sheet. The
//          timelines stack downward from that origin exactly as they stack from
//          the historical fixed (20, 20) origin without one. Pure, so the
//          layout is tested without rendering the dialog.

/** Where the caller wants the timelines, in sheet pixels on the ACTIVE sheet. */
export interface TimelinePlacement {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Where one created timeline goes. Width/height undefined = the backend's
 *  default size, exactly as before placement existed. */
export interface TimelineRect {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export const DEFAULT_TIMELINE_ORIGIN = { x: 20, y: 20 } as const;
/** Vertical step between timelines created together (the historical 120). */
export const TIMELINE_CASCADE_STEP = 120;
/** Gap kept between stacked timelines when the placement names a height
 *  taller than the historical step would fit. */
export const TIMELINE_CASCADE_GAP = 10;

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function positiveOrUndefined(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read `dialogData.placement`. Null when absent. A placement that is present
 * but unusable (no finite, non-negative x/y) is ignored with a warning: the
 * timelines then land at the default origin — visible, where a user can move
 * them — rather than at NaN, where nobody can.
 */
export function readTimelinePlacement(
  data: Record<string, unknown> | undefined,
): TimelinePlacement | null {
  const raw = data?.placement;
  if (raw === undefined || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof raw !== "object" || !isNonNegativeFinite(p.x) || !isNonNegativeFinite(p.y)) {
    console.warn("[InsertTimelineDialog] Ignoring an unusable placement:", raw);
    return null;
  }
  return {
    x: p.x,
    y: p.y,
    width: positiveOrUndefined(p.width),
    height: positiveOrUndefined(p.height),
  };
}

/**
 * One rectangle per timeline to create, stacked downward from the origin — the
 * placement's when given, (20, 20) otherwise — 120 px apart, or the named
 * height plus a 10 px gap when that is taller. Without a placement this is
 * exactly the historical layout.
 */
export function timelineRects(count: number, placement: TimelinePlacement | null): TimelineRect[] {
  const originX = placement?.x ?? DEFAULT_TIMELINE_ORIGIN.x;
  const originY = placement?.y ?? DEFAULT_TIMELINE_ORIGIN.y;
  const width = placement?.width;
  const height = placement?.height;
  const step =
    height !== undefined
      ? Math.max(TIMELINE_CASCADE_STEP, height + TIMELINE_CASCADE_GAP)
      : TIMELINE_CASCADE_STEP;
  const rects: TimelineRect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({
      x: originX,
      y: originY + i * step,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }
  return rects;
}
