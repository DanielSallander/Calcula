//! FILENAME: app/src/core/lib/gridRenderer/rendering/styledCellBox.test.ts
// PURPOSE: `paintStyledCellBox` paints one formatted cell into a box: fill,
//          font, alignment, wrap, indent, rotation, accounting runs, borders --
//          and it paints them the SAME way the grid's own `drawCellText` does.
// CONTEXT: The primitive a floating grid paints its cells with (P3 S7/S8). The
//          parity block at the bottom renders a fixture cell through the real
//          `renderGrid` and through `paintStyledCellBox` and compares the fill
//          colour, the font and the text x: the guard against the two painters
//          drifting apart.

import { describe, it, expect } from "vitest";

import { paintStyledCellBox, effectiveCellStyle, type CellBox } from "./styledCellBox";
import { borderLineWidth } from "./cells";
import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import { INDENT_PX_PER_LEVEL } from "../layout/cellIndent";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  cellKey,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type StyleData,
  type StyleDataMap,
  type Viewport,
} from "../../../types";

// ---------------------------------------------------------------------------
// A recording 2D context: one ordered op list, with the paint state in force.
// measureText is 6px per character, so every expected x is derivable by hand.
// ---------------------------------------------------------------------------

interface Op {
  op: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
}

const CHAR_W = 6;

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const api: Record<string, unknown> = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "miter",
    canvas: { width: 600, height: 200 },
  };
  const rec = (op: string) => (...args: unknown[]) => {
    ops.push({
      op,
      args,
      fillStyle: String(api.fillStyle),
      strokeStyle: String(api.strokeStyle),
      lineWidth: Number(api.lineWidth),
      font: String(api.font),
    });
  };
  for (const name of [
    "save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "rect", "arc", "clip",
    "fill", "stroke", "fillRect", "strokeRect", "clearRect", "fillText", "strokeText",
    "setLineDash", "translate", "rotate", "scale",
  ]) {
    api[name] = rec(name);
  }
  api.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  api.getLineDash = () => [];
  api.measureText = (text: string) => ({ width: String(text).length * CHAR_W });
  api.createLinearGradient = () => ({ addColorStop() {} });
  api.createPattern = () => null;
  return { ctx: api as unknown as CanvasRenderingContext2D, ops };
}

const BOX: CellBox = { x: 100, y: 50, width: 120, height: 20 };
const PAD_X = 3;

function style(over: Partial<StyleData> = {}): StyleData {
  return { ...DEFAULT_STYLE, ...over };
}

function cell(display: string, over: Partial<CellData> = {}): CellData {
  return { row: 0, col: 0, display, formula: null, styleIndex: 1, ...over } as CellData;
}

function paint(
  display: string,
  st: Partial<StyleData>,
  extra: Partial<Parameters<typeof paintStyledCellBox>[2]> = {},
  box: CellBox = BOX,
  cellOver: Partial<CellData> = {},
): Op[] {
  const { ctx, ops } = makeRecordingCtx();
  paintStyledCellBox(ctx, box, {
    cell: cell(display, cellOver),
    style: style(st),
    valueKind: "text",
    ...extra,
  });
  return ops;
}

const texts = (ops: Op[]) => ops.filter((o) => o.op === "fillText");

// ---------------------------------------------------------------------------

