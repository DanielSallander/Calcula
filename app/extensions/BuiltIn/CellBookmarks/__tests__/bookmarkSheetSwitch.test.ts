//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkSheetSwitch.test.ts
// PURPOSE: A bookmark on another sheet (and a view bookmark that restores the
//          active sheet) switches through `activateSheet` and WAITS for it
//          before selecting the cell or restoring anything else.
// CONTEXT: Both used to fire setActiveSheetApi + dispatch + SHEET_CHANGED
//          without awaiting the backend. SheetTabs' re-read on SHEET_CHANGED
//          could be answered before the switch landed and dispatched the old
//          sheet back, so a Next Bookmark from a canvas left the grid on the
//          canvas (found live 2026-09-29, e2e fixall-edit X16).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  release: (() => {}) as () => void,
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" },
    zoom: 1,
    dimensions: { manuallyHiddenRows: new Set(), manuallyHiddenCols: new Set() },
  }),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  activateSheet: (index: number) => {
    h.calls.push(`switch:${index}`);
    return new Promise((resolve) => {
      h.release = () => {
        h.calls.push("switch:landed");
        resolve({ activeIndex: index, sheets: [] });
      };
    });
  },
  dispatchGridAction: (action: { type: string }) => {
    h.calls.push(`dispatch:${action.type}`);
  },
}));

import { navigateToBookmark } from "../lib/bookmarkNavigation";
import { restoreState } from "../lib/viewBookmarkStore";
import type { Bookmark } from "../lib/bookmarkTypes";

const bookmark = {
  id: "b1",
  row: 4,
  col: 1,
  sheetIndex: 0,
  sheetName: "Sheet1",
  label: "",
  color: "blue",
  createdAt: 0,
} as unknown as Bookmark;

beforeEach(() => {
  h.calls.length = 0;
});

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("bookmark navigation across sheets", () => {
  it("selects the bookmarked cell only after the sheet switch has landed", async () => {
    const pending = navigateToBookmark(bookmark);
    await drain();
    expect(h.calls).toEqual(["switch:0"]);

    h.release();
    await pending;
    expect(h.calls[0]).toBe("switch:0");
    expect(h.calls[1]).toBe("switch:landed");
    expect(h.calls.slice(2).length).toBeGreaterThan(0);
    expect(h.calls.slice(2).every((c) => c.startsWith("dispatch:"))).toBe(true);
  });

  it("a view bookmark restores zoom only after the sheet switch has landed", async () => {
    const pending = restoreState(
      { activeSheet: { index: 0, name: "Sheet1" }, zoom: 1.5 },
      { activeSheet: true, zoom: true } as never,
    );
    await drain();
    expect(h.calls).toEqual(["switch:0"]);

    h.release();
    await pending;
    expect(h.calls[1]).toBe("switch:landed");
    expect(h.calls.slice(2).some((c) => c.startsWith("dispatch:"))).toBe(true);
  });
});
