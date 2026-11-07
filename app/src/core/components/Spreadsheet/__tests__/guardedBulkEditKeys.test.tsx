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
  // The backend batch, doubled: it reports each written cell, a formula where
  // the typed-entry ladder would make one (`=...`, or a leading sign that is
  // not a number -- core/engine/src/typed_entry.rs).
  updateCellsBatch: vi.fn(async (updates: Array<{ row: number; col: number; value: string; pasted?: boolean }>) =>
    updates.map((u) => {
      const t = u.value.trim();
      const formula = t.startsWith("=") || (/^[+-]./.test(t) && Number.isNaN(Number(t))) ? (t.startsWith("=") ? t : `=${t}`) : null;
      return { row: u.row, col: u.col, display: u.value, formula, styleIndex: 0 };
    }),
  ),
  // The backend fill shifter, doubled: it spells the delta it was asked for.
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map((i) => `${i.formula}|${i.rowDelta},${i.colDelta}`),
  ),
  // The active cell's value type after its write (get_range_cells_typed).
  activeType: "number" as string,
  getRangeCellsTyped: vi.fn(async (row: number, col: number) => [{ row, col, type: h.activeType }]),
  mergedRegions: [] as Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
  getMergedRegions: vi.fn(async () => h.mergedRegions),
  filterMode: false,
  /** "row,col" of cells whose number format is Text (`@`): style 9. */
  textCells: new Set<string>(),
  alertAsync: vi.fn(async () => {}),
}));

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async (row: number, col: number) =>
    h.textCells.has(`${row},${col}`) ? { row, col, display: "", formula: null, styleIndex: 9 } : null,
  ),
  getStyle: vi.fn(async (index: number) => ({ numberFormat: index === 9 ? "@" : "General" })),
  updateCell: h.updateCell,
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: h.updateCellsBatch,
  shiftFormulasBatch: h.shiftFormulasBatch,
  getRangeCellsTyped: h.getRangeCellsTyped,
  getMergedRegions: h.getMergedRegions,
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
vi.mock("../../../../api/autoFilterService", () => ({
  isActiveSheetFilterMode: vi.fn(async () => h.filterMode),
}));

import { useSpreadsheetEditing } from "../useSpreadsheetEditing";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import { registerRangeGuard, type RangeGuardOperation } from "../../../lib/editGuards";
import { commitGridCellText } from "../../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Sel = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  additionalRanges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
};

