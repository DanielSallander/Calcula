//! FILENAME: app/src/api/scriptHost/__tests__/hiddenLines.test.ts
// PURPOSE: Behavioural cover for the hide/unhide script surface — VBA's
//          `Rows("5:10").Hidden = True` / `Columns("C").Hidden = False`:
//            - executeSetLinesHidden expands the INCLUSIVE span into the one
//              range-taking backend call (one IPC round-trip, one undo step)
//              and pushes the backend's authoritative answer into Core state;
//            - it is ACTIVE SHEET only and REFUSES (never redirects) a ref
//              naming another sheet, by name or by index;
//            - executeGetHiddenLines resolves a sheet by NAME and answers for
//              ANY sheet, keeping the `user` and `effective` sets apart —
//              the distinction that makes "what did I hide" a different
//              question from "is this row visible".
// CONTEXT: autoFitScript.test.ts harness style — the executors take `lib` as a
//          parameter and the grid-sync side effects are module-mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

const gridMock = {
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  setManuallyHiddenRows: vi.fn((rows: number[]) => ({ type: "SET_MANUALLY_HIDDEN_ROWS", rows })),
  setManuallyHiddenCols: vi.fn((cols: number[]) => ({ type: "SET_MANUALLY_HIDDEN_COLS", cols })),
};
vi.mock("../../grid", () => gridMock);
const dispatchMock = { dispatchGridAction: vi.fn() };
vi.mock("../../gridDispatch", () => dispatchMock);

import { executeSetLinesHidden, executeGetHiddenLines } from "../host";
import { vHiddenSpan, vHiddenQuery, MAX_HIDDEN_SPAN } from "../validators";
import { ALLOWLIST } from "../allowlist";

// Sheet list: active = 0 ("Main"); "Data" (1) is the off-sheet target.
const SHEETS = [
  { index: 0, name: "Main" },
  { index: 1, name: "Data" },
];

