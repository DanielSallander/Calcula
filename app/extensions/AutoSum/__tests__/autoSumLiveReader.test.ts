//! FILENAME: app/extensions/AutoSum/__tests__/autoSumLiveReader.test.ts
// PURPOSE: The live reader tells the planner whether the ACTIVE sheet is in
//          filter mode (rev-ui-3), through @api/autoFilterService only -- so
//          AutoSum over a filtered list writes =SUBTOTAL(9,...) as Excel does,
//          not =SUM(...) (which counts the filtered-out rows: 15 for Excel's 12).
//          An object's cells (a floating grid) are never filtered.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  filterMode: true,
  asks: 0,
}));

vi.mock("@api/autoFilterService", () => ({
  isActiveSheetFilterMode: vi.fn(async () => {
    h.asks++;
    return h.filterMode;
  }),
}));
vi.mock("@api/lib", () => ({
  getRangeCellsTyped: vi.fn(async () => [
    { row: 0, col: 0, value: "H", display: "H", formula: null, type: "text" },
    { row: 1, col: 0, value: 1, display: "1", formula: null, type: "number" },
    { row: 2, col: 0, value: 2, display: "2", formula: null, type: "number" },
    { row: 3, col: 0, value: 3, display: "3", formula: null, type: "number" },
  ]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 3, endCol: 0, empty: false })),
}));
vi.mock("@api/cellTarget", () => ({
  getCellTargetCellsTyped: vi.fn(async () => [
    { row: 0, col: 0, value: 1, display: "1", formula: null, type: "number" },
    { row: 1, col: 0, value: 2, display: "2", formula: null, type: "number" },
  ]),
}));

import { createLiveReader, createTargetReader } from "../lib/liveReader";
import { planAutoSum } from "../lib/autoSumPlan";

describe("the live reader's filter mode", () => {
  beforeEach(() => {
    h.filterMode = true;
    h.asks = 0;
  });

  it("a filtered active sheet: Sum over the list is SUBTOTAL(9, ...), asked once per AutoSum", async () => {
    const plan = await planAutoSum("SUM", { startRow: 1, startCol: 0, endRow: 3, endCol: 0 }, createLiveReader(), ",");
    expect(plan).toMatchObject({ kind: "write", writes: [{ row: 4, col: 0, formula: "=SUBTOTAL(9,A2:A4)" }] });
    expect(h.asks).toBe(1);
  });

  it("an unfiltered active sheet: SUM", async () => {
    h.filterMode = false;
    const plan = await planAutoSum("SUM", { startRow: 1, startCol: 0, endRow: 3, endCol: 0 }, createLiveReader(), ",");
    expect(plan).toMatchObject({ kind: "write", writes: [{ row: 4, col: 0, formula: "=SUM(A2:A4)" }] });
  });

  it("an object's cells never ask: SUM", async () => {
    const reader = createTargetReader({ kind: "floatingGrid", id: "g" } as never, { rows: 5, cols: 2 });
    const plan = await planAutoSum("SUM", { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, reader, ",");
    expect(plan).toMatchObject({ kind: "write", writes: [{ row: 2, col: 0, formula: "=SUM(A1:A2)" }] });
    expect(h.asks).toBe(0);
  });
});
