//! FILENAME: app/extensions/Controls/__tests__/shapePropertyUndoOwnership.test.ts
// PURPOSE: A script's `shape.setProperty` closes ONLY the undo transaction its
//          own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The shape:setProperty
//          handler threw the begin's answer away and then committed -- or, on
//          a failure, cancelled -- whatever was open. This door is run BY
//          SCRIPTS, so the transaction open when it runs is typically the
//          script's own `api.beginBatch`: the handler ENDED that batch halfway,
//          and a refused write DROPPED its undo record. The handler now runs
//          lib/shapePropertyStep.ts (the source census in src/core/lib/
//          __tests__/undoTransactionOwnership.test.ts pins that it delegates and
//          no longer begins itself). The fake below is the backend's ONE slot on
//          the ticket wire of undo_commands.rs.

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
  beginUndoTransaction: vi.fn(async (label: string): Promise<number | null> => slot.begin(label)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
}));

import { setShapePropertyAsOneStep } from "../lib/shapePropertyStep";

const write = vi.fn(async () => {});
const setFill = () => setShapePropertyAsOneStep("fill", write);

beforeEach(() => {
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.beginUndoTransaction.mockImplementation(async (label: string) => slot.begin(label));
  h.commitUndoTransaction.mockClear();
  h.commitUndoTransaction.mockImplementation(async (t?: number | null) => slot.close(slot.committed, t));
  h.cancelUndoTransaction.mockClear();
  write.mockReset();
  write.mockImplementation(async () => {});
});

describe("a script's shape.setProperty", () => {
  it("inside the script's open batch, it writes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await setFill();
    expect(write, "nothing was written: the test proves nothing about the close").toHaveBeenCalledTimes(1);
    expect(slot.committed, "setProperty COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside the script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    write.mockImplementation(async () => {
      throw new Error("the sheet is protected");
    });
    await expect(setFill()).rejects.toThrow("the sheet is protected");
    expect(slot.dropped, "the refused setProperty CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await setFill();
    expect(slot.committed).toEqual(["Shape property: fill"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the step's ticket").toHaveBeenCalledWith(100);
    expect(h.cancelUndoTransaction, "a cancel after a landed commit").not.toHaveBeenCalled();
  });

  it("refused on its own, it cancels exactly its own step (positive control)", async () => {
    write.mockImplementation(async () => {
      throw new Error("the sheet is protected");
    });
    await expect(setFill()).rejects.toThrow("the sheet is protected");
    expect(slot.dropped).toEqual(["Shape property: fill"]);
    expect(slot.open).toBeNull();
  });

  it("a commit that FAILS still closes its own step -- nothing is left dangling", async () => {
    h.commitUndoTransaction.mockImplementationOnce(async () => {
      throw new Error("ipc down");
    });
    await expect(setFill()).rejects.toThrow("ipc down");
    expect(slot.dropped, "the failed commit left the transaction open for every later edit").toEqual([
      "Shape property: fill",
    ]);
    expect(slot.open).toBeNull();
  });

  it("with the undo API unavailable, the property is still written, ungrouped", async () => {
    h.beginUndoTransaction.mockImplementationOnce(async () => {
      throw new Error("no undo api");
    });
    await setFill();
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.commitUndoTransaction).not.toHaveBeenCalled();
    expect(h.cancelUndoTransaction).not.toHaveBeenCalled();
  });
});
