//! FILENAME: app/src/core/lib/__tests__/floatingHandles.test.ts
// PURPOSE: THE handle geometry and THE liveness rule (core/lib/floatingHandles.ts)
//          that Core's resize hit test and Core's selection-chrome painter
//          both read (BUG-0258 design phase 3): eight handles on edges of at
//          least 48px, four below or in "corners" mode; each handle drags only
//          its own sides and shows its own pointer; every painted handle is
//          hit at its own centre and nowhere outside its paint grown by 3px;
//          and nothing is live on an unselected, locked, consume-mode,
//          resizable:false or reference-picking region.
// CONTEXT: The handlers that consume this are driven end to end in
//          hooks/useMouseSelection/layout/__tests__/overlayHandles.test.ts and
//          the painter in lib/gridRenderer/floatingChromePaint.test.ts.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  FLOATING_HANDLE_HIT_HALF,
  FLOATING_HANDLE_MIDPOINT_MIN_EDGE,
  FLOATING_HANDLE_PAINT_SIZE,
  floatingCanvasRect,
  floatingHandleAt,
  floatingHandleGeometry,
  floatingHandleHits,
  floatingHandleMode,
  floatingHandlesLive,
  floatingHandlesOf,
  registerGridReferencePickProbe,
  type FloatingHandle,
  type FloatingHandleId,
} from "../floatingHandles";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import { registerExternalFormulaTarget } from "../formulaEditTarget";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../api/objectSelection";
import { registerRegionStacking, type GridRegion } from "../../../api/gridOverlays";

const GUTTERS = { rowHeaderWidth: 22, colHeaderHeight: 20 };
const SCROLL = { scrollX: 0, scrollY: 0 };
const TYPE = "handle-test";

function region(id: string, box: { x: number; y: number; width: number; height: number }, data: Record<string, unknown> = {}, z?: number): GridRegion {
  return {
    id,
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: box,
    data,
    ...(z === undefined ? {} : { z }),
  };
}

const selected = new Set<string>();
const cleanups: Array<() => void> = [];

beforeEach(() => {
  selected.clear();
  cleanups.push(
    registerObjectSelectionProvider({
      types: [TYPE],
      isSelected: (r) => selected.has(r.id),
      select: (r) => {
        selected.add(r.id);
      },
      deselectAll: () => selected.clear(),
    }),
  );
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
});

function surface(over: Partial<LayoutSurface> = {}): void {
  const s: LayoutSurface = {
    snapToGrid: false,
    gridSize: 16,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...over,
  };
  cleanups.push(registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? s : null) }));
}

const ids = (hs: FloatingHandle[]) => hs.map((h) => h.id).sort();

