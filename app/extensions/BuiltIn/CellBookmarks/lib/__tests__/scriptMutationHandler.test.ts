//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/scriptMutationHandler.test.ts
// PURPOSE: Tests for applying the bookmark mutations a script queued.
// CONTEXT: The mutations arrive over IPC inside an untyped CustomEvent detail;
//          these lock down the normalization (camelCase wire shape), the
//          cross-sheet name lookup, and the recursion guard on view activation.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/backend", () => ({ invokeBackend: vi.fn() }));

const mockGetGridStateSnapshot = vi.fn();
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => mockGetGridStateSnapshot(),
}));

const mockGetSheets = vi.fn();
vi.mock("@api/lib", () => ({
  getSheets: () => mockGetSheets(),
}));

const mockAddBookmark = vi.fn();
const mockRemoveBookmark = vi.fn();
vi.mock("../bookmarkStore", () => ({
  addBookmark: (...args: unknown[]) => mockAddBookmark(...args),
  removeBookmark: (...args: unknown[]) => mockRemoveBookmark(...args),
}));

const mockAddViewBookmark = vi.fn();
const mockRemoveViewBookmark = vi.fn();
const mockActivateViewBookmark = vi.fn();
vi.mock("../viewBookmarkStore", () => ({
  addViewBookmark: (...args: unknown[]) => mockAddViewBookmark(...args),
  removeViewBookmark: (...args: unknown[]) => mockRemoveViewBookmark(...args),
  activateViewBookmark: (...args: unknown[]) => mockActivateViewBookmark(...args),
}));

import { processBookmarkMutations } from "../scriptMutationHandler";
import { DEFAULT_VIEW_DIMENSIONS } from "../viewBookmarkTypes";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGridStateSnapshot.mockReturnValue({
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  });
  mockGetSheets.mockResolvedValue({
    sheets: [
      { index: 0, name: "Sheet1", visibility: "visible" },
      { index: 1, name: "Budget", visibility: "visible" },
    ],
    activeIndex: 0,
  });
  mockActivateViewBookmark.mockResolvedValue(true);
});

describe("processBookmarkMutations", () => {
  it("adds a cell bookmark from the camelCase wire payload", async () => {
    await processBookmarkMutations([
      { action: "addCellBookmark", row: 2, col: 3, sheetIndex: 0, label: "Total", color: "red" },
    ]);

    expect(mockAddBookmark).toHaveBeenCalledWith(2, 3, 0, "Sheet1", {
      label: "Total",
      color: "red",
    });
  });

  it("does NOT accept snake_case — the wire contract is camelCase", async () => {
    // What a dropped per-variant rename_all on the Rust enum would send: the
    // sheet must NOT silently resolve, it must fall back to the active sheet.
    await processBookmarkMutations([
      { action: "addCellBookmark", row: 2, col: 3, sheet_index: 1, label: null, color: null },
    ]);

    expect(mockAddBookmark).toHaveBeenCalledWith(2, 3, 0, "Sheet1", {
      label: undefined,
      color: "blue",
    });
  });

  it("resolves the sheet NAME for a bookmark on another sheet", async () => {
    await processBookmarkMutations([
      { action: "addCellBookmark", row: 0, col: 0, sheetIndex: 1, label: null, color: null },
    ]);

    expect(mockAddBookmark).toHaveBeenCalledWith(0, 0, 1, "Budget", {
      label: undefined,
      color: "blue",
    });
  });

  it("falls back to the active sheet when the script named none", async () => {
    mockGetGridStateSnapshot.mockReturnValue({
      sheetContext: { activeSheetIndex: 1, activeSheetName: "Budget" },
    });
    await processBookmarkMutations([{ action: "removeCellBookmark", row: 4, col: 4 }]);

    expect(mockRemoveBookmark).toHaveBeenCalledWith(4, 4, 1);
    expect(mockGetSheets).not.toHaveBeenCalled();
  });

  it("creates a view bookmark, parsing the dimensions payload", async () => {
    await processBookmarkMutations([
      {
        action: "createViewBookmark",
        label: "Q1 view",
        color: "green",
        dimensionsJson: JSON.stringify({ ...DEFAULT_VIEW_DIMENSIONS, zoom: false }),
      },
    ]);

    expect(mockAddViewBookmark).toHaveBeenCalledWith({
      label: "Q1 view",
      color: "green",
      dimensions: { ...DEFAULT_VIEW_DIMENSIONS, zoom: false },
    });
  });

  it("falls back to the default dimensions when the JSON is malformed", async () => {
    await processBookmarkMutations([
      { action: "createViewBookmark", label: "Broken", color: null, dimensionsJson: "{oops" },
    ]);

    expect(mockAddViewBookmark).toHaveBeenCalledWith({
      label: "Broken",
      color: "blue",
      dimensions: { ...DEFAULT_VIEW_DIMENSIONS },
    });
  });

  it("deletes and activates view bookmarks by id", async () => {
    await processBookmarkMutations([
      { action: "deleteViewBookmark", id: "vb-1" },
      { action: "activateViewBookmark", id: "vb-2" },
    ]);

    expect(mockRemoveViewBookmark).toHaveBeenCalledWith("vb-1");
    expect(mockActivateViewBookmark).toHaveBeenCalledWith("vb-2");
  });

  it("breaks the cycle when an onActivate script re-activates its own bookmark", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Activating vb-1 runs its script, which queues another activation of vb-1.
    mockActivateViewBookmark.mockImplementation(async () => {
      await processBookmarkMutations([{ action: "activateViewBookmark", id: "vb-1" }]);
      return true;
    });

    await processBookmarkMutations([{ action: "activateViewBookmark", id: "vb-1" }]);

    expect(mockActivateViewBookmark).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("drops malformed mutations and keeps applying the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processBookmarkMutations([
      { action: "addCellBookmark", row: "x", col: 1 },
      { action: "createViewBookmark", color: "red" },
      { action: "deleteViewBookmark", id: "" },
      { action: "unknownThing" },
      { action: "removeCellBookmark", row: 1, col: 1, sheetIndex: 0 },
    ]);

    expect(mockAddBookmark).not.toHaveBeenCalled();
    expect(mockAddViewBookmark).not.toHaveBeenCalled();
    expect(mockRemoveViewBookmark).not.toHaveBeenCalled();
    expect(mockRemoveBookmark).toHaveBeenCalledWith(1, 1, 0);
    warn.mockRestore();
  });

  it("ignores a non-array payload", async () => {
    await processBookmarkMutations(undefined);
    await processBookmarkMutations({ action: "deleteViewBookmark", id: "vb-1" });
    expect(mockRemoveViewBookmark).not.toHaveBeenCalled();
  });
});
