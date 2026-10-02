//! FILENAME: app/src/core/components/Spreadsheet/__tests__/cellReleaseClaimWiring.test.tsx
// PURPOSE: Core's mouse-down door holds a press a cell click interceptor
//          answered with a RELEASE CLAIM, and the claim acts at the release
//          over the same cell -- driven through the REAL mouse-down wrapper of
//          useSpreadsheetSelection (BUG-0258 design phase 4: "Buttons and pivot
//          +/- act on release instead of on press, and sliding off cancels").
// CONTEXT: The interceptors used to act on the press (an in-cell button ran its
//          macro, a worksheet pivot's +/- toggled the moment the mouse went
//          down). The door now opens Core's press session (core/lib/
//          cellPressRelease.ts) BEFORE it asks the interceptors -- they are
//          async, and a fast click's mouseup arrives while they still answer --
//          and hands the session the claim. What this file pins is the DOOR:
//          the claimed press selects nothing and commits nothing, the release
//          runs the claim once over the same cell and never over another cell,
//          over a floating object stacked on the cells, over DOM outside the
//          grid or over a claimed element, and a release heard during the
//          interceptors' answer still counts.

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
import { setActiveSheet, setFreezeConfig, setSelection, setViewport, setZoom } from "../../../state/gridActions";
import {
  actOnCellRelease,
  isCellPressed,
  registerCellClickInterceptor,
  type CellClickAnswer,
  type CellPressPoint,
} from "../../../lib/cellClickInterceptors";
import { cancelCellPress, isCellPressHeld } from "../../../lib/cellPressRelease";
import { setGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import { POINTER_CLAIM_ATTR } from "../../../lib/pointerClaims";
import type { GridConfig } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Handlers = ReturnType<typeof useSpreadsheetSelection>["mouseHandlers"];

let handlers: Handlers | null = null;
let observedConfig: GridConfig | null = null;
let observedSelection: { endRow: number; endCol: number } | null = null;
const commitBeforeSelect = vi.fn(async () => {});
const redraws = vi.fn();

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef({ redraw: redraws } as never);
  observedConfig = state.config;
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
    onCommitBeforeSelect: commitBeforeSelect,
  });
  handlers = hook.mouseHandlers;
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={focusContainerRef} data-focus-container="spreadsheet" tabIndex={0} />
      <div data-testid="claimed" {...{ [POINTER_CLAIM_ATTR]: "form" }} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let outside: HTMLDivElement;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let stateOut: ReturnType<typeof useGridContext>["state"];

