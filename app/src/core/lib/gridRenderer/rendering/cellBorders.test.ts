//! FILENAME: app/src/core/lib/gridRenderer/rendering/cellBorders.test.ts
// PURPOSE: Cell borders land on whole device pixels, straddle the boundary they
//          name, and paint ONE stroke per boundary — none of which was true.
// CONTEXT: Found by `e2e/tests/vba-idioms-wave3.spec.ts:468`, which sampled the
//          right edge of a red "medium" outline and got EXACTLY ZERO red pixels
//          while the TOP edge of the same outline passed. The trace stored the
//          probe's actual pixels; every one of its 12 rows read
//
//              255,255,255 | 255,107,107 | 238,131,131 | 255,255,255 | 255,255,255
//
//          i.e. one red line spread across two device pixels at ~58%/42%, against
//          a predicate needing >=64.7% coverage. Two defects stacked:
//
//          1. THE CLIP. The per-cell clip exists to cut overlong TEXT, and the
//             border pass ran inside it. A "medium" is 2px centred on the edge,
//             so the clip threw away the outer half: every border painted at HALF
//             its nominal weight, inside the cell, instead of straddling the
//             boundary the way Excel draws it.
//          2. NO SNAPPING. `drawGridLines` has always snapped its hairline to
//             device pixels; borders never did. Row boundaries are integral
//             (defaultCellHeight 20) but column boundaries are not
//             (defaultCellWidth 64.29), so horizontal borders happened to land on
//             one whole pixel and vertical ones smeared across two. That is the
//             whole top-passes/right-fails asymmetry.
//
//          At dpr 2 the surviving half was 2 device pixels, so one was always
//          fully covered — which is why this only surfaced when the machine moved
//          to dpr 1. It was latent, not a regression.
//
// WHAT MAKES THESE TESTS HARD TO FOOL. Frames go through the real `renderGrid`
// with a recording context that keeps ONE ordered op list and a real clip STACK,
// so "which clip was in force at this stroke" and "did the neighbour's background
// paint before or after this stroke" are both answerable. The fixture geometry is
// stated once and every expected coordinate is derived from it by hand, so no
// assertion restates the renderer's own arithmetic back at it.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import { drawBorderLine, borderLineWidth } from "./cells";
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
// FIXTURE GEOMETRY — stated once, everything below is derived from it BY HAND.
// ---------------------------------------------------------------------------
const CELL_W = DEFAULT_GRID_CONFIG.defaultCellWidth; // 64.29 — deliberately fractional
const CELL_H = DEFAULT_GRID_CONFIG.defaultCellHeight; // 20    — integral
const GUTTER_X = DEFAULT_GRID_CONFIG.rowHeaderWidth; // 22
const GUTTER_Y = DEFAULT_GRID_CONFIG.colHeaderHeight; // 20

const ROW = 1;
const COL = 1;

/** Cell (1,1)'s box: x [86.29, 150.58], y [40, 60]. */
const CELL_LEFT = GUTTER_X + CELL_W * COL; // 86.29
const CELL_RIGHT = GUTTER_X + CELL_W * (COL + 1); // 150.58  <- FRACTIONAL
const CELL_TOP = GUTTER_Y + CELL_H * ROW; // 40
const CELL_BOTTOM = GUTTER_Y + CELL_H * (ROW + 1); // 60     <- INTEGRAL

interface Op {
  op: string;
  args: number[];
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  /** The innermost clip rect in force when this op ran, if any. */
  clip: number[] | null;
}

/**
 * A recording context with a REAL clip stack. `save`/`restore` push and pop, so
 * the clip stamped on each op is the one actually in force — which is the only
 * way to tell "inside the per-cell text clip" from "inside the frame-wide border
 * clip", and that distinction IS the first defect.
 */
