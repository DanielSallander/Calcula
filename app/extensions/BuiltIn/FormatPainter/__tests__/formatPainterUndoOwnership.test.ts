//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterUndoOwnership.test.ts
// PURPOSE: A Format Painter stroke closes ONLY the undo transaction its own
//          begin OPENED.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). The stroke committed --
//          or, on a refused write, cancelled -- unconditionally after a begin
//          that may only have JOINED another caller's transaction: painting
//          while a script held `api.beginBatch` ended that batch halfway, or
//          dropped its undo record. The fake below is the backend's ONE slot on
//          the ticket wire of undo_commands.rs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const h = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  setCellStyle: vi.fn(async (..._a: unknown[]) => null as unknown),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: vi.fn(async () => ({ styleIndex: 3 })),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  beginUndoTransaction: (d: string) => h.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
  dispatchGridAction: vi.fn(),
  restoreFocusToGrid: vi.fn(),
  registerEditGuard: () => () => {},
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import { activateFormatPainter, applyFormatToTarget, deactivateFormatPainter } from "../formatPainterLogic";

const SOURCE = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
const TARGET = { startRow: 4, startCol: 4, endRow: 5, endCol: 5, type: "cells" as const };

/** Pick up A1's format and paint it onto E5:F6. */
async function paint(): Promise<void> {
  await activateFormatPainter(false, SOURCE);
  await applyFormatToTarget(TARGET);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.setCellStyle.mockReset();
  h.setCellStyle.mockImplementation(async () => {});
});

afterEach(() => {
  deactivateFormatPainter();
});

describe("a Format Painter stroke", () => {
  it("inside a script's open batch, it paints INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await paint();
    expect(h.setCellStyle, "the stroke painted nothing: the test proves nothing about its close").toHaveBeenCalled();
    expect(slot.committed, "the stroke COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    h.setCellStyle.mockImplementation(refuseWrites);
    await paint();
    expect(h.setCellStyle).toHaveBeenCalled();
    expect(slot.dropped, "the refused stroke CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await paint();
    expect(slot.committed).toEqual(["Format Painter"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the stroke's ticket").toHaveBeenCalledWith(100);
  });

  it("refused at its first write on its own, it cancels exactly its own step (positive control)", async () => {
    h.setCellStyle.mockImplementation(refuseWrites);
    await paint();
    expect(slot.dropped).toEqual(["Format Painter"]);
    expect(slot.open).toBeNull();
  });

  it("refused by the whole-stroke CHECK, it opens no step and writes no cell", async () => {
    // The protected sheet does not allow Format Cells (the check's one
    // question: a locked cell is formatted when the option is on, as in Excel).
    h.setCellStyle.mockImplementation(async (...a: unknown[]) => {
      if (isCheck(a)) throw new Error("Cannot format cells on a protected sheet.");
      return null;
    });
    await paint();
    expect(h.setCellStyle.mock.calls.filter((a) => !isCheck(a)), "a cell was written before the refusal").toEqual([]);
    expect(h.beginUndoTransaction, "a refused stroke opened an undo step").not.toHaveBeenCalled();
    expect(slot.committed).toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open).toBeNull();
  });

  it("refused part-way (after cells landed), what landed stays ONE undoable step", async () => {
    // The check passed, then the sheet was protected without Format Cells
    // before the third write (the window between separate calls that no
    // frontend check can close; each write re-asks under its own guards).
    let writes = 0;
    h.setCellStyle.mockImplementation(async (...a: unknown[]) => {
      if (isCheck(a)) return null;
      writes++;
      if (writes === 3) throw new Error("Cannot format cells on a protected sheet.");
      return null;
    });
    await paint();
    expect(slot.committed, "two painted cells were left with no undo step").toEqual(["Format Painter"]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open).toBeNull();
  });
});

/** The stroke's whole-rectangle CHECK (`checkArea`): writes nothing. */
function isCheck(a: readonly unknown[]): boolean {
  return Boolean((a[3] as { checkArea?: unknown } | undefined)?.checkArea);
}

/** A double whose CHECK passes and whose every cell WRITE is refused. */
async function refuseWrites(...a: unknown[]): Promise<unknown> {
  if (isCheck(a)) return null;
  throw new Error("Cannot format cells on a protected sheet.");
}
