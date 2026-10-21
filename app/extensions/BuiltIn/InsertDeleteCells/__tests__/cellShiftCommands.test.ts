//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/__tests__/cellShiftCommands.test.ts
// PURPOSE: core.grid.insert / delete / insertCells / deleteCells decide what
//          Excel decides and every refusal reaches the user.
// CONTEXT: Home tab 2026-10-04. Drives the real activation and the real command
//          registry; the backend wrappers, the dialogs, the grid snapshot and
//          the selection owner are doubles. The shape rule and the dialog
//          defaults were measured on live Excel 16 (build 20326).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  selection: null as Record<string, unknown> | null,
  owned: false,
  calls: [] as Array<{ op: string; args: unknown[] }>,
  results: [] as Array<unknown>,
  alerts: [] as string[],
  confirms: [] as string[],
  confirmAnswer: true,
  shown: [] as Array<{ id: string; data: Record<string, unknown> | undefined }>,
  refreshed: 0,
  executed: [] as Array<{ id: string; args: unknown }>,
  config: null as { totalRows: number; totalCols: number } | null,
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  insertCellsRange: vi.fn(async (...args: unknown[]) => {
    h.calls.push({ op: "insert", args });
    const next = h.results.shift();
    if (next instanceof Error) throw next;
    return next ?? { applied: true, confirm: null, wholeLines: false };
  }),
  deleteCellsRange: vi.fn(async (...args: unknown[]) => {
    h.calls.push({ op: "delete", args });
    const next = h.results.shift();
    if (next instanceof Error) throw next;
    return next ?? { applied: true, confirm: null, wholeLines: false };
  }),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: async (message: string) => {
    h.alerts.push(message);
  },
  // The Tauri SHAPE (a promise), never a bare boolean -- CLAUDE.md.
  confirmAsync: (message: string) => {
    h.confirms.push(message);
    return Promise.resolve(h.confirmAnswer);
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () =>
    h.selection ? (h.config ? { selection: h.selection, config: h.config } : { selection: h.selection }) : null,
  refreshGridData: () => {
    h.refreshed += 1;
  },
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
}));
import extension, { INSERT_CELLS_DIALOG_ID, DELETE_CELLS_DIALOG_ID, resetRememberedChoices } from "../index";
import { MULTIPLE_SELECTIONS, shapeShift, readShiftArg } from "../lib/cellShift";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerSelectionOwner, type CellTargetCapability, type SelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

// The selection OWNER is real (@api/selectionOwner): a test owner that holds
// the selection while `h.owned` is true and admits nothing, and -- for the
// floating-grid cases (P3) -- a double shaped like the floating grid's owner,
// which admits every capability but "table", "filter" and "shiftCells".
const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));
registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => h.owned });

const FR_ADMITS: readonly CellTargetCapability[] = [
  "read", "format", "numberFormat", "content", "clear", "sort", "structure", "lineSize", "merge", "conditionalFormat",
];
const SHIFT_SENTENCE = (action: string) => `${action} is not available inside a floating grid yet. Nothing was changed.`;
let frSelection: Record<string, unknown> | null = null;
const frOwner: SelectionOwner = {
  id: "test-floating-grid",
  label: "a floating grid's cells",
  ownsSelection: () => frSelection !== null,
  actsOn: FR_ADMITS,
  cellTarget: () =>
    frSelection === null
      ? null
      : {
          ref: { kind: "floatingRange", id: "fr-1" },
          selection: frSelection as never,
          bounds: { rows: 10, cols: 4 },
          label: "Float1",
          wholeObject: false,
        },
  refusal: (action: string, capability?: CellTargetCapability) =>
    capability === "shiftCells" ? SHIFT_SENTENCE(action) : `${action} is not available inside a floating grid yet. Nothing was changed.`,
};
registerSelectionOwner(frOwner);

