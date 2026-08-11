//! FILENAME: app/extensions/Table/handlers/__tests__/designTabLifecycle.test.ts
// PURPOSE: The contextual Table Design tab must be a function of the CURRENT
//          state — is the active cell inside a table that still exists — and
//          not of how the tab was switched on.
//
// WHAT WENT WRONG. The tab had two switches and only one of them could turn it
//          off. `ensureDesignTabRegistered()` turns it ON from the
//          TABLE_CREATED event, so the tab appears the moment Insert > Table
//          finishes; it does not set `currentTableId`, because no selection
//          moved. The only unregister sat inside `if (currentTableId !== null)`
//          in the selection handler. So a table created that way and then
//          deleted left the tab REGISTERED FOREVER — a Table Design tab on a
//          workbook with zero tables, every button on it addressing an object
//          that no longer exists.
//
//          The second half is the short-circuit: `handleSelectionChange`
//          returns immediately when the cell is the one it checked last, so
//          deleting the table UNDER a stationary cursor changed nothing either.
//
// HOW IT WAS FOUND. The soak walk, seed 20260810, invariant
//          `contextual-ribbon-tabs`. It failed at step 1 on an unrelated
//          `cell.edit-number`, and the minimiser reduced the trace to that one
//          action — which is the walker's way of saying "the violation was
//          already true before the walk started".
//
// VACUITY. Every "the tab is gone" assertion is paired with a case where the
//          tab must SURVIVE (a table still under the cursor), so a
//          `syncDesignTabToTables` that simply always unregistered would fail
//          here rather than pass.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the handler's whole outside world
// ---------------------------------------------------------------------------

const mockRegisterPanel = vi.fn();
const mockUnregisterPanel = vi.fn();
vi.mock("@api/ui", () => ({
  registerPanel: (...a: unknown[]) => mockRegisterPanel(...a),
  unregisterPanel: (...a: unknown[]) => mockUnregisterPanel(...a),
}));

const mockAddContextKey = vi.fn();
const mockRemoveContextKey = vi.fn();
vi.mock("@api", () => ({
  addTaskPaneContextKey: (...a: unknown[]) => mockAddContextKey(...a),
  removeTaskPaneContextKey: (...a: unknown[]) => mockRemoveContextKey(...a),
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  setColumnHeaderOverrideProvider: vi.fn(() => () => undefined),
  registerColumnHeaderClickInterceptor: vi.fn(() => () => undefined),
  // `tableEvents.ts` reads the real event names off AppEvents at module load,
  // and it is imported transitively by the handler under test.
  AppEvents: {
    TABLE_CREATED: "app:table-created",
    TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    TABLE_STATE: "table:state",
    TABLE_REQUEST_STATE: "table:request-state",
    GRID_REFRESH: "grid:refresh",
  },
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
  styleOptions: Record<string, boolean>;
}

let tables: FakeTable[] = [];

vi.mock("../../lib/tableStore", () => ({
  getAllTables: () => tables,
  getTableAtCell: (row: number, col: number) =>
    tables.find(
      (t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol,
    ) ?? null,
}));

vi.mock("../../manifest", () => ({
  TABLE_DESIGN_TAB_ID: "table-design",
  TableDesignPanelDefinition: { id: "table-design", title: "Table Design" },
}));

import {
  handleSelectionChange,
  ensureDesignTabRegistered,
  syncDesignTabToTables,
  resetSelectionHandlerState,
} from "../selectionHandler";

function makeTable(overrides: Partial<FakeTable> = {}): FakeTable {
  return {
    id: "t1",
    name: "Table1",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 3,
    endCol: 2,
    columns: [{ name: "A" }],
    styleOptions: { headerRow: true, totalRow: false },
    ...overrides,
  };
}

/** Is the contextual tab registered right now, per the calls made? */
function tabIsRegistered(): boolean {
  const events = [
    ...mockRegisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: true })),
    ...mockUnregisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: false })),
  ].sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

