//! FILENAME: app/extensions/TextToColumns/lib/__tests__/textToColumnsUndoOwnership.test.ts
// PURPOSE: Text to Columns -- the wizard's Finish and the script door
//          (@api/textToColumnsService) -- closes ONLY the undo transaction its
//          own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). Both doors threw the
//          begin's answer away and then committed -- or, on a refusal,
//          cancelled -- whatever was open. The script door is where it bites:
//          a script that splits a column inside its own `api.beginBatch`
//          ENDED its batch halfway, and a refused split DROPPED the batch's
//          undo record. Both doors now write through lib/writeSplit.ts (the
//          source census in src/core/lib/__tests__/undoTransactionOwnership
//          .test.ts pins that neither begins itself). The fake below is the
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
  getViewportCells: async () => [
    { row: 0, col: 0, display: "a,b" },
    { row: 1, col: 0, display: "c,d" },
  ],
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
}));

import { writeSplitAsOneStep } from "../writeSplit";
import { splitTextToColumns } from "../splitProvider";

const DOORS: [string, () => Promise<unknown>][] = [
  ["the wizard's Finish (writeSplitAsOneStep)", () => writeSplitAsOneStep([{ row: 0, col: 0, value: "a" }])],
  [
    "the script door (textToColumnsService.split)",
    () => splitTextToColumns({ startRow: 0, startCol: 0, endRow: 1, endCol: 0, delimiters: [","] }),
  ],
];

beforeEach(() => {
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
});

for (const [door, run] of DOORS) {
  describe(`Text to Columns: ${door}`, () => {
    it("inside a script's open batch, it splits INTO the batch and leaves the batch open", async () => {
      slot.holdAsScriptBatch();
      await run();
      expect(h.updateCellsBatch, "nothing was split: the test proves nothing about the close").toHaveBeenCalled();
      expect(slot.committed, "the split COMMITTED the script's batch halfway").toEqual([]);
      expect(slot.dropped).toEqual([]);
      expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
    });

    it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
      slot.holdAsScriptBatch();
      h.updateCellsBatch.mockImplementation(async () => {
        throw new Error("Cell B1 is protected");
      });
      await expect(run()).rejects.toThrow("Cell B1 is protected");
      expect(slot.dropped, "the refused split CANCELLED the script's batch").toEqual([]);
      expect(slot.committed).toEqual([]);
      expect(slot.open?.label).toBe("Script batch");
    });

    it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
      await run();
      expect(slot.committed).toEqual(["Text to Columns"]);
      expect(slot.open).toBeNull();
      expect(h.commitUndoTransaction, "the commit did not present the split's ticket").toHaveBeenCalledWith(100);
    });

    it("refused on its own, it cancels exactly its own step and rejects with the reason (positive control)", async () => {
      h.updateCellsBatch.mockImplementation(async () => {
        throw new Error("Cell B1 is protected");
      });
      await expect(run()).rejects.toThrow("Cell B1 is protected");
      expect(slot.dropped).toEqual(["Text to Columns"]);
      expect(slot.open).toBeNull();
    });
  });
}