function makeRecordingCtx(dpr = 1): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  let clip: number[] | null = null;
  let pendingRect: number[] | null = null;
  const stack: Array<number[] | null> = [];

  const push = (op: string, args: number[]): void => {
    ops.push({
      op,
      args,
      strokeStyle: String(api.strokeStyle),
      fillStyle: String(api.fillStyle),
      lineWidth: Number(api.lineWidth),
      clip: clip ? [...clip] : null,
    });
  };

  const api = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "miter",
    lineDashOffset: 0,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    canvas: { width: 600, height: 200 },
    // The transform the renderer scales by. `drawBorderLine` reads `.a` to learn
    // the device scale; a mock WITHOUT this method must still work (the fix uses
    // optional-call so it falls back to 1), and several other renderer mocks in
    // this repo do not define it.
    getTransform() {
      return { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 };
    },
    save() {
      stack.push(clip ? [...clip] : null);
    },
    restore() {
      clip = stack.length > 0 ? stack.pop()! : null;
    },
    beginPath() {
      pendingRect = null;
    },
    moveTo(x: number, y: number) {
      push("moveTo", [x, y]);
    },
    lineTo(x: number, y: number) {
      push("lineTo", [x, y]);
    },
    closePath() {},
    rect(x: number, y: number, w: number, h: number) {
      pendingRect = [x, y, w, h];
    },
    arc() {},
    clip() {
      if (pendingRect) clip = [...pendingRect];
    },
    fill() {},
    stroke() {
      push("stroke", []);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      push("fillRect", [x, y, w, h]);
    },
    strokeRect() {},
    clearRect() {},
    fillText() {},
    strokeText() {},
    measureText(text: string) {
      return { width: String(text).length * 6 };
    },
    setLineDash() {},
    getLineDash() {
      return [];
    },
    translate() {},
    rotate() {},
    scale() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, ops };
}

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 6,
  colCount: 6,
};

type Sides = Partial<
  Pick<
    StyleData,
    "borderTop" | "borderRight" | "borderBottom" | "borderLeft" | "borderDiagonalDown" | "borderDiagonalUp"
  >
>;

function side(style: string, color = "#ff0000") {
  return { style, color, width: 1 };
}

interface Scene {
  /** Sides on cell (1,1). */
  target: Sides;
  /** Sides on the cell to its RIGHT, (1,2) — for contested-boundary cases. */
  neighbour?: Sides;
  /** Background on (1,2), to prove paint ORDER against the target's border. */
  neighbourBg?: string;
  dpr?: number;
}

/** Render one frame and hand back every recorded op, in order. */
function renderScene(scene: Scene): Op[] {
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    totalRows: 50,
    totalCols: 12,
  };

  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);
  styleCache.set(1, { ...DEFAULT_STYLE, ...scene.target });
  styleCache.set(2, {
    ...DEFAULT_STYLE,
    ...(scene.neighbour ?? {}),
    ...(scene.neighbourBg ? { backgroundColor: scene.neighbourBg } : {}),
  });

  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    display: "",
    formula: null,
    styleIndex: 1,
  } as CellData);
  if (scene.neighbour || scene.neighbourBg) {
    cells.set(cellKey(ROW, COL + 1), {
      row: ROW,
      col: COL + 1,
      display: "",
      formula: null,
      styleIndex: 2,
    } as CellData);
  }

  const { ctx, ops } = makeRecordingCtx(scene.dpr ?? 1);
  renderGrid(
    ctx,
    600,
    200,
    config,
    VIEWPORT,
    null,
    null,
    cells,
    DEFAULT_THEME,
    [],
    { columnWidths: new Map(), rowHeights: new Map() },
    styleCache
  );
  return ops;
}

/**
 * The strokes of a given colour, as {x1,y1,x2,y2,lineWidth,clip} records.
 * Colour is the discriminator because gridlines, headers and selection chrome
 * all stroke too — filtering by position would silently start including them.
 */
interface Stroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineWidth: number;
  clip: number[] | null;
  index: number;
}

function strokesOf(ops: Op[], color: string): Stroke[] {
  const out: Stroke[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== "stroke" || ops[i].strokeStyle !== color) continue;
    // The two ops immediately before a stroke are its moveTo/lineTo.
    const lineTo = ops[i - 1];
    const moveTo = ops[i - 2];
    if (!lineTo || !moveTo || lineTo.op !== "lineTo" || moveTo.op !== "moveTo") continue;
    out.push({
      x1: moveTo.args[0],
      y1: moveTo.args[1],
      x2: lineTo.args[0],
      y2: lineTo.args[1],
      lineWidth: ops[i].lineWidth,
      clip: ops[i].clip,
      index: i,
    });
  }
  return out;
}

