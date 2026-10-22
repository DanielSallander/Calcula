// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackPainters.test.ts
// PURPOSE: The writeback grid painters (owner's design, 2026-10-22, and its
//          review round the same day):
//          - the REGION FRAME is a hairline drawn with Core's own gridline
//            geometry (1 device pixel, device-pixel snapped -- the ordinary grid
//            and every frozen pane) ON the region's boundary gridlines, in the
//            Writeback tab's accent at ~35%, no device pixel painted twice,
//            broken by an 8px edit icon (~85%, a whole-device-pixel stroke) on
//            the TOP and BOTTOM edges only, at the centre of the MIDDLE VISIBLE
//            column -- never on the sides, where it touched the middle row's
//            value, and never where the header or the canvas edge would cut it;
//          - the STATE MARKER is a solid red right triangle in the cell's
//            top-left corner (legs 7, the danger tone) for an unsent or a
//            rejected value, painted UNDER ErrorChecking's green 5px triangle
//            with a band of solid red left between them;
//          - a REJECTED value's text is drawn in a danger ink that reads on the
//            cell's fill (a style interceptor: text colour only), registered
//            only while subscribed regions exist.

import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  markerKindFor,
  markerTriangle,
  paintWritebackMarker,
  createWritebackDecoration,
  createWritebackRejectedTextInterceptor,
  createWritebackCellPainters,
  isInvisibleTextColor,
  rejectedTextInk,
  MARKER_TRIANGLE_SIZE,
  WRITEBACK_MARKER_ANCHOR,
  WRITEBACK_MARKER_ID,
  WRITEBACK_MARKER_PRIORITY,
  WRITEBACK_REJECTED_TEXT_ID,
  WRITEBACK_REJECTED_TEXT_PRIORITY,
  type WritebackRejectedTextDeps,
} from "../writebackDecorations";
import {
  createWritebackOutlinePainter,
  drawEditIcon,
  iconStrokeWidth,
  middleVisibleLine,
  writebackFrameColors,
  FRAME_ACCENT_TOKEN,
  FRAME_ICON_ALPHA,
  FRAME_ICON_MIN_CELL,
  FRAME_ICON_PAD,
  FRAME_ICON_SIZE,
  FRAME_LINE_ALPHA,
  type OutlineRegion,
  type RangeRectOf,
} from "../writebackOutline";
import { WRITEBACK_ACCENT_TOKEN } from "../writebackIds";
import type { WritebackCellState } from "../writebackStore";
import { gridlineGeometry, type GridLayerContext, type RangeCanvasRect } from "@api/gridLayers";
import type { CellDecorationContext } from "@api/cellDecorations";
import { getActiveSkin, getBaselineToneColors, getCanvasThemeColor, getSkinTokens } from "@api/appearance";
import { isExplicitCellFill } from "@api/cellPaint";
import {
  applyStyleInterceptors,
  getStyleInterceptors,
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  type BaseStyleInfo,
} from "@api/styleInterceptors";

// ============================================================================
// Doubles
// ============================================================================

interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  globalAlpha: unknown;
  lineWidth: unknown;
  lineCap: unknown;
}

/** The copy marquee's leftover dash state, so "the frame is solid" can fail. */
const LEFTOVER_DASH = [4, 4];

/**
 * A recording 2D context: every path/paint call with the state it was made in.
 * `scale` doubles getTransform() the way GridCanvas sets it (dpr * zoom); without
 * it the context has no getTransform at all (scale 1, as Core reads it). It
 * starts DASHED, as a context the copy marquee painted last would be.
 */
function recorder(scale?: number) {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: "butt",
    lineJoin: "miter",
    _dash: [...LEFTOVER_DASH] as number[],
  };
  const rec = (op: string) => (...args: unknown[]) =>
    calls.push({
      op,
      args,
      fillStyle: ctx.fillStyle,
      strokeStyle: ctx.strokeStyle,
      globalAlpha: ctx.globalAlpha,
      lineWidth: ctx.lineWidth,
      lineCap: ctx.lineCap,
    });
  for (const op of [
    "save", "restore", "beginPath", "closePath", "arc", "fill", "stroke", "fillRect", "moveTo", "lineTo",
    "fillText", "rect", "clip",
  ]) {
    ctx[op] = rec(op);
  }
  ctx.measureText = () => ({ width: 6 });
  ctx.setLineDash = (d: number[]) => {
    ctx._dash = d;
  };
  if (scale !== undefined) {
    ctx.getTransform = () => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D & { _dash: number[] }, calls };
}

/** Core's gridline snap, written out independently of the module under test (grid.ts gridlineGeometry). */
const coreSnap = (v: number, s: number): number => (Math.round(v * s) + 0.5) / s;

/** The column header's bottom edge in the default sheet: the view starts below it. */
const HEADER = 20;

/**
 * A sheet's geometry and a rangeToCanvasRect double over it: rows/columns of the
 * given sizes from (x0, y0), clipped to `view` with the clipped* flags set the
 * way Core's rangeRect.ts sets them (no frozen panes). Size 0 = hidden. The
 * view's top-left is the cell area's origin (below the column header).
 */
function sheet(opts: {
  rowHeight?: (r: number) => number;
  colWidth?: (c: number) => number;
  x0?: number;
  y0?: number;
  view?: { left: number; top: number; right: number; bottom: number };
}) {
  const rowHeight = opts.rowHeight ?? (() => 20);
  const colWidth = opts.colWidth ?? (() => 100);
  const x0 = opts.x0 ?? 0;
  const y0 = opts.y0 ?? HEADER;
  const view = opts.view ?? { left: 0, top: HEADER, right: 800, bottom: 600 };
  const colX = (c: number) => {
    let x = x0;
    for (let i = 0; i < c; i++) x += colWidth(i);
    return x;
  };
  const rowY = (r: number) => {
    let y = y0;
    for (let i = 0; i < r; i++) y += rowHeight(i);
    return y;
  };
  const calls: number[][] = [];
  const rectOf: RangeRectOf = (_context, startRow, startCol, endRow, endCol) => {
    calls.push([startRow, startCol, endRow, endCol]);
    const rx1 = colX(Math.min(startCol, endCol));
    const rx2 = colX(Math.max(startCol, endCol) + 1);
    const ry1 = rowY(Math.min(startRow, endRow));
    const ry2 = rowY(Math.max(startRow, endRow) + 1);
    const lx = Math.max(rx1, view.left);
    const hx = Math.min(rx2, view.right);
    const ly = Math.max(ry1, view.top);
    const hy = Math.min(ry2, view.bottom);
    if (!(lx < hx) || !(ly < hy)) return null;
    return {
      x: lx,
      y: ly,
      width: hx - lx,
      height: hy - ly,
      clippedLeft: rx1 < view.left,
      clippedTop: ry1 < view.top,
      clippedRight: rx2 > view.right,
      clippedBottom: ry2 > view.bottom,
    };
  };
  return { rectOf, calls, colX, rowY, view };
}

