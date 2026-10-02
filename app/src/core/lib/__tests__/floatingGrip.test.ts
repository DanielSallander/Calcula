//! FILENAME: app/src/core/lib/__tests__/floatingGrip.test.ts
// PURPOSE: THE grip (core/lib/floatingGrip.ts; BUG-0258 design phase 5):
//          (a) its hit square is 24 SCREEN px at every zoom, its painted plate
//              lies inside it and is hit at its centre, a point 1px outside it
//              is not, and it never takes a point of its own object nor of
//              the top edge's midpoint clearance (Core's n handle, a floating
//              grid's ball); a NARROW object's grip sits beside its left edge,
//              level with its top edge, so the straight path from the body to
//              the grip never crosses a point on neither (the hover would end
//              there, and a hover grip with it);
//          (b) it sits above the object, below it where there is no room above,
//              and nowhere on a canvas page with no room either way;
//          (c) THE visibility rule: on a worksheet only a `grip: "hover"`
//              region shows it, hovered or selected (a titled chart never);
//              on a canvas the selection's PRIMARY member shows it too, and
//              only that one; never on a locked, subscribed or immovable
//              object, nor during a reference pick, a Core gesture or a held
//              content gesture;
//          (d) nothing in the header gutters, topmost first where two overlap,
//              and never a point the grip's OWN object claims through its
//              overlay's extended hitTest (a selected floating grid's yellow
//              edge ball, painted above the grip, reaching past its left edge).
// CONTEXT: The painter is pinned in lib/gridRenderer/floatingChromePaint.test.ts,
//          the press in hooks/useMouseSelection/layout/__tests__/overlayGripPress.test.ts,
//          the hover in hooks/useMouseSelection/__tests__/gripHoverWiring.test.tsx
//          and the facade's probe in src/api/__tests__/gridOverlays.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const snap = vi.hoisted(() => ({
  value: {
    surface: "grid" as "grid" | "canvas",
    zoom: 1,
    sheetContext: { activeSheetIndex: 0 },
    editing: null as null | { sourceSheetIndex?: number },
  },
}));
vi.mock("../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/GridContext")>()),
  getGridStateSnapshot: () => snap.value,
}));

import {
  currentGripEnv,
  floatingGripAnchor,
  floatingGripAt,
  floatingGripGeometry,
  floatingGripHits,
  floatingGripOf,
  floatingGripShown,
  hoverChangeAffectsGrips,
  type FloatingGripGeometry,
} from "../floatingGrip";
import {
  FLOATING_GRIP_GAP_X,
  FLOATING_GRIP_MIDPOINT_CLEARANCE,
  FLOATING_GRIP_SCREEN_PX,
  FLOATING_HANDLE_HIT_HALF,
} from "../floatingHandleMetrics";
import { registerGridReferencePickProbe } from "../floatingHandles";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import { resetObjectHoverForTests, setFloatingGestureActive, setHoveredFloatingRegion } from "../objectHover";
import {
  addToObjectSelection,
  clearObjectSelection,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../api/objectSelection";
import {
  clearContentGestureCursor,
  holdContentGestureCursor,
  registerGridOverlay,
  registerRegionStacking,
  setGridRegions,
  type GridRegion,
} from "../../../api/gridOverlays";

const GUTTERS = { rowHeaderWidth: 22, colHeaderHeight: 20 };
const NO_GUTTERS = { rowHeaderWidth: 0, colHeaderHeight: 0 };
const SCROLL = { scrollX: 0, scrollY: 0 };
const TYPE = "grip-test";

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

const selected: string[] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  snap.value = { surface: "grid", zoom: 1, sheetContext: { activeSheetIndex: 0 }, editing: null };
  selected.length = 0;
  resetObjectHoverForTests();
  cleanups.push(
    registerObjectSelectionProvider({
      types: [TYPE],
      isSelected: (r) => selected.includes(r.id),
      select: (r) => {
        selected.length = 0;
        selected.push(r.id);
      },
      addToSelection: (r) => {
        if (!selected.includes(r.id)) selected.push(r.id);
      },
      deselectAll: () => {
        selected.length = 0;
      },
    }),
  );
});