/** Does a stroke of `w` device px centred at `d` cover only WHOLE device pixels? */
function coversWholeDevicePixels(coord: number, lineWidth: number, dpr: number): boolean {
  const d = coord * dpr;
  const w = lineWidth * dpr;
  return Number.isInteger(d - w / 2) && Number.isInteger(d + w / 2);
}

describe("cell borders straddle their boundary", () => {
  it("T1: a right border is NOT clipped to its own cell box", () => {
    const ops = renderScene({ target: { borderRight: side("medium") } });
    const s = strokesOf(ops, "#ff0000");
    expect(s.length, "the red right border did not paint at all").toBe(1);
    // The defect: the clip in force was the CELL box (64.29 wide), which cut the
    // outer half of the 2px stroke off. It must now be the frame-wide cell area.
    expect(
      s[0].clip,
      "the border stroked inside the per-cell TEXT clip, so half its width was " +
        "discarded — this is the original defect",
    ).not.toEqual([CELL_LEFT, CELL_TOP, CELL_W, CELL_H]);
    expect(s[0].clip![0], "clip left should be the row-header gutter").toBe(GUTTER_X);
    expect(s[0].clip![1], "clip top should be the column-header gutter").toBe(GUTTER_Y);
    expect(s[0].clip![2], "clip width should span the frame").toBe(600 - GUTTER_X);
  });

  it("T2: the border paints AFTER the neighbouring cell's background", () => {
    // The load-bearing ordering test. A right border straddles into cell (1,2);
    // if it were painted in place, (1,2)'s own background would erase that half
    // moments later. Only a deferred pass survives this.
    const ops = renderScene({
      target: { borderRight: side("medium") },
      neighbourBg: "#00ff00",
    });
    const bg = ops.findIndex((o) => o.op === "fillRect" && o.fillStyle === "#00ff00");
    const border = strokesOf(ops, "#ff0000");
    expect(bg, "the neighbour's green background never painted").toBeGreaterThanOrEqual(0);
    expect(border.length, "the red border never painted").toBe(1);
    expect(
      border[0].index,
      "the border painted BEFORE the neighbouring background, so the half that " +
        "straddles into that cell is erased — a wider clip cannot fix this, the " +
        "ORDERING is the defect",
    ).toBeGreaterThan(bg);
  });
});

