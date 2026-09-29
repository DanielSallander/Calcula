//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialUndoOwnership.test.ts
// PURPOSE: Paste Special, Paste Link and Paste Column Widths close ONLY the
//          undo transaction their own begin OPENED.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). All three committed --
//          or, when a write threw, cancelled -- unconditionally after a begin
//          that may only have JOINED another caller's transaction: a Paste
//          Values while a script held `api.beginBatch` ended that batch
//          halfway, or dropped its undo record. The fake below is the backend's
//          ONE slot on the ticket wire of undo_commands.rs.

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

const h = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  updateCell: vi.fn(async () => ({ cells: [] as unknown[] })),
  setColumnWidth: vi.fn(async () => {}),
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCell: vi.fn(async () => ({ display: "1", formula: null, styleIndex: 0 })),
  getStyle: vi.fn(async () => ({})),
  updateCell: () => h.updateCell(),
  setCellStyle: vi.fn(async () => {}),
  applyFormatting: vi.fn(async () => ({ cells: [] })),
  getColumnWidth: vi.fn(async () => 64),
  setColumnWidth: () => h.setColumnWidth(),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  addComment: vi.fn(async () => {}),
  setDataValidation: vi.fn(async () => {}),
  beginUndoTransaction: (d: string) => h.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import { executePasteSpecial, executePasteLink } from "../pasteSpecialExecute";

const CLIPBOARD = {
  cells: [[{ row: 0, col: 0, display: "1", formula: null, styleIndex: 2 }]],
  sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  sourceRows: [0],
  isCut: false,
  text: "1",
} as never;
const TARGET = { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" } as never;
const options = (pasteAttribute: string) =>
  ({ pasteAttribute, operation: "none", skipBlanks: false, transpose: false }) as never;

const PASTES = [
  {
    name: "Paste Special (values)",
    label: "Paste Special (values) 1 cells",
    writes: h.updateCell,
    run: () => executePasteSpecial(CLIPBOARD, TARGET, options("values"), 100, 50),
  },
  {
    name: "Paste Link",
    label: "Paste Link 1 cells",
    writes: h.updateCell,
    run: () => executePasteLink(CLIPBOARD, TARGET, 100, 50),
  },
  {
    name: "Paste Column Widths",
    label: "Paste Column Widths",
    writes: h.setColumnWidth,
    run: () => executePasteSpecial(CLIPBOARD, TARGET, options("columnWidths"), 100, 50),
  },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.updateCell.mockReset();
  h.updateCell.mockImplementation(async () => ({ cells: [] }));
  h.setColumnWidth.mockReset();
  h.setColumnWidth.mockImplementation(async () => {});
});

describe.each(PASTES)("$name", (g) => {
  it("inside a script's open batch, it pastes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await g.run();
    expect(g.writes, "the paste wrote nothing: the test proves nothing about its close").toHaveBeenCalled();
    expect(slot.committed, "the paste COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await g.run();
    expect(slot.committed).toEqual([g.label]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the paste's ticket").toHaveBeenCalledWith(100);
  });
});

describe("Paste Column Widths refused (the write throws)", () => {
  const refuse = () =>
    h.setColumnWidth.mockImplementation(async () => {
      throw new Error("The sheet is protected");
    });
  const run = () => executePasteSpecial(CLIPBOARD, TARGET, options("columnWidths"), 100, 50);

  it("inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    refuse();
    await expect(run()).rejects.toThrow("The sheet is protected");
    expect(slot.dropped, "the refused paste CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it cancels exactly its own step (positive control)", async () => {
    refuse();
    await expect(run()).rejects.toThrow("The sheet is protected");
    expect(slot.dropped).toEqual(["Paste Column Widths"]);
    expect(slot.open).toBeNull();
  });
});
