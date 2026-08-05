//! FILENAME: app/src/api/scriptHost/__tests__/autoFitScript.test.ts
// PURPOSE: Behavioural cover for the api.autoFitColumns / api.autoFitRows
//          executor (Wave 3, item 11) — proving a script auto-fit runs the
//          SAME canvas measurement the double-click best-fit runs, INCLUDING
//          the @api/autoFitContributors registry (extension chrome must size
//          identically whichever hand asked), applies Excel's empty-column /
//          empty-row rules, and refuses a non-active sheet.
// CONTEXT: rangeClipboard.test.ts harness style: the executor takes `lib` as
//          a parameter; measurement uses the autoFit test seam (jsdom has no
//          real canvas), and the grid-sync side effects are module-mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  // syncDimensionToGrid dispatches these as Core actions.
  setColumnWidth: vi.fn((col: number, width: number) => ({ type: "SET_COLUMN_WIDTH", col, width })),
  setRowHeight: vi.fn((row: number, height: number) => ({ type: "SET_ROW_HEIGHT", row, height })),
}));
vi.mock("../../gridDispatch", () => ({
  dispatchGridAction: vi.fn(),
}));
// syncDimensionToGrid asks the live lib for the active sheet to tag its
// resize event; the real module would reach for Tauri.
vi.mock("../../lib", () => ({
  getActiveSheet: vi.fn(async () => 0),
}));

import { autoFitFromScript } from "../host";
import { setMeasureContextForTesting } from "../../../core/lib/gridRenderer";
import { registerAutoFitContributor } from "../../autoFitContributors";
import type { CellData } from "../../types";

/** Fixed-width fake canvas: every character is 10px wide. */
const fakeCtx = {
  font: "",
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as CanvasRenderingContext2D;

function cell(row: number, col: number, display: string): CellData {
  return { row, col, display, styleIndex: 0 } as CellData;
}

interface DimCall { index: number; size: number }

function makeLib(opts: {
  cols?: Record<number, CellData[]>;
  rows?: Record<number, CellData[]>;
} = {}) {
  const colWidths: DimCall[] = [];
  const rowHeights: DimCall[] = [];
  const undo: string[] = [];
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({
      sheets: [0, 1].map((i) => ({ index: i, name: `Sheet${i + 1}` })),
      activeIndex: 0,
    })),
    getAllStyles: vi.fn(async () => []),
    getCellsInCols: vi.fn(async (start: number) => opts.cols?.[start] ?? []),
    getCellsInRows: vi.fn(async (start: number) => opts.rows?.[start] ?? []),
    getDefaultDimensions: vi.fn(async () => ({ defaultRowHeight: 20, defaultColumnWidth: 64 })),
    getAllColumnWidths: vi.fn(async () => []),
    setColumnWidth: vi.fn(async (index: number, size: number) => { colWidths.push({ index, size }); }),
    setRowHeight: vi.fn(async (index: number, size: number) => { rowHeights.push({ index, size }); }),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => { undo.push("begin"); }),
    commitUndoTransaction: vi.fn(async () => { undo.push("commit"); }),
    cancelUndoTransaction: vi.fn(async () => { undo.push("cancel"); }),
  };
  return { lib: lib as unknown as Parameters<typeof autoFitFromScript>[0], colWidths, rowHeights, undo };
}

beforeEach(() => {
  setMeasureContextForTesting(fakeCtx);
});
afterEach(() => {
  setMeasureContextForTesting(null);
});

describe("autoFitFromScript — columns", () => {
  it("measures with the double-click math (text width + padding + margin)", async () => {
    const { lib, colWidths, undo } = makeLib({ cols: { 0: [cell(0, 0, "Hello")] } });
    const result = await autoFitFromScript(lib, "columns", 0, 0, undefined);
    // 5 chars x 10px + 2x3 padding + 2 fit margin = 58 (the autoFit.ts formula).
    expect(colWidths).toEqual([{ index: 0, size: 58 }]);
    expect(result).toEqual({ count: 1 });
    expect(undo).toEqual(["begin", "commit"]);
  });

  it("consults @api/autoFitContributors exactly like the double-click", async () => {
    const measureColumn = vi.fn(() => ({ requiredWidth: 150 }));
    const unregister = registerAutoFitContributor({ id: "test-fit-contrib", measureColumn });
    try {
      const { lib, colWidths } = makeLib({ cols: { 0: [cell(0, 0, "Hi")] } });
      await autoFitFromScript(lib, "columns", 0, 0, undefined);
      // The contributor was ASKED, and its wider requirement won the max.
      expect(measureColumn).toHaveBeenCalledWith(0, fakeCtx);
      expect(colWidths).toEqual([{ index: 0, size: 150 }]);
    } finally {
      unregister();
    }
  });

  it("leaves EMPTY columns untouched (Excel) and opens no undo step for them", async () => {
    const { lib, colWidths, undo } = makeLib({ cols: {} });
    const result = await autoFitFromScript(lib, "columns", 0, 2, undefined);
    expect(result).toEqual({ count: 0 });
    expect(colWidths).toEqual([]);
    expect(undo).toEqual([]);
  });
});

describe("autoFitFromScript — rows", () => {
  it("default-size text lands exactly on the default row height", async () => {
    const { lib, rowHeights } = makeLib({ rows: { 0: [cell(0, 0, "Hi")] } });
    const result = await autoFitFromScript(lib, "rows", 0, 0, undefined);
    expect(rowHeights).toEqual([{ index: 0, size: 20 }]);
    expect(result).toEqual({ count: 1 });
  });

  it("an EMPTY row resets to the default height (Excel, unlike columns)", async () => {
    const { lib, rowHeights } = makeLib({ rows: {} });
    const result = await autoFitFromScript(lib, "rows", 3, 3, undefined);
    expect(rowHeights).toEqual([{ index: 3, size: 20 }]);
    expect(result).toEqual({ count: 1 });
  });
});

describe("autoFitFromScript — sheet clamp", () => {
  it("REFUSES a non-active sheet instead of measuring a sheet nobody sees", async () => {
    const { lib, colWidths } = makeLib();
    await expect(autoFitFromScript(lib, "columns", 0, 0, "Sheet2")).rejects.toThrow(
      /autoFitColumns can only target the active sheet/,
    );
    expect(colWidths).toEqual([]);
  });
});
