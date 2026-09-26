//! FILENAME: app/src/api/__tests__/gridOverlaysStacking.test.ts
// PURPOSE: The ONE z-order (M8 part A): `stackedFloatingRegions` (paint order,
//          bottom first) and `floatingHitOrder` (topmost first), the stacking
//          resolver seam, and the topmost-region lookups built on them.
// CONTEXT: Before M8 there were three "topmost" rules -- paint by overlay
//          priority then publication order, the body press by REVERSE
//          publication order, the resize scan by FORWARD publication order --
//          and a family re-publishing on a drag frame moved its regions to the
//          array end, so which object a press reached depended on which family
//          synced last. The cases below pin two things:
//
//          - WITHOUT any effective z both orders are exactly the historical
//            ones (so worksheets, and a canvas whose zOrder is empty, behave
//            as before);
//          - WITH one, z beats per-type priority AND publication order, a
//            region without a z paints above every region with one, and the
//            hit order is the EXACT reverse of the paint order.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const snapshot = {
  surface: "canvas" as "canvas" | "grid",
  displayHeadings: true,
  zoom: 1,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
};
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import {
  effectiveZ,
  floatingHitOrder,
  hasStackingOrder,
  isOccludedAtClientPoint,
  registerGridOverlay,
  registerRegionStacking,
  setGridRegions,
  stackedFloatingRegions,
  topFloatingRegionAt,
  topFloatingRegionAtClient,
  type GridRegion,
} from "../gridOverlays";

function floating(id: string, type: string, extra: Partial<GridRegion> = {}, box = { x: 0, y: 0, width: 100, height: 100 }): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: box, ...extra };
}

const ids = (rs: GridRegion[]) => rs.map((r) => r.id);

const cleanups: Array<() => void> = [];
beforeEach(() => {
  snapshot.surface = "canvas";
  snapshot.zoom = 1;
  snapshot.viewport = { scrollX: 0, scrollY: 0 };
  // Registration order is the tie-break at equal priority, as in the renderer.
  cleanups.push(
    registerGridOverlay({ type: "pivot-visual", render: () => {}, priority: 12 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 12 }),
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "timeline-slicer", render: () => {}, priority: 16 }),
  );
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("without any effective z: exactly the historical orders", () => {
  const regions = [
    floating("t1", "timeline-slicer"),
    floating("c1", "chart"),
    { id: "cell", type: "table", startRow: 0, startCol: 0, endRow: 3, endCol: 3 } as GridRegion,
    floating("k1", "floating-control"),
    floating("s1", "slicer"),
    floating("c2", "chart"),
    floating("p1", "pivot-visual"),
  ];

  it("paint: overlay priority, registration order on ties, then publication order", () => {
    expect(hasStackingOrder(regions)).toBe(false);
    expect(ids(stackedFloatingRegions(regions))).toEqual(["p1", "k1", "c1", "c2", "s1", "t1"]);
  });

  it("hit: reverse publication order, floating regions only (Core's press, unchanged)", () => {
    expect(ids(floatingHitOrder(regions))).toEqual(["p1", "c2", "s1", "k1", "c1", "t1"]);
  });

  it("a registered resolver with no opinion changes nothing", () => {
    cleanups.push(registerRegionStacking(() => undefined));
    expect(hasStackingOrder(regions)).toBe(false);
    expect(ids(floatingHitOrder(regions))).toEqual(["p1", "c2", "s1", "k1", "c1", "t1"]);
  });
});

describe("with a stacking order (z-mode)", () => {
  it("z beats per-type priority and publication order in PAINT", () => {
    // Timeline (priority 16) at the bottom, pivot box (12) on top.
    const regions = [floating("p1", "pivot-visual", { z: 1 }), floating("t1", "timeline-slicer", { z: 0 })];
    expect(ids(stackedFloatingRegions(regions))).toEqual(["t1", "p1"]);
  });

  it("the HIT order is the exact reverse of the paint order", () => {
    const regions = [
      floating("s1", "slicer", { z: 2 }),
      floating("c1", "chart"),
      floating("k1", "floating-control", { z: 0 }),
      floating("t1", "timeline-slicer", { z: 1 }),
      floating("p1", "pivot-visual"),
    ];
    const paint = ids(stackedFloatingRegions(regions));
    expect(paint).toEqual(["k1", "t1", "s1", "p1", "c1"]);
    expect(ids(floatingHitOrder(regions))).toEqual([...paint].reverse());
  });

  it("regions WITHOUT a z paint above every region with one (a new object is on top)", () => {
    const regions = [floating("new", "pivot-visual"), floating("placed", "timeline-slicer", { z: 99 })];
    expect(ids(stackedFloatingRegions(regions))).toEqual(["placed", "new"]);
    expect(ids(floatingHitOrder(regions))[0]).toBe("new");
  });

  it("the resolver supplies z; a region's own z wins over it", () => {
    const zOf: Record<string, number> = { a: 5, b: 1 };
    cleanups.push(registerRegionStacking((r) => zOf[r.id]));
    const a = floating("a", "chart");
    const b = floating("b", "chart", { z: 9 });
    expect(effectiveZ(a)).toBe(5);
    expect(effectiveZ(b)).toBe(9);
    expect(ids(stackedFloatingRegions([b, a]))).toEqual(["a", "b"]);
  });

  it("re-publication does not move an object in the stack (hit order no longer follows the array)", () => {
    cleanups.push(registerRegionStacking((r) => ({ c1: 1, s1: 0 })[r.id]));
    const c1 = floating("c1", "chart");
    const s1 = floating("s1", "slicer");
    expect(ids(floatingHitOrder([c1, s1]))).toEqual(["c1", "s1"]);
    // The slicer re-synced on a drag frame and moved to the array end:
    expect(ids(floatingHitOrder([c1, s1].reverse()))).toEqual(["c1", "s1"]);
  });

  it("cell-anchored regions never take part", () => {
    const cell = { id: "cell", type: "chart", startRow: 0, startCol: 0, endRow: 1, endCol: 1, z: 3 } as GridRegion;
    expect(hasStackingOrder([cell])).toBe(false);
    expect(stackedFloatingRegions([cell])).toEqual([]);
  });
});

