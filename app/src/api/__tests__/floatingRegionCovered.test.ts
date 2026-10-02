//! FILENAME: app/src/api/__tests__/floatingRegionCovered.test.ts
// PURPOSE: THE "RELEASED INSIDE" RULE's occlusion half (@api/gridOverlays
//          `isFloatingRegionCoveredAt` / `isFloatingRegionCoveredAtClient`,
//          BUG-0258 M7 review): whether ANOTHER floating object takes a point
//          before a given one, in Core's press order --
//            - an object stacked ABOVE it whose rectangle holds the point
//              covers it; one BELOW it never does;
//            - an object above it whose registration's extended `hitTest`
//              claims the point (a chart's quick-access buttons, outside its
//              edge) covers it;
//            - a point OUTSIDE the object's own rectangle with nothing above it
//              there is not covered (the family's own hit test decides which
//              part of it is there);
//            - another object's VISIBLE grip at the point covers it; the
//              object's own grip does not;
//            - no geometry (before mount), or an object that is not live:
//              nothing is known to cover it;
//            - the client-point door converts the way Core's mouse handling
//              does (relative to the grid area, divided by the zoom).
// CONTEXT: Every content press that acts at its release asks this: a run-mode
//          button (through `topFloatingRegionAtClient`), the slicer's Select
//          all / clear button, a pivot box's chrome, a chart's buttons.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const snap = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => snap.value,
}));

import {
  isFloatingRegionCoveredAt,
  isFloatingRegionCoveredAtClient,
  registerGridOverlay,
  setGridRegions,
  unregisterGridOverlay,
  type GridRegion,
} from "../gridOverlays";
import { resetObjectHoverForTests, setHoveredFloatingRegion } from "../../core/lib/objectHover";
import { floatingGripOf } from "../../core/lib/floatingGrip";

const GEO = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };
const TYPE = "covered-test";
const EXTENDED_TYPE = "covered-extended-test";

function region(id: string, box: { x: number; y: number; width: number; height: number }, type = TYPE, data: Record<string, unknown> = {}): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: box, data };
}

/** The object whose release is asked about: 200 x 100 at (100, 100). */
const TARGET = region("target", { x: 100, y: 100, width: 200, height: 100 });
/** Published BEFORE the target: below it. Covers its left half. */
const BELOW = region("below", { x: 50, y: 80, width: 150, height: 150 });
/** Published AFTER the target: above it. Covers its right quarter. */
const ABOVE = region("above", { x: 250, y: 90, width: 120, height: 60 });

let area: HTMLElement | null = null;

beforeEach(() => {
  snap.value = null;
  resetObjectHoverForTests();
});

afterEach(() => {
  resetObjectHoverForTests();
  unregisterGridOverlay(EXTENDED_TYPE);
  setGridRegions([]);
  area?.remove();
  area = null;
});

