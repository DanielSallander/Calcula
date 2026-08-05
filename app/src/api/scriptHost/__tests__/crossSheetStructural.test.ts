//! FILENAME: app/src/api/scriptHost/__tests__/crossSheetStructural.test.ts
// PURPOSE: Wave 3 item 12 — the cross-sheet wiring of the structural / sort /
//          find / replace / clear executors. Two invariants, pinned per op:
//          (1) the sheet ref (index or NAME) resolves against the live list
//              and the RESOLVED index is what crosses to the backend wrapper;
//          (2) an off-sheet target is state-only — the canvas refresh
//              choreography (refreshGridData / refreshGridDimensions /
//              cellEvents) is skipped, because the backend returns an empty
//              repaint payload for a sheet that is not on screen.
//          Also pins that the Wave-2 clearRange active-sheet residual is GONE:
//          naming another sheet executes there instead of rejecting.

import { describe, it, expect, vi, beforeEach } from "vitest";

const gridMock = {
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
};
vi.mock("../../grid", () => gridMock);
const cellEventsMock = { emitBatch: vi.fn() };
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: cellEventsMock,
  cellToChange: vi.fn((c: unknown) => c),
}));

import {
  executeStructuralOp,
  executeMergeCells,
  executeUnmergeCells,
  executeSortRange,
  executeFindAll,
  executeReplaceAll,
  executeClearRange,
  resolveSheetWriteTarget,
  type StructuralOpName,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import { vFind, vReplace } from "../validators";

// Sheet list: active = 0 ("Main"); "Data" (1) is the off-sheet target.
const SHEETS = [
  { index: 0, name: "Main" },
  { index: 1, name: "Data" },
];

function makeLib() {
  return {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: 0 })),
    insertRows: vi.fn(async () => []),
    deleteRows: vi.fn(async () => []),
    insertColumns: vi.fn(async () => []),
    deleteColumns: vi.fn(async () => []),
    mergeCells: vi.fn(async () => ({
      success: true,
      mergedRegions: [],
      updatedCells: [{ row: 0, col: 0, sheetIndex: 1 }],
    })),
    unmergeCells: vi.fn(async () => ({ success: true, mergedRegions: [], updatedCells: [] })),
    sortRange: vi.fn(async () => ({
      success: true,
      sortedCount: 5,
      updatedCells: [],
      error: null,
    })),
    findAll: vi.fn(async () => ({ matches: [[2, 3], [7, 1]], totalCount: 2 })),
    replaceAll: vi.fn(async () => ({ updatedCells: [], replacementCount: 4 })),
    clearRangeWithOptions: vi.fn(async () => ({ count: 9, updatedCells: [] })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => {
  vi.clearAllMocks();
});

/** Flush the requestAnimationFrame/setTimeout the refresh scheduler uses. */
async function settleRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** Drain any refresh a PREVIOUS test scheduled, then forget it — so a
 *  "the canvas was not touched" assertion can only see this test's calls. */
async function drainPendingRefresh(): Promise<void> {
  await settleRefresh();
  gridMock.refreshGridData.mockClear();
  gridMock.refreshGridDimensions.mockClear();
  cellEventsMock.emitBatch.mockClear();
}

// ============================================================================
// resolveSheetWriteTarget: the one resolver every write op shares
// ============================================================================

describe("resolveSheetWriteTarget", () => {
  it("no ref = the active sheet, active path", async () => {
    const lib = makeLib();
    expect(await resolveSheetWriteTarget(asLib(lib), undefined, "op")).toEqual({
      target: undefined,
      offSheet: false,
      sheet: 0,
    });
    expect(lib.getSheets).not.toHaveBeenCalled();
  });

  it("a NAME resolves against the live list; non-active = offSheet", async () => {
    const lib = makeLib();
    expect(await resolveSheetWriteTarget(asLib(lib), "Data", "op")).toEqual({
      target: 1,
      offSheet: true,
      sheet: 1,
    });
  });

  it("naming the ACTIVE sheet is the active path (offSheet false)", async () => {
    const lib = makeLib();
    expect(await resolveSheetWriteTarget(asLib(lib), "Main", "op")).toEqual({
      target: 0,
      offSheet: false,
      sheet: 0,
    });
  });

  it("an unknown sheet rejects, listing the real ones", async () => {
    const lib = makeLib();
    await expect(resolveSheetWriteTarget(asLib(lib), "Nope", "insertRows")).rejects.toThrow(
      /no sheet named "Nope".*"Main" \(0\).*"Data" \(1\)/,
    );
  });
});

