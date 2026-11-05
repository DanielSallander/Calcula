//! FILENAME: app/src/api/scriptHost/__tests__/wholeLineFormatScript.test.ts
// PURPOSE: A script formats and clears WHOLE rows, WHOLE columns and the whole
//          sheet in one call, as VBA does (BUG-0616 #1).
// CONTEXT: VBA's `Columns("C").ClearFormats`, `Columns("C").ClearContents`,
//          `Rows(5).Font.Bold = True` and `Cells.ClearFormats` act on whole
//          lines. The script API refused every format / clear rectangle over
//          100,000 cells -- the bound of a READ's answer and a value write --
//          so a whole column (1,048,576 cells) was out of reach, and a recorded
//          whole-column Bold could not replay. The backend has formatted whole
//          lines as row / column formats since BUG-0354 (`plan_range_style`,
//          `CellRect::line_extent`) and clears them the same way, so these rows
//          now take the backend's bound: whole / almost-whole lines at any
//          size, anything else up to its 4,000,000-cell walk.
// COVERS:  the validators and the broker's policy decision (the real
//          ALLOWLIST rows), the REAL host executors over the REAL wrappers
//          (only Tauri's `invoke` is doubled: what crosses the bridge is a
//          rectangle, never a million coordinates). The recorded whole-column
//          Bold's replay is pinned in the MacroRecorder's
//          clearRangeBoundedReplay.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("../../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "apply_formatting") return Promise.resolve({ cells: [], styles: [] });
    if (cmd === "clear_range_with_options") return Promise.resolve({ count: 3, updatedCells: [] });
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
import { applyRangeFormat, executeClearRange } from "../host";
import {
  MAX_FORMAT_RECT_CELLS,
  MAX_RESTRICTED_FORMAT_RECT_CELLS,
  vFormatRangeRefRestricted,
  isFormatLineRect,
  vClearRange,
  vFormatRangeRef,
  vRangeFormat,
  vRangeFormatUnlocked,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { decidePolicy } from "../brokerPolicy";

const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

function makeLib() {
  return {
    applyFormatting: wrappers.applyFormatting,
    applyBorderPreset: wrappers.applyBorderPreset,
    applyFormattingToSheets: wrappers.applyFormattingToSheets,
    clearRangeWithOptions: wrappers.clearRangeWithOptions,
    getActiveSheet: async () => 0,
    getSheets: async () => ({ sheets: [{ name: "Sheet1" }, { name: "Sheet2" }], activeIndex: 0 }),
    getSheetNames: async () => ["Sheet1", "Sheet2"],
    getUndoState: async () => ({ transactionOpen: false }),
    beginUndoTransaction: async () => true,
    commitUndoTransaction: async () => undefined,
    cancelUndoTransaction: async () => undefined,
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

const UNLOCKED = {
  tier: "unlocked" as const,
  grants: new Set<never>(),
  declaredCapabilities: new Set<never>(),
};
const RESTRICTED = { ...UNLOCKED, tier: "restricted" as const };

beforeEach(() => {
  calls.length = 0;
});

describe("the format / clear rectangle bound (BUG-0616 #1)", () => {
  const WHOLE: Array<[string, [number, number, number, number]]> = [
    ["Columns(\"C\")", [0, 2, LAST_ROW, 2]],
    ["Rows(5)", [4, 0, 4, LAST_COL]],
    ["Cells (Select All)", [0, 0, LAST_ROW, LAST_COL]],
    ["Columns(\"A:D\") less row 1 (almost whole, 4,194,300 cells)", [1, 0, LAST_ROW, 3]],
  ];

  // SABOTAGE: make vFormatRangeRef refuse above MAX_RANGE_CELLS like vRangeRef
  // -> every whole line is "range too large" again.
  it("accepts whole rows, whole columns, Select All and almost-whole lines", () => {
    for (const [what, [r0, c0, r1, c1]] of WHOLE) {
      expect(isFormatLineRect(r0, c0, r1, c1), what).toBe(true);
      expect(vFormatRangeRef([r0, c0, r1, c1]), what).toBe(true);
      expect(vRangeFormat([r0, c0, r1, c1, { bold: true }]), what).toBe(true);
      expect(vRangeFormatUnlocked([r0, c0, r1, c1, { bold: true }, 1]), what).toBe(true);
      expect(vClearRange([r0, c0, r1, c1, { applyTo: "formats" }]), what).toBe(true);
    }
  });

  it("bounds a rectangle that is NOT whole lines at the backend's 4,000,000-cell walk", () => {
    expect(MAX_FORMAT_RECT_CELLS).toBe(4_000_000);
    expect(isFormatLineRect(0, 0, 1999, 1999)).toBe(false);
    expect(vFormatRangeRef([0, 0, 1999, 1999])).toBe(true); // exactly 4,000,000
    expect(vFormatRangeRef([0, 0, 2000, 1999])).toContain("range too large");
    expect(vClearRange([0, 0, 999_999, 9])).toContain("range too large");
    // 300,000 rows of A:P are short of their columns by far more than the
    // 65,536 exceptions an almost-whole rectangle may leave out.
    expect(isFormatLineRect(100, 0, 300_000, 15)).toBe(false);
  });

  it("the policy rows use the line-aware bound; the READ rows keep 100,000", () => {
    for (const m of ["api.setRangeFormat", "api.clearRangeFormat", "api.clearRange"]) {
      expect(ALLOWLIST[m].limits?.maxCells, m).toBe(MAX_FORMAT_RECT_CELLS);
    }
    // The RESTRICTED rows keep whole lines at any size but bound every other
    // rectangle at 100,000 (BUG-0659, changed deliberately from 4,000,000:
    // explicitRunGrant.test.ts pins the bound and its reason).
    for (const m of ["sheet.setRangeFormat", "sheet.clearRangeFormat"]) {
      expect(ALLOWLIST[m].limits?.maxCells, m).toBe(MAX_RESTRICTED_FORMAT_RECT_CELLS);
    }
    expect(ALLOWLIST["api.clearRangeFormat"].validate).toBe(vFormatRangeRef);
    expect(ALLOWLIST["sheet.clearRangeFormat"].validate).toBe(vFormatRangeRefRestricted);
    // A read answers cell by cell, so a whole column stays out of reach there.
    expect(decidePolicy(UNLOCKED, "api.getRangeFormat", [0, 2, LAST_ROW, 2]).admitted).toBe(false);
  });

  it("the broker admits a whole-column format and clear (the tier rules are unchanged)", () => {
    expect(decidePolicy(UNLOCKED, "api.setRangeFormat", [0, 2, LAST_ROW, 2, { bold: true }]).admitted).toBe(true);
    expect(decidePolicy(UNLOCKED, "api.clearRangeFormat", [0, 2, LAST_ROW, 2]).admitted).toBe(true);
    expect(decidePolicy(UNLOCKED, "api.clearRange", [0, 2, LAST_ROW, 2, { applyTo: "contents" }]).admitted).toBe(true);
    expect(decidePolicy(RESTRICTED, "sheet.setRangeFormat", [4, 0, 4, LAST_COL, { bold: true }]).admitted).toBe(true);
    expect(decidePolicy(RESTRICTED, "api.clearRange", [0, 2, LAST_ROW, 2]).admitted).toBe(false);
  });
});

describe("the host sends a whole line as its rectangle", () => {
  // SABOTAGE: restore assertRangeSize (100,000) in applyRangeFormat -> the
  // executor throws "range too large" before anything is sent.
  it("Columns(\"C\").Font.Bold = True: ONE apply_formatting, the rows as a run", async () => {
    await applyRangeFormat(asLib(makeLib()), undefined, 0, 2, LAST_ROW, 2, { bold: true });
    const sent = calls.filter((c) => c.cmd === "apply_formatting");
    expect(sent).toHaveLength(1);
    const params = sent[0].args?.params as { rows: unknown; cols: unknown; bold: boolean };
    expect(params.rows).toEqual({ first: 0, last: LAST_ROW });
    expect(params.cols).toEqual([2]);
    expect(params.bold).toBe(true);
  });

  it("Cells.Font.Italic = True (Select All): ONE apply_formatting, both axes as runs", async () => {
    await applyRangeFormat(asLib(makeLib()), undefined, 0, 0, LAST_ROW, LAST_COL, { italic: true });
    const sent = calls.filter((c) => c.cmd === "apply_formatting");
    expect(sent).toHaveLength(1);
    const params = sent[0].args?.params as { rows: unknown; cols: unknown };
    expect(params.rows).toEqual({ first: 0, last: LAST_ROW });
    expect(params.cols).toEqual({ first: 0, last: LAST_COL });
  });

  // SABOTAGE: drop assertFormatRangeSize from applyRangeFormat -> a
  // 10-million-cell rectangle reaches the backend.
  it("a huge rectangle that is not whole lines is refused before anything is sent", async () => {
    await expect(
      applyRangeFormat(asLib(makeLib()), undefined, 0, 0, 999_999, 9, { bold: true }),
    ).rejects.toThrow(/range too large/);
    expect(calls).toEqual([]);
  });

  it("Columns(\"C\").ClearContents: ONE clear_range_with_options over the column", async () => {
    const result = await executeClearRange(asLib(makeLib()), "s1", 0, 2, LAST_ROW, 2, { applyTo: "contents" });
    expect(result).toEqual({ count: 3 });
    const sent = calls.filter((c) => c.cmd === "clear_range_with_options");
    expect(sent).toHaveLength(1);
    expect(sent[0].args?.params).toMatchObject({ startRow: 0, startCol: 2, endRow: LAST_ROW, endCol: 2, applyTo: "contents" });
  });
});
