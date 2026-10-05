//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/alignment/numberGroupCommands.test.ts
// PURPOSE: The Number group's two commands that are not a plain format write
//          (CONTRACT 3.7): Comma Style's preset keyword, and Increase /
//          Decrease Decimal through `adjustNumberFormatDecimals`, which steps
//          the ACTIVE cell's own format -- so the active cell must lead the
//          rows and columns it is sent -- and must refuse, announce and report
//          exactly as the Home tab's other formatting doors do.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const grid = vi.hoisted(() => ({ selection: null as object | null }));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => (grid.selection === null ? null : { selection: grid.selection }),
}));

const lib = vi.hoisted(() => ({
  adjustNumberFormatDecimals: vi.fn(),
  applyFormatting: vi.fn(),
  beginUndoTransaction: vi.fn(async () => 3),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
}));
vi.mock("@api/lib", () => lib);

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

const events = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@api/cellEvents", () => ({ cellEvents: events }));

import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import type { Selection } from "@api/types";
import {
  COMMA_STYLE_PRESET,
  activeCellFirst,
  stepNumberFormatDecimals,
} from "../../components/alignment/numberGroupCommands";

let toasts: ToastPayload[] = [];
let windowEvents: string[] = [];
let releaseOwner: (() => void) | null = null;
const listen = (e: Event) => windowEvents.push(e.type);

function sel(s: Partial<Selection>): Selection {
  return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", ...s } as Selection;
}

beforeEach(() => {
  toasts = [];
  windowEvents = [];
  registerToastSink((t) => toasts.push(t));
  grid.selection = null;
  lib.adjustNumberFormatDecimals.mockReset().mockResolvedValue({
    cells: [
      { row: 4, col: 2, display: "1.50", formula: null, styleIndex: 3 },
      { row: 3, col: 2, display: "2.00", formula: null, styleIndex: 3 },
    ],
    styles: [{ index: 3, style: { numberFormat: "Number (2 decimals)" } }],
  });
  lib.applyFormatting.mockReset().mockResolvedValue({ cells: [{ row: 9, col: 9, display: "3.00", formula: null, styleIndex: 3 }], styles: [] });
  for (const fn of [lib.beginUndoTransaction, lib.commitUndoTransaction, lib.cancelUndoTransaction]) fn.mockClear();
  dialogs.alertAsync.mockClear();
  events.emit.mockClear();
  for (const name of ["styles:refresh", "grid:refresh"]) window.addEventListener(name, listen);
});

afterEach(() => {
  releaseOwner?.();
  releaseOwner = null;
  for (const name of ["styles:refresh", "grid:refresh"]) window.removeEventListener(name, listen);
});

describe("Comma Style", () => {
  it("is the backend's `comma` preset (Accounting with no symbol, 2 decimals), not #,##0", () => {
    expect(COMMA_STYLE_PRESET).toBe("comma");
  });
});

describe("activeCellFirst", () => {
  it("puts the active cell's row and column first, then the rest of the rectangle in order", () => {
    // Anchor B2 (row 1, col 1), active cell D5 (row 4, col 3).
    expect(activeCellFirst(sel({ startRow: 1, startCol: 1, endRow: 4, endCol: 3 }))).toEqual({
      rows: [4, 1, 2, 3],
      cols: [3, 1, 2],
    });
  });

  it("normalises a selection dragged up and left (the active cell is still `end`)", () => {
    expect(activeCellFirst(sel({ startRow: 5, startCol: 4, endRow: 3, endCol: 2 }))).toEqual({
      rows: [3, 4, 5],
      cols: [2, 3, 4],
    });
  });

  it("honours the explicit activeRow / activeCol aliases", () => {
    expect(
      activeCellFirst(sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 1, activeRow: 1, activeCol: 0 })),
    ).toEqual({ rows: [1, 0, 2], cols: [0, 1] });
  });

  it("a single cell is one row and one column", () => {
    expect(activeCellFirst(sel({ startRow: 7, startCol: 9, endRow: 7, endCol: 9 }))).toEqual({
      rows: [7],
      cols: [9],
    });
  });
});

