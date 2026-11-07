//! FILENAME: app/extensions/ConditionalFormatting/rendering/__tests__/iconPlacement.test.ts
// PURPOSE: BUG-0728 (icon part) -- where Excel puts an icon-set glyph: at the
//          left while the value shows; with Show Icon Only, by the cell's
//          horizontal alignment (centred under Center, right under Right, left
//          otherwise, the indent ignored).
// CONTEXT: [LIVE] Excel 16, 2026-11-06, lane uiforms probe2/probe3: PDF exports
//          of icon-only columns under General, Left, Right, Center, Fill,
//          Justify, Center Across Selection, Distributed and indented Left /
//          Right alignments, and of value-showing columns under Right and
//          Center. The ledger's "Excel centres the icon when the value is
//          hidden" held only for a CENTRED cell -- the round-A render lane's own
//          PDF shows a General icon-only cell's icon at the left too.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  drawn: [] as Array<{ x: number; y: number }>,
  results: new Map<string, unknown[]>(),
  align: new Map<string, "center" | "right">(),
  regions: [] as Array<{ type: string; startRow: number; startCol: number }>,
}));

vi.mock("../iconShapes", () => ({
  drawIcon: (_ctx: unknown, _set: unknown, _i: unknown, x: number, y: number) => h.drawn.push({ x, y }),
}));
vi.mock("../../lib/cfStore", () => ({
  getEvaluationForCell: (row: number, col: number) => h.results.get(`${row},${col}`) ?? null,
  getIconAlignForCell: (row: number, col: number) => h.align.get(`${row},${col}`),
}));
vi.mock("@api", () => ({
  // A grid of 80px columns and 20px rows behind a 50px row header and a 24px
  // column header.
  overlayGetColumnX: (_c: unknown, col: number) => 50 + col * 80,
  overlayGetRowY: (_c: unknown, row: number) => 24 + row * 20,
  overlayGetColumnWidth: () => 80,
  overlayGetRowHeight: () => 20,
  overlayGetRowHeaderWidth: () => 50,
  overlayGetColHeaderHeight: () => 24,
  getGridRegions: () => h.regions,
}));

import {
  iconPlacementFor,
  iconXIn,
  paintIconSetIcon,
  renderIconSets,
  ICON_SIZE,
  ICON_INSET_X,
} from "../iconSetRenderer";

const ctx = { save() {}, restore() {} } as unknown as CanvasRenderingContext2D;

beforeEach(() => {
  h.drawn.length = 0;
  h.results.clear();
  h.align.clear();
  h.regions.length = 0;
});

describe("iconPlacementFor: Excel's rule", () => {
  it.each([
    // [value hidden, alignment, placement]
    [true, "general", "left"],
    [true, "left", "left"],
    [true, "center", "center"],
    [true, "right", "right"],
    [true, undefined, "left"],
    [false, "center", "left"],
    [false, "right", "left"],
  ] as const)("hideValue=%s, %s -> %s", (hide, align, expected) => {
    expect(iconPlacementFor(hide, align)).toBe(expected);
  });
});

describe("paintIconSetIcon places the glyph across the box", () => {
  const box = { x: 100, y: 10, width: 80, height: 20 };

  it("left (the default), centred, right", () => {
    paintIconSetIcon(ctx, box, "threeArrows", 0);
    paintIconSetIcon(ctx, box, "threeArrows", 0, "center");
    paintIconSetIcon(ctx, box, "threeArrows", 0, "right");
    expect(h.drawn.map((d) => d.x)).toEqual([
      100 + ICON_INSET_X,
      100 + (80 - ICON_SIZE) / 2,
      100 + 80 - ICON_INSET_X - ICON_SIZE,
    ]);
    expect(iconXIn(box, "center")).toBe(133);
  });
});

describe("the grid overlay uses the cell's alignment for a Show Icon Only cell", () => {
  function region(row: number, col: number): void {
    h.regions.push({ type: "cf-icon-set", startRow: row, startCol: col });
  }
  const overlay = { ctx, canvasWidth: 2000, canvasHeight: 1000 } as never;

  it("centred and right-aligned icon-only cells; a value-showing centred cell keeps its icon at the left", () => {
    region(0, 1); // B1: icon only, centred
    region(1, 1); // B2: icon only, right
    region(2, 1); // B3: value shown, centred
    region(3, 1); // B4: icon only, General
    h.results.set("0,1", [{ iconIndex: 0, iconSet: "threeArrows", hideValue: true }]);
    h.results.set("1,1", [{ iconIndex: 0, iconSet: "threeArrows", hideValue: true }]);
    h.results.set("2,1", [{ iconIndex: 0, iconSet: "threeArrows" }]);
    h.results.set("3,1", [{ iconIndex: 0, iconSet: "threeArrows", hideValue: true }]);
    h.align.set("0,1", "center");
    h.align.set("1,1", "right");
    h.align.set("2,1", "center");
    renderIconSets(overlay);
    const cellX = 50 + 80;
    expect(h.drawn.map((d) => d.x)).toEqual([
      cellX + (80 - ICON_SIZE) / 2,
      cellX + 80 - ICON_INSET_X - ICON_SIZE,
      cellX + ICON_INSET_X,
      cellX + ICON_INSET_X,
    ]);
  });
});
