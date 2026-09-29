//! FILENAME: app/src/core/components/Spreadsheet/__tests__/coreEditInterceptedPickCrossSheet.test.tsx
// PURPOSE: In Core's OWN cell edit, a pick an interceptor replaced with formula
//          text (GETPIVOTDATA over a pivot cell) made on ANOTHER sheet names
//          that sheet -- the same way a plain cell pick there does
//          (`Q1-2026!C3`). Driven through the REAL useSpreadsheetSelection
//          hook (its useEditing and useMouseSelection) and the real
//          interceptor registry.
// CONTEXT: W14 (wave C; wb-edit new defect 9). The Pivot extension's
//          interceptor (extensions/Pivot/index.ts) builds
//          `GETPIVOTDATA("Sales",$C$3,...)` with a BARE cell reference, and
//          Core's `insertFormulaText` inserted it as it was. With the edit
//          parked on Sheet1 while the user picked on the pivot's sheet, `$C$3`
//          then pointed at Sheet1!C3 -- a GETPIVOTDATA whose pivot argument is
//          not a pivot, #REF! on Enter, with nothing on screen to say why.
//          An EXTERNAL edit already qualified it (E2, qualifyInterceptedCellRef).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../lib/tauri-api", () => ({
  getCell: vi.fn(async () => null),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearRange: vi.fn(async () => {}),
  clearRangeOnSheets: vi.fn(async () => []),
  undo: vi.fn(async () => {
    throw new Error("not under test");
  }),
  redo: vi.fn(async () => {
    throw new Error("not under test");
  }),
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
  getDefaultDimensions: vi.fn(async () => ({ defaultColumnWidth: 64, defaultRowHeight: 20 })),
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
import { registerFormulaReferenceInterceptor } from "../../../lib/formulaReferenceInterceptors";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection, startEditing } from "../../../state/gridActions";
import { setGlobalCursorPosition, setGlobalEditingValue } from "../../../hooks/useEditing";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import type { GridConfig } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Handlers = ReturnType<typeof useSpreadsheetSelection>["mouseHandlers"];

let handlers: Handlers | null = null;
let observedConfig: GridConfig | null = null;
let editingValue: string | null = null;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);
  observedConfig = state.config;
  editingValue = state.editing?.value ?? null;
  dispatchOut = dispatch;
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
  handlers = hook.mouseHandlers;
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={focusContainerRef} data-focus-container="spreadsheet" tabIndex={0} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let offInterceptor: () => void = () => {};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function clickCell(row: number, col: number): Promise<void> {
  const cfg = observedConfig!;
  const x = cfg.rowHeaderWidth + cfg.defaultCellWidth * col + cfg.defaultCellWidth / 2;
  const y = cfg.colHeaderHeight + cfg.defaultCellHeight * row + cfg.defaultCellHeight / 2;
  const target = host.querySelector('[data-testid="container"]') as HTMLElement;
  const event = {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    detail: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    currentTarget: target,
    target,
    nativeEvent: new MouseEvent("mousedown"),
    preventDefault: () => {},
    stopPropagation: () => {},
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: () => {},
  } as unknown as React.MouseEvent<HTMLElement>;
  await act(async () => {
    await handlers!.handleMouseDown(event);
  });
  await settle();
  await act(async () => {
    handlers!.handleMouseUp();
  });
  await settle();
}

/** Core's own edit of Sheet1!A1 holding `=SUM(`, caret at the end. */
async function openCoreEdit(): Promise<void> {
  const text = "=SUM(";
  // The caret first: the hook reads it while rendering the edit (isFormulaMode).
  setGlobalEditingValue(text);
  setGlobalCursorPosition(text.length);
  await act(async () => {
    dispatchOut(
      startEditing({ row: 0, col: 0, value: text, sourceSheetIndex: 0, sourceSheetName: "Sheet1" }),
    );
  });
  await settle();
}

/** The grid shows another sheet while the edit stays on Sheet1 (point mode). */
async function viewSheet(index: number, name: string): Promise<void> {
  await act(async () => {
    dispatchOut(setActiveSheet(index, name));
  });
  await settle();
}

function pivotAt(row: number, col: number): void {
  offInterceptor = registerFormulaReferenceInterceptor(async (r, c) =>
    r === row && c === col
      ? { text: 'GETPIVOTDATA("Sales",$C$3,"Region","East")', highlightRow: row, highlightCol: col }
      : null,
  );
}

beforeEach(async () => {
  __resetExternalEditForTests();
  handlers = null;
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
    dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
  });
  await settle();
});

afterEach(async () => {
  offInterceptor();
  offInterceptor = () => {};
  __resetExternalEditForTests();
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalEditingValue("");
  setGlobalCursorPosition(0);
});

describe("Core's own edit: a GETPIVOTDATA pick on ANOTHER sheet names that sheet (W14)", () => {
  it("picked on Pivots: the pivot cell reference is qualified with Pivots!", async () => {
    await openCoreEdit();
    await viewSheet(1, "Pivots");
    pivotAt(2, 2);
    await clickCell(2, 2);
    expect(editingValue).toBe('=SUM(GETPIVOTDATA("Sales",Pivots!$C$3,"Region","East")');
  });

  it("the prefix follows the parser's rule: Q1-2026 is quoted", async () => {
    await openCoreEdit();
    await viewSheet(1, "Q1-2026");
    pivotAt(2, 2);
    await clickCell(2, 2);
    expect(editingValue).toBe("=SUM(GETPIVOTDATA(\"Sales\",'Q1-2026'!$C$3,\"Region\",\"East\")");
  });

  it("an interceptor text with no findable cell reference falls back to the plain qualified cell", async () => {
    await openCoreEdit();
    await viewSheet(1, "Pivots");
    offInterceptor = registerFormulaReferenceInterceptor(async () => ({
      text: 'GETPIVOTDATA("Sales",PivotAnchor)',
      highlightRow: 2,
      highlightCol: 2,
    }));
    await clickCell(2, 2);
    expect(editingValue).toBe("=SUM(Pivots!C3");
  });

  it("control: on the edit's OWN sheet the text goes in unchanged", async () => {
    await openCoreEdit();
    pivotAt(2, 2);
    await clickCell(2, 2);
    expect(editingValue).toBe('=SUM(GETPIVOTDATA("Sales",$C$3,"Region","East")');
  });
});
