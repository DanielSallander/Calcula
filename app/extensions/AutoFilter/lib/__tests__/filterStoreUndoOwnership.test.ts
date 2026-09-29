//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStoreUndoOwnership.test.ts
// PURPOSE: The filter dropdown's Sort A-Z / Sort by Color close ONLY the undo
//          transaction their own begin OPENED.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). Both committed -- or,
//          when the sort was refused (a protected range), cancelled --
//          unconditionally after a begin that may only have JOINED another
//          caller's transaction: a sort clicked while a script held
//          `api.beginBatch` ended that batch halfway, or dropped its undo
//          record. The fake below is the backend's ONE slot on the ticket wire
//          of undo_commands.rs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const slot = vi.hoisted(() => {
  const s = {
    open: null as null | { label: string; ticket: number },
    issued: null as number | null,
    nextTicket: 100,
    committed: [] as string[],
    dropped: [] as string[],
    begin(description: string): number | null {
      if (s.open) return null;
      const ticket = s.nextTicket++;
      s.open = { label: description, ticket };
      s.issued = ticket;
      return ticket;
    },
    close(into: string[], ticket?: number | null): void {
      if (ticket === undefined || ticket === null) {
        if (s.open) into.push(s.open.label);
        s.open = null;
        s.issued = null;
        return;
      }
      if (s.open && s.issued === ticket) {
        into.push(s.open.label);
        s.open = null;
        s.issued = null;
      }
    },
    holdAsScriptBatch(): void {
      s.open = { label: "Script batch", ticket: 1 };
      s.issued = 1;
    },
    reset(): void {
      s.open = null;
      s.issued = null;
      s.nextTicket = 100;
      s.committed = [];
      s.dropped = [];
    },
  };
  return s;
});

const lib = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  sortRangeByColumn: vi.fn(async () => ({ success: true })),
  sortRange: vi.fn(async () => ({ success: true })),
}));

const mockApplyAutoFilter = vi.fn();
const mockReapplyAutoFilter = vi.fn();

vi.mock("@api", () => ({
  applyAutoFilter: (...args: unknown[]) => mockApplyAutoFilter(...args),
  removeAutoFilter: vi.fn(),
  clearAutoFilterCriteria: vi.fn(),
  reapplyAutoFilter: (...args: unknown[]) => mockReapplyAutoFilter(...args),
  clearColumnCriteria: vi.fn(),
  getAutoFilter: vi.fn(),
  getHiddenRows: vi.fn(async () => []),
  setColumnFilterValues: vi.fn(),
  getFilterUniqueValues: vi.fn(),
  detectDataRegion: vi.fn(),
  setHiddenRows: (rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }),
  dispatchGridAction: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  sortRangeByColumn: (...a: unknown[]) => lib.sortRangeByColumn(...(a as [])),
  sortRange: (...a: unknown[]) => lib.sortRange(...(a as [])),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  setColumnCustomFilter: vi.fn(),
  beginUndoTransaction: (d: string) => lib.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => lib.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => lib.cancelUndoTransaction(t),
}));

vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import { createAutoFilterController, resetState, sortByColumn, sortByColor } from "../filterStore";

function info() {
  return {
    id: "af-uuid",
    startRow: 0,
    startCol: 2,
    endRow: 20,
    endCol: 5,
    enabled: true,
    isDataFiltered: false,
    criteria: [null, null, null, null],
  };
}

const okResult = () => ({ success: true, autoFilter: info(), hiddenRows: [], visibleRows: [] });

const SORTS = [
  { name: "Sort by column", run: () => sortByColumn(3, true), writes: lib.sortRangeByColumn },
  { name: "Sort by color", run: () => sortByColor(3, "#ff0000", "cellColor"), writes: lib.sortRange },
];

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetState();
  vi.clearAllMocks();
  slot.reset();
  lib.sortRangeByColumn.mockImplementation(async () => ({ success: true }));
  lib.sortRange.mockImplementation(async () => ({ success: true }));
  mockApplyAutoFilter.mockResolvedValue(okResult());
  mockReapplyAutoFilter.mockResolvedValue(okResult());
  await createAutoFilterController().apply(0, 2, 20, 5);
  slot.reset();
});

describe.each(SORTS)("AutoFilter dropdown: $name", (g) => {
  it("inside a script's open batch, it sorts INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await g.run();
    expect(g.writes, "the sort never ran: the test proves nothing about its close").toHaveBeenCalled();
    expect(slot.committed, "the sort COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    g.writes.mockImplementation(async () => {
      throw new Error("The range is protected");
    });
    await g.run();
    expect(g.writes).toHaveBeenCalled();
    expect(slot.dropped, "the refused sort CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await g.run();
    expect(slot.committed).toEqual([g.name]);
    expect(slot.open).toBeNull();
    expect(lib.commitUndoTransaction, "the commit did not present the sort's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step (positive control)", async () => {
    g.writes.mockImplementation(async () => {
      throw new Error("The range is protected");
    });
    await g.run();
    expect(slot.dropped).toEqual([g.name]);
    expect(slot.open).toBeNull();
  });
});
