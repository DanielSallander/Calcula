//! FILENAME: app/src/core/components/Spreadsheet/__tests__/floatingPressBeforeCells.test.tsx
// PURPOSE: A press on a FLOATING OBJECT -- a live resize handle of a selected
//          object, or its body -- is the object's, BEFORE the fill handle and
//          the cell click interceptors (BUG-0258 design phase 3, "handles only
//          where they work"). Driven through the REAL mouse-down wrapper of
//          useSpreadsheetSelection, the door every grid press goes through.
// CONTEXT: The wrapper checked the fill handle first, then routed only a press
//          on an object's BODY past the interceptors (`isOverFloatingOverlay`
//          was the body test alone). A handle is centred on the object's edge,
//          so its outer half lies over the neighbouring cells: a press there
//          reached `checkCellClickInterceptors` for the cell underneath -- a
//          checkbox toggled, a button cell ran its macro, a validation or
//          filter chevron opened -- and the resize never started, while the
//          hover showed the resize pointer. A handle (or a body) painted over
//          the selection's fill handle started a FILL drag. The objects and
//          their handles are painted over the cells, the selection and its
//          fill handle (core.ts), so the object answers first.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
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
import { registerCellClickInterceptor, type CellClickInterceptorFn } from "../../../lib/cellClickInterceptors";
import { setGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../api/objectSelection";
import type { GridConfig } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Handlers = ReturnType<typeof useSpreadsheetSelection>["mouseHandlers"];

let handlers: Handlers | null = null;
let observedConfig: GridConfig | null = null;
const commitBeforeSelect = vi.fn(async () => {});

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);
  observedConfig = state.config;
  const hook = useSpreadsheetSelection({
    canvasRef,
    containerRef,
    focusContainerRef,
    scrollRef,
    state,
    dispatch,
    isFocused: true,
    onCommitBeforeSelect: commitBeforeSelect,
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
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Capture(): null {
  dispatchOut = useGridContext().dispatch;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mouseEvent(x: number, y: number): React.MouseEvent<HTMLElement> {
  const target = host.querySelector('[data-testid="container"]') as HTMLElement;
  return {
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
}

/** A human drag through the wrapper: press at `from`, move to `to`, release. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await act(async () => {
    await handlers!.handleMouseDown(mouseEvent(from.x, from.y));
  });
  await settle();
  await act(async () => {
    handlers!.handleMouseMove(mouseEvent(to.x, to.y));
  });
  await settle();
  await act(async () => {
    handlers!.handleMouseUp();
  });
  await settle();
}

const TYPE = "press-order-test";
/** Sheet px: canvas [RHW+130 .. RHW+330] x [CHH+100 .. CHH+250]. */
const BOX = { x: 130, y: 100, width: 200, height: 150 };

function region(): GridRegion {
  return {
    id: "obj-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { ...BOX },
    data: {},
  };
}

/** The object's canvas rectangle, from the hook's own config. */
function rect(): { L: number; T: number; R: number; B: number } {
  const cfg = observedConfig!;
  const L = cfg.rowHeaderWidth + BOX.x;
  const T = cfg.colHeaderHeight + BOX.y;
  return { L, T, R: L + BOX.width, B: T + BOX.height };
}

/** The cell under a canvas point (default dimensions, no scroll). */
function cellAt(x: number, y: number): { row: number; col: number } {
  const cfg = observedConfig!;
  return {
    row: Math.floor((y - cfg.colHeaderHeight) / cfg.defaultCellHeight),
    col: Math.floor((x - cfg.rowHeaderWidth) / cfg.defaultCellWidth),
  };
}

/**
 * A point inside the FILL HANDLE of a selection whose bottom-right cell is
 * (row, col) -- the handle's hit box is x2-12 .. x2+2 around the cell's
 * bottom-right corner (useFillHandle.ts): 4px up and left of the corner.
 */
function fillHandlePointOf(row: number, col: number): { x: number; y: number } {
  const cfg = observedConfig!;
  return {
    x: cfg.rowHeaderWidth + (col + 1) * cfg.defaultCellWidth - 4,
    y: cfg.colHeaderHeight + (row + 1) * cfg.defaultCellHeight - 4,
  };
}

let selected = true;
let interceptor: Mock<CellClickInterceptorFn>;
let offInterceptor: () => void;
let offProvider: () => void;
const resizes: Array<{ x: number; y: number; width: number; height: number }> = [];
const presses: string[] = [];
const onResize = (e: Event) => {
  const d = (e as CustomEvent).detail;
  resizes.push({ x: d.x, y: d.y, width: d.width, height: d.height });
};
const onSelected = (e: Event) => {
  presses.push((e as CustomEvent).detail.regionId);
};

beforeEach(async () => {
  commitBeforeSelect.mockClear();
  handlers = null;
  selected = true;
  resizes.length = 0;
  presses.length = 0;
  offProvider = registerObjectSelectionProvider({
    types: [TYPE],
    isSelected: () => selected,
    select: () => {},
    deselectAll: () => {},
  });
  setGridRegions([region()]);
  window.addEventListener("floatingObject:resizeComplete", onResize);
  window.addEventListener("floatingObject:selected", onSelected);

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
  await act(async () => {
    dispatchOut(setActiveSheet(0, "Sheet1"));
  });
  await settle();

  // A claiming interceptor on every cell -- the shape of the checkbox and
  // button cell types, a validation chevron, a hyperlink: it ACTS and returns true.
  interceptor = vi.fn<CellClickInterceptorFn>(async () => true);
  offInterceptor = registerCellClickInterceptor(interceptor);
});

afterEach(async () => {
  offInterceptor();
  window.removeEventListener("floatingObject:resizeComplete", onResize);
  window.removeEventListener("floatingObject:selected", onSelected);
  await act(async () => {
    root.unmount();
  });
  host.remove();
  offProvider();
  resetObjectSelectionProviders();
  setGridRegions([]);
});

async function selectCell(row: number, col: number): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" }));
  });
  await settle();
}

describe("a press on a floating object is the object's, before the cells and the fill handle", () => {
  it("control: a press on a plain cell well clear of the object reaches the cell's interceptor", async () => {
    await selectCell(0, 0);
    const { B } = rect();
    await drag({ x: 60, y: B + 60 }, { x: 60, y: B + 60 });
    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(interceptor.mock.calls[0].slice(0, 2)).toEqual([
      cellAt(60, B + 60).row,
      cellAt(60, B + 60).col,
    ]);
  });

  it("a press on the OUTER half of a selected object's right-edge handle resizes it -- the cell under that half never acts", async () => {
    await selectCell(0, 0);
    const { R, T } = rect();
    const press = { x: R + 4, y: T + BOX.height / 2 };
    // The point is OUTSIDE the object, over a cell: exactly the half at stake.
    expect(press.x).toBeGreaterThan(R);

    await drag(press, { x: press.x + 20, y: press.y });

    expect(interceptor, "the cell under the handle acted (a checkbox toggled, a macro ran)").not.toHaveBeenCalled();
    expect(resizes, "the handle did not resize the object").toEqual([
      { x: BOX.x, y: BOX.y, width: BOX.width + 20, height: BOX.height },
    ]);
  });

  it("the same point on an UNSELECTED object is the cell's: no handle is live there", async () => {
    selected = false;
    await selectCell(0, 0);
    const { R, T } = rect();
    const press = { x: R + 4, y: T + BOX.height / 2 };
    await drag(press, { x: press.x + 20, y: press.y });
    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(interceptor.mock.calls[0].slice(0, 2)).toEqual([cellAt(press.x, press.y).row, cellAt(press.x, press.y).col]);
    expect(resizes).toEqual([]);
  });

  it("a live handle painted over the selection's FILL HANDLE resizes the object; no fill drag starts", async () => {
    const { L, T } = rect();
    const wMid = { x: L, y: T + BOX.height / 2 };
    // A selected cell whose fill handle lies under the left-edge handle's
    // OUTER half (outside the object): find it from the geometry.
    const cell = cellAt(wMid.x - 4, wMid.y + 4);
    await selectCell(cell.row, cell.col);
    const press = { x: wMid.x - 3, y: wMid.y + 3 };
    const fill = fillHandlePointOf(cell.row, cell.col);
    // Precondition: the press IS on the fill handle's hit box (x2-12..x2+2).
    expect(Math.abs(press.x - (fill.x + 4 - 5))).toBeLessThanOrEqual(7);
    expect(Math.abs(press.y - (fill.y + 4 - 5))).toBeLessThanOrEqual(7);
    expect(press.x).toBeLessThan(L);

    await drag(press, { x: press.x - 20, y: press.y });

    expect(resizes, "the fill handle took the press meant for the handle painted over it").toEqual([
      { x: BOX.x - 20, y: BOX.y, width: BOX.width + 20, height: BOX.height },
    ]);
    expect(interceptor).not.toHaveBeenCalled();
  });

  it("the BODY of an object painted over the selection's fill handle is the object's: the press selects it", async () => {
    selected = false;
    const { L, T } = rect();
    // A cell well inside the object's body; its fill handle is covered.
    const cell = cellAt(L + 60, T + 60);
    await selectCell(cell.row, cell.col);
    const fill = fillHandlePointOf(cell.row, cell.col);
    expect(fill.x).toBeGreaterThan(L);
    expect(fill.y).toBeGreaterThan(T);

    await drag(fill, fill);

    expect(presses, "the fill handle under the object took the press").toEqual(["obj-1"]);
    expect(interceptor).not.toHaveBeenCalled();
  });
});
