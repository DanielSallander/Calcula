import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  addGridRegions,
  removeGridRegionsByType,
  replaceGridRegionsByType,
  getGridRegions,
  getOverlayRenderers,
  getOverlayRegistration,
  onRegionChange,
  hitTestOverlays,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
} from "../gridOverlays";
import type { GridRegion, OverlayRenderContext } from "../gridOverlays";
import {
  resolveFloatingZone,
  holdContentGestureCursor,
  contentGestureCursorFor,
  clearContentGestureCursor,
  type OverlayZone,
  type OverlayHitTestContext,
} from "../gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import { topFloatingRegionAt } from "../gridOverlays";
import { floatingGripChromeProbe } from "../../core/lib/floatingGrip";
import { floatingChromeHitProbe, registerFloatingChromeHitProbe } from "../../core/lib/floatingChromeProbe";
import { resetObjectHoverForTests, setHoveredFloatingRegion } from "../../core/lib/objectHover";

describe("gridOverlays", () => {
  beforeEach(() => {
    // Reset regions
    setGridRegions([]);
    // Unregister known test overlays
    unregisterGridOverlay("test-type");
    unregisterGridOverlay("type-a");
    unregisterGridOverlay("type-b");
  });

  // ==========================================================================
  // Registry
  // ==========================================================================

  describe("registerGridOverlay / unregister", () => {
    it("registers and retrieves an overlay", () => {
      const cleanup = registerGridOverlay({
        type: "test-type",
        render: () => {},
      });
      expect(getOverlayRegistration("test-type")).toBeDefined();
      cleanup();
      expect(getOverlayRegistration("test-type")).toBeUndefined();
    });

    it("unregisterGridOverlay removes by type", () => {
      registerGridOverlay({ type: "test-type", render: () => {} });
      unregisterGridOverlay("test-type");
      expect(getOverlayRegistration("test-type")).toBeUndefined();
    });
  });

  describe("getOverlayRenderers", () => {
    it("returns renderers sorted by priority", () => {
      const c1 = registerGridOverlay({ type: "type-b", render: () => {}, priority: 10 });
      const c2 = registerGridOverlay({ type: "type-a", render: () => {}, priority: 1 });

      const renderers = getOverlayRenderers();
      const types = renderers.map((r) => r.type);
      expect(types.indexOf("type-a")).toBeLessThan(types.indexOf("type-b"));

      c1(); c2();
    });
  });

  // ==========================================================================
  // Region Management
  // ==========================================================================

  describe("region management", () => {
    const region1: GridRegion = { id: "r1", type: "pivot", startRow: 0, startCol: 0, endRow: 5, endCol: 5 };
    const region2: GridRegion = { id: "r2", type: "chart", startRow: 10, startCol: 0, endRow: 15, endCol: 5 };

    it("setGridRegions replaces all", () => {
      setGridRegions([region1]);
      expect(getGridRegions()).toHaveLength(1);
      setGridRegions([region2]);
      expect(getGridRegions()).toHaveLength(1);
      expect(getGridRegions()[0].id).toBe("r2");
    });

    it("addGridRegions appends", () => {
      setGridRegions([region1]);
      addGridRegions([region2]);
      expect(getGridRegions()).toHaveLength(2);
    });

    it("removeGridRegionsByType filters by type", () => {
      setGridRegions([region1, region2]);
      removeGridRegionsByType("pivot");
      expect(getGridRegions()).toHaveLength(1);
      expect(getGridRegions()[0].type).toBe("chart");
    });

    it("replaceGridRegionsByType atomically replaces", () => {
      const region3: GridRegion = { id: "r3", type: "pivot", startRow: 20, startCol: 0, endRow: 25, endCol: 5 };
      setGridRegions([region1, region2]);
      replaceGridRegionsByType("pivot", [region3]);
      expect(getGridRegions()).toHaveLength(2);
      expect(getGridRegions().find((r) => r.id === "r1")).toBeUndefined();
      expect(getGridRegions().find((r) => r.id === "r3")).toBeDefined();
    });

    it("replaceGridRegionsByType with notify=false skips listeners", () => {
      let called = false;
      const unsub = onRegionChange(() => { called = true; });
      called = false; // reset from setGridRegions in beforeEach

      replaceGridRegionsByType("pivot", [], false);
      expect(called).toBe(false);

      unsub();
    });
  });

  // ==========================================================================
  // Region Change Listeners
  // ==========================================================================

  describe("onRegionChange", () => {
    it("fires listener on setGridRegions", () => {
      let received: GridRegion[] = [];
      const unsub = onRegionChange((regions) => { received = regions; });

      const region: GridRegion = { id: "r1", type: "t", startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
      setGridRegions([region]);
      expect(received).toHaveLength(1);

      unsub();
    });

    it("requestOverlayRedraw fires listeners", () => {
      let called = false;
      const unsub = onRegionChange(() => { called = true; });
      called = false;

      requestOverlayRedraw();
      expect(called).toBe(true);

      unsub();
    });

    it("unsubscribe stops notifications", () => {
      let count = 0;
      const unsub = onRegionChange(() => { count++; });
      setGridRegions([]); // count = 1
      unsub();
      setGridRegions([]); // should not increment
      expect(count).toBe(1);
    });
  });

  // ==========================================================================
  // Hit Testing
  // ==========================================================================

  describe("hitTestOverlays", () => {
    it("returns null when no overlays registered", () => {
      setGridRegions([{ id: "r1", type: "test-type", startRow: 0, startCol: 0, endRow: 5, endCol: 5 }]);
      expect(hitTestOverlays(100, 100, 2, 2)).toBeNull();
    });

    it("returns region when hitTest returns true", () => {
      registerGridOverlay({
        type: "test-type",
        render: () => {},
        hitTest: () => true,
      });
      const region: GridRegion = { id: "r1", type: "test-type", startRow: 0, startCol: 0, endRow: 5, endCol: 5 };
      setGridRegions([region]);

      const result = hitTestOverlays(100, 100, 2, 2);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("r1");

      unregisterGridOverlay("test-type");
    });

    it("returns null when hitTest returns false", () => {
      registerGridOverlay({
        type: "test-type",
        render: () => {},
        hitTest: () => false,
      });
      setGridRegions([{ id: "r1", type: "test-type", startRow: 0, startCol: 0, endRow: 5, endCol: 5 }]);

      expect(hitTestOverlays(100, 100, 2, 2)).toBeNull();

      unregisterGridOverlay("test-type");
    });

    it("computes floating canvas bounds for floating regions", () => {
      let receivedBounds: any = null;
      registerGridOverlay({
        type: "test-type",
        render: () => {},
        hitTest: (ctx) => {
          receivedBounds = ctx.floatingCanvasBounds;
          return false;
        },
      });
      const region: GridRegion = {
        id: "r1", type: "test-type",
        startRow: 0, startCol: 0, endRow: 5, endCol: 5,
        floating: { x: 100, y: 200, width: 300, height: 150 },
      };
      setGridRegions([region]);

      hitTestOverlays(100, 100, 0, 0, 10, 20, 50, 24);
      expect(receivedBounds).toEqual({
        x: 50 + 100 - 10,  // rhw + x - scrollX
        y: 24 + 200 - 20,  // chh + y - scrollY
        width: 300,
        height: 150,
      });

      unregisterGridOverlay("test-type");
    });
  });

  // ==========================================================================
  // Dimension Helpers
  // ==========================================================================

  describe("overlay dimension helpers", () => {
    function makeRenderContext(overrides?: Partial<OverlayRenderContext>): OverlayRenderContext {
      return {
        ctx: {} as CanvasRenderingContext2D,
        region: { id: "r", type: "t", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
        config: {
          defaultCellWidth: 100,
          defaultCellHeight: 24,
          rowHeaderWidth: 50,
          colHeaderHeight: 24,
        } as any,
        viewport: { scrollX: 0, scrollY: 0 } as any,
        dimensions: {
          columnWidths: new Map([[1, 150]]),
          rowHeights: new Map([[2, 40]]),
          hiddenRows: new Set<number>(),
        } as any,
        canvasWidth: 1000,
        canvasHeight: 600,
        ...overrides,
      } as OverlayRenderContext;
    }

    it("overlayGetColumnWidth returns custom or default", () => {
      const ctx = makeRenderContext();
      expect(overlayGetColumnWidth(ctx, 1)).toBe(150);
      expect(overlayGetColumnWidth(ctx, 0)).toBe(100);
    });

    it("overlayGetRowHeight returns 0 for hidden rows", () => {
      const ctx = makeRenderContext({
        dimensions: {
          columnWidths: new Map(),
          rowHeights: new Map(),
          hiddenRows: new Set([3]),
        } as any,
      });
      expect(overlayGetRowHeight(ctx, 3)).toBe(0);
      expect(overlayGetRowHeight(ctx, 0)).toBe(24);
    });

    it("overlayGetColumnX computes position", () => {
      const ctx = makeRenderContext();
      // col 0: rowHeaderWidth(50) - scrollX(0) = 50
      expect(overlayGetColumnX(ctx, 0)).toBe(50);
    });

    it("overlayGetRowY accounts for hidden rows", () => {
      const ctx = makeRenderContext({
        dimensions: {
          columnWidths: new Map(),
          rowHeights: new Map(),
          hiddenRows: new Set([0]),
        } as any,
      });
      // row 0 is hidden, so row 1 should start at colHeaderHeight
      const y = overlayGetRowY(ctx, 1);
      expect(y).toBe(24); // colHeaderHeight + 0 (hidden row 0)
    });

    it("overlayGetColumnsWidth sums a range", () => {
      const ctx = makeRenderContext();
      // cols 0-2: 100 + 150 + 100 = 350
      expect(overlayGetColumnsWidth(ctx, 0, 2)).toBe(350);
    });

    it("overlayGetRowsHeight skips hidden rows", () => {
      const ctx = makeRenderContext({
        dimensions: {
          columnWidths: new Map(),
          rowHeights: new Map(),
          hiddenRows: new Set([1]),
        } as any,
      });
      // rows 0-2: 24 + 0 (hidden) + 24 = 48
      expect(overlayGetRowsHeight(ctx, 0, 2)).toBe(48);
    });

    it("overlayGetRowHeaderWidth / overlayGetColHeaderHeight", () => {
      const ctx = makeRenderContext();
      expect(overlayGetRowHeaderWidth(ctx)).toBe(50);
      expect(overlayGetColHeaderHeight(ctx)).toBe(24);
    });

    it("overlaySheetToCanvas converts coordinates", () => {
      const ctx = makeRenderContext({
        viewport: { scrollX: 10, scrollY: 20 } as any,
      });
      const { canvasX, canvasY } = overlaySheetToCanvas(ctx, 100, 200);
      expect(canvasX).toBe(50 + 100 - 10); // rhw + sheetX - scrollX
      expect(canvasY).toBe(24 + 200 - 20); // chh + sheetY - scrollY
    });
  });
});

// ============================================================================
// Zones (BUG-0258 phase 2): resolveFloatingZone is the ONE rule
// ============================================================================

describe("resolveFloatingZone -- the one rule for a point on a floating object", () => {
  const TYPE = "zone-rule-test";
  /** No grid is mounted, so the active sheet is 0. */
  let surface: LayoutSurface | null = null;
  let unregisterSurface: (() => void) | null = null;

  function useSurface(s: Partial<LayoutSurface>): void {
    surface = {
      snapToGrid: false,
      gridSize: 25,
      showGrid: false,
      page: { width: 1280, height: 720 },
      editable: true,
      ...s,
    };
    unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? surface : null) });
  }

  function ctx(data: Record<string, unknown> = {}, canvasX = 10): OverlayHitTestContext {
    const region: GridRegion = {
      id: "z-1",
      type: TYPE,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      data,
      floating: { x: 0, y: 0, width: 100, height: 50 },
    };
    return { region, canvasX, canvasY: 10, row: 0, col: 0, floatingCanvasBounds: { x: 0, y: 0, width: 100, height: 50 } };
  }

  /** Left half content ('pointer'), right half frame with no cursor of its own. */
  const halves = (c: OverlayHitTestContext): OverlayZone | null =>
    c.canvasX < 50 ? { kind: "content", cursor: "pointer", part: "tile" } : { kind: "frame", part: "header" };

  afterEach(() => {
    unregisterGridOverlay(TYPE);
    unregisterSurface?.();
    unregisterSurface = null;
    surface = null;
    clearContentGestureCursor();
    vi.restoreAllMocks();
  });

  it("content: its own cursor, whatever the object's movability", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: halves });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(ctx({}, 10))).toEqual({
      kind: "content",
      part: "tile",
      cursor: "pointer",
      canMove: false,
    });
  });

  it("an unlocked frame: 'move'", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: halves });
    useSurface({});
    expect(resolveFloatingZone(ctx({}, 80))).toEqual({ kind: "frame", part: "header", cursor: "move", canMove: true });
  });

  it("a worksheet (no surface): an ordinary frame moves", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: halves });
    expect(resolveFloatingZone(ctx({}, 80))).toMatchObject({ cursor: "move", canMove: true });
  });

  it("a LOCKED frame, a SUBSCRIBED (consume) frame and a movable:false frame: 'default'", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: halves });

    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(ctx({}, 80))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
    unregisterSurface!();

    useSurface({ editable: false });
    expect(resolveFloatingZone(ctx({}, 80))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
    unregisterSurface!();

    useSurface({});
    expect(resolveFloatingZone(ctx({ movable: false }, 80))).toMatchObject({
      kind: "frame",
      cursor: "default",
      canMove: false,
    });
  });

  it("a frame with its OWN cursor keeps it, locked or not", () => {
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => ({ kind: "frame", cursor: "pointer", part: "item" }),
    });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(ctx())).toEqual({ kind: "frame", part: "item", cursor: "pointer", canMove: false });
  });

  it("no zoneAt at all: the whole object is frame", () => {
    registerGridOverlay({ type: TYPE, render: () => {} });
    useSurface({});
    expect(resolveFloatingZone(ctx())).toEqual({ kind: "frame", part: null, cursor: "move", canMove: true });
  });

  it("a zoneAt that throws is frame, and is logged", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => {
        throw new Error("broken");
      },
    });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(ctx())).toEqual({ kind: "frame", part: null, cursor: "default", canMove: false });
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("the content-gesture pointer seam", () => {
  afterEach(() => clearContentGestureCursor());

  it("a hold answers for its own region only, and its release clears it", () => {
    const release = holdContentGestureCursor("timeline-slicer-a", "ew-resize");
    expect(contentGestureCursorFor("timeline-slicer-a")).toBe("ew-resize");
    expect(contentGestureCursorFor("timeline-slicer-b")).toBeNull();
    release();
    expect(contentGestureCursorFor("timeline-slicer-a")).toBeNull();
  });

  it("holding again for the same region updates the pointer; any release of that hold ends it", () => {
    const first = holdContentGestureCursor("r", "pointer");
    holdContentGestureCursor("r", "ew-resize");
    expect(contentGestureCursorFor("r")).toBe("ew-resize");
    first();
    expect(contentGestureCursorFor("r")).toBeNull();
  });

  it("a release left over from an older hold cannot end a newer one", () => {
    const stale = holdContentGestureCursor("r", "pointer");
    clearContentGestureCursor(); // Core's backstop at the next press
    holdContentGestureCursor("r", "ew-resize");
    stale();
    expect(contentGestureCursorFor("r")).toBe("ew-resize");

    const other = holdContentGestureCursor("s", "grabbing");
    expect(contentGestureCursorFor("r")).toBeNull();
    other();
    expect(contentGestureCursorFor("s")).toBeNull();
  });
});

