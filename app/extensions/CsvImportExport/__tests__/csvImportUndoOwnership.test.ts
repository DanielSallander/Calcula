//! FILENAME: app/extensions/CsvImportExport/__tests__/csvImportUndoOwnership.test.ts
// PURPOSE: The CSV Import wizard's write closes ONLY the undo transaction its
//          own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The wizard threw the
//          begin's answer away and then committed -- or, on a refusal,
//          cancelled -- whatever was open: importing while a script held
//          `api.beginBatch` ENDED the script's batch halfway, and a refused
//          import DROPPED the batch's undo record. The write now lives in
//          lib/csvImportWrite.ts, which the wizard runs (the source census in
//          src/core/lib/__tests__/undoTransactionOwnership.test.ts pins that the
//          wizard delegates and no longer begins itself). The fake below is the
//          backend's ONE slot on the ticket wire of undo_commands.rs.

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

const h = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (label: string) => slot.begin(label)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  updateCellsBatch: vi.fn(async (..._a: unknown[]) => []),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
}));

import { buildCsvImportUpdates, writeCsvImportAsOneStep } from "../lib/csvImportWrite";

const HEADER = ["Name", "Qty"];
const ROWS = [
  ["Apple", "3"],
  ["Pear", ""],
];

beforeEach(() => {
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
});

describe("the CSV Import wizard's write", () => {
  it("writes the header, then the data rows, skipping empty data fields (the wizard's layout, unchanged)", () => {
    expect(buildCsvImportUpdates(HEADER, ROWS)).toEqual([
      { row: 0, col: 0, value: "Name" },
      { row: 0, col: 1, value: "Qty" },
      { row: 1, col: 0, value: "Apple" },
      { row: 1, col: 1, value: "3" },
      { row: 2, col: 0, value: "Pear" },
    ]);
    expect(buildCsvImportUpdates(null, ROWS)[0]).toEqual({ row: 0, col: 0, value: "Apple" });
  });

  it("inside a script's open batch, it imports INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await writeCsvImportAsOneStep(HEADER, ROWS);
    expect(h.updateCellsBatch, "nothing was imported: the test proves nothing about the close").toHaveBeenCalled();
    expect(slot.committed, "the import COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell A1 is protected");
    });
    await expect(writeCsvImportAsOneStep(HEADER, ROWS)).rejects.toThrow("Cell A1 is protected");
    expect(slot.dropped, "the refused import CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await writeCsvImportAsOneStep(HEADER, ROWS);
    expect(slot.committed).toEqual(["CSV Import"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the import's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step and rejects with the reason (positive control)", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell A1 is protected");
    });
    await expect(writeCsvImportAsOneStep(HEADER, ROWS)).rejects.toThrow("Cell A1 is protected");
    expect(slot.dropped).toEqual(["CSV Import"]);
    expect(slot.open).toBeNull();
  });
});
