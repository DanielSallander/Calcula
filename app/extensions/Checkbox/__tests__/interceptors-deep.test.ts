//! FILENAME: app/extensions/Checkbox/__tests__/interceptors-deep.test.ts
// PURPOSE: Deep tests for checkbox style interceptor, selection tracking,
//          style index cache, and boundary conditions.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockGetAllStyles = vi.fn(async () => []);
const mockGetStyle = vi.fn(async () => null);

vi.mock("@api", () => ({
  ExtensionRegistry: {
    onSelectionChange: vi.fn(() => vi.fn()),
    onCellChange: vi.fn(() => vi.fn()),
    registerCommand: vi.fn(),
  },
  AppEvents: { DATA_CHANGED: "data-changed" },
}));

vi.mock("@api/styleInterceptors", () => ({}));

vi.mock("../../../src/api/lib", () => ({
  getAllStyles: (...args: unknown[]) => mockGetAllStyles(...args),
  getStyle: (...args: unknown[]) => mockGetStyle(...args),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async () => {}),
  updateCellsBatch: vi.fn(async () => {}),
  applyFormatting: vi.fn(async () => {}),
}));

vi.mock("../../../src/api/gridDispatch", () => ({
  dispatchGridAction: vi.fn(),
}));

vi.mock("../../../src/api/grid", () => ({
  setSelection: vi.fn(),
}));

import {
  checkboxStyleInterceptor,
  setCurrentSelection,
  getCurrentSelection,
  checkboxStyleIndices,
  refreshStyleCache,
} from "../interceptors";

// ============================================================================
// Tests
// ============================================================================

