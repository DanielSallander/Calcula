//! FILENAME: app/src/core/lib/__tests__/lineSizeWrappers.test.ts
// PURPOSE: setRowHeights / setColumnWidths (the batch Row Height / Column Width
//          wrappers) and getHyperlinksInRange at the bridge: what reaches the
//          backend, and what the macro recorder sees.
// CONTEXT: Home tab 2026-10-04 (rust-followup lane). The batch takes the span
//          as inclusive RUNS -- Select All is `[[0, 16383]]`, not 16,384
//          indices -- merged and ordered before they are sent. The macro
//          recorder sees ONE `rowHeights` / `columnWidths` event per call with
//          the runs as sent (its codegen replays api.setRowHeights /
//          setColumnWidths), and only for a call the backend accepted. Only Tauri's `invoke` is
//          doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
let hyperlinkReply: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  setRowHeights,
  setColumnWidths,
  getHyperlinksInRange,
  setGridRecorderHook,
  type RecordedGridEvent,
} from "../tauri-api";

const recorded: RecordedGridEvent[] = [];

function calls(): Array<[string, unknown]> {
  return invoke.mock.calls.map(([cmd, args]) => [cmd as string, args]);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "get_hyperlinks_in_range" ? hyperlinkReply : null));
  recorded.length = 0;
  hyperlinkReply = [];
});
afterEach(() => setGridRecorderHook(null));

describe("setRowHeights / setColumnWidths", () => {
  it("send ONE call with the runs merged, ordered and first <= last", async () => {
    await setRowHeights([[9, 7], [0, 1], [2, 3], [20, 20]], 30);
    await setColumnWidths([[0, 16_383]], 90);
    expect(calls()).toEqual([
      [
        "set_row_heights",
        {
          rows: [
            [0, 3],
            [7, 9],
            [20, 20],
          ],
          height: 30,
        },
      ],
      ["set_column_widths", { cols: [[0, 16_383]], width: 90 }],
    ]);
  });

  // NEW-recorder-select-all (round 15): ONE event per call, the runs AS SENT
  // (Excel records Rows("5:6").RowHeight = 32, never row by row). It used to
  // be one rowHeight event per line: 1,048,576 for Select All.
  it("the macro recorder sees ONE event per call, with the runs as sent", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    await setRowHeights([[5, 4], [9, 9]], 32);
    await setColumnWidths([[2, 2]], 75);
    expect(recorded).toEqual([
      { kind: "rowHeights", runs: [[4, 5], [9, 9]], height: 32 },
      { kind: "columnWidths", runs: [[2, 2]], width: 75 },
    ]);
  });

  it("Select All records ONE event, not a million", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    await setRowHeights([[0, 1_048_575]], 40);
    expect(recorded).toEqual([{ kind: "rowHeights", runs: [[0, 1_048_575]], height: 40 }]);
  });

  // Under filter mode the backend replies with the runs the size REACHED (it
  // passes over the hidden rows of runs that hold a visible one). The replay is
  // run-based now -- api.setRowHeights reaches the same command and applies
  // the same rule -- so the recorder keeps the runs the user SENT (Excel's
  // recorder writes the selection), and a Select All under a filter replays as
  // a Select All (the sheet's standard), not as explicit heights.
  it("records the runs as sent, whatever the backend says the size reached", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    invoke.mockImplementationOnce(async () => [
      [4, 4],
      [6, 7],
    ]);
    await setRowHeights([[4, 7]], 30);
    expect(recorded).toEqual([{ kind: "rowHeights", runs: [[4, 7]], height: 30 }]);
  });

  it("with the recorder uninstalled, nothing is recorded", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    setGridRecorderHook(null);
    await setColumnWidths([[0, 16_383]], 90);
    expect(recorded).toEqual([]);
  });

  it("a backend refusal rejects and records nothing", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    invoke.mockRejectedValueOnce("Cannot resize rows on a protected sheet.");
    await expect(setRowHeights([[0, 2]], 30)).rejects.toBe("Cannot resize rows on a protected sheet.");
    expect(recorded).toEqual([]);
  });
});

describe("getHyperlinksInRange (Core's door to the indicator query)", () => {
  it("asks for the range and returns the linked cells", async () => {
    hyperlinkReply = [{ row: 2, col: 3, linkType: "url" }];
    const linked = await getHyperlinksInRange(0, 0, 9, 9);
    expect(calls()).toEqual([["get_hyperlinks_in_range", { startRow: 0, startCol: 0, endRow: 9, endCol: 9 }]]);
    expect(linked).toEqual([{ row: 2, col: 3, linkType: "url" }]);
  });
});
