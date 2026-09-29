//! FILENAME: app/src/core/hooks/__tests__/clipboardUndoOwnership.test.tsx
// PURPOSE: A paste, a cut-paste, a drag-move and a Ctrl+drag-copy close ONLY
//          the undo transaction their own begin OPENED.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). The backend keeps ONE
//          undo-transaction slot, and a begin while it is open JOINS it. A
//          script that holds `api.beginBatch` (or a command-line run) holds
//          that slot; every clipboard gesture here then committed -- or, on a
//          refused write, cancelled -- unconditionally, so the user's paste
//          ended the script's batch halfway (its later writes became separate
//          undo steps) or dropped its undo record outright.
//
//          Driven through the REAL hook against a fake of the backend's one
//          slot that follows the ticket wire of undo_commands.rs: a begin that
//          opens answers a ticket, a join answers null, a ticketed close closes
//          only the transaction that ticket names, and a bare close closes
//          whatever is open.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend's ONE undo-transaction slot (undo_commands.rs tickets) -----
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
    /** A script's `api.beginBatch` holds the slot. */
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

const api = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  updateCell: vi.fn(async () => ({ cells: [] as unknown[] })),
  updateCellsBatch: vi.fn(async () => [] as unknown[]),
}));

const cell = (row: number, col: number) => ({ row, col, display: "x", formula: null, styleIndex: 0 });

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => api.cancelUndoTransaction(t),
  updateCell: () => api.updateCell(),
  updateCellsBatch: () => api.updateCellsBatch(),
  getCell: vi.fn(async (row: number, col: number) => cell(row, col)),
  getViewportCells: vi.fn(async (r0: number, c0: number) => [cell(r0, c0)]),
  getCellsInRows: vi.fn(async (r0: number) => [cell(r0, 0)]),
  getCellsInCols: vi.fn(async (c0: number) => [cell(0, c0)]),
  clearCell: vi.fn(async () => {}),
  clearRange: vi.fn(async () => {}),
  hasContentInRange: vi.fn(async () => false),
  setCellStyle: vi.fn(async () => {}),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
  relocateCellReferences: vi.fn(async () => []),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => null),
  writeText: vi.fn(async () => {}),
  writeHtml: vi.fn(async () => {}),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseClipboardReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  dispatchOut = dispatch;
  hook = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function select(row: number, col: number): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" }));
  });
  await settle();
}

const src = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };

/** Each gesture, the write it fails on when refused, and its own step's label. */
const GESTURES: Array<{
  name: string;
  failOn: "updateCell" | "updateCellsBatch";
  label: string;
  run: () => Promise<void>;
}> = [
  {
    name: "paste",
    failOn: "updateCellsBatch",
    label: "Paste 1 cells",
    run: async () => {
      await select(0, 0);
      await act(async () => {
        await hook.copy();
      });
      await select(4, 4);
      await act(async () => {
        await hook.paste();
      });
    },
  },
  {
    name: "drag-move cells",
    failOn: "updateCell",
    label: "Move 1 cells",
    run: () => act(async () => hook.moveCells(src, 5, 5)),
  },
  {
    name: "drag-move rows",
    failOn: "updateCellsBatch",
    label: "Move 1 rows",
    run: () => act(async () => hook.moveRows(0, 0, 5)),
  },
  {
    name: "drag-move columns",
    failOn: "updateCellsBatch",
    label: "Move 1 columns",
    run: () => act(async () => hook.moveColumns(0, 0, 5)),
  },
  {
    name: "Ctrl+drag copy cells",
    failOn: "updateCell",
    label: "Copy 1 cells",
    run: () => act(async () => hook.copyCellsDrag(src, 5, 5)),
  },
  {
    name: "Ctrl+drag copy rows",
    failOn: "updateCellsBatch",
    label: "Copy 1 rows",
    run: () => act(async () => hook.copyRowsDrag(0, 0, 5)),
  },
  {
    name: "Ctrl+drag copy columns",
    failOn: "updateCellsBatch",
    label: "Copy 1 columns",
    run: () => act(async () => hook.copyColumnsDrag(0, 0, 5)),
  },
];

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  slot.reset();
  api.beginUndoTransaction.mockClear();
  api.commitUndoTransaction.mockClear();
  api.cancelUndoTransaction.mockClear();
  api.updateCell.mockReset();
  api.updateCell.mockImplementation(async () => ({ cells: [] }));
  api.updateCellsBatch.mockReset();
  api.updateCellsBatch.mockImplementation(async () => []);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe.each(GESTURES)("clipboard gesture: $name", (g) => {
  it("inside a script's open batch, it writes INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await g.run();
    await settle();
    expect(api.beginUndoTransaction, "the gesture never asked for its undo step").toHaveBeenCalled();
    expect(
      api[g.failOn],
      "the gesture wrote nothing: the test proves nothing about its close",
    ).toHaveBeenCalled();
    expect(slot.committed, "the gesture COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    api[g.failOn].mockImplementation(async () => {
      throw new Error("Cell is protected");
    });
    await g.run();
    await settle();
    expect(api[g.failOn]).toHaveBeenCalled();
    expect(slot.dropped, "the refused gesture CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await g.run();
    await settle();
    expect(slot.committed).toEqual([g.label]);
    expect(slot.open).toBeNull();
    expect(api.commitUndoTransaction, "the commit did not present the gesture's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step (positive control)", async () => {
    api[g.failOn].mockImplementation(async () => {
      throw new Error("Cell is protected");
    });
    await g.run();
    await settle();
    expect(slot.dropped).toEqual([g.label]);
    expect(slot.open).toBeNull();
  });
});

// Wave F, Z8: the paste declared its hold INSIDE the try, so the outer catch
// could not reach it -- anything that threw after the write, the commit
// included, left the paste's transaction OPEN and every later edit joined it.
describe("paste: every exit closes the step the paste opened", () => {
  const paste = GESTURES.find((g) => g.name === "paste")!;

  it("a commit that FAILS still closes the paste's own step", async () => {
    api.commitUndoTransaction.mockImplementationOnce(async () => {
      throw new Error("ipc down");
    });
    await paste.run();
    await settle();
    expect(api.updateCellsBatch, "nothing was pasted: the test proves nothing").toHaveBeenCalled();
    expect(slot.open, "the paste's transaction was left OPEN -- every later edit would join it").toBeNull();
    expect(slot.dropped).toEqual([paste.label]);
    expect(api.cancelUndoTransaction, "the close did not present the paste's ticket").toHaveBeenCalledWith(100);
  });

  it("anything that throws between the write and the commit still closes the paste's own step", async () => {
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith("[PERF][paste]")) throw new Error("boom after the write");
    });
    await paste.run();
    await settle();
    expect(api.updateCellsBatch).toHaveBeenCalled();
    expect(slot.open, "the paste's transaction was left OPEN -- every later edit would join it").toBeNull();
    expect(slot.dropped).toEqual([paste.label]);
  });

  it("the same failure inside a script's open batch closes nothing: the batch stays open", async () => {
    slot.holdAsScriptBatch();
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith("[PERF][paste]")) throw new Error("boom after the write");
    });
    await paste.run();
    await settle();
    expect(slot.dropped, "the failed paste dropped the script's undo record").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });
});