afterEach(() => {
  clearObjectSelection();
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectHoverForTests();
  clearContentGestureCursor();
  setGridRegions([]);
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

const centre = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

// ============================================================================
// (a) The geometry
// ============================================================================

describe("(a) the grip's geometry: 24 SCREEN px, the plate inside it, never on its object", () => {
  const OBJ = { x: 200, y: 150, width: 240, height: 120 };

  for (const zoom of [0.5, 1, 2]) {
    it(`at zoom ${zoom}: the hit is 24 screen px; the plate is centred inside it and hit at its centre; 1px outside is not`, () => {
      const g = floatingGripGeometry(OBJ, OBJ, null, zoom)!;
      expect(g).not.toBeNull();
      expect(g.hit.width * zoom).toBeCloseTo(FLOATING_GRIP_SCREEN_PX, 9);
      expect(g.hit.height * zoom).toBeCloseTo(FLOATING_GRIP_SCREEN_PX, 9);
      // The plate: wholly inside the hit square, and centred on it.
      const p = g.plate;
      expect(p.x).toBeGreaterThanOrEqual(g.hit.x);
      expect(p.y).toBeGreaterThanOrEqual(g.hit.y);
      expect(p.x + p.width).toBeLessThanOrEqual(g.hit.x + g.hit.width);
      expect(p.y + p.height).toBeLessThanOrEqual(g.hit.y + g.hit.height);
      expect(centre(p).x).toBeCloseTo(centre(g.hit).x, 9);
      expect(centre(p).y).toBeCloseTo(centre(g.hit).y, 9);
      // Every dot is on the plate.
      for (const d of g.dots) {
        expect(d.cx - g.dotRadius).toBeGreaterThanOrEqual(p.x);
        expect(d.cx + g.dotRadius).toBeLessThanOrEqual(p.x + p.width);
        expect(d.cy - g.dotRadius).toBeGreaterThanOrEqual(p.y);
        expect(d.cy + g.dotRadius).toBeLessThanOrEqual(p.y + p.height);
      }
      expect(g.dots).toHaveLength(6);
      // Hit where it is painted, not a pixel beyond (1 SCREEN px = 1/zoom logical).
      const c = centre(p);
      expect(floatingGripHits(g, c.x, c.y)).toBe(true);
      const px = 1 / zoom;
      expect(floatingGripHits(g, g.hit.x - px, c.y), "1px left of the hit square").toBe(false);
      expect(floatingGripHits(g, g.hit.x + g.hit.width + px, c.y), "1px right of it").toBe(false);
      expect(floatingGripHits(g, c.x, g.hit.y - px), "1px above it").toBe(false);
    });
  }

  it("above the object, FLOATING_GRIP_GAP_X right of its left edge -- clear of the nw handle's hit square", () => {
    const g = floatingGripGeometry(OBJ, OBJ, null, 1)!;
    expect(g.placement).toBe("above");
    expect(g.outsideLeft).toBe(false);
    expect(g.hit).toEqual({ x: OBJ.x + FLOATING_GRIP_GAP_X, y: OBJ.y - 24, width: 24, height: 24 });
    expect(g.hit.x).toBeGreaterThan(OBJ.x + FLOATING_HANDLE_HIT_HALF);
  });

  it("HALF-OPEN on the object's side: no point of the object's own rectangle, edges included, is the grip's", () => {
    for (const zoom of [0.5, 1, 2]) {
      for (const g of [
        floatingGripGeometry(OBJ, OBJ, null, zoom)!,
        floatingGripGeometry({ ...OBJ, y: 5 }, { ...OBJ, y: 5 }, null, zoom)!, // below
        floatingGripGeometry({ ...OBJ, width: 50 }, { ...OBJ, width: 50 }, null, zoom)!, // outside left
      ]) {
        const o = g.object;
        const step = g.hit.width / 12;
        for (let x = g.hit.x; x <= g.hit.x + g.hit.width + 1e-9; x += step) {
          for (let y = g.hit.y; y <= g.hit.y + g.hit.height + 1e-9; y += step) {
            const onObject = x >= o.x && x <= o.x + o.width && y >= o.y && y <= o.y + o.height;
            if (onObject) expect(floatingGripHits(g, x, y), `(${x}, ${y}) is on the object`).toBe(false);
          }
        }
        // Where the square touches the object: the shared stretch of the top
        // (or bottom) edge, or -- beside the left edge -- of the LEFT edge.
        if (g.placement === "left") {
          const shared = Math.min(o.height, g.hit.height);
          expect(floatingGripHits(g, o.x, o.y + shared / 2), "the shared stretch of the left edge").toBe(false);
          expect(floatingGripHits(g, o.x, o.y), "the shared top-left corner").toBe(false);
        } else {
          const edgeY = g.placement === "above" ? o.y : o.y + o.height;
          expect(floatingGripHits(g, g.hit.x + g.hit.width / 2, edgeY)).toBe(false);
          expect(floatingGripHits(g, o.x, edgeY), "the shared corner").toBe(false);
        }
      }
    }
  });

  it("never reaches the top edge's midpoint clearance: a narrow object gets its grip BESIDE its left edge", () => {
    for (const width of [48, 60, 79, 80, 81, 120, 240]) {
      for (const zoom of [0.5, 1, 2]) {
        const rect = { x: 300, y: 200, width, height: 90 };
        const g = floatingGripGeometry(rect, rect, null, zoom)!;
        const mid = rect.x + width / 2;
        const right = g.hit.x + g.hit.width;
        expect(right, `width ${width} zoom ${zoom}`).toBeLessThanOrEqual(mid - FLOATING_GRIP_MIDPOINT_CLEARANCE + 1e-9);
        if (g.outsideLeft) {
          expect(g.placement).toBe("left");
          expect(right).toBe(rect.x);
        }
      }
    }
    const narrow = floatingGripGeometry({ x: 300, y: 200, width: 60, height: 90 }, { x: 300, y: 200, width: 60, height: 90 }, null, 1)!;
    expect(narrow.outsideLeft).toBe(true);
    expect(narrow.placement).toBe("left");
    expect(narrow.hit.x).toBe(300 - 24);
  });

  for (const zoom of [0.5, 1, 2]) {
    it(`at zoom ${zoom}: a NARROW object's grip sits beside its left edge, LEVEL WITH ITS TOP EDGE -- sharing a stretch of that edge, not a corner`, () => {
      const rect = { x: 300, y: 200, width: 40, height: 90 };
      const g = floatingGripGeometry(rect, rect, null, zoom)!;
      const size = FLOATING_GRIP_SCREEN_PX / zoom;
      expect(g.placement).toBe("left");
      expect(g.hit).toEqual({ x: rect.x - size, y: rect.y, width: size, height: size });
      // Half a SCREEN px left of the edge, anywhere down the shared stretch, is the grip's.
      const justLeft = rect.x - 0.5 / zoom;
      for (const f of [0.05, 0.5, 0.95]) {
        expect(floatingGripHits(g, justLeft, rect.y + f * Math.min(size, rect.height)), `just left of the edge at ${f}`).toBe(true);
      }
    });
  }

  // THE REACH (BUG-0258 M7 review): a hover grip shows only while its object
  // is Core's hovered object, and Core's hover ends on any pointer sample that
  // is on neither the object nor its grip. So the straight path a hand takes
  // from the object's body to the grip must never leave the two -- here from
  // the body's centre to the plate's centre in 1-SCREEN-px samples, on an
  // object narrow enough to put the grip beside its left edge (60 px wide:
  // under 80 at zoom 1, under 128 at zoom 0.5).
  for (const zoom of [0.5, 1]) {
    it(`at zoom ${zoom}: every sample on the straight path from a 60 px object's body to its grip is on the object or on the grip`, () => {
      const rect = { x: 300, y: 200, width: 60, height: 90 };
      const g = floatingGripGeometry(rect, rect, null, zoom)!;
      expect(g.outsideLeft, "precondition: the grip is beside the left edge").toBe(true);
      const from = centre(rect);
      const to = centre(g.plate);
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * zoom);
      let gaps = 0;
      for (let i = 0; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        const onObject = x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
        if (!onObject && !floatingGripHits(g, x, y)) gaps++;
      }
      expect(gaps, "samples on neither the object nor its grip (the hover ends there, and the grip with it)").toBe(0);
    });
  }

  it("beside the left edge on a canvas PAGE: level with the bottom edge where a grip taller than the object would overhang the page; none with room for neither", () => {
    const page = { width: 1280, height: 720 };
    const short = { x: 300, y: 710, width: 40, height: 10 };
    const g = floatingGripGeometry(short, short, page, 1)!;
    expect(g.placement).toBe("left");
    expect(g.hit.y + g.hit.height, "level with the object's bottom edge").toBe(short.y + short.height);
    expect(g.hit.y + g.hit.height).toBeLessThanOrEqual(page.height);
    // A 10 px page: neither level fits a 24 px grip.
    const tiny = { x: 300, y: 0, width: 40, height: 10 };
    expect(floatingGripGeometry(tiny, tiny, { width: 1280, height: 10 }, 1)).toBeNull();
  });

  it("the anchor is the hit square in CLIENT px (the grid area's origin plus the canvas point times the zoom)", () => {
    const g = floatingGripGeometry(OBJ, OBJ, null, 2)!;
    expect(floatingGripAnchor(g, { left: 10, top: 40 }, 2)).toEqual({
      x: 10 + g.hit.x * 2,
      y: 40 + g.hit.y * 2,
      width: 24,
      height: 24,
    });
  });
});

// ============================================================================
// (b) The placement
// ============================================================================

describe("(b) where it sits: above, else below, else nowhere (a canvas page with no room)", () => {
  it("an object at sheet y = 0 gets its grip BELOW its bottom edge", () => {
    const rect = { x: 100, y: 0, width: 200, height: 100 };
    const g = floatingGripGeometry(rect, rect, null, 1)!;
    expect(g.placement).toBe("below");
    expect(g.hit.y).toBe(100);
  });

  it("the room above is measured in SCREEN px: sheet y 20 fits at zoom 2 (12 logical), not at zoom 1", () => {
    const rect = { x: 100, y: 20, width: 200, height: 100 };
    expect(floatingGripGeometry(rect, rect, null, 1)!.placement).toBe("below");
    expect(floatingGripGeometry(rect, rect, null, 2)!.placement).toBe("above");
  });

  it("on a canvas page as tall as the object: no grip at all", () => {
    const rect = { x: 100, y: 0, width: 200, height: 720 };
    expect(floatingGripGeometry(rect, rect, { width: 1280, height: 720 }, 1)).toBeNull();
    // ...but with room below on the page there is one.
    const shorter = { x: 100, y: 0, width: 200, height: 600 };
    expect(floatingGripGeometry(shorter, shorter, { width: 1280, height: 720 }, 1)!.placement).toBe("below");
  });

  it("the canvas rectangle carries the gutters and the scroll; the placement reads the SHEET rectangle", () => {
    const r = region("a", { x: 100, y: 30, width: 200, height: 100 });
    const g = floatingGripOf(r, GUTTERS, { scrollX: 40, scrollY: 25 }, 1, null)!;
    expect(g.placement).toBe("above");
    expect(g.object).toEqual({ x: 22 + 100 - 40, y: 20 + 30 - 25, width: 200, height: 100 });
    expect(g.hit.y).toBe(g.object.y - 24);
  });
});

// ============================================================================
// (c) The visibility rule
// ============================================================================

describe("(c) when the grip SHOWS", () => {
  const BOX = { x: 100, y: 100, width: 200, height: 100 };

  it("worksheet: a grip:'hover' region shows it while HOVERED or SELECTED, and not otherwise", () => {
    const r = region("s1", BOX, { grip: "hover" });
    setGridRegions([r]);
    expect(floatingGripShown(r)).toBe(false);
    setHoveredFloatingRegion("s1");
    expect(floatingGripShown(r)).toBe(true);
    setHoveredFloatingRegion(null);
    expect(floatingGripShown(r)).toBe(false);
    addToObjectSelection(r);
    expect(floatingGripShown(r)).toBe(true);
  });

  it("worksheet: a SELECTED titled chart (no grip flag) shows none -- owner decision: Excel's frame, no grip", () => {
    const chart = region("c1", BOX);
    setGridRegions([chart]);
    addToObjectSelection(chart);
    setHoveredFloatingRegion("c1");
    expect(floatingGripShown(chart)).toBe(false);
  });

  it("canvas: the selection's PRIMARY member shows one whatever its family; the other members do not (D2)", () => {
    snap.value.surface = "canvas";
    surface();
    const a = region("a", BOX);
    const b = region("b", { ...BOX, x: 400 });
    setGridRegions([a, b]);
    expect(floatingGripShown(a)).toBe(false);
    addToObjectSelection(a);
    expect(floatingGripShown(a)).toBe(true);
    addToObjectSelection(b); // b is now the primary
    expect(currentGripEnv().primaryId).toBe("b");
    expect(floatingGripShown(b)).toBe(true);
    expect(floatingGripShown(a), "a non-primary member of a multi-selection shows a grip").toBe(false);
  });

  it("canvas: an UNSELECTED grip:'hover' region still shows it on hover", () => {
    snap.value.surface = "canvas";
    surface();
    const s = region("s1", BOX, { grip: "hover" });
    setGridRegions([s]);
    setHoveredFloatingRegion("s1");
    expect(floatingGripShown(s)).toBe(true);
  });

  it("never on a LOCKED object (canvas primary or hovered grip:'hover')", () => {
    snap.value.surface = "canvas";
    surface({ isLocked: (r) => r.id === "a" || r.id === "s1" });
    const a = region("a", BOX);
    const s = region("s1", { ...BOX, x: 400 }, { grip: "hover" });
    setGridRegions([a, s]);
    addToObjectSelection(a);
    setHoveredFloatingRegion("s1");
    expect(floatingGripShown(a)).toBe(false);
    expect(floatingGripShown(s)).toBe(false);
  });

  it("never on a SUBSCRIBED page (the surface is not editable)", () => {
    snap.value.surface = "canvas";
    surface({ editable: false });
    const a = region("a", BOX, { grip: "hover" });
    setGridRegions([a]);
    addToObjectSelection(a);
    setHoveredFloatingRegion("a");
    expect(floatingGripShown(a)).toBe(false);
  });

  it("never on an object published movable: false (a run-mode button)", () => {
    snap.value.surface = "canvas";
    surface();
    const button = region("btn", BOX, { movable: false });
    setGridRegions([button]);
    addToObjectSelection(button);
    expect(floatingGripShown(button)).toBe(false);
    const hoverOnly = region("h", BOX, { movable: false, grip: "hover" });
    setGridRegions([hoverOnly]);
    setHoveredFloatingRegion("h");
    expect(floatingGripShown(hoverOnly)).toBe(false);
  });

  it("never during a REFERENCE PICK, a Core GESTURE, a held CONTENT gesture, or cross-sheet point mode", () => {
    const r = region("s1", BOX, { grip: "hover" });
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    expect(floatingGripShown(r), "control").toBe(true);

    const offPick = registerGridReferencePickProbe(() => true);
    expect(floatingGripShown(r), "reference pick").toBe(false);
    offPick();

    setFloatingGestureActive(true);
    expect(floatingGripShown(r), "Core gesture").toBe(false);
    setFloatingGestureActive(false);

    const release = holdContentGestureCursor("other", "pointer");
    expect(floatingGripShown(r), "held content gesture").toBe(false);
    release();

    snap.value.editing = { sourceSheetIndex: 1 };
    expect(floatingGripShown(r), "point mode on a foreign sheet").toBe(false);
    snap.value.editing = null;

    expect(floatingGripShown(r), "control after").toBe(true);
  });

  it("a hover change repaints the grips only when a grip:'hover' region is involved", () => {
    const regions = [region("s1", BOX, { grip: "hover" }), region("c1", { ...BOX, x: 400 })];
    expect(hoverChangeAffectsGrips(null, "s1", regions)).toBe(true);
    expect(hoverChangeAffectsGrips("s1", "c1", regions)).toBe(true);
    expect(hoverChangeAffectsGrips(null, "c1", regions)).toBe(false);
    expect(hoverChangeAffectsGrips("c1", "c1", regions)).toBe(false);
  });
});

// ============================================================================
// (d) The hit test
// ============================================================================

describe("(d) floatingGripAt: the visible grip under a point, never in the gutters, topmost first", () => {
  function gripOf(r: GridRegion, gutters = GUTTERS, zoom = 1): FloatingGripGeometry {
    return floatingGripOf(r, gutters, SCROLL, zoom, null)!;
  }

  for (const zoom of [0.5, 1, 2]) {
    it(`at zoom ${zoom}: the centre of the painted plate hits, the grip's object answers; hidden, nothing`, () => {
      snap.value.zoom = zoom;
      const r = region("s1", { x: 100, y: 100, width: 300, height: 150 }, { grip: "hover" });
      setGridRegions([r]);
      const c = centre(gripOf(r, GUTTERS, zoom).plate);
      expect(floatingGripAt(c.x, c.y, GUTTERS, SCROLL), "hidden: not hovered, not selected").toBeNull();
      setHoveredFloatingRegion("s1");
      expect(floatingGripAt(c.x, c.y, GUTTERS, SCROLL)?.region.id).toBe("s1");
    });
  }

  it("nothing in the header GUTTERS (a left-hand grip of an object at the sheet's left edge, a grip scrolled under the column header)", () => {
    const r = region("s1", { x: 0, y: 100, width: 60, height: 100 }, { grip: "hover" });
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const g = gripOf(r);
    expect(g.outsideLeft).toBe(true);
    const c = centre(g.hit);
    expect(c.x).toBeLessThan(GUTTERS.rowHeaderWidth);
    expect(floatingGripAt(c.x, c.y, GUTTERS, SCROLL)).toBeNull();

    // Control: the same object 40px further right has its left-hand grip in the cells, and it answers.
    const r2 = region("s1", { x: 40, y: 100, width: 60, height: 100 }, { grip: "hover" });
    setGridRegions([r2]);
    const c2 = centre(gripOf(r2).hit);
    expect(c2.x).toBeGreaterThan(GUTTERS.rowHeaderWidth);
    expect(floatingGripAt(c2.x, c2.y, GUTTERS, SCROLL)?.region.id).toBe("s1");

    // Scrolled so the grip lies under the column header: not hit there.
    const scrolled = { scrollX: 0, scrollY: 115 };
    const g3 = floatingGripOf(r2, GUTTERS, scrolled, 1, null)!;
    const c3 = centre(g3.hit);
    expect(c3.y).toBeLessThan(GUTTERS.colHeaderHeight);
    expect(floatingGripAt(c3.x, c3.y, GUTTERS, scrolled)).toBeNull();
    // ...on a canvas (no gutters) the page's top edge is the limit, not a header:
    // the same grip (beside the left edge, level with the top) answers there.
    expect(floatingGripAt(c2.x - GUTTERS.rowHeaderWidth, 100 + 12, NO_GUTTERS, SCROLL)?.region.id).toBe("s1");
  });

  it("where two grips overlap, the TOPMOST object's wins (the hit order)", () => {
    cleanups.push(registerRegionStacking((r) => ({ a: 1, b: 2 })[r.id]));
    const a = region("a", { x: 100, y: 100, width: 300, height: 150 }, { grip: "hover" });
    const b = region("b", { x: 102, y: 102, width: 300, height: 150 }, { grip: "hover" });
    setGridRegions([a, b]);
    addToObjectSelection(a);
    addToObjectSelection(b);
    const c = centre(gripOf(a).hit);
    expect(floatingGripShown(a) && floatingGripShown(b)).toBe(true);
    expect(floatingGripAt(c.x, c.y, GUTTERS, SCROLL)?.region.id).toBe("b");
  });
});

describe("(d) a point the grip's OWN object claims is never the grip's (the half-open rule past the rectangle)", () => {
  // A narrow, short, SELECTED floating-grid stand-in: 40 x 40 at sheet (100, 100).
  // Its grip sits beside the left edge, level with the top: [x-24, x) x [y, y+24].
  // Its yellow LEFT edge ball (radius 7, centred on the edge midpoint) reaches
  // 7 px past the edge -- into the grip's square -- and is painted ABOVE it.
  const BALL_R = 7;
  const r = region("g1", { x: 100, y: 100, width: 40, height: 40 }, { grip: "hover" });
  const claimsBall = (ctx: { canvasX: number; canvasY: number; floatingCanvasBounds?: { x: number; y: number; width: number; height: number } }) => {
    const b = ctx.floatingCanvasBounds!;
    const dx = ctx.canvasX - b.x;
    const dy = ctx.canvasY - (b.y + b.height / 2);
    return dx * dx + dy * dy <= BALL_R * BALL_R;
  };

  function setup(hitTest?: (ctx: never) => boolean): { onBall: { x: number; y: number }; onGripOnly: { x: number; y: number } } {
    if (hitTest) cleanups.push(registerGridOverlay({ type: TYPE, render: () => {}, hitTest: hitTest as never }));
    setGridRegions([r]);
    addToObjectSelection(r);
    const g = floatingGripOf(r, GUTTERS, SCROLL, 1, null)!;
    expect(g.placement, "precondition: the grip is beside the left edge").toBe("left");
    const edgeX = g.object.x;
    const midY = g.object.y + g.object.height / 2;
    // On the ball's outer half AND in the grip's square.
    const onBall = { x: edgeX - 3, y: midY };
    expect(floatingGripHits(g, onBall.x, onBall.y), "precondition: the ball's outer half lies in the grip's square").toBe(true);
    return { onBall, onGripOnly: { x: edgeX - 18, y: g.object.y + 4 } };
  }

  it("the object's ball claims its outer half: the grip answers nothing there, and still answers clear of the ball", () => {
    const { onBall, onGripOnly } = setup(claimsBall as never);
    expect(floatingGripAt(onBall.x, onBall.y, GUTTERS, SCROLL, 1), "the grip took a press on its own object's yellow ball").toBeNull();
    expect(floatingGripAt(onGripOnly.x, onGripOnly.y, GUTTERS, SCROLL, 1)?.region.id).toBe("g1");
  });

  it("control: an object with no extended hit test leaves its whole square to the grip", () => {
    const { onBall } = setup();
    expect(floatingGripAt(onBall.x, onBall.y, GUTTERS, SCROLL, 1)?.region.id).toBe("g1");
  });

  it("a hit test that throws is logged and claims nothing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { onBall } = setup((() => {
        throw new Error("broken hit test");
      }) as never);
      expect(floatingGripAt(onBall.x, onBall.y, GUTTERS, SCROLL, 1)?.region.id).toBe("g1");
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