const LINE_COMMANDS = [
  CoreCommands.INSERT_ROW,
  CoreCommands.INSERT_COLUMN,
  CoreCommands.DELETE_ROW,
  CoreCommands.DELETE_COLUMN,
];
const realExecute = CommandRegistry.execute.bind(CommandRegistry);

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
    },
    ui: { dialogs: { register: () => {}, unregister: () => {}, show: () => {} } },
  } as never);
  // The whole-row / whole-column grid commands are Core's; record them here.
  vi.spyOn(CommandRegistry, "execute").mockImplementation(async (id: string, args?: unknown) => {
    if (LINE_COMMANDS.includes(id)) {
      h.executed.push({ id, args });
      return undefined;
    }
    return realExecute(id, args);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  extension.deactivate?.();
});

beforeEach(() => {
  h.selection = { startRow: 3, startCol: 3, endRow: 3, endCol: 3, type: "cells" };
  h.owned = false;
  h.calls = [];
  h.results = [];
  h.alerts = [];
  h.confirms = [];
  h.confirmAnswer = true;
  h.shown = [];
  h.refreshed = 0;
  h.executed = [];
  h.config = null;
  frSelection = null;
  toasts.length = 0;
  resetRememberedChoices();
});

const cells = (startRow: number, startCol: number, endRow: number, endCol: number, extra: Record<string, unknown> = {}) => ({
  startRow,
  startCol,
  endRow,
  endCol,
  type: "cells",
  ...extra,
});

describe("Excel's shape rule for an unnamed shift (Range.Insert / Range.Delete, measured)", () => {
  it.each([
    ["D4:F4 (1x3)", "down", "up", [3, 3, 3, 5]],
    ["D4:D6 (3x1)", "right", "left", [3, 3, 5, 3]],
    ["D4:E5 (square)", "down", "up", [3, 3, 4, 4]],
    ["D4 (one cell)", "down", "up", [3, 3, 3, 3]],
    ["D4:F5 (2x3)", "down", "up", [3, 3, 4, 5]],
    ["D4:E6 (3x2)", "right", "left", [3, 3, 5, 4]],
  ] as const)("%s inserts %s and deletes %s", (_label, insert, del, [r0, c0, r1, c1]) => {
    const rect = { startRow: r0, startCol: c0, endRow: r1, endCol: c1 };
    expect(shapeShift("insert", rect)).toBe(insert);
    expect(shapeShift("delete", rect)).toBe(del);
  });
});

describe("readShiftArg", () => {
  it("knows each dialog's four choices and nothing else", () => {
    expect(readShiftArg("insert", undefined)).toEqual({ kind: "none" });
    expect(readShiftArg("insert", { shift: "down" })).toEqual({ kind: "choice", choice: "down" });
    expect(readShiftArg("delete", { shift: "entireColumn" })).toEqual({ kind: "choice", choice: "entireColumn" });
    expect(readShiftArg("insert", { shift: "left" }).kind).toBe("invalid");
    expect(readShiftArg("delete", { shift: "down" }).kind).toBe("invalid");
  });
});

