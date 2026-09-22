//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.measureLoop.test.tsx
// PURPOSE: The in-cell editor's self-measurement must SETTLE. It measures itself
//          in a layout effect and feeds the result back into its own size, so a
//          measurement that does not converge is not a cosmetic wobble -- React
//          throws "Maximum update depth exceeded", the RootErrorBoundary catches
//          it, and the whole window goes.
//
// CONTEXT: The effect used to have NO dependency array and a bail-out that only
//          recognised a FIXED POINT ("the triple I just read equals the triple I
//          am holding"). A fixed-point test cannot see a 2-CYCLE: a measurement
//          that reads A, then B, then A, then B is never equal to the value in
//          state, so every pass committed new state, every commit re-ran the
//          effect, and nothing ever ended it.
//
//          Two repros here, because there are two separable loops:
//
//            1. The measurement alternates on its own (`contentHeight` flips).
//               A dependency array ends this one: `contentHeight` is not an
//               input to the measurement, so a new value cannot re-trigger it.
//
//            2. The alternation reaches the box's WIDTH (`layerWidth` flips, and
//               width IS an input to how the entry wraps). A dependency array
//               does NOT end this one -- the dep genuinely changed every pass.
//               Only a bounded settle budget does.
//
//          The second is why the fix is not "add []". The component measures an
//          element whose CSS lives three files away (Spreadsheet.styles.ts); it
//          cannot prove the measurement converges, so it must survive a
//          measurement that does not.

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
  type DimensionOverrides,
  type EditingCell,
  type GridConfig,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const COL_W = 64.29;
const ROW_H = 20;
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

/** Long enough that the box wants far more width than one column. */
const LONG = "Quarterly revenue for the EMEA region, restated and re-restated again";

// --- Emulated layout ---------------------------------------------------------

let layer: HTMLDivElement;
/** How many times the editor has taken a content measurement. */
let measurements = 0;
/** Supplies `scrollHeight` for the measurement pass; `null` = a plain constant. */
let contentHeightSource: (() => number) | null = null;
/** Supplies the grid layer's `clientWidth`. */
let layerWidthSource: () => number;

const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const realOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

function installLayout(): void {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      // Only the neutralised read is the editor's measurement pass; Chromium's
      // max(content, client) behaviour for the un-neutralised read is pinned in
      // InlineEditor.wrap.test.tsx and is not what this file is about.
      if (this.style.height === "auto") {
        measurements += 1;
        return contentHeightSource ? contentHeightSource() : LINE;
      }
      const boxed = parseFloat(window.getComputedStyle(this).height);
      return Number.isFinite(boxed) ? Math.max(0, boxed - EDITOR_VCHROME_PX) : 0;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, "offsetParent", {
    configurable: true,
    get: () => layer,
  });
  Object.defineProperty(layer, "clientWidth", {
    configurable: true,
    get: () => layerWidthSource(),
  });
  Object.defineProperty(layer, "clientHeight", { configurable: true, get: () => 800 });
}

function uninstallLayout(): void {
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).offsetParent;
  if (realScrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", realScrollHeight);
  if (realOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", realOffsetParent);
  }
}

let root: Root;
let host: HTMLDivElement;

function editorEl(): HTMLTextAreaElement | null {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement | null;
}

interface Overrides {
  viewport?: Viewport;
  dimensions?: DimensionOverrides;
  zoom?: number;
}

async function renderEditor(value: string, over: Overrides = {}): Promise<void> {
  const editing: EditingCell = { row: 3, col: 2, value } as EditingCell;
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <InlineEditor
          editing={editing}
          config={CONFIG}
          viewport={over.viewport ?? VIEWPORT}
          dimensions={over.dimensions ?? createEmptyDimensionOverrides()}
          zoom={over.zoom ?? 1}
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

function renderedHeight(): number {
  const el = editorEl();
  return el ? parseFloat(window.getComputedStyle(el).height) : NaN;
}

/** Render and report the error React threw, or null if it settled. */
async function renderCatching(value: string): Promise<Error | null> {
  try {
    await renderEditor(value);
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe("InlineEditor survives a measurement that does not converge", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    measurements = 0;
    contentHeightSource = null;
    layerWidthSource = () => 1200;
    layer = document.createElement("div");
    document.body.appendChild(layer);
    installLayout();
    window.innerWidth = 5000;
    window.innerHeight = 5000;
    host = document.createElement("div");
    layer.appendChild(host);
    root = createRoot(host);
    // React shouts the whole component stack for an update-depth blow-up; the
    // assertions below are on the thrown error, not on the console.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      act(() => root.unmount());
    } catch {
      /* a root left mid-blow-up cannot always unmount cleanly */
    }
    errorSpy.mockRestore();
    uninstallLayout();
    layer.remove();
  });

  it("settles when the measured content height ALTERNATES between two values", async () => {
    // A 2-cycle. Every pass disagrees with the value in state, so a bail-out
    // that only recognises a fixed point never fires.
    let flip = false;
    contentHeightSource = () => {
      flip = !flip;
      return flip ? LINE : LINE * 3;
    };

    const err = await renderCatching(LONG);
    expect(err).toBeNull();
    expect(editorEl()).toBeTruthy();
    // Bounded, not merely "finite eventually": React's own ceiling is 50, so an
    // assertion of "did not throw" alone would pass at 49 measurements a render.
    expect(measurements).toBeLessThanOrEqual(8);
  });

  it("settles when the oscillation reaches the box WIDTH", async () => {
    // The harder one, and the reason the fix is not "add []".
    //
    // `layerWidth` is the editor's right-hand bound, so it feeds the WIDTH the
    // box renders at — and the width is an input to the next measurement. Both
    // bounds below are narrower than the entry wants (the editor's own cell
    // starts at 50 + 2*64.29 = 178.58, and LONG wants ~608px), so each one
    // clamps the box to a DIFFERENT width and the dependency genuinely changes
    // on every pass. A dependency array cannot end this; only the budget can.
    let wide = false;
    layerWidthSource = () => {
      wide = !wide;
      return wide ? 500 : 700;
    };
    contentHeightSource = () => {
      const el = editorEl();
      const w = el ? parseFloat(window.getComputedStyle(el).width) : 0;
      // Narrower box => more wrapping. A real relationship, not a constant.
      return w > 500 ? LINE : LINE * 4;
    };

    const err = await renderCatching(LONG);
    expect(err).toBeNull();
    expect(editorEl()).toBeTruthy();
    expect(measurements).toBeLessThanOrEqual(8);
  });

  it("does not re-measure on a render that cannot have changed the layout", async () => {
    // The effect used to run after EVERY render -- including every parent
    // render -- and each run writes `height: auto`, reads `scrollHeight` and
    // writes the height back. That is a forced synchronous reflow of the grid
    // on every keystroke, scroll frame and selection change.
    contentHeightSource = () => LINE;
    await renderEditor("42");
    const afterFirst = measurements;
    expect(afterFirst).toBeGreaterThan(0);

    // Same props, same value: re-render the identical tree several times.
    await renderEditor("42");
    await renderEditor("42");
    await renderEditor("42");
    expect(measurements).toBe(afterFirst);
  });

  it("still re-measures when the entry itself changes", async () => {
    contentHeightSource = () => LINE;
    await renderEditor("4");
    const afterFirst = measurements;
    await renderEditor("42");
    expect(measurements).toBeGreaterThan(afterFirst);
  });
});

