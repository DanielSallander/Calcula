import { describe, it, expect, beforeEach } from "vitest";
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
