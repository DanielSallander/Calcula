//! FILENAME: app/src/core/components/Spreadsheet/__tests__/floatingReferencePickRouting.test.tsx
// PURPOSE: Where a finished REFERENCE PICK on a floating object goes (D-PICK,
//          owner finding F3) -- `handleFloatingReferencePick`, the ONE router
//          for every family -- driven through the REAL useSpreadsheetSelection
//          hook: a press on a floating object whose `referenceAt` answers, the
//          capture-phase release of the pick session, and the real formula
//          reference interceptor registry.
//            sheet, one cell   -> the interceptors are asked (GETPIVOTDATA);
//                                 an external target gets the text qualified
//                                 with the ACTIVE sheet's name
//            sheet, a range    -> a plain range; the interceptors are NOT asked
//            object            -> `<name>!A1(:B3)`; the interceptors are NEVER
//                                 asked, even when one answers for (0,0) -- the
//                                 "Float2!A1 became GETPIVOTDATA" hazard
// CONTEXT: precedent coreEditInterceptedPickCrossSheet.test.tsx (same harness).

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
import { setGlobalCursorPosition, setGlobalEditingValue, setGlobalIsEditing } from "../../../hooks/useEditing";
import {
  __resetExternalEditForTests,
  registerExternalFormulaTarget,
  type ExternalFormulaReference,
} from "../../../lib/formulaEditTarget";
import { __resetReferencePickStateForTests } from "../../../lib/referencePickState";
import { cancelFloatingReferencePick } from "../../../hooks/useMouseSelection/layout/floatingReferencePickSession";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  type GridRegion,
  type OverlayReferencePick,
} from "../../../../api/gridOverlays";
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

const TYPE = "routing-pick-test";
const REGION: GridRegion = {
  id: "obj-1",
  type: TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: {},
  floating: { x: 100, y: 100, width: 200, height: 150 },
};

/** The object's left half answers `left`, its right half `right` (a drag from one to the other spans both). */
let left: OverlayReferencePick | null = null;
let right: OverlayReferencePick | null = null;

let root: Root;
let host: HTMLDivElement;
const offs: Array<() => void> = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Client points over the object's left and right halves (the container sits at the client origin). */
function points(): { left: { x: number; y: number }; right: { x: number; y: number } } {
  const cfg = observedConfig!;
  const y = cfg.colHeaderHeight + 100 + 75;
  return {
    left: { x: cfg.rowHeaderWidth + 100 + 40, y },
    right: { x: cfg.rowHeaderWidth + 100 + 160, y },
  };
}

async function pick(from: "left" | "right", to: "left" | "right" = from): Promise<void> {
  const p = points();
  const start = p[from];
  const end = p[to];
  const target = host.querySelector('[data-testid="container"]') as HTMLElement;
  const event = {
    clientX: start.x,
    clientY: start.y,
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
  if (to !== from) {
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: end.x, clientY: end.y, buttons: 1 }));
    });
  }
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: end.x, clientY: end.y, button: 0 }));
  });
  await settle();
}

/** Core's own edit holding `=SUM(`, caret at the end, on the active sheet. */
async function openCoreEdit(sheetName: string): Promise<void> {
  const text = "=SUM(";
  setGlobalEditingValue(text);
  setGlobalCursorPosition(text.length);
  // The synchronous "Core's edit is open" flag the pick predicate reads (the
  // reducer action alone does not raise it; useEditing's own start does).
  setGlobalIsEditing(true);
  await act(async () => {
    dispatchOut(startEditing({ row: 0, col: 0, value: text, sourceSheetIndex: 0, sourceSheetName: sheetName }));
  });
  await settle();
}

interface FakeTarget {
  refs: ExternalFormulaReference[];
  texts: string[];
}
/** An external editor (a floating grid's cell editor) expecting a reference. */
function externalTarget(withText: boolean): FakeTarget {
  const fake: FakeTarget = { refs: [], texts: [] };
  offs.push(
    registerExternalFormulaTarget({
      isExpectingReference: () => true,
      insertReference: (ref) => fake.refs.push(ref),
      ...(withText ? { insertText: (text: string) => fake.texts.push(text) } : {}),
    }),
  );
  return fake;
}

/** A pivot cell interceptor answering for (row, col); the spy records every question. */
function pivotAt(row: number, col: number): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (r: number, c: number) =>
    r === row && c === col
      ? { text: 'GETPIVOTDATA("Sales",$C$3,"Region","East")', highlightRow: row, highlightCol: col }
      : null,
  );
  offs.push(registerFormulaReferenceInterceptor(spy));
  return spy;
}

beforeEach(async () => {
  __resetExternalEditForTests();
  __resetReferencePickStateForTests();
  handlers = null;
  left = null;
  right = null;
  offs.push(
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      referenceAt: (ctx) =>
        ctx.canvasX < (ctx.floatingCanvasBounds?.x ?? 0) + 100 ? left : right,
    }),
  );
  setGridRegions([REGION]);
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
    dispatchOut(setActiveSheet(0, "Canvas1"));
    dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
  });
  await settle();
});

