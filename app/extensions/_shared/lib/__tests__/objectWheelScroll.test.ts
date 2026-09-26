//! FILENAME: app/extensions/_shared/lib/__tests__/objectWheelScroll.test.ts
// PURPOSE: The shared wheel route for floating objects' content.
//          - on a CANVAS the header gutters are 0 even though the stored config
//            still says 50x24 (the Slicer copy reads the raw config and is one
//            gutter off there);
//          - the topmost object wins, and an object covered by an unregistered
//            one does not scroll behind it;
//          - no overflow on the wheeled axis passes the wheel to the page;
//          - a claimed pointer is not ours;
//          - line/page deltaMode and Shift-for-horizontal;
//          - preventDefault only when the wheel is consumed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const snapshot = {
  surface: "canvas" as "canvas" | "grid",
  displayHeadings: true,
  zoom: 1,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
};

vi.mock("@api/grid", async () => {
  const header = await vi.importActual<typeof import("../../../../src/core/lib/gridRenderer/layout/headerVisibility")>(
    "../../../../src/core/lib/gridRenderer/layout/headerVisibility",
  );
  return {
    getGridStateSnapshot: () => snapshot,
    resolveHeaderSizes: header.resolveHeaderSizes,
  };
});

vi.mock("@api", async () => {
  const claims = await vi.importActual<typeof import("../../../../src/core/lib/pointerClaims")>(
    "../../../../src/core/lib/pointerClaims",
  );
  return { isPointerClaimed: claims.isPointerClaimed };
});

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  registerObjectWheelTarget,
  handleObjectWheel,
  topFloatingRegionAt,
  wheelDeltaPx,
  applyWheelDelta,
  isObjectWheelListening,
  type ObjectWheelScroll,
} from "../objectWheelScroll";

let area: HTMLElement;

function floating(id: string, type: string, x: number, y: number, w: number, h: number): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width: w, height: h }, data: { id } };
}

function wheel(clientX: number, clientY: number, init: WheelEventInit = {}, target: EventTarget = area): WheelEvent {
  const e = new WheelEvent("wheel", { clientX, clientY, deltaY: 120, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

/** A target whose objects have a fixed scroll state, recording setScroll. */
function makeTarget(type: string, state: ObjectWheelScroll) {
  const set = vi.fn();
  const cleanup = registerObjectWheelTarget({
    types: [type],
    getScroll: () => ({ ...state }),
    setScroll: (_r, left, top) => set(left, top),
  });
  return { set, cleanup };
}

beforeEach(() => {
  snapshot.surface = "canvas";
  snapshot.zoom = 1;
  snapshot.viewport = { scrollX: 0, scrollY: 0 };
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () => ({ left: 10, top: 20, width: 1000, height: 800, right: 1010, bottom: 820, x: 10, y: 20, toJSON() {} }) as DOMRect;
  document.body.appendChild(area);
  setGridRegions([]);
});

afterEach(() => {
  area.remove();
});

describe("topFloatingRegionAt", () => {
  const geo = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };

  it("returns the LAST published region under the point (Core's press order)", () => {
    const a = floating("a", "pivot-visual", 0, 0, 100, 100);
    const b = floating("b", "slicer", 50, 50, 100, 100);
    expect(topFloatingRegionAt([a, b], 60, 60, geo)?.id).toBe("b");
    expect(topFloatingRegionAt([a, b], 20, 20, geo)?.id).toBe("a");
    expect(topFloatingRegionAt([a, b], 500, 500, geo)).toBeNull();
  });

  it("ignores cell-anchored regions", () => {
    const cellRegion: GridRegion = { id: "c", type: "pivot", startRow: 0, startCol: 0, endRow: 5, endCol: 5 };
    expect(topFloatingRegionAt([cellRegion], 1, 1, geo)).toBeNull();
  });
});

describe("wheelDeltaPx / applyWheelDelta", () => {
  it("pixel mode is taken as is; line mode multiplies by the line size; page mode by the object", () => {
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: false }, 24, { width: 300, height: 200 })).toEqual({ dx: 0, dy: 120 });
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 24, { width: 300, height: 200 })).toEqual({ dx: 0, dy: 72 });
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, 24, { width: 300, height: 200 })).toEqual({ dx: 0, dy: 200 });
  });

  it("Shift turns a vertical wheel horizontal", () => {
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }, 20, { width: 1, height: 1 })).toEqual({ dx: 100, dy: 0 });
  });

  it("clamps, and returns null when no wheeled axis overflows", () => {
    const s = { left: 0, top: 90, maxLeft: 0, maxTop: 100 };
    expect(applyWheelDelta(s, 0, 50)).toEqual({ left: 0, top: 100 });
    expect(applyWheelDelta(s, 0, -500)).toEqual({ left: 0, top: 0 });
    expect(applyWheelDelta(s, 40, 0)).toBeNull();
    expect(applyWheelDelta({ left: 0, top: 0, maxLeft: 0, maxTop: 0 }, 0, 120)).toBeNull();
  });
});