describe("the geometry", () => {
  const BIG = { x: 100, y: 50, width: 200, height: 120 };

  it("8 handles when both edges reach 48px, the 4 corners below, and 4 in 'corners' mode", () => {
    expect(ids(floatingHandleGeometry(BIG, "all"))).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
    const edge = FLOATING_HANDLE_MIDPOINT_MIN_EDGE;
    expect(ids(floatingHandleGeometry({ x: 0, y: 0, width: edge, height: edge }, "all"))).toHaveLength(8);
    expect(ids(floatingHandleGeometry({ x: 0, y: 0, width: edge - 1, height: edge - 1 }, "all"))).toEqual(["ne", "nw", "se", "sw"]);
    // Only the long edges get their midpoint: a wide, short object has n and s.
    expect(ids(floatingHandleGeometry({ x: 0, y: 0, width: 200, height: 30 }, "all"))).toEqual(["n", "ne", "nw", "s", "se", "sw"]);
    expect(ids(floatingHandleGeometry(BIG, "corners"))).toEqual(["ne", "nw", "se", "sw"]);
  });

  it("the mode comes from the region: data.handles === 'corners', else all", () => {
    expect(floatingHandleMode(region("a", BIG))).toBe("all");
    expect(floatingHandleMode(region("a", BIG, { handles: "corners" }))).toBe("corners");
    expect(floatingHandlesOf(region("a", BIG, { handles: "corners" }), GUTTERS, SCROLL)).toHaveLength(4);
  });

  it("each handle sits on its corner or edge midpoint, in canvas px (gutters and scroll applied)", () => {
    const rect = floatingCanvasRect(region("a", BIG), GUTTERS, { scrollX: 30, scrollY: 10 })!;
    expect(rect).toEqual({ x: 22 + 100 - 30, y: 20 + 50 - 10, width: 200, height: 120 });
    const at = Object.fromEntries(floatingHandleGeometry(rect, "all").map((h) => [h.id, [h.cx, h.cy]]));
    expect(at).toEqual({
      nw: [92, 60],
      n: [192, 60],
      ne: [292, 60],
      e: [292, 120],
      se: [292, 180],
      s: [192, 180],
      sw: [92, 180],
      w: [92, 120],
    });
    expect(floatingCanvasRect({ ...region("c", BIG), floating: undefined }, GUTTERS, SCROLL)).toBeNull();
  });

  it("each handle drags ONLY its own sides ('e' is the right edge alone)", () => {
    const edges = Object.fromEntries(floatingHandleGeometry(BIG, "all").map((h) => [h.id, h.edges]));
    const E = (left: boolean, right: boolean, top: boolean, bottom: boolean) => ({ left, right, top, bottom });
    expect(edges).toEqual({
      nw: E(true, false, true, false),
      n: E(false, false, true, false),
      ne: E(false, true, true, false),
      e: E(false, true, false, false),
      se: E(false, true, false, true),
      s: E(false, false, false, true),
      sw: E(true, false, false, true),
      w: E(true, false, false, false),
    });
  });

  it("each handle shows its own pointer", () => {
    const cursor = Object.fromEntries(floatingHandleGeometry(BIG, "all").map((h) => [h.id, h.cursor]));
    expect(cursor).toEqual({
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
    });
  });

  it("the centre of every PAINTED square hits its own handle and no other; the hit square never leaves the paint grown by 3px", () => {
    for (const rect of [BIG, { x: 7.5, y: 3.25, width: 61, height: 49 }, { x: 0, y: 0, width: 16, height: 16 }]) {
      const handles = floatingHandleGeometry(rect, "all");
      for (const h of handles) {
        expect(h.paint.width).toBe(FLOATING_HANDLE_PAINT_SIZE);
        expect(h.paint.height).toBe(FLOATING_HANDLE_PAINT_SIZE);
        expect(Number.isInteger(h.paint.x) && Number.isInteger(h.paint.y), "paint on whole pixels").toBe(true);
        const px = h.paint.x + h.paint.width / 2;
        const py = h.paint.y + h.paint.height / 2;
        expect(handles.filter((o) => floatingHandleHits(o, px, py)).map((o) => o.id), `painted centre of ${h.id}`).toEqual([h.id]);
        const grown = { x: h.paint.x - 3, y: h.paint.y - 3, r: h.paint.x + h.paint.width + 3, b: h.paint.y + h.paint.height + 3 };
        expect(h.hit.x).toBeGreaterThanOrEqual(grown.x);
        expect(h.hit.y).toBeGreaterThanOrEqual(grown.y);
        expect(h.hit.x + h.hit.width).toBeLessThanOrEqual(grown.r);
        expect(h.hit.y + h.hit.height).toBeLessThanOrEqual(grown.b);
      }
    }
  });

  it("the hit square is the centre +/- FLOATING_HANDLE_HIT_HALF, inclusive, and stays under 8 (the chart's quick-access buttons start at right + 8)", () => {
    const [nw] = floatingHandleGeometry(BIG, "all");
    expect(floatingHandleHits(nw, nw.cx + FLOATING_HANDLE_HIT_HALF, nw.cy - FLOATING_HANDLE_HIT_HALF)).toBe(true);
    expect(floatingHandleHits(nw, nw.cx + FLOATING_HANDLE_HIT_HALF + 1, nw.cy)).toBe(false);
    expect(FLOATING_HANDLE_HIT_HALF).toBeLessThan(8);
  });
});