afterEach(async () => {
  cancelFloatingReferencePick();
  while (offs.length) offs.pop()!();
  unregisterGridOverlay(TYPE);
  setGridRegions([]);
  __resetExternalEditForTests();
  __resetReferencePickStateForTests();
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalIsEditing(false);
  setGlobalEditingValue("");
  setGlobalCursorPosition(0);
});

describe("a 'sheet' pick (a canvas pivot's hidden-grid cell) is routed like a grid pick", () => {
  it("one cell, external target: the interceptor's GETPIVOTDATA, qualified with the ACTIVE sheet", async () => {
    const target = externalTarget(true);
    const asked = pivotAt(2, 2);
    left = { space: "sheet", row: 2, col: 2 };
    await pick("left");
    expect(asked).toHaveBeenCalledWith(2, 2);
    expect(target.texts).toEqual(['GETPIVOTDATA("Sales",Canvas1!$C$3,"Region","East")']);
    expect(target.refs).toEqual([]);
  });

  it("one cell, Core's own edit on the same sheet: the GETPIVOTDATA text goes in unchanged", async () => {
    await openCoreEdit("Canvas1");
    pivotAt(2, 2);
    left = { space: "sheet", row: 2, col: 2 };
    await pick("left");
    expect(editingValue).toBe('=SUM(GETPIVOTDATA("Sales",$C$3,"Region","East")');
  });

  it("one cell no interceptor answers: the plain reference", async () => {
    const target = externalTarget(true);
    left = { space: "sheet", row: 4, col: 1 };
    await pick("left");
    expect(target.refs).toEqual([{ sheetName: "Canvas1", startRow: 4, startCol: 1, endRow: 4, endCol: 1 }]);
  });

  it("a dragged RANGE: a plain range reference, and the interceptors are NOT asked", async () => {
    const target = externalTarget(true);
    const asked = pivotAt(1, 1);
    left = { space: "sheet", row: 1, col: 1 };
    right = { space: "sheet", row: 3, col: 4 };
    await pick("left", "right");
    expect(asked).not.toHaveBeenCalled();
    expect(target.refs).toEqual([{ sheetName: "Canvas1", startRow: 1, startCol: 1, endRow: 3, endCol: 4 }]);
    expect(target.texts).toEqual([]);
  });

  it("a dragged range in Core's own edit: B2:E4", async () => {
    await openCoreEdit("Canvas1");
    left = { space: "sheet", row: 1, col: 1 };
    right = { space: "sheet", row: 3, col: 4 };
    await pick("left", "right");
    expect(editingValue).toBe("=SUM(B2:E4");
  });
});

describe("an 'object' pick (a floating grid's cell) names the object and never asks the interceptors", () => {
  it("external target: insertReference with the object's name, even with an interceptor answering for (0,0)", async () => {
    const target = externalTarget(true);
    const asked = pivotAt(0, 0);
    left = { space: "object", name: "Float2", row: 0, col: 0 };
    await pick("left");
    expect(asked).not.toHaveBeenCalled();
    expect(target.refs).toEqual([{ sheetName: "Float2", startRow: 0, startCol: 0, endRow: 0, endCol: 0 }]);
    expect(target.texts).toEqual([]);
  });

  it("external target, a drag: the spanned range", async () => {
    const target = externalTarget(false);
    left = { space: "object", name: "Float2", row: 0, col: 0 };
    right = { space: "object", name: "Float2", row: 2, col: 1 };
    await pick("left", "right");
    expect(target.refs).toEqual([{ sheetName: "Float2", startRow: 0, startCol: 0, endRow: 2, endCol: 1 }]);
  });

  it("Core's own edit: Float2!A1:B3 typed into the formula", async () => {
    await openCoreEdit("Canvas1");
    const asked = pivotAt(0, 0);
    left = { space: "object", name: "Float2", row: 0, col: 0 };
    right = { space: "object", name: "Float2", row: 2, col: 1 };
    await pick("left", "right");
    expect(asked).not.toHaveBeenCalled();
    expect(editingValue).toBe("=SUM(Float2!A1:B3");
  });

  it("Core's own edit: a name that needs quoting is quoted by the parser's rule", async () => {
    await openCoreEdit("Canvas1");
    left = { space: "object", name: "My Float", row: 0, col: 0 };
    await pick("left");
    expect(editingValue).toBe("=SUM('My Float'!A1");
  });
});

describe("control", () => {
  it("with no pick in progress the press inserts nothing", async () => {
    left = { space: "object", name: "Float2", row: 0, col: 0 };
    const target = { refs: [] as ExternalFormulaReference[] };
    offs.push(
      registerExternalFormulaTarget({
        isExpectingReference: () => false,
        insertReference: (ref) => target.refs.push(ref),
      }),
    );
    await pick("left");
    expect(target.refs).toEqual([]);
    expect(editingValue).toBeNull();
  });
});
