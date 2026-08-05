//! FILENAME: app/extensions/TextToColumns/lib/__tests__/splitProvider.test.ts
// PURPOSE: The @api/textToColumnsService provider (Wave 4) — the script-facing
//          door to this extension's split. What is asserted:
//            - delimitersToConfig maps the flat list onto the wizard's
//              checkbox model (standard four + at most ONE custom);
//            - the split reads the source column, runs the SAME parser the
//              wizard runs, writes the full destination rectangle (short rows
//              blank their tails) as ONE undo transaction, and reports every
//              written cell for attribution;
//            - a refused write cancels the transaction and propagates the
//              backend's reason.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetViewportCells = vi.fn();
const mockUpdateCellsBatch = vi.fn();
const mockBeginUndoTransaction = vi.fn();
const mockCommitUndoTransaction = vi.fn();
const mockCancelUndoTransaction = vi.fn();

vi.mock("@api", () => ({
  getViewportCells: (...args: unknown[]) => mockGetViewportCells(...args),
  updateCellsBatch: (...args: unknown[]) => mockUpdateCellsBatch(...args),
  beginUndoTransaction: (...args: unknown[]) => mockBeginUndoTransaction(...args),
  commitUndoTransaction: (...args: unknown[]) => mockCommitUndoTransaction(...args),
  cancelUndoTransaction: (...args: unknown[]) => mockCancelUndoTransaction(...args),
}));

import { delimitersToConfig, splitTextToColumns } from "../splitProvider";

function viewportCellsFor(values: string[], startRow: number, col: number) {
  return values.map((display, i) => ({ row: startRow + i, col, display }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetViewportCells.mockResolvedValue([]);
  mockUpdateCellsBatch.mockResolvedValue([]);
  mockBeginUndoTransaction.mockResolvedValue(undefined);
  mockCommitUndoTransaction.mockResolvedValue(undefined);
  mockCancelUndoTransaction.mockResolvedValue(undefined);
});

describe("delimitersToConfig", () => {
  it("maps the standard four onto the wizard's checkboxes", () => {
    const cfg = delimitersToConfig(["\t", ";", ",", " "], true);
    expect(cfg).toMatchObject({
      tab: true, semicolon: true, comma: true, space: true, other: "",
      treatConsecutiveAsOne: true, textQualifier: '"',
    });
  });

  it("defaults to comma (the wizard's default)", () => {
    expect(delimitersToConfig(undefined, false)).toMatchObject({ comma: true, other: "" });
    expect(delimitersToConfig([], false)).toMatchObject({ comma: true });
  });

  it("accepts ONE custom character; a second refuses with the fix", () => {
    expect(delimitersToConfig(["|"], false)).toMatchObject({ other: "|", comma: false });
    expect(delimitersToConfig(["|", "|"], false)).toMatchObject({ other: "|" });
    expect(() => delimitersToConfig(["|", "#"], false)).toThrow(/at most one custom delimiter/);
  });

  it("refuses a multi-character delimiter", () => {
    expect(() => delimitersToConfig([";;"], false)).toThrow(/exactly one character/);
  });
});

describe("splitTextToColumns", () => {
  it("splits in place, blanking short rows' tail cells, as one transaction", async () => {
    mockGetViewportCells.mockResolvedValue(viewportCellsFor(["a;b;c", "d;e", ""], 2, 1));
    const result = await splitTextToColumns({
      startRow: 2, startCol: 1, endRow: 4, endCol: 1, delimiters: [";"],
    });
    expect(result.rowsProcessed).toBe(3);
    expect(result.columnsProduced).toBe(3);
    expect(result.cellsWritten).toBe(9);
    expect(result.writtenCells).toHaveLength(9);
    expect(mockBeginUndoTransaction).toHaveBeenCalledWith("Text to Columns");
    expect(mockCommitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(mockCancelUndoTransaction).not.toHaveBeenCalled();
    expect(mockUpdateCellsBatch).toHaveBeenCalledWith([
      { row: 2, col: 1, value: "a" }, { row: 2, col: 2, value: "b" }, { row: 2, col: 3, value: "c" },
      { row: 3, col: 1, value: "d" }, { row: 3, col: 2, value: "e" }, { row: 3, col: 3, value: "" },
      { row: 4, col: 1, value: "" }, { row: 4, col: 2, value: "" }, { row: 4, col: 3, value: "" },
    ]);
  });

  it("writes at an explicit destination instead of in place", async () => {
    mockGetViewportCells.mockResolvedValue(viewportCellsFor(["x,y"], 0, 0));
    const result = await splitTextToColumns({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      destination: { row: 5, col: 7 },
    });
    expect(result.columnsProduced).toBe(2);
    expect(mockUpdateCellsBatch).toHaveBeenCalledWith([
      { row: 5, col: 7, value: "x" }, { row: 5, col: 8, value: "y" },
    ]);
  });

  it("honours quoted fields (the wizard's text qualifier)", async () => {
    mockGetViewportCells.mockResolvedValue(viewportCellsFor(['"a,b",c'], 0, 0));
    await splitTextToColumns({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    expect(mockUpdateCellsBatch).toHaveBeenCalledWith([
      { row: 0, col: 0, value: "a,b" }, { row: 0, col: 1, value: "c" },
    ]);
  });

  it("merges consecutive delimiters when asked", async () => {
    mockGetViewportCells.mockResolvedValue(viewportCellsFor(["a;;b"], 0, 0));
    await splitTextToColumns({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      delimiters: [";"], consecutiveAsOne: true,
    });
    expect(mockUpdateCellsBatch).toHaveBeenCalledWith([
      { row: 0, col: 0, value: "a" }, { row: 0, col: 1, value: "b" },
    ]);
  });

  it("refuses a multi-column source", async () => {
    await expect(
      splitTextToColumns({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 }),
    ).rejects.toThrow(/single-column/);
    expect(mockBeginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a refused write cancels the transaction and propagates the reason", async () => {
    mockGetViewportCells.mockResolvedValue(viewportCellsFor(["a,b"], 0, 0));
    mockUpdateCellsBatch.mockRejectedValue(new Error("Cell B1 is locked (sheet protection)"));
    await expect(
      splitTextToColumns({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }),
    ).rejects.toThrow(/locked/);
    expect(mockCancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(mockCommitUndoTransaction).not.toHaveBeenCalled();
  });
});