function layerContext(ctx: CanvasRenderingContext2D, canvasHeight = 600): GridLayerContext {
  return { ctx, canvasWidth: 800, canvasHeight } as unknown as GridLayerContext;
}

const ACCENT = { accent: "ACCENT" };
const colors = () => ACCENT;

/** B3:B5 on a sheet of 100px columns and 20px rows: x 100..200, y 60..120. */
const B3_B5: OutlineRegion = { rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 };

/** Paint `regions` at device scale `scale` over `geo`, with the REAL Core gridline geometry. */
function paint(regions: OutlineRegion[], scale?: number, geo = sheet({}), canvasHeight = 600) {
  const { ctx, calls } = recorder(scale);
  createWritebackOutlinePainter({
    regions: () => regions,
    colors,
    rectOf: geo.rectOf,
    gridline: gridlineGeometry,
    cellArea: () => ({ x: geo.view.left, y: geo.view.top }),
  })(layerContext(ctx, canvasHeight));
  return { ctx, calls, geo };
}

/** The frame line's straight pieces: the moveTo/lineTo pairs before its stroke. */
function linePieces(calls: Call[]): Array<{ from: number[]; to: number[] }> {
  const end = calls.findIndex((c) => c.op === "stroke");
  const out: Array<{ from: number[]; to: number[] }> = [];
  for (let i = 0; i < end; i++) {
    if (calls[i].op === "moveTo" && calls[i + 1]?.op === "lineTo") {
      out.push({ from: calls[i].args as number[], to: calls[i + 1].args as number[] });
    }
  }
  return out;
}

/** Every icon's path points, one array per icon, in drawing order. */
function iconPaths(calls: Call[]): number[][][] {
  const lineStroke = calls.findIndex((c) => c.op === "stroke");
  const out: number[][][] = [];
  let current: number[][] | null = null;
  for (let i = lineStroke + 1; i < calls.length; i++) {
    const c = calls[i];
    if (c.op === "beginPath") current = [];
    else if ((c.op === "moveTo" || c.op === "lineTo") && current) current.push(c.args as number[]);
    else if (c.op === "stroke" && current) {
      out.push(current);
      current = null;
    }
  }
  return out;
}

/**
 * The centre of every icon painted, recovered from its first point (11, 4) on
 * the 24-unit grid. The glyph's vertices are aligned to device pixels, which
 * moves them by less than a pixel, so a centre is known to within ONE pixel --
 * every placement these tests tell apart is 10px or more.
 */
function iconCentres(calls: Call[]): Array<[number, number]> {
  const k = FRAME_ICON_SIZE / 24;
  return iconPaths(calls).map((points) => {
    const [x, y] = points[0];
    return [x - (11 - 12) * k, y - (4 - 12) * k] as [number, number];
  });
}

/** Within one pixel (see iconCentres). */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;

function expectCentres(actual: Array<[number, number]>, expected: Array<[number, number]>): void {
  expect(actual.length, JSON.stringify(actual)).toBe(expected.length);
  actual.forEach(([x, y], i) => {
    expect(near(x, expected[i][0]), `icon ${i} x ${x} vs ${expected[i][0]}`).toBe(true);
    expect(near(y, expected[i][1]), `icon ${i} y ${y} vs ${expected[i][1]}`).toBe(true);
  });
}

/**
 * The DEVICE pixels each straight piece of a 1-device-pixel hairline covers
 * ("col,row" -> how many pieces cover it). A piece runs along a device pixel
 * row (or column) centre from one pixel EDGE to another, so it covers exactly
 * the pixels between its ends.
 */
function devicePixelCover(pieces: Array<{ from: number[]; to: number[] }>, scale: number): Map<string, number> {
  const cover = new Map<string, number>();
  const add = (x: number, y: number) => cover.set(`${x},${y}`, (cover.get(`${x},${y}`) ?? 0) + 1);
  for (const { from, to } of pieces) {
    const [x1, y1] = from.map((v) => v * scale);
    const [x2, y2] = to.map((v) => v * scale);
    if (y1 === y2) {
      const row = Math.floor(y1);
      for (let x = Math.round(Math.min(x1, x2)); x < Math.round(Math.max(x1, x2)); x++) add(x, row);
    } else {
      const col = Math.floor(x1);
      for (let y = Math.round(Math.min(y1, y2)); y < Math.round(Math.max(y1, y2)); y++) add(col, y);
    }
  }
  return cover;
}

const APP = path.resolve(__dirname, "../../../..");
const readSource = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

