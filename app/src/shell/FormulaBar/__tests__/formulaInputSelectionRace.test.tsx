//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputSelectionRace.test.tsx
// PURPOSE: The selection -> cell-content fetch must be CANCELLED when the
//          selection moves on, so the last write belongs to the last selection.
// CONTEXT: `FormulaInput`'s selection effect makes up to FIVE backend round
//          trips (getMergeInfo x1-2, getSpillRanges, getCell, and for a formula
//          cell isSheetProtected + getCellProtection) before it writes THREE
//          pieces of shared state: the formula bar's text, the spill-ref flag,
//          and `state.formulaReferences` — which the GRID CANVAS paints as the
//          faint dashed precedent boxes.
//
//          It used to fire that chain with no cleanup, so two selections in
//          quick succession left two chains racing and the SLOWER one won. The
//          user-visible failure: click a formula cell, then click a plain one,
//          and the formula bar can still read the FIRST cell's formula while the
//          canvas still paints the FIRST cell's precedents. No error, nothing to
//          retry, and no way to tell from the screen which cell you are on.
//
//          It is also what made two visual goldens unstable run to run
//          (`grid with data`, `cell selection highlight`): the highlight is
//          painted by an IPC chain the capture was racing.
//
// THE TEST IS THE RACE, NOT A PROXY FOR IT. The first selection's `getCell` is
// held on a deferred promise and released AFTER the second selection has been
// answered — i.e. the interleaving is forced, not hoped for. Without the
// cancellation this test fails on its last two assertions: the stale chain
// dispatches `SET_FORMULA_REFERENCES` for B3 and puts `=B3*2` back in the input.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles. The component reaches the backend through the @api barrel; every one
// of those calls is a promise the test controls.
// ---------------------------------------------------------------------------

interface FakeCell {
  formula?: string;
  display?: string;
}

const cells = new Map<string, FakeCell>();
/** Cells whose `getCell` is HELD until the test releases it. */
const held = new Map<string, () => void>();

const dispatch = vi.fn();
const gridState: { selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null; referenceStyle: string } = {
  selection: null,
  referenceStyle: "A1",
};

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  getCell: (row: number, col: number) => {
    const key = `${row},${col}`;
    const value = cells.get(key) ?? null;
    if (held.has(key)) {
      return new Promise((resolve) => {
        held.set(key, () => resolve(value));
      });
    }
    return Promise.resolve(value);
  },
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    updateValue: vi.fn(),
    commitEdit: vi.fn(),
    cancelEdit: vi.fn(),
    startEdit: vi.fn(),
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

import { FormulaInput } from "../FormulaInput";

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

/** Let every already-resolved microtask settle inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(): void {
  act(() => {
    root.render(React.createElement(FormulaInput));
  });
}

function select(row: number, col: number): void {
  gridState.selection = { startRow: row, startCol: col, endRow: row, endCol: col };
}

function input(): HTMLInputElement {
  const el = container.querySelector("input[data-formula-bar]");
  if (!el) throw new Error("the formula bar input did not render");
  return el as HTMLInputElement;
}

describe("FormulaInput — the selection fetch is cancelled when the selection moves on", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cells.clear();
    held.clear();
    dispatch.mockClear();
    gridState.selection = null;
    gridState.referenceStyle = "A1";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a superseded selection cannot write the formula bar or the grid's precedent highlight", async () => {
    // C3 holds a formula (its precedent B3 is what gets highlighted); A1 is plain.
    cells.set("2,2", { formula: "=B3*2", display: "400" });
    cells.set("0,0", { display: "Name" });

    // Hold C3's getCell so its chain cannot finish before A1's does.
    held.set("2,2", () => {});

    select(2, 2); // C3
    render();
    await flush();

    // Nothing has been answered for C3 yet: it is still waiting on getCell.
    expect(input().value).toBe("");

    // The selection moves to A1 and IS answered.
    select(0, 0); // A1
    render();
    await flush();

    expect(input().value).toBe("Name");
    const afterA1 = dispatch.mock.calls.length;

    // NOW let the stale C3 chain complete. It must write nothing.
    await act(async () => {
      held.get("2,2")!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      input().value,
      "the superseded C3 chain put its formula back into the formula bar — " +
        "the bar is now describing a cell the user is not standing on",
    ).toBe("Name");
    expect(
      dispatch.mock.calls.length,
      "the superseded C3 chain dispatched after A1's answer — the canvas would " +
        "paint C3's precedent box while A1 is selected",
    ).toBe(afterA1);
  });

  it("the surviving selection still sets the precedent highlight for a formula cell", async () => {
    // Positive control: the cancellation must not have switched the feature off.
    cells.set("2,2", { formula: "=B3*2", display: "400" });

    select(2, 2);
    render();
    await flush();

    expect(input().value).toBe("=B3*2");
    const types = dispatch.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("SET_FORMULA_REFERENCES");
  });

  it("selecting a plain cell clears the previous cell's highlight", async () => {
    cells.set("0,0", { display: "Name" });

    select(0, 0);
    render();
    await flush();

    const types = dispatch.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("CLEAR_FORMULA_REFERENCES");
  });
});
