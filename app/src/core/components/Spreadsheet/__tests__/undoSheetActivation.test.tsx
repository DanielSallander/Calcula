//! FILENAME: app/src/core/components/Spreadsheet/__tests__/undoSheetActivation.test.tsx
// PURPOSE: An undo/redo that restores another sheet must take the WHOLE view
//          there in one step -- grid, tab strip, formula bar and per-sheet
//          chrome -- and must not take it anywhere the backend did not go.
//
// CONTEXT: Excel keeps ONE undo history and switches to the sheet the undone
//          action happened on, so the user sees what changed. The backend now
//          performs that switch (it owns the per-sheet mirrors) and reports the
//          result on `UndoResult.activeSheetIndex` / `activeSheetName`; this is
//          the frontend half.
//
//          THE HAZARD THIS FILE EXISTS FOR is a switch the frontend follows
//          only partially: Sheet1's tab over Sheet2's data, which is worse than
//          the silence it replaces. Everything that has to move already answers
//          to the tab click's own channel -- `sheet:beforeSwitch`,
//          `sheet:normalSwitch` and SHEET_CHANGED -- and the grid's sheet
//          context, which is what the tab strip syncs its highlight from. So
//          the test asserts that an undo fires exactly that sequence, in that
//          order, and that a same-sheet undo fires none of it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Backend ---------------------------------------------------------------

/** What the mocked `getCell` answers with -- the ACTIVE sheet's cell. */
let cellOnActiveSheet: { display: string; formula: string | null } | null = null;
const getCellAnswer = () => cellOnActiveSheet;

/** What the mocked `undo`/`redo` command answers with. */
let undoAnswer: Record<string, unknown>;
let redoAnswer: Record<string, unknown>;

const undoSpy = vi.fn(async () => undoAnswer);
const redoSpy = vi.fn(async () => redoAnswer);

vi.mock("../../../lib/tauri-api", () => ({
  undo: () => undoSpy(),
  redo: () => redoSpy(),
  getCell: vi.fn(async () => getCellAnswer()),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearRange: vi.fn(async () => {}),
  clearRangeOnSheets: vi.fn(async () => []),
  applyFormatting: vi.fn(async () => []),
  getStyle: vi.fn(async () => null),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  fillRange: vi.fn(async () => []),
  calculateNow: vi.fn(async () => []),
  calculateSheet: vi.fn(async () => []),
  recalcControlDependents: vi.fn(async () => []),
  getAllColumnWidths: vi.fn(async () => []),
  getAllRowHeights: vi.fn(async () => []),
  getDefaultDimensions: vi.fn(async () => ({
    defaultColumnWidth: 64,
    defaultRowHeight: 20,
  })),
  getViewportCells: vi.fn(async () => []),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => {}),
  applyColsHidden: vi.fn(async () => {}),
  refreshUserHidden: vi.fn(async () => {}),
}));

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { CommandRegistry, CoreCommands } from "../../../../api/commands";
import { AppEvents } from "../../../../api/events";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Every event the follow is supposed to fire, in the order it fired. */
let fired: Array<{ name: string; detail: unknown }> = [];

const WATCHED = [
  "sheet:beforeSwitch",
  "sheet:normalSwitch",
  AppEvents.SHEET_CHANGED,
] as const;

function record(event: Event): void {
  fired.push({ name: event.type, detail: (event as CustomEvent).detail });
}

