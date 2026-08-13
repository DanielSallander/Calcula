//! FILENAME: app/extensions/Review/lib/__tests__/annotationStore.test.ts
// PURPOSE: Tests for the annotation indicator store (comments, notes cache).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @api backend calls
import { createCoalescedRefresh as actualCoalescedRefresh } from "../../../../src/api/coalescedRefresh";

vi.mock("@api", () => ({
  // The refresh coalescer is @api's own primitive, not a backend
  // boundary — the real one, so these tests exercise real coalescing.
  createCoalescedRefresh: actualCoalescedRefresh,
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
  requestAnnotationRefresh,
  invalidateAnnotationRefresh,
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

describe("the cache is never empty while it is being refilled", () => {
  // BUG-0042's neighbourhood. Every reader of these maps is SYNCHRONOUS -- the
  // triangle renderer, the cell-click interceptor, the hover preview -- and a
  // map that answers "absent" mid-refill is indistinguishable from "deleted":
  // no triangle, no editor, no preview, with nothing scheduled to correct it.
  it("a reader during the refill still sees the previous answer", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([{ row: 1, col: 0, preview: "n" }]);
    await refreshAnnotationState();

    let seenMidFlight: number | null = null;
    mockGetNotes.mockImplementation(async () => {
      // The refill is in flight right now; this is what a paint would read.
      seenMidFlight = getAllNoteIndicatorsCached().length;
      return [{ row: 2, col: 0, preview: "n2" }];
    });
    await requestAnnotationRefresh();

    expect(seenMidFlight, "the old answer, not an empty map").toBe(1);
    expect(getAllNoteIndicatorsCached()).toHaveLength(1);
    expect(getNoteIndicatorAt(2, 0)).toBeDefined();
  });

  it("a failed read leaves the previous answer standing", async () => {
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([{ row: 1, col: 0, preview: "n" }]);
    await refreshAnnotationState();

    mockGetNotes.mockRejectedValue(new Error("ipc down"));
    await requestAnnotationRefresh();

    expect(getAllNoteIndicatorsCached()).toHaveLength(1);
    expect(getAllCommentIndicatorsCached()).toHaveLength(1);
  });

  it("a pass abandoned by invalidateAnnotationRefresh writes nothing", async () => {
    // The sheet changed under an in-flight read: its answer describes the sheet
    // the user just left and must not land. invalidate() only means that if the
    // read actually consults stillCurrent().
    mockGetComments.mockResolvedValue([
      { row: 0, col: 0, authorName: "A", threadCount: 1 },
    ]);
    mockGetNotes.mockResolvedValue([{ row: 1, col: 0, preview: "n" }]);
    await refreshAnnotationState();

    mockGetNotes.mockImplementation(async () => {
      invalidateAnnotationRefresh();
      return [{ row: 9, col: 9, preview: "other sheet" }];
    });
    await requestAnnotationRefresh();

    expect(getNoteIndicatorAt(9, 9), "the stale sheet's note did not land").toBeUndefined();
    expect(getNoteIndicatorAt(1, 0), "the previous answer survived").toBeDefined();
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
