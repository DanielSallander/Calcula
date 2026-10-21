//! FILENAME: app/src/core/components/Spreadsheet/__tests__/guardedBulkEditKeys.test.tsx
// PURPOSE: Ctrl+Enter and the Delete key over a cell whose range guard admits a
//          one-cell EDIT but refuses a bulk write (a writeback cell collects one
//          answer at a time, recorded by its owner's commit guard).
//
// CONTEXT: Ctrl+Enter fills the selection through `updateCellsBatch`, which
//          bypasses the commit guards -- and the backend batch path SKIPS a
//          writeback cell silently, so the typed value vanished with no draft,
//          no marker and no message. Delete went to `clearRange`, which the
//          backend refuses for a writeback cell, so a single answer could only
//          be cleared through F2 + Backspace + Enter.
//
//          Now: Ctrl+Enter on such a single cell COMMITS (Excel's "commit and
//          stay") so the commit guard runs; Ctrl+Enter over a selection a guard
//          refuses keeps the editor open and says why; Delete on such a single
//          cell is entered as an empty edit through Core's text committer.
//
//          Driven through the REAL hook, assembled as Spreadsheet.tsx does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null }],
  })),
  updateCellsBatch: vi.fn(async () => []),
  alertAsync: vi.fn(async () => {}),
}));

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCell: h.updateCell,
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: h.updateCellsBatch,
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));
vi.mock("../../../lib/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/dialogs")>()),
  alertAsync: h.alertAsync,
}));
vi.mock("../../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));
vi.mock("../../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

import { useSpreadsheetEditing } from "../useSpreadsheetEditing";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import { registerRangeGuard, type RangeGuardOperation } from "../../../lib/editGuards";
import { commitGridCellText } from "../../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Sel = { startRow: number; startCol: number; endRow: number; endCol: number };

let handlersRef: ReturnType<typeof useSpreadsheetEditing>["handlers"] | null = null;
let editorOpen = false;
let initialSelection: Sel = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);
  const { editingState, handlers } = useSpreadsheetEditing({
    containerRef,
    focusContainerRef,
    formulaInputRef,
    state,
    selectedCellContent: "",
    moveActiveCell: () => {},
    scrollToSelection: () => {},
    selectCell: () => {},
  });
  handlersRef = handlers;
  const open = Boolean(editingState.editing && editingState.isEditing);
  useEffect(() => {
    editorOpen = open;
  }, [open]);
  useEffect(() => {
    dispatch(setSelection({ ...initialSelection, type: "cells" }));
  }, [dispatch]);
  return <div ref={focusContainerRef} data-testid="grid" tabIndex={0} onKeyDown={handlers.handleContainerKeyDown} />;
}

let root: Root;
let host: HTMLDivElement;
let unregisterGuard: (() => void) | null = null;

async function mount(selection: Sel): Promise<void> {
  initialSelection = selection;
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
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(key: string): Promise<void> {
  const grid = host.querySelector("[data-testid='grid']") as HTMLElement;
  await act(async () => {
    grid.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
}

/** A writeback-like guard over B3:B5: one-cell edits pass, bulk writes do not. */
function guardB3toB5(): void {
  unregisterGuard = registerRangeGuard(
    (sr: number, sc: number, er: number, ec: number, operation: RangeGuardOperation) => {
      const overlaps = sr <= 4 && er >= 2 && sc <= 1 && ec >= 1;
      if (!overlaps) return null;
      if (operation === "edit" && sr === er && sc === ec) return null;
      return { blocked: true, message: "These cells collect input one cell at a time." };
    },
  );
}

describe("Ctrl+Enter and Delete over a cell that takes one edit at a time", () => {
  beforeEach(() => {
    h.updateCell.mockClear();
    h.updateCellsBatch.mockClear();
    h.alertAsync.mockClear();
    handlersRef = null;
    editorOpen = false;
    setGlobalIsEditing(false);
    guardB3toB5();
  });

  afterEach(async () => {
    unregisterGuard?.();
    unregisterGuard = null;
    await act(async () => {
      root.unmount();
    });
    host.remove();
    setGlobalIsEditing(false);
  });

  it("Ctrl+Enter on ONE such cell commits through the commit path (no silent batch skip)", async () => {
    await mount({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    await type("5");
    expect(editorOpen).toBe(true);

    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();

    expect(h.updateCellsBatch).not.toHaveBeenCalled();
    expect(h.updateCell).toHaveBeenCalledWith(2, 1, "5");
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter over a selection the guard refuses keeps the editor open and says why", async () => {
    await mount({ startRow: 2, startCol: 1, endRow: 4, endCol: 1 });
    await type("5");
    expect(editorOpen).toBe(true);

    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();

    expect(h.updateCellsBatch).not.toHaveBeenCalled();
    expect(h.updateCell).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledWith("These cells collect input one cell at a time.");
    expect(editorOpen).toBe(true);
  });

  it("Ctrl+Enter over an unguarded selection still fills it", async () => {
    await mount({ startRow: 7, startCol: 3, endRow: 8, endCol: 3 });
    await type("5");
    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();
    expect(h.updateCellsBatch).toHaveBeenCalledTimes(1);
  });

  it("the grid text committer ENTERS a value as a committed edit (Delete's route)", async () => {
    await mount({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    // Started inside act, awaited OUTSIDE it: the commit runs in an effect once
    // the opened editor is in state, and act flushes that only after its own
    // callback returns.
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = commitGridCellText("");
    });
    await settle();
    expect(await pending).toBe(true);
    expect(h.updateCell).toHaveBeenCalledWith(2, 1, "");
  });
});
