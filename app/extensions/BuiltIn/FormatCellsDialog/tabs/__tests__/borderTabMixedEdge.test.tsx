//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/borderTabMixedEdge.test.tsx
// PURPOSE: BUG-0365 -- a range's OUTER edge whose cells draw different lines is
//          MIXED (greyed), as in Excel, never one corner cell's line.
// CONTEXT: Excel 16 [LIVE] 2026-11-04 (lane multiarea probe3): A3 bordered at
//          the bottom, B3 not -- Range("A1:B3").Borders(xlEdgeBottom).LineStyle
//          reads back Null, and the dialog greys that edge. The dialog used to
//          show the bottom-LEFT cell's line, so a click meant to draw the
//          bottom edge turned it OFF along the whole edge.
//          Three parts: the loader (lib/borderEdges.ts) over a fake sheet, the
//          plan (a mixed edge left alone is never written) and the tab (a click
//          on a mixed edge draws the chosen line).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CellData, StyleData } from "@api";

vi.mock("../../components/ColorPicker", () => ({ ColorPicker: () => null }));

import { BorderTab } from "../BorderTab";
import { useFormatCellsStore, snapshotOf } from "../../hooks/useFormatCellsState";
import { planFormatCellsWrites } from "../../lib/formatCellsWrites";
import { outerEdgeSides, edgeSide, EDGE_READ_LIMIT, MIXED_SIDE, type EdgeReader } from "../../lib/borderEdges";

// ---------------------------------------------------------------------------
// A fake sheet: style 0 has no border, style 1 a thin black bottom, style 2 a
// thin black bottom too (a second index for the same look), style 3 a red one.
// ---------------------------------------------------------------------------

const none = { style: "none", color: "#000000", width: 0 };
const thin = (color = "#000000") => ({ style: "thin", color, width: 1 });
function styleData(bottom: object): StyleData {
  return { borderTop: none, borderRight: none, borderLeft: none, borderBottom: bottom } as unknown as StyleData;
}
const STYLES: Record<number, StyleData> = {
  0: styleData(none),
  1: styleData(thin()),
  2: styleData(thin()),
  3: styleData(thin("#ff0000")),
};

function readerOf(cells: Array<{ row: number; col: number; styleIndex: number; rowSpan?: number; colSpan?: number }>): EdgeReader & {
  reads: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
} {
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

describe("the loader reads every cell along an edge", () => {
  it("BUG-0365 A3 bordered at the bottom and B3 not: the bottom edge is MIXED", async () => {
    const edges = await outerEdgeSides(A1_B3, readerOf([{ row: 2, col: 0, styleIndex: 1 }]));
    expect(edges.borderBottom).toEqual(MIXED_SIDE);
    // The other edges draw nothing anywhere.
    expect(edges.borderTop).toEqual({ style: "none", color: "#000000" });
    expect(edges.borderLeft).toEqual({ style: "none", color: "#000000" });
  });

  it("the same line along the whole edge is that line, whatever style index carries it", async () => {
    const side = await edgeSide(A1_B3, "borderBottom", readerOf([
      { row: 2, col: 0, styleIndex: 1 },
      { row: 2, col: 1, styleIndex: 2 },
    ]));
    expect(side).toEqual({ style: "thin", color: "#000000" });
  });

  it("a different COLOUR is a different line", async () => {
    const side = await edgeSide(A1_B3, "borderBottom", readerOf([
      { row: 2, col: 0, styleIndex: 1 },
      { row: 2, col: 1, styleIndex: 3 },
    ]));
    expect(side.mixed).toBe(true);
  });

  it("a merged cell covers the positions of its span (they are not empty)", async () => {
    const side = await edgeSide(A1_B3, "borderBottom", readerOf([{ row: 2, col: 0, styleIndex: 1, colSpan: 2 }]));
    expect(side).toEqual({ style: "thin", color: "#000000" });
  });

  it("an edge longer than the read limit is judged by its two ends, never one corner alone", async () => {
    const tall = { startRow: 0, startCol: 0, endRow: EDGE_READ_LIMIT + 10, endCol: 0 };
    const reader = readerOf([{ row: 0, col: 0, styleIndex: 1 }]);
    // Left edge of a one-column strip: its ends are A1 (thin bottom, no left)
    // and the last row -- read through styleAt, not the strip.
    const left = await edgeSide(tall, "borderLeft", reader);
    expect(left).toEqual({ style: "none", color: "#000000" });
    expect(reader.reads).toEqual([]);
    // Ends that differ are MIXED.
    const ends = readerOf([{ row: 0, col: 0, styleIndex: 1 }]);
    const wide = { startRow: 0, startCol: 0, endRow: 0, endCol: EDGE_READ_LIMIT + 10 };
    expect((await edgeSide(wide, "borderBottom", ends)).mixed).toBe(true);
  });
});

describe("the plan never writes a MIXED edge the user left alone", () => {
  beforeEach(() => useFormatCellsStore.getState().reset());

  it("loaded mixed, untouched: no edge call", () => {
    useFormatCellsStore.getState().loadFromStyle({ borderBottom: { ...MIXED_SIDE } });
    useFormatCellsStore.getState().markBaseline();
    // Something else changes (bold), so OK has a plan to make.
    useFormatCellsStore.getState().setBold(true);
    const s = useFormatCellsStore.getState();
    const calls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, s.touched).calls;
    expect(calls.some((c) => c.kind === "format" && "borderBottom" in c.formatting)).toBe(false);
    // Even marked touched, a side that is STILL mixed is no line to write: it
    // would clear (style "none") every cell's own bottom line.
    const forced = new Set([...s.touched, "borderBottom" as const]);
    const forcedCalls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, forced).calls;
    expect(forcedCalls.some((c) => c.kind === "format" && "borderBottom" in c.formatting)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

describe("the Border tab shows a MIXED edge greyed, and a click draws the line", () => {
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

  it("BUG-0365 greyed (aria-pressed=mixed); one click draws the chosen line along the whole edge", async () => {
    const store = useFormatCellsStore.getState();
    store.setRangeShape({ multiRow: true, multiCol: true });
    store.loadFromStyle({ borderBottom: { ...MIXED_SIDE } });
    store.markBaseline();
    await act(async () => {
      root.render(React.createElement(BorderTab));
    });
    const bottom = container.querySelector<HTMLButtonElement>('[data-testid="fc-border-bottom"]')!;
    expect(bottom.getAttribute("aria-pressed")).toBe("mixed");
    await act(async () => {
      bottom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const s = useFormatCellsStore.getState();
    expect(s.borderBottom).toEqual({ style: "thin", color: "#000000" });
    const calls = planFormatCellsWrites(s.baseline, snapshotOf(s), A1_B3, false, s.touched).calls;
    expect(calls).toEqual([
      { kind: "format", rows: [2], cols: [0, 1], formatting: { borderBottom: { style: "thin", color: "#000000" } } },
    ]);
  });
});
