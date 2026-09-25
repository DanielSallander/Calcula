//! FILENAME: app/extensions/TimelineSlicer/__tests__/insertTimelinePlan.test.ts
// PURPOSE: The Insert Timeline dialog places timelines at the caller's
//          placement (stacking downward) or — without one — exactly where it
//          always did: (20, 20), 120 px apart, at the backend's default size.

import { describe, it, expect, vi } from "vitest";
import { readTimelinePlacement, timelineRects } from "../lib/insertTimelinePlan";

describe("timeline placement", () => {
  it("without a placement: the historical stack, and no size (backend default)", () => {
    const rects = timelineRects(3, readTimelinePlacement(undefined));
    expect(rects).toEqual([
      { x: 20, y: 20 },
      { x: 20, y: 140 },
      { x: 20, y: 260 },
    ]);
    // No width/height key at all, so createTimelineAsync still gets none.
    expect("width" in rects[0]).toBe(false);
    expect("height" in rects[0]).toBe(false);
  });

  it("with a placement: its origin and size", () => {
    expect(timelineRects(1, readTimelinePlacement({ placement: { x: 50, y: 70, width: 320, height: 90 } }))).toEqual([
      { x: 50, y: 70, width: 320, height: 90 },
    ]);
  });

  it("stacks at 120 px, or the named height plus a gap when that is taller", () => {
    const short = timelineRects(2, { x: 0, y: 0, height: 90 });
    expect(short.map((r) => r.y)).toEqual([0, 120]);
    const tall = timelineRects(2, { x: 0, y: 0, height: 200 });
    expect(tall.map((r) => r.y)).toEqual([0, 210]);
  });

  it("an unusable placement is ignored (default origin), not placed at NaN", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readTimelinePlacement({ placement: { x: Number.NaN, y: 0 } })).toBeNull();
    expect(readTimelinePlacement({ placement: "here" })).toBeNull();
    warn.mockRestore();
  });
});
