//! FILENAME: app/extensions/Review/lib/__tests__/navigationHelper.test.ts
// PURPOSE: Tests for the pure navigation helper functions (sortByPosition, findIndexAfter/Before).

import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to test the internal sort/find helpers.
// They are not exported, but we can test them through the public API
// by mocking the annotation store and API calls.

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { NAVIGATE_TO_CELL: "NAVIGATE_TO_CELL" },
  showOverlay: vi.fn(),
  getComment: vi.fn(),
  getNote: vi.fn(),
}));

vi.mock("../annotationStore", () => ({
  getAllCommentIndicatorsCached: vi.fn(),
  getAllNoteIndicatorsCached: vi.fn(),
}));

import { emitAppEvent, getComment, getNote } from "@api";
import {
  getAllCommentIndicatorsCached,
  getAllNoteIndicatorsCached,
} from "../annotationStore";
import {
  navigateNextComment,
  navigatePreviousComment,
  navigateNextNote,
} from "../navigationHelper";

const mockEmit = emitAppEvent as ReturnType<typeof vi.fn>;
const mockGetComment = getComment as ReturnType<typeof vi.fn>;
const mockGetNote = getNote as ReturnType<typeof vi.fn>;
const mockComments = getAllCommentIndicatorsCached as ReturnType<typeof vi.fn>;
const mockNotes = getAllNoteIndicatorsCached as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetComment.mockResolvedValue(null);
  mockGetNote.mockResolvedValue(null);
});

// ============================================================================
// navigateNextComment
// ============================================================================

describe("navigateNextComment", () => {
  it("does nothing when there are no comments", async () => {
    mockComments.mockReturnValue([]);
    await navigateNextComment(0, 0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("navigates to the next comment after current position", async () => {
    mockComments.mockReturnValue([
      { row: 1, col: 0 },
      { row: 3, col: 2 },
      { row: 5, col: 1 },
    ]);
    await navigateNextComment(2, 0);

    // Should navigate to row=3, col=2 (first comment after row 2)
    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 3, col: 2,
    });
  });

  it("wraps around to the first comment when past the last", async () => {
    mockComments.mockReturnValue([
      { row: 1, col: 0 },
      { row: 3, col: 2 },
    ]);
    await navigateNextComment(5, 0);

    // Past all comments, should wrap to the first
    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 1, col: 0,
    });
  });

  it("navigates by column within the same row", async () => {
    mockComments.mockReturnValue([
      { row: 1, col: 0 },
      { row: 1, col: 3 },
      { row: 1, col: 7 },
    ]);
    await navigateNextComment(1, 3);

    // Should go to col=7 (next after col=3 on same row)
    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 1, col: 7,
    });
  });
});

// ============================================================================
// navigatePreviousComment
// ============================================================================

describe("navigatePreviousComment", () => {
  it("does nothing when there are no comments", async () => {
    mockComments.mockReturnValue([]);
    await navigatePreviousComment(0, 0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("navigates to the previous comment before current position", async () => {
    mockComments.mockReturnValue([
      { row: 1, col: 0 },
      { row: 3, col: 2 },
      { row: 5, col: 1 },
    ]);
    await navigatePreviousComment(4, 0);

    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 3, col: 2,
    });
  });

  it("wraps around to the last comment when before the first", async () => {
    mockComments.mockReturnValue([
      { row: 3, col: 0 },
      { row: 5, col: 2 },
    ]);
    await navigatePreviousComment(1, 0);

    // Before all comments, should wrap to the last
    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 5, col: 2,
    });
  });
});

// ============================================================================
// navigateNextNote
// ============================================================================

describe("navigateNextNote", () => {
  it("navigates to the next note after current position", async () => {
    mockNotes.mockReturnValue([
      { row: 0, col: 0 },
      { row: 2, col: 5 },
    ]);
    await navigateNextNote(0, 0);

    expect(mockEmit).toHaveBeenCalledWith("NAVIGATE_TO_CELL", {
      row: 2, col: 5,
    });
  });
});
