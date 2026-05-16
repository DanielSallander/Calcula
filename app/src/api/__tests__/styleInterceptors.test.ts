import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  getStyleInterceptors,
  hasStyleInterceptors,
  applyStyleInterceptors,
  markRangeDirty,
  markSheetDirty,
  clearDirtyState,
  isCellDirty,
  hasDirtyState,
} from "../styleInterceptors";
import type { BaseStyleInfo, CellCoords } from "../styleInterceptors";

// Helper to clean up all interceptors between tests
function cleanupInterceptors(ids: string[]): void {
  for (const id of ids) {
    unregisterStyleInterceptor(id);
  }
}

describe("styleInterceptors", () => {
  const baseStyle: BaseStyleInfo = { styleIndex: 0 };
  const coords: CellCoords = { row: 0, col: 0 };

  // ==========================================================================
  // Registry
  // ==========================================================================

  describe("register / unregister", () => {
    it("registers and retrieves an interceptor", () => {
      const cleanup = registerStyleInterceptor("test-1", () => null);
      expect(hasStyleInterceptors()).toBe(true);
      expect(getStyleInterceptors().length).toBeGreaterThanOrEqual(1);
      cleanup();
    });

    it("unregister via cleanup function removes interceptor", () => {
      const cleanup = registerStyleInterceptor("test-unreg", () => null);
      cleanup();
      const found = getStyleInterceptors().find((i) => i.id === "test-unreg");
      expect(found).toBeUndefined();
    });

    it("unregisterStyleInterceptor removes by id", () => {
      registerStyleInterceptor("test-byid", () => null);
      unregisterStyleInterceptor("test-byid");
      const found = getStyleInterceptors().find((i) => i.id === "test-byid");
      expect(found).toBeUndefined();
    });

    it("unregistering non-existent id is a no-op", () => {
      // Should not throw
      unregisterStyleInterceptor("does-not-exist");
    });
  });

  // ==========================================================================
  // Priority ordering
  // ==========================================================================

  describe("priority ordering", () => {
    it("sorts interceptors by priority ascending", () => {
      const c1 = registerStyleInterceptor("p-high", () => null, 10);
      const c2 = registerStyleInterceptor("p-low", () => null, 1);
      const c3 = registerStyleInterceptor("p-mid", () => null, 5);

      const sorted = getStyleInterceptors();
      const ids = sorted.map((i) => i.id);
      const lowIdx = ids.indexOf("p-low");
      const midIdx = ids.indexOf("p-mid");
      const highIdx = ids.indexOf("p-high");

      expect(lowIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(highIdx);

      c1(); c2(); c3();
    });
  });

  // ==========================================================================
  // applyStyleInterceptors
  // ==========================================================================

  describe("applyStyleInterceptors", () => {
    it("returns baseStyle when no interceptors registered", () => {
      // Ensure clean state
      const interceptors = getStyleInterceptors();
      const cleanups = interceptors.map((i) => {
        unregisterStyleInterceptor(i.id);
        return i.id;
      });

      const result = applyStyleInterceptors("hello", baseStyle, coords);
      expect(result).toEqual(baseStyle);
    });

    it("applies single interceptor override", () => {
      const cleanup = registerStyleInterceptor("test-apply-1", () => ({
        backgroundColor: "#ff0000",
      }), 0);

      const result = applyStyleInterceptors("test", baseStyle, coords);
      expect(result.backgroundColor).toBe("#ff0000");
      expect(result.styleIndex).toBe(0); // preserved from base
      cleanup();
    });

    it("merges multiple interceptor overrides in priority order", () => {
      const c1 = registerStyleInterceptor("test-m1", () => ({
        backgroundColor: "#ff0000",
        textColor: "#000000",
      }), 1);
      const c2 = registerStyleInterceptor("test-m2", () => ({
        backgroundColor: "#00ff00", // overrides m1's bg
      }), 2);

      const result = applyStyleInterceptors("test", baseStyle, coords);
      expect(result.backgroundColor).toBe("#00ff00"); // later priority wins
      expect(result.textColor).toBe("#000000"); // from m1

      c1(); c2();
    });

    it("skips interceptor that returns null", () => {
      const c1 = registerStyleInterceptor("test-null", () => null, 0);
      const c2 = registerStyleInterceptor("test-bg", () => ({
        bold: true,
      }), 1);

      const result = applyStyleInterceptors("test", baseStyle, coords);
      expect(result.bold).toBe(true);

      c1(); c2();
    });

    it("catches interceptor errors without breaking pipeline", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const c1 = registerStyleInterceptor("test-error", () => {
        throw new Error("boom");
      }, 0);
      const c2 = registerStyleInterceptor("test-after-error", () => ({
        italic: true,
      }), 1);

      const result = applyStyleInterceptors("test", baseStyle, coords);
      expect(result.italic).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
      c1(); c2();
    });
  });

  // ==========================================================================
  // Dirty Range Cache
  // ==========================================================================

  describe("dirty range cache", () => {
    beforeEach(() => {
      clearDirtyState();
    });

    it("initially has no dirty state", () => {
      expect(hasDirtyState()).toBe(false);
      expect(isCellDirty(0, 0)).toBe(false);
    });

    it("markRangeDirty makes cells in range dirty", () => {
      markRangeDirty({ startRow: 1, startCol: 1, endRow: 3, endCol: 3 });
      expect(hasDirtyState()).toBe(true);
      expect(isCellDirty(2, 2)).toBe(true);
      expect(isCellDirty(0, 0)).toBe(false);
      expect(isCellDirty(4, 4)).toBe(false);
    });

    it("markRangeDirty respects sheetIndex", () => {
      markRangeDirty({ startRow: 0, startCol: 0, endRow: 5, endCol: 5, sheetIndex: 1 });
      expect(isCellDirty(2, 2, 1)).toBe(true);
      expect(isCellDirty(2, 2, 0)).toBe(false);
      // undefined sheetIndex in range matches any sheet
    });

    it("range without sheetIndex matches any sheetIndex query", () => {
      markRangeDirty({ startRow: 0, startCol: 0, endRow: 5, endCol: 5 });
      expect(isCellDirty(2, 2, 0)).toBe(true);
      expect(isCellDirty(2, 2, 99)).toBe(true);
    });

    it("markSheetDirty makes everything dirty", () => {
      markSheetDirty();
      expect(hasDirtyState()).toBe(true);
      expect(isCellDirty(999, 999)).toBe(true);
    });

    it("clearDirtyState resets all dirty state", () => {
      markRangeDirty({ startRow: 0, startCol: 0, endRow: 10, endCol: 10 });
      markSheetDirty();
      clearDirtyState();
      expect(hasDirtyState()).toBe(false);
      expect(isCellDirty(0, 0)).toBe(false);
    });
  });
});