describe("stepNumberFormatDecimals", () => {
  it("Increase Decimal sends +1 with the active cell first, then announces the cells and refreshes", async () => {
    grid.selection = sel({ startRow: 3, startCol: 2, endRow: 4, endCol: 2 });
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(true);
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledTimes(1);
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledWith([4, 3], [2], 1);
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenCalledWith({ row: 4, col: 2, oldValue: undefined, newValue: "1.50", formula: null });
    expect(windowEvents).toEqual(["styles:refresh", "grid:refresh"]);
  });

  it("Decrease Decimal sends -1", async () => {
    grid.selection = sel({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    await stepNumberFormatDecimals(-1, "Decrease Decimal");
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledWith([0], [0], -1);
  });

  it("when Excel would change nothing (a date, text, nothing left to remove) nothing is announced", async () => {
    lib.adjustNumberFormatDecimals.mockResolvedValue({ cells: [], styles: [] });
    grid.selection = sel({});
    await expect(stepNumberFormatDecimals(-1, "Decrease Decimal")).resolves.toBe(true);
    expect(events.emit).not.toHaveBeenCalled();
    expect(windowEvents).toEqual([]);
  });

  it("falls back to the last known selection when a ribbon click has cleared the grid's", async () => {
    grid.selection = null;
    await stepNumberFormatDecimals(1, "Increase Decimal", sel({ startRow: 2, startCol: 5, endRow: 2, endCol: 5 }));
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledWith([2], [5], 1);
  });

  it("with no selection at all it writes nothing", async () => {
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(false);
    expect(lib.adjustNumberFormatDecimals).not.toHaveBeenCalled();
  });

  it("refuses with ONE toast, writing nothing, while something else owns the selection", async () => {
    releaseOwner = registerSelectionOwner({
      id: "test-owner",
      label: "the test object's cells",
      ownsSelection: () => true,
    });
    grid.selection = sel({});
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(false);
    expect(lib.adjustNumberFormatDecimals).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("Increase Decimal");
  });

  it("a backend refusal reaches the user and announces nothing", async () => {
    lib.adjustNumberFormatDecimals.mockRejectedValue(new Error("The cell is on a protected sheet."));
    grid.selection = sel({});
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(false);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(windowEvents).toEqual([]);
  });

  it("a refusal that is a bare string is shown as it is", async () => {
    lib.adjustNumberFormatDecimals.mockRejectedValue("Refused.");
    grid.selection = sel({});
    await stepNumberFormatDecimals(-1, "Decrease Decimal");
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Refused.");
  });
});

describe("stepNumberFormatDecimals over several blocks", () => {
  const twoBlocks = () =>
    sel({ startRow: 3, startCol: 2, endRow: 4, endCol: 2, additionalRanges: [{ startRow: 9, startCol: 9, endRow: 9, endCol: 9 }] });

  it("the other block takes the active cell's stepped format, all in ONE undo step, announced once", async () => {
    grid.selection = twoBlocks();
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(true);
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledWith([4, 3], [2], 1);
    expect(lib.applyFormatting.mock.calls).toEqual([[[9], [9], { numberFormat: "Number (2 decimals)" }]]);
    expect(lib.beginUndoTransaction.mock.calls).toEqual([["Increase Decimal"]]);
    expect(lib.commitUndoTransaction.mock.calls).toEqual([[3]]);
    expect(events.emit).toHaveBeenCalledTimes(3);
    expect(windowEvents).toEqual(["styles:refresh", "grid:refresh"]);
  });

  it("the other block refused: the main block's step is COMMITTED and announced, the refusal said once", async () => {
    lib.applyFormatting.mockRejectedValue(new Error("J10 is locked."));
    grid.selection = twoBlocks();
    await expect(stepNumberFormatDecimals(1, "Increase Decimal")).resolves.toBe(true);
    expect(lib.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync.mock.calls).toEqual([["J10 is locked."]]);
    expect(windowEvents).toEqual(["styles:refresh", "grid:refresh"]);
  });

  it("the main block refused: nothing landed, the empty step is cancelled, nothing announced", async () => {
    lib.adjustNumberFormatDecimals.mockRejectedValue(new Error("Sheet1 is protected."));
    grid.selection = twoBlocks();
    await expect(stepNumberFormatDecimals(-1, "Decrease Decimal")).resolves.toBe(false);
    expect(lib.applyFormatting).not.toHaveBeenCalled();
    expect(lib.cancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
    expect(windowEvents).toEqual([]);
  });
});