/** A restore result with the fields under test, and neutral values elsewhere. */
function restoreResult(over: Record<string, unknown>): Record<string, unknown> {
  return {
    success: true,
    description: "Edit cell",
    updatedCells: [],
    canUndo: true,
    canRedo: true,
    mergeChanged: false,
    structuralRestore: false,
    pivotChanged: false,
    slicerChanged: false,
    ribbonFilterChanged: false,
    paneControlChanged: false,
    objectsChanged: false,
    hiddenChanged: false,
    refreshDomains: [],
    activeSheetIndex: 0,
    activeSheetName: "Sheet1",
    restoredAnchor: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness: the real hook, mounted the way Spreadsheet.tsx mounts it.
// ---------------------------------------------------------------------------

/** The grid state as the hook last saw it, for assertions after the fact. */
let observedSheetIndex = -1;
let observedSelection: { endRow: number; endCol: number } | null = null;
/** What the hook is feeding the formula bar. */
let observedFormulaBar = "";

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);

  observedSheetIndex = state.sheetContext.activeSheetIndex;
  observedSelection = state.selection
    ? { endRow: state.selection.endRow, endCol: state.selection.endCol }
    : null;

  const hook = useSpreadsheetSelection({
    canvasRef,
    containerRef,
    focusContainerRef,
    scrollRef,
    state,
    dispatch,
    isFocused: true,
    onCommitBeforeSelect: async () => {},
  });
  observedFormulaBar = hook.selectedCellContent;

  return <div ref={focusContainerRef} data-testid="grid" tabIndex={0} />;
}

let root: Root;
let host: HTMLDivElement;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Capture(): null {
  dispatchOut = useGridContext().dispatch;
  return null;
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Capture />
        <Harness />
      </GridProvider>,
    );
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pressUndo(): Promise<void> {
  await act(async () => {
    await CommandRegistry.execute(CoreCommands.UNDO);
  });
  await settle();
}

async function pressRedo(): Promise<void> {
  await act(async () => {
    await CommandRegistry.execute(CoreCommands.REDO);
  });
  await settle();
}

