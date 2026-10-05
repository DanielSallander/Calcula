//! FILENAME: app/src/shell/registries/__tests__/gridFormatCommands.test.ts
// PURPOSE: Excel's Home > Cells > Format menu, Cell Size and Visibility halves:
//          Row Height... / Column Width... / Default Width... and Hide & Unhide
//          Rows / Columns. Each acts on the rows or columns the SELECTION
//          SPANS, whatever its shape (Excel), and each resize is ONE undo step.
// CONTEXT: The right-click Row Height / Column Width items (gridExtensions.ts)
//          looped `setRowHeight` / `setColumnWidth` with no transaction, and the
//          backend pushes one undo entry per call outside one -- resizing five
//          columns took five Ctrl+Z. Both doors now share one writer.
//          (2026-10-04, rust-followup) That writer is now ONE backend call per
//          gesture -- `setRowHeights` / `setColumnWidths` take the span as
//          inclusive runs and record ONE compact undo step -- so Select All +
//          Column Width is one call, not 16,384, and the per-line loop and its
//          TypeScript transaction are gone.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  state: null as null | Record<string, unknown>,
  openDialog: vi.fn(),
  registerDialog: vi.fn(),
  setRowHeight: vi.fn(async (_r: number, _px: number) => undefined),
  setColumnWidth: vi.fn(async (_c: number, _px: number) => undefined),
  setRowHeights: vi.fn(async (_runs: ReadonlyArray<readonly [number, number]>, _px: number) => undefined),
  setColumnWidths: vi.fn(async (_runs: ReadonlyArray<readonly [number, number]>, _px: number) => undefined),
  getRowHeight: vi.fn(async (_r: number): Promise<number | null> => null),
  getColumnWidth: vi.fn(async (_c: number): Promise<number | null> => null),
  getDefaultDimensions: vi.fn(async () => ({ defaultRowHeight: 20, defaultColumnWidth: 64.01 })),
  setDefaultColumnWidth: vi.fn(async (w: number) => ({ defaultRowHeight: 20, defaultColumnWidth: w })),
  begin: vi.fn(async (_label: string): Promise<number | null> => 7),
  commit: vi.fn(async (_t?: number | null) => undefined),
  cancel: vi.fn(async (_t?: number | null) => undefined),
  userHiddenRows: vi.fn(async (): Promise<number[]> => []),
  userHiddenCols: vi.fn(async (): Promise<number[]> => []),
  hideRows: vi.fn(async (_rows: number[], _hidden: boolean) => true),
  hideColumns: vi.fn(async (_cols: number[], _hidden: boolean) => true),
  canPerform: vi.fn(async (_action: string) => ({ canEdit: true, reason: null as string | null })),
  alert: vi.fn(async () => undefined),
}));

vi.mock("../../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../core/lib/tauri-api")>()),
  setRowHeight: (r: number, px: number) => h.setRowHeight(r, px),
  setColumnWidth: (c: number, px: number) => h.setColumnWidth(c, px),
  setRowHeights: (runs: ReadonlyArray<readonly [number, number]>, px: number) => h.setRowHeights(runs, px),
  setColumnWidths: (runs: ReadonlyArray<readonly [number, number]>, px: number) => h.setColumnWidths(runs, px),
  getRowHeight: (r: number) => h.getRowHeight(r),
  getColumnWidth: (c: number) => h.getColumnWidth(c),
  getDefaultDimensions: () => h.getDefaultDimensions(),
  setDefaultColumnWidth: (w: number) => h.setDefaultColumnWidth(w),
  beginUndoTransaction: (label: string) => h.begin(label),
  commitUndoTransaction: (t?: number | null) => h.commit(t),
  cancelUndoTransaction: (t?: number | null) => h.cancel(t),
  getUserHiddenRows: () => h.userHiddenRows(),
  getUserHiddenCols: () => h.userHiddenCols(),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.state,
  hideRows: (rows: number[], hidden: boolean) => h.hideRows(rows, hidden),
  hideColumns: (cols: number[], hidden: boolean) => h.hideColumns(cols, hidden),
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  canPerformAction: (action: string) => h.canPerform(action),
}));
vi.mock("@api/ui", () => ({
  DialogExtensions: {
    openDialog: (...a: unknown[]) => h.openDialog(...a),
    registerDialog: (...a: unknown[]) => h.registerDialog(...a),
    unregisterDialog: vi.fn(),
  },
}));
vi.mock("@api/dialogs", () => ({
  alertAsync: (...a: unknown[]) => h.alert(...a),
  confirmAsync: vi.fn(async () => false),
  promptAsync: vi.fn(async () => null),
}));