describe("when handles are live", () => {
  const box = { x: 100, y: 50, width: 200, height: 120 };

  it("only on a SELECTED object", () => {
    surface();
    const r = region("a", box);
    expect(floatingHandlesLive(r), "an unselected object has live handles").toBe(false);
    selected.add("a");
    expect(floatingHandlesLive(r)).toBe(true);
  });

  it("never with no selection provider for the type (nothing can select it)", () => {
    selected.add("x");
    expect(floatingHandlesLive({ ...region("x", box), type: "nobody-owns-this" })).toBe(false);
  });

  it("never on a LOCKED object, in CONSUME mode or when the family published resizable: false", () => {
    selected.add("a");
    surface({ isLocked: () => true });
    expect(floatingHandlesLive(region("a", box)), "locked").toBe(false);
    cleanups.pop()!();
    surface({ editable: false });
    expect(floatingHandlesLive(region("a", box)), "consume mode").toBe(false);
    cleanups.pop()!();
    surface();
    expect(floatingHandlesLive(region("a", box, { resizable: false })), "resizable: false").toBe(false);
    expect(floatingHandlesLive(region("a", box)), "control").toBe(true);
  });

  it("never while a formula is picking a reference -- an external editor's, or the grid's (the registered probe)", () => {
    selected.add("a");
    surface();
    let expecting = true;
    const off = registerExternalFormulaTarget({ isExpectingReference: () => expecting, insertReference: () => {} });
    try {
      expect(floatingHandlesLive(region("a", box)), "external pick").toBe(false);
      expecting = false;
      expect(floatingHandlesLive(region("a", box)), "the same editor, not picking").toBe(true);
    } finally {
      off();
    }
    let grid = true;
    cleanups.push(registerGridReferencePickProbe(() => grid));
    expect(floatingHandlesLive(region("a", box)), "grid pick").toBe(false);
    grid = false;
    expect(floatingHandlesLive(region("a", box))).toBe(true);
  });

  it("a cell-anchored region has none", () => {
    expect(floatingHandlesLive({ ...region("a", box), floating: undefined })).toBe(false);
  });
});

