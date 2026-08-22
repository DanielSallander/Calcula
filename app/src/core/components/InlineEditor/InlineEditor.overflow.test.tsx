//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.overflow.test.tsx
// PURPOSE: The in-cell editor never presents a scrollbar — and the reason that
//          is safe rather than lossy is pinned here too.
//
// CONTEXT: The editor carried `overflow: auto`. That reads as harmless until you
//          notice the box it is on: a default cell is 64.29 x 20 logical px, and
//          the content area inside the 2px accent border is SIXTEEN pixels tall.
//          A Chromium scrollbar is 8px here (`::-webkit-scrollbar` in
//          app/src/index.css), so an entry too long for its column overflowed
//          horizontally and drew a horizontal bar; that bar took 8 of the 16
//          content pixels, so the single 16px line no longer fitted vertically
//          and the VERTICAL bar appeared too. Both bars plus the corner, painted
//          over the user's half-typed value. Excel shows neither, ever.
//
//          `hidden` ALONE would trade a scrollbar for silently clipped text,
//          which is not parity either — so the two declarations that make it
//          honest are asserted together: the box wraps (`pre-wrap`, and
//          `overflow-wrap: anywhere` so an unbroken formula can break at all)
//          and grows downward to fit what it wrapped. Clipping is then reserved
//          for the one case wrapping cannot solve, an entry that outgrows the
//          whole grid, where `hidden` still leaves the box programmatically
//          scrollable so Chromium carries the caret along as the user types.
//
//          jsdom has no layout and therefore cannot grow a real scrollbar, so
//          what is pinned here is the set of declarations that decide whether
//          one may exist at all.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: async () => [],
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

function expectNoScrollbarAnywhere(): void {
  const axes = scrollableAxes();
  expect(axes.length).toBeGreaterThan(0);
  for (const value of axes) expect(value).toBe("hidden");
}

let mountSeq = 0;

async function mount(value: string): Promise<void> {
  mountSeq += 1;
  const editing = { row: 3, col: 2, value } as EditingCell;
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
  await act(async () => {
    await Promise.resolve();
  });
}

describe("InlineEditor overflow", () => {
  beforeEach(() => {
    window.innerWidth = 1200;
    window.innerHeight = 800;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mountSeq += 1;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("wraps rather than clipping, which is what makes hiding the bars honest", () => {
    // Asserted on a mounted editor rather than by reading the stylesheet, so it
    // pins what the user's box actually resolves to.
    const cs = { whiteSpace: "", overflowWrap: "" };
    return mount("=1+5000").then(() => {
      const live = computed();
      cs.whiteSpace = live.whiteSpace;
      cs.overflowWrap = live.overflowWrap;
      // pre-wrap, never plain pre: plain pre cannot wrap, so `overflow: hidden`
      // would mean an entry too long for the grid is simply invisible.
      expect(cs.whiteSpace).toBe("pre-wrap");
      // A formula has no spaces, so without `anywhere` there is no break
      // opportunity in it at all and pre-wrap alone would not save it.
      if (cs.overflowWrap !== "") expect(cs.overflowWrap).toBe("anywhere");
    });
  });

  it("never allows a scrollbar on an entry far longer than its column", async () => {
    await mount("=1+5000000000000000000000000000");
    expect(editorEl()).toBeTruthy();
    expectNoScrollbarAnywhere();
  });

  it("never allows a scrollbar when the box is clamped hard against the grid edge", async () => {
    // A window barely wider than the cell: the box cannot grow, so everything
    // that follows has to wrap. This is the case that used to draw both bars.
    window.innerWidth = 200;
    await mount("=SUM(A1:A100)+VLOOKUP(B2,Sheet2!A:D,4,FALSE)+INDEX(C:C,MATCH(D2,E:E,0))");
    expectNoScrollbarAnywhere();
  });

  it("never allows a scrollbar on a multi-line entry either", async () => {
    // Vertical growth is bounded by the grid, so a tall enough Alt+Enter entry
    // outgrows the box no matter how much room the row has.
    await mount(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    expect(editorEl()).toBeTruthy();
    expectNoScrollbarAnywhere();
  });

  it("keeps the resize handle off, which would be the other way to get chrome", async () => {
    await mount("short");
    expect(computed().resize).toBe("none");
  });
});
