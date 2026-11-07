//! FILENAME: app/extensions/AutoSum/__tests__/autoSumTableTotals.test.ts
// PURPOSE: BUG-0769 -- AutoSum on a table's TOTALS cell takes the table's own
//          total through @api/tableTotalsService, as Excel [LIVE, 2026-11-06,
//          lane uimisc probe3] writes =SUBTOTAL(109,[H]) on a totals-row cell
//          and on the cell just below a table (turning its totals row on). A
//          cell that is no table's totals cell keeps AutoSum's own rules.
// CONTEXT: The seam is REAL; the provider is a double that records what it is
//          asked (the Table extension's side is tableTotalsProvider.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  selection: { startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" } as Record<string, unknown>,
  sheetReads: 0,
  writes: 0,
  refreshed: 0,
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getRangeCellsTyped: async () => {
    h.sheetReads++;
    return [];
  },
  getUsedRange: async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9, empty: false }),
  updateCellsBatch: async () => {
    h.writes++;
    return [];
  },
  beginUndoTransaction: async () => 1,
  commitUndoTransaction: async () => undefined,
  cancelUndoTransaction: async () => undefined,
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: () => {},
}));
vi.mock("@api/autoFilterService", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isActiveSheetFilterMode: async () => false,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "grid", selection: h.selection }),
  refreshGridData: () => {
    h.refreshed++;
  },
}));

import { runAutoSum } from "../lib/autoSumCommand";
import { registerTableTotalsProvider } from "@api/tableTotalsService";

const asked: Array<[number, number, string]> = [];
let answer: boolean | null = true;
let release: () => void = () => {};

beforeEach(() => {
  asked.length = 0;
  answer = true;
  h.selection = { startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" };
  h.sheetReads = 0;
  h.writes = 0;
  h.refreshed = 0;
  release = registerTableTotalsProvider({
    applyTotal: async (row, col, fn) => {
      asked.push([row, col, fn]);
      return answer;
    },
  });
});
afterEach(() => release());

describe("BUG-0769 AutoSum on a table's totals cell", () => {
  it("one cell: the table's own total, and nothing of AutoSum's own planning", async () => {
    await runAutoSum({ fn: "SUM" });
    expect(asked).toEqual([[4, 1, "sum"]]);
    expect(h.sheetReads, "AutoSum planned over the cells as well").toBe(0);
    expect(h.writes).toBe(0);
    expect(h.refreshed).toBe(1);
  });

  it("asks for the function picked: Count Numbers is the totals row's countNumbers", async () => {
    await runAutoSum({ fn: "COUNT" });
    await runAutoSum({ fn: "MAX" });
    expect(asked.map((a) => a[2])).toEqual(["countNumbers", "max"]);
  });

  it("a cell that is no table's totals cell keeps AutoSum's own rules", async () => {
    answer = null;
    await runAutoSum({ fn: "SUM" });
    expect(asked).toHaveLength(1);
    expect(h.sheetReads, "AutoSum's own guess was never looked for").toBeGreaterThan(0);
  });

  it("a range or a Ctrl+click selection never asks the table", async () => {
    h.selection = { startRow: 1, startCol: 1, endRow: 4, endCol: 1, type: "cells" };
    await runAutoSum({ fn: "SUM" });
    h.selection = {
      startRow: 4,
      startCol: 1,
      endRow: 4,
      endCol: 1,
      type: "cells",
      additionalRanges: [{ startRow: 8, startCol: 1, endRow: 8, endCol: 1 }],
    };
    await runAutoSum({ fn: "SUM" });
    expect(asked).toEqual([]);
  });
});
