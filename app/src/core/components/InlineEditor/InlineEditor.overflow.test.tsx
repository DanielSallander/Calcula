//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.overflow.test.tsx
// PURPOSE: The in-cell editor never presents a scrollbar.
//
// CONTEXT: The editor carried `overflow: auto`. That reads as harmless until you
//          notice the box it is on: a default cell is 64.29 x 20 logical px, and
//          the content area inside the 2px accent border is SIXTEEN pixels tall.
//          A Chromium scrollbar is 8px here (`::-webkit-scrollbar` in
//          app/src/index.css), so:
//
//            1. An entry too long for its column that CANNOT expand — the
//               neighbour holds data, or the neighbour lookup has not answered
//               yet and "unknown" deliberately counts as occupied — overflows
//               horizontally and draws a horizontal bar.
//            2. That bar takes 8 of the 16 content pixels, so the single 16px
//               line no longer fits vertically and the VERTICAL bar appears too.
//
//          The user sees both bars, plus the corner, painted over their
//          half-typed value. Excel clips; so does the Floating Range in-cell
//          editor (`app/extensions/FloatingRange/editor/frEditor.ts`, which sets
//          `overflow: hidden` on its own textarea for the same reason).
//
//          `hidden` is not "cannot scroll": the box stays programmatically
//          scrollable, so Chromium keeps scrolling the caret into view as the
//          user types past the right edge. Only the bars go away. jsdom has no
//          layout and therefore cannot grow a real scrollbar, so what is pinned
//          here is the declaration that decides whether one may exist at all.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ProbedCell {
  row: number;
  col: number;
  display: string;
}

/** Declared with the real 4-argument shape so a test can answer BASED ON the
 *  range asked for; `vi.fn(async () => [])` infers a nullary mock and rejects
 *  any implementation that reads its arguments. */
const getViewportCells = vi.fn(
  async (_r1: number, _c1: number, _r2: number, _c2: number): Promise<ProbedCell[]> => []
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

/** Excel's default column width, and the row height the backend hands us. */
const COL_W = 64.29;
const ROW_H = 20;

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: COL_W,
  defaultCellHeight: ROW_H,
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

const ROW = 3;
const COL = 2;

let root: Root;
let host: HTMLDivElement;

function editorEl(): HTMLTextAreaElement {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement;
}

function computed(): CSSStyleDeclaration {
  return window.getComputedStyle(editorEl());
}

/**
 * Every axis that can put a bar on the box. The stylesheet declares the
 * shorthand; jsdom's cascade may or may not expand it to the longhands, so an
 * axis that resolves to "" is skipped rather than asserted against — asserting
 * "" === "hidden" would fail for a reason that has nothing to do with the bug.
 */
function scrollableAxes(): string[] {
  const cs = computed();
  return (["overflow", "overflowX", "overflowY"] as const)
    .map((prop) => cs[prop])
    .filter((value) => value !== "" && value !== undefined);
}

let mountSeq = 0;

async function mount(value: string): Promise<void> {
  mountSeq += 1;
  const editing = { row: ROW, col: COL, value } as EditingCell;
  await act(async () => {
    root.render(
      <GridProvider key={mountSeq} initialState={getInitialState()}>
        <InlineEditor
          editing={editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={() => {}}
          onCommit={async () => true}
          onCancel={() => {}}
        />
      </GridProvider>
    );
  });
  // Let the neighbour lookup settle, so the expansion this test depends on has
  // actually been applied rather than still being "unknown".
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InlineEditor overflow", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    getViewportCells.mockReset();
    mountSeq += 1;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("never allows a scrollbar, even when the entry cannot fit its column", async () => {
    // Every neighbour holds data, so the Excel-parity expansion refuses to
    // cover any of them and the editor stays exactly one cell wide. This is the
    // reported case: a long entry with nowhere to grow.
    getViewportCells.mockImplementation(async (r1, c1, _r2, c2) => {
      const cells: ProbedCell[] = [];
      for (let c = c1; c <= c2; c++) cells.push({ row: r1, col: c, display: "occupied" });
      return cells;
    });

    await mount("=1+5000000000000000000000000000");

    const el = editorEl();
    expect(el).toBeTruthy();
    // The premise: the box really did stay at its cell's width, so the entry
    // really does overflow. Without this the assertion below could pass for the
    // wrong reason (an editor wide enough to need no scrollbar in the first
    // place proves nothing about the declaration).
    expect(parseFloat(computed().width)).toBeCloseTo(COL_W, 1);

    const axes = scrollableAxes();
    expect(axes.length).toBeGreaterThan(0);
    for (const value of axes) expect(value).toBe("hidden");
  });

  it("never allows a scrollbar on a multi-line entry either", async () => {
    // Vertical growth is bounded by the viewport, so a tall enough Alt+Enter
    // entry overflows downward no matter how much room the row has.
    getViewportCells.mockResolvedValue([]);

    await mount(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));

    expect(editorEl()).toBeTruthy();
    const axes = scrollableAxes();
    expect(axes.length).toBeGreaterThan(0);
    for (const value of axes) expect(value).toBe("hidden");
  });

  it("keeps the resize handle off, which would be the other way to get chrome", async () => {
    getViewportCells.mockResolvedValue([]);
    await mount("short");
    expect(computed().resize).toBe("none");
  });
});
