//! FILENAME: app/extensions/Table/handlers/__tests__/selectCommands.test.ts
// PURPOSE: "Select this table" as a command — which table, and which block.
// CONTEXT: No select-table command existed at all, so the ribbon, a macro and a
//          script had no way to select a table except by walking its geometry
//          themselves. Every such walk is another copy of the header/totals
//          arithmetic, and a copy that says "the data starts at start_row"
//          selects one row too many and reports success.
//
//          The resolution rules matter as much as the geometry: a command that
//          cannot find the table the caller named must SAY so (return false)
//          rather than pick one, because selecting the wrong table looks
//          exactly like selecting the right one.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const dispatchGridActionMock = vi.fn();

vi.mock("@api", () => ({
  dispatchGridAction: (...args: unknown[]) => dispatchGridActionMock(...args),
  setSelection: (payload: unknown) => ({ type: "SET_SELECTION", payload }),
  scrollToCell: (row: number, col: number) => ({ type: "SCROLL_TO_CELL", row, col }),
}));

let snapshotSelection: { endRow: number; endCol: number } | null = null;

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => (snapshotSelection ? { selection: snapshotSelection } : null),
}));

interface FakeTable {
  id: string;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: Array<{ name: string }>;
  styleOptions: { headerRow: boolean; totalRow: boolean };
}

let tables: FakeTable[] = [];

vi.mock("../../lib/tableStore", () => ({
  getAllTables: () => tables,
  getTableAtCell: (row: number, col: number) =>
    tables.find(
      (t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol,
    ) ?? null,
}));

import {
  selectTableData,
  selectWholeTable,
  registerTableSelectCommands,
  TABLE_SELECT_DATA_COMMAND,
  TABLE_SELECT_ALL_COMMAND,
} from "../selectCommands";

// ---------------------------------------------------------------------------

/** Sales at A5:C10 with a header row and a totals row, so its data is A6:C9. */
const SALES: FakeTable = {
  id: "t-1",
  name: "Sales",
  sheetIndex: 0,
  startRow: 4,
  startCol: 0,
  endRow: 9,
  endCol: 2,
  columns: [{ name: "Region" }, { name: "Units" }, { name: "Margin" }],
  styleOptions: { headerRow: true, totalRow: true },
};

const COSTS: FakeTable = { ...SALES, id: "t-2", name: "Costs", startRow: 20, endRow: 25 };

/** The block of the last SET_SELECTION dispatched. */
function lastBlock(): Record<string, unknown> | null {
  const calls = dispatchGridActionMock.mock.calls.filter(
    (c) => (c[0] as { type?: string })?.type === "SET_SELECTION",
  );
  return calls.length
    ? ((calls[calls.length - 1][0] as { payload: Record<string, unknown> }).payload)
    : null;
}

beforeEach(() => {
  dispatchGridActionMock.mockReset();
  tables = [SALES, COSTS];
  snapshotSelection = { endRow: 6, endCol: 1 }; // inside Sales
});

describe("table.selectData - the table's data rows", () => {
  it("selects the data body, header and totals row excluded", () => {
    expect(selectTableData()).toBe(true);
    expect(lastBlock()).toMatchObject({
      startRow: 5,
      startCol: 0,
      endRow: 8,
      endCol: 2,
      type: "cells",
    });
  });

  it("brings the block's top-left corner into view", () => {
    selectTableData();
    expect(dispatchGridActionMock.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      "SCROLL_TO_CELL",
    );
  });

  it("takes the table under the ACTIVE CELL when the caller names none", () => {
    snapshotSelection = { endRow: 22, endCol: 0 }; // inside Costs
    expect(selectTableData()).toBe(true);
    expect(lastBlock()).toMatchObject({ startRow: 21, endRow: 24 });
  });

  it("takes the table the caller named by id, whatever is selected", () => {
    expect(selectTableData({ tableId: "t-2" })).toBe(true);
    expect(lastBlock()).toMatchObject({ startRow: 21, endRow: 24 });
  });

  it("takes the table the caller named by name, case-insensitively", () => {
    expect(selectTableData({ name: "cOsTs" })).toBe(true);
    expect(lastBlock()).toMatchObject({ startRow: 21, endRow: 24 });
  });

  it("selects NOTHING and says so when the named table does not exist", () => {
    expect(selectTableData({ name: "NoSuchTable" })).toBe(false);
    expect(lastBlock()).toBeNull();
  });

  it("selects nothing when the active cell is outside every table", () => {
    snapshotSelection = { endRow: 40, endCol: 5 };
    expect(selectTableData()).toBe(false);
    expect(lastBlock()).toBeNull();
  });

  it("selects nothing when there is no selection at all", () => {
    snapshotSelection = null;
    expect(selectTableData()).toBe(false);
    expect(lastBlock()).toBeNull();
  });
});

describe("table.selectAll - the whole table", () => {
  it("includes the header row and the totals row", () => {
    expect(selectWholeTable()).toBe(true);
    expect(lastBlock()).toMatchObject({ startRow: 4, startCol: 0, endRow: 9, endCol: 2 });
  });

  it("is the same block as the data when the table shows neither", () => {
    tables = [{ ...SALES, styleOptions: { headerRow: false, totalRow: false } }];
    selectWholeTable();
    const whole = lastBlock();
    dispatchGridActionMock.mockReset();
    selectTableData();
    expect(lastBlock()).toEqual(whole);
  });
});

describe("registration", () => {
  it("registers both commands as script-safe and unregisters both on cleanup", () => {
    const register = vi.fn();
    const unregister = vi.fn();
    const cleanup = registerTableSelectCommands({
      register,
      unregister,
      execute: vi.fn(),
      has: vi.fn(),
      isScriptSafe: vi.fn(),
      getAll: vi.fn(),
    });

    expect(register.mock.calls.map((c) => c[0])).toEqual([
      TABLE_SELECT_DATA_COMMAND,
      TABLE_SELECT_ALL_COMMAND,
    ]);
    for (const call of register.mock.calls) {
      expect(call[2]).toMatchObject({ scriptSafe: true });
    }

    // A command left registered after unload runs against a store that
    // deactivation has just emptied.
    cleanup();
    expect(unregister.mock.calls.map((c) => c[0])).toEqual([
      TABLE_SELECT_DATA_COMMAND,
      TABLE_SELECT_ALL_COMMAND,
    ]);
  });
});
