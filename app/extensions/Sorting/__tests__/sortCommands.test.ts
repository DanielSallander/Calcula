//! FILENAME: app/extensions/Sorting/__tests__/sortCommands.test.ts
// PURPOSE: sort.ascending / sort.descending / sort.customDialog sort what
//          EXCEL sorts -- measured in live Excel 2026-10-04:
//            - one selected cell: the block of data around it, the first row
//              kept as a header when Excel's guess says it is one (text over
//              numbers: yes; text over text, numbers over numbers, a bold text
//              row over text: no);
//            - several cells: exactly the selection, by the ACTIVE cell's
//              column (rows outside it and columns beside it stay put);
//            - one selected column inside wider data: Excel's Sort Warning --
//              expand to the block (default) or continue with the column.
// CONTEXT: The Data menu's quick sort ignored the selection entirely (it always
//          sorted the region around the active cell) and always assumed a
//          header row, so an all-text list never sorted its first item; and
//          neither sort had a command id the Home tab could run. Drives the
//          real extension; the backend, the grid snapshot and the dialogs are
//          doubles.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

type Cell = string | number | null;

const h = vi.hoisted(() => ({
  /** The sheet, row-major from A1. */
  grid: [] as Array<Array<string | number | null>>,
  region: null as [number, number, number, number] | null,
  sorts: [] as unknown[][],
  sortError: null as string | null,
  snapshot: {
    surface: "grid" as "grid" | "canvas",
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown>,
  },
  shown: [] as Array<{ id: string; data?: Record<string, unknown> }>,
  toasts: [] as string[],
  table: null as null | Record<string, unknown>,
  filter: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
  reapplied: 0,
  reapplyError: null as string | null,
  /** Undo transaction + write order: begin / sort / reapply / commit:<t> / cancel:<t>. */
  undoLog: [] as string[],
  used: { startRow: 0, startCol: 0, endRow: 20, endCol: 10, empty: false },
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  detectDataRegion: async () => h.region,
  sortRangeByColumn: async (...args: unknown[]) => {
    h.sorts.push(args);
    h.undoLog.push("sort");
    if (h.sortError) throw new Error(h.sortError);
    return { success: true };
  },
  beginUndoTransaction: async (label: string) => {
    h.undoLog.push(`begin:${label}`);
    return 7;
  },
  commitUndoTransaction: async (ticket?: number | null) => {
    h.undoLog.push(`commit:${ticket}`);
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    h.undoLog.push(`cancel:${ticket}`);
  },
  getUsedRange: async () => h.used,
  getRangeCellsTyped: async (sr: number, sc: number, er: number, ec: number) => {
    const out: unknown[] = [];
    for (let r = sr; r <= er; r++) {
      for (let c = sc; c <= ec; c++) {
        const v = h.grid[r]?.[c] ?? null;
        if (v === null) continue;
        out.push({ row: r, col: c, value: v, display: String(v), formula: null, type: typeof v === "number" ? "number" : "text" });
      }
    }
    return out;
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.snapshot,
  refreshGridData: () => {},
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getTableAtCell: async () => h.table,
}));
vi.mock("@api/autoFilterService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/autoFilterService")>()),
  getAutoFilterStatus: () => ({ hasFilter: h.filter !== null, isDataFiltered: false }),
  hasAutoFilterController: () => true,
  requireAutoFilterController: () => ({
    get: async () => (h.filter ? { ...h.filter, id: "af", enabled: true, isDataFiltered: false, columns: [], hiddenRows: [] } : null),
    reapply: async () => {
      h.reapplied++;
      h.undoLog.push("reapply");
      if (h.reapplyError) throw new Error(h.reapplyError);
      return {};
    },
  }),
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));

import extension from "../index";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { answerSortWarning, isSortWarningPending, SORT_WARNING_DIALOG_ID } from "../lib/sortWarning";
import { guessHasHeaders } from "../lib/quickSort";
import { registerSelectionOwner } from "@api/selectionOwner";