function Capture(): null {
  const ctx = useGridContext();
  dispatchOut = ctx.dispatch;
  stateOut = ctx.state;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function container(): HTMLElement {
  return host.querySelector('[data-testid="container"]') as HTMLElement;
}

/** The centre of cell (row, col) in client px (the container sits at 0,0, zoom 1). */
function centre(row: number, col: number): { x: number; y: number } {
  const cfg = observedConfig!;
  return {
    x: cfg.rowHeaderWidth + cfg.defaultCellWidth * col + cfg.defaultCellWidth / 2,
    y: cfg.colHeaderHeight + cfg.defaultCellHeight * row + cfg.defaultCellHeight / 2,
  };
}

function mouseDown(p: { x: number; y: number }, button = 0): React.MouseEvent<HTMLElement> {
  const target = container();
  return {
    clientX: p.x,
    clientY: p.y,
    button,
    buttons: button === 0 ? 1 : 2,
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

async function press(p: { x: number; y: number }, button = 0): Promise<void> {
  await act(async () => {
    await handlers!.handleMouseDown(mouseDown(p, button));
  });
  await settle();
}

/** A real mouseup ON `on` (default: the grid area), bubbling to the window, then the grid's own up. */
async function release(p: { x: number; y: number }, on?: EventTarget): Promise<void> {
  await act(async () => {
    (on ?? container()).dispatchEvent(
      new MouseEvent("mouseup", { clientX: p.x, clientY: p.y, button: 0, buttons: 0, bubbles: true }),
    );
    handlers!.handleMouseUp();
  });
  await settle();
}

async function moveTo(p: { x: number; y: number }, on?: EventTarget): Promise<void> {
  await act(async () => {
    (on ?? container()).dispatchEvent(
      new MouseEvent("mousemove", { clientX: p.x, clientY: p.y, buttons: 1, bubbles: true }),
    );
  });
}

/** The claimed button cell: C2. */
const BUTTON = { row: 1, col: 2 };
const runs: CellPressPoint[] = [];
let answerFor: (row: number, col: number) => Promise<CellClickAnswer>;
let offInterceptor: () => void;

/** Sheet px: a floating object over cells D4:F8 (canvas px from the cell area origin). */
const TYPE = "release-cover-test";
function coverRegion(): GridRegion {
  const cfg = observedConfig!;
  return {
    id: "cover-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    // Covers the button cell C2 exactly (its sheet-px rectangle).
    floating: {
      x: cfg.defaultCellWidth * BUTTON.col,
      y: cfg.defaultCellHeight * BUTTON.row,
      width: cfg.defaultCellWidth,
      height: cfg.defaultCellHeight,
    },
    data: {},
  };
}

beforeEach(async () => {
  cancelCellPress();
  commitBeforeSelect.mockClear();
  redraws.mockClear();
  runs.length = 0;
  handlers = null;
  host = document.createElement("div");
  outside = document.createElement("div");
  document.body.appendChild(host);
  document.body.appendChild(outside);
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
    dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
  });
  await settle();

  answerFor = async (row, col) =>
    row === BUTTON.row && col === BUTTON.col
      ? actOnCellRelease(row, col, (p) => void runs.push(p), { pressedLook: true })
      : false;
  offInterceptor = registerCellClickInterceptor((row, col) => answerFor(row, col));
});

afterEach(async () => {
  offInterceptor();
  cancelCellPress();
  setGridRegions([]);
  await act(async () => {
    root.unmount();
  });
  host.remove();
  outside.remove();
});

describe("Core's door holds a claimed cell press until its release", () => {
  it("the press runs nothing, selects nothing and commits nothing; the release on the same cell runs it ONCE", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    expect(runs, "the claim ran on the PRESS").toEqual([]);
    expect(isCellPressHeld()).toBe(true);
    expect(isCellPressed(BUTTON.row, BUTTON.col), "no pressed look while held over the button").toBe(true);
    expect(observedSelection, "a claimed press moved the selection").toEqual({ endRow: 0, endCol: 0 });
    expect(commitBeforeSelect).not.toHaveBeenCalled();

    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs.map((p) => [p.row, p.col])).toEqual([[BUTTON.row, BUTTON.col]]);
    expect(isCellPressHeld()).toBe(false);
    expect(isCellPressed(BUTTON.row, BUTTON.col)).toBe(false);
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
  });

  it("slid off and released on ANOTHER cell: nothing runs, and the look goes off while outside", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    await moveTo(centre(BUTTON.row, BUTTON.col + 2));
    expect(isCellPressed(BUTTON.row, BUTTON.col), "the button still looked pressed with the pointer off it").toBe(false);
    expect(redraws).toHaveBeenCalled();
    await release(centre(BUTTON.row, BUTTON.col + 2));
    expect(runs, "a release on another cell ran the button").toEqual([]);
  });

  it("released over DOM OUTSIDE the grid at the button's coordinates: nothing runs", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    await release(centre(BUTTON.row, BUTTON.col), outside);
    expect(runs, "a release over a menu or a pane covering the button ran it").toEqual([]);
  });

  it("released over an element that CLAIMED the pointer (an on-grid form) at the button's coordinates: nothing runs", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    await release(centre(BUTTON.row, BUTTON.col), host.querySelector('[data-testid="claimed"]')!);
    expect(runs).toEqual([]);
  });

  it("released where a FLOATING OBJECT now covers the button cell: nothing runs", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    setGridRegions([coverRegion()]);
    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs, "a release on an object stacked over the button ran the button").toEqual([]);
  });

  it("a FAST click: the release heard while the interceptor was still answering runs the claim once", async () => {
    let answer: (a: CellClickAnswer) => void = () => {};
    answerFor = (row, col) =>
      new Promise<CellClickAnswer>((resolve) => {
        answer = resolve;
        void row;
        void col;
      });
    let down: Promise<void> = Promise.resolve();
    await act(async () => {
      down = handlers!.handleMouseDown(mouseDown(centre(BUTTON.row, BUTTON.col))) as unknown as Promise<void>;
      await Promise.resolve();
    });
    // The release arrives BEFORE the claim does.
    await act(async () => {
      container().dispatchEvent(
        new MouseEvent("mouseup", { clientX: centre(BUTTON.row, BUTTON.col).x, clientY: centre(BUTTON.row, BUTTON.col).y, button: 0, buttons: 0, bubbles: true }),
      );
    });
    expect(runs).toEqual([]);
    await act(async () => {
      answer(actOnCellRelease(BUTTON.row, BUTTON.col, (p) => void runs.push(p), { pressedLook: true }));
      await down;
    });
    await settle();
    expect(runs.map((p) => [p.row, p.col]), "the fast click's release was lost").toEqual([[BUTTON.row, BUTTON.col]]);
    expect(isCellPressHeld()).toBe(false);
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
  });

  it("a press on an unclaimed cell selects it as before, and arms nothing", async () => {
    await press(centre(4, 4));
    expect(isCellPressHeld()).toBe(false);
    await release(centre(4, 4));
    expect(observedSelection).toEqual({ endRow: 4, endCol: 4 });
    expect(runs).toEqual([]);
  });

  it("a RIGHT press on the button is taken and runs nothing, at the press or at its release", async () => {
    await press(centre(BUTTON.row, BUTTON.col), 2);
    expect(isCellPressHeld()).toBe(false);
    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs, "a right press ran the button").toEqual([]);
  });

  it("a press on a FLOATING OBJECT (a path that never asks the interceptors) also ends a held one", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    expect(isCellPressHeld()).toBe(true);
    // An object over cells far from the button; the press goes straight to the object.
    const cfg = observedConfig!;
    setGridRegions([
      {
        id: "object-1",
        type: TYPE,
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
        floating: { x: cfg.defaultCellWidth * 6, y: cfg.defaultCellHeight * 8, width: 80, height: 40 },
        data: {},
      },
    ]);
    await press({
      x: cfg.rowHeaderWidth + cfg.defaultCellWidth * 6 + 40,
      y: cfg.colHeaderHeight + cfg.defaultCellHeight * 8 + 20,
    });
    expect(isCellPressHeld(), "a press on a floating object left the cell press held").toBe(false);
    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs).toEqual([]);
  });

  it("the next press ends a held one: its later release runs nothing", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    expect(isCellPressHeld()).toBe(true);
    await press(centre(5, 5), 2);
    expect(isCellPressHeld()).toBe(false);
    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs).toEqual([]);
  });
});