describe("paintStyledCellBox", () => {
  it("fills the box with the cell's background colour", () => {
    const ops = paint("", { backgroundColor: "#FFFF00" });
    const fill = ops.find((o) => o.op === "fillRect");
    expect(fill).toBeDefined();
    expect(fill!.fillStyle).toBe("#FFFF00");
    expect(fill!.args).toEqual([BOX.x, BOX.y, BOX.width, BOX.height]);
  });

  it("paints no fill for the default white background", () => {
    const ops = paint("x", {});
    expect(ops.filter((o) => o.op === "fillRect")).toHaveLength(0);
  });

  it("a conditional fill overrides the static one", () => {
    const ops = paint("x", { backgroundColor: "#FFFF00" }, { conditional: { backgroundColor: "#FFC7CE" } });
    const fills = ops.filter((o) => o.op === "fillRect");
    expect(fills).toHaveLength(1);
    expect(fills[0].fillStyle).toBe("#FFC7CE");
  });

  it("builds a bold font string", () => {
    const [t] = texts(paint("Hello", { bold: true }));
    expect(t.font).toMatch(/^normal bold /);
    expect(t.font).toContain("Calibri");
  });

  it("centre-aligns the text inside the padded box", () => {
    const [t] = texts(paint("Hello", { textAlign: "center" }));
    const inner = BOX.width - PAD_X * 2;
    const w = "Hello".length * CHAR_W;
    expect(t.args[1]).toBeCloseTo(BOX.x + PAD_X + (inner - w) / 2, 6);
  });

  it("right-aligns a General NUMBER and left-aligns General text", () => {
    const [num] = texts(paint("1234", {}, { valueKind: "number" }));
    expect(num.args[1]).toBeCloseTo(BOX.x + BOX.width - PAD_X - 4 * CHAR_W, 6);
    const [txt] = texts(paint("1234", {}, { valueKind: "text" }));
    expect(txt.args[1]).toBeCloseTo(BOX.x + PAD_X, 6);
  });

  it("breaks wrapped text into lines, one below the other", () => {
    const narrow: CellBox = { x: 0, y: 0, width: 50, height: 80 };
    const lines = texts(paint("aaaa bbbb cccc", { wrapText: true }, {}, narrow));
    // The shared wrapper keeps a line's trailing space (layout/autoFit.ts).
    expect(lines.map((o) => String(o.args[0]).trimEnd())).toEqual(["aaaa", "bbbb", "cccc"]);
    const ys = lines.map((o) => o.args[2] as number);
    expect(ys[1]).toBeGreaterThan(ys[0]);
    expect(ys[2]).toBeGreaterThan(ys[1]);
  });

  it("offsets an indented value by the indent", () => {
    const [t] = texts(paint("Hi", { textAlign: "left", indent: 2 }));
    expect(t.args[1]).toBeCloseTo(BOX.x + PAD_X + 2 * INDENT_PX_PER_LEVEL, 6);
  });

  it("paints rotated text through a rotated path", () => {
    const ops = paint("Up", { textRotation: "rotate90" });
    const rotate = ops.find((o) => o.op === "rotate");
    expect(rotate).toBeDefined();
    expect(rotate!.args[0]).toBeCloseTo(-Math.PI / 2, 6);
    expect(ops.some((o) => o.op === "translate")).toBe(true);
    expect(texts(ops)).toHaveLength(1);
  });

  it("splits an accounting value into a symbol run and a value run", () => {
    const ops = paint("$ 12.00 ", {}, { valueKind: "number" }, BOX, {
      accountingLayout: { symbol: "$", symbolBefore: true, value: "12.00 " },
    });
    const runs = texts(ops);
    expect(runs.map((o) => o.args[0])).toEqual(["$", "12.00 "]);
    // The symbol hugs the left edge; the value hugs the right edge.
    expect(runs[0].args[1]).toBeCloseTo(BOX.x + PAD_X, 6);
    expect(runs[1].args[1]).toBeCloseTo(BOX.x + BOX.width - PAD_X - "12.00 ".length * CHAR_W, 6);
  });

  it("strokes an edge border at the weight borderLineWidth gives its style", () => {
    const ops = paint("", { borderBottom: { style: "medium", color: "#FF0000", width: 2 } });
    const strokes = ops.filter((o) => o.op === "stroke" && o.strokeStyle === "#FF0000");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].lineWidth).toBe(borderLineWidth("medium"));
    expect(strokes[0].lineWidth).toBe(2);
  });

  it("skips the edge borders when the caller paints them in a second pass", () => {
    const ops = paint("", { borderBottom: { style: "thin", color: "#FF0000", width: 1 } }, { edgeBorders: false });
    expect(ops.some((o) => o.op === "stroke" && o.strokeStyle === "#FF0000")).toBe(false);
  });

  it("paints nothing for an empty box", () => {
    const ops = paint("x", { backgroundColor: "#FFFF00" }, {}, { x: 0, y: 0, width: 0, height: 20 });
    expect(ops).toHaveLength(0);
  });

  it("an absent conditional key never blanks the static value", () => {
    const eff = effectiveCellStyle(style({ bold: true, textColor: "#123456" }), { italic: true });
    expect(eff.bold).toBe(true);
    expect(eff.italic).toBe(true);
    expect(eff.textColor).toBe("#123456");
  });
});

