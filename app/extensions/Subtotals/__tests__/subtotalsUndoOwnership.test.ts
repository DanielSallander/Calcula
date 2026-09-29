//! FILENAME: app/extensions/Subtotals/__tests__/subtotalsUndoOwnership.test.ts
// PURPOSE: Data > Subtotals closes ONLY the undo transaction its own begin
//          OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). applySubtotals threw the
//          begin's answer away and committed whatever was open -- on success
//          AND on a refusal: run while a script held `api.beginBatch` it ENDED
//          the script's batch halfway. The fake below is the backend's ONE slot
//          on the ticket wire of undo_commands.rs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const slot = vi.hoisted(() => {
  const s = {
    open: null as null | { label: string; ticket: number },
    next: 100,
    committed: [] as string[],
    dropped: [] as string[],
    begin(label: string): number | null {
      if (s.open) return null;
      s.open = { label, ticket: s.next++ };
      return s.open.ticket;
    },
    close(into: string[], ticket?: number | null): void {
      if (!s.open) return;
      if (ticket !== undefined && ticket !== null && ticket !== s.open.ticket) return;
      into.push(s.open.label);
      s.open = null;
    },
    holdAsScriptBatch(): void {
      s.open = { label: "Script batch", ticket: 1 };
    },
    reset(): void {
      s.open = null;
      s.next = 100;
      s.committed = [];
      s.dropped = [];
    },
  };
  return s;
});

/** A2:A5 group-by values (two groups), B2:B5 numbers. */
const COLUMN_A = new Map<number, string>([
  [1, "North"],
  [2, "North"],
  [3, "South"],
  [4, "South"],
]);

const h = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (label: string) => slot.begin(label)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  insertRows: vi.fn(async (..._a: unknown[]) => {}),
  updateCellsBatch: vi.fn(async (..._a: unknown[]) => []),
  alertAsync: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: async (row: number, col: number) => {
    const display = col === 0 ? COLUMN_A.get(row) : undefined;
    return display === undefined ? null : { row, col, display, formula: null, styleIndex: 0 };
  },
  insertRows: (...a: unknown[]) => h.insertRows(...a),
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
  groupRows: vi.fn(async () => {}),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alertAsync(...a) }));

import { applySubtotals } from "../lib/subtotalEngine";

const CONFIG = { groupByCol: 0, subtotalCols: [1], functionCode: 9, startRow: 1, endRow: 4 } as never;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.alertAsync.mockClear();
  h.insertRows.mockReset();
  h.insertRows.mockImplementation(async () => {});
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
});

describe("Data > Subtotals", () => {
  it("inside a script's open batch, it writes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await applySubtotals(CONFIG);
    expect(h.updateCellsBatch, "no subtotal was written: the test proves nothing about the close").toHaveBeenCalled();
    expect(slot.committed, "Subtotals COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it leaves the batch open and says why", async () => {
    slot.holdAsScriptBatch();
    h.insertRows.mockImplementation(async () => {
      throw new Error("Row 4 is protected");
    });
    await applySubtotals(CONFIG);
    expect(slot.committed, "the refused Subtotals COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
    expect(h.alertAsync).toHaveBeenCalledWith("Row 4 is protected");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await applySubtotals(CONFIG);
    expect(slot.committed).toEqual(["Subtotals"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the step's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it closes its own step so the partial result stays ONE undo step (positive control)", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell B6 is protected");
    });
    await applySubtotals(CONFIG);
    expect(slot.committed).toEqual(["Subtotals"]);
    expect(slot.open, "the refused Subtotals left its transaction open for later edits to join").toBeNull();
    expect(h.alertAsync).toHaveBeenCalledWith("Cell B6 is protected");
  });
});
