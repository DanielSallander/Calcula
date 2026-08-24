//! FILENAME: app/extensions/GoToSpecial/__tests__/lastCellCriteria.test.ts
// PURPOSE: Go To Special's "Last cell" must answer from get_used_range — the
//          same command Ctrl+End asks — and never from a scan of its own.
// CONTEXT: The criteria existed at no layer at all: not in GoToSpecialCriteria,
//          not in this dialog, while Ctrl+End claimed to go to "the end" and
//          went to XFD1048576 instead. The temptation when adding it is a second
//          implementation (a backend kind, a widest-cell scan); the whole point
//          is that there is ONE answer to "where does the data end", so these
//          tests assert the command that gets invoked, not just the coordinates.
//
//          It lives in the extension's __tests__ because the extension is what
//          offers the criteria to the user; the resolution happens one layer
//          down in @api/grid, which is what makes the two gestures agree.

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every backend call the code under test made, in order. */
let invoked: Array<{ command: string; args: unknown }> = [];
/** What get_used_range answers. */
let usedRange = { startRow: 2, startCol: 1, endRow: 9, endCol: 4, empty: false };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === "get_used_range") return usedRange;
    if (command === "go_to_special") return { cells: [{ row: 0, col: 0 }] };
    throw new Error(`unexpected backend command: ${command}`);
  }),
}));

import { goToSpecial } from "@api/grid";

describe("Go To Special: Last cell", () => {
  beforeEach(() => {
    invoked = [];
    usedRange = { startRow: 2, startCol: 1, endRow: 9, endCol: 4, empty: false };
  });

  it("answers the lower-right corner of the used range", async () => {
    const result = await goToSpecial("lastCell");

    expect(result.cells).toEqual([{ row: 9, col: 4 }]);
  });

  it("asks get_used_range and never the go_to_special scan", async () => {
    await goToSpecial("lastCell");

    expect(invoked.map((call) => call.command)).toEqual(["get_used_range"]);
  });

  it("ignores the search range, because the last cell belongs to the sheet", async () => {
    await goToSpecial("lastCell", { startRow: 0, startCol: 0, endRow: 3, endCol: 3 });

    expect(invoked).toEqual([{ command: "get_used_range", args: { sheetIndex: undefined } }]);
  });

  it("answers A1 on an empty sheet", async () => {
    usedRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };

    const result = await goToSpecial("lastCell");

    expect(result.cells).toEqual([{ row: 0, col: 0 }]);
  });

  // Positive control: intercepting one criteria must not swallow the others.
  it("leaves every other criteria on the backend scan", async () => {
    await goToSpecial("blanks", { startRow: 0, startCol: 0, endRow: 3, endCol: 3 });

    expect(invoked).toEqual([
      {
        command: "go_to_special",
        args: { criteria: "blanks", searchRange: [0, 0, 3, 3] },
      },
    ]);
  });
});
