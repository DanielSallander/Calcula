//! FILENAME: app/src/core/components/Spreadsheet/__tests__/cellTargetSelectionWiring.test.tsx
// PURPOSE: The WIRING of a floating grid's cells into Core's own handlers
//          (P3 S10, owner finding G3), through the real useSpreadsheetSelection:
//            - Fill Down / AutoFit through the command registry reach the
//              handler with the grid-command door's OBJECT target, and the
//              writes name it (never Core's hidden selection under the grid);
//            - the format keys (Ctrl+B, Ctrl+Shift+5) the keyboard resolves to
//              the grid write the grid's cells with `{ target }`, and Ctrl+B
//              reads the toggle direction from the GRID's active cell;
//            - Delete clears the grid's cells through the target.
// CONTEXT: Harness of fillAndAutoFitCommandWiring.test.tsx. The selection owner
//          is REAL (core/lib/selectionOwner), shaped like the floating grid's.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  fillRange: vi.fn(async (): Promise<unknown[]> => []),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async (index: number) => ({ bold: index === 9 })),
  clearRange: vi.fn(async () => 0),
  clearRangeWithOptions: vi.fn(async () => undefined),
  setColumnWidths: vi.fn(async () => undefined),
  setColumnWidth: vi.fn(async () => {}),
  beginUndoTransaction: vi.fn(async (): Promise<number | null> => 5),
  commitUndoTransaction: vi.fn(async () => {}),
}));
const seam = vi.hoisted(() => ({
  read: vi.fn(),
  lines: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("../../../lib/tauri-api", () => ({
  getCell: (...a: unknown[]) => api.getCell(...(a as [])),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: (...a: unknown[]) => api.setColumnWidth(...(a as [])),
  setColumnWidths: (...a: unknown[]) => api.setColumnWidths(...(a as [])),
  setRowHeights: vi.fn(async () => undefined),
  setRowsHidden: vi.fn(async () => []),
  setColsHidden: vi.fn(async () => []),
  setRowHeight: vi.fn(async () => {}),
  clearRange: (...a: unknown[]) => api.clearRange(...(a as [])),
  clearRangeWithOptions: (...a: unknown[]) => api.clearRangeWithOptions(...(a as [])),
  clearRangeOnSheets: vi.fn(async () => []),
  clearCommentsInRange: vi.fn(async () => 0),
  clearNotesInRange: vi.fn(async () => 0),
  clearHyperlinksInRange: vi.fn(async () => 0),
  getHyperlinksInRange: vi.fn(async () => []),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
  applyFormatting: (...a: unknown[]) => api.applyFormatting(...(a as [])),
  getStyle: (...a: unknown[]) => api.getStyle(...(a as [never])),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: vi.fn(async () => []),
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
vi.mock("../../../../api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCellTargetCells: (...a: unknown[]) => seam.read(...a),
  readTargetCell: async (_ref: unknown, row: number, col: number) =>
    row === 2 && col === 1 ? { row, col, display: "x", formula: null, styleIndex: 9, valueKind: "text" } : null,
  getCellTargetLines: (...a: unknown[]) => seam.lines(...a),
  announceCellTargetObjectChanged: (...a: unknown[]) => seam.announce(...a),
}));
vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => true),
  applyColsHidden: vi.fn(async () => true),
  refreshUserHidden: vi.fn(async () => {}),
}));
vi.mock("../../../lib/dialogs", () => ({ alertAsync: vi.fn(async () => {}), confirmAsync: vi.fn(async () => true) }));
vi.mock("../../../lib/gridRenderer/layout/autoFit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureOptimalColumnWidth: () => 140,
  measureOptimalRowHeight: () => null,
}));

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import { registerSelectionOwner, type CellTargetCapability } from "../../../lib/selectionOwner";
import { CommandRegistry, CoreCommands } from "../../../../api/commands";
import type { Selection } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const ADMITS: readonly CellTargetCapability[] = [
  "read", "format", "numberFormat", "content", "clear", "sort", "structure", "lineSize", "merge", "conditionalFormat",
];

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let focusEl: HTMLDivElement | null = null;

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
      <div
        ref={(el) => {
          focusContainerRef.current = el;
          focusEl = el;
        }}
        data-focus-container="spreadsheet"
        tabIndex={0}
      />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let frSelection: Selection | null = null;