/** The body of `function <name>(` in `src`, up to the next top-level function. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\nexport function ${name}\\(|\\nfunction ${name}\\(`));
  expect(start, `${name} is gone`).toBeGreaterThanOrEqual(0);
  const next = src.slice(start + 1).search(/\n(?:export )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// ============================================================================
// The region frame: the line
// ============================================================================

describe("region frame: a hairline ON the boundary gridlines, with Core's own geometry", () => {
  it("both Core gridline painters -- the ordinary grid and every frozen or split pane -- use the geometry the frame uses", () => {
    // The frame lands on the gridline only while Core draws gridlines with the
    // function the frame is given (@api/gridLayers gridlineGeometry). The pane
    // painter once stroked 1 CSS px at Math.floor(v) + 0.5: with any freeze the
    // frame sat BESIDE the gridline again. Behaviour: frozenPaneGridlines.test.ts.
    const grid = functionBody(readSource("src/core/lib/gridRenderer/rendering/grid.ts"), "drawGridLines");
    const zone = functionBody(readSource("src/core/lib/gridRenderer/core.ts"), "drawGridLinesZone");
    for (const body of [grid, zone]) {
      expect(body).toContain("gridlineGeometry(ctx)");
      expect(body).not.toMatch(/Math\.floor\([xy]\) \+ 0\.5/);
      expect(body).not.toMatch(/ctx\.lineWidth = 1;/);
    }
    // ...and the extension is wired to that very function.
    const index = readSource("extensions/Collaboration/index.ts");
    expect(index).toContain("gridline: gridlineGeometry,");
    expect(index).toContain("cellArea: cellAreaOrigin,");
  });

  for (const scale of [1, 1.25, 2]) {
    it(`at device scale ${scale}: one device pixel wide, on the gridline of every boundary`, () => {
      const { calls } = paint([B3_B5], scale);
      const stroke = calls.find((c) => c.op === "stroke")!;
      expect(stroke.lineWidth).toBe(1 / scale);
      expect(stroke.lineCap).toBe("butt");

      const pieces = linePieces(calls);
      const verticalXs = new Set(pieces.filter((p) => p.from[0] === p.to[0]).map((p) => p.from[0]));
      const horizontalYs = new Set(pieces.filter((p) => p.from[1] === p.to[1]).map((p) => p.from[1]));
      // Left: column B's own gridline. Right: column C's (the boundary at 200),
      // not a line inside the region beside it.
      expect([...verticalXs].sort((a, b) => a - b)).toEqual([coreSnap(100, scale), coreSnap(200, scale)]);
      expect([...horizontalYs].sort((a, b) => a - b)).toEqual([coreSnap(60, scale), coreSnap(120, scale)]);
    });
  }

  it("at device scale 2 it is no longer the 2-device-pixel line half a pixel inside the region", () => {
    const { calls } = paint([B3_B5], 2);
    const xs = linePieces(calls).filter((p) => p.from[0] === p.to[0]).map((p) => p.from[0]);
    expect(xs).not.toContain(100.5);
    expect(xs).not.toContain(199.5);
    expect(calls.find((c) => c.op === "stroke")!.lineWidth).not.toBe(1);
  });

  // Chromium strokes a 1-device-pixel line as a hairline, segment by segment,
  // so a pixel two pieces cover is blended twice: a darker dot at every corner
  // (measured 5.35:1 against 3.27:1 along the edges, 2026-10-22).
  // SABOTAGE: run the vertical pieces past the corners too -- four pixels are
  // covered twice.
  for (const scale of [1, 1.25, 2]) {
    it(`at device scale ${scale}: every device pixel of the frame is covered exactly once, corners included`, () => {
      const { calls } = paint([B3_B5], scale);
      const cover = devicePixelCover(linePieces(calls), scale);
      const twice = [...cover].filter(([, n]) => n > 1).map(([p]) => p);
      expect(twice, `pixels painted twice: ${twice.join(" ")}`).toEqual([]);
      const px = (v: number) => Math.floor(coreSnap(v, scale) * scale);
      for (const [x, y] of [[100, 60], [200, 60], [100, 120], [200, 120]]) {
        expect(cover.get(`${px(x)},${px(y)}`), `corner ${x},${y}`).toBe(1);
      }
    });
  }

  it("an edge cut by the viewport leaves no gap where the region continues", () => {
    // Rows 0..19 with everything above y 220 under the header: the top edge is
    // not drawn, and the sides start AT the cut, not half a pixel below it.
    const geo = sheet({ view: { left: 0, top: 220, right: 800, bottom: 600 } });
    const { calls } = paint([{ rowStart: 0, rowEnd: 19, colStart: 1, colEnd: 1 }], 1, geo);
    const left = linePieces(calls).filter((p) => p.from[0] === coreSnap(100, 1));
    expect(Math.min(...left.map((p) => Math.min(p.from[1], p.to[1])))).toBe(220);
    const cover = devicePixelCover(linePieces(calls), 1);
    expect([...cover.values()].every((n) => n === 1)).toBe(true);
  });

  // SABOTAGE: drop `context.ctx.setLineDash([])` -- the leftover dash stays.
  it("is solid -- never the copy marquee's dashes -- and all four edges are ONE stroke", () => {
    const { ctx, calls } = paint([B3_B5]);
    expect((ctx as unknown as { _dash: number[] })._dash).toEqual([]);
    const lineStroke = calls.findIndex((c) => c.op === "stroke");
    expect(calls.slice(0, lineStroke).filter((c) => c.op === "beginPath").length).toBe(1);
    // Top and bottom broken once each around their icon; the sides whole.
    expect(linePieces(calls).length).toBe(6);
  });
});

describe("region frame: colour", () => {
  it("is read through the theme accessor, from the Writeback tab's OWN accent token", () => {
    expect(FRAME_ACCENT_TOKEN).toBe(WRITEBACK_ACCENT_TOKEN);
    expect(WRITEBACK_ACCENT_TOKEN).toBe("--tab-accent-writeback");
    const read = vi.fn(() => "SPY");
    expect(writebackFrameColors(read)).toEqual({ accent: "SPY" });
    expect(read).toHaveBeenCalledWith("--tab-accent-writeback");
    // Through the real accessor: the active skin's value of that token, a
    // concrete colour the canvas can parse.
    const real = writebackFrameColors(getCanvasThemeColor).accent;
    expect(real).toBe(getSkinTokens(getActiveSkin())["--tab-accent-writeback"]);
    expect(real).not.toContain("var(");
    expect(real).not.toBe("");
  });

  // The tab's colour and the frame's tint are ONE token: changing the tab's
  // must move the frame with it. SABOTAGE: write the token out in manifest.ts.
  it("the Writeback tab's colour is built from the same constant", () => {
    const manifest = readSource("extensions/Collaboration/manifest.ts");
    expect(manifest).toContain("export const WRITEBACK_TAB_COLOR = `var(${WRITEBACK_ACCENT_TOKEN}, #4338ca)`;");
    expect(manifest).not.toContain('"var(--tab-accent-writeback');
  });

  it("strokes the line in the accent at about 35% and the icons in the accent at about 85%", () => {
    // 55% measured 3.3:1 on white at 100% scaling -- the contrast of the line
    // the owner called "too sharp and noticeable"; 35% is about 2.3:1.
    expect(FRAME_LINE_ALPHA).toBeGreaterThanOrEqual(0.3);
    expect(FRAME_LINE_ALPHA).toBeLessThanOrEqual(0.4);
    expect(FRAME_ICON_ALPHA).toBeGreaterThanOrEqual(0.8);
    expect(FRAME_ICON_ALPHA).toBeLessThanOrEqual(0.9);
    const { calls } = paint([B3_B5]);
    const strokes = calls.filter((c) => c.op === "stroke");
    expect(strokes[0].strokeStyle).toBe("ACCENT");
    expect(strokes[0].globalAlpha).toBe(FRAME_LINE_ALPHA);
    const icons = strokes.slice(1);
    expect(icons.length).toBe(2);
    expect(icons.every((c) => c.strokeStyle === "ACCENT" && c.globalAlpha === FRAME_ICON_ALPHA)).toBe(true);
  });

  it("reads the colours once per frame, not per region", () => {
    const { ctx } = recorder();
    const read = vi.fn(colors);
    const geo = sheet({});
    createWritebackOutlinePainter({
      regions: () => [B3_B5, { rowStart: 8, rowEnd: 9, colStart: 3, colEnd: 3 }],
      colors: read,
      rectOf: geo.rectOf,
      gridline: gridlineGeometry,
      cellArea: () => ({ x: 0, y: HEADER }),
    })(layerContext(ctx));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The region frame: the edit icon
// ============================================================================

describe("region frame: the edit icon", () => {
  // Rounded DOWN: at 150% and 175% a 2-device-pixel stroke filled the 8px pen in.
  // SABOTAGE: Math.round -- 150% and 175% get 2 device pixels.
  it("is 8px, its stroke one CSS px rounded DOWN to a WHOLE number of device pixels", () => {
    expect(FRAME_ICON_SIZE).toBe(8);
    for (const [scale, devicePx] of [[0.75, 1], [1, 1], [1.1, 1], [1.25, 1], [1.5, 1], [1.75, 1], [2, 2], [2.5, 2], [3, 3]] as const) {
      expect(iconStrokeWidth(scale) * scale, `scale ${scale}`).toBeCloseTo(devicePx, 9);
      const { calls } = paint([B3_B5], scale);
      const icons = calls.filter((c) => c.op === "stroke").slice(1);
      expect(icons.length).toBe(2);
      expect(icons.every((c) => c.lineWidth === iconStrokeWidth(scale)), `scale ${scale}`).toBe(true);
    }
  });

  it("drawEditIcon stays inside its 8px box", () => {
    for (const scale of [undefined, 1, 1.25, 1.5, 2]) {
      const { ctx, calls } = recorder(scale);
      ctx.lineWidth = iconStrokeWidth(scale ?? 1);
      drawEditIcon(ctx, 50.3, 49.8);
      const pts = calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").map((c) => c.args as number[]);
      expect(pts.length).toBe(11);
      for (const [x, y] of pts) {
        expect(Math.abs(x - 50.3)).toBeLessThanOrEqual(FRAME_ICON_SIZE / 2);
        expect(Math.abs(y - 49.8)).toBeLessThanOrEqual(FRAME_ICON_SIZE / 2);
      }
      expect(calls.filter((c) => c.op === "stroke").length).toBe(1);
    }
  });

  // At 125%, 150% and 175% a 1-CSS-px stroke is 1.25-1.75 device pixels, and
  // no position makes it crisp: the 8px glyph rendered as a soft blob there.
  // SABOTAGE: draw the icons at lineWidth FRAME_ICON_STROKE -- the fractional
  // scales lose their alignment.
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
    it(`at device scale ${scale}: every vertex of every icon is aligned to the device pixels`, () => {
      const deviceStroke = Math.round(iconStrokeWidth(scale) * scale);
      // Odd device stroke: on a pixel CENTRE (k + 0.5); even: on a pixel EDGE.
      const offset = deviceStroke % 2 === 1 ? 0.5 : 0;
      const { calls } = paint([B3_B5], scale);
      const points = iconPaths(calls).flat();
      expect(points.length).toBe(22);
      for (const v of points.flat()) {
        const device = v * scale - offset;
        expect(Math.abs(device - Math.round(device)), `${v} at scale ${scale}`).toBeLessThan(1e-6);
      }
    });
  }

  it("every icon on a frame has the same shape, wherever it lands", () => {
    for (const scale of [1, 1.25, 2]) {
      const { calls } = paint([B3_B5, { rowStart: 8, rowEnd: 12, colStart: 3, colEnd: 5 }], scale);
      // After the first region's line come its icons, then the second region's
      // line (not an icon: it is not the glyph's 11 points) and its icons.
      const icons = iconPaths(calls).filter((points) => points.length === 11);
      const shapes = icons.map((points) => {
        const [x0, y0] = points[0];
        return points.map(([x, y]) => [Math.round((x - x0) * 1e6) / 1e6, Math.round((y - y0) * 1e6) / 1e6]);
      });
      expect(shapes.length).toBe(4);
      for (const s of shapes) expect(s).toEqual(shapes[0]);
    }
  });

  // The owner (2026-10-22): the side icons were "a bit too intrusive on the
  // cell". A side icon centred on the edge reaches 3px into the edge cell --
  // exactly where Core's 3px text inset ends a right-aligned number -- so it
  // touched the middle row's value (measured: zero pixels between the 0 of 850
  // and the icon), and a one-row region was boxed in by four icons.
  // SABOTAGE: put the side icons back -- four icons, two on the side edges.
  it("icons sit on the top and bottom edges only, at the middle column's centre -- never on a side", () => {
    const { calls } = paint([B3_B5]);
    // One column, B, x 100..200: centre 150.
    expectCentres(iconCentres(calls), [
      [150, coreSnap(60, 1)],
      [150, coreSnap(120, 1)],
    ]);
    // The side edges are whole lines, not broken around an icon.
    const sides = linePieces(calls).filter((p) => p.from[0] === p.to[0]);
    expect(sides.length).toBe(2);
    // No icon point comes within the side cells' text inset (3px) plus 2px.
    for (const [x] of iconPaths(calls).flat()) {
      expect(x).toBeGreaterThan(100 + 3 + 2);
      expect(x).toBeLessThan(200 - 3 - 2);
    }
  });

  it("a single writeback cell: one icon above it and one below, none beside its value", () => {
    const { calls } = paint([{ rowStart: 2, rowEnd: 2, colStart: 1, colEnd: 1 }]);
    expectCentres(iconCentres(calls), [
      [150, coreSnap(60, 1)],
      [150, coreSnap(80, 1)],
    ]);
  });

  it("breaks the line 2px either side of the icon, and only there", () => {
    const { calls } = paint([B3_B5]);
    const half = FRAME_ICON_SIZE / 2 + FRAME_ICON_PAD;
    expect(half).toBe(6);
    const top = linePieces(calls)
      .filter((p) => p.from[1] === coreSnap(60, 1) && p.to[1] === coreSnap(60, 1))
      .map((p) => [p.from[0], p.to[0]]);
    expect(top).toEqual([
      [100, 150 - half],
      [150 + half, 201],
    ]);
  });

  it("even counts: the left of the two middle columns -- never the boundary between them", () => {
    // Columns B..C (x 100..300): the middle 200 is the B / C boundary; the icon
    // goes to B's centre, 150.
    const { calls } = paint([{ rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 2 }]);
    const centres = iconCentres(calls);
    expectCentres(centres, [
      [150, coreSnap(60, 1)],
      [150, coreSnap(140, 1)],
    ]);
    for (const [x] of centres) expect(Math.abs(x - 200)).toBeGreaterThan(5);
  });

  it("columns of different widths: the column holding the middle of the edge", () => {
    // Columns B, C, D are 100, 100 and 400px: x 100..200, 200..300, 300..700.
    // The middle of 100..700 is 400, inside D -> centre 500 (not C's 250).
    const geo = sheet({ colWidth: (c) => (c === 3 ? 400 : 100) });
    const { calls } = paint([{ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 3 }], 1, geo);
    expect(iconCentres(calls).every(([x]) => near(x, 500))).toBe(true);
  });

  it("a hidden middle column never carries the icon", () => {
    // Column C hidden: B and D are 100..200 and 200..300; the middle, 200, is
    // the boundary -> the left column, B, centre 150.
    const geo = sheet({ colWidth: (c) => (c === 2 ? 0 : 100) });
    const { calls } = paint([{ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 3 }], 1, geo);
    const centres = iconCentres(calls);
    expect(centres.length).toBe(2);
    expect(centres.every(([x]) => near(x, 150))).toBe(true);
  });

  it("a region scrolled part off sideways: the middle of the VISIBLE width, the left edge not drawn", () => {
    // Columns 0..19 (x 0..2000); everything left of 300 is under the row header.
    // Visible 300..800, middle 550 = inside column 5 (500..600), centre 550.
    const geo = sheet({ view: { left: 300, top: HEADER, right: 800, bottom: 600 } });
    const { calls } = paint([{ rowStart: 2, rowEnd: 4, colStart: 0, colEnd: 19 }], 1, geo);
    expectCentres(iconCentres(calls), [
      [550, coreSnap(60, 1)],
      [550, coreSnap(120, 1)],
    ]);
    const xs = linePieces(calls).filter((p) => p.from[0] === p.to[0]).map((p) => p.from[0]);
    expect(xs).not.toContain(coreSnap(300, 1));
  });

  it("an edge whose middle column is too narrow keeps a plain line", () => {
    expect(FRAME_ICON_MIN_CELL).toBe(16);
    const narrow = sheet({ colWidth: (c) => (c === 1 ? 14 : 100) });
    const { calls } = paint([B3_B5], 1, narrow);
    expect(iconCentres(calls)).toEqual([]);
    expect(linePieces(calls).length).toBe(4);
  });

  it("skips an edge that continues off-screen, and its icon", () => {
    // Rows 2..40 run past the bottom of the view.
    const geo = sheet({ view: { left: 0, top: HEADER, right: 800, bottom: 300 } });
    const { calls } = paint([{ rowStart: 2, rowEnd: 40, colStart: 1, colEnd: 1 }], 1, geo);
    expectCentres(iconCentres(calls), [[150, coreSnap(60, 1)]]);
    expect(calls.filter((c) => c.op === "stroke").length).toBe(1 + 1);
    const ys = linePieces(calls).filter((p) => p.from[1] === p.to[1]).map((p) => p.from[1]);
    expect(ys).not.toContain(coreSnap(300, 1));
  });
});

// ============================================================================
// The region frame: an icon the header or the canvas edge would cut
// ============================================================================

describe("region frame: never an icon the header or the canvas edge would cut in half", () => {
  // The headers are painted AFTER every layer below "over-headers", so an icon
  // centred on a top edge flush with the column header lost its upper half
  // under it: a region in row 1, or one scrolled so its first row is the first
  // one visible (keyboard scrolling is row-aligned, so that is common).
  // SABOTAGE: ignore the cell area's top -- the half icon is back.
  it("a region in row 1: the top edge keeps its line, the icon goes to the bottom edge only", () => {
    const { calls } = paint([{ rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 }]);
    expectCentres(iconCentres(calls), [[150, coreSnap(80, 1)]]);
    const ys = linePieces(calls).filter((p) => p.from[1] === p.to[1]).map((p) => p.from[1]);
    expect(ys).toContain(coreSnap(HEADER, 1));
  });

  it("a region scrolled flush with the header: the same", () => {
    // The view's top (the header's bottom) is 220 = row 10's top.
    const geo = sheet({ view: { left: 0, top: 220, right: 800, bottom: 600 } });
    const { calls } = paint([{ rowStart: 10, rowEnd: 12, colStart: 1, colEnd: 1 }], 1, geo);
    expectCentres(iconCentres(calls), [[150, coreSnap(280, 1)]]);
  });

  it("one row below the header the top icon fits, and is drawn", () => {
    const { calls } = paint([{ rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 }]);
    expectCentres(iconCentres(calls), [
      [150, coreSnap(40, 1)],
      [150, coreSnap(80, 1)],
    ]);
  });

  it("headings hidden: the cell area starts at the canvas top, and the same rule holds there", () => {
    const geo = sheet({ y0: 0, view: { left: 0, top: 0, right: 800, bottom: 600 } });
    const { calls } = paint([{ rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 }], 1, geo);
    expectCentres(iconCentres(calls), [[150, coreSnap(60, 1)]]);
  });

  it("a bottom edge at the bottom of the canvas keeps its line but not its icon", () => {
    // Rows 2..4 end at 120; the canvas is 120 tall.
    const geo = sheet({ view: { left: 0, top: HEADER, right: 800, bottom: 120 } });
    const { calls } = paint([B3_B5], 1, geo, 120);
    expectCentres(iconCentres(calls), [[150, coreSnap(60, 1)]]);
    const ys = linePieces(calls).filter((p) => p.from[1] === p.to[1]).map((p) => p.from[1]);
    expect(ys).toContain(coreSnap(120, 1));
  });
});

describe("region frame: what it costs and when it paints", () => {
  it("paints nothing when the active sheet has no regions (another sheet, a canvas page)", () => {
    const geo = sheet({});
    const rectOf = vi.fn(geo.rectOf);
    const { ctx, calls } = recorder();
    createWritebackOutlinePainter({
      regions: () => [],
      colors,
      rectOf,
      gridline: gridlineGeometry,
      cellArea: () => ({ x: 0, y: HEADER }),
    })(layerContext(ctx));
    expect(rectOf).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("the usual form costs two rectangles: the region and its middle column", () => {
    const geo = sheet({});
    paint([B3_B5], 1, geo);
    expect(geo.calls).toEqual([
      [2, 1, 4, 1],
      [2, 1, 4, 1], // the middle column (B), across the region's rows
    ]);
  });

  it("a wide region scrolled half off costs a binary search, never a walk", () => {
    const geo = sheet({ view: { left: 0, top: HEADER, right: 800, bottom: 600 } });
    const cols = 1000;
    paint([{ rowStart: 2, rowEnd: 4, colStart: 0, colEnd: cols - 1 }], 1, geo);
    const bound = 1 + 2 * (Math.ceil(Math.log2(cols)) + 2);
    expect(geo.calls.length).toBeLessThanOrEqual(bound);
  });

  it("middleVisibleLine names the line it chose, on either axis", () => {
    const geo = sheet({});
    const rect = geo.rectOf(layerContext(recorder().ctx), 2, 1, 5, 2) as RangeCanvasRect;
    const ctx = layerContext(recorder().ctx);
    expect(middleVisibleLine("row", ctx, { rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 2 }, rect, geo.rectOf)).toEqual({
      index: 3,
      lo: 80,
      hi: 100,
    });
    expect(middleVisibleLine("col", ctx, { rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 2 }, rect, geo.rectOf)).toEqual({
      index: 1,
      lo: 100,
      hi: 200,
    });
  });
});

// ============================================================================
// The state marker
// ============================================================================

const cell = { cellLeft: 100, cellTop: 40, cellRight: 200, cellBottom: 60 };
const DANGER = { danger: "DANGER" };

describe("state marker: a red triangle in the top-left corner", () => {
  it("only draft and rejected carry a marker", () => {
    expect(markerKindFor("draft")).toBe("draft");
    expect(markerKindFor("rejected")).toBe("rejected");
    expect(markerKindFor("empty")).toBeNull();
    expect(markerKindFor("submitted")).toBeNull();
    expect(markerKindFor("approved")).toBeNull();
    expect(markerKindFor(null)).toBeNull();
  });

  it("is a solid right triangle, right angle in the corner, legs 7, in the danger tone", () => {
    expect(MARKER_TRIANGLE_SIZE).toBe(7);
    expect(markerTriangle(100, 40)).toEqual([
      [100, 40],
      [107, 40],
      [100, 47],
    ]);
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, cell, DANGER);
    expect(calls.map((c) => c.op)).toEqual(["save", "beginPath", "moveTo", "lineTo", "lineTo", "closePath", "fill", "restore"]);
    expect(calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").map((c) => c.args)).toEqual([
      [100, 40],
      [107, 40],
      [100, 47],
    ]);
    expect(calls.find((c) => c.op === "fill")!.fillStyle).toBe("DANGER");
    // No disc, no square, no ring, no glyph.
    expect(calls.some((c) => ["arc", "stroke", "fillRect", "fillText"].includes(c.op))).toBe(false);
  });

  it("skips a cell (or the visible part of one) smaller than the triangle", () => {
    for (const small of [
      { ...cell, cellRight: cell.cellLeft + 6 },
      { ...cell, cellBottom: cell.cellTop + 6 },
    ]) {
      const { ctx, calls } = recorder();
      paintWritebackMarker(ctx, small, DANGER);
      expect(calls.length).toBe(0);
    }
  });

  it("the decoration marks drafts and rejected values alike, and nothing else", () => {
    const states: Record<number, WritebackCellState | null> = {
      1: "draft",
      2: "rejected",
      3: "submitted",
      4: "approved",
      5: "empty",
      6: null,
    };
    const tones = vi.fn(() => DANGER);
    const decorate = createWritebackDecoration({ cellState: (row) => states[row] ?? null, colors: tones });
    const marked: number[] = [];
    for (const row of [1, 2, 3, 4, 5, 6]) {
      const { ctx, calls } = recorder();
      decorate({ ctx, row, col: 1, ...cell } as unknown as CellDecorationContext);
      if (calls.some((c) => c.op === "fill")) {
        marked.push(row);
        expect(calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").map((c) => c.args)).toEqual([
          [100, 40],
          [107, 40],
          [100, 47],
        ]);
      } else {
        expect(calls.length).toBe(0);
      }
    }
    expect(marked).toEqual([1, 2]);
    expect(tones).toHaveBeenCalledTimes(2);
  });

  // With 6px legs over the green 5px triangle the band between the two
  // hypotenuses was 0.71px: at 100% it rasterised as a brown 50/50 mix and a
  // pink fringe, no pixel of the marker's red (measured 2026-10-22), so a cell
  // flagged "number stored as text" lost its "not sent" signal.
  // SABOTAGE: legs 6 -- no device pixel is solid red at 100%.
  it("paints UNDER ErrorChecking's green triangle, leaving a band of SOLID red pixels at 100% and 200%", () => {
    const errorChecking = readSource("extensions/ErrorChecking/index.ts");
    const registration = /"error-checking-triangles",\s*drawErrorTriangle,\s*(\d+),\s*"([^"]+)"/.exec(errorChecking);
    expect(registration, "ErrorChecking's decoration registration moved").not.toBeNull();
    const [, greenPriority, greenAnchor] = registration!;
    expect(greenAnchor).toBe(WRITEBACK_MARKER_ANCHOR);
    expect(WRITEBACK_MARKER_ANCHOR).toBe("over-selection");
    // Lower priority paints first (underneath).
    expect(WRITEBACK_MARKER_PRIORITY).toBe(9);
    expect(WRITEBACK_MARKER_PRIORITY).toBeLessThan(Number(greenPriority));
    const greenSize = /const TRIANGLE_SIZE = (\d+);/.exec(readSource("extensions/ErrorChecking/rendering/errorTriangleRenderer.ts"));
    expect(greenSize).not.toBeNull();
    const green = Number(greenSize![1]);
    // A device pixel (i, j) from the corner is SOLID red when the red triangle
    // covers all of it (its far corner, i + j + 2 device px, within the red
    // hypotenuse) and the green one none of it (its near corner, i + j, on or
    // beyond the green hypotenuse).
    for (const scale of [1, 2]) {
      const solidRed: number[] = [];
      for (let diagonal = 0; diagonal < 4 * MARKER_TRIANGLE_SIZE; diagonal++) {
        if ((diagonal + 2) / scale <= MARKER_TRIANGLE_SIZE && diagonal / scale >= green) solidRed.push(diagonal);
      }
      expect(solidRed.length, `at scale ${scale}`).toBeGreaterThanOrEqual(1);
    }
  });
});

// ============================================================================
// The rejected value's text
// ============================================================================

const LIGHT_INK = "#b42318";
const DARK_INK = "#fda29b";

/** Deps for a skin whose own danger ink is `active` (Light: LIGHT_INK; Dark: DARK_INK). */
function textDeps(
  active: string,
  cellState: (row: number, col: number) => WritebackCellState | null = () => "rejected",
): WritebackRejectedTextDeps {
  return {
    cellState,
    danger: () => active,
    alternativeInks: () => [LIGHT_INK, DARK_INK],
    isExplicitFill: isExplicitCellFill,
  };
}

