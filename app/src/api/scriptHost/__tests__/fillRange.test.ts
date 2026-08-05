//! FILENAME: app/src/api/scriptHost/__tests__/fillRange.test.ts
// PURPOSE: Behavioural cover for the api.fillRange executor (Wave 3, item 10)
//          — proving a SCRIPT fill goes through the drag fill-handle's own
//          machinery (core/lib/fillEngine) and lands the same cells the drag
//          would: formulas shifted per cell, series continued with the drag's
//          inference, styles carried, one undo transaction, and the
//          active-sheet-only refusal instead of a silent redirect.
// CONTEXT: Same harness style as rangeClipboard.test.ts — the executor takes
//          its `lib` facade as a parameter, driven here by a recording stub.
//          fillEngine's own backend calls (shiftFormulasBatch for formula
//          shifting, getMergedRegions/mergeCells for merge replication) are
//          module-mocked so the test sees exactly what the engine asked for.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
}));

vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(async (_id: string, writes: unknown[]) => ({
    plain: [...(writes as Array<{ sheetIndex: number; row: number; col: number; value: string }>)],
    drafted: [],
  })),
  workbookHasWritebackRegions: vi.fn(async () => false),
}));

// fillEngine reaches the backend directly (it is core code shared with the
// drag); give it a recording stand-in. Everything else in tauri-api stays real.
const engineShiftCalls: Array<{ formula: string; rowDelta: number; colDelta: number }> = [];
const engineMergeCalls: Array<[number, number, number, number]> = [];
let mergedRegions: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> = [];
vi.mock("../../../core/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/lib/tauri-api")>();
  return {
    ...actual,
    shiftFormulasBatch: vi.fn(
      async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) => {
        engineShiftCalls.push(...inputs);
        return inputs.map((i) => `${i.formula}|shifted(${i.rowDelta},${i.colDelta})`);
      },
    ),
    getMergedRegions: vi.fn(async () => mergedRegions),
    mergeCells: vi.fn(async (startRow: number, startCol: number, endRow: number, endCol: number) => {
      engineMergeCalls.push([startRow, startCol, endRow, endCol]);
      return { success: true, mergedRegions: [], updatedCells: [] };
    }),
  };
});

import { fillRangeFromScript } from "../host";

const SCRIPT = "fill-test-script";

interface ViewportCell {
  row: number;
  col: number;
  display: string;
  formula?: string;
  styleIndex?: number;
}
type Update = { row: number; col: number; value: string; styleIndex?: number };

/** A recording stand-in for the @api/lib facade. */
function makeLib(sourceCells: ViewportCell[]) {
  const updates: Update[] = [];
  const undo: string[] = [];
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({
      sheets: [0, 1, 2].map((i) => ({ index: i, name: `Sheet${i + 1}` })),
      activeIndex: 0,
    })),
    getViewportCells: vi.fn(async () => sourceCells),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => { undo.push("begin"); }),
    commitUndoTransaction: vi.fn(async () => { undo.push("commit"); }),
    cancelUndoTransaction: vi.fn(async () => { undo.push("cancel"); }),
    updateCellsBatch: vi.fn(async (u: Update[]) => {
      updates.push(...u);
      return [];
    }),
    updateCell: vi.fn(async () => null),
  };
  return { lib: lib as unknown as Parameters<typeof fillRangeFromScript>[0], updates, undo };
}

function at(updates: Update[], row: number, col: number): Update | undefined {
  return updates.find((u) => u.row === row && u.col === col);
}