// ---------------------------------------------------------------------------
// PARITY with the grid painter: the same fixture cell through renderGrid and
// through paintStyledCellBox gives the same fill colour, font and text x.
// ---------------------------------------------------------------------------

describe("paintStyledCellBox / drawCellText parity", () => {
  const ROW = 1;
  const COL = 1;
  const CELL_W = DEFAULT_GRID_CONFIG.defaultCellWidth;
  const CELL_H = DEFAULT_GRID_CONFIG.defaultCellHeight;
  const CELL_BOX: CellBox = {
    x: DEFAULT_GRID_CONFIG.rowHeaderWidth + CELL_W * COL,
    y: DEFAULT_GRID_CONFIG.colHeaderHeight + CELL_H * ROW,
    width: CELL_W,
    height: CELL_H,
  };
  const FIXTURE: StyleData = style({
    bold: true,
    italic: true,
    backgroundColor: "#FFFF00",
    textColor: "#C00000",
    textAlign: "center",
    fontSize: 12,
  });
  const DISPLAY = "Total";

  function gridOps(fixture: StyleData = FIXTURE): Op[] {
    const config: GridConfig = { ...DEFAULT_GRID_CONFIG, totalRows: 50, totalCols: 12 };
    const styleCache: StyleDataMap = new Map();
    styleCache.set(0, DEFAULT_STYLE);
    styleCache.set(1, fixture);
    const cells: CellDataMap = new Map();
    cells.set(cellKey(ROW, COL), { row: ROW, col: COL, display: DISPLAY, formula: null, styleIndex: 1 } as CellData);
    const viewport: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 6, colCount: 6 };
    const { ctx, ops } = makeRecordingCtx();
    renderGrid(
      ctx, 600, 200, config, viewport, null, null, cells, DEFAULT_THEME, [],
      { columnWidths: new Map(), rowHeights: new Map() }, styleCache,
    );
    return ops;
  }

  function boxOps(fixture: StyleData = FIXTURE): Op[] {
    const { ctx, ops } = makeRecordingCtx();
    paintStyledCellBox(ctx, CELL_BOX, {
      cell: { display: DISPLAY },
      style: fixture,
      valueKind: "text",
    });
    return ops;
  }

  it("the same fill colour over the same rectangle", () => {
    const gridFill = gridOps().find((o) => o.op === "fillRect" && o.fillStyle === "#FFFF00");
    const boxFill = boxOps().find((o) => o.op === "fillRect");
    expect(gridFill).toBeDefined();
    expect(boxFill).toBeDefined();
    expect(boxFill!.fillStyle).toBe(gridFill!.fillStyle);
    expect(boxFill!.args).toEqual(gridFill!.args);
  });

  // Centre alone cannot see a padding drift (it is symmetric), so the left,
  // right and indented placements are pinned too.
  it.each([
    ["center", 0],
    ["left", 0],
    ["right", 0],
    ["left", 1],
  ] as const)("the same font, ink and text x (%s, indent %i)", (textAlign, indent) => {
    const fixture = { ...FIXTURE, textAlign, indent };
    const gridText = gridOps(fixture).find((o) => o.op === "fillText" && o.args[0] === DISPLAY);
    const boxText = boxOps(fixture).find((o) => o.op === "fillText" && o.args[0] === DISPLAY);
    expect(gridText).toBeDefined();
    expect(boxText).toBeDefined();
    expect(boxText!.font).toBe(gridText!.font);
    expect(boxText!.fillStyle).toBe(gridText!.fillStyle);
    expect(boxText!.args[1]).toBeCloseTo(gridText!.args[1] as number, 6);
    expect(boxText!.args[2]).toBeCloseTo(gridText!.args[2] as number, 6);
  });
});