function makeLib() {
  // The backend owns the set; the fake mirrors its semantics (add/remove the
  // named indexes, answer ascending) so the executor's own arithmetic — the
  // inclusive-span expansion — is what the assertions actually test.
  const rows = new Set<number>();
  const cols = new Set<number>();
  const apply = (set: Set<number>, lines: number[], hidden: boolean): number[] => {
    for (const l of lines) {
      if (hidden) set.add(l);
      else set.delete(l);
    }
    return [...set].sort((a, b) => a - b);
  };
  return {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: 0 })),
    setRowsHidden: vi.fn(async (lines: number[], hidden: boolean) => apply(rows, lines, hidden)),
    setColsHidden: vi.fn(async (lines: number[], hidden: boolean) => apply(cols, lines, hidden)),
    getHiddenRowsInfo: vi.fn(async (_sheetIndex?: number) => ({
      user: [4],
      effective: [4, 11, 12],
    })),
    getHiddenColsInfo: vi.fn(async (_sheetIndex?: number) => ({
      user: [2],
      effective: [2, 7],
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// executeSetLinesHidden
// ============================================================================

describe("executeSetLinesHidden", () => {
  it("sends the whole INCLUSIVE span in ONE backend call (one undo step)", async () => {
    const lib = makeLib();
    const result = await executeSetLinesHidden(asLib(lib), "rows", 4, 9, true);
    expect(lib.setRowsHidden).toHaveBeenCalledTimes(1);
    expect(lib.setRowsHidden).toHaveBeenCalledWith([4, 5, 6, 7, 8, 9], true);
    expect(result).toEqual({ hidden: [4, 5, 6, 7, 8, 9] });
  });

  it("a single row is a one-element span, not a special case", async () => {
    const lib = makeLib();
    const result = await executeSetLinesHidden(asLib(lib), "rows", 3, 3, true);
    expect(lib.setRowsHidden).toHaveBeenCalledWith([3], true);
    expect(result.hidden).toEqual([3]);
  });

  it("unhide removes only the named indexes — the rest of the set survives", async () => {
    const lib = makeLib();
    await executeSetLinesHidden(asLib(lib), "rows", 0, 5, true);
    const result = await executeSetLinesHidden(asLib(lib), "rows", 2, 3, false);
    expect(lib.setRowsHidden).toHaveBeenLastCalledWith([2, 3], false);
    expect(result.hidden).toEqual([0, 1, 4, 5]);
  });

  it("columns go through the column command, addressed by COLUMN index", async () => {
    const lib = makeLib();
    const result = await executeSetLinesHidden(asLib(lib), "columns", 2, 4, true);
    expect(lib.setColsHidden).toHaveBeenCalledWith([2, 3, 4], true);
    expect(lib.setRowsHidden).not.toHaveBeenCalled();
    expect(result.hidden).toEqual([2, 3, 4]);
  });

  it("pushes the BACKEND's answer into Core state and repaints (no second read)", async () => {
    const lib = makeLib();
    await executeSetLinesHidden(asLib(lib), "rows", 1, 2, true);
    expect(gridMock.setManuallyHiddenRows).toHaveBeenCalledWith([1, 2]);
    expect(dispatchMock.dispatchGridAction).toHaveBeenCalledWith({
      type: "SET_MANUALLY_HIDDEN_ROWS",
      rows: [1, 2],
    });
    expect(gridMock.refreshGridData).toHaveBeenCalled();

    vi.clearAllMocks();
    await executeSetLinesHidden(asLib(lib), "columns", 0, 0, true);
    expect(gridMock.setManuallyHiddenCols).toHaveBeenCalledWith([0]);
    expect(gridMock.setManuallyHiddenRows).not.toHaveBeenCalled();
  });

  it("the ACTIVE sheet may be named explicitly (by name or index)", async () => {
    const lib = makeLib();
    await executeSetLinesHidden(asLib(lib), "rows", 1, 1, true, "Main");
    await executeSetLinesHidden(asLib(lib), "rows", 2, 2, true, 0);
    expect(lib.setRowsHidden).toHaveBeenCalledTimes(2);
  });

  it("REFUSES a background sheet rather than hiding the wrong rows", async () => {
    const lib = makeLib();
    await expect(
      executeSetLinesHidden(asLib(lib), "rows", 4, 9, true, "Data"),
    ).rejects.toThrow(/setRowsHidden can only target the active sheet/);
    await expect(
      executeSetLinesHidden(asLib(lib), "columns", 1, 1, true, 1),
    ).rejects.toThrow(/setColumnsHidden can only target the active sheet/);
    expect(lib.setRowsHidden).not.toHaveBeenCalled();
    expect(lib.setColsHidden).not.toHaveBeenCalled();
    expect(dispatchMock.dispatchGridAction).not.toHaveBeenCalled();
  });

  it("an unknown sheet name names the workbook's sheets in the error", async () => {
    const lib = makeLib();
    await expect(
      executeSetLinesHidden(asLib(lib), "rows", 0, 0, true, "Nope"),
    ).rejects.toThrow(/no sheet named "Nope"/);
  });

  it("a backend refusal (protected sheet) propagates and syncs NOTHING", async () => {
    const lib = makeLib();
    lib.setRowsHidden.mockRejectedValueOnce(
      new Error("Sheet is protected: hide rows is not allowed"),
    );
    await expect(executeSetLinesHidden(asLib(lib), "rows", 4, 9, true)).rejects.toThrow(
      /Sheet is protected/,
    );
    expect(dispatchMock.dispatchGridAction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// executeGetHiddenLines
// ============================================================================

describe("executeGetHiddenLines", () => {
  it("keeps the USER set and the EFFECTIVE set apart", async () => {
    const lib = makeLib();
    const rows = await executeGetHiddenLines(asLib(lib), "rows");
    // Row 4 was hidden by hand; 11 and 12 are hidden by a filter or a
    // collapsed group. "What did I hide?" and "is it visible?" differ.
    expect(rows).toEqual({ user: [4], effective: [4, 11, 12] });
    expect(rows.user.every((r) => rows.effective.includes(r))).toBe(true);
  });

  it("answers for ANY sheet, resolved BY NAME — no activate-dance", async () => {
    const lib = makeLib();
    await executeGetHiddenLines(asLib(lib), "rows", "Data");
    expect(lib.getHiddenRowsInfo).toHaveBeenCalledWith(1);
    await executeGetHiddenLines(asLib(lib), "columns", "Data");
    expect(lib.getHiddenColsInfo).toHaveBeenCalledWith(1);
  });

  it("omitted sheet = the active sheet (undefined crosses to the backend)", async () => {
    const lib = makeLib();
    await executeGetHiddenLines(asLib(lib), "rows");
    expect(lib.getHiddenRowsInfo).toHaveBeenCalledWith(undefined);
  });

  it("the column read is a different question from the row read", async () => {
    const lib = makeLib();
    const cols = await executeGetHiddenLines(asLib(lib), "columns");
    expect(cols).toEqual({ user: [2], effective: [2, 7] });
    expect(lib.getHiddenRowsInfo).not.toHaveBeenCalled();
  });

  it("an unknown sheet name rejects before any backend call", async () => {
    const lib = makeLib();
    await expect(executeGetHiddenLines(asLib(lib), "rows", "Nope")).rejects.toThrow(
      /getHiddenRows: no sheet named "Nope"/,
    );
    expect(lib.getHiddenRowsInfo).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Validators + ALLOWLIST policy
// ============================================================================

describe("vHiddenSpan / vHiddenQuery", () => {
  it("accepts an inclusive span with the boolean and an optional sheet", () => {
    expect(vHiddenSpan([4, 9, true])).toBe(true);
    expect(vHiddenSpan([4, 4, false])).toBe(true);
    expect(vHiddenSpan([0, 5, true, "Data"])).toBe(true);
    expect(vHiddenSpan([0, 5, true, 1])).toBe(true);
  });

  it("refuses a malformed span", () => {
    expect(vHiddenSpan([-1, 5, true])).toMatch(/start must be a non-negative integer/);
    expect(vHiddenSpan([0, 1.5, true])).toMatch(/end must be a non-negative integer/);
    expect(vHiddenSpan([9, 2, true])).toMatch(/end must be >= start/);
    expect(vHiddenSpan([0, MAX_HIDDEN_SPAN, true])).toMatch(/span too large/);
  });

  it("insists on the boolean — an omitted flag is not 'hide'", () => {
    expect(vHiddenSpan([4, 9])).toMatch(/hidden must be a boolean/);
    expect(vHiddenSpan([4, 9, "true"])).toMatch(/hidden must be a boolean/);
    expect(vHiddenSpan([4, 9, 1])).toMatch(/hidden must be a boolean/);
  });

  it("the read takes a sheet ref and nothing else", () => {
    expect(vHiddenQuery([])).toBe(true);
    expect(vHiddenQuery(["Data"])).toBe(true);
    expect(vHiddenQuery([1])).toBe(true);
    expect(vHiddenQuery([{}])).not.toBe(true);
  });
});

describe("ALLOWLIST rows", () => {
  it("hide/unhide is a MUTATE and the reads are READS, all unlocked, no capability", () => {
    for (const id of ["api.setRowsHidden", "api.setColumnsHidden"]) {
      const row = ALLOWLIST[id];
      expect(row, id).toBeDefined();
      expect(row.class).toBe("mutate");
      expect(row.tier).toBe("unlocked");
      expect(row.capability).toBeUndefined();
    }
    for (const id of ["api.getHiddenRows", "api.getHiddenColumns"]) {
      const row = ALLOWLIST[id];
      expect(row, id).toBeDefined();
      expect(row.class).toBe("read");
      expect(row.tier).toBe("unlocked");
      expect(row.capability).toBeUndefined();
    }
  });
});
