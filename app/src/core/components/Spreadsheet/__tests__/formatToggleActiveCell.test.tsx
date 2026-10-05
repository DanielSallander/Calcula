//! FILENAME: app/src/core/components/Spreadsheet/__tests__/formatToggleActiveCell.test.tsx
// PURPOSE: Ctrl+B / Ctrl+I / Ctrl+U decide their direction from the ACTIVE cell
//          (the one the grid draws as active: `activeRow ?? endRow`), not the
//          anchor; and they, like the keyboard's number formats, format EVERY
//          block of a Ctrl+click / Go To Special selection in ONE undo step.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04; review finding (f) and the
//          Core half of the Go To Special formatting finding.) toggleFormatProperty
//          read `getCell(selection.startRow, selection.startCol)` -- the ANCHOR,
//          which Go To Special deliberately writes at the main range's far
//          corner (its first match is the active cell). After Go To Special
//          found A1:A5 with A5 bold and A1 not, Ctrl+B read A5 and UN-bolded
//          while the ribbon's Bold (reading the active cell) bolded. And the
//          write covered the main range only, so "Constants, then Ctrl+B"
//          bolded one area of many. Ctrl+; and Ctrl+: wrote into the anchor
//          too; Excel writes the date into the active cell.
//          Driven through the real hook and the real grid keyboard handler
//          (harness of fillAndAutoFitCommandWiring).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

/** Style 1 is bold; every other index is plain. */
const BOLD_STYLE = 1;

const api = vi.hoisted(() => ({
  getCell: vi.fn(async (_row: number, _col: number): Promise<unknown> => null),
  getStyle: vi.fn(async (_index: number): Promise<unknown> => ({})),
  applyFormatting: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ cells: [], styles: [] })),
  updateCell: vi.fn(async (..._args: unknown[]) => ({ cells: [] })),
  beginUndoTransaction: vi.fn(async (_label: string): Promise<number | null> => 5),
  commitUndoTransaction: vi.fn(async (..._args: unknown[]) => {}),
  cancelUndoTransaction: vi.fn(async (..._args: unknown[]) => {}),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (_m: string) => {}), confirmAsync: vi.fn(async () => true) }));

vi.mock("../../../lib/tauri-api", () => ({
  getCell: (...a: unknown[]) => api.getCell(...(a as [number, number])),
  getMergeInfo: vi.fn(async () => null),
  updateCell: (...a: unknown[]) => api.updateCell(...a),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearRange: vi.fn(async () => {}),
  clearRangeOnSheets: vi.fn(async () => []),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
  applyFormatting: (...a: unknown[]) => api.applyFormatting(...a),
  getStyle: (...a: unknown[]) => api.getStyle(...(a as [number])),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: vi.fn(async () => []),
  beginUndoTransaction: (...a: unknown[]) => api.beginUndoTransaction(...(a as [string])),
  commitUndoTransaction: (...a: unknown[]) => api.commitUndoTransaction(...a),
  cancelUndoTransaction: (...a: unknown[]) => api.cancelUndoTransaction(...a),
  fillRange: vi.fn(async () => []),
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

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import type { Selection } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let focusEl: HTMLDivElement;

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
      <div ref={focusContainerRef} data-focus-container="spreadsheet" data-testid="focus" tabIndex={0} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function select(selection: Selection): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection(selection));
  });
  await settle();
}