import { CommandRegistry, CoreCommands } from "@api/commands";
import { AppEvents } from "@api/events";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { registerSelectionOwner } from "@api/selectionOwner";
import type { Selection } from "../../../core/types";
import { createEmptyDimensionOverrides } from "../../../core/types";
import {
  registerGridFormatCommands,
  selectionLineIntervals,
  MAX_LINES_PER_FORMAT_COMMAND,
} from "../gridFormatCommands";
import { gridExtensions, registerCoreGridContextMenu, type GridMenuContext } from "../gridExtensions";
import { DIMENSION_INPUT_DIALOG_ID, type DimensionInputData } from "../../dialogs/DimensionInputDialog";

const FORMAT_COMMANDS = [
  CoreCommands.ROW_HEIGHT,
  CoreCommands.COLUMN_WIDTH,
  CoreCommands.DEFAULT_WIDTH,
  CoreCommands.HIDE_ROWS,
  CoreCommands.HIDE_COLUMNS,
  CoreCommands.UNHIDE_ROWS,
  CoreCommands.UNHIDE_COLUMNS,
] as const;

const toasts: ToastPayload[] = [];
const windowEvents: string[] = [];
const WATCHED = ["grid:refresh", "dimensions:refresh", AppEvents.ROW_RESIZED, AppEvents.COLUMN_RESIZED];
const record = (e: Event) => windowEvents.push(e.type);

function cells(startRow: number, startCol: number, endRow: number, endCol: number, extra: Partial<Selection> = {}): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", ...extra };
}

function select(selection: Selection | null): void {
  h.state = {
    selection,
    dimensions: createEmptyDimensionOverrides(),
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  };
}

/** The dialog the last command opened, with its data. */
function openedDialog(): DimensionInputData {
  expect(h.openDialog).toHaveBeenCalledTimes(1);
  const [id, data] = h.openDialog.mock.calls[0] as [string, DimensionInputData];
  expect(id).toBe(DIMENSION_INPUT_DIALOG_ID);
  return data;
}

beforeAll(() => {
  registerToastSink((t) => toasts.push(t));
  registerGridFormatCommands();
});

beforeEach(() => {
  vi.clearAllMocks();
  toasts.length = 0;
  windowEvents.length = 0;
  for (const type of WATCHED) window.addEventListener(type, record);
  select(cells(0, 0, 0, 0));
});

afterEach(() => {
  for (const type of WATCHED) window.removeEventListener(type, record);
});

// ---------------------------------------------------------------------------

describe("the selection SPAN", () => {
  it("is the rows (or columns) any area of the selection covers, merged and ascending", () => {
    const sel = cells(6, 2, 3, 4, {
      additionalRanges: [
        { startRow: 10, endRow: 12, startCol: 0, endCol: 1 },
        { startRow: 8, endRow: 5, startCol: 9, endCol: 7 },
      ],
    });
    expect(selectionLineIntervals(sel, "rows")).toEqual([
      [3, 8],
      [10, 12],
    ]);
    expect(selectionLineIntervals(sel, "columns")).toEqual([
      [0, 4],
      [7, 9],
    ]);
  });

  it("adjacent areas join into one run", () => {
    const sel = cells(0, 0, 2, 0, { additionalRanges: [{ startRow: 3, endRow: 4, startCol: 0, endCol: 0 }] });
    expect(selectionLineIntervals(sel, "rows")).toEqual([[0, 4]]);
  });
});