describe("fillRangeFromScript — drag parity", () => {
  it("default = FillDown copy: values tiled, formulas shifted per cell, styles carried", async () => {
    // Row 0: A1 = "5" (style 3), B1 = "=A1*2" (style 4). Fill B1's formula and
    // A1's value down through row 2 — Excel's FillDown over A1:B3.
    const { lib, updates, undo } = makeLib([
      { row: 0, col: 0, display: "5", styleIndex: 3 },
      { row: 0, col: 1, display: "14", formula: "=A1*2", styleIndex: 4 },
    ]);
    engineShiftCalls.length = 0;

    const result = await fillRangeFromScript(lib, SCRIPT, 0, 0, 2, 1, {}, undefined);
    expect(result).toEqual({ count: 4 });

    // Values: verbatim copies of the seed (a lone number COPIES — the drag's
    // rule, and Excel FillDown's).
    expect(at(updates, 1, 0)).toMatchObject({ value: "5", styleIndex: 3 });
    expect(at(updates, 2, 0)).toMatchObject({ value: "5", styleIndex: 3 });
    // Formulas: shifted with a PER-CELL delta, through the engine's batch.
    expect(at(updates, 1, 1)).toMatchObject({ value: "=A1*2|shifted(1,0)", styleIndex: 4 });
    expect(at(updates, 2, 1)).toMatchObject({ value: "=A1*2|shifted(2,0)", styleIndex: 4 });
    expect(engineShiftCalls).toEqual([
      { formula: "=A1*2", rowDelta: 1, colDelta: 0 },
      { formula: "=A1*2", rowDelta: 2, colDelta: 0 },
    ]);
    // One undo transaction around the whole fill.
    expect(undo).toEqual(["begin", "commit"]);
  });

  it("type series with a two-value seed continues the sequence (1, 2 -> 3, 4)", async () => {
    const { lib, updates } = makeLib([
      { row: 0, col: 0, display: "1" },
      { row: 1, col: 0, display: "2" },
    ]);
    const result = await fillRangeFromScript(
      lib, SCRIPT, 0, 0, 3, 0, { type: "series", sourceSize: 2 }, undefined,
    );
    expect(result).toEqual({ count: 2 });
    expect(at(updates, 2, 0)?.value).toBe("3");
    expect(at(updates, 3, 0)?.value).toBe("4");
  });

  it("type series continues a text-number seed like the drag would (Item 1 -> Item 2)", async () => {
    const { lib, updates } = makeLib([{ row: 0, col: 0, display: "Item 1" }]);
    await fillRangeFromScript(lib, SCRIPT, 0, 0, 2, 0, { type: "series" }, undefined);
    expect(at(updates, 1, 0)?.value).toBe("Item 2");
    expect(at(updates, 2, 0)?.value).toBe("Item 3");
  });

  it("type series upgrades a LONE numeric seed to a step-1 series (Fill > Series)", async () => {
    const { lib, updates } = makeLib([{ row: 0, col: 0, display: "7" }]);
    await fillRangeFromScript(lib, SCRIPT, 0, 0, 2, 0, { type: "series" }, undefined);
    expect(at(updates, 1, 0)?.value).toBe("8");
    expect(at(updates, 2, 0)?.value).toBe("9");
  });

  it("fills upward from the LAST row when direction is up", async () => {
    const { lib, updates } = makeLib([{ row: 2, col: 0, display: "x", styleIndex: 9 }]);
    const result = await fillRangeFromScript(
      lib, SCRIPT, 0, 0, 2, 0, { direction: "up" }, undefined,
    );
    expect(result).toEqual({ count: 2 });
    expect(at(updates, 0, 0)).toMatchObject({ value: "x", styleIndex: 9 });
    expect(at(updates, 1, 0)).toMatchObject({ value: "x", styleIndex: 9 });
  });

  it("fills right with per-cell column deltas on formulas", async () => {
    const { lib, updates } = makeLib([
      { row: 0, col: 0, display: "3", formula: "=SUM(A2:A9)" },
    ]);
    engineShiftCalls.length = 0;
    await fillRangeFromScript(lib, SCRIPT, 0, 0, 0, 2, { direction: "right" }, undefined);
    expect(at(updates, 0, 1)?.value).toBe("=SUM(A2:A9)|shifted(0,1)");
    expect(at(updates, 0, 2)?.value).toBe("=SUM(A2:A9)|shifted(0,2)");
  });

  it("replicates merged regions from the seed band, inside the same batch", async () => {
    mergedRegions = [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }];
    engineMergeCalls.length = 0;
    const { lib } = makeLib([{ row: 0, col: 0, display: "h" }]);
    await fillRangeFromScript(lib, SCRIPT, 0, 0, 2, 1, {}, undefined);
    // The A1:B1 merge repeats on each filled row, exactly like the drag.
    expect(engineMergeCalls).toEqual([
      [1, 0, 1, 1],
      [2, 0, 2, 1],
    ]);
    mergedRegions = [];
  });

  it("a band covering the whole range fills nothing (Excel FillDown on one row)", async () => {
    const { lib, updates, undo } = makeLib([{ row: 0, col: 0, display: "5" }]);
    const result = await fillRangeFromScript(
      lib, SCRIPT, 0, 0, 0, 3, { direction: "down" }, undefined,
    );
    expect(result).toEqual({ count: 0 });
    expect(updates).toEqual([]);
    expect(undo).toEqual([]); // no empty undo step
  });

  it("REFUSES a non-active sheet instead of silently retargeting", async () => {
    const { lib, updates } = makeLib([]);
    await expect(
      fillRangeFromScript(lib, SCRIPT, 0, 0, 5, 0, {}, "Sheet2"),
    ).rejects.toThrow(/fillRange can only target the active sheet/);
    expect(updates).toEqual([]);
  });
});
