//! FILENAME: app/src/core/components/Spreadsheet/__tests__/escEndsCutAnywhere.test.tsx
// PURPOSE: Esc ends a pending CUT wherever the user is: on a sheet other than
//          the cut's source (where no marching ants are drawn) and after a
//          floating grid's cut (which draws none at all) -- through the REAL
//          grid keyboard wiring of useSpreadsheetSelection and the REAL
//          clipboard hook.
// CONTEXT: Bug-ledger fix programme round 8 (lane cutmode; round 7 lane
//          clipgroup's follow-up 1). Round 7 made Esc end cut mode
//          (`clearClipboardState` -> `endCutMode`), but the grid keyboard calls
//          it only while `hasClipboardContent`, and useSpreadsheetSelection
//          passed `clipboardMode !== "none"` -- which the hook reports as "none"
//          off the source sheet, and always for an object's cut. So Cut on
//          Sheet1, switch to Sheet2, Esc, Paste: the paste still MOVED the
//          cells the user thought they had cancelled. Excel ends cut mode on
//          Esc [LIVE, round 7, clipgroup/probe-keys*.ps1].

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const sys = vi.hoisted(() => ({ text: null as string | null }));
const seam = vi.hoisted(() => ({
  getCellTargetCells: vi.fn(async () => ({
    cells: [{ row: 1, col: 1, display: "moved", formula: null, styleIndex: 0 }],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  })),
  selectTargetCells: vi.fn(),
}));

vi.mock("../../../lib/tauri-api", () => ({
  getCell: vi.fn(async (row: number, col: number) => ({ row, col, display: "5", formula: null, styleIndex: 0 })),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearCell: vi.fn(async () => {}),
  clearRange: vi.fn(async () => 0),
  clearRangeOnSheets: vi.fn(async () => undefined),
  clearRangeWithOptions: vi.fn(async () => undefined),
  relocateCellReferences: vi.fn(async () => []),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
  applyFormatting: vi.fn(async () => []),
  getStyle: vi.fn(async () => null),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 5, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
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
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  getRangeCellsTyped: vi.fn(async () => {
    throw new Error("no typed read in this double");
  }),
}));

vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => true),
  applyColsHidden: vi.fn(async () => true),
  refreshUserHidden: vi.fn(async () => {}),
}));

vi.mock("../../../lib/dialogs", () => ({ alertAsync: vi.fn(async () => {}), confirmAsync: vi.fn(async () => true) }));

vi.mock("../../../../api/cellTarget", () => seam);

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => sys.text),
  writeText: vi.fn(async (t: string) => {
    sys.text = t;
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.text = t;
  }),
}));

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import { isCutModeLive, getInternalClipboard, endCutMode } from "../../../hooks/useClipboard";
import type { CellTarget } from "../../../lib/selectionOwner";
import type { GridState } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let gridState: GridState;
let selectionLogic: ReturnType<typeof useSpreadsheetSelection>;
let focusEl: HTMLDivElement | null = null;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);
  dispatchOut = dispatch;
  gridState = state;
  selectionLogic = useSpreadsheetSelection({
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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Press a key on the grid's focus container; nothing else is awaited first. */
async function press(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    focusEl!.dispatchEvent(event);
  });
  await settle();
  return event;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetExternalEditForTests();
  sys.text = null;
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
    dispatchOut(setActiveSheet(0, "Sheet1", undefined, "S1"));
  });
  await settle();
  await act(async () => {
    focusEl!.focus();
  });
  await settle();
});

afterEach(async () => {
  // Whatever a test left pending ends here, so the next one starts clean.
  await act(async () => {
    endCutMode();
  });
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe("Esc ends a pending cut wherever the user is", () => {
  it("on a sheet OTHER than the cut's source (no ants drawn there)", async () => {
    await act(async () => {
      dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
    });
    await settle();
    await act(async () => {
      await selectionLogic.clipboardHandlers.cut();
    });
    await settle();
    expect(isCutModeLive(), "precondition: the cut is pending").toBe(true);
    await act(async () => {
      dispatchOut(setActiveSheet(1, "Sheet2", undefined, "S2"));
    });
    await settle();
    expect(selectionLogic.clipboardState.mode, "precondition: no ants on Sheet2").toBe("none");

    const event = await press("Escape");
    expect(isCutModeLive(), "Esc on Sheet2 left the cut pending: a later Paste still moves the cells").toBe(false);
    expect(getInternalClipboard()).toBeNull();
    expect(gridState.clipboard.mode, "the ants on Sheet1 stayed up").toBe("none");
    expect(event.defaultPrevented).toBe(true);
  });

  it("after a FLOATING GRID's cut (no ants at all), with nothing else re-rendering the grid first", async () => {
    const grid: CellTarget = {
      kind: "object",
      ownerId: "floatingRange",
      ref: { kind: "floatingRange", id: "fr-1" },
      selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
      bounds: { rows: 10, cols: 5 },
      label: "Float1",
      wholeObject: false,
    };
    await act(async () => {
      await selectionLogic.clipboardHandlers.cut(undefined, { target: grid });
    });
    await settle();
    expect(isCutModeLive(), "precondition: the floating grid's cut is pending").toBe(true);
    expect(gridState.clipboard.mode, "precondition: an object's cut draws no ants").toBe("none");

    const event = await press("Escape");
    expect(isCutModeLive(), "Esc left the floating grid's cut pending").toBe(false);
    expect(getInternalClipboard()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it("control: with nothing cut or copied, Esc is not taken as a clipboard clear", async () => {
    expect(isCutModeLive()).toBe(false);
    const event = await press("Escape");
    expect(event.defaultPrevented, "Esc was swallowed with no clipboard to clear").toBe(false);
  });
});