let release: () => void = () => {};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function run(command: string, args?: unknown): Promise<void> {
  await act(async () => {
    await CommandRegistry.execute(command, args);
  });
  await settle();
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    focusEl!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

function cells(startRow: number, startCol: number, endRow: number, endCol: number): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells" };
}

beforeEach(async () => {
  __resetExternalEditForTests();
  for (const fn of Object.values(api)) fn.mockClear();
  for (const fn of Object.values(seam)) fn.mockReset();
  seam.read.mockResolvedValue({
    cells: [{ row: 0, col: 1, display: "wide text", formula: null, styleIndex: 0, valueKind: "text" }],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  });
  seam.lines.mockResolvedValue({ rowHeights: {}, colWidths: {}, hiddenRows: [], hiddenCols: [] });
  frSelection = null;
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    actsOn: ADMITS,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 6, cols: 4 }, label: "Float1", wholeObject: false },
  });
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
    // Core's selection: the hidden sheet cell under the grid.
    dispatchOut(setSelection({ startRow: 30, startCol: 30, endRow: 30, endCol: 30, type: "cells" }));
  });
  await settle();
});

afterEach(async () => {
  release();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("the grid-command door hands Core's handlers the floating grid's cells", () => {
  it("Fill Down fills the GRID with its target (never Core's hidden selection)", async () => {
    frSelection = cells(1, 1, 3, 1);
    await run(CoreCommands.FILL_DOWN);
    expect(api.fillRange.mock.calls).toEqual([[1, 1, 1, 1, 2, 1, 3, 1, { target: REF }]]);
  });

  it("AutoFit Column Width measures the GRID's cells and writes the grid's width", async () => {
    frSelection = cells(0, 1, 0, 1);
    await run(CoreCommands.AUTOFIT_COLUMN_WIDTH);
    expect(seam.read).toHaveBeenCalledWith(REF, { startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
    expect(api.setColumnWidths).toHaveBeenCalledWith([[1, 1]], 140, { target: REF });
    expect(api.setColumnWidth, "wrote the SHEET's column width").not.toHaveBeenCalled();
  });

  it("control: without the grid, Fill Down acts on Core's selection with no target", async () => {
    await act(async () => {
      dispatchOut(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
    });
    await settle();
    await run(CoreCommands.FILL_DOWN);
    expect(api.fillRange.mock.calls).toEqual([[1, 1, 1, 1, 2, 1, 2, 1]]);
  });
});

describe("the keyboard's format keys and Delete on the floating grid's cells", () => {
  it("Ctrl+B toggles from the GRID's active cell and writes the grid's cells with the target", async () => {
    frSelection = { ...cells(2, 1, 2, 2), activeRow: 2, activeCol: 1 } as Selection;
    // (Mounting read Core's cells for its own selection; only the key counts.)
    api.getCell.mockClear();
    await press("b", { ctrlKey: true });
    expect(api.getCell, "read Core's hidden cell for the toggle direction").not.toHaveBeenCalled();
    expect(api.applyFormatting).toHaveBeenCalledWith([2], [1, 2], { bold: false }, { target: REF });
  });

  it("Delete clears the GRID's cells through the target, never Core's hidden cells", async () => {
    frSelection = cells(1, 0, 2, 1);
    await press("Delete");
    expect(api.clearRangeWithOptions).toHaveBeenCalledWith(1, 0, 2, 1, "contents", undefined, { target: REF });
    expect(api.clearRange, "cleared Core's hidden selection").not.toHaveBeenCalled();
  });
});
