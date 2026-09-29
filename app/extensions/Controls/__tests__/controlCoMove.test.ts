//! FILENAME: app/extensions/Controls/__tests__/controlCoMove.test.ts
// PURPOSE: A control-led drag co-moves the rest of the selection like a
//          Core-led canvas group drag does (open-items 2.af, "their own
//          co-moved members are clamped at 0 only"): from the PRESS-TIME rects,
//          by the lead's total move, kept on the page, a locked member put.
// CONTEXT: The old handler added each frame's increment to a member's CURRENT
//          position and clamped at 0. `oldFrame` below is that arithmetic,
//          kept here only as the control that shows the drift the snapshot
//          removes; the real handlers (Controls/index.ts) are pinned to the
//          new module by CanvasSheet/__tests__/familyCoMoveWiring.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectRect } from "@api/objectGeometry";
import { coMovedControlPositions, snapshotControlDrag } from "../lib/controlCoMove";

const CANVAS = 1;
const WORKSHEET = 0;
const PAGE = { width: 800, height: 600 };
const lockedIds = new Set<string>();
let dispose: (() => void) | null = null;

function surface(): LayoutSurface {
  return {
    snapToGrid: false,
    gridSize: 10,
    showGrid: false,
    page: PAGE,
    editable: true,
    isLocked: (r: GridRegion) => lockedIds.has(r.id),
  };
}

const regionOf = (id: string): GridRegion => ({
  id,
  type: "floating-control",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: 10, height: 10 },
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

/** Lead at (300,300); member A at (20,20); member B near the right edge. */
function start(): Map<string, ObjectRect> {
  return new Map([
    ["lead", { x: 300, y: 300, width: 80, height: 40 }],
    ["a", { x: 20, y: 20, width: 80, height: 40 }],
    ["b", { x: 700, y: 500, width: 80, height: 40 }],
  ]);
}

describe("a control-led drag's co-moved controls", () => {
  it("on a canvas, a member pushed past the page edge is KEPT ON THE PAGE", () => {
    const rects = start();
    const snap = snapshotControlDrag("lead", rects.keys(), (id) => rects.get(id) ?? null);
    const at = coMovedControlPositions(snap, { x: 360, y: 380 }, CANVAS, regionOf);
    // b: 700+60 = 760 > 800-80 = 720 -> 720; 500+80 = 580 > 600-40 = 560 -> 560.
    expect(at.get("b"), "a co-moved control left the page").toEqual({ x: 720, y: 560, width: 80, height: 40 });
    expect(at.get("a")).toEqual({ x: 80, y: 100, width: 80, height: 40 });
    expect(at.has("lead")).toBe(false);
  });

  it("a LOCKED member stays where it was", () => {
    lockedIds.add("a");
    const rects = start();
    const snap = snapshotControlDrag("lead", rects.keys(), (id) => rects.get(id) ?? null);
    const at = coMovedControlPositions(snap, { x: 360, y: 380 }, CANVAS, regionOf);
    expect(at.get("a")).toEqual({ x: 20, y: 20, width: 80, height: 40 });
  });

  it("no drift: pushed against the left edge and brought back, a member keeps its offset", () => {
    const rects = start();
    const snap = snapshotControlDrag("lead", rects.keys(), (id) => rects.get(id) ?? null);
    // Frame 1: the lead goes 50 left (a would be at -30: clamped to 0).
    const f1 = coMovedControlPositions(snap, { x: 250, y: 300 }, CANVAS, regionOf);
    expect(f1.get("a")?.x).toBe(0);
    // Frame 2: the lead comes back to where it started -- so does a.
    const f2 = coMovedControlPositions(snap, { x: 300, y: 300 }, CANVAS, regionOf);
    expect(f2.get("a")?.x, "the co-moved control drifted").toBe(20);

    // The control: the OLD per-frame arithmetic loses the 30px the clamp ate.
    const oldFrame = (x: number, dx: number): number => Math.max(0, x + dx);
    expect(oldFrame(oldFrame(20, -50), +50)).toBe(50);
  });

  it("control: on a worksheet (no page) the historical clamp at 0 is kept", () => {
    const rects = start();
    const snap = snapshotControlDrag("lead", rects.keys(), (id) => rects.get(id) ?? null);
    const at = coMovedControlPositions(snap, { x: 5300, y: 250 }, WORKSHEET, regionOf);
    expect(at.get("b")).toEqual({ x: 5700, y: 450, width: 80, height: 40 });
    const left = coMovedControlPositions(snap, { x: 200, y: 200 }, WORKSHEET, regionOf);
    expect(left.get("a")).toEqual({ x: 0, y: 0, width: 80, height: 40 });
  });
});
