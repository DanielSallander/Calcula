//! FILENAME: app/src/core/lib/__tests__/lineSizeWrappers.test.ts
// PURPOSE: setRowHeights / setColumnWidths (the batch Row Height / Column Width
//          wrappers) and getHyperlinksInRange at the bridge: what reaches the
//          backend, and what the macro recorder sees.
// CONTEXT: Home tab 2026-10-04 (rust-followup lane). The batch takes the span
//          as inclusive RUNS -- Select All is `[[0, 16383]]`, not 16,384
//          indices -- merged and ordered before they are sent. The macro
//          recorder keeps seeing the per-line `rowHeight` / `columnWidth`
//          events the one-line wrappers report (its codegen replays them), and
//          only for a call the backend accepted. Only Tauri's `invoke` is
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

  it("the macro recorder sees the same per-line events the one-line wrappers report", async () => {
    setGridRecorderHook((e) => recorded.push(e));
    await setRowHeights([[4, 5]], 32);
    await setColumnWidths([[2, 2]], 75);
    expect(recorded).toEqual([
      { kind: "rowHeight", row: 4, height: 32 },
      { kind: "rowHeight", row: 5, height: 32 },
      { kind: "columnWidth", col: 2, width: 75 },
    ]);
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
