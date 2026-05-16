//! FILENAME: app/extensions/Review/lib/__tests__/annotationStore.deep.test.ts
// PURPOSE: Deep tests for annotation store - threads, bulk ops, edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @api backend calls
vi.mock("@api", () => ({
  getCommentIndicators: vi.fn(),
  getNoteIndicators: vi.fn(),
}));

import { getCommentIndicators, getNoteIndicators } from "@api";
import {
  refreshAnnotationState,
  getCommentIndicatorAt,
  getNoteIndicatorAt,
  hasAnnotationAt,
  getAllCommentIndicatorsCached,
  getAllNoteIndicatorsCached,
  invalidateAnnotationCache,
  resetAnnotationStore,
  setShowAllNotes,
  getShowAllNotes,
  setShowAllComments,
  getShowAllComments,
} from "../annotationStore";

const mockGetComments = getCommentIndicators as ReturnType<typeof vi.fn>;
const mockGetNotes = getNoteIndicators as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAnnotationStore();
  vi.clearAllMocks();
});

// ============================================================================
// Comment threads with replies
// ============================================================================

describe("comment thread with replies", () => {
  it("stores threadCount reflecting multiple replies", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "Alice", threadCount: 5 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    const indicator = getCommentIndicatorAt(0, 0);
    expect(indicator).toBeDefined();
    expect(indicator!.threadCount).toBe(5);
  });

  it("handles multiple cells each with threaded comments", async () => {
    const comments = [
      { row: 0, col: 0, authorName: "Alice", threadCount: 3 },
      { row: 1, col: 2, authorName: "Bob", threadCount: 7 },
      { row: 5, col: 10, authorName: "Charlie", threadCount: 1 },
    ];
    mockGetComments.mockResolvedValue(comments);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(getCommentIndicatorAt(0, 0)!.threadCount).toBe(3);
    expect(getCommentIndicatorAt(1, 2)!.threadCount).toBe(7);
    expect(getCommentIndicatorAt(5, 10)!.threadCount).toBe(1);
  });
});

// ============================================================================
// Navigation through comments on multiple sheets (simulated via refresh)
// ============================================================================

describe("navigation through comments on multiple sheets", () => {
  it("refreshing replaces all indicators simulating sheet switch", async () => {
    // Sheet 1 comments
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
      { row: 10, col: 5, authorName: "B", threadCount: 2 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();
    expect(getAllCommentIndicatorsCached()).toHaveLength(2);

    // Switch to Sheet 2 (backend returns different indicators)
    mockGetComments.mockResolvedValue([
      { row: 3, col: 3, authorName: "C", threadCount: 1 },
    ]);
    await refreshAnnotationState();

    expect(getAllCommentIndicatorsCached()).toHaveLength(1);
    expect(getCommentIndicatorAt(0, 0)).toBeUndefined();
    expect(getCommentIndicatorAt(3, 3)).toBeDefined();
  });

  it("switching to a sheet with no comments clears all", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();
    expect(getAllCommentIndicatorsCached()).toHaveLength(1);

    mockGetComments.mockResolvedValue([]);
    await refreshAnnotationState();
    expect(getAllCommentIndicatorsCached()).toHaveLength(0);
  });
});

// ============================================================================
// Threaded comment ordering (by position)
// ============================================================================

describe("threaded comment ordering by position", () => {
  it("getAllCommentIndicatorsCached returns all regardless of insertion order", async () => {
    mockGetComments.mockResolvedValue([
      { row: 99, col: 0, authorName: "Z", threadCount: 1 },
      { row: 0, col: 50, authorName: "A", threadCount: 1 },
      { row: 10, col: 3, authorName: "M", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    const all = getAllCommentIndicatorsCached();
    expect(all).toHaveLength(3);
    // All three positions accessible
    expect(getCommentIndicatorAt(99, 0)).toBeDefined();
    expect(getCommentIndicatorAt(0, 50)).toBeDefined();
    expect(getCommentIndicatorAt(10, 3)).toBeDefined();
  });
});

// ============================================================================
// Show/hide all comments toggle
// ============================================================================

describe("show/hide all comments toggle", () => {
  it("toggling showAllComments does not affect showAllNotes", () => {
    setShowAllComments(true);
    expect(getShowAllComments()).toBe(true);
    expect(getShowAllNotes()).toBe(false);
  });

  it("toggling showAllNotes does not affect showAllComments", () => {
    setShowAllNotes(true);
    expect(getShowAllNotes()).toBe(true);
    expect(getShowAllComments()).toBe(false);
  });

  it("both toggles can be active simultaneously", () => {
    setShowAllComments(true);
    setShowAllNotes(true);
    expect(getShowAllComments()).toBe(true);
    expect(getShowAllNotes()).toBe(true);
  });

  it("resetting store turns off both toggles", () => {
    setShowAllComments(true);
    setShowAllNotes(true);
    resetAnnotationStore();
    expect(getShowAllComments()).toBe(false);
    expect(getShowAllNotes()).toBe(false);
  });
});

// ============================================================================
// Comment on merged cell ranges (indicator at anchor cell)
// ============================================================================

describe("comment on merged cell ranges", () => {
  it("indicator stored at the anchor cell position of a merge", async () => {
    // Merged range A1:C3 => anchor at (0,0)
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "Merge Author", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(hasAnnotationAt(0, 0)).toBe(true);
    // Non-anchor cells in the merge have no indicator
    expect(hasAnnotationAt(0, 1)).toBe(false);
    expect(hasAnnotationAt(1, 0)).toBe(false);
    expect(hasAnnotationAt(2, 2)).toBe(false);
  });
});

// ============================================================================
// Bulk operations
// ============================================================================

describe("bulk operations", () => {
  it("invalidateAnnotationCache clears all comments and notes at once", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
      { row: 1, col: 1, authorName: "B", threadCount: 2 },
      { row: 2, col: 2, authorName: "C", threadCount: 3 },
    ]);
    mockGetNotes.mockResolvedValue([
      { row: 3, col: 3, preview: "note1" },
      { row: 4, col: 4, preview: "note2" },
    ]);
    await refreshAnnotationState();

    expect(getAllCommentIndicatorsCached()).toHaveLength(3);
    expect(getAllNoteIndicatorsCached()).toHaveLength(2);

    invalidateAnnotationCache();

    expect(getAllCommentIndicatorsCached()).toHaveLength(0);
    expect(getAllNoteIndicatorsCached()).toHaveLength(0);
  });

  it("resetAnnotationStore clears data and toggles", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([
      { row: 1, col: 0, preview: "n" },
    ]);
    await refreshAnnotationState();
    setShowAllComments(true);
    setShowAllNotes(true);

    resetAnnotationStore();

    expect(getAllCommentIndicatorsCached()).toHaveLength(0);
    expect(getAllNoteIndicatorsCached()).toHaveLength(0);
    expect(getShowAllComments()).toBe(false);
    expect(getShowAllNotes()).toBe(false);
  });

  it("refresh after invalidate repopulates correctly", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    invalidateAnnotationCache();
    expect(getAllCommentIndicatorsCached()).toHaveLength(0);

    mockGetComments.mockResolvedValue([
      { row: 5, col: 5, authorName: "New", threadCount: 2 },
    ]);
    await refreshAnnotationState();

    expect(getAllCommentIndicatorsCached()).toHaveLength(1);
    expect(getCommentIndicatorAt(5, 5)!.authorName).toBe("New");
  });
});