// THE RELEASE IS PLACED THE WAY THE PRESS WAS. The release check
// (`cellPressDeps.cellAt` / `sheetKey`) is a SECOND call into the grid's
// geometry, beside the press-time one whose comment records that a pane
// mismatch already shipped once ("THE PANE OPTIONS ARE NOT OPTIONAL"). If the
// two ever disagree, the press arms one cell and the release is judged over
// another: a button that never runs, or one that runs on a release over a
// different cell.
describe("the release is judged with the press's own geometry", () => {
  // SABOTAGE: drop `/ g.zoom` from cellPressDeps.cellAt in
  // useSpreadsheetSelection.ts -> the release lands on another cell, red.
  it("at ZOOM 1.5: the release on the button runs it once; a release on the neighbouring cell runs nothing", async () => {
    await act(async () => {
      dispatchOut(setZoom(1.5));
    });
    await settle();
    const zoomed = (p: { x: number; y: number }) => ({ x: p.x * 1.5, y: p.y * 1.5 });

    await press(zoomed(centre(BUTTON.row, BUTTON.col)));
    expect(isCellPressHeld(), "the zoomed press on the button was not claimed").toBe(true);
    await release(zoomed(centre(BUTTON.row, BUTTON.col)));
    expect(runs.map((p) => [p.row, p.col]), "a release on the zoomed button did not run it").toEqual([[BUTTON.row, BUTTON.col]]);

    runs.length = 0;
    await press(zoomed(centre(BUTTON.row, BUTTON.col)));
    await release(zoomed(centre(BUTTON.row, BUTTON.col + 1)));
    expect(runs, "a release on the neighbouring cell ran the button").toEqual([]);
  });

  // SABOTAGE: call getCellFromPixel in cellPressDeps.cellAt WITHOUT the pane
  // options -> the release in the frozen row is read as a cell ten rows down,
  // and the button never runs, red.
  it("FROZEN ROWS on a scrolled sheet: a button in the frozen row runs on a release over its own cell", async () => {
    const FROZEN = { row: 0, col: 2 };
    answerFor = async (row, col) =>
      row === FROZEN.row && col === FROZEN.col
        ? actOnCellRelease(row, col, (p) => void runs.push(p), { pressedLook: true })
        : false;
    await act(async () => {
      dispatchOut(setFreezeConfig(1, null));
    });
    await act(async () => {
      const cfg = observedConfig!;
      dispatchOut(setViewport({ ...stateOut.viewport, startRow: 10, scrollY: cfg.defaultCellHeight * 10 }));
    });
    await settle();
    expect(stateOut.viewport.scrollY, "the sheet did not scroll").toBeGreaterThan(0);

    await press(centre(FROZEN.row, FROZEN.col));
    expect(isCellPressHeld(), "the press in the frozen row was not claimed").toBe(true);
    await release(centre(FROZEN.row, FROZEN.col));
    expect(runs.map((p) => [p.row, p.col]), "the release in the frozen row was placed on another cell").toEqual([
      [FROZEN.row, FROZEN.col],
    ]);
  });

  // SABOTAGE: make cellPressDeps.sheetKey answer a constant -> the release on
  // the other sheet runs the button, red.
  it("a SHEET SWITCH while the press is held: the release at the same point runs nothing", async () => {
    await press(centre(BUTTON.row, BUTTON.col));
    expect(isCellPressHeld()).toBe(true);
    await act(async () => {
      dispatchOut(setActiveSheet(1, "Sheet2"));
    });
    await settle();
    await release(centre(BUTTON.row, BUTTON.col));
    expect(runs, "a press begun on Sheet1 ran at a release on Sheet2").toEqual([]);
  });
});