/** Put a block of values on the sheet with its top-left at (row, col). */
function put(row: number, col: number, rows: Cell[][]): void {
  rows.forEach((values, r) =>
    values.forEach((v, c) => {
      h.grid[row + r] ??= [];
      h.grid[row + r][col + c] = v;
    }),
  );
}
/** Core's selection: (startRow, startCol) is the ANCHOR, (endRow, endCol) the
 *  ACTIVE cell -- always a corner of the range in Core's model. */
function select(anchorRow: number, anchorCol: number, activeRow: number, activeCol: number): void {
  h.snapshot.selection = { startRow: anchorRow, startCol: anchorCol, endRow: activeRow, endCol: activeCol, type: "cells" };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
    },
    ui: {
      dialogs: {
        register: () => {},
        unregister: () => {},
        show: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
      },
      menus: { registerItem: () => {}, unregisterItem: () => {} },
    },
  } as never);
});
afterAll(() => extension.deactivate?.());

beforeEach(() => {
  h.grid = [];
  h.region = null;
  h.sorts = [];
  h.sortError = null;
  h.shown = [];
  h.toasts = [];
  h.table = null;
  h.filter = null;
  h.reapplied = 0;
  h.reapplyError = null;
  h.undoLog = [];
  h.snapshot = { surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } };
  h.used = { startRow: 0, startCol: 0, endRow: 20, endCol: 10, empty: false };
  if (isSortWarningPending()) answerSortWarning("cancel");
});

describe("Excel's header guess (measured live)", () => {
  const cellsOf = (rows: Cell[][]) => {
    const out: Array<{ row: number; col: number; value: string | number; display: string; formula: null; type: "number" | "text" }> = [];
    rows.forEach((vals, r) =>
      vals.forEach((v, c) => {
        if (v !== null) out.push({ row: r, col: c, value: v, display: String(v), formula: null, type: typeof v === "number" ? "number" : "text" });
      }),
    );
    return out;
  };
  const range = (rows: Cell[][]) => ({ startRow: 0, startCol: 0, endRow: rows.length - 1, endCol: rows[0].length - 1 });
  const guess = (rows: Cell[][]) => guessHasHeaders(cellsOf(rows), range(rows));

  it("text over numbers is a header (C1)", () => {
    expect(guess([["Name", "Val"], ["d", 4], ["b", 2]])).toBe(true);
  });
  it("text over text is not (C2, C7)", () => {
    expect(guess([["d"], ["b"], ["c"]])).toBe(false);
    expect(guess([["Name", "City"], ["d", "x"], ["b", "y"]])).toBe(false);
  });
  it("numbers over numbers is not, even a 'year' row (C4, C6)", () => {
    expect(guess([[5], [3], [4]])).toBe(false);
    expect(guess([[2020, 2021], [4, 40], [2, 20]])).toBe(false);
  });
  it("a number in the first row makes it data (C14)", () => {
    expect(guess([[3], ["b"], [1]])).toBe(false);
  });
  it("one row cannot have a header", () => {
    expect(guess([["Name", "Val"]])).toBe(false);
  });
});

