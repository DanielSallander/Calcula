//! FILENAME: app/extensions/Review/lib/__tests__/annotationStore.test.ts
// PURPOSE: Tests for the annotation indicator store (comments, notes cache).

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

// ============================================================================
// Setup
// ============================================================================

const mockGetComments = getCommentIndicators as ReturnType<typeof vi.fn>;
const mockGetNotes = getNoteIndicators as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAnnotationStore();
  vi.clearAllMocks();
});

// ============================================================================
// refreshAnnotationState
// ============================================================================

describe("refreshAnnotationState", () => {
  it("populates comment and note maps from backend", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "Alice", threadCount: 2 },
      { row: 3, col: 5, authorName: "Bob", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([
      { row: 1, col: 1, preview: "hello" },
    ]);

    await refreshAnnotationState();

    expect(getCommentIndicatorAt(0, 0)).toEqual({
      row: 0, col: 0, authorName: "Alice", threadCount: 2,
    });
    expect(getCommentIndicatorAt(3, 5)).toEqual({
      row: 3, col: 5, authorName: "Bob", threadCount: 1,
    });
    expect(getNoteIndicatorAt(1, 1)).toEqual({
      row: 1, col: 1, preview: "hello",
    });
  });

  it("clears old data when refreshed", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();
    expect(getCommentIndicatorAt(0, 0)).toBeDefined();

    // Refresh with empty data
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(getCommentIndicatorAt(0, 0)).toBeUndefined();
  });

  it("handles backend errors gracefully", async () => {
    mockGetComments.mockRejectedValue(new Error("network"));
    mockGetNotes.mockRejectedValue(new Error("network"));

    // Should not throw
    await refreshAnnotationState();

    expect(getAllCommentIndicatorsCached()).toEqual([]);
  });
});

// ============================================================================
// Lookup helpers
// ============================================================================

describe("hasAnnotationAt", () => {
  it("returns true for cells with comments", async () => {
    mockGetComments.mockResolvedValue([
      { row: 2, col: 3, authorName: "X", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([]);
    await refreshAnnotationState();

    expect(hasAnnotationAt(2, 3)).toBe(true);
    expect(hasAnnotationAt(0, 0)).toBe(false);
  });

  it("returns true for cells with notes", async () => {
    mockGetComments.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([
      { row: 4, col: 1, preview: "note" },
    ]);
    await refreshAnnotationState();

    expect(hasAnnotationAt(4, 1)).toBe(true);
  });
});

// ============================================================================
// Cache operations
// ============================================================================

describe("invalidateAnnotationCache", () => {
  it("clears both maps", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([
      { row: 1, col: 0, preview: "n" },
    ]);
    await refreshAnnotationState();

    invalidateAnnotationCache();

    expect(getAllCommentIndicatorsCached()).toEqual([]);
    expect(getAllNoteIndicatorsCached()).toEqual([]);
  });
});

// ============================================================================
// Toggle state
// ============================================================================

describe("show all toggles", () => {
  it("tracks showAllNotes state", () => {
    expect(getShowAllNotes()).toBe(false);
    setShowAllNotes(true);
    expect(getShowAllNotes()).toBe(true);
    setShowAllNotes(false);
    expect(getShowAllNotes()).toBe(false);
  });

  it("tracks showAllComments state", () => {
    expect(getShowAllComments()).toBe(false);
    setShowAllComments(true);
    expect(getShowAllComments()).toBe(true);
  });

  it("resets toggles on resetAnnotationStore", () => {
    setShowAllNotes(true);
    setShowAllComments(true);
    resetAnnotationStore();
    expect(getShowAllNotes()).toBe(false);
    expect(getShowAllComments()).toBe(false);
  });
});