async function press(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    focusEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

/** Cells (row:col) that hold the bold style. */
let boldCells = new Set<string>();

beforeEach(async () => {
  __resetExternalEditForTests();
  for (const fn of Object.values(api)) fn.mockClear();
  dialogs.alertAsync.mockClear();
  boldCells = new Set();
  api.getCell.mockImplementation(async (row: number, col: number) => ({
    row,
    col,
    display: "",
    styleIndex: boldCells.has(`${row}:${col}`) ? BOLD_STYLE : 0,
  }));
  api.getStyle.mockImplementation(async (index: number) => ({
    bold: index === BOLD_STYLE,
    italic: false,
    strikethrough: false,
    underline: "none",
  }));
  api.applyFormatting.mockImplementation(async () => ({ cells: [], styles: [] }));
  api.beginUndoTransaction.mockImplementation(async () => 5);
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
  focusEl = host.querySelector("[data-testid='focus']") as HTMLDivElement;
  focusEl.focus();
  await settle();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

/** The `formatting` argument of every applyFormatting call. */
function formattings(): unknown[] {
  return api.applyFormatting.mock.calls.map((c) => c[2]);
}

describe("Ctrl+B decides from the ACTIVE cell, not the anchor", () => {
  it("Go To Special's shape (anchor at the far corner): A1 active and plain, A5 anchor and bold -> BOLD", async () => {
    boldCells.add("4:0");
    // selectionForMatches writes start = the far corner, end = the first match.
    await select({ startRow: 4, startCol: 0, endRow: 0, endCol: 0, type: "cells" });
    await press({ key: "b", ctrlKey: true });
    expect(api.getCell.mock.calls.map((c) => [c[0], c[1]])).toContainEqual([0, 0]);
    expect(api.getCell.mock.calls.map((c) => [c[0], c[1]]), "the toggle read the ANCHOR").not.toContainEqual([4, 0]);
    expect(formattings()).toEqual([{ bold: true }]);
  });

  it("a drag from a bold B2 down to a plain B5 (B5 active) -> BOLD, as the ribbon does", async () => {
    boldCells.add("1:1");
    await select({ startRow: 1, startCol: 1, endRow: 4, endCol: 1, type: "cells" });
    await press({ key: "b", ctrlKey: true });
    expect(formattings()).toEqual([{ bold: true }]);
  });

  // (Core's reducer keeps no activeRow / activeCol -- end IS the active cell
  // here; the "activeRow wins" half of the rule is pinned at the unit tier in
  // src/api/__tests__/selectionRules.test.ts.)
  it("a drag UP-LEFT from a bold D5 to a plain B2 (B2 active, D5 the anchor) -> BOLD", async () => {
    boldCells.add("4:3");
    await select({ startRow: 4, startCol: 3, endRow: 1, endCol: 1, type: "cells" });
    await press({ key: "i", ctrlKey: true });
    await press({ key: "b", ctrlKey: true });
    expect(formattings()).toEqual([{ italic: true }, { bold: true }]);
  });

  it("control: the active cell bold -> UN-bold", async () => {
    boldCells.add("4:1");
    await select({ startRow: 1, startCol: 1, endRow: 4, endCol: 1, type: "cells" });
    await press({ key: "b", ctrlKey: true });
    expect(formattings()).toEqual([{ bold: false }]);
  });
});

describe("the keyboard's formats cover EVERY block, in ONE undo step", () => {
  const goToSpecial = (): Selection => ({
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    type: "cells",
    additionalRanges: [
      { startRow: 2, startCol: 2, endRow: 2, endCol: 2 },
      { startRow: 5, startCol: 1, endRow: 6, endCol: 1 },
    ],
  });

  it("Ctrl+B over three Go To Special areas formats all three, as one step", async () => {
    await select(goToSpecial());
    await press({ key: "b", ctrlKey: true });
    expect(api.applyFormatting.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [[0], [0]],
      [[2], [2]],
      [[5, 6], [1]],
    ]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(5);
  });

  it("one block: one write, no bracket (the backend's own step)", async () => {
    await select({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" });
    await press({ key: "b", ctrlKey: true });
    expect(api.applyFormatting).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a refusal on a later block: what landed stays ONE step, and the refusal is SHOWN", async () => {
    api.applyFormatting.mockImplementation(async (rows: unknown) => {
      if ((rows as number[])[0] === 5) throw "The cell is on a protected sheet.";
      return { cells: [], styles: [] };
    });
    await select(goToSpecial());
    await press({ key: "b", ctrlKey: true });
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(5);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });

  it("refused on the first block: nothing landed, the empty step is cancelled", async () => {
    api.applyFormatting.mockImplementation(async () => {
      throw "Protected.";
    });
    await select(goToSpecial());
    await press({ key: "b", ctrlKey: true });
    expect(api.applyFormatting).toHaveBeenCalledTimes(1);
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(5);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Protected.");
  });
});

describe("Ctrl+; writes today's date into the ACTIVE cell", () => {
  it("Go To Special's shape: the date lands in the first match (end), not the anchor", async () => {
    await select({ startRow: 4, startCol: 0, endRow: 0, endCol: 0, type: "cells" });
    await press({ key: ";", code: "Semicolon", ctrlKey: true });
    expect(api.updateCell).toHaveBeenCalledTimes(1);
    expect(api.updateCell.mock.calls[0].slice(0, 2)).toEqual([0, 0]);
  });
});
