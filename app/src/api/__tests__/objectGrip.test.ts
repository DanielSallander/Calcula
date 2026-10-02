//! FILENAME: app/src/api/__tests__/objectGrip.test.ts
// PURPOSE: The GRIP seam for extensions (@api/objectGrip; BUG-0258 design
//          phase 5): the click event it re-exports is Core's own, and it is ALL
//          the seam carries -- the grip-only client-point door it once had
//          (`floatingGripAtClient`) had no consumer and was removed (M7 review).
//          The client-point question a consumer asks instead is the facade's
//          grip-aware `topFloatingRegionAtClient` (plan decision D6): it
//          converts a CLIENT point the way Core's own mouse handling does
//          (relative to the grid area, divided by the zoom) and answers a
//          VISIBLE grip's object there -- and nothing while the grip is hidden,
//          outside the grid area, or before the grid is mounted.
// CONTEXT: The grip's geometry and visibility rule are pinned in
//          core/lib/__tests__/floatingGrip.test.ts; the canvas-point probe in
//          src/api/__tests__/gridOverlays.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_GRID_CONFIG } from "../../core/types";

const grid = vi.hoisted(() => ({
  snapshot: null as null | Record<string, unknown>,
}));
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => grid.snapshot,
}));

import * as objectGrip from "../objectGrip";
import { FLOATING_GRIP_CLICK_EVENT } from "../objectGrip";
import * as core from "../../core/lib/floatingGrip";
import { setGridRegions, topFloatingRegionAtClient, type GridRegion } from "../gridOverlays";
import { resetObjectHoverForTests, setHoveredFloatingRegion } from "../../core/lib/objectHover";

/** The grid area's client rectangle. */
const AREA = { left: 100, top: 50, width: 1000, height: 700 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 22;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 20;

/** A header-less slicer stand-in: 200 x 100 at sheet (100, 100), asking for a hover grip. */
const S: GridRegion = {
  id: "s1",
  type: "object-grip-test",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 100, width: 200, height: 100 },
  data: { grip: "hover" },
};

function snapshotAt(zoom: number): Record<string, unknown> {
  return {
    surface: "grid",
    zoom,
    sheetContext: { activeSheetIndex: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    config: DEFAULT_GRID_CONFIG,
    displayHeadings: true,
    editing: null,
  };
}

/** The grip's hit square in CLIENT px at `zoom`, from Core's own geometry. */
function gripClientRect(zoom: number): { x: number; y: number; width: number; height: number } {
  const g = core.floatingGripOf(S, { rowHeaderWidth: RHW, colHeaderHeight: CHH }, { scrollX: 0, scrollY: 0 }, zoom, null)!;
  return { x: AREA.left + g.hit.x * zoom, y: AREA.top + g.hit.y * zoom, width: g.hit.width * zoom, height: g.hit.height * zoom };
}

beforeEach(() => {
  grid.snapshot = snapshotAt(1);
  resetObjectHoverForTests();
  const area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () =>
    ({
      left: AREA.left,
      top: AREA.top,
      right: AREA.left + AREA.width,
      bottom: AREA.top + AREA.height,
      x: AREA.left,
      y: AREA.top,
      width: AREA.width,
      height: AREA.height,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(area);
  setGridRegions([S]);
});

afterEach(() => {
  grid.snapshot = null;
  resetObjectHoverForTests();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("the client-point question is the facade's grip-aware topFloatingRegionAtClient", () => {
  for (const zoom of [1, 2]) {
    it(`at zoom ${zoom}: a client point on a VISIBLE grip (24 x 24 client px) answers the grip's object`, () => {
      grid.snapshot = snapshotAt(zoom);
      setHoveredFloatingRegion("s1");
      const r = gripClientRect(zoom);
      expect(r.width).toBeCloseTo(24, 9);
      expect(topFloatingRegionAtClient(r.x + r.width / 2, r.y + r.height / 2)?.id).toBe("s1");
    });
  }

  it("nothing while the grip is hidden (the object neither hovered nor selected)", () => {
    const r = gripClientRect(1);
    expect(topFloatingRegionAtClient(r.x + 12, r.y + 12)).toBeNull();
  });

  it("nothing outside the grid area, and before the grid is mounted", () => {
    setHoveredFloatingRegion("s1");
    expect(topFloatingRegionAtClient(AREA.left - 5, AREA.top + 100), "left of the grid area").toBeNull();
    const r = gripClientRect(1);
    grid.snapshot = null;
    expect(topFloatingRegionAtClient(r.x + 12, r.y + 12), "no grid mounted").toBeNull();
  });
});

describe("@api/objectGrip", () => {
  it("the click event is Core's own, under its one name", () => {
    expect(FLOATING_GRIP_CLICK_EVENT).toBe(core.FLOATING_GRIP_CLICK_EVENT);
    expect(FLOATING_GRIP_CLICK_EVENT).toBe("floatingObject:gripClick");
  });

  it("carries the event and nothing else (no consumer door without a consumer)", () => {
    expect(Object.keys(objectGrip).sort()).toEqual(["FLOATING_GRIP_CLICK_EVENT"]);
  });
});
