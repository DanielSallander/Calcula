//! FILENAME: app/extensions/FillSeries/__tests__/seriesCommand.test.ts
// PURPOSE: `fill.series` opens Excel's Series dialog (refusing first when the
//          series could not be written), and the dialog's OK writes the whole
//          series in ONE undo step -- AutoFill through the fill handle's own
//          engine, a lone cell running on to its Stop value.
// CONTEXT: Home tab 2026-10-04. The per-line rules are seriesPlan.test.ts's.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

type Raw = number | string;

const h = vi.hoisted(() => ({
  sheet: new Map<string, number | string>(),
  styles: new Map<string, number>(),
  snapshot: {
    surface: "grid" as "grid" | "canvas",
    selection: { startRow: 0, startCol: 0, endRow: 5, endCol: 0, type: "cells" } as Record<string, unknown>,
  },
  writes: [] as unknown[][],
  writeError: null as string | null,
  shown: [] as Array<{ id: string; data?: Record<string, unknown> }>,
  toasts: [] as string[],
  undo: { open: null as null | { label: string; ticket: number }, committed: [] as string[], dropped: [] as string[] },
}));

function inRange(key: string, sr: number, sc: number, er: number, ec: number): { row: number; col: number } | null {
  const [row, col] = key.split(",").map(Number);
  return row >= sr && row <= er && col >= sc && col <= ec ? { row, col } : null;
}

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getRangeCellsTyped: async (sr: number, sc: number, er: number, ec: number) => {
    const out: unknown[] = [];
    for (const [key, v] of h.sheet) {
      const at = inRange(key, sr, sc, er, ec);
      if (at) out.push({ ...at, value: v, display: String(v), formula: null, type: typeof v === "number" ? "number" : "text" });
    }
    return out;
  },
  getViewportCells: async (sr: number, sc: number, er: number, ec: number) => {
    const out: unknown[] = [];
    for (const [key, v] of h.sheet) {
      const at = inRange(key, sr, sc, er, ec);
      const formula = typeof v === "string" && v.startsWith("=") ? v : null;
      if (at) out.push({ ...at, display: formula ? "0" : String(v), formula, styleIndex: h.styles.get(key) ?? 0 });
    }
    return out;
  },
  updateCellsBatch: async (updates: unknown[]) => {
    h.writes.push(updates);
    if (h.writeError) throw new Error(h.writeError);
    return [];
  },
  beginUndoTransaction: async (label: string) => {
    if (h.undo.open) return null;
    h.undo.open = { label, ticket: 3 };
    return 3;
  },
  commitUndoTransaction: async (t?: number | null) => {
    if (h.undo.open && (t == null || t === h.undo.open.ticket)) {
      h.undo.committed.push(h.undo.open.label);
      h.undo.open = null;
    }
  },
  cancelUndoTransaction: async (t?: number | null) => {
    if (h.undo.open && (t == null || t === h.undo.open.ticket)) {
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
import { registerSelectionOwner } from "@api/selectionOwner";
import { detectPattern, generateFillValue } from "@api/fillPatterns";

const opts = (o: Partial<SeriesOptions> = {}): SeriesOptions => ({
  seriesIn: "columns",
  type: "linear",
  dateUnit: "day",
  step: 1,
  stop: null,
  trend: false,
  ...o,
});
const put = (row: number, col: number, v: Raw, style = 0) => {
  h.sheet.set(`${row},${col}`, v);
  if (style) h.styles.set(`${row},${col}`, style);
};
const written = () => (h.writes[0] ?? []) as Array<{ row: number; col: number; value: string; styleIndex?: number; invariant?: boolean }>;

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
  h.sheet = new Map();
  h.styles = new Map();
  h.snapshot = { surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 5, endCol: 0, type: "cells" } };
  h.writes = [];
  h.writeError = null;
  h.shown = [];
  h.toasts = [];
  h.undo = { open: null, committed: [], dropped: [] };
});

