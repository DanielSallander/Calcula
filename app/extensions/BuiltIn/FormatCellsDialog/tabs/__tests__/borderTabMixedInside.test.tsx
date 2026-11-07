//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/borderTabMixedInside.test.tsx
// PURPOSE: BUG-0726 -- a range's INSIDE lines are read across every inner
//          boundary, and a line that differs between boundaries is MIXED
//          (greyed), as Excel greys it; never the top-left cell's own sides.
// CONTEXT: Excel 16 [LIVE] 2026-11-06 (lane uiforms probe3): on A1:B3 with only
//          A1's bottom bordered, the Border tab's preview draws the inside
//          horizontal line as a grey dotted line (#C0C0C0), and the same with
//          only B2's TOP bordered (one boundary line, whichever cell carries
//          it); with every inside line drawn it is solid black. The dialog
//          loaded the inside lines from the top-left cell, so the first case
//          showed the line ON and a click meant to draw it everywhere turned it
//          OFF everywhere. Four parts: the loader (lib/borderEdges.ts) over a
//          fake sheet, the plan (a mixed inside line left alone is never
//          written), the tab (greyed, and a click draws the chosen line), and
//          the preview (Excel's grey dotted line for every mixed line).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CellData, StyleData } from "@api";

vi.mock("../../components/ColorPicker", () => ({ ColorPicker: () => null }));

import { BorderTab } from "../BorderTab";
import { useFormatCellsStore, snapshotOf } from "../../hooks/useFormatCellsState";
import { planFormatCellsWrites } from "../../lib/formatCellsWrites";
import {
  insideLineSide,
  insideLineSides,
  boundaryLine,
  previewLine,
  INSIDE_READ_LIMIT,
  MIXED_SIDE,
  MIXED_LINE_COLOR,
  type EdgeReader,
} from "../../lib/borderEdges";

// ---------------------------------------------------------------------------
// A fake sheet. Style 0 has no border. Style 1 a thin black BOTTOM, 2 a thin
// black TOP, 3 a thin black RIGHT, 4 a thin black LEFT, 5 a thick bottom, 6 a
// thin RED bottom.
// ---------------------------------------------------------------------------

const none = { style: "none", color: "#000000", width: 0 };
const line = (style = "thin", color = "#000000") => ({ style, color, width: style === "thick" ? 3 : 1 });
function styleData(sides: Partial<Record<"borderTop" | "borderBottom" | "borderLeft" | "borderRight", object>>): StyleData {
  return { borderTop: none, borderRight: none, borderBottom: none, borderLeft: none, ...sides } as unknown as StyleData;
}
const STYLES: Record<number, StyleData> = {
  0: styleData({}),
  1: styleData({ borderBottom: line() }),
  2: styleData({ borderTop: line() }),
  3: styleData({ borderRight: line() }),
  4: styleData({ borderLeft: line() }),
  5: styleData({ borderBottom: line("thick") }),
  6: styleData({ borderBottom: line("thin", "#ff0000") }),
};

type FakeCell = { row: number; col: number; styleIndex: number; rowSpan?: number; colSpan?: number };

function readerOf(cells: FakeCell[]): EdgeReader & { reads: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> } {
  const reads: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> = [];
  return {
    reads,
    async cells(strip) {
      reads.push(strip);
      return cells
        .filter((c) => c.row >= strip.startRow && c.row <= strip.endRow && c.col >= strip.startCol && c.col <= strip.endCol)
        .map((c) => ({ rowSpan: 1, colSpan: 1, ...c }) as unknown as CellData);
    },
    async style(index) {
      return STYLES[index];
    },
    async styleAt(row, col) {
      return STYLES[cells.find((c) => c.row === row && c.col === col)?.styleIndex ?? 0];
    },
  };
}