describe("floatingHandleAt: the live handle under a point", () => {
  const LOWER = { x: 100, y: 100, width: 200, height: 150 };
  const UPPER = { x: 250, y: 200, width: 200, height: 150 };
  /** LOWER's bottom-right corner, INSIDE UPPER's body. */
  const HIDDEN = { x: 22 + 300, y: 20 + 250 };

  it("an UNSELECTED object's corner is not a handle", () => {
    surface();
    const regions = [region("lower", LOWER)];
    expect(floatingHandleAt(HIDDEN.x, HIDDEN.y, GUTTERS, SCROLL, regions)).toBeNull();
    selected.add("lower");
    expect(floatingHandleAt(HIDDEN.x, HIDDEN.y, GUTTERS, SCROLL, regions)?.handle.id).toBe("se");
  });

  it("a SELECTED object's handle painted over an object stacked above it is grabbable there (handles are topmost)", () => {
    surface();
    selected.add("lower");
    for (const zs of [[undefined, undefined], [0, 1]] as const) {
      const regions = [region("lower", LOWER, {}, zs[0]), region("upper", UPPER, {}, zs[1])];
      const hit = floatingHandleAt(HIDDEN.x, HIDDEN.y, GUTTERS, SCROLL, regions);
      expect(hit?.region.id, `z = ${String(zs)}`).toBe("lower");
      expect(hit?.handle.id).toBe("se");
    }
  });

  it("two selected objects whose handles overlap: the TOPMOST one's handle wins (the one painted last)", () => {
    surface();
    selected.add("a");
    selected.add("b");
    // Same top-left corner.
    const A = { x: 100, y: 100, width: 200, height: 150 };
    const B = { x: 100, y: 100, width: 120, height: 90 };
    const at = { x: 22 + 100, y: 20 + 100 };
    // Without z: the later-published region is on top (floatingHitOrder).
    expect(floatingHandleAt(at.x, at.y, GUTTERS, SCROLL, [region("a", A), region("b", B)])?.region.id).toBe("b");
    // With z: z decides, whatever the publication order.
    expect(floatingHandleAt(at.x, at.y, GUTTERS, SCROLL, [region("a", A, {}, 2), region("b", B, {}, 1)])?.region.id).toBe("a");
    cleanups.push(registerRegionStacking((r) => ({ a: 0, b: 5 })[r.id]));
    expect(floatingHandleAt(at.x, at.y, GUTTERS, SCROLL, [region("b", B), region("a", A)])?.region.id).toBe("b");
  });

  it("nothing in the header GUTTERS, where the headers paint over the chrome: an object at sheet (0, 0) keeps only the cell-area half of its top and left handles", () => {
    surface();
    selected.add("edge");
    // Top-left corner exactly at the gutters' inner corner (22, 20).
    const regions = [region("edge", { x: 0, y: 0, width: 200, height: 150 })];
    const nMid = 22 + 100;
    const wMid = 20 + 75;
    // Control: the cell-area half of each still resizes.
    expect(floatingHandleAt(nMid, 20 + 4, GUTTERS, SCROLL, regions)?.handle.id).toBe("n");
    expect(floatingHandleAt(22 + 4, wMid, GUTTERS, SCROLL, regions)?.handle.id).toBe("w");
    expect(floatingHandleAt(22 + 3, 20 + 3, GUTTERS, SCROLL, regions)?.handle.id).toBe("nw");
    // The half under the column header / row header is the header's.
    for (const y of [20 - 1, 20 - 4, 20 - 6]) {
      expect(floatingHandleAt(nMid, y, GUTTERS, SCROLL, regions), `n at y=${y} (column header)`).toBeNull();
      expect(floatingHandleAt(22 + 200, y, GUTTERS, SCROLL, regions), `ne at y=${y} (column header)`).toBeNull();
    }
    for (const x of [22 - 1, 22 - 4, 22 - 6]) {
      expect(floatingHandleAt(x, wMid, GUTTERS, SCROLL, regions), `w at x=${x} (row header)`).toBeNull();
      expect(floatingHandleAt(x, 20 + 150, GUTTERS, SCROLL, regions), `sw at x=${x} (row header)`).toBeNull();
    }
    // Scrolled so the whole top edge sits under the column header: no top handle anywhere.
    const scrolled = { scrollX: 0, scrollY: 10 };
    expect(floatingHandleAt(nMid, 20 - 10, GUTTERS, scrolled, regions), "n's centre under the header").toBeNull();
    // A canvas / headings off (gutters 0): nothing is clipped.
    const none = { rowHeaderWidth: 0, colHeaderHeight: 0 };
    expect(floatingHandleAt(100, 0, none, SCROLL, regions)?.handle.id).toBe("n");
  });

  it("the hit is exactly the handles (every id reachable at its centre, nothing in the object's middle)", () => {
    surface();
    selected.add("a");
    const regions = [region("a", LOWER)];
    const found = new Set<FloatingHandleId>();
    for (const h of floatingHandlesOf(regions[0], GUTTERS, SCROLL)) {
      const hit = floatingHandleAt(h.cx, h.cy, GUTTERS, SCROLL, regions);
      if (hit) found.add(hit.handle.id);
    }
    expect([...found].sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
    expect(floatingHandleAt(22 + 200, 20 + 175, GUTTERS, SCROLL, regions)).toBeNull();
  });
});