describe("Checkbox Interceptors Deep", () => {
  beforeEach(() => {
    checkboxStyleIndices.clear();
    setCurrentSelection(null);
    mockGetAllStyles.mockReset();
    mockGetStyle.mockReset();
  });

  // --------------------------------------------------------------------------
  // Style interceptor with various checkbox states
  // --------------------------------------------------------------------------

  describe("checkboxStyleInterceptor with populated cache", () => {
    beforeEach(async () => {
      mockGetAllStyles.mockResolvedValue([
        { checkbox: false, fontSize: 11 },  // index 0
        { checkbox: true, fontSize: 11 },   // index 1
        { checkbox: true, fontSize: 14 },   // index 2
        { checkbox: false, fontSize: 11 },  // index 3
      ]);
      await refreshStyleCache();
    });

    it("returns transparent text for checkbox style (TRUE)", () => {
      const result = checkboxStyleInterceptor(
        "TRUE",
        { styleIndex: 1, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 0 },
      );
      expect(result).not.toBeNull();
      expect(result!.textColor).toBe("rgba(0,0,0,0)");
    });

    it("returns transparent text for checkbox style (FALSE)", () => {
      const result = checkboxStyleInterceptor(
        "FALSE",
        { styleIndex: 2, textColor: "#000", backgroundColor: "#fff" },
        { row: 5, col: 5 },
      );
      expect(result).not.toBeNull();
      expect(result!.textColor).toBe("rgba(0,0,0,0)");
    });

    it("returns transparent text for checkbox style with empty value", () => {
      const result = checkboxStyleInterceptor(
        "",
        { styleIndex: 1, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 0 },
      );
      expect(result).not.toBeNull();
      expect(result!.textColor).toBe("rgba(0,0,0,0)");
    });

    it("returns null for non-checkbox style", () => {
      const result = checkboxStyleInterceptor(
        "TRUE",
        { styleIndex: 0, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 0 },
      );
      expect(result).toBeNull();
    });

    it("returns null for unknown style index", () => {
      const result = checkboxStyleInterceptor(
        "TRUE",
        { styleIndex: 999, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 0 },
      );
      expect(result).toBeNull();
    });

    it("checkboxStyleIndices contains only checkbox styles", () => {
      expect(checkboxStyleIndices.has(0)).toBe(false);
      expect(checkboxStyleIndices.has(1)).toBe(true);
      expect(checkboxStyleIndices.has(2)).toBe(true);
      expect(checkboxStyleIndices.has(3)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Checkbox at cell boundaries
  // --------------------------------------------------------------------------

  describe("interceptor at cell boundaries", () => {
    beforeEach(async () => {
      mockGetAllStyles.mockResolvedValue([
        { checkbox: false },
        { checkbox: true },
      ]);
      await refreshStyleCache();
    });

    it("works at row 0, col 0", () => {
      const result = checkboxStyleInterceptor(
        "TRUE",
        { styleIndex: 1, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 0 },
      );
      expect(result).not.toBeNull();
    });

    it("works at very large row", () => {
      const result = checkboxStyleInterceptor(
        "FALSE",
        { styleIndex: 1, textColor: "#000", backgroundColor: "#fff" },
        { row: 1048575, col: 0 },
      );
      expect(result).not.toBeNull();
    });

    it("works at very large column", () => {
      const result = checkboxStyleInterceptor(
        "TRUE",
        { styleIndex: 1, textColor: "#000", backgroundColor: "#fff" },
        { row: 0, col: 16383 },
      );
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Multiple selections
  // --------------------------------------------------------------------------

  describe("selection tracking edge cases", () => {
    it("stores selection with additional ranges", () => {
      const sel = {
        startRow: 0,
        startCol: 0,
        endRow: 5,
        endCol: 5,
        type: "cells" as const,
        additionalRanges: [
          { startRow: 10, startCol: 10, endRow: 15, endCol: 15 },
        ],
      };
      setCurrentSelection(sel as any);
      const retrieved = getCurrentSelection() as any;
      expect(retrieved.additionalRanges).toHaveLength(1);
      expect(retrieved.additionalRanges[0].startRow).toBe(10);
    });

    it("overwriting selection replaces completely", () => {
      setCurrentSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as any);
      setCurrentSelection({ startRow: 99, startCol: 99, endRow: 99, endCol: 99, type: "cells" } as any);
      const sel = getCurrentSelection() as any;
      expect(sel.startRow).toBe(99);
    });

    it("setting null after selection clears it", () => {
      setCurrentSelection({ startRow: 5, startCol: 5, endRow: 5, endCol: 5, type: "cells" } as any);
      setCurrentSelection(null);
      expect(getCurrentSelection()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Style index registration and cleanup
  // --------------------------------------------------------------------------

  describe("style index registration and cleanup", () => {
    it("refreshStyleCache clears previous indices", async () => {
      mockGetAllStyles.mockResolvedValue([
        { checkbox: true },
        { checkbox: true },
      ]);
      await refreshStyleCache();
      expect(checkboxStyleIndices.size).toBe(2);

      // Refresh with no checkboxes
      mockGetAllStyles.mockResolvedValue([
        { checkbox: false },
        { checkbox: false },
      ]);
      await refreshStyleCache();
      expect(checkboxStyleIndices.size).toBe(0);
    });

    it("handles empty style array", async () => {
      mockGetAllStyles.mockResolvedValue([]);
      await refreshStyleCache();
      expect(checkboxStyleIndices.size).toBe(0);
    });

    it("handles styles without checkbox property", async () => {
      mockGetAllStyles.mockResolvedValue([
        { fontSize: 11 },
        { fontSize: 14 },
      ]);
      await refreshStyleCache();
      expect(checkboxStyleIndices.size).toBe(0);
    });

    it("handles mix of checkbox and non-checkbox across many styles", async () => {
      const styles = Array.from({ length: 100 }, (_, i) => ({
        checkbox: i % 3 === 0,
      }));
      mockGetAllStyles.mockResolvedValue(styles);
      await refreshStyleCache();
      // indices 0, 3, 6, ... 99 -> 34 items
      expect(checkboxStyleIndices.size).toBe(34);
    });
  });
});
