//! FILENAME: app/src/core/lib/__tests__/lineEditDimensionRefresh.test.ts
// PURPOSE: BUG-0360 -- a row / column insert or delete made OUTSIDE Core's own
//          gesture (a script's table.insertRow, Insert Copied Cells' whole
//          rows, an extension or CLI call) kept painting the OLD row heights
//          and column widths on the shifted lines until the next sheet switch,
//          because only the gesture re-read the grid's dimensions. The four
//          line wrappers now ask for the re-read themselves.
// CONTEXT: Only Tauri's `invoke` is doubled; the wrappers under test are real.
//          An OFF-sheet edit and an object's (floating grid's) lines change no
//          dimension of the sheet on screen, so they ask for nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_active_sheet") return Promise.resolve(0);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { insertRows, deleteRows, insertColumns, deleteColumns } from "../tauri-api";

const asked: string[] = [];
const onRefresh = (e: Event): void => {
  asked.push(e.type);
};

beforeEach(() => {
  asked.length = 0;
  window.addEventListener("dimensions:refresh", onRefresh);
});
afterEach(() => {
  window.removeEventListener("dimensions:refresh", onRefresh);
});

describe("BUG-0360: every row / column insert or delete on the sheet on screen re-reads the dimensions", () => {
  // SABOTAGE: delete the refreshDimensionsAfterLineEdit() line in insertRows
  // (tauri-api.ts) -> the first assertion reads [] and this goes red.
  it("insertRows / deleteRows / insertColumns / deleteColumns each ask once, whoever calls them", async () => {
    await insertRows(1, 3);
    expect(asked, "insertRows").toEqual(["dimensions:refresh"]);
    await deleteRows(1, 3);
    await insertColumns(2, 1);
    await deleteColumns(2, 1);
    expect(asked).toEqual(["dimensions:refresh", "dimensions:refresh", "dimensions:refresh", "dimensions:refresh"]);
  });

  it("an edit on ANOTHER sheet, or on a floating grid's lines, asks for nothing on screen", async () => {
    await insertRows(1, 3, 1);
    await deleteColumns(0, 1, 2);
    await insertRows(0, 1, undefined, { target: { kind: "floatingGrid", id: "fg-1" } as never });
    expect(asked).toEqual([]);
  });
});
