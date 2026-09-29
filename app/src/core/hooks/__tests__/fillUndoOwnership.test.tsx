//! FILENAME: app/src/core/hooks/__tests__/fillUndoOwnership.test.tsx
// PURPOSE: A fill-handle drag ("Fill series") and a fill-handle double-click
//          ("Auto-fill to edge") close ONLY the undo transaction their own
//          begin OPENED.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). Both committed -- or,
//          on a refused batch, cancelled -- unconditionally after a begin that
//          may only have JOINED another caller's transaction (a script's
//          `api.beginBatch`), which ended that batch halfway or dropped its
//          undo record. Driven through the REAL hook against a fake of the
//          backend's one slot that follows undo_commands.rs's ticket wire.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

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

const api = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
  commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
  cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
  updateCellsBatch: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => api.cancelUndoTransaction(t),
  updateCellsBatch: () => api.updateCellsBatch(),
  // Column A holds data in rows 1..3 (0-based 0..3): the double-click fills
  // B1's value down to row 4.
  getCell: vi.fn(async (row: number, col: number) =>
    col === 0 && row <= 3 ? { row, col, display: "a", formula: null, styleIndex: 0 } : null,
  ),
  getViewportCells: vi.fn(async (r0: number, c0: number) => [
    { row: r0, col: c0, display: "x", formula: null, styleIndex: 0 },
  ]),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  getMergedRegions: vi.fn(async () => []),
  mergeCells: vi.fn(async () => {}),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useFillHandle, type UseFillHandleReturn } from "../useFillHandle";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";
import type { GridConfig } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseFillHandleReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let configOut: GridConfig;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  // No container element: the drag never starts the auto-scroll loop.
  const containerRef = useRef<HTMLElement | null>(null);
  dispatchOut = dispatch;
  configOut = state.config;
  hook = useFillHandle({ containerRef, config: state.config });
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

async function selectB1(): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" }));
  });
  await settle();
}

/** Drag B1's fill handle three rows down, then release. */
async function dragFillDown(): Promise<void> {
  await selectB1();
  await act(async () => {
    hook.startFillDrag(0, 0);
  });
  await settle();
  const rowHeight = configOut.defaultCellHeight;
  const x = configOut.rowHeaderWidth + configOut.defaultCellWidth + 5; // column B
  const y = configOut.colHeaderHeight + rowHeight * 3 + 5; // row 4
  await act(async () => {
    hook.updateFillDrag(x, y);
  });
  await settle();
  await act(async () => {
    await hook.completeFill();
  });
}

async function autoFill(): Promise<void> {
  await selectB1();
  await act(async () => {
    await hook.autoFillToEdge();
  });
}

const GESTURES = [
  { name: "drag the fill handle", label: "Fill series", run: dragFillDown },
  { name: "double-click the fill handle", label: "Auto-fill to edge", run: autoFill },
];

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  slot.reset();
  api.beginUndoTransaction.mockClear();
  api.commitUndoTransaction.mockClear();
  api.cancelUndoTransaction.mockClear();
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

describe.each(GESTURES)("fill gesture: $name", (g) => {
  it("inside a script's open batch, it fills INTO the batch and leaves the batch open", async () => {
    slot.holdAsScriptBatch();
    await g.run();
    await settle();
    expect(api.updateCellsBatch, "the fill wrote nothing: the test proves nothing about its close").toHaveBeenCalled();
    expect(slot.committed, "the fill COMMITTED the script's batch halfway").toEqual([]);
    expect(slot.dropped).toEqual([]);
    expect(slot.open?.label, "the script's batch is no longer open").toBe("Script batch");
  });

  it("refused inside a script's open batch, it does not drop the batch's undo record", async () => {
    slot.holdAsScriptBatch();
    api.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell is protected");
    });
    await g.run();
    await settle();
    expect(api.updateCellsBatch).toHaveBeenCalled();
    expect(slot.dropped, "the refused fill CANCELLED the script's batch").toEqual([]);
    expect(slot.committed).toEqual([]);
    expect(slot.open?.label).toBe("Script batch");
  });

  it("on its own, it opens its step and commits exactly that step with its ticket (positive control)", async () => {
    await g.run();
    await settle();
    expect(slot.committed).toEqual([g.label]);
    expect(slot.open).toBeNull();
    expect(api.commitUndoTransaction, "the commit did not present the fill's ticket").toHaveBeenCalledWith(100);
  });

  it("refused on its own, it cancels exactly its own step (positive control)", async () => {
    api.updateCellsBatch.mockImplementation(async () => {
      throw new Error("Cell is protected");
    });
    await g.run();
    await settle();
    expect(slot.dropped).toEqual([g.label]);
    expect(slot.open).toBeNull();
  });
});
