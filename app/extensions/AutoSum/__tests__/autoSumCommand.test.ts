//! FILENAME: app/extensions/AutoSum/__tests__/autoSumCommand.test.ts
// PURPOSE: `autosum.insert { fn }` end to end, minus the backend: one cell
//          opens Core's edit holding the guess (through the opener the shell
//          component lends -- never the raw grid action); a range writes its
//          totals in ONE undo step that it closes only if its own begin opened
//          it; refusals are said out loud.
// CONTEXT: Home tab 2026-10-04. The rules themselves are autoSumPlan.test.ts's;
//          this file is the wiring around them.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = vi.hoisted(() => {
  const s = {
    cells: [] as Array<{ row: number; col: number; value: number | string; display: string; formula: string | null; type: string }>,
    used: { startRow: 0, startCol: 0, endRow: 2, endCol: 0, empty: false },
    snapshot: {
      surface: "grid" as "grid" | "canvas",
      selection: { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as Record<string, unknown>,
    },
    dispatched: [] as Array<{ type: string; payload: unknown }>,
    writes: [] as unknown[][],
    writeError: null as string | null,
    toasts: [] as string[],
    opened: [] as string[],
    cursor: [] as number[],
    undo: { open: null as null | { label: string; ticket: number }, committed: [] as string[], dropped: [] as string[] },
  };
  return s;
});

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getRangeCellsTyped: async (sr: number, sc: number, er: number, ec: number) =>
    h.cells.filter((c) => c.row >= sr && c.row <= er && c.col >= sc && c.col <= ec),
  getUsedRange: async () => h.used,
  updateCellsBatch: async (updates: unknown[]) => {
    h.writes.push(updates);
    if (h.writeError) throw new Error(h.writeError);
    return [];
  },
  beginUndoTransaction: async (label: string) => {
    if (h.undo.open) return null;
    h.undo.open = { label, ticket: 7 };
    return 7;
  },
  commitUndoTransaction: async (ticket?: number | null) => {
    if (h.undo.open && (ticket === undefined || ticket === null || ticket === h.undo.open.ticket)) {
      h.undo.committed.push(h.undo.open.label);
      h.undo.open = null;
    }
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    if (h.undo.open && (ticket === undefined || ticket === null || ticket === h.undo.open.ticket)) {
      h.undo.dropped.push(h.undo.open.label);
      h.undo.open = null;
    }
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.snapshot,
  refreshGridData: () => {},
}));
vi.mock("@api/gridDispatch", () => ({
  dispatchGridAction: (a: { type: string; payload: unknown }) => h.dispatched.push(a),
}));
vi.mock("@api/locale", () => ({ getLocaleSettings: async () => ({ listSeparator: ";" }) }));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));
vi.mock("@api/editing", () => ({
  useEditing: () => ({
    startEditing: async (value: string) => {
      h.opened.push(value);
    },
  }),
  setGlobalCursorPosition: (p: number) => h.cursor.push(p),
}));

import extension from "../index";
import { AutoSumEditHost } from "../components/AutoSumEditHost";
import { hasEditOpener } from "../lib/editOpener";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { getShellComponents } from "@api/ui";
import { setSelection } from "@api/grid";
import { registerSelectionOwner } from "@api/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SET_SELECTION = setSelection(0, 0, 0, 0).type;
const num = (row: number, col: number, value: number) => ({ row, col, value, display: String(value), formula: null, type: "number" });

let unmountHost: () => void = () => {};

beforeAll(async () => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
  // Mount the host the way the shell frame would.
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(AutoSumEditHost));
  });
  unmountHost = () => {
    act(() => root.unmount());
    el.remove();
  };
});
afterAll(() => {
  unmountHost();
  extension.deactivate?.();
});

beforeEach(() => {
  h.cells = [num(0, 0, 1), num(1, 0, 2), num(2, 0, 3)];
  h.used = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, empty: false };
  h.snapshot = { surface: "grid", selection: { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } };
  h.dispatched = [];
  h.writes = [];
  h.writeError = null;
  h.toasts = [];
  h.opened = [];
  h.cursor = [];
  h.undo = { open: null, committed: [], dropped: [] };
});