describe("core.grid.insert / core.grid.delete (the split buttons' main halves)", () => {
  it("a tall cell range inserts cells shifted right and refreshes the grid", async () => {
    h.selection = cells(3, 3, 5, 3);
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.calls).toEqual([{ op: "insert", args: [3, 3, 5, 3, "right", { unmergeCutMerges: false }] }]);
    expect(h.refreshed).toBe(1);
  });

  it("a wide cell range deletes cells shifted up", async () => {
    h.selection = cells(3, 5, 3, 3);
    await CommandRegistry.execute(CoreCommands.DELETE);
    expect(h.calls).toEqual([{ op: "delete", args: [3, 3, 3, 5, "up", { unmergeCutMerges: false }] }]);
  });

  it("whole rows and whole columns run the row / column commands", async () => {
    h.selection = { startRow: 1, startCol: 0, endRow: 2, endCol: 16383, type: "rows" };
    await CommandRegistry.execute(CoreCommands.INSERT);
    h.selection = { startRow: 0, startCol: 4, endRow: 1048575, endCol: 4, type: "columns" };
    await CommandRegistry.execute(CoreCommands.DELETE);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW, CoreCommands.DELETE_COLUMN]);
    expect(h.calls).toEqual([]);
  });

  it("a Ctrl+click selection is refused with Excel's sentence", async () => {
    h.selection = cells(1, 1, 2, 2, { additionalRanges: [{ startRow: 5, startCol: 5, endRow: 5, endCol: 5 }] });
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.alerts).toEqual([MULTIPLE_SELECTIONS]);
    expect(h.calls).toEqual([]);
  });

  it("an object that owns the selection refuses it before anything runs", async () => {
    h.owned = true;
    await CommandRegistry.execute(CoreCommands.INSERT);
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "up" });
    expect(h.calls).toEqual([]);
    expect(h.shown).toEqual([]);
    expect(h.executed).toEqual([]);
    expect(toasts.length, "each refused door says it once").toBe(2);
  });

  it("a backend refusal reaches the user and nothing is refreshed", async () => {
    h.results = [new Error("This won't work because it would move cells in a table on your worksheet.")];
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.alerts).toEqual(["This won't work because it would move cells in a table on your worksheet."]);
    expect(h.refreshed).toBe(0);
  });
});

describe("Excel's question before it unmerges", () => {
  const question = "This operation will cause some merged cells to unmerge. Do you wish to continue?";

  it("OK runs the shift again, unmerging", async () => {
    h.results = [{ applied: false, confirm: question, wholeLines: false }];
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.confirms).toEqual([question]);
    expect(h.calls.map((c) => c.args[5])).toEqual([{ unmergeCutMerges: false }, { unmergeCutMerges: true }]);
    expect(h.refreshed).toBe(1);
  });

  it("Cancel changes nothing", async () => {
    h.confirmAnswer = false;
    h.results = [{ applied: false, confirm: question, wholeLines: false }];
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "left" });
    expect(h.calls).toHaveLength(1);
    expect(h.refreshed).toBe(0);
  });
});

describe("core.grid.insertCells / deleteCells", () => {
  it("a named shift runs at once, entire row / column run the line commands", async () => {
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "entireColumn" });
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "entireRow" });
    expect(h.calls.map((c) => c.args[4])).toEqual(["down"]);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_COLUMN, CoreCommands.DELETE_ROW]);
  });

  it("an unknown shift is refused out loud", async () => {
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "left" });
    expect(h.alerts[0]).toMatch(/does not know the shift "left"/);
    expect(h.calls).toEqual([]);
  });

  it("no argument opens the dialog on its first option, then remembers the last choice", async () => {
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].id).toBe(INSERT_CELLS_DIALOG_ID);
    expect(h.shown[0].data?.initial).toBe("right");
    expect(h.calls).toEqual([]);

    (h.shown[0].data?.onChoose as (c: string) => void)("down");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].args.slice(0, 5)).toEqual([3, 3, 3, 3, "down"]);

    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown[1].data?.initial).toBe("down");

    await CommandRegistry.execute(CoreCommands.DELETE_CELLS);
    expect(h.shown[2].id).toBe(DELETE_CELLS_DIALOG_ID);
    expect(h.shown[2].data?.initial).toBe("left");
  });

  it("whole rows skip the dialog", async () => {
    h.selection = { startRow: 4, startCol: 0, endRow: 4, endCol: 16383, type: "rows" };
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS);
    expect(h.shown).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.DELETE_ROW]);
  });
});

