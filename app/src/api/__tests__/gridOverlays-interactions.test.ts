import { describe, it, expect, beforeEach, vi } from "vitest";
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
  registerPostHeaderOverlay,
  getPostHeaderOverlayRenderers,
} from "../gridOverlays";
import type { GridRegion, OverlayRegistration } from "../gridOverlays";

describe("gridOverlays - interactions", () => {
  beforeEach(() => {
    setGridRegions([]);
    // Clean up any registered overlays from previous tests
    for (const type of ["ext-a", "ext-b", "ext-c", "pivot", "chart", "comment", "validation", "sparkline", "hover", "click", "tooltip", "post-a", "post-b"]) {
      unregisterGridOverlay(type);
    }
  });

  // ==========================================================================
  // Multiple overlays from different extensions stacking correctly
  // ==========================================================================

  describe("multi-extension overlay stacking", () => {
    it("renders overlays in ascending priority order (low first, high on top)", () => {
      const renderOrder: string[] = [];

      registerGridOverlay({
        type: "ext-a",
        render: () => { renderOrder.push("ext-a"); },
        priority: 10,
      });
      registerGridOverlay({
        type: "ext-b",
        render: () => { renderOrder.push("ext-b"); },
        priority: 1,
      });
      registerGridOverlay({
        type: "ext-c",
        render: () => { renderOrder.push("ext-c"); },
        priority: 5,
      });

      const renderers = getOverlayRenderers();
      expect(renderers.map((r) => r.type)).toEqual(["ext-b", "ext-c", "ext-a"]);
    });

    it("overlays with same priority maintain insertion order", () => {
      registerGridOverlay({ type: "ext-a", render: () => {}, priority: 0 });
      registerGridOverlay({ type: "ext-b", render: () => {}, priority: 0 });

      const renderers = getOverlayRenderers();
      const types = renderers.map((r) => r.type);
      // Map preserves insertion order
      expect(types.indexOf("ext-a")).toBeLessThan(types.indexOf("ext-b"));
    });

    it("three extensions can each own separate regions simultaneously", () => {
      registerGridOverlay({ type: "pivot", render: () => {} });
      registerGridOverlay({ type: "chart", render: () => {} });
      registerGridOverlay({ type: "comment", render: () => {} });

      setGridRegions([
        { id: "p1", type: "pivot", startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
        { id: "c1", type: "chart", startRow: 0, startCol: 5, endRow: 10, endCol: 10 },
        { id: "cm1", type: "comment", startRow: 2, startCol: 2, endRow: 2, endCol: 2 },
      ]);

      expect(getGridRegions()).toHaveLength(3);
      expect(getOverlayRenderers()).toHaveLength(3);
    });

    it("registering overlay with same type replaces previous registration", () => {
      const renderA = vi.fn();
      const renderB = vi.fn();

      registerGridOverlay({ type: "ext-a", render: renderA, priority: 1 });
      registerGridOverlay({ type: "ext-a", render: renderB, priority: 5 });

      const reg = getOverlayRegistration("ext-a");
      expect(reg!.render).toBe(renderB);
      expect(reg!.priority).toBe(5);
    });
  });

  // ==========================================================================
  // Overlay hit testing with overlapping regions at same position
  // ==========================================================================

  describe("overlapping region hit testing", () => {
    it("higher priority overlay wins when regions overlap", () => {
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: () => true,
        priority: 1,
      });
      registerGridOverlay({
        type: "ext-b",
        render: () => {},
        hitTest: () => true,
        priority: 10,
      });

      setGridRegions([
        { id: "a1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
        { id: "b1", type: "ext-b", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      // hitTestOverlays tests in reverse priority order (highest first)
      const result = hitTestOverlays(100, 100, 2, 2);
      expect(result!.type).toBe("ext-b");
    });

    it("falls through to lower priority when higher returns false", () => {
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: () => true,
        priority: 1,
      });
      registerGridOverlay({
        type: "ext-b",
        render: () => {},
        hitTest: () => false,
        priority: 10,
      });

      setGridRegions([
        { id: "a1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
        { id: "b1", type: "ext-b", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      const result = hitTestOverlays(100, 100, 2, 2);
      expect(result!.type).toBe("ext-a");
    });

    it("returns null when all overlapping overlays reject the hit", () => {
      registerGridOverlay({ type: "ext-a", render: () => {}, hitTest: () => false, priority: 1 });
      registerGridOverlay({ type: "ext-b", render: () => {}, hitTest: () => false, priority: 10 });

      setGridRegions([
        { id: "a1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
        { id: "b1", type: "ext-b", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      expect(hitTestOverlays(100, 100, 2, 2)).toBeNull();
    });

    it("multiple regions of same type are all tested", () => {
      const hitIds: string[] = [];
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => {
          hitIds.push(ctx.region.id);
          return ctx.region.id === "a2";
        },
        priority: 1,
      });

      setGridRegions([
        { id: "a1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
        { id: "a2", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      const result = hitTestOverlays(50, 50, 1, 1);
      expect(result!.id).toBe("a2");
      expect(hitIds).toContain("a1");
      expect(hitIds).toContain("a2");
    });
  });

  // ==========================================================================
  // Overlay z-order (later registered = on top via priority)
  // ==========================================================================

  describe("z-order behavior", () => {
    it("default priority is 0 for all overlays", () => {
      registerGridOverlay({ type: "ext-a", render: () => {} });
      registerGridOverlay({ type: "ext-b", render: () => {} });

      const renderers = getOverlayRenderers();
      expect(renderers[0].priority ?? 0).toBe(0);
      expect(renderers[1].priority ?? 0).toBe(0);
    });

    it("renderBelowSelection flag is preserved in registration", () => {
      registerGridOverlay({ type: "ext-a", render: () => {}, renderBelowSelection: true });
      registerGridOverlay({ type: "ext-b", render: () => {}, renderBelowSelection: false });

      expect(getOverlayRegistration("ext-a")!.renderBelowSelection).toBe(true);
      expect(getOverlayRegistration("ext-b")!.renderBelowSelection).toBe(false);
    });

    it("negative priority renders before default priority", () => {
      registerGridOverlay({ type: "ext-a", render: () => {}, priority: -5 });
      registerGridOverlay({ type: "ext-b", render: () => {}, priority: 0 });

      const renderers = getOverlayRenderers();
      expect(renderers[0].type).toBe("ext-a");
      expect(renderers[1].type).toBe("ext-b");
    });
  });

  // ==========================================================================
  // Floating overlay positioning at viewport edges
  // ==========================================================================

  describe("floating overlay positioning", () => {
    it("floating overlay at origin with no scroll", () => {
      let receivedBounds: any = null;
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => { receivedBounds = ctx.floatingCanvasBounds; return false; },
      });

      setGridRegions([{
        id: "f1", type: "ext-a", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        floating: { x: 0, y: 0, width: 200, height: 100 },
      }]);

      hitTestOverlays(50, 50, 0, 0, 0, 0, 50, 24);
      expect(receivedBounds).toEqual({ x: 50, y: 24, width: 200, height: 100 });
    });

    it("floating overlay scrolled partially off-screen (negative canvas coords)", () => {
      let receivedBounds: any = null;
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => { receivedBounds = ctx.floatingCanvasBounds; return false; },
      });

      setGridRegions([{
        id: "f1", type: "ext-a", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        floating: { x: 10, y: 10, width: 200, height: 100 },
      }]);

      // scrollX=100 scrollY=100 pushes overlay well off screen
      hitTestOverlays(0, 0, 0, 0, 100, 100, 50, 24);
      expect(receivedBounds!.x).toBe(50 + 10 - 100); // -40
      expect(receivedBounds!.y).toBe(24 + 10 - 100); // -66
    });

    it("floating overlay uses default header sizes when not provided", () => {
      let receivedBounds: any = null;
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => { receivedBounds = ctx.floatingCanvasBounds; return false; },
      });

      setGridRegions([{
        id: "f1", type: "ext-a", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        floating: { x: 50, y: 50, width: 100, height: 80 },
      }]);

      // No rowHeaderWidth/colHeaderHeight args => defaults 50/24
      hitTestOverlays(0, 0, 0, 0, 0, 0);
      expect(receivedBounds).toEqual({ x: 100, y: 74, width: 100, height: 80 });
    });

    it("non-floating region does not get floatingCanvasBounds", () => {
      let receivedBounds: any = "unset";
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => { receivedBounds = ctx.floatingCanvasBounds; return false; },
      });

      setGridRegions([{
        id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5,
      }]);

      hitTestOverlays(50, 50, 1, 1, 0, 0, 50, 24);
      expect(receivedBounds).toBeUndefined();
    });
  });

  // ==========================================================================
  // Region change callbacks with batch operations
  // ==========================================================================

  describe("region change callbacks - batch operations", () => {
    it("setGridRegions fires exactly one notification", () => {
      const handler = vi.fn();
      const unsub = onRegionChange(handler);
      handler.mockClear();

      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
        { id: "r2", type: "ext-b", startRow: 2, startCol: 2, endRow: 3, endCol: 3 },
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toHaveLength(2);
      unsub();
    });

    it("addGridRegions fires one notification with full snapshot", () => {
      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      ]);

      const handler = vi.fn();
      const unsub = onRegionChange(handler);
      handler.mockClear();

      addGridRegions([
        { id: "r2", type: "ext-b", startRow: 2, startCol: 2, endRow: 3, endCol: 3 },
        { id: "r3", type: "ext-c", startRow: 4, startCol: 4, endRow: 5, endCol: 5 },
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toHaveLength(3); // r1 + r2 + r3
      unsub();
    });

    it("replaceGridRegionsByType fires exactly one notification (not two)", () => {
      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      ]);

      const handler = vi.fn();
      const unsub = onRegionChange(handler);
      handler.mockClear();

      replaceGridRegionsByType("ext-a", [
        { id: "r2", type: "ext-a", startRow: 10, startCol: 10, endRow: 15, endCol: 15 },
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("multiple listeners all receive the same snapshot", () => {
      const snapshots: GridRegion[][] = [];
      const unsub1 = onRegionChange((r) => snapshots.push(r));
      const unsub2 = onRegionChange((r) => snapshots.push(r));

      // Clear from setup
      snapshots.length = 0;

      const region: GridRegion = { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
      setGridRegions([region]);

      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toEqual(snapshots[1]);

      unsub1();
      unsub2();
    });

    it("snapshot is a copy - mutations do not affect internal state", () => {
      const handler = vi.fn();
      const unsub = onRegionChange(handler);
      handler.mockClear();

      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      ]);

      const snapshot = handler.mock.calls[0][0] as GridRegion[];
      snapshot.push({ id: "fake", type: "fake", startRow: 99, startCol: 99, endRow: 99, endCol: 99 });

      expect(getGridRegions()).toHaveLength(1); // Internal state unaffected
      unsub();
    });
  });

  // ==========================================================================
  // Grid region types: clickable, hoverable, tooltip (via data metadata)
  // ==========================================================================

  describe("region metadata for interaction types", () => {
    it("regions can carry arbitrary metadata in data field", () => {
      const region: GridRegion = {
        id: "btn1", type: "ext-a",
        startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        data: { clickable: true, tooltip: "Click me", cursor: "pointer" },
      };

      setGridRegions([region]);
      const stored = getGridRegions()[0];
      expect(stored.data).toEqual({ clickable: true, tooltip: "Click me", cursor: "pointer" });
    });

    it("getCursor callback is preserved and accessible", () => {
      const cursorFn = () => "pointer";
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        getCursor: cursorFn,
      });

      const reg = getOverlayRegistration("ext-a");
      expect(reg!.getCursor).toBe(cursorFn);
    });

    it("hitTest receives region data for interaction decisions", () => {
      let receivedData: Record<string, unknown> | undefined;
      registerGridOverlay({
        type: "ext-a",
        render: () => {},
        hitTest: (ctx) => {
          receivedData = ctx.region.data;
          return true;
        },
      });

      setGridRegions([{
        id: "r1", type: "ext-a",
        startRow: 0, startCol: 0, endRow: 5, endCol: 5,
        data: { hoverable: true, action: "expand" },
      }]);

      hitTestOverlays(50, 50, 1, 1);
      expect(receivedData).toEqual({ hoverable: true, action: "expand" });
    });
  });

  // ==========================================================================
  // Overlay cleanup when extension unregisters
  // ==========================================================================

  describe("overlay cleanup on extension unregister", () => {
    it("cleanup function from registerGridOverlay removes the overlay", () => {
      const cleanup = registerGridOverlay({ type: "ext-a", render: () => {} });
      expect(getOverlayRegistration("ext-a")).toBeDefined();

      cleanup();
      expect(getOverlayRegistration("ext-a")).toBeUndefined();
      expect(getOverlayRenderers().find((r) => r.type === "ext-a")).toBeUndefined();
    });

    it("calling cleanup twice is safe (idempotent)", () => {
      const cleanup = registerGridOverlay({ type: "ext-a", render: () => {} });
      cleanup();
      cleanup(); // Should not throw
      expect(getOverlayRegistration("ext-a")).toBeUndefined();
    });

    it("unregistering overlay does not remove its regions automatically", () => {
      registerGridOverlay({ type: "ext-a", render: () => {} });
      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      unregisterGridOverlay("ext-a");
      // Regions remain - extension must clean up regions separately
      expect(getGridRegions()).toHaveLength(1);
    });

    it("removeGridRegionsByType + unregisterGridOverlay fully cleans up", () => {
      const cleanup = registerGridOverlay({ type: "ext-a", render: () => {} });
      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 5, endCol: 5 },
      ]);

      removeGridRegionsByType("ext-a");
      cleanup();

      expect(getGridRegions()).toHaveLength(0);
      expect(getOverlayRegistration("ext-a")).toBeUndefined();
    });

    it("onRegionChange listener cleanup stops notifications", () => {
      const handler = vi.fn();
      const unsub = onRegionChange(handler);
      handler.mockClear();

      unsub();

      setGridRegions([
        { id: "r1", type: "ext-a", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      ]);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Post-header overlays
  // ==========================================================================

  describe("post-header overlay registry", () => {
    it("registers and retrieves post-header overlay", () => {
      const fn = vi.fn();
      const cleanup = registerPostHeaderOverlay("post-a", fn);

      const renderers = getPostHeaderOverlayRenderers();
      expect(renderers).toContain(fn);
      cleanup();
    });

    it("cleanup removes post-header overlay", () => {
      const fn = vi.fn();
      const cleanup = registerPostHeaderOverlay("post-a", fn);
      cleanup();

      expect(getPostHeaderOverlayRenderers()).not.toContain(fn);
    });

    it("multiple post-header overlays returned in insertion order", () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const c1 = registerPostHeaderOverlay("post-a", fn1);
      const c2 = registerPostHeaderOverlay("post-b", fn2);

      const renderers = getPostHeaderOverlayRenderers();
      expect(renderers[0]).toBe(fn1);
      expect(renderers[1]).toBe(fn2);

      c1();
      c2();
    });
  });
});
