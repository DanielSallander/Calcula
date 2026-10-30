//! FILENAME: app/src/core/lib/__tests__/formatWrappersHomeTab.test.ts
// PURPOSE: The formatting doors the Home tab uses, at the bridge: what reaches
//          the backend, what the macro recorder hears, and what grouped sheets
//          receive.
// CONTEXT: - GROUPED SHEETS ARE ONE COMMAND (review finding, 2026-10-04). The
//            wrappers used to format the active sheet, then repeat the change
//            on the group with a second command (*_to_sheets). A protected
//            grouped sheet refused only that second call -- after the active
//            sheet was already formatted, with the refusal sent to the console
//            -- and a successful group took one Ctrl+Z per sheet plus one. Now
//            applyFormatting, applyBorderPreset and adjustNumberFormatDecimals
//            send the group as `sheetIndices` to their ONE backend command,
//            which gates every sheet first and writes them as one undo step.
//          - adjustNumberFormatDecimals: the backend decides the new format;
//            this wrapper announces the styles and records the RESULTING number
//            format (which replays through applyFormatting). A Select All writes
//            column TIERS and no cell, so the record follows the returned
//            styles, not the returned cells.
//          - ONLY THE GROUP THE SHEET ON SCREEN BELONGS TO (review G#4): a group
//            left behind by a Name Box / Go To / link switch to a sheet outside
//            it (Excel ungroups there) is never sent.
//          Only Tauri's `invoke` and the grid's sheet context (the sheet on
//          screen) are doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
let nextResult: unknown = null;
let refuse: string | null = null;