describe("registration", () => {
  it("registers all seven commands, none script-safe (each opts in only after an audit)", () => {
    for (const id of FORMAT_COMMANDS) {
      expect(CommandRegistry.has(id), id).toBe(true);
      expect(CommandRegistry.isScriptSafe(id), id).toBe(false);
    }
  });
});

describe("Row Height...", () => {
  it("opens the dialog on the span of a CELL selection (Excel), seeded with the first row's height", async () => {
    select(cells(3, 1, 6, 2));
    h.getRowHeight.mockResolvedValueOnce(30);
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    const data = openedDialog();
    expect(data.mode).toBe("rowHeight");
    expect(data.currentPx).toBe(30);
    expect(data.rangeLabel).toBe("4:7");
    expect(h.getRowHeight).toHaveBeenCalledWith(3);
  });

  it("falls back to the sheet default when the first row has no height of its own", async () => {
    select(cells(3, 1, 3, 1));
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    expect(openedDialog().currentPx).toBe(20);
    expect(openedDialog().rangeLabel).toBe("4");
  });

  it("OK resizes every spanned row in ONE backend call (one undo step), then re-reads the dimensions", async () => {
    select(cells(3, 1, 6, 2));
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    await openedDialog().onResult!(40);
    expect(h.setRowHeights.mock.calls).toEqual([[[[3, 6]], 40]]);
    expect(h.setRowHeight, "never one call per row").not.toHaveBeenCalled();
    // The backend records the ONE step itself (an owned step: inside a
    // script's batch it joins), so the gesture opens no transaction of its own.
    expect(h.begin).not.toHaveBeenCalled();
    expect(windowEvents).toContain("dimensions:refresh");
    expect(windowEvents).toContain("grid:refresh");
    // ONE resize announcement for the gesture (pinned controls re-derive everything).
    expect(windowEvents.filter((t) => t === AppEvents.ROW_RESIZED).length).toBe(1);
  });

  it("a multi-area selection resizes the union", async () => {
    select(cells(0, 0, 1, 0, { additionalRanges: [{ startRow: 5, endRow: 5, startCol: 0, endCol: 0 }] }));
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    await openedDialog().onResult!(40);
    expect(h.setRowHeights.mock.calls).toEqual([
      [
        [
          [0, 1],
          [5, 5],
        ],
        40,
      ],
    ]);
  });

  it("a backend refusal (a protected sheet) is surfaced, nothing is announced as resized", async () => {
    select(cells(0, 0, 2, 0));
    h.setRowHeights.mockRejectedValueOnce(new Error("The sheet is protected."));
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    await openedDialog().onResult!(40);
    expect(h.alert).toHaveBeenCalledWith("The sheet is protected.");
    expect(windowEvents.filter((t) => t === AppEvents.ROW_RESIZED).length).toBe(0);
  });

  it("16,384 rows (as many as a sheet has columns) are one call", async () => {
    select(cells(0, 0, 16_383, 0));
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    await openedDialog().onResult!(30);
    expect(h.setRowHeights.mock.calls).toEqual([[[[0, 16_383]], 30]]);
  });

  it("more rows than that are still refused before the dialog opens -- each would carry a stored height", async () => {
    // A whole-COLUMN selection spans every row of the sheet. The batch made the
    // CALL cheap; what is still per row is the stored height, which every
    // structural undo step, every dimension refresh and the scroll arithmetic
    // carry (see the file header).
    select({ startRow: 0, endRow: 1_048_575, startCol: 2, endCol: 2, type: "columns" });
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.setRowHeights).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
    expect(MAX_LINES_PER_FORMAT_COMMAND).toBeLessThan(1_048_576);
  });

  it("no selection, nothing", async () => {
    select(null);
    await CommandRegistry.execute(CoreCommands.ROW_HEIGHT);
    expect(h.openDialog).not.toHaveBeenCalled();
  });
});