describe("fill.series", () => {
  it("opens the Series dialog, Rows for a wide selection and Columns for a tall one", async () => {
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 6, type: "cells" };
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    expect(h.shown).toEqual([
      { id: SERIES_DIALOG_ID, data: { seriesIn: "columns" } },
      { id: SERIES_DIALOG_ID, data: { seriesIn: "rows" } },
    ]);
  });

  it("refuses (and opens nothing) on a canvas, over several areas, and while an object owns the selection", async () => {
    h.snapshot.surface = "canvas";
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    h.snapshot.surface = "grid";
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells", additionalRanges: [{ startRow: 4, startCol: 4, endRow: 5, endCol: 4 }] };
    await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    const release = registerSelectionOwner({
      id: "t", label: "the object", fallback: true, ownsSelection: () => true,
      refusal: (a) => `${a} is not available while an object is selected.`,
    });
    try {
      await CommandRegistry.execute(ExtensionCommands.FILL_SERIES);
    } finally {
      release();
    }
    expect(h.shown).toEqual([]);
    expect(h.toasts).toEqual([
      "Series is not available on a canvas sheet: it holds objects, not cells.",
      "This command cannot be used on multiple selections.",
      "Series is not available while an object is selected.",
    ]);
  });
});

describe("runSeries (the dialog's OK)", () => {
  it("writes the whole series in ONE undo step, canonical numbers, the start's format", async () => {
    put(0, 0, 1, 9);
    expect(await runSeries(opts({ step: 2 }))).toBeNull();
    expect(written()).toEqual([1, 2, 3, 4, 5].map((row) => ({
      row, col: 0, value: String(1 + 2 * row), styleIndex: 9, invariant: true,
    })));
    expect(h.undo.committed).toEqual(["Series"]);
  });

  it("Rows fills each row of the selection from its own first cell", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 2, type: "cells" };
    put(0, 0, 1);
    put(1, 0, 10);
    await runSeries(opts({ seriesIn: "rows" }));
    expect(written().map((w) => [w.row, w.col, w.value])).toEqual([
      [0, 1, "2"], [0, 2, "3"], [1, 1, "11"], [1, 2, "12"],
    ]);
  });

  it("a lone cell runs on to the Stop value (Excel extends the selection)", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
    put(0, 0, 1);
    await runSeries(opts({ step: 3, stop: 10 }));
    expect(written().map((w) => [w.row, w.value])).toEqual([[1, "4"], [2, "7"], [3, "10"]]);
  });

  it("a lone cell without a Stop value has nothing to fill, and says so", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
    put(0, 0, 1);
    expect(await runSeries(opts())).toMatch(/Stop value/);
    expect(h.writes).toEqual([]);
  });

  it("AutoFill is the fill handle's inference (Mon -> Tue, Item 1 -> Item 2)", async () => {
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 3, endCol: 1, type: "cells" };
    put(0, 0, "Mon");
    put(0, 1, "Item 1");
    await runSeries(opts({ type: "autofill" }));
    const byCell = Object.fromEntries(written().map((w) => [`${w.row},${w.col}`, w.value]));
    expect(byCell).toEqual({
      "1,0": "Tue", "2,0": "Wed", "3,0": "Thu",
      "1,1": "Item 2", "2,1": "Item 3", "3,1": "Item 4",
    });
    expect(h.undo.committed).toEqual(["Series"]);
  });

  it("AutoFill infers like the DRAG: a formula in the source is not part of the pattern (review finding (j))", async () => {
    // The handle infers from the NON-formula values; Series used to infer from
    // every value, so ["Item 1", "=B1"] was a copy here and an increment there.
    h.snapshot.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    put(0, 0, "Item 1");
    put(1, 0, "=B1");
    await runSeries(opts({ type: "autofill" }));
    const dragWouldWrite = generateFillValue(detectPattern(["Item 1"]), ["Item 1", "=B1"], 2);
    expect(dragWouldWrite, "the oracle cannot tell the two rules apart").not.toBe(
      generateFillValue(detectPattern(["Item 1", "=B1"]), ["Item 1", "=B1"], 2),
    );
    expect(written().map((w) => [w.row, w.value])).toEqual([[2, dragWouldWrite]]);
  });

  it("a refused write cancels its own step and returns the reason (the dialog shows it)", async () => {
    put(0, 0, 1);
    h.writeError = "Cell A2 is protected";
    expect(await runSeries(opts())).toBe("Cell A2 is protected");
    expect(h.undo.dropped).toEqual(["Series"]);
  });

  it("inside a script's open batch it writes INTO the batch and leaves it open", async () => {
    put(0, 0, 1);
    h.undo.open = { label: "Script batch", ticket: 1 };
    await runSeries(opts());
    expect(h.writes).toHaveLength(1);
    expect(h.undo.open?.label).toBe("Script batch");
    expect(h.undo.committed).toEqual([]);
  });
});
