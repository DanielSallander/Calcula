//! FILENAME: app/src/api/__tests__/objectGeometryCoMove.test.ts
// PURPOSE: When Controls, Slicer or Timeline LEAD a drag, the members they
//          co-move themselves follow the SAME rule a Core-led canvas group
//          drag applies to its movers (open-items 2.af, "their own co-moved
//          members are clamped at 0 only"): the member's press-time rect,
//          shifted by the lead's (snapped) delta, then KEPT ON THE PAGE; a
//          LOCKED member stays where it was; off a page (a worksheet) the old
//          clamp at 0 is kept.
// CONTEXT: The rule lives on the object-geometry seam (`coMovedMemberRect`)
//          so the three families and the canvas group drag cannot drift apart
//          (CanvasSheet lib/groupDrag.ts `moverChanges` is the Core-led half).
//          The family wiring is pinned by source in
//          CanvasSheet/__tests__/familyCoMoveWiring.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { coMovedMemberRect } from "../objectGeometry";
import { registerLayoutSurfaceProvider, clampMoveToPage, type LayoutSurface } from "../layoutSurface";
import type { GridRegion } from "../gridOverlays";

const CANVAS = 1;
const WORKSHEET = 0;
const PAGE = { width: 800, height: 600 };

const lockedIds = new Set<string>();
let dispose: (() => void) | null = null;

function surface(): LayoutSurface {
  return {
    snapToGrid: true,
    gridSize: 20,
    showGrid: true,
    page: PAGE,
    editable: true,
    isLocked: (r: GridRegion) => lockedIds.has(r.id),
  };
}

const region = (id: string): GridRegion => ({
  id,
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: 100, height: 50 },
  data: {},
});

beforeEach(() => {
  lockedIds.clear();
  dispose = registerLayoutSurfaceProvider({ get: (i) => (i === CANVAS ? surface() : null) });
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("coMovedMemberRect: a family's co-moved member, the Core-led rule", () => {
  it("on a canvas a member pushed past the page's right/bottom edge is KEPT ON THE PAGE", () => {
    const from = { x: 700, y: 520, width: 100, height: 50 };
    const at = coMovedMemberRect(CANVAS, from, { dx: 60, dy: 60 }, region("m"));
    // The Core-led group drag's own answer for the same member and delta.
    expect(at).toEqual(clampMoveToPage({ ...from, x: 760, y: 580 }, PAGE));
    expect(at).toEqual({ x: 700, y: 550, width: 100, height: 50 });
  });

  it("on a canvas a member pushed past the left/top edge stops at 0 (and keeps its size)", () => {
    const at = coMovedMemberRect(CANVAS, { x: 10, y: 30, width: 100, height: 50 }, { dx: -40, dy: -80 }, region("m"));
    expect(at).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("a member the canvas LOCKS stays exactly where it was", () => {
    lockedIds.add("locked");
    const from = { x: 200, y: 100, width: 100, height: 50 };
    expect(coMovedMemberRect(CANVAS, from, { dx: 40, dy: 20 }, region("locked"))).toEqual(from);
  });

  it("a member moves by the lead's delta from its PRESS-TIME rect (no per-frame drift)", () => {
    const from = { x: 5, y: 5, width: 100, height: 50 };
    // Frame 1 pushes it against the edge, frame 2 comes back: the answer for
    // the net delta is where it would be had frame 1 never happened.
    expect(coMovedMemberRect(CANVAS, from, { dx: -20, dy: -20 }, region("m"))).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(coMovedMemberRect(CANVAS, from, { dx: 10, dy: 10 }, region("m"))).toEqual({ x: 15, y: 15, width: 100, height: 50 });
  });

  it("control: on a worksheet (no page) the old clamp at 0 holds and nothing else", () => {
    expect(coMovedMemberRect(WORKSHEET, { x: 10, y: 10, width: 100, height: 50 }, { dx: 5000, dy: -50 })).toEqual({
      x: 5010,
      y: 0,
      width: 100,
      height: 50,
    });
  });
});
