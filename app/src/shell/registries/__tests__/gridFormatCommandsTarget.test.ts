//! FILENAME: app/src/shell/registries/__tests__/gridFormatCommandsTarget.test.ts
// PURPOSE: Home > Cells > Format's Row Height / Column Width / Hide / Unhide on
//          a floating grid's cells (P3 S10, owner finding G3). Each command
//          asks `resolveCellTarget(action, "lineSize")`; on the grid it writes
//          the OBJECT's own sizes / hidden lines with `{ target }` -- never the
//          sheet's (`hideRows` / `hideColumns` move the ACTIVE sheet and Core's
//          mirror) -- and Unhide reads the OBJECT's hidden set, never the
//          sheet's user-hidden rows.
// CONTEXT: The selection owner is REAL (@api/selectionOwner): a double shaped
//          like the floating grid's. The cell-target seam's object reads are
//          doubles; resolveCellTarget is the real one.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  state: null as null | Record<string, unknown>,
  openDialog: vi.fn(),
  setRowHeights: vi.fn(async (..._a: unknown[]) => undefined),
  setColumnWidths: vi.fn(async (..._a: unknown[]) => undefined),
  setRowsHidden: vi.fn(async (..._a: unknown[]) => [] as number[]),
  setColsHidden: vi.fn(async (..._a: unknown[]) => [] as number[]),
  getRowHeight: vi.fn(async (_r: number): Promise<number | null> => 33),
  getColumnWidth: vi.fn(async (_c: number): Promise<number | null> => 99),
  getDefaultDimensions: vi.fn(async () => ({ defaultRowHeight: 20, defaultColumnWidth: 64 })),
  userHiddenRows: vi.fn(async (): Promise<number[]> => [1, 2, 3]),
  userHiddenCols: vi.fn(async (): Promise<number[]> => [1, 2, 3]),
  hideRows: vi.fn(async () => true),
  hideColumns: vi.fn(async () => true),
  alert: vi.fn(async () => undefined),
  lines: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("../../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../core/lib/tauri-api")>()),
  setRowHeights: (...a: unknown[]) => h.setRowHeights(...a),
  setColumnWidths: (...a: unknown[]) => h.setColumnWidths(...a),
  setRowsHidden: (...a: unknown[]) => h.setRowsHidden(...a),
  setColsHidden: (...a: unknown[]) => h.setColsHidden(...a),
  getRowHeight: (r: number) => h.getRowHeight(r),
  getColumnWidth: (c: number) => h.getColumnWidth(c),
  getDefaultDimensions: () => h.getDefaultDimensions(),
  getUserHiddenRows: () => h.userHiddenRows(),
  getUserHiddenCols: () => h.userHiddenCols(),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetLines: (...a: unknown[]) => h.lines(...a),
  announceCellTargetObjectChanged: (...a: unknown[]) => h.announce(...a),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.state,
  hideRows: (...a: unknown[]) => h.hideRows(...(a as [])),
  hideColumns: (...a: unknown[]) => h.hideColumns(...(a as [])),
}));
vi.mock("@api/ui", () => ({
  DialogExtensions: {
    openDialog: (...a: unknown[]) => h.openDialog(...a),
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
  },
}));
vi.mock("@api/dialogs", () => ({
  alertAsync: (...a: unknown[]) => h.alert(...a),
  confirmAsync: vi.fn(async () => false),
  promptAsync: vi.fn(async () => null),
}));

import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "../../../core/types";
import { registerGridFormatCommands } from "../gridFormatCommands";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
let frSelection: Selection | null = null;
let admits: readonly CellTargetCapability[] = ["lineSize"];

function cells(startRow: number, startCol: number, endRow: number, endCol: number): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells" };
}

let release: () => void = () => {};
let unregister: () => void = () => {};

beforeAll(() => {
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return admits;
    },
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 10, cols: 5 }, label: "Float1", wholeObject: false },
  });
});

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  h.state = { selection: cells(40, 40, 41, 41) };
  frSelection = null;
  admits = ["lineSize"];
  h.lines.mockResolvedValue({ rowHeights: { 2: 44 }, colWidths: { 1: 77 }, hiddenRows: [2, 7], hiddenCols: [0] });
  unregister = registerGridFormatCommands();
});