// Classified by SHAPE, not by Selection.type: Ctrl+A commits a "cells"
// selection over the whole sheet, and a cells-typed range that spans every
// column used to reach insertCellsRange, whose whole-line branch called
// insertRows(0, 1048576) directly -- past Core's row gesture and its
// "shifted off the worksheet" refusal (review finding, 2026-10-04).
describe("a range that spans every column (row) is entire rows (columns), whatever its type", () => {
  const selectAll = () => cells(0, 0, 1048575, 16383);

  it("Select All then the Insert main half runs Core's Insert Sheet Rows, never a cell shift", async () => {
    h.selection = selectAll();
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.calls).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW]);
  });

  it("Select All then Ctrl+Plus skips the dialog and runs Insert Sheet Rows", async () => {
    h.selection = selectAll();
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW]);
  });

  it("Select All then Delete runs Delete Sheet Rows", async () => {
    h.selection = selectAll();
    await CommandRegistry.execute(CoreCommands.DELETE);
    expect(h.calls).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.DELETE_ROW]);
  });

  it("a full-width cells range runs the row commands for every named cell shift", async () => {
    h.selection = cells(2, 0, 3, 16383);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "right" });
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "up" });
    expect(h.calls).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([
      CoreCommands.INSERT_ROW,
      CoreCommands.INSERT_ROW,
      CoreCommands.DELETE_ROW,
    ]);
  });

  it("a full-height cells range runs the column commands, from the main half and the dialog alike", async () => {
    h.selection = cells(0, 4, 1048575, 5);
    await CommandRegistry.execute(CoreCommands.DELETE);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "left" });
    expect(h.shown).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.executed.map((e) => e.id)).toEqual([
      CoreCommands.DELETE_COLUMN,
      CoreCommands.INSERT_COLUMN,
      CoreCommands.DELETE_COLUMN,
    ]);
  });

  it("the sheet size comes from the grid's config when it has one", async () => {
    h.config = { totalRows: 100, totalCols: 10 };
    h.selection = cells(5, 0, 6, 9);
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW]);
    expect(h.calls).toEqual([]);
  });

  it("one column short of the sheet's width is still a cell shift", async () => {
    h.selection = cells(2, 0, 3, 16382);
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.executed).toEqual([]);
    expect(h.calls.map((c) => c.args[4])).toEqual(["down"]);
  });
});

// P3 (owner finding G3): a floating grid's cells. Entire rows / columns are
// the GRID's own lines (capability "structure"), run through the row / column
// grid commands, whose door hands the target on. A cell SHIFT asks
// "shiftCells", which no floating grid admits this round: refused with the
// grid's sentence, and no wrapper is called.
describe("on a floating grid's cells", () => {
  it("Insert Cells (shift down) refuses with the floating grid's sentence and calls no wrapper", async () => {
    frSelection = cells(1, 1, 1, 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "left" });
    expect(h.calls, "a cell shift reached the active-sheet backend").toEqual([]);
    expect(h.executed).toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([SHIFT_SENTENCE("Insert Cells"), SHIFT_SENTENCE("Delete Cells")]);
  });

  it("the main half's cell shift refuses the same way; Core's selection is never read", async () => {
    frSelection = cells(2, 1, 2, 2);
    h.selection = cells(2, 1, 2, 2);
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.calls).toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([SHIFT_SENTENCE("Insert Cells")]);
  });

  it("\"Entire row\" / \"Entire column\" run the row / column grid commands (whose door hands the target on)", async () => {
    frSelection = cells(1, 1, 1, 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "entireRow" });
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "entireColumn" });
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW, CoreCommands.DELETE_COLUMN]);
    expect(h.calls).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("a selection spanning every column of the GRID is its entire rows (measured against its extent, not the sheet)", async () => {
    frSelection = cells(3, 0, 4, 3);
    await CommandRegistry.execute(CoreCommands.INSERT);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.executed.map((e) => e.id)).toEqual([CoreCommands.INSERT_ROW, CoreCommands.INSERT_ROW]);
    expect(h.shown, "the dialog opened over whole lines").toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("no argument opens the dialog over the GRID's selection; choosing a shift then refuses", async () => {
    frSelection = cells(1, 1, 2, 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toHaveLength(1);
    (h.shown[0].data?.onChoose as (c: string) => void)("right");
    await vi.waitFor(() => expect(toasts.map((t) => t.message)).toEqual([SHIFT_SENTENCE("Insert Cells")]));
    expect(h.calls).toEqual([]);
  });
});