describe("isFloatingRegionCoveredAt: another object takes the point first, in Core's press order", () => {
  const regions = [BELOW, TARGET, ABOVE];

  it("an object stacked ABOVE whose rectangle holds the point covers it; one BELOW never does", () => {
    expect(isFloatingRegionCoveredAt("target", 280, 120, GEO, regions), "the object above covers its right quarter").toBe(true);
    expect(isFloatingRegionCoveredAt("target", 150, 150, GEO, regions), "the object below never covers it").toBe(false);
    expect(isFloatingRegionCoveredAt("target", 200, 180, GEO, regions), "a point only it holds").toBe(false);
  });

  it("an object above whose registration's extended hitTest claims the point covers it (a chart's quick-access buttons)", () => {
    // Above the target, its rectangle well away; its hitTest claims a strip beside the target's right edge.
    const chartLike = region("chartlike", { x: 600, y: 300, width: 50, height: 50 }, EXTENDED_TYPE);
    registerGridOverlay({
      type: EXTENDED_TYPE,
      render: () => {},
      hitTest: (ctx) => ctx.canvasX >= 290 && ctx.canvasX <= 320 && ctx.canvasY >= 150 && ctx.canvasY <= 180,
    });
    expect(isFloatingRegionCoveredAt("target", 295, 160, GEO, [TARGET, chartLike])).toBe(true);
    expect(isFloatingRegionCoveredAt("target", 280, 190, GEO, [TARGET, chartLike]), "outside the claimed strip").toBe(false);
  });

  it("a point OUTSIDE the object's own rectangle with nothing above it there is not covered (the family's own hit test decides)", () => {
    // A chart's quick-access button sits beside its right edge.
    expect(isFloatingRegionCoveredAt("target", 310, 190, GEO, [TARGET])).toBe(false);
    // ...and a LOWER object holding that point still does not cover it (Core's press reaches the target's extended hit first).
    const lower = region("lower", { x: 305, y: 180, width: 50, height: 50 });
    expect(isFloatingRegionCoveredAt("target", 310, 190, GEO, [lower, TARGET])).toBe(false);
  });

  it("another object's VISIBLE grip at the point covers it; the object's own grip does not", () => {
    // A header-less neighbour BELOW the target whose hover grip lies over the target's body.
    const neighbour = region("neighbour", { x: 90, y: 210, width: 200, height: 80 }, TYPE, { grip: "hover" });
    const g = floatingGripOf(neighbour, GEO, GEO, 1, null)!;
    const onGrip = { x: g.hit.x + g.hit.width / 2, y: g.hit.y + g.hit.height / 2 };
    expect(onGrip.y, "precondition: the neighbour's grip lies over the target").toBeLessThan(200);
    const regions2 = [neighbour, TARGET];
    expect(isFloatingRegionCoveredAt("target", onGrip.x, onGrip.y, GEO, regions2), "hidden grip: not covered").toBe(false);
    setHoveredFloatingRegion("neighbour");
    expect(isFloatingRegionCoveredAt("target", onGrip.x, onGrip.y, GEO, regions2), "a visible grip of ANOTHER object covers it").toBe(true);
    expect(isFloatingRegionCoveredAt("neighbour", onGrip.x, onGrip.y, GEO, regions2), "its own grip does not").toBe(false);
  });

  it("nothing is known to cover it before the grid mounts (no geometry), or when the object is not live", () => {
    expect(isFloatingRegionCoveredAt("target", 280, 120, null, regions)).toBe(false);
    expect(isFloatingRegionCoveredAt("gone", 280, 120, GEO, regions)).toBe(false);
  });
});

describe("isFloatingRegionCoveredAtClient: the client-point door", () => {
  function mountArea(left: number, top: number): void {
    area = document.createElement("div");
    area.setAttribute("data-grid-area", "");
    area.getBoundingClientRect = () =>
      ({ left, top, right: left + 2000, bottom: top + 2000, width: 2000, height: 2000, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(area);
  }

  function mountSnapshot(zoom: number): void {
    snap.value = {
      zoom,
      surface: "grid",
      displayHeadings: false,
      config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
      viewport: { scrollX: 0, scrollY: 0 },
      sheetContext: { activeSheetIndex: 0 },
      editing: null,
    };
  }

  for (const zoom of [1, 2]) {
    it(`at zoom ${zoom}: relative to the grid area, divided by the zoom`, () => {
      mountArea(40, 120);
      mountSnapshot(zoom);
      setGridRegions([BELOW, TARGET, ABOVE]);
      // Canvas (280, 120) is under ABOVE; canvas (200, 180) is the target's alone.
      expect(isFloatingRegionCoveredAtClient("target", 40 + 280 * zoom, 120 + 120 * zoom)).toBe(true);
      expect(isFloatingRegionCoveredAtClient("target", 40 + 200 * zoom, 120 + 180 * zoom)).toBe(false);
    });
  }

  it("false outside the grid area, and with no grid area at all", () => {
    mountSnapshot(1);
    setGridRegions([BELOW, TARGET, ABOVE]);
    expect(isFloatingRegionCoveredAtClient("target", 280, 120), "no grid area").toBe(false);
    mountArea(40, 120);
    expect(isFloatingRegionCoveredAtClient("target", 10, 10), "left of / above the grid area").toBe(false);
  });
});
