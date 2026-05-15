//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/bookmarkStore.test.ts
// PURPOSE: Tests for the cell bookmark store CRUD and query operations.

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

describe("bookmarkStore", () => {
  beforeEach(() => {
    removeAllBookmarks();
    setCurrentSheet(0);
    // Reset highlight to off
    if (isHighlightEnabled()) toggleHighlight();
  });

  describe("addBookmark", () => {
    it("creates a bookmark with default label and color", () => {
      const bm = addBookmark(0, 0, 0, "Sheet1");
      expect(bm.row).toBe(0);
      expect(bm.col).toBe(0);
      expect(bm.sheetIndex).toBe(0);
      expect(bm.color).toBe("blue");
      expect(bm.label).toBe("A1");
      expect(bm.id).toMatch(/^bm-/);
    });

    it("uses custom label and color when provided", () => {
      const bm = addBookmark(2, 1, 0, "Sheet1", { label: "Important", color: "red" });
      expect(bm.label).toBe("Important");
      expect(bm.color).toBe("red");
    });

    it("returns existing bookmark if one exists at same cell", () => {
      const bm1 = addBookmark(0, 0, 0, "Sheet1");
      const bm2 = addBookmark(0, 0, 0, "Sheet1", { label: "Different" });
      expect(bm1.id).toBe(bm2.id);
      expect(bm2.label).toBe(bm1.label); // not updated
    });

    it("includes sheet name in label for different sheets", () => {
      setCurrentSheet(0);
      const bm = addBookmark(0, 0, 1, "Sheet2");
      expect(bm.label).toBe("Sheet2!A1");
    });

    it("generates unique IDs", () => {
      const bm1 = addBookmark(0, 0, 0, "Sheet1");
      const bm2 = addBookmark(1, 0, 0, "Sheet1");
      expect(bm1.id).not.toBe(bm2.id);
    });
  });

  describe("removeBookmark", () => {
    it("removes an existing bookmark and returns true", () => {
      addBookmark(0, 0, 0, "Sheet1");
      expect(removeBookmark(0, 0, 0)).toBe(true);
      expect(hasBookmarkAt(0, 0, 0)).toBe(false);
    });

    it("returns false for non-existent bookmark", () => {
      expect(removeBookmark(99, 99, 0)).toBe(false);
    });
  });

  describe("removeBookmarkById", () => {
    it("removes by ID", () => {
      const bm = addBookmark(0, 0, 0, "Sheet1");
      expect(removeBookmarkById(bm.id)).toBe(true);
      expect(getBookmarkCount()).toBe(0);
    });

    it("returns false for unknown ID", () => {
      expect(removeBookmarkById("bm-999999")).toBe(false);
    });
  });

  describe("removeAllBookmarks", () => {
    it("clears all bookmarks", () => {
      addBookmark(0, 0, 0, "Sheet1");
      addBookmark(1, 1, 0, "Sheet1");
      removeAllBookmarks();
      expect(getBookmarkCount()).toBe(0);
    });
  });

  describe("updateBookmark", () => {
    it("updates label and color", () => {
      const bm = addBookmark(0, 0, 0, "Sheet1");
      const ok = updateBookmark(bm.id, { label: "Updated", color: "green" });
      expect(ok).toBe(true);
      const updated = getBookmarkAt(0, 0, 0);
      expect(updated?.label).toBe("Updated");
      expect(updated?.color).toBe("green");
    });

    it("returns false for unknown ID", () => {
      expect(updateBookmark("bm-nope", { label: "x" })).toBe(false);
    });
  });

  describe("query operations", () => {
    it("getBookmarksForSheet filters by sheet", () => {
      addBookmark(0, 0, 0, "Sheet1");
      addBookmark(0, 0, 1, "Sheet2");
      addBookmark(1, 0, 1, "Sheet2");
      expect(getBookmarksForSheet(0)).toHaveLength(1);
      expect(getBookmarksForSheet(1)).toHaveLength(2);
    });

    it("getSortedBookmarks sorts by sheet, row, col", () => {
      addBookmark(5, 2, 1, "S2");
      addBookmark(0, 0, 0, "S1");
      addBookmark(5, 0, 1, "S2");
      const sorted = getSortedBookmarks();
      expect(sorted[0].sheetIndex).toBe(0);
      expect(sorted[1].col).toBe(0);
      expect(sorted[2].col).toBe(2);
    });

    it("getAllBookmarks returns all", () => {
      addBookmark(0, 0, 0, "S1");
      addBookmark(1, 0, 0, "S1");
      expect(getAllBookmarks()).toHaveLength(2);
    });
  });

  describe("highlight toggle", () => {
    it("starts disabled", () => {
      expect(isHighlightEnabled()).toBe(false);
    });

    it("toggles on and off", () => {
      expect(toggleHighlight()).toBe(true);
      expect(isHighlightEnabled()).toBe(true);
      expect(toggleHighlight()).toBe(false);
      expect(isHighlightEnabled()).toBe(false);
    });
  });

  describe("onChange", () => {
    it("notifies listeners on add", () => {
      const fn = vi.fn();
      const unsub = onChange(fn);
      addBookmark(0, 0, 0, "S1");
      expect(fn).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("stops notifying after unsubscribe", () => {
      const fn = vi.fn();
      const unsub = onChange(fn);
      unsub();
      addBookmark(0, 0, 0, "S1");
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("currentSheet", () => {
    it("defaults to 0", () => {
      expect(getCurrentSheet()).toBe(0);
    });

    it("can be set", () => {
      setCurrentSheet(3);
      expect(getCurrentSheet()).toBe(3);
    });

    it("getBookmarkAt uses currentSheet as default", () => {
      setCurrentSheet(2);
      addBookmark(0, 0, 2, "Sheet3");
      expect(getBookmarkAt(0, 0)).toBeDefined();
      expect(getBookmarkAt(0, 0, 0)).toBeUndefined();
    });
  });
});