describe("effectiveZ and the resolver seam", () => {
  it("ignores a non-finite z and a throwing resolver (no opinion)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(effectiveZ(floating("n", "chart", { z: Number.NaN }))).toBeUndefined();
    cleanups.push(
      registerRegionStacking(() => {
        throw new Error("boom");
      }),
    );
    expect(effectiveZ(floating("x", "chart"))).toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("last registration wins, and a stale cleanup cannot remove a newer resolver", () => {
    const offFirst = registerRegionStacking(() => 1);
    cleanups.push(registerRegionStacking(() => 2));
    offFirst();
    expect(effectiveZ(floating("x", "chart"))).toBe(2);
  });
});

describe("topFloatingRegionAt", () => {
  const geo = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };
  // `under` (priority 16) and `over` (priority 12) overlap in [50..100]^2.
  const under = floating("under", "timeline-slicer", {}, { x: 0, y: 0, width: 100, height: 100 });
  const over = floating("over", "pivot-visual", {}, { x: 50, y: 50, width: 100, height: 100 });

  it("without z: the LAST published region under the point", () => {
    expect(topFloatingRegionAt(60, 60, geo, [under, over])?.id).toBe("over");
    expect(topFloatingRegionAt(60, 60, geo, [over, under])?.id).toBe("under");
    expect(topFloatingRegionAt(10, 10, geo, [under, over])?.id).toBe("under");
    expect(topFloatingRegionAt(500, 500, geo, [under, over])).toBeNull();
  });

  it("with z: the region painted on top, whatever the publication order", () => {
    const regions = [{ ...over, z: 0 }, { ...under, z: 1 }];
    expect(topFloatingRegionAt(60, 60, geo, regions)?.id).toBe("under");
    expect(topFloatingRegionAt(60, 60, geo, [...regions].reverse())?.id).toBe("under");
  });

  it("defaults to the live geometry with the PAINTED gutters (none on a canvas)", () => {
    setGridRegions([under]);
    expect(topFloatingRegionAt(5, 5)?.id).toBe("under");
    snapshot.surface = "grid";
    expect(topFloatingRegionAt(5, 5)).toBeNull(); // inside the 50 x 24 gutters
    expect(topFloatingRegionAt(55, 29)?.id).toBe("under");
  });
});

describe("the client-point lookups", () => {
  let area: HTMLElement;
  beforeEach(() => {
    area = document.createElement("div");
    area.setAttribute("data-grid-area", "");
    area.getBoundingClientRect = () =>
      ({ left: 10, top: 20, right: 1010, bottom: 820, width: 1000, height: 800, x: 10, y: 20, toJSON() {} }) as DOMRect;
    document.body.appendChild(area);
  });
  afterEach(() => area.remove());

  it("converts relative to the grid area and divides by the zoom", () => {
    setGridRegions([floating("a", "chart", {}, { x: 100, y: 100, width: 50, height: 50 })]);
    snapshot.zoom = 2;
    // Canvas (110, 110) is client (10 + 220, 20 + 220) at zoom 2.
    expect(topFloatingRegionAtClient(230, 240)?.id).toBe("a");
    expect(topFloatingRegionAtClient(130, 140)).toBeNull();
    // Outside the grid area entirely.
    expect(topFloatingRegionAtClient(5, 5)).toBeNull();
  });

  it("isOccludedAtClientPoint: true only when ANOTHER object is on top", () => {
    const chart = floating("c", "chart", {}, { x: 0, y: 0, width: 200, height: 200 });
    const slicer = floating("s", "slicer", {}, { x: 50, y: 50, width: 100, height: 100 });
    const isChart = (r: GridRegion) => r.type === "chart";
    setGridRegions([chart, slicer]);
    expect(isOccludedAtClientPoint(10 + 60, 20 + 60, isChart)).toBe(true); // the slicer is on top
    expect(isOccludedAtClientPoint(10 + 10, 20 + 10, isChart)).toBe(false); // only the chart
    expect(isOccludedAtClientPoint(10 + 500, 20 + 500, isChart)).toBe(false); // nothing there
    // Stacked: the chart placed above the slicer owns the overlap.
    cleanups.push(registerRegionStacking((r) => ({ s: 0, c: 1 })[r.id]));
    expect(isOccludedAtClientPoint(10 + 60, 20 + 60, isChart)).toBe(false);
  });
});