let handlersRef: ReturnType<typeof useSpreadsheetEditing>["handlers"] | null = null;
let editorOpen = false;
let initialSelection: Sel = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
/** Rows / columns the grid shows hidden (any reason), for the next mount. */
let initialHidden: { rows: number[]; cols: number[] } = { rows: [], cols: [] };

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
  const initial = getInitialState();
  initial.dimensions = {
    ...initial.dimensions,
    hiddenRows: new Set(initialHidden.rows),
    hiddenCols: new Set(initialHidden.cols),
  };
  await act(async () => {
    root.render(
      <GridProvider initialState={initial}>
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
    h.shiftFormulasBatch.mockClear();
    h.getRangeCellsTyped.mockClear();
    h.getMergedRegions.mockClear();
    h.activeType = "number";
    h.mergedRegions = [];
    h.textCells.clear();
    h.filterMode = false;
    initialHidden = { rows: [], cols: [] };
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
    // The ACTIVE cell first (its entry decides what every cell gets), then the rest.
    expect(h.updateCellsBatch).toHaveBeenCalledTimes(2);
    expect(h.updateCellsBatch.mock.calls[0][0]).toEqual([{ row: 8, col: 3, value: "5" }]);
  });

  // BUG-0396, Excel measured live 2026-11-04 (lane multiarea probe2): every
  // block is filled, and a formula moves relative to the active cell.
  const scattered: Sel = {
    startRow: 7,
    startCol: 3,
    endRow: 7,
    endCol: 3,
    additionalRanges: [
      { startRow: 0, startCol: 6, endRow: 1, endCol: 6 },
      { startRow: 9, startCol: 4, endRow: 9, endCol: 5 },
    ],
  };
  const writtenCells = () =>
    h.updateCellsBatch.mock.calls.flatMap((c) => c[0]).map((u) => `${u.row},${u.col}=${u.value}`).sort();

  it("BUG-0396 Ctrl+Enter fills EVERY block of a multi-area selection", async () => {
    await mount(scattered);
    await type("5");
    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();
    expect(h.updateCellsBatch).toHaveBeenCalledTimes(2);
    expect(writtenCells()).toEqual(["0,6=5", "1,6=5", "7,3=5", "9,4=5", "9,5=5"]);
    expect(h.shiftFormulasBatch, "a constant needs no shift").not.toHaveBeenCalled();
  });

  it("BUG-0396 a formula is entered relative to the active cell in every block", async () => {
    await mount(scattered);
    await type("=");
    await act(async () => {
      handlersRef!.handleInlineValueChange("=C8");
    });
    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();
    expect(h.shiftFormulasBatch).toHaveBeenCalledTimes(1);
    expect(writtenCells()).toEqual([
      "0,6==C8|-7,3",
      "1,6==C8|-6,3",
      "7,3==C8",
      "9,4==C8|2,1",
      "9,5==C8|2,2",
    ]);
  });

  it("BUG-0396 a guard refusing ANY block writes no block at all", async () => {
    // The second block crosses the guarded B3:B5.
    await mount({ ...scattered, additionalRanges: [{ startRow: 3, startCol: 1, endRow: 3, endCol: 2 }] });
    await type("5");
    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();
    expect(h.updateCellsBatch).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledWith("These cells collect input one cell at a time.");
    expect(editorOpen).toBe(true);
  });

  // rev-ui-4 / rev-ui-5, Excel measured live 2026-11-05 (lane uic probe1..4).
  async function ctrlEnter(sel: Sel, text: string): Promise<void> {
    await mount(sel);
    await type(text.slice(0, 1));
    await act(async () => {
      handlersRef!.handleInlineValueChange(text);
    });
    await act(async () => {
      await handlersRef!.handleInlineCtrlEnter();
    });
    await settle();
  }
  const written = () =>
    h.updateCellsBatch.mock.calls
      .flatMap((c) => c[0])
      .map((u) => `${u.row},${u.col}=${u.value}${u.pasted ? " (p)" : ""}`)
      .sort();

  it("rev-ui-5 a leading + starts a formula, moved for every cell in the spelling typed", async () => {
    // A1:A2, A1 active: Excel writes A1 =+B1, A2 =+B2.
    await ctrlEnter({ startRow: 1, startCol: 0, endRow: 0, endCol: 0 }, "+B1");
    expect(h.updateCellsBatch.mock.calls[0][0], "the active cell first, as typed").toEqual([{ row: 0, col: 0, value: "+B1" }]);
    expect(h.shiftFormulasBatch).toHaveBeenCalledTimes(1);
    expect(written()).toEqual(["0,0=+B1", "1,0==+B1|1,0 (p)"]);
  });

  it("rev-ui-5 the active cell's TEXT is text in every cell (a Text-formatted active cell)", async () => {
    h.activeType = "text";
    // The active cell is Text-formatted: the ladder stored the TEXT "=B1".
    h.updateCellsBatch.mockImplementationOnce(async (updates) =>
      updates.map((u) => ({ row: u.row, col: u.col, display: u.value, formula: null, styleIndex: 0 })),
    );
    await ctrlEnter({ startRow: 1, startCol: 0, endRow: 0, endCol: 0 }, "=B1");
    expect(h.shiftFormulasBatch).not.toHaveBeenCalled();
    // A PASTED invariant write (BUG-0769, C9/K2): A2 keeps its General format,
    // as in Excel [LIVE] -- a typed apostrophe would make it Text.
    expect(written()).toEqual(["0,0==B1", "1,0='=B1 (p)"]);
    const second = h.updateCellsBatch.mock.calls[1][0][0];
    expect(second.invariant, "a typed-entry write would restyle A2 as Text").toBe(true);
  });

  it("rev-ui-5 a number goes into every cell as the number, Text format or not", async () => {
    await ctrlEnter({ startRow: 1, startCol: 0, endRow: 0, endCol: 0 }, "5");
    expect(written()).toEqual(["0,0=5", "1,0=5 (p)"]);
  });

  it("rev-ui-4 a merged area takes the entry in its top-left cell only", async () => {
    // A1:C3 with B2:C2 merged: Excel leaves C2 empty. (Here F1:H3 with G2:H2,
    // clear of the guarded B3:B5.)
    h.mergedRegions = [{ startRow: 1, startCol: 6, endRow: 1, endCol: 7 }];
    await ctrlEnter({ startRow: 2, startCol: 7, endRow: 0, endCol: 5 }, "7");
    expect(h.getMergedRegions).toHaveBeenCalledWith({ startRow: 0, startCol: 5, endRow: 2, endCol: 7 });
    const cells = written().map((w) => w.split("=")[0]);
    expect(cells).toContain("1,6");
    expect(cells).not.toContain("1,7");
    expect(cells.length).toBe(8);
  });

  it("rev-ui-4 in filter mode every hidden row and column is skipped", async () => {
    // G2:I6 (rows 1..5, cols 6..8), row 4 (index 3) and column H hidden.
    h.filterMode = true;
    initialHidden = { rows: [3], cols: [7] };
    await ctrlEnter({ startRow: 5, startCol: 8, endRow: 1, endCol: 6 }, "x");
    const cells = written().map((w) => w.split("=")[0]);
    expect(cells.some((c) => c.startsWith("3,")), "no cell of the hidden row").toBe(false);
    expect(cells.some((c) => c.endsWith(",7")), "no cell of the hidden column").toBe(false);
    expect(cells.length).toBe(4 * 2);
  });

  it("BUG-0769 in filter mode an ACTIVE cell on a hidden row is not written either (Excel leaves it empty)", async () => {
    // G4:G6 (rows 3..5) with G4 (row 3) active and hidden: Excel [LIVE, uimisc
    // probe3 C13] writes the visible cells only.
    h.filterMode = true;
    initialHidden = { rows: [3], cols: [] };
    await ctrlEnter({ startRow: 5, startCol: 6, endRow: 3, endCol: 6 }, "x");
    const cells = written().map((w) => w.split("=")[0]);
    expect(cells, "the hidden active cell was written").not.toContain("3,6");
    expect(cells).toEqual(["4,6", "5,6"]);
  });

  it("BUG-0769 a formula typed for a hidden active cell is moved from it to every cell it lands in", async () => {
    h.filterMode = true;
    initialHidden = { rows: [3], cols: [] };
    await ctrlEnter({ startRow: 5, startCol: 6, endRow: 3, endCol: 6 }, "=B1");
    // The first visible cell takes the entry moved one row from the active
    // cell; the next one two rows -- each relative to the ACTIVE cell. The
    // stand-in is written as the active cell would read it, its own Text rung
    // skipped (`pasted`, wave 3).
    expect(written()).toEqual(["4,6==B1|1,0 (p)", "5,6==B1|2,0 (p)"]);
  });

  // Ledger programme 2, wave 3 (W2 uimisc new defect): with the active cell on a
  // filter-hidden row, the entry's kind was decided at the first VISIBLE cell's
  // format. Excel [LIVE, Excel 16, 2026-11-06, lane dtui probe3: filter <>3
  // hiding row 4, B2:B6 with B4 active] decides it at the ACTIVE cell's: a
  // Text-formatted B4 makes `007` the text "007" and `=A2` the text "=A2" in
  // the General B2, B3, B5; a General B4 makes `5` the NUMBER 5 in a
  // Text-formatted B2.
  // SABOTAGE: make `textFormatAt` answer false in ctrlEnterFill's text branch
  // -- fails at "DECIDED AT THE FIRST VISIBLE CELL".
  it("a hidden ACTIVE cell's format decides the entry's kind for every visible cell", async () => {
    h.filterMode = true;
    initialHidden = { rows: [3], cols: [] };
    h.textCells.add("3,6"); // the active G4 is Text-formatted
    await ctrlEnter({ startRow: 5, startCol: 6, endRow: 3, endCol: 6 }, "=B1");
    expect(written(), "DECIDED AT THE FIRST VISIBLE CELL: a Text active cell makes the entry text").toEqual([
      "4,6='=B1 (p)",
      "5,6='=B1 (p)",
    ]);
    expect(h.shiftFormulasBatch, "a text entry is never shifted").not.toHaveBeenCalled();

    // A General active cell over a Text-formatted first visible cell: the
    // stand-in skips its Text rung, so 5 is the number in it.
    h.updateCellsBatch.mockClear();
    h.textCells.clear();
    h.textCells.add("4,6");
    await ctrlEnter({ startRow: 5, startCol: 6, endRow: 3, endCol: 6 }, "5");
    expect(written()).toEqual(["4,6=5 (p)", "5,6=5 (p)"]);
  });

  it("rev-ui-4 outside filter mode hidden rows and columns are filled like any other", async () => {
    initialHidden = { rows: [3], cols: [7] };
    await ctrlEnter({ startRow: 5, startCol: 8, endRow: 1, endCol: 6 }, "x");
    expect(written().length).toBe(5 * 3);
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