describe("undo activates the sheet it restored", () => {
  beforeEach(async () => {
    fired = [];
    observedSheetIndex = -1;
    observedSelection = null;
    observedFormulaBar = "";
    cellOnActiveSheet = null;
    undoAnswer = restoreResult({});
    redoAnswer = restoreResult({});
    undoSpy.mockClear();
    redoSpy.mockClear();
    for (const name of WATCHED) window.addEventListener(name, record);
    await mount();
    // Start where the user is: Sheet1, with a selection somewhere other than
    // the cell any restore below touches, so a moved cursor is visible.
    await act(async () => {
      dispatchOut(setActiveSheet(0, "Sheet1"));
      dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
    });
    await settle();
  });

  afterEach(async () => {
    for (const name of WATCHED) window.removeEventListener(name, record);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("takes the grid, the tab strip and the chrome to the restored sheet in one step", async () => {
    undoAnswer = restoreResult({
      activeSheetIndex: 1,
      activeSheetName: "Sheet2",
      restoredAnchor: { row: 5, col: 2 },
    });

    await pressUndo();

    // THE GRID'S SHEET CONTEXT. The tab strip has no state of its own: it syncs
    // its highlight from this, so this single value is what makes the tab and
    // the grid agree.
    expect(observedSheetIndex).toBe(1);

    // THE CHANNEL, in order. `beforeSwitch` has to precede the context change
    // or the sheet being LEFT never gets its selection and scroll saved;
    // `normalSwitch` is what re-reads dimensions, zoom, split, freeze panes,
    // the display flags and the cells; SHEET_CHANGED is what the extensions
    // listen to.
    expect(fired.map((e) => e.name)).toEqual([
      "sheet:beforeSwitch",
      "sheet:normalSwitch",
      AppEvents.SHEET_CHANGED,
    ]);
    expect(fired[0].detail).toEqual({ oldSheetIndex: 0, newSheetIndex: 1 });
    expect(fired[1].detail).toEqual({ newSheetIndex: 1, newSheetName: "Sheet2" });
    expect(fired[2].detail).toEqual({ sheetIndex: 1, sheetName: "Sheet2" });
  });

  it("aims the selection at the cell it restored", async () => {
    // Switching sheets is only half of "so the user can see what changed": the
    // restored cell can be anywhere on a sheet that was left scrolled
    // elsewhere. The formula bar reads the ACTIVE cell, so this is also what
    // makes the formula bar agree with the grid.
    undoAnswer = restoreResult({
      activeSheetIndex: 1,
      activeSheetName: "Sheet2",
      restoredAnchor: { row: 5, col: 2 },
    });

    await pressUndo();

    expect(observedSelection).toEqual({ endRow: 5, endCol: 2 });
  });

  it("leaves the selection alone when the restore names no cell", async () => {
    // A column width describes a whole column and a snapshot the whole sheet;
    // neither names a cell worth aiming at, and inventing A1 would move the
    // cursor for no reason.
    undoAnswer = restoreResult({
      activeSheetIndex: 1,
      activeSheetName: "Sheet2",
      restoredAnchor: null,
    });

    await pressUndo();

    expect(observedSheetIndex).toBe(1);
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
  });

  it("does nothing at all when the restore was on the sheet already in front of the user", async () => {
    // THE CONTROL, and it is load-bearing: the common case is a same-sheet
    // undo, and firing a switch for it would save and restore the sheet's own
    // selection, re-read every per-sheet store and re-fetch every cell on
    // every Ctrl+Z.
    undoAnswer = restoreResult({
      activeSheetIndex: 0,
      activeSheetName: "Sheet1",
      restoredAnchor: { row: 5, col: 2 },
    });

    await pressUndo();

    expect(fired).toEqual([]);
    expect(observedSheetIndex).toBe(0);
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
  });

  it("follows a redo exactly as it follows an undo", async () => {
    // Redo shares the backend function with undo but not the frontend path it
    // used to have: these two handlers were byte-identical copies, and every
    // gap this path has ever had was added to one and forgotten in the other.
    redoAnswer = restoreResult({
      activeSheetIndex: 2,
      activeSheetName: "Sheet3",
      restoredAnchor: { row: 1, col: 1 },
    });

    await pressRedo();

    expect(observedSheetIndex).toBe(2);
    expect(fired.map((e) => e.name)).toEqual([
      "sheet:beforeSwitch",
      "sheet:normalSwitch",
      AppEvents.SHEET_CHANGED,
    ]);
    expect(observedSelection).toEqual({ endRow: 1, endCol: 1 });
  });

  it("re-reads the formula bar when the sheet moves under an unchanged selection", async () => {
    // A DEFECT OF ITS OWN, and it predates undo learning to switch sheets: the
    // effect that fills the formula bar depended on the selection coordinates
    // and `isEditing` only. `getCell` reads the ACTIVE sheet, so a switch that
    // lands on the SAME coordinates -- the common case, because a sheet with no
    // saved state gets A1 and A1 is where you already were -- re-ran nothing,
    // and the formula bar went on showing the sheet you had just left. The
    // ordinary tab click hits this too; undo's switch merely makes it constant.
    cellOnActiveSheet = { display: "Sheet1 value", formula: null };
    await act(async () => {
      dispatchOut(setSelection({ startRow: 3, startCol: 3, endRow: 3, endCol: 3, type: "cells" }));
    });
    await settle();
    expect(observedFormulaBar).toBe("Sheet1 value");

    // The sheet moves; the selection does NOT.
    cellOnActiveSheet = { display: "Sheet2 value", formula: null };
    undoAnswer = restoreResult({
      activeSheetIndex: 1,
      activeSheetName: "Sheet2",
      restoredAnchor: { row: 3, col: 3 },
    });

    await pressUndo();

    expect(observedSheetIndex).toBe(1);
    expect(observedSelection).toEqual({ endRow: 3, endCol: 3 });
    expect(observedFormulaBar).toBe("Sheet2 value");
  });

  it("does not switch when the backend refused to switch", async () => {
    // A HIDDEN target: Excel cannot make a hidden sheet active, so the backend
    // restores it and stays put. The frontend must not invent a switch the
    // backend did not make -- it would put the grid on a sheet with no tab.
    // The backend says so simply by reporting the sheet the user is still on.
    undoAnswer = restoreResult({
      activeSheetIndex: 0,
      activeSheetName: "Sheet1",
      restoredAnchor: null,
    });

    await pressUndo();

    expect(fired).toEqual([]);
    expect(observedSheetIndex).toBe(0);
  });
});
