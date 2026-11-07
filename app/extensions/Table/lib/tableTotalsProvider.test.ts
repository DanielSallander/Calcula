//! FILENAME: app/extensions/Table/lib/tableTotalsProvider.test.ts
// PURPOSE: BUG-0769 -- the Table extension's side of @api/tableTotalsService:
//          which cell is a table's totals cell, and that the total is put
//          there by the totals row's own commands in ONE undo step. Excel
//          [LIVE, 2026-11-06, lane uimisc probe3]: AutoSum on a totals-row cell
//          writes =SUBTOTAL(109,[H]); on the cell just below a table with its
//          totals row off it turns the row on and writes the same.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tables: [] as unknown[],
  calls: [] as string[],
  toggleOk: true,
  setOk: true,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getAllTables: async () => h.tables,
  toggleTotalsRow: async (id: string, show: boolean) => {
    h.calls.push(`toggle:${id}:${show}`);
    return h.toggleOk ? { success: true } : { success: false, error: "protected" };
  },
  setTotalsRowFunction: async (p: { tableId: string; columnName: string; function: string }) => {
    h.calls.push(`set:${p.tableId}:${p.columnName}:${p.function}`);
    return h.setOk ? { success: true } : { success: false, error: "nope" };
  },
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  beginUndoTransaction: async (label: string) => {
    h.calls.push(`begin:${label}`);
    return 3;
  },
  commitUndoTransaction: async () => {
    h.calls.push("commit");
  },
  cancelUndoTransaction: async () => {
    h.calls.push("cancel");
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.calls.push(`toast:${m}`);
  },
}));
vi.mock("./tableStore", () => ({ refreshCache: async () => undefined }));

import { createTableTotalsProvider, totalsCellOf } from "./tableTotalsProvider";
import type { Table } from "@api/backend";

/** Table1 on A1:B4 (header K, H; three data rows); `totals` = totals row shown on row 5. */
function table(totals: boolean): Table {
  return {
    id: "t1",
    name: "Table1",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: totals ? 4 : 3,
    endCol: 1,
    columns: [
      { id: "c1", name: "K", totalsRowFunction: "none" },
      { id: "c2", name: "H", totalsRowFunction: totals ? "none" : "none" },
    ],
    styleOptions: {
      bandedRows: true,
      bandedColumns: false,
      headerRow: true,
      totalRow: totals,
      firstColumn: false,
      lastColumn: false,
      showFilterButton: true,
    },
    styleName: "TableStyleMedium2",
  } as Table;
}

beforeEach(() => {
  h.tables = [];
  h.calls = [];
  h.toggleOk = true;
  h.setOk = true;
});

describe("totalsCellOf: which cell is a table's totals cell", () => {
  it("a cell of a SHOWN totals row, by its column", () => {
    expect(totalsCellOf([table(true)], 0, 4, 1)).toMatchObject({ columnName: "H", turnOn: false });
  });
  it("the cell just below a table whose totals row is OFF (Excel turns it on)", () => {
    expect(totalsCellOf([table(false)], 0, 4, 1)).toMatchObject({ columnName: "H", turnOn: true });
  });
  it("not a data cell, not a cell beside the table, not another sheet's table, not below a shown totals row", () => {
    expect(totalsCellOf([table(false)], 0, 3, 1)).toBeNull();
    expect(totalsCellOf([table(false)], 0, 4, 2)).toBeNull();
    expect(totalsCellOf([table(false)], 1, 4, 1)).toBeNull();
    expect(totalsCellOf([table(true)], 0, 5, 1)).toBeNull();
  });
});

describe("applyTotal: the totals row's own commands, in ONE undo step", () => {
  it("a shown totals row: the column's totals function, nothing else", async () => {
    h.tables = [table(true)];
    expect(await createTableTotalsProvider().applyTotal(4, 1, "sum")).toBe(true);
    expect(h.calls).toEqual(["begin:AutoSum", "set:t1:H:sum", "commit"]);
  });

  it("below a table with the totals row off: turned on, then the function -- one step", async () => {
    h.tables = [table(false)];
    expect(await createTableTotalsProvider().applyTotal(4, 1, "countNumbers")).toBe(true);
    expect(h.calls).toEqual(["begin:AutoSum", "toggle:t1:true", "set:t1:H:countNumbers", "commit"]);
  });

  it("no table there: null, and nothing is opened or written", async () => {
    h.tables = [table(true)];
    expect(await createTableTotalsProvider().applyTotal(9, 9, "sum")).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("a refused totals row is said, and the empty step cancelled", async () => {
    h.tables = [table(false)];
    h.toggleOk = false;
    expect(await createTableTotalsProvider().applyTotal(4, 1, "sum")).toBe(false);
    expect(h.calls[0]).toBe("begin:AutoSum");
    expect(h.calls).toContain("cancel");
    expect(h.calls.some((c) => c.startsWith("toast:"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("set:"))).toBe(false);
  });
});