const A1_B3 = { startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
const THIN = { style: "thin", color: "#000000" };
const NONE = { style: "none", color: "#000000" };

describe("the loader reads every inner boundary (BUG-0726)", () => {
  it("A1 bordered at the bottom and nothing else: Inside Horizontal is MIXED, Inside Vertical none", async () => {
    const inside = await insideLineSides(A1_B3, readerOf([{ row: 0, col: 0, styleIndex: 1 }]));
    expect(inside.borderInsideHorizontal).toEqual(MIXED_SIDE);
    expect(inside.borderInsideVertical).toEqual(NONE);
  });

  it("B2's TOP alone draws the B1|B2 boundary: MIXED too (one line per boundary, whichever cell holds it)", async () => {
    const side = await insideLineSide(A1_B3, "borderInsideHorizontal", readerOf([{ row: 1, col: 1, styleIndex: 2 }]));
    expect(side).toEqual(MIXED_SIDE);
  });

  it("every boundary drawn -- some by the upper cell's bottom, some by the lower cell's top -- is that line", async () => {
    const side = await insideLineSide(A1_B3, "borderInsideHorizontal", readerOf([
      { row: 0, col: 0, styleIndex: 1 },
      { row: 1, col: 1, styleIndex: 2 },
      { row: 1, col: 0, styleIndex: 1 },
      { row: 2, col: 1, styleIndex: 2 },
    ]));
    expect(side).toEqual(THIN);
  });

  it("a different weight or colour on one boundary is MIXED", async () => {
    const thick = await insideLineSide(A1_B3, "borderInsideHorizontal", readerOf([
      { row: 0, col: 0, styleIndex: 1 }, { row: 0, col: 1, styleIndex: 5 },
      { row: 1, col: 0, styleIndex: 1 }, { row: 1, col: 1, styleIndex: 1 },
    ]));
    expect(thick.mixed).toBe(true);
    const red = await insideLineSide(A1_B3, "borderInsideHorizontal", readerOf([
      { row: 0, col: 0, styleIndex: 1 }, { row: 0, col: 1, styleIndex: 6 },
      { row: 1, col: 0, styleIndex: 1 }, { row: 1, col: 1, styleIndex: 1 },
    ]));
    expect(red.mixed).toBe(true);
  });

  it("the vertical inside line reads each left|right boundary (A2's right alone is MIXED)", async () => {
    expect(await insideLineSide(A1_B3, "borderInsideVertical", readerOf([{ row: 1, col: 0, styleIndex: 3 }]))).toEqual(MIXED_SIDE);
    const all = await insideLineSide(A1_B3, "borderInsideVertical", readerOf([
      { row: 0, col: 0, styleIndex: 3 }, { row: 1, col: 1, styleIndex: 4 }, { row: 2, col: 0, styleIndex: 3 },
    ]));
    expect(all).toEqual(THIN);
  });

  it("a boundary inside a merged cell is no boundary", async () => {
    // A1:A2 merged, no border of its own (so the A1|A2 position would read as
    // "none" if it counted); every real boundary is thin: B1|B2 and B2|B3 by
    // the upper cells' bottoms, A2|A3 by A3's top.
    const side = await insideLineSide(A1_B3, "borderInsideHorizontal", readerOf([
      { row: 0, col: 0, styleIndex: 0, rowSpan: 2 },
      { row: 0, col: 1, styleIndex: 1 },
      { row: 1, col: 1, styleIndex: 1 },
      { row: 2, col: 0, styleIndex: 2 },
    ]));
    expect(side).toEqual(THIN);
  });

  it("two sides of ONE boundary that disagree are MIXED; one side alone is that side", () => {
    expect(boundaryLine(THIN as never, NONE as never)).toEqual(THIN);
    expect(boundaryLine(NONE as never, THIN as never)).toEqual(THIN);
    expect(boundaryLine(THIN as never, THIN as never)).toEqual(THIN);
    expect(boundaryLine(THIN as never, { style: "thick", color: "#000000" }).mixed).toBe(true);
  });

  it("past the read limit the first and the last boundary decide -- never the top-left cell alone", async () => {
    const tall = { startRow: 0, startCol: 0, endRow: INSIDE_READ_LIMIT + 10, endCol: 0 };
    // Only the FIRST boundary is drawn: the ends differ.
    const reader = readerOf([{ row: 0, col: 0, styleIndex: 1 }]);
    expect((await insideLineSide(tall, "borderInsideHorizontal", reader)).mixed).toBe(true);
    expect(reader.reads).toEqual([]);
    // First and last both drawn: that line.
    const both = readerOf([{ row: 0, col: 0, styleIndex: 1 }, { row: INSIDE_READ_LIMIT + 9, col: 0, styleIndex: 1 }]);
    expect(await insideLineSide(tall, "borderInsideHorizontal", both)).toEqual(THIN);
  });

  it("one row or one column has no inside line in that direction", async () => {
    const row = { startRow: 0, startCol: 0, endRow: 0, endCol: 3 };
    expect(await insideLineSide(row, "borderInsideHorizontal", readerOf([{ row: 0, col: 0, styleIndex: 1 }]))).toEqual(NONE);
  });
});

describe("the plan never writes a MIXED inside line the user left alone", () => {
  beforeEach(() => useFormatCellsStore.getState().reset());

  it("loaded mixed, untouched -- or even marked touched -- no inside preset", () => {
    useFormatCellsStore.getState().loadFromStyle({
      borderInsideHorizontal: { ...MIXED_SIDE },
      borderInsideVertical: { ...MIXED_SIDE },
    });
    useFormatCellsStore.getState().markBaseline();
    useFormatCellsStore.getState().setBold(true);
    const s = useFormatCellsStore.getState();
    const calls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, s.touched).calls;
    expect(calls.some((c) => c.kind === "preset")).toBe(false);
    // A side that is STILL mixed is no line: its "none" would remove every
    // inner line of the range.
    const forced = new Set([...s.touched, "borderInsideHorizontal" as const, "borderInsideVertical" as const]);
    const forcedCalls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, forced).calls;
    expect(forcedCalls.some((c) => c.kind === "preset")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

describe("the Border tab greys a MIXED inside line, and a click draws the line", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    useFormatCellsStore.getState().reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("BUG-0726 aria-pressed=mixed on both inside buttons; a click on one draws it as ONE preset", async () => {
    const store = useFormatCellsStore.getState();
    store.setRangeShape({ multiRow: true, multiCol: true });
    store.loadFromStyle({ borderInsideHorizontal: { ...MIXED_SIDE }, borderInsideVertical: { ...MIXED_SIDE } });
    store.markBaseline();
    await act(async () => {
      root.render(React.createElement(BorderTab));
    });
    const insideH = container.querySelector<HTMLButtonElement>('[data-testid="fc-border-insideHorizontal"]')!;
    const insideV = container.querySelector<HTMLButtonElement>('[data-testid="fc-border-insideVertical"]')!;
    expect(insideH.getAttribute("aria-pressed")).toBe("mixed");
    expect(insideV.getAttribute("aria-pressed")).toBe("mixed");
    await act(async () => {
      insideH.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const s = useFormatCellsStore.getState();
    expect(s.borderInsideHorizontal).toEqual(THIN);
    const calls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, s.touched).calls;
    expect(calls).toEqual([{ kind: "preset", preset: "insideHorizontal", style: "solid", color: "#000000", width: 1 }]);
  });

  it("the preview draws a mixed inside line in Excel's grey dotted line, a real one in its own colour", async () => {
    const store = useFormatCellsStore.getState();
    store.setRangeShape({ multiRow: true, multiCol: true });
    store.loadFromStyle({ borderInsideHorizontal: { ...MIXED_SIDE }, borderInsideVertical: { style: "thin", color: "#00ff00" } });
    await act(async () => {
      root.render(React.createElement(BorderTab));
    });
    const h = container.querySelector<HTMLElement>('[data-testid="fc-border-preview-insideHorizontal"]')!;
    const v = container.querySelector<HTMLElement>('[data-testid="fc-border-preview-insideVertical"]')!;
    expect(h.style.borderTopStyle).toBe("dotted");
    expect(h.style.borderTopColor).toBe("rgb(192, 192, 192)");
    expect(v.style.borderLeftStyle).toBe("solid");
    expect(v.style.borderLeftColor).toBe("rgb(0, 255, 0)");
  });

  it("a mixed OUTER edge is drawn the same grey dotted way (BUG-0365's state, Excel's preview)", async () => {
    const store = useFormatCellsStore.getState();
    store.setRangeShape({ multiRow: true, multiCol: true });
    store.loadFromStyle({ borderBottom: { ...MIXED_SIDE } });
    await act(async () => {
      root.render(React.createElement(BorderTab));
    });
    const preview = container.querySelector<HTMLElement>('[data-testid="fc-border-preview"]')!;
    expect(preview.style.borderBottomStyle).toBe("dotted");
    expect(preview.style.borderBottomColor).toBe("rgb(192, 192, 192)");
    expect(preview.style.borderTopColor).toBe("transparent");
  });

  it("previewLine: mixed is the grey, none is nothing", () => {
    expect(previewLine({ ...MIXED_SIDE })).toEqual({ color: MIXED_LINE_COLOR, width: "2px", style: "dotted" });
    expect(previewLine({ style: "none", color: "#000000" })).toBeNull();
    expect(previewLine({ style: "thick", color: "#123456" })).toEqual({ color: "#123456", width: "3px", style: "solid" });
  });
});
