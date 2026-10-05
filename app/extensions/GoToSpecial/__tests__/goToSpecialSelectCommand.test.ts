//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialSelectCommand.test.ts
// PURPOSE: `goToSpecial.select { criteria }` -- the command Excel's Find &
//          Select quick items run (Formulas, Notes, Conditional Formatting,
//          Constants, Data Validation) -- selects the matching cells DIRECTLY,
//          through the same search the Go To Special dialog's OK uses.
// CONTEXT: Home tab 2026-10-04. The dialog could not open pre-set, and its
//          search lived in its OK handler, so the quick items had nothing to
//          call. Drives the real extension activation and the real command
//          registry; the backend search, the grid snapshot and the dispatch are
//          doubles.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  matches: [] as Array<{ row: number; col: number }>,
  searches: [] as Array<{ criteria: string; range: unknown }>,
  dispatched: [] as Array<{ type: string; payload: unknown }>,
  toasts: [] as string[],
  snapshot: {
    surface: "grid" as "grid" | "canvas",
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown>,
  },
  used: { startRow: 0, startCol: 0, endRow: 49, endCol: 9, empty: false },
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  goToSpecial: vi.fn(async (criteria: string, range?: unknown) => {
    h.searches.push({ criteria, range });
    return { cells: h.matches };
  }),
  getGridStateSnapshot: () => h.snapshot,
}));
vi.mock("@api/gridDispatch", () => ({
  dispatchGridAction: (action: { type: string; payload: unknown }) => h.dispatched.push(action),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getUsedRange: async () => h.used,
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));

import extension from "../index";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { setSelection, scrollToCell } from "@api/grid";

// The action types, read off the real creators (a test may not import Core).
const GRID_ACTIONS = {
  SET_SELECTION: setSelection(0, 0, 0, 0).type,
  SCROLL_TO_CELL: scrollToCell(0, 0).type,
};

const select = (criteria: unknown) => CommandRegistry.execute(ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria });

const selections = () =>
  h.dispatched.filter((a) => a.type === GRID_ACTIONS.SET_SELECTION).map((a) => a.payload as Record<string, unknown>);

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
    },
    ui: {
      dialogs: { register: () => {}, unregister: () => {}, show: () => {} },
      menus: { registerItem: () => {}, unregisterItem: () => {} },
    },
  } as never);
});
afterAll(() => extension.deactivate?.());

beforeEach(() => {
  h.matches = [];
  h.searches = [];
  h.dispatched = [];
  h.toasts = [];
  h.snapshot = { surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } };
  h.used = { startRow: 0, startCol: 0, endRow: 49, endCol: 9, empty: false };
});

describe("goToSpecial.select", () => {
  it("is registered by the extension", () => {
    expect(CommandRegistry.has(ExtensionCommands.GO_TO_SPECIAL_SELECT)).toBe(true);
  });

  it("Constants from one cell: searches the whole sheet and selects EXACTLY the constants", async () => {
    h.matches = [
      { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 4, col: 2 },
    ];
    await select("constants");
    expect(h.searches).toEqual([{ criteria: "constants", range: undefined }]);
    const [sel] = selections();
    // Main range = the A1:B2 block, active A1; C5 is the second area.
    expect(sel).toMatchObject({ startRow: 1, startCol: 1, endRow: 0, endCol: 0, type: "cells" });
    expect(sel.additionalRanges).toEqual([{ startRow: 4, startCol: 2, endRow: 4, endCol: 2 }]);
    // The active cell is scrolled into view.
    expect(h.dispatched.some((a) => a.type === GRID_ACTIONS.SCROLL_TO_CELL)).toBe(true);
  });

  it("within a multi-cell selection it searches only there (clipped to the used extent for a scan)", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2, type: "columns" };
    h.matches = [{ row: 3, col: 2 }];
    await select("formulas");
    expect(h.searches).toEqual([
      { criteria: "formulas", range: { startRow: 0, startCol: 2, endRow: 49, endCol: 2 } },
    ]);
  });

  it("Notes are not clipped (the backend walks the notes, not the cells)", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2, type: "columns" };
    await select("notes");
    expect(h.searches).toEqual([
      { criteria: "notes", range: { startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2 } },
    ]);
  });

  it("nothing found: Excel's sentence, and the selection is left alone", async () => {
    await select("dataValidation");
    expect(h.toasts).toEqual(["No cells were found."]);
    expect(selections()).toEqual([]);
  });

  it("refuses on a canvas sheet, without searching", async () => {
    h.snapshot.surface = "canvas";
    await select("constants");
    expect(h.searches).toEqual([]);
    expect(selections()).toEqual([]);
    expect(h.toasts[0]).toMatch(/canvas/);
  });

  it("refuses while an object owns the selection, without searching", async () => {
    const release = registerSelectionOwner({
      id: "test.owner",
      label: "the object",
      fallback: true,
      ownsSelection: () => true,
      refusal: (action) => `${action} is not available while an object is selected.`,
    });
    try {
      await select("formulas");
    } finally {
      release();
    }
    expect(h.searches).toEqual([]);
    expect(selections()).toEqual([]);
    expect(h.toasts).toEqual(["Go To Special is not available while an object is selected."]);
  });

  it("refuses a criteria it does not know, out loud", async () => {
    await select("everything");
    expect(h.searches).toEqual([]);
    expect(h.toasts[0]).toMatch(/everything/);
  });
});