afterEach(() => {
  unregister();
});

/** Run the dialog's OK with `px` (the dimension dialog is opened with an onResult). */
async function okDialog(px: number): Promise<void> {
  const data = h.openDialog.mock.calls.at(-1)?.[1] as { onResult: (px: number) => Promise<void>; currentPx: number };
  await data.onResult(px);
}

describe("on a floating grid's cells", () => {
  it("Row Height seeds from the GRID's own height and writes the grid's map with the target", async () => {
    frSelection = cells(2, 0, 3, 1);
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    const data = h.openDialog.mock.calls.at(-1)?.[1] as { currentPx: number; rangeLabel: string };
    expect(data.currentPx, "seeded from the SHEET's row 3").toBe(44);
    expect(data.rangeLabel).toBe("3:4");
    await okDialog(30);
    expect(h.setRowHeights).toHaveBeenCalledWith([[2, 3]], 30, { target: REF });
    expect(h.getRowHeight).not.toHaveBeenCalled();
    expect(h.announce).toHaveBeenCalledWith(REF);
  });

  it("Column Width writes the grid's widths with the target", async () => {
    frSelection = cells(0, 1, 0, 2);
    await CommandRegistry.execute(CoreCommands.COLUMN_WIDTH);
    expect((h.openDialog.mock.calls.at(-1)?.[1] as { currentPx: number }).currentPx).toBe(77);
    await okDialog(120);
    expect(h.setColumnWidths).toHaveBeenCalledWith([[1, 2]], 120, { target: REF });
  });

  it("Hide Rows / Columns hide the GRID's lines with the target, never the sheet's", async () => {
    frSelection = cells(1, 3, 2, 4);
    await CommandRegistry.execute(CoreCommands.HIDE_ROWS);
    await CommandRegistry.execute(CoreCommands.HIDE_COLUMNS);
    expect(h.setRowsHidden).toHaveBeenCalledWith([1, 2], true, { target: REF });
    expect(h.setColsHidden).toHaveBeenCalledWith([3, 4], true, { target: REF });
    expect(h.hideRows, "hid the ACTIVE sheet's rows").not.toHaveBeenCalled();
    expect(h.hideColumns).not.toHaveBeenCalled();
    expect(h.announce).toHaveBeenCalledTimes(2);
  });

  it("Unhide reads the GRID's hidden set (never the sheet's user-hidden rows) and unhides inside the span", async () => {
    frSelection = cells(0, 0, 5, 0);
    await CommandRegistry.execute(CoreCommands.UNHIDE_ROWS);
    expect(h.lines).toHaveBeenCalledWith(REF);
    expect(h.userHiddenRows, "read the SHEET's hidden rows for a floating grid").not.toHaveBeenCalled();
    // Row 7 is hidden too, but outside the span.
    expect(h.setRowsHidden).toHaveBeenCalledWith([2], false, { target: REF });
  });

  it("a grid that does not admit line sizes refuses once and writes nothing", async () => {
    admits = [];
    frSelection = cells(0, 0, 1, 1);
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    await CommandRegistry.execute(CoreCommands.HIDE_ROWS);
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.setRowsHidden).not.toHaveBeenCalled();
    expect(h.hideRows).not.toHaveBeenCalled();
  });
});

describe("positive control: on the sheet", () => {
  it("the commands act on Core's selection and the sheet's lines, with no target", async () => {
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    expect((h.openDialog.mock.calls.at(-1)?.[1] as { currentPx: number }).currentPx).toBe(33);
    await okDialog(25);
    expect(h.setRowHeights).toHaveBeenCalledWith([[40, 41]], 25, { target: undefined });
    await CommandRegistry.execute(CoreCommands.HIDE_ROWS);
    expect(h.hideRows).toHaveBeenCalled();
    expect(h.setRowsHidden).not.toHaveBeenCalled();
    expect(h.lines).not.toHaveBeenCalled();
  });
});

afterAll(() => release());
