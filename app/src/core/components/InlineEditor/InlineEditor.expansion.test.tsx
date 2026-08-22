//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.expansion.test.tsx
// PURPOSE: The REAL inline editor grows to fit the entry the way Excel's does —
//          over its neighbours whatever they hold, never past the grid edge, and
//          collapsing again when the entry no longer needs the room.
// CONTEXT: This file used to assert the opposite of its own title. It pinned
//          "does NOT expand when the immediate neighbour holds data", which
//          meant an entry in a dense table — the common case — had nowhere to
//          grow and scrolled inside one 64.29px column while it was being
//          typed. Excel's in-cell editor is an overlay: it covers the
//          neighbours, and they repaint untouched the moment the edit ends.
//
//          The strongest assertion here is now a NEGATIVE one: the editor makes
//          no backend call at all. That is what "overlay" means operationally —
//          nothing underneath is read, so nothing underneath can be wrong, slow
//          or unanswered. It also takes an IPC round trip out of the path
//          between a keypress and the character appearing.
//
//          Measurement note: jsdom has no 2D canvas, so `measureEditorTextWidth`
//          takes its documented character-count fallback. That is deterministic
//          and monotonic in text length, which is what these assertions need;
//          the exact-pixel arithmetic is pinned in expansion.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The backend lookup this editor no longer makes. Mocked so that a regression
// which reintroduces it is a FAILED ASSERTION here rather than a real IPC call
// in a unit test.
const getViewportCells = vi.fn(
  async (
    startRow: number,
    startCol: number,
    _endRow: number,
    endCol: number
  ): Promise<Array<{ row: number; col: number; display: string }>> => {
    const out: Array<{ row: number; col: number; display: string }> = [];
    for (let c = startCol; c <= endCol; c++) {
      out.push({ row: startRow, col: c, display: "taken" });
    }
    return out;
  }
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

// The editor is a <textarea> (an <input> strips the newlines Alt+Enter puts in
// the entry). Locate it by its stable data attribute, never by tag.
function editorEl(): HTMLTextAreaElement {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement;
}

/** The width the editor is actually rendered at, in px. */
function renderedWidth(): number {
  const el = editorEl();
  if (!el) return NaN;
  return parseFloat(window.getComputedStyle(el).width);
}

async function renderEditor(value: string, cell: Partial<EditingCell> = {}): Promise<void> {
  const editing: EditingCell = { row: 3, col: 2, value, ...cell } as EditingCell;

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
  // Flush anything the editor might still be waiting on. Nothing should be, and
  // `asks the grid nothing` below is what proves it.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A value comfortably wider than one column under the jsdom fallback metric. */
const LONG = "Quarterly revenue for the EMEA region, restated";
const SHORT = "42";

describe("InlineEditor grows like Excel's in-cell editor", () => {
  beforeEach(() => {
    getViewportCells.mockClear();
    window.innerWidth = 1200;
    window.innerHeight = 800;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  it("renders at exactly the cell width for a short entry", async () => {
    await renderEditor(SHORT);
    expect(renderedWidth()).toBeCloseTo(COL_W, 2);
  });

  it("expands for a long entry", async () => {
    await renderEditor(LONG);
    const width = renderedWidth();
    expect(width).toBeGreaterThan(COL_W);
    // It really did cross at least one column boundary.
    expect(width).toBeGreaterThan(COL_W * 2);
  });

  it("expands even though every neighbouring cell holds data", async () => {
    // The mocked backend reports EVERY column as occupied. Under the old rule
    // this rendered at exactly one column wide and the entry scrolled out of
    // sight as it was typed. An overlay covers them instead.
    await renderEditor(LONG);
    expect(renderedWidth()).toBeGreaterThan(COL_W * 2);
  });

  it("asks the grid nothing about what it is covering", async () => {
    // The operational meaning of "overlay", and the reason there is no IPC in
    // the typing path. A reintroduced lookup fails here immediately.
    await renderEditor(LONG);
    await renderEditor(LONG + "!");
    expect(getViewportCells).not.toHaveBeenCalled();
  });

  it("clamps at the grid edge", async () => {
    // A narrow window: the editor's own cell starts at 50 + 2*64.29 = 178.58,
    // so there is ~121px of room to the right edge and no more. (With no layout
    // engine the editor falls back to the window bound; the grid-layer bound it
    // uses in the product is pinned in InlineEditor.wrap.test.tsx.)
    window.innerWidth = 300;
    await renderEditor(LONG);
    const left = parseFloat(window.getComputedStyle(editorEl()).left);
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
      root.render(<GridProvider initialState={getInitialState()}>{null}</GridProvider>);
    });
    expect(host.querySelector("[data-inline-editor]")).toBeNull();
  });

  it("does not expand a MERGED cell past its own span", async () => {
    await renderEditor(LONG, { colSpan: 3 });
    // The merge is 3 columns wide; expansion must not add a fourth.
    expect(renderedWidth()).toBeCloseTo(COL_W * 3, 2);
  });

  it("grows without a round trip, so the FIRST render is already the right size", async () => {
    // The old lookup meant the box spent its first frames at one column wide and
    // widened once the backend answered. Nothing is awaited now, so the width is
    // correct in the render that first shows the entry.
    const editing: EditingCell = { row: 3, col: 2, value: LONG } as EditingCell;
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
    // No extra microtask flush here on purpose.
    expect(renderedWidth()).toBeGreaterThan(COL_W * 2);
  });
});