describe("handleObjectWheel", () => {
  it("installs ONE window listener with the first target and removes it with the last", () => {
    expect(isObjectWheelListening()).toBe(false);
    const a = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    const b = makeTarget("floating-grid", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    expect(isObjectWheelListening()).toBe(true);
    a.cleanup();
    expect(isObjectWheelListening()).toBe(true);
    b.cleanup();
    expect(isObjectWheelListening()).toBe(false);
  });

  it("on a canvas the gutters are 0: a wheel at the object's painted position scrolls it", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 100, 100, 300, 200)]);
    // Client (10 + 110, 20 + 110) = canvas (110, 110): inside the box at page (100,100).
    const e = wheel(120, 130);
    expect(handleObjectWheel(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(t.set).toHaveBeenCalledWith(0, 120);
    t.cleanup();
  });

  it("on a canvas a point one (stale) header gutter away does NOT hit the box", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 40, 20)]);
    // With the raw config (50x24) the box would be at canvas (50,24)..(90,44).
    const e = wheel(10 + 60, 20 + 30);
    expect(handleObjectWheel(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    t.cleanup();
  });

  it("on a worksheet the header gutters apply", () => {
    snapshot.surface = "grid";
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 40, 20)]);
    expect(handleObjectWheel(wheel(10 + 60, 20 + 30))).toBe(true);
    t.cleanup();
  });

  it("divides by the zoom", () => {
    snapshot.zoom = 2;
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 100, 100, 50, 50)]);
    // Canvas (110,110) is client 10 + 220, 20 + 220 at zoom 2.
    expect(handleObjectWheel(wheel(230, 240))).toBe(true);
    expect(handleObjectWheel(wheel(130, 140))).toBe(false);
    t.cleanup();
  });

  it("the topmost object decides: an unregistered object on top passes the wheel through", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([
      floating("p", "pivot-visual", 0, 0, 300, 300),
      floating("chart", "chart", 50, 50, 100, 100),
    ]);
    const covered = wheel(10 + 60, 20 + 60);
    expect(handleObjectWheel(covered)).toBe(false);
    expect(covered.defaultPrevented).toBe(false);
    expect(t.set).not.toHaveBeenCalled();
    t.cleanup();
  });

  it("with a stacking order (a canvas's zOrder) the placed order decides, not publication (M8)", async () => {
    const { registerRegionStacking } = await import("@api/gridOverlays");
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    // Same geometry as above, but the box is placed ABOVE the chart.
    const off = registerRegionStacking((r) => ({ chart: 0, p: 1 })[r.id]);
    setGridRegions([
      floating("p", "pivot-visual", 0, 0, 300, 300),
      floating("chart", "chart", 50, 50, 100, 100),
    ]);
    expect(handleObjectWheel(wheel(10 + 60, 20 + 60))).toBe(true);
    expect(t.set).toHaveBeenCalled();
    off();
    t.cleanup();
  });

  it("no overflow: the wheel passes through to the page", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 0 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 300, 300)]);
    const e = wheel(20, 30);
    expect(handleObjectWheel(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    t.cleanup();
  });

  it("at the edge the wheel is still consumed (the page does not scroll under the box)", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 500, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 300, 300)]);
    const e = wheel(20, 30);
    expect(handleObjectWheel(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(t.set).not.toHaveBeenCalled();
    t.cleanup();
  });

  it("a claimed pointer is not ours", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 300, 300)]);
    const claimant = document.createElement("div");
    claimant.setAttribute("data-pointer-claim", "test-form");
    const inner = document.createElement("span");
    claimant.appendChild(inner);
    area.appendChild(claimant);
    const e = wheel(20, 30, {}, inner);
    expect(handleObjectWheel(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(t.set).not.toHaveBeenCalled();
    t.cleanup();
  });

  it("is reached through the real window listener", () => {
    const t = makeTarget("pivot-visual", { left: 0, top: 0, maxLeft: 0, maxTop: 500 });
    setGridRegions([floating("p", "pivot-visual", 0, 0, 300, 300)]);
    const e = new WheelEvent("wheel", { clientX: 20, clientY: 30, deltaY: 60, bubbles: true, cancelable: true });
    area.dispatchEvent(e);
    expect(t.set).toHaveBeenCalledWith(0, 60);
    expect(e.defaultPrevented).toBe(true);
    t.cleanup();
  });
});