/** The sheet on screen (Core's sheet context); null = not known. */
const grid = vi.hoisted(() => ({ activeSheetIndex: 0 as number | null }));
vi.mock("../../state/GridContext", () => ({
  getGridStateSnapshot: () =>
    grid.activeSheetIndex === null ? null : { sheetContext: { activeSheetIndex: grid.activeSheetIndex } },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (refuse !== null) return Promise.reject(new Error(refuse));
    if (
      cmd === "apply_border_preset" ||
      cmd === "adjust_number_format_decimals" ||
      cmd === "apply_formatting"
    ) {
      return Promise.resolve(nextResult);
    }
    if (cmd === "sheet_is_blank") return Promise.resolve(true);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  applyBorderPreset,
  applyFormatting,
  adjustNumberFormatDecimals,
  isSheetBlank,
  setGridRecorderHook,
  type RecordedGridEvent,
} from "../tauri-api";
import { setSelectedSheetIndices, clearSheetGrouping } from "../../state/sheetGrouping";
import { DEFAULT_STYLE } from "../../types";

const recorded: RecordedGridEvent[] = [];

beforeEach(() => {
  calls.length = 0;
  recorded.length = 0;
  refuse = null;
  nextResult = { cells: [], styles: [] };
  grid.activeSheetIndex = 0;
  clearSheetGrouping();
  setGridRecorderHook((event) => recorded.push(event));
});

afterEach(() => {
  setGridRecorderHook(null);
  clearSheetGrouping();
});

function cell(row: number, col: number, styleIndex: number) {
  return { row, col, display: "", formula: null, styleIndex };
}

describe("applyBorderPreset sends a grouped preset as ONE command", () => {
  it("passes the group to apply_border_preset and calls nothing else", async () => {
    setSelectedSheetIndices([0, 2]);
    await applyBorderPreset(1, 2, 3, 4, "outside", "solid", "#112233", 3);
    expect(calls.map((c) => c.cmd)).toEqual(["apply_border_preset"]);
    expect(calls[0].args).toEqual({
      startRow: 1,
      startCol: 2,
      endRow: 3,
      endCol: 4,
      preset: "outside",
      style: "solid",
      color: "#112233",
      width: 3,
      sheetIndices: [0, 2],
    });
  });

  it("names no group when nothing is grouped", async () => {
    await applyBorderPreset(0, 0, 0, 0, "allBorders", "solid", "#000000", 1);
    expect(calls.map((c) => c.cmd)).toEqual(["apply_border_preset"]);
    expect(calls[0].args).not.toHaveProperty("sheetIndices");
  });

  it("REJECTS when the group is refused -- nothing is half-applied or swallowed", async () => {
    setSelectedSheetIndices([0, 1]);
    refuse = "Cannot apply borders on a protected sheet.";
    await expect(applyBorderPreset(0, 0, 1, 1, "outside", "solid", "#000000", 1)).rejects.toThrow(
      "protected sheet",
    );
    expect(calls.map((c) => c.cmd)).toEqual(["apply_border_preset"]);
    expect(recorded).toEqual([]);
  });
});

describe("applyFormatting sends a grouped format as ONE command", () => {
  it("passes the group beside the params", async () => {
    setSelectedSheetIndices([0, 1, 3]);
    await applyFormatting([0], [0], { bold: true });
    expect(calls.map((c) => c.cmd)).toEqual(["apply_formatting"]);
    expect(calls[0].args?.sheetIndices).toEqual([0, 1, 3]);
    expect((calls[0].args?.params as Record<string, unknown>).bold).toBe(true);
  });

  it("sends only the params when nothing is grouped", async () => {
    await applyFormatting([0], [0], { italic: true });
    expect(calls[0].args).not.toHaveProperty("sheetIndices");
  });
});

describe("adjustNumberFormatDecimals", () => {
  it("sends rows, cols and delta, active cell first, to the backend command", async () => {
    await adjustNumberFormatDecimals([4, 3, 5], [2], 1);
    expect(calls[0]).toEqual({
      cmd: "adjust_number_format_decimals",
      args: { rows: [4, 3, 5], cols: [2], delta: 1 },
    });
  });

  it("records the RESULTING number format so a macro replays it through applyFormatting", async () => {
    nextResult = {
      cells: [cell(0, 0, 7), cell(1, 0, 7)],
      styles: [{ index: 7, style: { ...DEFAULT_STYLE, numberFormat: "Percentage (1 decimals)" } }],
    };
    await adjustNumberFormatDecimals([0, 1], [0], 1);
    expect(recorded).toEqual([
      {
        kind: "formatting",
        rows: [0, 1],
        cols: [0],
        formatting: { numberFormat: "Percentage (1 decimals)" },
      },
    ]);
  });

  it("records a Select All step that wrote column tiers and no cell", async () => {
    nextResult = {
      cells: [],
      styles: [{ index: 12, style: { ...DEFAULT_STYLE, numberFormat: "Number (2 decimals)" } }],
    };
    await adjustNumberFormatDecimals([0, 1, 2], [0, 1], 1);
    expect(recorded).toEqual([
      { kind: "formatting", rows: [0, 1, 2], cols: [0, 1], formatting: { numberFormat: "Number (2 decimals)" } },
    ]);
  });

  it("sends the group to the ONE command instead of repeating it afterwards", async () => {
    setSelectedSheetIndices([0, 1]);
    nextResult = {
      cells: [cell(0, 0, 9)],
      styles: [{ index: 9, style: { ...DEFAULT_STYLE, numberFormat: "Number (3 decimals)" } }],
    };
    await adjustNumberFormatDecimals([0], [0], -1);
    expect(calls.map((c) => c.cmd)).toEqual(["adjust_number_format_decimals"]);
    expect(calls[0].args).toEqual({ rows: [0], cols: [0], delta: -1, sheetIndices: [0, 1] });
  });

  it("records nothing when Excel would change nothing", async () => {
    setSelectedSheetIndices([0, 1]);
    await adjustNumberFormatDecimals([0], [0], 1);
    expect(recorded).toEqual([]);
    expect(calls.map((c) => c.cmd)).toEqual(["adjust_number_format_decimals"]);
  });
});

// review G#4: the group is ended only by a plain tab click, so a switch by the
// Name Box / Go To / a link / the command line to a sheet OUTSIDE the group
// left it selected, and every formatting wrapper sent it anyway -- the backend
// formats the active sheet plus every listed sheet, so a Bold on Sheet2 also
// bolded the old group's Sheet1 and Sheet3, off screen. Excel [LIVE, Excel 16:
// Sheet1+Sheet3 grouped, Application.Goto Sheet2!A1, ExecuteMso "Bold"] bolds
// Sheet2!A1 only.
// SABOTAGE: make groupArgs (core/lib/tauri-api.ts) send the selected group
// whatever the sheet on screen -> the three "outside the group" cases send
// sheetIndices [0, 2].
describe("a group the sheet on screen is NOT in is never sent (review G#4)", () => {
  beforeEach(() => {
    setSelectedSheetIndices([0, 2]);
    grid.activeSheetIndex = 1;
  });

  it("applyFormatting: the Bold reaches the sheet on screen alone", async () => {
    await applyFormatting([0], [0], { bold: true });
    expect(calls.map((c) => c.cmd)).toEqual(["apply_formatting"]);
    expect(calls[0].args, "the old group's sheets must not be formatted off screen").not.toHaveProperty("sheetIndices");
  });

  it("applyBorderPreset: the preset reaches the sheet on screen alone", async () => {
    await applyBorderPreset(1, 2, 3, 4, "outside", "solid", "#112233", 3);
    expect(calls[0].args).not.toHaveProperty("sheetIndices");
  });

  it("adjustNumberFormatDecimals: the step reaches the sheet on screen alone", async () => {
    await adjustNumberFormatDecimals([0], [0], 1);
    expect(calls[0].args).not.toHaveProperty("sheetIndices");
  });

  it("back on a sheet of the group, the group is sent again (Excel keeps a group across a switch to a member)", async () => {
    grid.activeSheetIndex = 2;
    await applyFormatting([0], [0], { italic: true });
    expect(calls[0].args?.sheetIndices).toEqual([0, 2]);
  });

  it("the sheet on screen not known: no group (nothing could tell it from the others)", async () => {
    grid.activeSheetIndex = null;
    await applyFormatting([0], [0], { italic: true });
    expect(calls[0].args).not.toHaveProperty("sheetIndices");
  });
});

describe("isSheetBlank", () => {
  it("asks the backend about EVERY sheet-keyed store of one sheet", async () => {
    await expect(isSheetBlank(2)).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: "sheet_is_blank", args: { sheetIndex: 2 } }]);
  });
});
