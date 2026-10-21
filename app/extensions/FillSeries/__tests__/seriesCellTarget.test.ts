//! FILENAME: app/extensions/FillSeries/__tests__/seriesCellTarget.test.ts
// PURPOSE: Fill > Series on a floating grid's cells (P3 S11, owner finding
//          G3): the command door resolves the grid's cells ("content") and
//          opens the dialog; the dialog's OK re-asks silently, reads the
//          OBJECT's cells (typed + styled reads of @api/cellTarget, never the
//          active sheet's) and writes the series with the target in ONE undo
//          step. A lone cell runs on to Stop only inside the object's extent.
//          An owner that admits no "content" refuses (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  objectTyped: [] as Array<{ row: number; col: number; value: number | string; display: string; formula: string | null; type: string }>,
  sheetReads: 0,
  objectReads: [] as string[],
  writes: [] as unknown[][],
  shown: [] as Array<{ id: string; data?: Record<string, unknown> }>,
  toasts: [] as string[],
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getRangeCellsTyped: async () => {
    h.sheetReads++;
    return [];
  },
  getViewportCells: async () => {
    h.sheetReads++;
    return [];
  },
  updateCellsBatch: async (...a: unknown[]) => {
    h.writes.push(a);
    return [];
  },
  beginUndoTransaction: async () => 3,
  commitUndoTransaction: async () => {},
  cancelUndoTransaction: async () => {},
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: async (_ref: unknown, r: { startRow: number; startCol: number; endRow: number; endCol: number }) => {
    h.objectReads.push("typed");
    return h.objectTyped.filter((c) => c.row >= r.startRow && c.row <= r.endRow && c.col >= r.startCol && c.col <= r.endCol);
  },
  getCellTargetCells: async (_ref: unknown, r: { startRow: number; startCol: number; endRow: number; endCol: number }) => {
    h.objectReads.push("styled");
    const cells = h.objectTyped
      .filter((c) => c.row >= r.startRow && c.row <= r.endRow && c.col >= r.startCol && c.col <= r.endCol)
      .map((c) => ({ row: c.row, col: c.col, display: c.display, formula: c.formula, styleIndex: 7, valueKind: c.type }));
    return { cells, merges: [], conditional: [], styles: [], rules: [] };
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  // Core's hidden cell under the object: a canvas page, so a sheet read would
  // be refused -- the object's cells must not be.
  getGridStateSnapshot: () => ({ surface: "canvas", selection: { startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" } }),
  refreshGridData: () => {},
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));

import extension, { SERIES_DIALOG_ID } from "../index";
import { runSeries } from "../lib/runSeries";
import type { SeriesOptions } from "../lib/seriesPlan";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const opts = (o: Partial<SeriesOptions> = {}): SeriesOptions => ({
  seriesIn: "columns",
  type: "linear",
  dateUnit: "day",
  step: 1,
  stop: null,
  trend: false,
  ...o,
});

let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["content"];
let release: () => void = () => {};

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
    ui: { dialogs: { register: () => {}, unregister: () => {} } },
  } as never);
});
afterAll(() => extension.deactivate?.());

beforeEach(() => {
  h.objectTyped = [{ row: 1, col: 0, value: 5, display: "5", formula: null, type: "number" }];
  h.sheetReads = 0;
  h.objectReads = [];
  h.writes = [];
  h.shown = [];
  h.toasts = [];
  actsOn = ["content"];
  frSelection = { startRow: 1, startCol: 0, endRow: 4, endCol: 0, type: "cells", activeRow: 1, activeCol: 0 };
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 6, cols: 3 }, label: "Float1", wholeObject: false },
  });
});
afterEach(() => release());

describe("Fill > Series on a floating grid's cells", () => {
  it("the command opens the dialog for the OBJECT's selection (a canvas host does not refuse it)", async () => {
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    expect(h.toasts).toEqual([]);
    expect(h.shown).toEqual([{ id: SERIES_DIALOG_ID, data: { seriesIn: "columns" } }]);
  });

  it("OK fills the object's cells from its own start value, with the target, reading nothing of the sheet", async () => {
    expect(await runSeries(opts({ step: 2 }))).toBeNull();
    expect(h.sheetReads).toBe(0);
    expect(h.objectReads.length).toBeGreaterThan(0);
    expect(h.writes).toHaveLength(1);
    const [updates, placement] = h.writes[0] as [Array<{ row: number; col: number; value: string }>, unknown];
    expect(placement).toEqual({ target: REF });
    expect(updates.map((u) => [u.row, u.col, u.value])).toEqual([
      [2, 0, "7"],
      [3, 0, "9"],
      [4, 0, "11"],
    ]);
  });

  it("a lone cell runs on to Stop only as far as the object's extent", async () => {
    frSelection = { startRow: 1, startCol: 0, endRow: 1, endCol: 0, type: "cells", activeRow: 1, activeCol: 0 };
    expect(await runSeries(opts({ stop: 100 }))).toBeNull();
    const [updates] = h.writes[0] as [Array<{ row: number }>];
    expect(Math.max(...updates.map((u) => u.row))).toBe(5); // the object's last row (6 rows)
  });

  it("inert until the owner admits \"content\": the door refuses once and opens nothing", async () => {
    actsOn = [];
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    expect(h.shown).toEqual([]);
    expect(h.toasts).toEqual(["Series is not available inside a floating grid yet. Nothing was changed."]);
    expect(await runSeries(opts())).toBe("Series is not available inside a floating grid yet. Nothing was changed.");
    expect(h.writes).toEqual([]);
  });
});
