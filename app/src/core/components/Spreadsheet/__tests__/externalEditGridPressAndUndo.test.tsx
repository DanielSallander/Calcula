//! FILENAME: app/src/core/components/Spreadsheet/__tests__/externalEditGridPressAndUndo.test.tsx
// PURPOSE: Two Core doors an EXTERNAL edit session (a floating grid's cell
//          edit, hosted by the formula bar or parked on another sheet) must
//          answer, driven through the REAL useSpreadsheetSelection hook:
//          1. A handled grid cell press is ANNOUNCED (`onGridCellPressed`,
//             core/lib/cellClickInterceptors.ts) -- AFTER commit-before-select
//             and after the selection, and even when the press leaves Core's
//             selection unchanged (a click on the cell Core already had
//             active). A pick announces nothing.
//          2. Undo and Redo reached through the COMMAND (the ribbon's and the
//             Quick Access Toolbar's buttons, Edit > Undo, the CLI) do not run
//             while a session is live -- the rule the keyboard dispatcher
//             already follows for Ctrl+Z/Y (api/keybindings.ts).
// CONTEXT: Review round 2 (2026-09-27), FR findings #11 (variant) and #13.
//          (1) The cell-click interceptors stand down while a session is live,
//          so a floating grid's selected cell survived a press on Core's
//          already-active cell: the bar session was committed, and the formula
//          bar went on targeting the FLOATING cell. (2) The Undo button undid
//          a workbook action under an open edit, and an undo that followed its
//          sheet ended a parked edit through `sheet:beforeSwitch`, writing the
//          half-typed formula as text.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  undo: vi.fn(async (): Promise<unknown> => {
    throw new Error("undo stub: the call is what the test observes");
  }),
  redo: vi.fn(async (): Promise<unknown> => {
    throw new Error("redo stub: the call is what the test observes");
  }),
}));

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
  undo: () => api.undo(),
  redo: () => api.redo(),
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
import { onGridCellPressed, type GridCellPress } from "../../../lib/cellClickInterceptors";
import {
  __resetExternalEditForTests,
  setExternalSessionParked,
} from "../../../lib/formulaEditTarget";
import {
  createFakeExternalEdit,
  type FakeExternalEdit,
} from "../../../lib/__tests__/helpers/fakeExternalEdit";
import { CommandRegistry, CoreCommands } from "../../../../api/commands";
import type { GridConfig } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Handlers = ReturnType<typeof useSpreadsheetSelection>["mouseHandlers"];

let handlers: Handlers | null = null;
let observedConfig: GridConfig | null = null;
let observedSelection: { endRow: number; endCol: number } | null = null;

/** Everything that happened, in order: the commit and the announcement. */
const order: string[] = [];
/** The live session commit-before-select ends (null = none). */
let liveFake: FakeExternalEdit | null = null;
const commitBeforeSelect = vi.fn(async () => {
  order.push("commit");
  // What useSpreadsheetEditing's handleCommitBeforeSelect does for a live
  // session: end it through the owner's commit.
  if (liveFake?.isRegistered()) await liveFake.session.commit(null);
});

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

/** A press + release on the centre of cell (row, col) of the grid. */
async function clickCell(row: number, col: number, button = 0): Promise<void> {
  const cfg = observedConfig!;
  const x = cfg.rowHeaderWidth + cfg.defaultCellWidth * col + cfg.defaultCellWidth / 2;
  const y = cfg.colHeaderHeight + cfg.defaultCellHeight * row + cfg.defaultCellHeight / 2;
  const target = host.querySelector('[data-testid="container"]') as HTMLElement;
  const event = {
    clientX: x,
    clientY: y,
    button,
    buttons: button === 2 ? 2 : 1,
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

let offPress: () => void;
const presses: GridCellPress[] = [];

beforeEach(async () => {
  __resetExternalEditForTests();
  commitBeforeSelect.mockClear();
  api.undo.mockClear();
  api.redo.mockClear();
  order.length = 0;
  presses.length = 0;
  liveFake = null;
  handlers = null;
  offPress = onGridCellPressed((press) => {
    presses.push(press);
    order.push(`press:${press.row},${press.col}`);
  });
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
});

afterEach(async () => {
  offPress();
  __resetExternalEditForTests();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("a handled grid cell press is announced AFTER commit-before-select", () => {
  it("a press on Core's ALREADY-active cell with a bar session live: the session is committed FIRST, then the press is announced", async () => {
    liveFake = createFakeExternalEdit({ hostSheetIndex: 0, text: "7" });
    liveFake.register();

    await clickCell(0, 0);

    // Core's selection did not change -- the case no selection listener sees.
    expect(observedSelection).toEqual({ endRow: 0, endCol: 0 });
    expect(order).toEqual(["commit", "press:0,0"]);
    expect(liveFake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
    expect(presses[0]).toMatchObject({ row: 0, col: 0, button: 0, shiftKey: false, ctrlKey: false });
  });

  it("control: a press on another cell with nothing live is announced too, after the selection moved", async () => {
    await clickCell(2, 3);
    expect(observedSelection).toEqual({ endRow: 2, endCol: 3 });
    expect(presses.map((p) => [p.row, p.col])).toEqual([[2, 3]]);
  });

  it("a reference PICK announces nothing (the press fed the edit; nothing was selected)", async () => {
    liveFake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=NOT(" });
    liveFake.register();

    await clickCell(1, 2);

    expect(liveFake.session.text).toBe("=NOT(Sheet1!C2");
    expect(presses).toHaveLength(0);
    expect(commitBeforeSelect).not.toHaveBeenCalled();
  });

  it("a right-press INSIDE the selection keeps it for the context menu and announces nothing", async () => {
    await clickCell(0, 0, 2);
    expect(presses).toHaveLength(0);
  });
});

describe("Undo and Redo through the COMMAND stand down while an external session is live", () => {
  it("a live session: neither undo nor redo reaches the backend", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=SUM(" });
    fake.register();

    await act(async () => {
      await CommandRegistry.execute(CoreCommands.UNDO);
      await CommandRegistry.execute(CoreCommands.REDO);
    });

    expect(api.undo).not.toHaveBeenCalled();
    expect(api.redo).not.toHaveBeenCalled();
    // The edit is untouched: nothing ended it.
    expect(fake.isRegistered()).toBe(true);
    expect(fake.calls.some((c) => c.fn === "commit" || c.fn === "cancel")).toBe(false);
  });

  it("a PARKED session: the same (an undo that followed its sheet ended the edit as text)", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=SUM(" });
    fake.register();
    setExternalSessionParked(0);

    await act(async () => {
      await CommandRegistry.execute(CoreCommands.UNDO);
    });

    expect(api.undo).not.toHaveBeenCalled();
  });

  it("control: with no session the command reaches the backend", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        await CommandRegistry.execute(CoreCommands.UNDO);
        await CommandRegistry.execute(CoreCommands.REDO);
      });
    } finally {
      quiet.mockRestore();
    }
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(api.redo).toHaveBeenCalledTimes(1);
  });
});