describe("cell borders snap to whole device pixels", () => {
  // The boundary under test is x = 150.58 — fractional, which is why vertical
  // borders were the ones that smeared. Expected coordinates are worked by hand:
  //   even width -> pixel EDGE   -> round(150.58) = 151
  //   odd  width -> pixel CENTRE -> round(150.58) + 0.5 = 151.5
  it("T3: medium (2px, EVEN) lands on a pixel edge at dpr 1", () => {
    const s = strokesOf(renderScene({ target: { borderRight: side("medium") } }), "#ff0000");
    expect(s[0].lineWidth).toBe(2);
    expect(s[0].x1).toBe(151);
    expect(s[0].x2).toBe(151);
    expect(coversWholeDevicePixels(151, 2, 1), "device span must be [150,152]").toBe(true);
  });

  it("T4: thin (1px, ODD) lands on the SAME pixel the gridline chose", () => {
    // The non-restating half: rather than asserting 151.5 (which would just echo
    // the fix's arithmetic), compare against the vertical GRIDLINE the renderer
    // drew for the same boundary in the same frame. A thin border replaces that
    // hairline, so it must land exactly on it or toggling gridlines shifts it.
    const ops = renderScene({ target: { borderRight: side("thin") } });
    const border = strokesOf(ops, "#ff0000");
    expect(border[0].lineWidth).toBe(1);

    // `theme.gridLine` is #e2e2e2 — the same 226,226,226 the golden-corpus
    // census reads a dpr-1 capture by. Same hairline, same snapping rule.
    const gridlines = strokesOf(ops, DEFAULT_THEME.gridLine).filter(
      (g) => g.x1 === g.x2 && Math.abs(g.x1 - CELL_RIGHT) < 2,
    );
    expect(
      gridlines.length,
      "no gridline was drawn near this boundary, so the comparison is vacuous",
    ).toBeGreaterThan(0);
    expect(
      border[0].x1,
      "a thin border must sit exactly where the gridline it replaces sits",
    ).toBe(gridlines[0].x1);
  });

  it("T5: thick (3px, ODD) lands on a pixel centre at dpr 1", () => {
    const s = strokesOf(renderScene({ target: { borderRight: side("thick") } }), "#ff0000");
    expect(s[0].lineWidth).toBe(3);
    expect(s[0].x1).toBe(151.5);
    expect(coversWholeDevicePixels(151.5, 3, 1), "device span must be [150,153]").toBe(true);
  });

  it("T6: at dpr 2 a medium border still covers whole DEVICE pixels", () => {
    // deviceWidth = 4 (even) -> the device coordinate must be an integer, so the
    // logical coordinate is a half. This is the configuration the corpus used to
    // be recorded at; it must not regress.
    const s = strokesOf(renderScene({ target: { borderRight: side("medium") }, dpr: 2 }), "#ff0000");
    expect(s[0].lineWidth).toBe(2);
    expect(s[0].x1).toBe(150.5);
    expect(coversWholeDevicePixels(150.5, 2, 2), "device span must be [299,303]").toBe(true);
  });

  it("T7: a DIAGONAL is neither snapped nor moved out of its cell clip", () => {
    // Snapping one axis of a diagonal only skews it, and a 3px thick diagonal
    // must stay boxed or it bleeds into neighbours.
    const s = strokesOf(renderScene({ target: { borderDiagonalDown: side("medium") } }), "#ff0000");
    expect(s.length, "the diagonal did not paint").toBe(1);
    expect([s[0].x1, s[0].y1, s[0].x2, s[0].y2], "diagonal endpoints were snapped").toEqual([
      CELL_LEFT,
      CELL_TOP,
      CELL_RIGHT,
      CELL_BOTTOM,
    ]);
    expect(
      s[0].clip,
      "the diagonal escaped the per-cell clip — a thick one would bleed out",
    ).toEqual([CELL_LEFT, CELL_TOP, CELL_W, CELL_H]);
  });
});

describe("a contested boundary paints exactly one stroke", () => {
  it("T8: heavier wins, so a thin neighbour cannot punch through a thick border", () => {
    // Before the fix the per-cell clip made these two DISJOINT halves, so both
    // showed. At full weight they are coincident: black|grey|black, an artefact
    // that exists neither today nor in Excel.
    const ops = renderScene({
      target: { borderRight: side("thick", "#000000") },
      neighbour: { borderLeft: side("thin", "#808080") },
    });
    const dark = strokesOf(ops, "#000000").filter((s) => s.x1 === s.x2 && Math.abs(s.x1 - CELL_RIGHT) < 2);
    const grey = strokesOf(ops, "#808080").filter((s) => s.x1 === s.x2 && Math.abs(s.x1 - CELL_RIGHT) < 2);
    expect(dark.length, "the thick black border should paint once").toBe(1);
    expect(dark[0].lineWidth).toBe(3);
    expect(
      grey.length,
      "the thin grey neighbour also stroked the shared boundary — it punches a " +
        "1px stripe through the middle of the thick black border",
    ).toBe(0);
  });

  it("T9: on equal weight the LATER cell wins, and only one stroke happens", () => {
    const ops = renderScene({
      target: { borderRight: side("medium", "#ff0000") },
      neighbour: { borderLeft: side("medium", "#0000ff") },
    });
    const red = strokesOf(ops, "#ff0000").filter((s) => s.x1 === s.x2 && Math.abs(s.x1 - CELL_RIGHT) < 2);
    const blue = strokesOf(ops, "#0000ff").filter((s) => s.x1 === s.x2 && Math.abs(s.x1 - CELL_RIGHT) < 2);
    expect(red.length + blue.length, "a contested boundary must paint exactly once").toBe(1);
    expect(blue.length, "the tie rule is later-cell-wins; it silently flipped").toBe(1);
  });
});