describe("Column Width...", () => {
  it("opens on the column span and resizes it in one undo step", async () => {
    select(cells(4, 1, 2, 3));
    await CommandRegistry.execute(CoreCommands.COLUMN_WIDTH);
    const data = openedDialog();
    expect(data.mode).toBe("columnWidth");
    expect(data.rangeLabel).toBe("B:D");
    expect(data.currentPx).toBe(64.01);
    await data.onResult!(75);
    expect(h.setColumnWidths.mock.calls).toEqual([[[[1, 3]], 75]]);
    expect(h.setColumnWidth, "never one call per column").not.toHaveBeenCalled();
    expect(windowEvents.filter((t) => t === AppEvents.COLUMN_RESIZED).length).toBe(1);
  });

  it("Select All + Column Width is ONE call with one run (it was 16,384 calls)", async () => {
    select(cells(0, 0, 1_048_575, 16_383));
    await CommandRegistry.execute(CoreCommands.COLUMN_WIDTH);
    const data = openedDialog();
    expect(data.rangeLabel).toBe("A:XFD");
    await data.onResult!(90);
    expect(h.setColumnWidths.mock.calls).toEqual([[[[0, 16_383]], 90]]);
    expect(toasts.length).toBe(0);
  });
});

describe("Default Width...", () => {
  it("opens the Standard Width mode on the current default and sets it", async () => {
    await CommandRegistry.execute(CoreCommands.DEFAULT_WIDTH);
    const data = openedDialog();
    expect(data.mode).toBe("defaultWidth");
    expect(data.currentPx).toBe(64.01);
    await data.onResult!(75);
    expect(h.setDefaultColumnWidth).toHaveBeenCalledWith(75);
    // The grid reads the default from the backend: it must be told to re-read.
    expect(windowEvents).toContain("dimensions:refresh");
  });

  it("is refused BEFORE its dialog on a sheet whose protection forbids formatting columns", async () => {
    h.canPerform.mockResolvedValueOnce({ canEdit: false, reason: "Action 'formatColumns' is not allowed" });
    await CommandRegistry.execute(CoreCommands.DEFAULT_WIDTH);
    expect(h.canPerform).toHaveBeenCalledWith("formatColumns");
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("the backend's own refusal (it now gates the standard width too) is shown", async () => {
    h.setDefaultColumnWidth.mockRejectedValueOnce("Cannot change the standard column width on a protected sheet.");
    await CommandRegistry.execute(CoreCommands.DEFAULT_WIDTH);
    await openedDialog().onResult!(75);
    expect(h.alert).toHaveBeenCalledWith("Cannot change the standard column width on a protected sheet.");
    expect(windowEvents).not.toContain("dimensions:refresh");
  });
});

describe("Hide & Unhide", () => {
  it("Hide Rows hides the rows a CELL selection spans, then refreshes", async () => {
    select(cells(2, 5, 4, 7));
    await CommandRegistry.execute(CoreCommands.HIDE_ROWS);
    expect(h.hideRows).toHaveBeenCalledWith([2, 3, 4], true);
    expect(windowEvents).toContain("grid:refresh");
  });

  it("Hide Columns hides the columns it spans", async () => {
    select(cells(2, 5, 4, 7));
    await CommandRegistry.execute(CoreCommands.HIDE_COLUMNS);
    expect(h.hideColumns).toHaveBeenCalledWith([5, 6, 7], true);
  });

  it("Unhide Rows unhides only the USER-hidden rows inside the span", async () => {
    h.userHiddenRows.mockResolvedValueOnce([2, 50]);
    select(cells(0, 0, 9, 0));
    await CommandRegistry.execute(CoreCommands.UNHIDE_ROWS);
    expect(h.hideRows).toHaveBeenCalledWith([2], false);
  });

  it("Unhide over a whole-column selection (Excel's select-all-then-unhide) sends the hidden rows, not a million indices", async () => {
    h.userHiddenRows.mockResolvedValueOnce([2, 50]);
    select({ startRow: 0, endRow: 1_048_575, startCol: 0, endCol: 3, type: "columns" });
    await CommandRegistry.execute(CoreCommands.UNHIDE_ROWS);
    expect(h.hideRows).toHaveBeenCalledWith([2, 50], false);
  });

  it("Unhide with nothing hidden in the span does nothing (Excel)", async () => {
    h.userHiddenCols.mockResolvedValueOnce([40]);
    select(cells(0, 0, 0, 9));
    await CommandRegistry.execute(CoreCommands.UNHIDE_COLUMNS);
    expect(h.hideColumns).not.toHaveBeenCalled();
  });

  it("Unhide Columns unhides the user-hidden columns in the span", async () => {
    h.userHiddenCols.mockResolvedValueOnce([3]);
    select(cells(0, 2, 0, 4));
    await CommandRegistry.execute(CoreCommands.UNHIDE_COLUMNS);
    expect(h.hideColumns).toHaveBeenCalledWith([3], false);
  });

  it("hiding every row of the sheet is refused, not sent", async () => {
    select({ startRow: 0, endRow: 1_048_575, startCol: 0, endCol: 0, type: "columns" });
    await CommandRegistry.execute(CoreCommands.HIDE_ROWS);
    expect(h.hideRows).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });
});

describe("a selection owner holds the selection (BUG-0185 class)", () => {
  let release: () => void = () => {};
  afterEach(() => release());

  it("every Cell Size / Visibility command is refused with one toast and touches nothing", async () => {
    release = registerSelectionOwner({ id: "test", label: "the test object's cells", ownsSelection: () => true });
    select(cells(0, 0, 3, 3));
    for (const id of [
      CoreCommands.ROW_HEIGHT,
      CoreCommands.COLUMN_WIDTH,
      CoreCommands.HIDE_ROWS,
      CoreCommands.HIDE_COLUMNS,
      CoreCommands.UNHIDE_ROWS,
      CoreCommands.UNHIDE_COLUMNS,
    ]) {
      toasts.length = 0;
      await CommandRegistry.execute(id);
      expect(toasts.length, id).toBe(1);
    }
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.hideRows).not.toHaveBeenCalled();
    expect(h.hideColumns).not.toHaveBeenCalled();
    expect(h.userHiddenRows).not.toHaveBeenCalled();
  });

  it("Default Width is a SHEET setting, not a selection door: it still opens", async () => {
    release = registerSelectionOwner({ id: "test", label: "the test object's cells", ownsSelection: () => true });
    await CommandRegistry.execute(CoreCommands.DEFAULT_WIDTH);
    expect(h.openDialog).toHaveBeenCalledTimes(1);
  });
});

describe("the right-click Column Width... / Row Height... (the per-column undo defect)", () => {
  function menuContext(selection: Selection): GridMenuContext {
    return {
      selection,
      clickedCell: { row: selection.startRow, col: selection.startCol },
      isWithinSelection: true,
      sheetIndex: 0,
      sheetName: "Sheet1",
      dimensions: createEmptyDimensionOverrides(),
    };
  }
  function item(id: string) {
    const found = gridExtensions.getContextMenuItems().find((i) => i.id === id);
    if (!found) throw new Error(`menu item ${id} not registered`);
    return found;
  }

  beforeEach(() => {
    gridExtensions.clear();
    registerCoreGridContextMenu();
    vi.clearAllMocks();
  });

  it("resizing five columns is ONE undo step, not five", async () => {
    await item("core:columnWidth").onClick(
      menuContext({ startRow: 0, endRow: 1_048_575, startCol: 1, endCol: 5, type: "columns" }),
    );
    await openedDialog().onResult!(80);
    expect(h.setColumnWidths.mock.calls).toEqual([[[[1, 5]], 80]]);
    expect(h.setColumnWidth).not.toHaveBeenCalled();
  });

  it("resizing three rows is ONE undo step", async () => {
    await item("core:rowHeight").onClick(
      menuContext({ startRow: 2, endRow: 4, startCol: 0, endCol: 16_383, type: "rows" }),
    );
    const data = openedDialog();
    expect(data.rangeLabel).toBe("3:5");
    await data.onResult!(30);
    expect(h.setRowHeights.mock.calls).toEqual([[[[2, 4]], 30]]);
    expect(h.setRowHeight).not.toHaveBeenCalled();
  });
});