// ============================================================================
// The structural four: resolved index through, repaint only when visible
// ============================================================================

const STRUCTURAL_OPS: StructuralOpName[] = [
  "insertRows", "deleteRows", "insertColumns", "deleteColumns",
];

describe.each(STRUCTURAL_OPS)("executeStructuralOp %s", (op) => {
  it("off-sheet by NAME: resolved index crosses, canvas untouched", async () => {
    await drainPendingRefresh();
    const lib = makeLib();
    await executeStructuralOp(asLib(lib), op, 4, 2, "Data");
    expect(lib[op]).toHaveBeenCalledWith(4, 2, 1);
    expect(gridMock.refreshGridData).not.toHaveBeenCalled();
    expect(gridMock.refreshGridDimensions).not.toHaveBeenCalled();
  });

  it("active path (no ref): undefined crosses, canvas refreshed", async () => {
    const lib = makeLib();
    await executeStructuralOp(asLib(lib), op, 0, 1);
    expect(lib[op]).toHaveBeenCalledWith(0, 1, undefined);
    expect(gridMock.refreshGridData).toHaveBeenCalled();
    expect(gridMock.refreshGridDimensions).toHaveBeenCalled();
  });

  it("the pre-Wave-3 refusal is gone: naming another sheet EXECUTES", async () => {
    const lib = makeLib();
    // This exact call used to throw "can only target the active sheet".
    await expect(executeStructuralOp(asLib(lib), op, 0, 1, 1)).resolves.toBeUndefined();
    expect(lib[op]).toHaveBeenCalledWith(0, 1, 1);
  });
});

// ============================================================================
// Merge / unmerge
// ============================================================================

describe("executeMergeCells", () => {
  it("off-sheet: target index crosses; repaint skipped", async () => {
    await drainPendingRefresh();
    const lib = makeLib();
    lib.mergeCells.mockResolvedValueOnce({ success: true, mergedRegions: [], updatedCells: [] });
    await executeMergeCells(asLib(lib), "s1", 0, 0, 2, 2, "Data");
    expect(lib.mergeCells).toHaveBeenCalledWith(0, 0, 2, 2, 1);
    await settleRefresh();
    expect(gridMock.refreshGridData).not.toHaveBeenCalled();
    expect(cellEventsMock.emitBatch).not.toHaveBeenCalled();
  });

  it("active: updated cells announced through cellEvents + refresh", async () => {
    const lib = makeLib();
    await executeMergeCells(asLib(lib), "s1", 0, 0, 2, 2);
    expect(lib.mergeCells).toHaveBeenCalledWith(0, 0, 2, 2, undefined);
    expect(cellEventsMock.emitBatch).toHaveBeenCalled();
  });

  it("a refused merge throws a ValidationError", async () => {
    const lib = makeLib();
    lib.mergeCells.mockResolvedValueOnce({ success: false, mergedRegions: [], updatedCells: [] });
    await expect(executeMergeCells(asLib(lib), "s1", 0, 0, 2, 2, "Data")).rejects.toThrow(
      /overlaps an existing merge/,
    );
  });
});

describe("executeUnmergeCells", () => {
  it("off-sheet: target crosses; no-merge answers a coordinate error", async () => {
    const lib = makeLib();
    await executeUnmergeCells(asLib(lib), 3, 4, 1);
    expect(lib.unmergeCells).toHaveBeenCalledWith(3, 4, 1);
    lib.unmergeCells.mockResolvedValueOnce({ success: false, mergedRegions: [], updatedCells: [] });
    await expect(executeUnmergeCells(asLib(lib), 9, 9, "Data")).rejects.toThrow(
      /No merged region at row=9 col=9/,
    );
  });
});

// ============================================================================
// Sort
// ============================================================================

describe("executeSortRange", () => {
  it("off-sheet: sheetIndex rides the options bag; count comes back; no repaint", async () => {
    await drainPendingRefresh();
    const lib = makeLib();
    const fields = [{ key: 1, ascending: false }];
    const count = await executeSortRange(
      asLib(lib), "s1", 0, 0, 9, 3, asLib(fields), { hasHeaders: true }, "Data",
    );
    expect(count).toBe(5);
    expect(lib.sortRange).toHaveBeenCalledWith(
      0, 0, 9, 3, fields, { hasHeaders: true, sheetIndex: 1 },
    );
    await settleRefresh();
    expect(gridMock.refreshGridData).not.toHaveBeenCalled();
  });

  it("active: sheetIndex undefined; failure surfaces the backend error", async () => {
    const lib = makeLib();
    await executeSortRange(asLib(lib), "s1", 0, 0, 9, 3, asLib([{ key: 0 }]), undefined);
    expect(lib.sortRange).toHaveBeenCalledWith(0, 0, 9, 3, [{ key: 0 }], { sheetIndex: undefined });
    lib.sortRange.mockResolvedValueOnce({
      success: false, sortedCount: 0, updatedCells: [], error: "sheet is protected",
    });
    await expect(
      executeSortRange(asLib(lib), "s1", 0, 0, 9, 3, asLib([{ key: 0 }]), undefined, 1),
    ).rejects.toThrow(/sheet is protected/);
  });
});

