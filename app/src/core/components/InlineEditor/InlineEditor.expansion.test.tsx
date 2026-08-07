//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.expansion.test.tsx
// PURPOSE: The REAL inline editor expands over adjacent empty cells while
//          editing, never over occupied ones, never past the viewport, and
//          collapses again when the entry no longer needs the room.
// CONTEXT: The editor had no expansion logic at all, so at the (correct)
//          64.29px default column width a longer entry scrolled inside one
//          column instead of being visible. This drives the component itself —
//          the width asserted is the width the styled input is rendered with.
//
//          Measurement note: jsdom has no 2D canvas, so `measureEditorTextWidth`
//          takes its documented character-count fallback. That is deterministic
//          and monotonic in text length, which is exactly what these assertions
//          need; the exact-pixel arithmetic is pinned in expansion.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend lookup the editor uses to find occupied neighbours ----------
/** Columns (on the edited row) that hold data. */
let occupiedCols = new Set<number>();
const getViewportCells = vi.fn(
  async (startRow: number, startCol: number, _endRow: number, endCol: number) => {
    const out: Array<{ row: number; col: number; display: string; value: string; styleIndex: number }> = [];
    for (let c = startCol; c <= endCol; c++) {
      if (occupiedCols.has(c)) {
        out.push({ row: startRow, col: c, display: "taken", value: "taken", styleIndex: 0 });
      }
    }
    return out;
  },
);
vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: (...args: [number, number, number, number]) => getViewportCells(...args),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));

import { InlineEditor } from "./InlineEditor";
import { GridProvider } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type EditingCell,
  type GridConfig,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The real default column width that exposed the gap. */
const COL_W = 64.29;

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: COL_W,
  defaultCellHeight: 20,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1000,
  totalCols: 100,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 30,
  colCount: 20,
};

let root: Root;
let host: HTMLDivElement;

function editorEl(): HTMLInputElement {
  return host.querySelector("input") as HTMLInputElement;
}

/** The width the editor is actually rendered at, in px. */
function renderedWidth(): number {
  const el = editorEl();
  if (!el) return NaN;
  return parseFloat(window.getComputedStyle(el).width);
}

async function renderEditor(value: string, cell: Partial<EditingCell> = {}): Promise<void> {
  const editing: EditingCell = {
    row: 3,
    col: 2,
    value,
    ...cell,
  } as EditingCell;

  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <InlineEditor
          editing={editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={() => {}}
          onCommit={async () => true}
          onCancel={() => {}}
        />
      </GridProvider>,
    );
  });
  // Let the neighbour lookup resolve and the width recompute.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A value comfortably wider than one column under the jsdom fallback metric. */
const LONG = "Quarterly revenue for the EMEA region, restated";
const SHORT = "42";

describe("InlineEditor expands over neighbouring cells (Excel parity)", () => {
  beforeEach(() => {
    occupiedCols = new Set();
    getViewportCells.mockClear();
    window.innerWidth = 1200;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  it("renders at exactly the cell width for a short entry", async () => {
    await renderEditor(SHORT);
    expect(renderedWidth()).toBeCloseTo(COL_W, 2);
  });

  it("EXPANDS over adjacent empty cells for a long entry", async () => {
    await renderEditor(LONG);
    const width = renderedWidth();
    expect(width).toBeGreaterThan(COL_W);
    // It really did cross at least one column boundary.
    expect(width).toBeGreaterThan(COL_W * 2);
  });

  it("does NOT expand when the immediate neighbour holds data", async () => {
    occupiedCols = new Set([3]); // the cell being edited is col 2
    await renderEditor(LONG);
    expect(renderedWidth()).toBeCloseTo(COL_W, 2);
  });

  it("stops at the first occupied cell instead of obscuring it", async () => {
    occupiedCols = new Set([5]); // two empty neighbours (3, 4), then data
    await renderEditor(LONG);
    const width = renderedWidth();
    expect(width).toBeGreaterThan(COL_W);
    expect(width).toBeLessThanOrEqual(COL_W * 3 + 0.01);
  });

  it("clamps at the viewport edge", async () => {
    // A narrow window: the editor's own cell starts at 50 + 2*64.29 = 178.58,
    // so there is ~121px of room to the right edge and no more.
    window.innerWidth = 300;
    await renderEditor(LONG);
    const el = editorEl();
    const left = parseFloat(window.getComputedStyle(el).left);
    expect(left + renderedWidth()).toBeLessThanOrEqual(300 + 0.01);
    // ...and it did use the room it had.
    expect(renderedWidth()).toBeGreaterThan(COL_W);
  });

  it("collapses back to the cell width when the entry shrinks", async () => {
    await renderEditor(LONG);
    expect(renderedWidth()).toBeGreaterThan(COL_W);

    await renderEditor(SHORT);
    expect(renderedWidth()).toBeCloseTo(COL_W, 2);
  });

  it("is gone entirely once editing stops (commit or cancel)", async () => {
    await renderEditor(LONG);
    expect(editorEl()).toBeTruthy();

    await act(async () => {
      root.render(
        <GridProvider initialState={getInitialState()}>
          {null}
        </GridProvider>,
      );
    });
    expect(host.querySelector("input")).toBeNull();
  });

  it("does not expand a MERGED cell past its own span", async () => {
    await renderEditor(LONG, { colSpan: 3 });
    // The merge is 3 columns wide; expansion must not add a fourth.
    expect(renderedWidth()).toBeCloseTo(COL_W * 3, 2);
  });

  it("looks the neighbours up once per edited cell, not once per keystroke", async () => {
    await renderEditor("a");
    const afterFirst = getViewportCells.mock.calls.length;
    await renderEditor("ab");
    await renderEditor("abc");
    expect(getViewportCells.mock.calls.length).toBe(afterFirst);
  });

  it("does not cover anything while the neighbour lookup is still unanswered", async () => {
    let release: (() => void) | null = null;
    getViewportCells.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    await renderEditor(LONG);
    // Unknown neighbours count as occupied.
    expect(renderedWidth()).toBeCloseTo(COL_W, 2);

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderedWidth()).toBeGreaterThan(COL_W);
  });
});
