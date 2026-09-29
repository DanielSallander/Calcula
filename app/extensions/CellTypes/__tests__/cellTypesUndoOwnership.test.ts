//! FILENAME: app/extensions/CellTypes/__tests__/cellTypesUndoOwnership.test.ts
// PURPOSE: Insert > Cell Type closes ONLY the undo transaction its own begin
//          OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). applyTypeToRange threw the
//          begin's answer away and then committed unconditionally: a checkbox
//          inserted from a script (`cellTypes.insertCheckbox` is a command a
//          button or script runs) while that script held `api.beginBatch`
//          ENDED the script's batch halfway, so its later writes became
//          separate undo steps. The fake below is the backend's ONE slot on the
//          ticket wire of undo_commands.rs: a begin while it is open JOINS
//          (answers null); a close presenting a ticket closes only while that
//          very transaction is still the one open; a bare close closes
//          whatever is open.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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
  setCellTypeRange: vi.fn(async (..._a: unknown[]) => {}),
  updateCellsBatch: vi.fn(async (..._a: unknown[]) => []),
  alertAsync: vi.fn(async (..._a: unknown[]) => {}),
  commands: [] as { id: string; execute: () => Promise<void> }[],
  selection: null as null | ((sel: unknown) => void),
}));

// applyTypeToRange imports these lazily (`await import("../../src/api/lib")`,
// `../../src/api/cellTypes`, `../../src/api/events`): the mocks below are the
// SAME modules, so the lazy imports receive them.
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  beginUndoTransaction: (label: string) => h.beginUndoTransaction(label),
  commitUndoTransaction: (t?: number | null) => h.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => h.cancelUndoTransaction(t),
  getCell: vi.fn(async () => null),
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
}));
vi.mock("@api/cellTypes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTypes")>()),
  setCellTypeRange: (...a: unknown[]) => h.setCellTypeRange(...a),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  restoreFocusToGrid: vi.fn(),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alertAsync(...a) }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the @api export's own name
  ExtensionRegistry: {
    onSelectionChange: (cb: (sel: unknown) => void) => {
      h.selection = cb;
      return () => {};
    },
    registerCommand: (command: { id: string; execute: () => Promise<void> }) => {
      h.commands.push(command);
    },
    unregisterCommand: () => {},
  },
  gridExtensions: {
    registerContextMenuItems: () => {},
    unregisterContextMenuItem: () => {},
  },
}));

import extension from "../index";

function insertCheckbox(): Promise<void> {
  const command = h.commands.find((c) => c.id === "cellTypes.insertCheckbox");
  if (!command) throw new Error("cellTypes.insertCheckbox was not registered");
  return command.execute();
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  extension.activate({
    grid: { cellTypes: { register: () => () => {}, refresh: async () => {} } },
    ui: {
      dialogs: { register: () => {}, unregister: () => {}, show: () => {} },
      menus: { registerItem: () => {}, unregisterItem: () => {} },
    },
  } as never);
  // B2:B3 selected -- two empty cells, initialised to FALSE in the same step.
  h.selection?.({ startRow: 1, startCol: 1, endRow: 2, endCol: 1, type: "cells" });
});

beforeEach(() => {
  slot.reset();
  h.beginUndoTransaction.mockClear();
  h.commitUndoTransaction.mockClear();
  h.cancelUndoTransaction.mockClear();
  h.alertAsync.mockClear();
  h.setCellTypeRange.mockReset();
  h.setCellTypeRange.mockImplementation(async () => {});
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
});

describe("Insert > Cell Type > Checkbox", () => {
  it("inside a script's open batch, it writes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await insertCheckbox();
    expect(h.setCellTypeRange, "nothing was inserted: the test proves nothing about the close").toHaveBeenCalled();
    expect(h.updateCellsBatch, "the FALSE initialisation did not run").toHaveBeenCalled();
    expect(slot.committed, "the insert COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it leaves the batch open and says why", async () => {
    slot.holdAsScriptBatch();
    h.setCellTypeRange.mockImplementation(async () => {
      throw new Error("Cell B2 is protected");
    });
    await expect(insertCheckbox()).rejects.toThrow("Cell B2 is protected");
    expect(slot.committed, "the refused insert COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped, "the refused insert dropped the script's undo record").toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
    expect(h.alertAsync).toHaveBeenCalledWith("Cell B2 is protected");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await insertCheckbox();
    expect(slot.committed).toEqual(["Insert cell type"]);
    expect(slot.open).toBeNull();
    expect(h.commitUndoTransaction, "the commit did not present the insert's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it still closes its own step -- the partial result stays one undo step (positive control)", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell B2 is protected");
    });
    await expect(insertCheckbox()).rejects.toThrow("Cell B2 is protected");
    expect(slot.committed).toEqual(["Insert cell type"]);
    expect(slot.open, "the refused insert left its transaction open for later edits to join").toBeNull();
  });
});