describe("rejected text: the danger tone on the text, and nothing else", () => {
  const states: Record<number, WritebackCellState | null> = {
    1: "draft",
    2: "rejected",
    3: "submitted",
    4: "approved",
    5: "empty",
    6: null,
  };
  const intercept = createWritebackRejectedTextInterceptor({
    cellState: (row) => states[row] ?? null,
    danger: () => "DANGER",
    alternativeInks: () => [],
    isExplicitFill: isExplicitCellFill,
  });
  const base: BaseStyleInfo = { styleIndex: 3, textColor: "#000000", backgroundColor: "#ffffff", bold: true };

  it("a rejected value: text colour only -- never a fill, never anything else", () => {
    const out = intercept("12", base, { row: 2, col: 1 });
    expect(out).toEqual({ textColor: "DANGER" });
    expect(Object.keys(out!)).toEqual(["textColor"]);
  });

  it("every other state, and a cell outside any region: no override", () => {
    for (const row of [1, 3, 4, 5, 6]) {
      expect(intercept("12", base, { row, col: 1 })).toBeNull();
    }
  });

  it("leaves text an earlier interceptor hid (a checkbox, an embedded button) hidden", () => {
    expect(intercept("TRUE", { ...base, textColor: "rgba(0,0,0,0)" }, { row: 2, col: 1 })).toBeNull();
  });

  it("knows an invisible text colour from black", () => {
    for (const hidden of ["transparent", "rgba(0,0,0,0)", "rgba(0, 0, 0, 0.0)", "rgb(0 0 0 / 0%)", "#0000", "#00000000", "hsla(0, 0%, 0%, 0)"]) {
      expect(isInvisibleTextColor(hidden), hidden).toBe(true);
    }
    for (const visible of [undefined, "", "#000", "#000000", "rgb(0,0,0)", "rgb(0, 0, 0)", "rgba(0,0,0,0.5)", "#000f", "black"]) {
      expect(isInvisibleTextColor(visible), String(visible)).toBe(false);
    }
  });

  it("wins over conditional formatting's font colour in the real pipeline, and keeps a checkbox's text hidden", () => {
    const ids = ["test.cf", "test.checkbox", WRITEBACK_REJECTED_TEXT_ID];
    try {
      registerStyleInterceptor("test.cf", () => ({ textColor: "CF" }), 100);
      registerStyleInterceptor(WRITEBACK_REJECTED_TEXT_ID, intercept, WRITEBACK_REJECTED_TEXT_PRIORITY);
      expect(applyStyleInterceptors("12", { styleIndex: 0 }, { row: 2, col: 1 }).textColor).toBe("DANGER");
      expect(applyStyleInterceptors("12", { styleIndex: 0 }, { row: 1, col: 1 }).textColor).toBe("CF");
      registerStyleInterceptor("test.checkbox", () => ({ textColor: "rgba(0,0,0,0)" }), 5);
      unregisterStyleInterceptor("test.cf");
      expect(applyStyleInterceptors("TRUE", { styleIndex: 0 }, { row: 2, col: 1 }).textColor).toBe("rgba(0,0,0,0)");
    } finally {
      for (const id of ids) unregisterStyleInterceptor(id);
    }
  });

  // The stand-in above runs at 100 because that is where the REAL conditional
  // formatting interceptor runs; if it moved above 150 it would override the
  // rejected ink with no other test failing.
  // SABOTAGE: register CF at 200 -- this pin fails.
  it("runs after the REAL conditional-formatting interceptor (pinned from its registration)", () => {
    const cf = readSource("extensions/ConditionalFormatting/index.ts");
    const registration = /styleInterceptors\.register\(\s*"conditional-formatting",\s*conditionalFormattingInterceptor,\s*(\d+)\s*\)/.exec(cf);
    expect(registration, "ConditionalFormatting's interceptor registration moved").not.toBeNull();
    expect(WRITEBACK_REJECTED_TEXT_PRIORITY).toBeGreaterThan(Number(registration![1]));
  });
});