// ============================================================================
// The grip is its object's point for every lookup (BUG-0258 design phase 5, D6)
// ============================================================================

describe("topFloatingRegionAt answers a VISIBLE grip's object (the chrome probe)", () => {
  const GEO = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };
  /** A header-less slicer stand-in: 200 x 100 at (100, 100); its grip square is [108, 132] x [76, 100). */
  const A: GridRegion = {
    id: "a",
    type: "grip-probe-test",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width: 200, height: 100 },
    data: { grip: "hover" },
  };
  /** A neighbour whose body covers A's grip square. */
  const B: GridRegion = { ...A, id: "b", floating: { x: 90, y: 40, width: 80, height: 50 }, data: {} };
  const GRIP = { x: 120, y: 88 };

  afterEach(() => {
    resetObjectHoverForTests();
    registerFloatingChromeHitProbe(floatingGripChromeProbe);
  });

  it("the grip module registered its probe at load", () => {
    expect(floatingChromeHitProbe()).toBe(floatingGripChromeProbe);
  });

  it("a point on the grip answers the grip's object only while the grip SHOWS (A hovered)", () => {
    expect(topFloatingRegionAt(GRIP.x, GRIP.y, GEO, [A]), "hidden grip: nothing there").toBeNull();
    setHoveredFloatingRegion("a");
    expect(topFloatingRegionAt(GRIP.x, GRIP.y, GEO, [A])?.id).toBe("a");
    setHoveredFloatingRegion(null);
    expect(topFloatingRegionAt(GRIP.x, GRIP.y, GEO, [A])).toBeNull();
  });

  it("over a NEIGHBOUR's body the visible grip wins (it is painted above every object and takes the press there)", () => {
    expect(topFloatingRegionAt(GRIP.x, GRIP.y, GEO, [A, B])?.id, "control: the neighbour's body").toBe("b");
    setHoveredFloatingRegion("a");
    expect(topFloatingRegionAt(GRIP.x, GRIP.y, GEO, [A, B])?.id).toBe("a");
    // Off the grip, the neighbour's body answers as before.
    expect(topFloatingRegionAt(95, 50, GEO, [A, B])?.id).toBe("b");
  });

  it("a probe that throws is logged and ignored: the bodies still answer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerFloatingChromeHitProbe(() => {
      throw new Error("broken probe");
    });
    expect(topFloatingRegionAt(150, 150, GEO, [A])?.id).toBe("a");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("the registration is last-wins, and a stale cleanup removes nothing newer", () => {
    const stale = registerFloatingChromeHitProbe(() => null);
    const fresh = () => A;
    registerFloatingChromeHitProbe(fresh);
    stale();
    expect(floatingChromeHitProbe()).toBe(fresh);
  });
});
