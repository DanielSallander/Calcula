//! FILENAME: app/src/core/lib/fillCommands/__tests__/fillCommands.test.ts
// PURPOSE: Excel's Fill Down / Right / Up / Left: which cells are the source
//          and which the target, for a single row / column too, the sheet
//          edge, and a refusal SHOWN.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) Each fill needed at
//          least two rows (columns) selected and silently did nothing on one,
//          and a refusal (a protected sheet) was only logged, so the ribbon's
//          Fill menu and Ctrl+D looked dead. Live Excel (build 20326,
//          2026-10-04): Fill Down on ONE cell (or one row of cells) copies the
//          cell(s) ABOVE -- value, formula, format; an empty source clears the
//          target; Fill Right copies from the left, Fill Up from below, Fill
//          Left from the right; at the sheet's edge the command does nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({ fillRange: vi.fn() }));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emitBatch = vi.hoisted(() => vi.fn());

vi.mock("../../tauri-api", () => api);
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellEvents", () => ({
  cellEvents: { emitBatch },
  cellToChange: (c: { row: number; col: number }) => ({ row: c.row, col: c.col }),
}));

import type { Selection } from "../../../types";
import { fillPlan, runFillCommand } from "../fillCommands";

const ROWS = 1048576;
const COLS = 16384;

function sel(startRow: number, startCol: number, endRow: number, endCol: number): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells" };
}

beforeEach(() => {
  api.fillRange.mockReset();
  api.fillRange.mockResolvedValue([]);
  dialogs.alertAsync.mockReset();
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  emitBatch.mockReset();
});

describe("fillPlan: several rows / columns (the rule that already held)", () => {
  it("Fill Down copies the TOP row into the rows below", () => {
    expect(fillPlan("down", sel(2, 1, 5, 3), ROWS, COLS)).toEqual({
      source: { startRow: 2, startCol: 1, endRow: 2, endCol: 3 },
      target: { startRow: 3, startCol: 1, endRow: 5, endCol: 3 },
    });
  });

  it("Fill Up copies the BOTTOM row into the rows above", () => {
    expect(fillPlan("up", sel(5, 1, 2, 3), ROWS, COLS)).toEqual({
      source: { startRow: 5, startCol: 1, endRow: 5, endCol: 3 },
      target: { startRow: 2, startCol: 1, endRow: 4, endCol: 3 },
    });
  });

  it("Fill Right / Left copy the first / last column", () => {
    expect(fillPlan("right", sel(0, 2, 1, 4), ROWS, COLS)).toEqual({
      source: { startRow: 0, startCol: 2, endRow: 1, endCol: 2 },
      target: { startRow: 0, startCol: 3, endRow: 1, endCol: 4 },
    });
    expect(fillPlan("left", sel(0, 2, 1, 4), ROWS, COLS)).toEqual({
      source: { startRow: 0, startCol: 4, endRow: 1, endCol: 4 },
      target: { startRow: 0, startCol: 2, endRow: 1, endCol: 3 },
    });
  });
});

describe("fillPlan: ONE row / column copies from the neighbour (Excel)", () => {
  it("Fill Down on one cell copies the cell above (B3 <- B2)", () => {
    expect(fillPlan("down", sel(2, 1, 2, 1), ROWS, COLS)).toEqual({
      source: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
      target: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 },
    });
  });

  it("Fill Down on one ROW of cells copies the row above (E6:G6 <- E5:G5)", () => {
    expect(fillPlan("down", sel(5, 4, 5, 6), ROWS, COLS)).toEqual({
      source: { startRow: 4, startCol: 4, endRow: 4, endCol: 6 },
      target: { startRow: 5, startCol: 4, endRow: 5, endCol: 6 },
    });
  });

  it("Fill Right on one cell copies the cell to the left; one column of cells, the column to the left", () => {
    expect(fillPlan("right", sel(9, 2, 9, 2), ROWS, COLS)).toEqual({
      source: { startRow: 9, startCol: 1, endRow: 9, endCol: 1 },
      target: { startRow: 9, startCol: 2, endRow: 9, endCol: 2 },
    });
    expect(fillPlan("right", sel(11, 2, 12, 2), ROWS, COLS)).toEqual({
      source: { startRow: 11, startCol: 1, endRow: 12, endCol: 1 },
      target: { startRow: 11, startCol: 2, endRow: 12, endCol: 2 },
    });
  });

  it("Fill Up on one cell copies the cell BELOW; Fill Left, the cell to the RIGHT", () => {
    expect(fillPlan("up", sel(19, 9, 19, 9), ROWS, COLS)).toEqual({
      source: { startRow: 20, startCol: 9, endRow: 20, endCol: 9 },
      target: { startRow: 19, startCol: 9, endRow: 19, endCol: 9 },
    });
    expect(fillPlan("left", sel(29, 11, 29, 11), ROWS, COLS)).toEqual({
      source: { startRow: 29, startCol: 12, endRow: 29, endCol: 12 },
      target: { startRow: 29, startCol: 11, endRow: 29, endCol: 11 },
    });
  });

  it("at the sheet's edge there is nothing to copy from: no plan", () => {
    expect(fillPlan("down", sel(0, 7, 0, 7), ROWS, COLS)).toBeNull();
    expect(fillPlan("right", sel(14, 0, 14, 0), ROWS, COLS)).toBeNull();
    expect(fillPlan("up", sel(ROWS - 1, 9, ROWS - 1, 9), ROWS, COLS)).toBeNull();
    expect(fillPlan("left", sel(29, COLS - 1, 29, COLS - 1), ROWS, COLS)).toBeNull();
  });

  it("no selection: no plan", () => {
    expect(fillPlan("down", null, ROWS, COLS)).toBeNull();
  });
});

describe("runFillCommand", () => {
  const host = (selection: Selection | null) => ({ selection, totalRows: ROWS, totalCols: COLS });

  it("fills a single cell from above in ONE backend call and announces the cells", async () => {
    api.fillRange.mockResolvedValue([{ row: 2, col: 1 }]);
    await runFillCommand("down", host(sel(2, 1, 2, 1)));
    expect(api.fillRange.mock.calls).toEqual([[1, 1, 1, 1, 2, 1, 2, 1]]);
    expect(emitBatch).toHaveBeenCalledWith([{ row: 2, col: 1 }], "fill");
  });

  it("at the edge: no call and no message (Excel does nothing)", async () => {
    await runFillCommand("down", host(sel(0, 3, 0, 3)));
    expect(api.fillRange).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("a refusal (a protected sheet) is SHOWN, not only logged", async () => {
    api.fillRange.mockRejectedValue("The cell is on a protected sheet.");
    for (const direction of ["down", "right", "up", "left"] as const) {
      await runFillCommand(direction, host(sel(3, 3, 5, 5)));
    }
    expect(dialogs.alertAsync.mock.calls).toEqual([
      ["The cell is on a protected sheet."],
      ["The cell is on a protected sheet."],
      ["The cell is on a protected sheet."],
      ["The cell is on a protected sheet."],
    ]);
    expect(emitBatch).not.toHaveBeenCalled();
  });
});
