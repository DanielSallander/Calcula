//! FILENAME: app/extensions/Consolidate/__tests__/consolidateUndoOwnership.test.ts
// PURPOSE: Data > Consolidate's OK closes ONLY the undo transaction its own
//          begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The dialog threw the
//          begin's answer away and then committed -- or, on a refusal,
//          cancelled -- whatever was open: consolidating while a script held
//          `api.beginBatch` ENDED the script's batch halfway, and a refused run
//          DROPPED the batch's undo record. The write now lives in
//          lib/consolidateAsOneStep.ts, which the dialog runs (the source census
//          in src/core/lib/__tests__/undoTransactionOwnership.test.ts pins that
//          the dialog delegates and no longer begins itself). The fake below is
//          the backend's ONE slot on the ticket wire of undo_commands.rs.

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
  consolidateData: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ success: true })),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  consolidateData: (...a: unknown[]) => h.consolidateData(...a),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
}));

import { consolidateAsOneStep } from "../lib/consolidateAsOneStep";

const PARAMS = {
  function: "sum",
  sourceRanges: [{ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 }],
  destSheetIndex: 0,
  destRow: 0,
  destCol: 4,
  useTopRow: false,
  useLeftColumn: false,
} as never;

beforeEach(() => {
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.consolidateData.mockReset();
  h.consolidateData.mockImplementation(async () => ({ success: true }));
});

describe("Data > Consolidate (the dialog's OK)", () => {
  it("inside a script's open batch, it writes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await expect(consolidateAsOneStep(PARAMS)).resolves.toEqual({ success: true });
    expect(h.consolidateData, "nothing was consolidated: the test proves nothing about the close").toHaveBeenCalled();
    expect(slot.committed, "the consolidation COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    h.consolidateData.mockImplementation(async () => {
      throw new Error("Cell E1 is protected");
    });
    await expect(consolidateAsOneStep(PARAMS)).rejects.toThrow("Cell E1 is protected");
    expect(slot.dropped, "the refused consolidation CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await consolidateAsOneStep(PARAMS);
    expect(slot.committed).toEqual(["Data Consolidation"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the step's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step and rejects with the reason (positive control)", async () => {
    h.consolidateData.mockImplementation(async () => {
      throw new Error("Cell E1 is protected");
    });
    await expect(consolidateAsOneStep(PARAMS)).rejects.toThrow("Cell E1 is protected");
    expect(slot.dropped).toEqual(["Data Consolidation"]);
    expect(slot.open).toBeNull();
  });
});