/**
 * A dependency array's failure mode is the mirror image of the crash: NOT
 * re-running when it should have. The box would then paint at whatever size it
 * was measured at last, and the user would see a stale editor — which is the
 * ordinary path, every keystroke, for the most-used component in the app.
 *
 * Every input that can legitimately change what the browser lays out gets a
 * case here. Growing text and the grid's own edges are pinned in
 * InlineEditor.expansion.test.tsx and InlineEditor.wrap.test.tsx; zoom, scroll
 * and a column resize had NO component-level coverage at all before this file,
 * which is part of why a measurement effect that ran on every render looked
 * like the safe option.
 */
describe("InlineEditor re-measures whenever the layout can have changed", () => {
  beforeEach(() => {
    measurements = 0;
    // The taller the entry, the more lines — so a missed re-measure shows up as
    // a WRONG BOX, not merely as a missing call.
    contentHeightSource = () => {
      const el = editorEl();
      const len = el ? el.value.length : 0;
      return LINE * Math.max(1, Math.ceil(len / 10));
    };
    layerWidthSource = () => 1200;
    layer = document.createElement("div");
    document.body.appendChild(layer);
    installLayout();
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

  it("grows as the entry gets longer and shrinks again", async () => {
    await renderEditor("x");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 5);

    await renderEditor("x".repeat(35)); // 4 lines
    expect(renderedHeight()).toBeCloseTo(ROW_H + 3 * LINE, 5);

    await renderEditor("x");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 5);
  });

  it("re-measures a long formula, which is one line of text with no spaces", async () => {
    await renderEditor("=IF(SUM(A1:A99)>0,VLOOKUP(B2,Sheet2!A:D,4,FALSE),\"\")");
    // 52 characters => 6 wrapped lines under the model above.
    expect(renderedHeight()).toBeCloseTo(ROW_H + 5 * LINE, 5);
  });

  it("re-measures on a ZOOM change", async () => {
    await renderEditor("x".repeat(25));
    const before = measurements;
    const widthAt100 = parseFloat(window.getComputedStyle(editorEl()!).width);

    await renderEditor("x".repeat(25), { zoom: 2 });
    expect(measurements).toBeGreaterThan(before);
    // Zoom is a real input to the geometry, not just a CSS scale: the cell box
    // doubles, so the box may never come back narrower or shorter than it was.
    expect(parseFloat(window.getComputedStyle(editorEl()!).width)).toBeGreaterThan(widthAt100);
    expect(renderedHeight()).toBeGreaterThanOrEqual(2 * ROW_H);
  });

  it("re-measures when the grid SCROLLS under the open editor", async () => {
    await renderEditor("x".repeat(25));
    const before = measurements;
    // The box moves up: the room between it and the grid's bottom edge changes,
    // which is an input to the clamp.
    await renderEditor("x".repeat(25), { viewport: { ...VIEWPORT, scrollY: 40 } });
    expect(measurements).toBeGreaterThan(before);
  });

  it("re-measures when the edited COLUMN is resized", async () => {
    await renderEditor("x".repeat(25));
    const before = measurements;
    const wider = createEmptyDimensionOverrides();
    wider.columnWidths.set(2, 400);
    await renderEditor("x".repeat(25), { dimensions: wider });
    expect(measurements).toBeGreaterThan(before);
    // A 400px column holds the entry on fewer lines than a 64px one did, and
    // the box must never be shorter than the cell it is editing.
    expect(renderedHeight()).toBeGreaterThanOrEqual(ROW_H);
  });

  it("re-measures after the WINDOW resizes, with no prop of its own changing", async () => {
    // The capability the no-dependency-array effect was providing, kept — but
    // subscribed to as the event it is rather than paid for on every render.
    await renderEditor("x".repeat(25));
    const before = measurements;
    await act(async () => {
      window.innerWidth = 900;
      window.dispatchEvent(new Event("resize"));
    });
    expect(measurements).toBeGreaterThan(before);
  });
});
