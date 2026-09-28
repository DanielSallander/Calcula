//! FILENAME: app/src/core/components/Spreadsheet/__tests__/externalEditCellInterceptors.test.tsx
// PURPOSE: While an EXTERNAL edit session is live (a floating grid's cell edit,
//          hosted by the formula bar or parked on another sheet), a grid click
//          belongs to that session: it picks a reference when the formula
//          expects one, and otherwise commits the session before selecting.
//          The cell CLICK INTERCEPTORS (checkbox and button cell types, cell
//          behaviours, pivot filter buttons) must not run instead.
// CONTEXT: The interceptor door in useSpreadsheetSelection's mouse-down wrapper
//          read Core's own `isEditing` only. With a floating-grid cell edited
//          in the formula bar and "=NOT(" typed, a click on a checkbox cell
//          toggled the CELL (a write, an undo entry, a dirty document) instead
//          of inserting the reference, and a button cell ran its macro. Parked
//          on another sheet it was worse: the interceptors answered from the
//          HOST sheet's stale indexes. This drives the REAL hook with a
//          registered fake session and a claiming interceptor.

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
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { registerCellClickInterceptor } from "../../../lib/cellClickInterceptors";
import {
  __resetExternalEditForTests,
  setExternalSessionParked,
} from "../../../lib/formulaEditTarget";
import {
  createFakeExternalEdit,
  type FakeExternalEdit,
} from "../../../lib/__tests__/helpers/fakeExternalEdit";
import type { GridConfig } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Handlers = ReturnType<typeof useSpreadsheetSelection>["mouseHandlers"];

/** The hook's CURRENT mouse handlers (refreshed on every render). */
let handlers: Handlers | null = null;
let observedConfig: GridConfig | null = null;
let observedSelection: { endRow: number; endCol: number } | null = null;
const commitBeforeSelect = vi.fn(async () => {});

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);

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

/** A left press + release on the centre of cell (row, col) of the grid. */
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

describe("a grid click during a live external session never reaches the cell click interceptors", () => {
  let fake: FakeExternalEdit;
  let interceptor: ReturnType<typeof vi.fn>;
  let offInterceptor: () => void;

  beforeEach(async () => {
    __resetExternalEditForTests();
    commitBeforeSelect.mockClear();
    handlers = null;
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
      dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
    });
    await settle();

    // A claiming interceptor on every cell -- the shape of the checkbox and
    // button cell types: it WRITES / runs code and returns true.
    interceptor = vi.fn(async () => true);
    offInterceptor = registerCellClickInterceptor(interceptor);
  });

  afterEach(async () => {
    offInterceptor();
    __resetExternalEditForTests();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("control: with no session, the claiming interceptor takes the click (the harness reaches the door)", async () => {
    await clickCell(1, 2);
    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(interceptor.mock.calls[0].slice(0, 2)).toEqual([1, 2]);
    expect(commitBeforeSelect).not.toHaveBeenCalled();
  });

  it("a session EXPECTING a reference gets the pick: the interceptor is not asked, the reference is inserted", async () => {
    fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=NOT(" });
    fake.register();

    await clickCell(1, 2);

    expect(interceptor).not.toHaveBeenCalled();
    expect(fake.session.text).toBe("=NOT(Sheet1!C2");
    // The pick moved nothing on the grid and committed nothing.
    expect(commitBeforeSelect).not.toHaveBeenCalled();
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(0);
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
  });

  it("a PARKED session picks the same way -- the host sheet's stale interceptor indexes never answer", async () => {
    fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=NOT(" });
    fake.register();
    setExternalSessionParked(0);

    await clickCell(1, 2);

    expect(interceptor).not.toHaveBeenCalled();
    expect(fake.session.text).toBe("=NOT(Sheet1!C2");
  });

  it("a session NOT expecting a reference takes the commit-before-select path, not the interceptor", async () => {
    fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "7" });
    fake.register();

    await clickCell(1, 2);

    expect(interceptor).not.toHaveBeenCalled();
    expect(commitBeforeSelect).toHaveBeenCalledTimes(1);
    expect(fake.session.text).toBe("7");
  });
});
