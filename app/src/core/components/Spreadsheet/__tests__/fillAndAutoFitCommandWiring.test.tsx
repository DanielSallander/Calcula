//! FILENAME: app/src/core/components/Spreadsheet/__tests__/fillAndAutoFitCommandWiring.test.tsx
// PURPOSE: The Home tab's Fill and Format > AutoFit items reach Core's REAL
//          handlers through the command registry: Fill Down on ONE cell copies
//          the cell above, a refused fill is shown, and AutoFit Row Height's
//          `{ growOnly: true }` survives the whole trip (CommandRegistry ->
//          grid bridge -> useSpreadsheetSelection's handler -> the fit).
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) The rules themselves are
//          pinned by core/lib/fillCommands and core/lib/autoFitCommands; this
//          file pins the WIRING, which a unit test of either module cannot see.
//          Driven through the real hook (harness of undoRefusalToast).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  fillRange: vi.fn(async (): Promise<unknown[]> => []),
  getCellsInRows: vi.fn(async (): Promise<unknown[]> => []),
  setRowHeight: vi.fn(async () => {}),
  beginUndoTransaction: vi.fn(async (): Promise<number | null> => 5),
  commitUndoTransaction: vi.fn(async () => {}),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async () => {}), confirmAsync: vi.fn(async () => true) }));
const measure = vi.hoisted(() => ({ rowHeight: vi.fn((): number | null => null) }));

vi.mock("../../../lib/tauri-api", () => ({
  getCell: vi.fn(async () => null),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: (...a: unknown[]) => api.setRowHeight(...(a as [])),
  clearRange: vi.fn(async () => {}),
  clearRangeOnSheets: vi.fn(async () => []),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
  applyFormatting: vi.fn(async () => []),
  getStyle: vi.fn(async () => null),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: (...a: unknown[]) => api.getCellsInRows(...(a as [])),
  beginUndoTransaction: (...a: unknown[]) => api.beginUndoTransaction(...(a as [])),
  commitUndoTransaction: (...a: unknown[]) => api.commitUndoTransaction(...(a as [])),
  cancelUndoTransaction: vi.fn(async () => {}),
  fillRange: (...a: unknown[]) => api.fillRange(...(a as [])),
  calculateNow: vi.fn(async () => []),
  calculateSheet: vi.fn(async () => []),
  recalcControlDependents: vi.fn(async () => []),
  getAllColumnWidths: vi.fn(async () => []),
  getAllRowHeights: vi.fn(async () => []),
  getDefaultDimensions: vi.fn(async () => ({ defaultColumnWidth: 64, defaultRowHeight: 20 })),
  getViewportCells: vi.fn(async () => []),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => true),
  applyColsHidden: vi.fn(async () => true),
  refreshUserHidden: vi.fn(async () => {}),
}));

vi.mock("../../../lib/dialogs", () => dialogs);

// The renderer's measurer (a canvas in the app) answers what the test says.
vi.mock("../../../lib/gridRenderer/layout/autoFit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureOptimalRowHeight: () => measure.rowHeight(),
}));

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection, setRowHeight } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import { CommandRegistry, CoreCommands } from "../../../../api/commands";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);
  dispatchOut = dispatch;
  useSpreadsheetSelection({
    canvasRef,
    containerRef,
    focusContainerRef,
    scrollRef,
    state,
    dispatch,
    isFocused: true,
    onCommitBeforeSelect: async () => {},
  });
  return (
    <div ref={containerRef}>
      <div ref={focusContainerRef} data-focus-container="spreadsheet" tabIndex={0} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function select(startRow: number, startCol: number, endRow: number, endCol: number): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow, startCol, endRow, endCol, type: "cells" }));
  });
  await settle();
}

async function run(command: string, args?: unknown): Promise<void> {
  await act(async () => {
    await CommandRegistry.execute(command, args);
  });
  await settle();
}

beforeEach(async () => {
  __resetExternalEditForTests();
  for (const fn of Object.values(api)) fn.mockClear();
  api.fillRange.mockImplementation(async () => []);
  api.getCellsInRows.mockImplementation(async () => []);
  api.beginUndoTransaction.mockImplementation(async () => 5);
  dialogs.alertAsync.mockClear();
  measure.rowHeight.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Harness />
      </GridProvider>,
    );
  });
  await act(async () => {
    dispatchOut(setActiveSheet(0, "Sheet1"));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("Fill through the command registry", () => {
  it("Fill Down on ONE cell copies the cell above (it used to do nothing)", async () => {
    await select(2, 1, 2, 1);
    await run(CoreCommands.FILL_DOWN);
    expect(api.fillRange.mock.calls).toEqual([[1, 1, 1, 1, 2, 1, 2, 1]]);
  });

  it("Fill Left on one cell copies the cell to the RIGHT", async () => {
    await select(4, 3, 4, 3);
    await run(CoreCommands.FILL_LEFT);
    expect(api.fillRange.mock.calls).toEqual([[4, 4, 4, 4, 4, 3, 4, 3]]);
  });

  it("a refused fill is SHOWN", async () => {
    api.fillRange.mockImplementation(async () => {
      throw "The cell is on a protected sheet.";
    });
    await select(2, 1, 5, 1);
    await run(CoreCommands.FILL_DOWN);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });
});

describe("AutoFit through the command registry", () => {
  it("AutoFit Row Height is registered by Core", () => {
    expect(CommandRegistry.has(CoreCommands.AUTOFIT_ROW_HEIGHT)).toBe(true);
    expect(CommandRegistry.has(CoreCommands.AUTOFIT_COLUMN_WIDTH)).toBe(true);
  });

  it("{ growOnly: true } arrives: a row the user made taller is NOT shrunk", async () => {
    api.getCellsInRows.mockImplementation(async () => [{ row: 3, col: 0, display: "x", styleIndex: 0 }]);
    measure.rowHeight.mockReturnValue(24);
    await act(async () => {
      dispatchOut(setRowHeight(3, 60));
    });
    await select(3, 0, 3, 0);
    await run(CoreCommands.AUTOFIT_ROW_HEIGHT, { growOnly: true });
    expect(api.setRowHeight, "growOnly was dropped on the way: a full fit shrank the row").not.toHaveBeenCalled();
  });

  it("control: without args the same row IS fitted (shrunk to its content)", async () => {
    api.getCellsInRows.mockImplementation(async () => [{ row: 3, col: 0, display: "x", styleIndex: 0 }]);
    measure.rowHeight.mockReturnValue(24);
    await act(async () => {
      dispatchOut(setRowHeight(3, 60));
    });
    await select(3, 0, 3, 0);
    await run(CoreCommands.AUTOFIT_ROW_HEIGHT);
    expect(api.setRowHeight).toHaveBeenCalledWith(3, 24);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(5);
  });
});
