//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/bookmarkStore.deep.test.ts
// PURPOSE: Deep tests for bookmark store: scale, navigation, persistence, edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", () => ({
  columnToLetter: (col: number) => {
    let s = "";
    let c = col;
    do {
      s = String.fromCharCode(65 + (c % 26)) + s;
      c = Math.floor(c / 26) - 1;
    } while (c >= 0);
    return s;
  },
}));

import {
  addBookmark,
  removeBookmark,
  removeBookmarkById,
  removeAllBookmarks,
  updateBookmark,
  getBookmarkAt,
  hasBookmarkAt,
  getAllBookmarks,
  getBookmarksForSheet,
  getBookmarkCount,
  getSortedBookmarks,
  setCurrentSheet,
  getCurrentSheet,
  isHighlightEnabled,
  toggleHighlight,
  onChange,
} from "../bookmarkStore";
import type { BookmarkColor } from "../bookmarkTypes";
import { BOOKMARK_COLORS } from "../bookmarkTypes";

describe("bookmarkStore deep tests", () => {
  beforeEach(() => {
    removeAllBookmarks();
    setCurrentSheet(0);
    if (isHighlightEnabled()) toggleHighlight();
  });

  // ==========================================================================
  // Scale: 100+ bookmarks across 10 sheets
  // ==========================================================================

  describe("scale - 100+ bookmarks across 10 sheets", () => {
    it("handles 100 bookmarks across 10 sheets", () => {
      for (let sheet = 0; sheet < 10; sheet++) {
        for (let row = 0; row < 10; row++) {
          addBookmark(row, sheet, sheet, `Sheet${sheet + 1}`);
        }
      }
      expect(getBookmarkCount()).toBe(100);
    });

    it("getBookmarksForSheet returns correct count per sheet", () => {
      for (let sheet = 0; sheet < 10; sheet++) {
        for (let row = 0; row < 10; row++) {
          addBookmark(row, 0, sheet, `Sheet${sheet + 1}`);
        }
      }
      for (let sheet = 0; sheet < 10; sheet++) {
        expect(getBookmarksForSheet(sheet)).toHaveLength(10);
      }
    });

    it("getSortedBookmarks sorts all 100 correctly", () => {
      for (let sheet = 9; sheet >= 0; sheet--) {
        for (let row = 9; row >= 0; row--) {
          addBookmark(row, 0, sheet, `S${sheet}`);
        }
      }
      const sorted = getSortedBookmarks();
      expect(sorted).toHaveLength(100);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevKey = prev.sheetIndex * 1000 + prev.row * 10 + prev.col;
        const currKey = curr.sheetIndex * 1000 + curr.row * 10 + curr.col;
        expect(currKey).toBeGreaterThanOrEqual(prevKey);
      }
    });

    it("removeAllBookmarks clears all 100 at once", () => {
      for (let i = 0; i < 100; i++) {
        addBookmark(i, 0, 0, "Sheet1");
      }
      expect(getBookmarkCount()).toBe(100);
      removeAllBookmarks();
      expect(getBookmarkCount()).toBe(0);
    });

    it("150 bookmarks with varied colors", () => {
      for (let i = 0; i < 150; i++) {
        const color = BOOKMARK_COLORS[i % BOOKMARK_COLORS.length];
        addBookmark(i, 0, i % 10, `S${i % 10}`, { color });
      }
      expect(getBookmarkCount()).toBe(150);
      const blues = getAllBookmarks().filter((b) => b.color === "blue");
      expect(blues.length).toBe(25); // 150/6 = 25
    });
  });

  // ==========================================================================
  // Bookmark navigation order (next/previous via sorted list with wrapping)
  // ==========================================================================

  describe("navigation order (sorted bookmarks with wrapping)", () => {
    it("sorted order for cross-sheet bookmarks", () => {
      addBookmark(5, 0, 2, "S3");
      addBookmark(0, 0, 0, "S1");
      addBookmark(3, 0, 1, "S2");
      const sorted = getSortedBookmarks();
      expect(sorted[0].sheetIndex).toBe(0);
      expect(sorted[1].sheetIndex).toBe(1);
      expect(sorted[2].sheetIndex).toBe(2);
    });

    it("sorted order within same sheet by row then col", () => {
      addBookmark(2, 3, 0, "S1");
      addBookmark(2, 1, 0, "S1");
      addBookmark(0, 5, 0, "S1");
      const sorted = getSortedBookmarks();
      expect(sorted[0].row).toBe(0);
      expect(sorted[1].col).toBe(1);
      expect(sorted[2].col).toBe(3);
    });

    it("wrap-around scenario: last sorted bookmark leads back to first", () => {
      addBookmark(0, 0, 0, "S1");
      addBookmark(10, 0, 0, "S1");
      addBookmark(0, 0, 1, "S2");
      const sorted = getSortedBookmarks();
      // After navigating past sorted[2], wrapping means next = sorted[0]
      expect(sorted[0].sheetIndex).toBe(0);
      expect(sorted[0].row).toBe(0);
      expect(sorted[sorted.length - 1].sheetIndex).toBe(1);
    });
  });

  // ==========================================================================
  // Custom colors and labels
  // ==========================================================================

  describe("custom colors and labels", () => {
    it("all six bookmark colors can be used", () => {
      BOOKMARK_COLORS.forEach((color, i) => {
        addBookmark(i, 0, 0, "S1", { color });
      });
      const all = getAllBookmarks();
      const colors = new Set(all.map((b) => b.color));
      expect(colors.size).toBe(6);
    });

    it("custom label with special characters", () => {
      const bm = addBookmark(0, 0, 0, "S1", { label: "Q1 Revenue <$1M>" });
      expect(bm.label).toBe("Q1 Revenue <$1M>");
    });

    it("custom label with unicode", () => {
      const bm = addBookmark(0, 0, 0, "S1", { label: "Summering" });
      expect(bm.label).toBe("Summering");
    });

    it("empty-string label falls back to cell reference", () => {
      const bm = addBookmark(0, 0, 0, "S1", { label: "" });
      // empty string is falsy, so cellRef is used
      expect(bm.label).toBe("A1");
    });

    it("update color to every valid color", () => {
      const bm = addBookmark(0, 0, 0, "S1");
      for (const color of BOOKMARK_COLORS) {
        updateBookmark(bm.id, { color });
        expect(getBookmarkAt(0, 0, 0)?.color).toBe(color);
      }
    });
  });

  // ==========================================================================
  // Duplicate bookmark at same cell
  // ==========================================================================

  describe("duplicate bookmark at same cell", () => {
    it("returns existing bookmark without creating new one", () => {
      const bm1 = addBookmark(3, 3, 0, "S1", { label: "First", color: "red" });
      const bm2 = addBookmark(3, 3, 0, "S1", { label: "Second", color: "green" });
      expect(bm1.id).toBe(bm2.id);
      expect(getBookmarkCount()).toBe(1);
    });

    it("preserves original label and color on duplicate add", () => {
      addBookmark(0, 0, 0, "S1", { label: "Original", color: "red" });
      const dup = addBookmark(0, 0, 0, "S1", { label: "Overwrite", color: "green" });
      expect(dup.label).toBe("Original");
      expect(dup.color).toBe("red");
    });

    it("same cell on different sheets creates separate bookmarks", () => {
      addBookmark(0, 0, 0, "S1");
      addBookmark(0, 0, 1, "S2");
      expect(getBookmarkCount()).toBe(2);
    });
  });

  // ==========================================================================
  // Remove bookmarks by sheet (bulk)
  // ==========================================================================

  describe("remove bookmarks by sheet (bulk)", () => {
    it("remove all bookmarks from a single sheet", () => {
      addBookmark(0, 0, 0, "S1");
      addBookmark(1, 0, 0, "S1");
      addBookmark(0, 0, 1, "S2");
      const sheetBookmarks = getBookmarksForSheet(0);
      for (const bm of sheetBookmarks) {
        removeBookmarkById(bm.id);
      }
      expect(getBookmarksForSheet(0)).toHaveLength(0);
      expect(getBookmarksForSheet(1)).toHaveLength(1);
    });

    it("bulk remove from sheet with many bookmarks", () => {
      for (let i = 0; i < 50; i++) {
        addBookmark(i, 0, 0, "S1");
      }
      for (let i = 0; i < 5; i++) {
        addBookmark(i, 0, 1, "S2");
      }
      const sheet0 = getBookmarksForSheet(0);
      for (const bm of sheet0) {
        removeBookmarkById(bm.id);
      }
      expect(getBookmarkCount()).toBe(5);
    });
  });

  // ==========================================================================
  // Highlight toggle with rapid switching
  // ==========================================================================

  describe("highlight toggle rapid switching", () => {
    it("rapid toggle 20 times ends in correct state", () => {
      for (let i = 0; i < 20; i++) {
        toggleHighlight();
      }
      // 20 toggles from false => false (even number)
      expect(isHighlightEnabled()).toBe(false);
    });

    it("rapid toggle 21 times ends enabled", () => {
      for (let i = 0; i < 21; i++) {
        toggleHighlight();
      }
      expect(isHighlightEnabled()).toBe(true);
    });

    it("each toggle fires onChange", () => {
      const fn = vi.fn();
      const unsub = onChange(fn);
      toggleHighlight();
      toggleHighlight();
      toggleHighlight();
      expect(fn).toHaveBeenCalledTimes(3);
      unsub();
    });
  });

  // ==========================================================================
  // Sort order (by position)
  // ==========================================================================

  describe("sort order stability", () => {
    it("bookmarks on same row sorted by column", () => {
      addBookmark(0, 5, 0, "S1");
      addBookmark(0, 2, 0, "S1");
      addBookmark(0, 8, 0, "S1");
      const sorted = getSortedBookmarks();
      expect(sorted.map((b) => b.col)).toEqual([2, 5, 8]);
    });

    it("bookmarks on same sheet sorted by row first", () => {
      addBookmark(10, 0, 0, "S1");
      addBookmark(1, 5, 0, "S1");
      addBookmark(1, 0, 0, "S1");
      const sorted = getSortedBookmarks();
      expect(sorted[0].row).toBe(1);
      expect(sorted[0].col).toBe(0);
      expect(sorted[1].row).toBe(1);
      expect(sorted[1].col).toBe(5);
      expect(sorted[2].row).toBe(10);
    });
  });

  // ==========================================================================
  // Export/import bookmarks (serialization round-trip)
  // ==========================================================================

  describe("export/import bookmarks (serialization round-trip)", () => {
    it("round-trips bookmarks through JSON serialization", () => {
      addBookmark(0, 0, 0, "S1", { label: "Start", color: "green" });
      addBookmark(5, 3, 1, "S2", { label: "Data", color: "red" });
      addBookmark(99, 25, 2, "S3", { label: "End", color: "purple" });

      const exported = JSON.stringify(getAllBookmarks());
      removeAllBookmarks();
      expect(getBookmarkCount()).toBe(0);

      const imported = JSON.parse(exported);
      for (const bm of imported) {
        addBookmark(bm.row, bm.col, bm.sheetIndex, bm.sheetName, {
          label: bm.label,
          color: bm.color,
        });
      }
      expect(getBookmarkCount()).toBe(3);
      expect(getBookmarkAt(0, 0, 0)?.label).toBe("Start");
      expect(getBookmarkAt(5, 3, 1)?.color).toBe("red");
      expect(getBookmarkAt(99, 25, 2)?.label).toBe("End");
    });

    it("exported data contains all required fields", () => {
      addBookmark(1, 2, 3, "Sheet4", { label: "Test", color: "yellow" });
      const exported = getAllBookmarks();
      const bm = exported[0];
      expect(bm).toHaveProperty("id");
      expect(bm).toHaveProperty("row", 1);
      expect(bm).toHaveProperty("col", 2);
      expect(bm).toHaveProperty("sheetIndex", 3);
      expect(bm).toHaveProperty("sheetName", "Sheet4");
      expect(bm).toHaveProperty("label", "Test");
      expect(bm).toHaveProperty("color", "yellow");
      expect(bm).toHaveProperty("createdAt");
      expect(typeof bm.createdAt).toBe("number");
    });
  });

  // ==========================================================================
  // Edge cases: row 0/col 0, max row/col
  // ==========================================================================

  describe("edge cases - boundary cells", () => {
    it("bookmark at row 0, col 0", () => {
      const bm = addBookmark(0, 0, 0, "S1");
      expect(bm.row).toBe(0);
      expect(bm.col).toBe(0);
      expect(hasBookmarkAt(0, 0, 0)).toBe(true);
    });

    it("bookmark at very large row and col (1048575, 16383)", () => {
      const bm = addBookmark(1048575, 16383, 0, "S1");
      expect(bm.row).toBe(1048575);
      expect(bm.col).toBe(16383);
      expect(hasBookmarkAt(1048575, 16383, 0)).toBe(true);
    });

    it("bookmarks at adjacent boundary cells are distinct", () => {
      addBookmark(0, 0, 0, "S1");
      addBookmark(0, 1, 0, "S1");
      addBookmark(1, 0, 0, "S1");
      expect(getBookmarkCount()).toBe(3);
    });

    it("remove and re-add bookmark at same cell gets new ID", () => {
      const bm1 = addBookmark(0, 0, 0, "S1");
      const id1 = bm1.id;
      removeBookmark(0, 0, 0);
      const bm2 = addBookmark(0, 0, 0, "S1");
      expect(bm2.id).not.toBe(id1);
    });

    it("bookmark at sheet index 0 with currentSheet set elsewhere", () => {
      setCurrentSheet(5);
      const bm = addBookmark(0, 0, 0, "Sheet1");
      // Label should include sheet name since currentSheet != bookmark sheet
      expect(bm.label).toBe("Sheet1!A1");
    });

    it("removeAllBookmarks on empty store does not fire onChange", () => {
      const fn = vi.fn();
      const unsub = onChange(fn);
      removeAllBookmarks(); // already empty from beforeEach
      expect(fn).not.toHaveBeenCalled();
      unsub();
    });
  });

  // ==========================================================================
  // onChange listener edge cases
  // ==========================================================================

  describe("onChange listener edge cases", () => {
    it("multiple listeners all get notified", () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const fn3 = vi.fn();
      const unsub1 = onChange(fn1);
      const unsub2 = onChange(fn2);
      const unsub3 = onChange(fn3);
      addBookmark(0, 0, 0, "S1");
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn3).toHaveBeenCalledTimes(1);
      unsub1();
      unsub2();
      unsub3();
    });

    it("listener throwing does not prevent other listeners", () => {
      const fn1 = vi.fn(() => {
        throw new Error("boom");
      });
      const fn2 = vi.fn();
      const unsub1 = onChange(fn1);
      const unsub2 = onChange(fn2);
      addBookmark(0, 0, 0, "S1");
      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
      unsub1();
      unsub2();
    });

    it("update triggers onChange", () => {
      const bm = addBookmark(0, 0, 0, "S1");
      const fn = vi.fn();
      const unsub = onChange(fn);
      updateBookmark(bm.id, { label: "Changed" });
      expect(fn).toHaveBeenCalledTimes(1);
      unsub();
    });
  });
});