// ============================================================================
// Find / replace
// ============================================================================

describe("executeFindAll", () => {
  it("resolves the sheet NAME and reshapes tuples into named fields", async () => {
    const lib = makeLib();
    const result = await executeFindAll(asLib(lib), "total", {
      caseSensitive: true, sheetIndex: "Data",
    });
    expect(lib.findAll).toHaveBeenCalledWith("total", {
      caseSensitive: true, matchEntireCell: false, searchFormulas: false, sheetIndex: 1,
    });
    expect(result).toEqual({ matches: [{ row: 2, col: 3 }, { row: 7, col: 1 }], totalCount: 2 });
  });

  it("no sheet option = active sheet (sheetIndex undefined)", async () => {
    const lib = makeLib();
    await executeFindAll(asLib(lib), "x", undefined);
    expect(lib.findAll).toHaveBeenCalledWith("x", {
      caseSensitive: false, matchEntireCell: false, searchFormulas: false, sheetIndex: undefined,
    });
  });

  it("vFind accepts the sheet slot and still rejects junk", () => {
    expect(vFind(["q", { sheetIndex: "Data" }])).toBe(true);
    expect(vFind(["q", { sheetIndex: 1 }])).toBe(true);
    expect(vFind(["q", { sheetIndex: -1 }])).not.toBe(true);
    expect(vFind(["q", { bogus: true }])).toContain("sheetIndex");
  });
});

describe("executeReplaceAll", () => {
  it("off-sheet: resolved index crosses; repaint skipped; count returned", async () => {
    await drainPendingRefresh();
    const lib = makeLib();
    const result = await executeReplaceAll(asLib(lib), "s1", "a", "b", { sheetIndex: "Data" });
    expect(result).toEqual({ replacementCount: 4 });
    expect(lib.replaceAll).toHaveBeenCalledWith("a", "b", {
      caseSensitive: false, matchEntireCell: false, sheetIndex: 1,
    });
    await settleRefresh();
    expect(gridMock.refreshGridData).not.toHaveBeenCalled();
  });

  it("vReplace accepts the sheet slot", () => {
    expect(vReplace(["a", "b", { sheetIndex: "Data" }])).toBe(true);
    expect(vReplace(["a", "b", { searchFormulas: true }])).not.toBe(true);
  });
});

// ============================================================================
// clearRange: the Wave-2 residual, closed
// ============================================================================

describe("executeClearRange", () => {
  it("off-sheet by NAME executes (the loud refusal is gone) and skips repaint", async () => {
    await drainPendingRefresh();
    const lib = makeLib();
    const result = await executeClearRange(
      asLib(lib), "s1", 0, 0, 9, 9, { applyTo: "contents" }, "Data",
    );
    expect(result).toEqual({ count: 9 });
    expect(lib.clearRangeWithOptions).toHaveBeenCalledWith(0, 0, 9, 9, "contents", 1);
    await settleRefresh();
    expect(gridMock.refreshGridData).not.toHaveBeenCalled();
  });

  it("active default: applyTo 'all', no sheet param, canvas refreshed", async () => {
    const lib = makeLib();
    await executeClearRange(asLib(lib), "s1", 1, 1, 2, 2, undefined);
    expect(lib.clearRangeWithOptions).toHaveBeenCalledWith(1, 1, 2, 2, "all", undefined);
    await settleRefresh();
    expect(gridMock.refreshGridData).toHaveBeenCalled();
  });
});

// ============================================================================
// Allowlist: the descs no longer claim "active sheet"
// ============================================================================

describe("allowlist wording matches the cross-sheet reality", () => {
  it("findAll/replaceAll/clearRange descs stopped saying 'active sheet'", () => {
    for (const m of ["api.findAll", "api.replaceAll", "api.clearRange", "api.sortRange"]) {
      expect(ALLOWLIST[m].desc.toLowerCase()).not.toContain("active sheet");
    }
  });
});