// ============================================================================
// The rejected value's ink follows the cell's fill
// ============================================================================

describe("rejected text: an ink that reads on the cell's fill", () => {
  // Measured 2026-10-22: the Dark skin's #fda29b on Excel's "Light Red Fill"
  // #ffc7ce is 1.32:1 (it replaced the preset's own #9c0006 at 5.92:1), on a
  // light-yellow input fill #fff2cc 1.74:1; the Light skin's #b42318 on a dark
  // blue #1f4e79 is 1.32:1.
  // SABOTAGE: return the active ink for every fill -- the three fills fail.
  it("on an explicit fill of the opposite lightness, the other ground's danger ink", () => {
    expect(rejectedTextInk("#ffc7ce", textDeps(DARK_INK))).toBe(LIGHT_INK);
    expect(rejectedTextInk("#FFF2CC", textDeps(DARK_INK))).toBe(LIGHT_INK);
    expect(rejectedTextInk("#1f4e79", textDeps(LIGHT_INK))).toBe(DARK_INK);
  });

  it("the skin's own ink wherever it reads: no fill, white, transparent, a fill of the skin's lightness", () => {
    for (const fill of [undefined, "", "#ffffff", "#FFF", "white", "transparent", "rgb(255, 255, 255)"]) {
      // A "no fill" style: the grid paints the skin's own background -- dark
      // under Dark, so the Dark ink, even though the style says white.
      expect(rejectedTextInk(fill, textDeps(DARK_INK)), String(fill)).toBe(DARK_INK);
      expect(rejectedTextInk(fill, textDeps(LIGHT_INK)), String(fill)).toBe(LIGHT_INK);
    }
    expect(rejectedTextInk("#ffc7ce", textDeps(LIGHT_INK))).toBe(LIGHT_INK);
    expect(rejectedTextInk("#1f4e79", textDeps(DARK_INK))).toBe(DARK_INK);
  });

  it("on a mid-tone fill no danger ink reads: the text keeps its own colour (the triangle still marks the cell)", () => {
    for (const fill of ["#4472c4", "#ed7d31", "#70ad47", "#ff0000", "#808080"]) {
      expect(rejectedTextInk(fill, textDeps(LIGHT_INK)), fill).toBeNull();
      const intercept = createWritebackRejectedTextInterceptor(textDeps(LIGHT_INK));
      expect(intercept("12", { styleIndex: 0, textColor: "#ffffff", backgroundColor: fill }, { row: 2, col: 1 }), fill).toBeNull();
    }
  });

  it("a fill it cannot read as an opaque colour keeps the skin's ink, as before", () => {
    for (const fill of ["rgba(255, 0, 0, 0.5)", "#ff000080", "red"]) {
      expect(rejectedTextInk(fill, textDeps(DARK_INK)), fill).toBe(DARK_INK);
    }
  });

  it("through the interceptor: a conditional format's light fill under the Dark skin gets the Light ink", () => {
    const intercept = createWritebackRejectedTextInterceptor(textDeps(DARK_INK));
    const cfStyled: BaseStyleInfo = { styleIndex: 0, textColor: "#9c0006", backgroundColor: "#ffc7ce" };
    expect(intercept("12", cfStyled, { row: 2, col: 1 })).toEqual({ textColor: LIGHT_INK });
  });

  it("the alternatives are the Light and Dark grounds' own danger inks, as the extension wires them", () => {
    expect(getBaselineToneColors("light").dangerFg).toBe(LIGHT_INK);
    expect(getBaselineToneColors("dark").dangerFg).toBe(DARK_INK);
    const index = readSource("extensions/Collaboration/index.ts");
    expect(index).toContain(
      'alternativeInks: () => [getBaselineToneColors("light").dangerFg, getBaselineToneColors("dark").dangerFg],',
    );
    expect(index).toContain("isExplicitFill: isExplicitCellFill,");
  });
});

