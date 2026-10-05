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
//          Only Tauri's `invoke` is doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
let nextResult: unknown = null;
let refuse: string | null = null;

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

describe("isSheetBlank", () => {
  it("asks the backend about EVERY sheet-keyed store of one sheet", async () => {
    await expect(isSheetBlank(2)).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: "sheet_is_blank", args: { sheetIndex: 2 } }]);
  });
});
