//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.wrap.test.tsx
// PURPOSE: The height the editor renders at comes from the BROWSER'S OWN layout
//          of the wrapped entry, and the box is bounded by the GRID rather than
//          by the window.
//
// CONTEXT: jsdom has no layout engine: `scrollHeight` is 0 and `offsetParent` is
//          null, so the editor's real path — measure, then size to what was
//          measured — is invisible to an ordinary component test, which only
//          ever exercises the count-based fallback. Two layout properties are
//          therefore emulated here with the semantics Chromium actually has, so
//          the shipped path is the one under test.
//
//          The emulation of `scrollHeight` is the interesting one. Chromium
//          never reports it as less than the element's own client height, which
//          is why the editor must neutralise its height (`height: auto`) before
//          reading it. Without that step the box latches at its high-water mark:
//          it grows as the entry grows and then never shrinks back when the user
//          deletes the text again. `shrinks back again` below fails if that line
//          is removed — which it would not if the stub simply returned a number.

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
import { EDITOR_VCHROME_PX } from "./expansion";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type EditingCell,
  type GridConfig,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const COL_W = 64.29;
const ROW_H = 20;
/** One rendered line inside a default row: the row less its two borders. */
const LINE = ROW_H - EDITOR_VCHROME_PX;

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

// --- Emulated layout ---------------------------------------------------------

/** What the "browser" would lay the wrapped entry out at, in px. */
let contentHeight = LINE;
/** The grid canvas layer the editor is positioned inside. */
let layer: HTMLDivElement;

const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const realOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

function installLayout(): void {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      // Chromium: scrollHeight is max(content height, client height). The
      // editor neutralises its own height before reading, and this is what
      // makes that step observable.
      if (this.style.height === "auto") return contentHeight;
      const boxed = parseFloat(window.getComputedStyle(this).height);
      const client = Number.isFinite(boxed) ? Math.max(0, boxed - EDITOR_VCHROME_PX) : 0;
      return Math.max(contentHeight, client);
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, "offsetParent", {
    configurable: true,
    get: () => layer,
  });
}

function uninstallLayout(): void {
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).offsetParent;
  if (realScrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", realScrollHeight);
  if (realOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", realOffsetParent);
  }
}

/** Size the emulated grid layer. */
function sizeLayer(width: number, height: number): void {
  Object.defineProperty(layer, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(layer, "clientHeight", { configurable: true, get: () => height });
}

let root: Root;
let host: HTMLDivElement;

function editorEl(): HTMLTextAreaElement {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement;
}

function renderedHeight(): number {
  return parseFloat(window.getComputedStyle(editorEl()).height);
}

function renderedWidth(): number {
  return parseFloat(window.getComputedStyle(editorEl()).width);
}

function renderedLeft(): number {
  return parseFloat(window.getComputedStyle(editorEl()).left);
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
  await act(async () => {
    await Promise.resolve();
  });
}

describe("InlineEditor sizes itself from real layout", () => {
  beforeEach(() => {
    contentHeight = LINE;
    layer = document.createElement("div");
    document.body.appendChild(layer);
    sizeLayer(1200, 800);
    installLayout();
    // A window much larger than the grid, so any assertion that passes because
    // the WINDOW happened to bound the box would pass for the wrong reason.
    window.innerWidth = 5000;
    window.innerHeight = 5000;
    host = document.createElement("div");
    layer.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    uninstallLayout();
    layer.remove();
  });

  it("is exactly the row height when the entry lays out on one line", async () => {
    contentHeight = LINE;
    await renderEditor("42");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 5);
  });

  it("takes its height from the WRAP the browser chose, not from the newline count", async () => {
    // A single-line entry — no hard breaks at all — that the browser wrapped
    // onto three lines. The count-based estimate would say one row; only the
    // measurement knows better, and the measurement is what must win.
    contentHeight = LINE * 3;
    await renderEditor("a very long entry with no newlines in it whatsoever");
    expect(renderedHeight()).toBeCloseTo(ROW_H + 2 * LINE, 5);
  });

  it("shrinks back again when the entry gets shorter", async () => {
    contentHeight = LINE * 5;
    await renderEditor("long".repeat(40));
    expect(renderedHeight()).toBeGreaterThan(ROW_H);

    // The user deletes it all. If the editor measured at its CURRENT height
    // instead of neutralising first, scrollHeight would still report the tall
    // box and it would stay tall forever.
    contentHeight = LINE;
    await renderEditor("x");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 5);
  });

  it("stops at the GRID's bottom edge, not the window's", async () => {
    // Row 3 sits at y = 24 + 3*20 = 84. A 200px-tall grid leaves 116px.
    sizeLayer(1200, 200);
    contentHeight = 5000;
    await renderEditor("wrapped".repeat(200));
    expect(renderedHeight()).toBeCloseTo(116, 5);
    // The window is 5000 tall; had that been the bound this would be enormous.
    expect(renderedHeight()).toBeLessThan(200);
  });

  it("stops at the GRID's right edge, not the window's", async () => {
    // The canvas layer is inset by the scrollbar gutter and sits right of the
    // sidebar, so measuring the window put the box under the scrollbar — where
    // the layer's own `overflow: hidden` clipped it without a sound.
    sizeLayer(300, 800);
    await renderEditor("Quarterly revenue for the EMEA region, restated and re-restated");
    expect(renderedLeft() + renderedWidth()).toBeLessThanOrEqual(300 + 0.01);
    expect(renderedWidth()).toBeGreaterThan(COL_W);
  });

  it("never renders a box shorter than the cell it is editing", async () => {
    contentHeight = 1;
    await renderEditor("x");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 5);
  });

  it("hands the height back to the stylesheet after measuring", async () => {
    // The measurement writes `height: auto` onto the element and must put it
    // back; a leftover inline height would outrank the styled-components rule
    // and freeze the box at one line forever.
    contentHeight = LINE * 3;
    await renderEditor("wrapped entry");
    expect(editorEl().style.height).toBe("");
  });
});
