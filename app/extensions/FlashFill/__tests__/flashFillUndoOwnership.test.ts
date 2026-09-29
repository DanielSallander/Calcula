//! FILENAME: app/extensions/FlashFill/__tests__/flashFillUndoOwnership.test.ts
// PURPOSE: Flash Fill closes ONLY the undo transaction its own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). Flash Fill threw the
//          begin's answer away and then committed -- or, on a refused write,
//          cancelled -- whatever was open: run from a script (the
//          flashfill.execute command) while that script held
//          `api.beginBatch`, it ENDED the script's batch halfway, and a refused
//          fill DROPPED the batch's undo record. The fake below is the
//          backend's ONE slot on the ticket wire of undo_commands.rs.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

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

/** A1:A3 are full names, B1 is the typed example, B2:B3 are to fill. */
const GRID = new Map<string, string>([
  ["0,0", "Alice Smith"],
  ["1,0", "Bob Jones"],
  ["2,0", "Carl Wu"],
  ["0,1", "Alice"],
]);

const h = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (label: string) => slot.begin(label)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  updateCellsBatch: vi.fn(async (..._a: unknown[]) => []),
  toasts: [] as { message: string; variant?: string }[],
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getGridBounds: async () => [2, 1],
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: async (row: number, col: number) => {
    const display = GRID.get(`${row},${col}`);
    return display === undefined ? null : { row, col, display, formula: null, styleIndex: 0 };
  },
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
  registerMenuItem: () => {},
  unregisterMenuItem: () => {},
  emitAppEvent: () => {},
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";

const flashFill = () => CommandRegistry.execute("flashfill.execute");

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  slot.reset();
  h.toasts.length = 0;
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
});

describe("Flash Fill (flashfill.execute)", () => {
  it("inside a script's open batch, it fills INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await flashFill();
    expect(h.updateCellsBatch, "nothing was filled: the test proves nothing about the close").toHaveBeenCalled();
    expect(slot.committed, "Flash Fill COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell B2 is protected");
    });
    await flashFill();
    expect(h.updateCellsBatch).toHaveBeenCalled();
    expect(slot.dropped, "the refused Flash Fill CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
    expect(h.toasts.filter((t) => t.variant === "error").map((t) => t.message)).toEqual(["Cell B2 is protected"]);
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await flashFill();
    expect(slot.committed).toEqual(["Flash Fill"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present Flash Fill's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step (positive control)", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell B2 is protected");
    });
    await flashFill();
    expect(slot.dropped).toEqual(["Flash Fill"]);
    expect(slot.open).toBeNull();
  });
});
