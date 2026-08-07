//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/bookmarkWriteThrough.test.ts
// PURPOSE: Pin the bookmark WRITE-THROUGH, which replaced a BEFORE_SAVE listener.
//
// THE DEFECT THIS GUARDS. Bookmarks used to be flushed to the virtual file only from an
// `AppEvents.BEFORE_SAVE` handler. That handler is `async` and the event dispatcher does
// not await its handlers, so `save_file` could serialize `user_files` before the flush
// resolved: the newest bookmark was archived one save late, or lost outright if the user
// never saved again. There is no ordering fix available from the listener side, because
// the race is between two independent async chains -- so the flush had to stop being a
// save-time event at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const createVirtualFile = vi.fn(async () => {});
const readVirtualFile = vi.fn(async () => "");

vi.mock("@api/backend", () => ({
  createVirtualFile: (...args: unknown[]) => createVirtualFile(...(args as [])),
  readVirtualFile: (...args: unknown[]) => readVirtualFile(...(args as [])),
}));

import { addBookmark, removeAllBookmarks } from "../bookmarkStore";
import {
  startBookmarkWriteThrough,
  flushBookmarkWrites,
  loadBookmarks,
} from "../bookmarkPersistence";

const BOOKMARKS_FILE = ".calcula/bookmarks.json";

describe("bookmark write-through", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    createVirtualFile.mockClear();
    readVirtualFile.mockClear();
    removeAllBookmarks();
  });

  afterEach(async () => {
    await flushBookmarkWrites();
    stop?.();
    stop = null;
    removeAllBookmarks();
  });

  it("persists on the mutation itself, with no save event involved", async () => {
    stop = startBookmarkWriteThrough();
    createVirtualFile.mockClear();

    addBookmark(3, 4, 0, "Sheet1", { label: "here" });
    await flushBookmarkWrites();

    // The whole point: the file is current WITHOUT anything having dispatched
    // BEFORE_SAVE. If this ever needs a save event to pass, the race is back.
    expect(createVirtualFile).toHaveBeenCalled();
    const [path, content] = createVirtualFile.mock.calls.at(-1) as [string, string];
    expect(path).toBe(BOOKMARKS_FILE);
    expect(JSON.parse(content).cellBookmarks).toHaveLength(1);
  });

  it("does not write back while a load is hydrating the stores", async () => {
    // loadBookmarks() clears and then re-adds every bookmark. Each of those fires a
    // change notification; persisting them would write a half-restored file over the
    // good one -- and dirty a workbook the user only opened.
    readVirtualFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        cellBookmarks: [
          { id: "a", row: 1, col: 1, sheetIndex: 0, sheetName: "Sheet1", label: "x" },
        ],
        viewBookmarks: [],
      })
    );
    stop = startBookmarkWriteThrough();
    createVirtualFile.mockClear();

    await loadBookmarks();
    await flushBookmarkWrites();

    expect(createVirtualFile).not.toHaveBeenCalled();
  });

  it("coalesces a burst but still ends with the FINAL state on disk", async () => {
    stop = startBookmarkWriteThrough();
    createVirtualFile.mockClear();

    addBookmark(1, 1, 0, "Sheet1", { label: "one" });
    addBookmark(2, 2, 0, "Sheet1", { label: "two" });
    addBookmark(3, 3, 0, "Sheet1", { label: "three" });
    await flushBookmarkWrites();

    // Coalescing is allowed; going stale is not. Whatever the write count, the LAST
    // write must describe all three bookmarks.
    const [, content] = createVirtualFile.mock.calls.at(-1) as [string, string];
    expect(JSON.parse(content).cellBookmarks).toHaveLength(3);
  });

  it("stops writing once the subscription is torn down", async () => {
    stop = startBookmarkWriteThrough();
    stop();
    stop = null;
    createVirtualFile.mockClear();

    addBookmark(9, 9, 0, "Sheet1", { label: "after cleanup" });
    await flushBookmarkWrites();

    expect(createVirtualFile).not.toHaveBeenCalled();
  });
});
