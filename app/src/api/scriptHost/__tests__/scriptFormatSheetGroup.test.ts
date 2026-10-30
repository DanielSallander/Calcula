//! FILENAME: app/src/api/scriptHost/__tests__/scriptFormatSheetGroup.test.ts
// PURPOSE: A script's format lands on the sheet it names, NEVER on the user's
//          sheet group (review NEW-script-format-follows-ui-group).
// CONTEXT: The script executors called the formatting wrappers the ribbon
//          calls, and those add the group the sheet on screen belongs to
//          (`groupArgs`, core/lib/tauri-api.ts). So a macro or a button that
//          formatted one cell while the user happened to have sheets grouped
//          formatted every grouped sheet too, off screen -- and a recorded
//          grouped Bold, replayed while sheets were grouped, reached the
//          CURRENT group as well. Excel's object model formats the range's
//          own sheet [LIVE, Excel 16: Sheet1+Sheet3 grouped,
//          `ActiveSheet.Range("D4").Font.Bold = True` bolds Sheet1 only, while
//          `Selection.Font.Italic` -- the user's selection -- reaches both].
// COVERS:  the REAL executors (applyRangeFormat: base keys and range-edge
//          borders; executeCreateNamedStyle's scratch format) over the REAL
//          wrappers (applyFormatting / applyBorderPreset), with a real group in
//          core/state/sheetGrouping and the sheet on screen a member of it.
//          Only Tauri's `invoke`, the grid's sheet context and the host's
//          non-formatting reads are doubled. A control proves the same harness
//          DOES send the group for a ribbon-style call.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("../../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "apply_formatting" || cmd === "apply_border_preset" || cmd === "adjust_number_format_decimals") {
      return Promise.resolve({ cells: [{ row: 11, col: 6, styleIndex: 42, display: "" }], styles: [] });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

import * as wrappers from "../../../core/lib/tauri-api";
import { clearSheetGrouping, setSelectedSheetIndices } from "../../../core/state/sheetGrouping";
import { applyRangeFormat, executeCreateNamedStyle } from "../host";

/**
 * The host's `lib`: the REAL formatting wrappers, everything else a plain
 * answer (the active sheet is 0, the sheet on screen; nothing is open).
 */
function makeLib() {
  return {
    applyFormatting: wrappers.applyFormatting,
    applyBorderPreset: wrappers.applyBorderPreset,
    applyFormattingToSheets: wrappers.applyFormattingToSheets,
    getActiveSheet: async () => 0,
    getUndoState: async () => ({ transactionOpen: false }),
    beginUndoTransaction: async () => true,
    commitUndoTransaction: async () => undefined,
    cancelUndoTransaction: async () => undefined,
    getNamedStyles: async () => [],
    getUsedRange: async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false }),
    getViewportCells: async () => [],
    createNamedStyle: async (name: string, styleIndex: number, category: string) => ({
      name,
      builtIn: false,
      styleIndex,
      category,
    }),
    clearRangeWithOptions: async () => ({ count: 1 }),
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

const formattingCalls = () => calls.filter((c) => c.cmd === "apply_formatting" || c.cmd === "apply_border_preset");

beforeEach(() => {
  calls.length = 0;
  // Sheet1 + Sheet3 grouped by the USER, Sheet1 on screen.
  setSelectedSheetIndices([0, 2]);
});

afterEach(() => {
  clearSheetGrouping();
});

describe("a script formats its own sheet, never the user's group", () => {
  it("control: the same harness sends the group for a ribbon-style call (the group is live)", async () => {
    await wrappers.applyFormatting([0], [0], { bold: true });
    expect(calls[0].args?.sheetIndices).toEqual([0, 2]);
  });

  // SABOTAGE: drop SCRIPT_FORMAT_PLACEMENT from applyRangeFormat's
  // applyFormatting call -> the group rides along.
  it("api.setRangeFormat (bold on D4): apply_formatting names no group", async () => {
    await applyRangeFormat(asLib(makeLib()), undefined, 3, 3, 3, 3, { bold: true });
    const sent = formattingCalls();
    expect(sent.map((c) => c.cmd)).toEqual(["apply_formatting"]);
    expect(sent[0].args, "a script's Bold reached the user's grouped sheets").not.toHaveProperty("sheetIndices");
  });

  // SABOTAGE: drop SCRIPT_FORMAT_PLACEMENT from the applyBorderPreset call.
  it("range-edge borders (borderOutline): apply_border_preset names no group either", async () => {
    await applyRangeFormat(asLib(makeLib()), undefined, 0, 0, 2, 2, {
      bold: true,
      borderOutline: { style: "thin", color: "#000000" },
    });
    const sent = formattingCalls();
    expect(sent.map((c) => c.cmd)).toEqual(["apply_formatting", "apply_border_preset"]);
    for (const call of sent) {
      expect(call.args, `${call.cmd} reached the user's grouped sheets`).not.toHaveProperty("sheetIndices");
    }
  });

  it("api.createNamedStyle: the scratch format lands on the active sheet's scratch cell alone", async () => {
    await executeCreateNamedStyle(asLib(makeLib()), "Alert", { bold: true });
    const sent = formattingCalls();
    expect(sent.map((c) => c.cmd)).toEqual(["apply_formatting"]);
    expect(sent[0].args, "the scratch format reached the grouped sheets, and only this one is reverted").not.toHaveProperty(
      "sheetIndices",
    );
  });

  // SABOTAGE: make placementArgs ignore `activeSheetOnly`.
  it("the wrapper option itself: activeSheetOnly drops the group, and records the gesture as the active sheet's", async () => {
    const recorded: wrappers.RecordedGridEvent[] = [];
    wrappers.setGridRecorderHook((event) => recorded.push(event));
    try {
      await wrappers.applyFormatting([0], [0], { italic: true }, { activeSheetOnly: true });
      await wrappers.applyBorderPreset(0, 0, 0, 0, "outside", "solid", "#000000", 1, { activeSheetOnly: true });
      await wrappers.adjustNumberFormatDecimals([0], [0], 1, { activeSheetOnly: true });
    } finally {
      wrappers.setGridRecorderHook(null);
    }
    for (const call of calls) {
      expect(call.args, call.cmd).not.toHaveProperty("sheetIndices");
    }
    for (const event of recorded) {
      expect(event, event.kind).not.toHaveProperty("sheetIndices");
    }
  });
});