describe("the contextual Table Design tab follows the table list", () => {
  beforeEach(() => {
    tables = [];
    resetSelectionHandlerState();
    mockRegisterPanel.mockClear();
    mockUnregisterPanel.mockClear();
    mockAddContextKey.mockClear();
    mockRemoveContextKey.mockClear();
  });

  it("THE DEFECT: a table created without a selection, then deleted, leaves no tab behind", () => {
    // Exactly the route the walker's reset and the script broker both take:
    // the table appears, TABLE_CREATED switches the tab on, and the cursor was
    // never inside it.
    tables = [makeTable()];
    ensureDesignTabRegistered();
    expect(tabIsRegistered(), "precondition: the tab must be ON, or nothing is measured").toBe(
      true,
    );

    tables = [];
    syncDesignTabToTables();

    expect(tabIsRegistered(), "the Table Design tab outlived the last table").toBe(false);
    expect(mockUnregisterPanel).toHaveBeenCalledWith("table-design");
  });

  it("the table is deleted UNDER a stationary cursor — the short-circuit must not save it", () => {
    tables = [makeTable()];
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabIsRegistered(), "precondition: a selection inside a table shows the tab").toBe(true);

    // The cursor does not move. Only the table goes.
    tables = [];
    syncDesignTabToTables();

    expect(
      tabIsRegistered(),
      "the tab survived because handleSelectionChange short-circuits on an unmoved cell",
    ).toBe(false);
    expect(mockRemoveContextKey).toHaveBeenCalledWith("table");
  });

  it("the table under the cursor is deleted while OTHERS remain — the tab still closes", () => {
    // This is the case the `getAllTables().length === 0` shortcut cannot
    // answer, so it is the one that proves the stale-cell cache is really
    // thrown away rather than merely being routed around.
    tables = [makeTable(), makeTable({ id: "t2", startRow: 20, endRow: 24 })];
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabIsRegistered(), "precondition: the cursor is inside t1").toBe(true);

    tables = [makeTable({ id: "t2", startRow: 20, endRow: 24 })];
    syncDesignTabToTables();

    expect(
      tabIsRegistered(),
      "the cursor is no longer inside any table, but the tab stayed — " +
        "handleSelectionChange short-circuited on the unmoved cell",
    ).toBe(false);
  });

  it("VACUITY GUARD: a table still under the cursor KEEPS its tab", () => {
    tables = [makeTable()];
    handleSelectionChange({ endRow: 1, endCol: 1 });
    mockRegisterPanel.mockClear();
    mockUnregisterPanel.mockClear();

    // e.g. the table was merely resized: the list changed, the table did not go.
    tables = [makeTable({ endRow: 8 })];
    syncDesignTabToTables();

    expect(
      mockUnregisterPanel,
      "a sync that always unregisters would make the assertions above meaningless",
    ).not.toHaveBeenCalled();
  });

  it("one of several tables going away, with the cursor outside all of them, closes the tab", () => {
    tables = [makeTable(), makeTable({ id: "t2", startRow: 20, endRow: 24 })];
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabIsRegistered()).toBe(true);

    // The cursor moves off every table. This is the pre-existing rule, and it
    // must still hold after the unregister was moved out of its guard.
    handleSelectionChange({ endRow: 50, endCol: 5 });
    expect(tabIsRegistered(), "the tab must close when the cursor leaves the table").toBe(false);
  });

  it("moving back into a table re-opens it, so the unregister is not one-way", () => {
    tables = [makeTable()];
    handleSelectionChange({ endRow: 1, endCol: 1 });
    handleSelectionChange({ endRow: 50, endCol: 5 });
    expect(tabIsRegistered()).toBe(false);

    handleSelectionChange({ endRow: 2, endCol: 1 });
    expect(tabIsRegistered(), "the tab did not come back when the cursor re-entered").toBe(true);
  });
});
