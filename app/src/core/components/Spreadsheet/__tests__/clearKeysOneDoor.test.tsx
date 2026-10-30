//! FILENAME: app/src/core/components/Spreadsheet/__tests__/clearKeysOneDoor.test.tsx
// PURPOSE: BUG-0350 wiring -- the grid keyboard's bare Delete reaches the ONE
//          Clear Contents door (the `clearContents` grid command, whose gesture
//          decides the sheet group, the one-cell writeback edit and the one
//          undo step), never a second clear of its own; and the bare Backspace
//          is Excel's: an empty entry in the ACTIVE cell, no clear at all.
// CONTEXT: useSpreadsheetSelection's Delete handler ran its own clear (group
//          replication, a silent single-cell edit-guard check, the selection's
//          last block only). The registry's Delete binding pre-empts it in the
//          capture phase, so only Backspace still reached it -- and Delete with
//          grouped sheets cleared the active sheet alone. Round 1 sent
//          Backspace through Clear Contents too, which cleared EVERY block on
//          every grouped sheet (review G#7); Excel [LIVE, 2026-10-29: A1:A5 +
//          C1:C5 selected, C1 active] clears only C1 and enters Edit mode (Esc
//          put C1 back, Enter left it empty and kept the rest). Driven through
//          the REAL hook (harness of fillAndAutoFitCommandWiring) with a grouped
//          selection: the old handler cleared through tauri-api itself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  clearRange: vi.fn(async () => 0),
  clearRangeOnSheets: vi.fn(async () => undefined),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async () => {}), confirmAsync: vi.fn(async () => true) }));

vi.mock("../../../lib/tauri-api", () => ({
  getCell: vi.fn(async () => null),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearRange: (...a: unknown[]) => api.clearRange(...(a as [])),
  clearRangeOnSheets: (...a: unknown[]) => api.clearRangeOnSheets(...(a as [])),
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
import { gridCommands } from "../../../lib/gridCommands";
import { clearSheetGrouping, setSelectedSheetIndices } from "../../../state/sheetGrouping";
import { setGridCellEditorOpener } from "../../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let focusEl: HTMLDivElement | null = null;

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
const clearContents = vi.fn(async () => {});
/** Core's in-cell editor as useSpreadsheetEditing registers it: the text it opened with. */
const opened: string[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    focusEl!.focus();
    focusEl!.dispatchEvent(event);
  });
  await settle();
  return event;
}

beforeEach(async () => {
  __resetExternalEditForTests();
  api.clearRange.mockClear();
  api.clearRangeOnSheets.mockClear();
  clearContents.mockClear();
  dialogs.alertAsync.mockClear();
  opened.length = 0;
  setGridCellEditorOpener((text) => {
    opened.push(text);
    return true;
  });
  // The ONE door: what Spreadsheet registers for Delete, the Clear menu, the
  // Edit menu and the right-click menu.
  gridCommands.register("clearContents", clearContents);
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
  await settle();
  // Sheet1 grouped with Sheet3, A1:B2 selected.
  setSelectedSheetIndices([0, 2]);
  await act(async () => {
    dispatchOut(setSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" }));
  });
  await settle();
});

afterEach(async () => {
  gridCommands.unregister("clearContents");
  setGridCellEditorOpener(null);
  clearSheetGrouping();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("the grid keyboard's clears reach the ONE Clear Contents door", () => {
  it("Delete: runs the clearContents grid command once, and clears nothing on its own", async () => {
    const event = await press("Delete");
    expect(clearContents, "Delete did not reach the clearContents grid command").toHaveBeenCalledTimes(1);
    expect(api.clearRange, "Delete cleared the active sheet through a second door").not.toHaveBeenCalled();
    expect(api.clearRangeOnSheets, "Delete replicated through a second door").not.toHaveBeenCalled();
    expect(opened, "Delete is no entry").toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  // review G#7, Excel [LIVE]: Backspace clears the ACTIVE cell only and enters
  // Edit mode (Esc puts the value back; Enter commits the empty entry, to the
  // group when grouped -- the commit path's own replication).
  it("Backspace: opens an EMPTY entry in the active cell and clears nothing -- not the selection, not the group", async () => {
    const event = await press("Backspace");
    expect(opened, "Backspace did not open Core's editor with an empty entry").toEqual([""]);
    expect(clearContents, "Backspace ran Clear Contents over the whole selection").not.toHaveBeenCalled();
    expect(api.clearRange).not.toHaveBeenCalled();
    expect(api.clearRangeOnSheets).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("control: a modified Backspace (Shift) clears nothing", async () => {
    const event = new KeyboardEvent("keydown", { key: "Backspace", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      focusEl!.focus();
      focusEl!.dispatchEvent(event);
    });
    await settle();
    expect(clearContents).not.toHaveBeenCalled();
  });
});
