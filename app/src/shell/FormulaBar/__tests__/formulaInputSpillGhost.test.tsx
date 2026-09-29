//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputSpillGhost.test.tsx
// PURPOSE: A selected EXTERNAL cell (a floating-grid cell) that a formula
//          spills into is shown in the formula bar exactly as a grid spill
//          cell is: the anchor's formula, GREYED, read-only (wave C, W12).
// CONTEXT: The bar greys a grid cell through its own `isSpillRef` (it asks
//          `getSpillRanges` for the ACTIVE sheet). An external cell says for
//          itself: `ExternalCellTarget.spillGhost` (core/lib/formulaEditTarget.ts).
//          The comparison is against the grid's own spill rendering, so the
//          two cannot drift into two different greys.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: {
    selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
    referenceStyle: "A1",
    surface: "grid" as "grid" | "canvas",
  },
  cells: new Map<string, { formula?: string; display?: string }>(),
  spills: [] as Array<{ originRow: number; originCol: number; endRow: number; endCol: number }>,
  dispatch: vi.fn(),
}));

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: h.gridState, dispatch: h.dispatch }),
  getCell: (row: number, col: number) => Promise.resolve(h.cells.get(`${row},${col}`) ?? null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve(h.spills),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    updateValue: vi.fn(),
    commitEdit: vi.fn(async () => ({ success: true })),
    cancelEdit: vi.fn(async () => undefined),
    startEdit: vi.fn(async () => undefined),
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
import {
  __resetExternalEditForTests,
  publishExternalCellTarget,
  type ExternalCellTarget,
} from "../../../core/lib/formulaEditTarget";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(FormulaInput));
  });
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function input(): HTMLInputElement {
  const el = container.querySelector("input[data-formula-bar]");
  if (!el) throw new Error("the formula bar input did not render");
  return el as HTMLInputElement;
}

function color(): string {
  return window.getComputedStyle(input()).color;
}

function publishCell(over: Partial<ExternalCellTarget>): void {
  const target = {
    address: "Float1!B3",
    content: "=SEQUENCE(3)",
    readOnly: false,
    beginEdit: () => null,
    ...over,
  } as ExternalCellTarget;
  act(() => publishExternalCellTarget("test-owner", target));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.cells.clear();
  h.spills = [];
  h.gridState.selection = null;
  h.gridState.surface = "canvas";
  h.dispatch.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetExternalEditForTests();
});

/** The grid's own greyed spill cell: B3 inside =SEQUENCE(3) anchored at B2. */
async function gridSpillColor(): Promise<string> {
  h.gridState.surface = "grid";
  h.gridState.selection = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
  h.spills = [{ originRow: 1, originCol: 1, endRow: 3, endCol: 1 }];
  h.cells.set("1,1", { formula: "=SEQUENCE(3)", display: "1" });
  await render();
  expect(input().value).toBe("=SEQUENCE(3)");
  expect(input().readOnly).toBe(true);
  const grey = color();
  act(() => root.unmount());
  root = createRoot(container);
  h.gridState.selection = null;
  h.gridState.surface = "canvas";
  h.spills = [];
  return grey;
}

describe("FormulaInput -- an external spill cell", () => {
  it("a spill GHOST is greyed and read-only, exactly as the grid's own spill cell", async () => {
    const grey = await gridSpillColor();

    publishCell({});
    await render();
    const ordinary = color();
    expect(ordinary).not.toBe(grey);

    publishCell({ readOnly: true, spillGhost: true });
    await render();
    expect(input().value).toBe("=SEQUENCE(3)");
    expect(input().readOnly).toBe(true);
    expect(color(), "an external spill ghost is not greyed like a grid spill cell").toBe(grey);
  });

  it("a republish that ONLY turns the cell into a ghost is heard (the store's change check sees spillGhost)", async () => {
    const grey = await gridSpillColor();
    publishCell({ readOnly: true });
    await render();
    expect(color()).not.toBe(grey);
    // Same address, content and readOnly -- only the ghost flag changes.
    publishCell({ readOnly: true, spillGhost: true });
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(color(), "the ghost flag alone did not reach the bar").toBe(grey);
  });

  it("an external cell that is not a ghost keeps the ordinary colour", async () => {
    const grey = await gridSpillColor();
    publishCell({ readOnly: true });
    await render();
    expect(color()).not.toBe(grey);
  });
});