describe("Sort A to Z / Z to A", () => {
  it("are registered under the contract's ids", () => {
    for (const id of [ExtensionCommands.SORT_ASCENDING, ExtensionCommands.SORT_DESCENDING, ExtensionCommands.SORT_CUSTOM]) {
      expect(CommandRegistry.has(id), id).toBe(true);
    }
  });

  it("one cell: sorts the block around it by the active column, header kept (C1)", async () => {
    put(0, 0, [["Name", "Val"], ["d", 4], ["b", 2], ["c", 3], ["a", 1]]);
    h.region = [0, 0, 4, 1];
    select(2, 1, 2, 1);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[0, 0, 4, 1, 1, true, true]]);
  });

  it("one cell in an all-text list: the first item is sorted too (C2: no header)", async () => {
    put(0, 0, [["d"], ["b"], ["c"], ["a"], ["e"]]);
    h.region = [0, 0, 4, 0];
    select(1, 0, 1, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[0, 0, 4, 0, 0, true, false]]);
  });

  it("Z to A passes descending", async () => {
    put(0, 0, [[5], [3], [4]]);
    h.region = [0, 0, 2, 0];
    select(0, 0, 0, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_DESCENDING);
    expect(h.sorts).toEqual([[0, 0, 2, 0, 0, false, false]]);
  });

  it("several cells: EXACTLY the selection, by the active cell's column (C8, C9)", async () => {
    put(0, 0, [["N", "V", "W"], ["f", 6, 60], ["e", 5, 50], ["d", 4, 40], ["c", 3, 30], ["b", 2, 20]]);
    h.region = [0, 0, 5, 2];
    select(2, 0, 4, 1); // A3:B5, active B5
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[2, 0, 4, 1, 1, true, false]]);
    expect(h.shown.filter((s) => s.id === SORT_WARNING_DIALOG_ID)).toEqual([]);
  });

  it("a selection that includes the header row keeps it (C11)", async () => {
    put(0, 0, [["Name", "Val"], ["d", 4], ["b", 2]]);
    h.region = [0, 0, 2, 1];
    select(2, 1, 0, 0); // A1:B3 selected upwards: active A1
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[0, 0, 2, 1, 0, true, true]]);
  });

  it("one column inside wider data asks first; Expand sorts the block (C10)", async () => {
    put(0, 0, [["N", "V", "W"], ["f", 6, 60], ["e", 5, 50], ["d", 4, 40]]);
    h.region = [0, 0, 3, 2];
    select(3, 1, 1, 1); // B2:B4, active B2 // B2:B4
    const run = CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    await settle();
    expect(h.shown.map((s) => s.id)).toContain(SORT_WARNING_DIALOG_ID);
    expect(h.sorts, "sorted before the user answered").toEqual([]);
    answerSortWarning("expand");
    await run;
    expect(h.sorts).toEqual([[0, 0, 3, 2, 1, true, true]]);
  });

  it("... Continue with the current selection sorts only the column", async () => {
    put(0, 0, [["N", "V", "W"], ["f", 6, 60], ["e", 5, 50], ["d", 4, 40]]);
    h.region = [0, 0, 3, 2];
    select(3, 1, 1, 1); // B2:B4, active B2
    const run = CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    await settle();
    answerSortWarning("current");
    await run;
    expect(h.sorts).toEqual([[1, 1, 3, 1, 1, true, false]]);
  });

  it("... and Cancel sorts nothing", async () => {
    put(0, 0, [["N", "V"], ["f", 6], ["e", 5]]);
    h.region = [0, 0, 2, 1];
    select(2, 1, 1, 1);
    const run = CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    await settle();
    answerSortWarning("cancel");
    await run;
    expect(h.sorts).toEqual([]);
  });

  it("one column with nothing beside it sorts without asking (C12)", async () => {
    put(0, 0, [["d"], ["b"], ["c"], ["a"]]);
    h.region = [0, 0, 3, 0];
    select(3, 0, 0, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.shown).toEqual([]);
    expect(h.sorts).toEqual([[0, 0, 3, 0, 0, true, false]]);
  });

  it("whole selected columns are clipped to the used rows", async () => {
    put(0, 0, [["a", 1], ["b", 2]]);
    h.used = { startRow: 0, startCol: 0, endRow: 1, endCol: 1, empty: false };
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 1, type: "columns" };
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[0, 0, 1, 1, 1, true, false]]);
  });

  it("a multi-area selection is refused, as Excel refuses it", async () => {
    h.snapshot.selection = {
      startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells",
      additionalRanges: [{ startRow: 5, startCol: 5, endRow: 6, endCol: 5 }],
    };
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([]);
    expect(h.toasts[0]).toMatch(/multiple selections/);
  });

  it("inside a TABLE: the table body, with its header, totals row excluded", async () => {
    put(0, 0, [["Name", "City"], ["d", "x"], ["b", "y"]]);
    h.table = {
      id: "t", name: "T1", sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1, columns: [],
      styleOptions: { headerRow: true, totalRow: true }, styleName: "",
    };
    select(1, 1, 1, 1);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    // Text over text would guess "no header"; the table KNOWS it has one.
    expect(h.sorts).toEqual([[0, 0, 2, 1, 1, true, true]]);
  });

  it("inside an AutoFilter range: that range with its header, then the filter is reapplied", async () => {
    put(0, 0, [["Name", "City"], ["d", "x"], ["b", "y"]]);
    h.filter = { startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    h.region = [0, 0, 2, 1];
    select(2, 0, 2, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([[0, 0, 2, 1, 0, true, true]]);
    expect(h.reapplied).toBe(1);
  });

  // The sort and the reapply each record an undo entry. As two steps, the
  // first Ctrl+Z put back the old hidden-row INDEX set over the sorted rows,
  // hiding the wrong records (review finding, 2026-10-04). One owned
  // transaction makes them one step.
  it("inside an AutoFilter range: the sort and the reapply are ONE undo step", async () => {
    put(0, 0, [["Name", "City"], ["d", "x"], ["b", "y"]]);
    h.filter = { startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    h.region = [0, 0, 2, 1];
    select(2, 0, 2, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_DESCENDING);
    expect(h.undoLog).toEqual(["begin:Sort Z to A", "sort", "reapply", "commit:7"]);
  });

  it("a refused sort inside an AutoFilter range cancels the empty step and reapplies nothing", async () => {
    put(0, 0, [["Name", "City"], ["d", "x"], ["b", "y"]]);
    h.filter = { startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    h.region = [0, 0, 2, 1];
    h.sortError = "The range is protected";
    select(2, 0, 2, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.undoLog).toEqual(["begin:Sort A to Z", "sort", "cancel:7"]);
    expect(h.toasts).toEqual(["The range is protected"]);
  });

  it("a reapply that fails after the sort landed still commits the sort's step", async () => {
    put(0, 0, [["Name", "City"], ["d", "x"], ["b", "y"]]);
    h.filter = { startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    h.region = [0, 0, 2, 1];
    h.reapplyError = "filter gone";
    select(2, 0, 2, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.undoLog).toEqual(["begin:Sort A to Z", "sort", "reapply", "commit:7"]);
  });

  it("outside a filter the sort is the backend's own step: no transaction is opened", async () => {
    put(0, 0, [[3], [1], [2]]);
    h.region = [0, 0, 2, 0];
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.undoLog).toEqual(["sort"]);
  });

  it("a refusal from the backend (protected sheet) reaches the user", async () => {
    put(0, 0, [[1], [2]]);
    h.region = [0, 0, 1, 0];
    h.sortError = "The range is protected";
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.toasts).toEqual(["The range is protected"]);
  });

  it("refuses on a canvas sheet and while an object owns the selection", async () => {
    h.region = [0, 0, 1, 0];
    h.snapshot.surface = "canvas";
    await CommandRegistry.execute(ExtensionCommands.SORT_ASCENDING);
    expect(h.sorts).toEqual([]);
    expect(h.toasts[0]).toMatch(/canvas/);

    h.snapshot.surface = "grid";
    const release = registerSelectionOwner({
      id: "test.owner", label: "the object", fallback: true, ownsSelection: () => true,
      refusal: (action) => `${action} is not available while an object is selected.`,
    });
    try {
      await CommandRegistry.execute(ExtensionCommands.SORT_DESCENDING);
    } finally {
      release();
    }
    expect(h.sorts).toEqual([]);
    expect(h.toasts[1]).toBe("Sort Z to A is not available while an object is selected.");
  });
});

describe("Custom Sort... (sort.customDialog)", () => {
  it("opens the Sort dialog on the block and header the quick sort would use", async () => {
    put(0, 0, [["Name", "Val"], ["d", 4], ["b", 2]]);
    h.region = [0, 0, 2, 1];
    select(1, 0, 1, 0);
    await CommandRegistry.execute(ExtensionCommands.SORT_CUSTOM);
    expect(h.sorts).toEqual([]);
    const shown = h.shown.find((s) => s.id === "sort-dialog");
    expect(shown?.data).toMatchObject({
      range: { startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
      hasHeaders: true,
    });
  });
});