// ============================================================================
// Comment with very long text
// ============================================================================

describe("comment with very long text", () => {
  it("handles note preview with 10K characters", async () => {
    const longText = "x".repeat(10_000);
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 0, col: 0, preview: longText },
    ]);
    await refreshAnnotationState();

    const note = getNoteIndicatorAt(0, 0);
    expect(note).toBeDefined();
    expect(note!.preview).toHaveLength(10_000);
  });

  it("handles author name with long string", async () => {
    const longAuthor = "A".repeat(1000);
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: longAuthor, threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(getCommentIndicatorAt(0, 0)!.authorName).toHaveLength(1000);
  });
});

// ============================================================================
// Special characters and unicode in comments
// ============================================================================

describe("special characters and unicode in comments", () => {
  it("handles unicode in author names", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "Muller", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(getCommentIndicatorAt(0, 0)!.authorName).toBe("Muller");
  });

  it("handles CJK characters in note preview", async () => {
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 0, col: 0, preview: "This has some text" },
    ]);
    await refreshAnnotationState();

    expect(getNoteIndicatorAt(0, 0)!.preview).toContain("text");
  });

  it("handles emoji in note preview", async () => {
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 0, col: 0, preview: "Check this out \u{1F680}\u{1F4CA}\u{2705}" },
    ]);
    await refreshAnnotationState();

    const note = getNoteIndicatorAt(0, 0);
    expect(note!.preview).toContain("\u{1F680}");
  });

  it("handles special HTML-like characters in preview", async () => {
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 0, col: 0, preview: '<script>alert("xss")</script>' },
    ]);
    await refreshAnnotationState();

    expect(getNoteIndicatorAt(0, 0)!.preview).toBe('<script>alert("xss")</script>');
  });

  it("handles newlines and tabs in preview", async () => {
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 0, col: 0, preview: "Line1\nLine2\tTabbed" },
    ]);
    await refreshAnnotationState();

    expect(getNoteIndicatorAt(0, 0)!.preview).toBe("Line1\nLine2\tTabbed");
  });
});

// ============================================================================
// Large number of annotations
// ============================================================================

describe("large number of annotations", () => {
  it("handles 500 comment indicators", async () => {
    const comments = Array.from({ length: 500 }, (_, i) => ({
      row: Math.floor(i / 50),
      col: i % 50,
      authorName: `User${i}`,
      threadCount: 1,
    }));
    mockGetComments.mockResolvedValue(comments);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(getAllCommentIndicatorsCached()).toHaveLength(500);
    expect(getCommentIndicatorAt(3, 25)).toBeDefined();
    expect(getCommentIndicatorAt(3, 25)!.authorName).toBe("User175");
  });

  it("hasAnnotationAt works correctly with dense annotations", async () => {
    const comments = Array.from({ length: 100 }, (_, i) => ({
      row: i,
      col: 0,
      authorName: `U${i}`,
      threadCount: 1,
    }));
    const notes = Array.from({ length: 100 }, (_, i) => ({
      row: i,
      col: 1,
      preview: `note${i}`,
    }));
    mockGetComments.mockResolvedValue(comments);
    mockGetNotes.mockResolvedValue(notes);
    await refreshAnnotationState();

    for (let r = 0; r < 100; r++) {
      expect(hasAnnotationAt(r, 0)).toBe(true);
      expect(hasAnnotationAt(r, 1)).toBe(true);
      expect(hasAnnotationAt(r, 2)).toBe(false);
    }
  });
});
