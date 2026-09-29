//! FILENAME: app/src/core/components/Spreadsheet/__tests__/undoRefusalToast.test.tsx
// PURPOSE: An Undo or Redo the BACKEND refuses tells the user why, whichever
//          door asked for it: the ribbon and Quick Access Toolbar buttons,
//          Edit > Undo and the CLI all reach Core's UNDO / REDO commands
//          (useSpreadsheetSelection handleUndo / handleRedo), and so does the
//          keyboard once no command refusal answered first.
// CONTEXT: W15 (wave C; wb-slicer fixup, new defect 10). The backend refuses
//          to move the history while a gesture that pushes its step when it
//          lands (a slicer click, a ribbon filter change) is in flight, and
//          says so in `UndoResult.refusal`. Only the keyboard's own refusal
//          (@api/objectGeometry refuseUndoWhileAGestureLands) told the user:
//          the command dropped the sentence, so the Undo button simply did
//          nothing. Driven through the REAL hook and the real command registry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  undo: vi.fn(async (): Promise<unknown> => null),
  redo: vi.fn(async (): Promise<unknown> => null),
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
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import { CommandRegistry, CoreCommands } from "../../../../api/commands";
import { registerToastSink, type ToastPayload } from "../../../../api/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REFUSAL =
  "A slicer or filter change is still being applied, so nothing was undone or redone. Try again once it has finished.";

/** An UndoResult as the backend returns it (undo_commands.rs). */
function undoResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    description: "Edit",
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
    refusal: null,
    refreshDomains: [],
    activeSheetIndex: 0,
    activeSheetName: "Sheet1",
    restoredAnchor: null,
    restoredRange: null,
    ...overrides,
  };
}

const refused = (): Record<string, unknown> =>
  undoResult({ success: false, description: null, refusal: REFUSAL });

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

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
      <div ref={focusContainerRef} data-focus-container="spreadsheet" tabIndex={0} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
const toasts: ToastPayload[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function run(command: string): Promise<unknown> {
  let result: unknown;
  await act(async () => {
    result = await CommandRegistry.execute(command);
  });
  await settle();
  return result;
}

beforeEach(async () => {
  __resetExternalEditForTests();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  api.undo.mockReset();
  api.redo.mockReset();
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
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("a refused Undo / Redo through the COMMAND says why (W15)", () => {
  it("Undo: the backend's refusal is shown once, and the result still reaches the caller", async () => {
    api.undo.mockResolvedValue(refused());
    const result = (await run(CoreCommands.UNDO)) as { refusal?: string } | undefined;
    expect(toasts.map((t) => t.message)).toEqual([REFUSAL]);
    // The CLI reads the result: it must still say "refused", not "undone".
    expect(result?.refusal).toBe(REFUSAL);
  });

  it("Redo: the same", async () => {
    api.redo.mockResolvedValue(refused());
    await run(CoreCommands.REDO);
    expect(toasts.map((t) => t.message)).toEqual([REFUSAL]);
  });

  it("control: an ordinary undo and redo show nothing", async () => {
    api.undo.mockResolvedValue(undoResult());
    api.redo.mockResolvedValue(undoResult());
    await run(CoreCommands.UNDO);
    await run(CoreCommands.REDO);
    expect(toasts).toEqual([]);
  });

  it("control: nothing to undo (success false, no refusal) is not a refusal", async () => {
    api.undo.mockResolvedValue(undoResult({ success: false, description: null }));
    await run(CoreCommands.UNDO);
    expect(toasts).toEqual([]);
  });
});