describe("autosum.insert", () => {
  it("is registered, and its edit host is contributed to the shell frame", () => {
    expect(CommandRegistry.has(ExtensionCommands.AUTOSUM)).toBe(true);
    expect(getShellComponents().map((c) => c.id)).toContain("autosum.editHost");
    expect(hasEditOpener(), "the mounted host did not lend Core's opener").toBe(true);
  });

  it("one cell: opens Core's edit holding the guess, caret before ')', and writes nothing", async () => {
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.opened).toEqual(["=SUM(A1:A3)"]);
    expect(h.cursor).toEqual(["=SUM(A1:A3".length]);
    expect(h.writes).toEqual([]);
    expect(h.undo.committed).toEqual([]);
  });

  it("{ fn } picks the function (any case); an unknown one is refused", async () => {
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM, { fn: "average" });
    expect(h.opened).toEqual(["=AVERAGE(A1:A3)"]);
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM, { fn: "MEDIAN" });
    expect(h.opened).toHaveLength(1);
    expect(h.toasts[0]).toMatch(/MEDIAN/);
  });

  it("a range: the totals in ONE undo step, invariant formulas, the selection grows over them", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.writes).toEqual([[{ row: 3, col: 0, value: "=SUM(A1:A3)", invariant: true }]]);
    expect(h.undo.committed).toEqual(["AutoSum"]);
    const sel = h.dispatched.find((a) => a.type === SET_SELECTION)?.payload;
    expect(sel).toMatchObject({ startRow: 0, startCol: 0, endRow: 3, endCol: 0 });
  });

  it("inside a script's open batch it writes INTO the batch and leaves it open", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    h.undo.open = { label: "Script batch", ticket: 1 };
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.writes).toHaveLength(1);
    expect(h.undo.committed).toEqual([]);
    expect(h.undo.open?.label).toBe("Script batch");
  });

  it("a refused write (protected sheet) cancels its own step and says why", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    h.writeError = "Cell A4 is protected";
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.undo.dropped).toEqual(["AutoSum"]);
    expect(h.toasts).toEqual(["Cell A4 is protected"]);
    expect(h.dispatched.filter((a) => a.type === SET_SELECTION)).toEqual([]);
  });

  // Excel's Go To Special > Blanks then Alt+= (measured live 2026-10-04, build
  // 20430): a total in every blank area, ONE undo step, the areas still
  // selected. This used to be refused ("cannot be used on multiple selections").
  it("several areas: a total in each, ONE batch in ONE undo step, every area still selected", async () => {
    h.cells = [num(0, 0, 1), num(1, 0, 2), num(2, 0, 3), num(4, 0, 50), num(5, 0, 60), num(6, 0, 70)];
    h.used = { startRow: 0, startCol: 0, endRow: 6, endCol: 0, empty: false };
    h.snapshot.selection = {
      startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells",
      additionalRanges: [{ startRow: 7, startCol: 0, endRow: 7, endCol: 0 }],
    };
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.writes).toEqual([
      [
        { row: 3, col: 0, value: "=SUM(A1:A3)", invariant: true },
        { row: 7, col: 0, value: "=SUM(A5:A7)", invariant: true },
      ],
    ]);
    expect(h.undo.committed).toEqual(["AutoSum"]);
    expect(h.opened).toEqual([]);
    const sel = h.dispatched.find((a) => a.type === SET_SELECTION)?.payload;
    expect(sel).toMatchObject({
      startRow: 3, startCol: 0, endRow: 3, endCol: 0,
      additionalRanges: [{ startRow: 7, startCol: 0, endRow: 7, endCol: 0 }],
    });
  });

  it("several areas, one with nothing to total: the active cell's edit opens and nothing is written", async () => {
    h.snapshot.selection = {
      startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells",
      additionalRanges: [{ startRow: 9, startCol: 4, endRow: 9, endCol: 4 }],
    };
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.opened).toEqual(["=SUM(A1:A3)"]);
    expect(h.writes).toEqual([]);
    expect(h.undo.committed).toEqual([]);
  });

  it("refuses on a canvas sheet and while an object owns the selection", async () => {
    h.snapshot.surface = "canvas";
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    h.snapshot.surface = "grid";
    h.snapshot.selection = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" };
    const release = registerSelectionOwner({
      id: "test.owner", label: "the object", fallback: true, ownsSelection: () => true,
      refusal: (a) => `${a} is not available while an object is selected.`,
    });
    try {
      await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    } finally {
      release();
    }
    expect(h.opened).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.toasts).toEqual([
      "AutoSum is not available on a canvas sheet: it holds objects, not cells.",
      "AutoSum is not available while an object is selected.",
    ]);
  });

  it("an edit's arguments use the user's list separator (sv-SE ';')", async () => {
    h.cells = [
      num(0, 0, 1), num(1, 0, 2),
      { row: 2, col: 0, value: 3, display: "3", formula: "=SUM(A1:A2)", type: "number" },
      num(3, 0, 4),
      { row: 4, col: 0, value: 4, display: "4", formula: "=SUM(A4)", type: "number" },
    ];
    h.used = { startRow: 0, startCol: 0, endRow: 4, endCol: 0, empty: false };
    h.snapshot.selection = { startRow: 5, startCol: 0, endRow: 5, endCol: 0, type: "cells" };
    await CommandRegistry.execute(ExtensionCommands.AUTOSUM);
    expect(h.opened).toEqual(["=SUM(A5;A3)"]);
  });
});