// ============================================================================
// Registration: only while subscribed regions exist
// ============================================================================

describe("the cell painters are registered only while subscribed regions exist", () => {
  afterEach(() => {
    unregisterStyleInterceptor(WRITEBACK_REJECTED_TEXT_ID);
  });

  function harness() {
    const decorations = new Map<string, { priority: number; anchor: string }>();
    const registerDecoration = vi.fn((id: string, _fn: unknown, priority: number, anchor: string) => {
      decorations.set(id, { priority, anchor });
      return () => {
        decorations.delete(id);
      };
    });
    const registerInterceptor = vi.fn(
      (id: string, fn: Parameters<typeof registerStyleInterceptor>[1], priority: number) =>
        registerStyleInterceptor(id, fn, priority),
    );
    const painters = createWritebackCellPainters({
      cellState: (row) => (row === 2 ? "rejected" : null),
      danger: () => "DANGER",
      alternativeInks: () => [],
      isExplicitFill: isExplicitCellFill,
      registerDecoration,
      registerInterceptor,
    });
    const interceptorUp = () => getStyleInterceptors().some((i) => i.id === WRITEBACK_REJECTED_TEXT_ID);
    return { painters, decorations, registerDecoration, registerInterceptor, interceptorUp };
  }

  it("nothing while there are none", () => {
    const h = harness();
    h.painters.sync(false);
    expect(h.registerDecoration).not.toHaveBeenCalled();
    expect(h.registerInterceptor).not.toHaveBeenCalled();
    expect(h.interceptorUp()).toBe(false);
  });

  it("both while there are some -- the marker at priority 9 over the selection -- once, however often it syncs", () => {
    const h = harness();
    h.painters.sync(true);
    h.painters.sync(true);
    expect(h.registerDecoration).toHaveBeenCalledTimes(1);
    expect(h.registerInterceptor).toHaveBeenCalledTimes(1);
    expect(h.decorations.get(WRITEBACK_MARKER_ID)).toEqual({ priority: 9, anchor: "over-selection" });
    expect(h.registerInterceptor.mock.calls[0][0]).toBe(WRITEBACK_REJECTED_TEXT_ID);
    expect(h.registerInterceptor.mock.calls[0][2]).toBe(WRITEBACK_REJECTED_TEXT_PRIORITY);
    expect(h.interceptorUp()).toBe(true);
    // The registered interceptor is the rejected-text one.
    expect(applyStyleInterceptors("12", { styleIndex: 0 }, { row: 2, col: 1 }).textColor).toBe("DANGER");
  });

  it("drops both when the last region goes, and again on dispose", () => {
    const h = harness();
    h.painters.sync(true);
    h.painters.sync(false);
    expect(h.decorations.size).toBe(0);
    expect(h.interceptorUp()).toBe(false);
    h.painters.sync(true);
    expect(h.interceptorUp()).toBe(true);
    h.painters.dispose();
    h.painters.dispose();
    expect(h.decorations.size).toBe(0);
    expect(h.interceptorUp()).toBe(false);
  });

  it("the extension wires them that way (frame colours from the accessor, cell painters by the region index)", () => {
    const index = readSource("extensions/Collaboration/index.ts");
    expect(index).toContain("colors: () => writebackFrameColors(getCanvasThemeColor),");
    expect(index).toContain("cellPainters.sync(hasWritebackRegions());");
    expect(index).toContain("cellPainters.dispose();");
  });
});