describe("the double border keeps its ornament centred", () => {
  it("T10: on an INTEGRAL boundary it is byte-identical to before the fix", () => {
    // The regression an adversarial reviewer caught: snapping each rule
    // independently makes Math.round tie UP for both, shifting the whole ornament
    // one device pixel off the boundary (58.5/61.5 -> 59.5/62.5).
    const s = strokesOf(renderScene({ target: { borderBottom: side("double") } }), "#ff0000");
    expect(s.length, "a double border draws two rules").toBe(2);
    expect(s[0].lineWidth).toBe(1);
    const ys = s.map((r) => r.y1).sort((a, b) => a - b);
    expect(ys, "the ornament moved off an already-crisp integral boundary").toEqual([58.5, 61.5]);
    expect((ys[0] + ys[1]) / 2, "the ornament is no longer centred on the boundary").toBe(CELL_BOTTOM);
  });

  it("T11: on a FRACTIONAL boundary both rules become crisp and stay symmetric", () => {
    const s = strokesOf(renderScene({ target: { borderRight: side("double") } }), "#ff0000");
    expect(s.length).toBe(2);
    const xs = s.map((r) => r.x1).sort((a, b) => a - b);
    expect(xs).toEqual([149.5, 152.5]);
    for (const x of xs) {
      expect(coversWholeDevicePixels(x, 1, 1), `rule at ${x} still straddles two pixels`).toBe(true);
    }
    expect(
      (xs[0] + xs[1]) / 2,
      "the ornament must centre on the SNAPPED boundary, not the raw one",
    ).toBe(Math.round(CELL_RIGHT));
  });
});

describe("the weight table is the single source of truth", () => {
  it("T12: every style maps to a width, and parity decides the snap", () => {
    // Documents which widths exist. "solid" (written by the conditional-format
    // interceptor) must fall through to 1 rather than to some default 0.
    expect(borderLineWidth("thin")).toBe(1);
    expect(borderLineWidth("solid")).toBe(1);
    expect(borderLineWidth("dashed")).toBe(1);
    expect(borderLineWidth("dotted")).toBe(1);
    expect(borderLineWidth("double")).toBe(1);
    expect(borderLineWidth("medium")).toBe(2);
    expect(borderLineWidth("thick")).toBe(3);

    for (const dpr of [1, 2, 1.25]) {
      for (const style of ["thin", "medium", "thick"]) {
        const { ctx, ops } = makeRecordingCtx(dpr);
        drawBorderLine(ctx, 150.58, 40, 150.58, 60, { style, color: "#123456", width: 1 });
        const s = strokesOf(ops, "#123456");
        expect(s.length, `${style} @${dpr} did not stroke`).toBe(1);

        const deviceWidth = Math.max(1, Math.round(borderLineWidth(style) * dpr));
        expect(s[0].lineWidth, `${style} @${dpr}: lineWidth must be a whole device width`).toBeCloseTo(
          deviceWidth / dpr,
          10,
        );
        // Parity: an odd device width sits on a pixel CENTRE, an even one on an EDGE.
        const deviceCoord = s[0].x1 * dpr;
        const isHalf = Math.abs(deviceCoord - Math.floor(deviceCoord) - 0.5) < 1e-9;
        expect(isHalf, `${style} @${dpr}: wrong parity for deviceWidth ${deviceWidth}`).toBe(
          deviceWidth % 2 === 1,
        );
      }
    }
  });

  it("T12b: a context with no getTransform falls back to scale 1 instead of throwing", () => {
    // Several renderer mocks in this repo do not define getTransform. The fix
    // uses an optional CALL so the whole member access short-circuits.
    const { ctx, ops } = makeRecordingCtx(1);
    delete (ctx as unknown as Record<string, unknown>).getTransform;
    expect(() =>
      drawBorderLine(ctx, 150.58, 40, 150.58, 60, { style: "medium", color: "#abcdef", width: 1 }),
    ).not.toThrow();
    expect(strokesOf(ops, "#abcdef")[0].x1).toBe(151);
  });
});
