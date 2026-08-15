//! FILENAME: app/src/core/lib/gridRenderer/rendering/truncatedTextDecoration.test.ts
// PURPOSE: An underline (and a strikethrough) must be as wide as the text the
//          user can SEE, not as wide as the text the cell holds.
// CONTEXT: The original defect: the decoration was measured with
//          `ctx.measureText(displayValue)` — the FULL string — and then clamped
//          to the cell, while the renderer drew an ellipsised version that was
//          strictly narrower than the clamp. The rule ran on past the "...".
//
// RE-AIMED FOR EXCEL'S OVERFLOW RULE. Calcula no longer ellipsises anything:
// over-long TEXT is clipped mid-glyph at the cell edge (Excel's behaviour), and
// an over-long NUMBER is replaced by '####' repeated to fill the column. Both
// changed what "the glyphs actually painted" MEANS, so the fixtures below moved
// with them — but the contract did not, and that is the point of keeping this
// file rather than replacing it:
//
//   the rule must span exactly the glyph run that was drawn, clamped to the
//   same box that clips the glyphs.
//
// Under clipping the glyph run IS the whole string, and the clamp to the cell is
// what the clip does to it — so the two agree by construction instead of by
// arithmetic. Under '####' the glyph run is the marker, which is sized to the
// box, so the rule follows the marker rather than the value it replaced. A test
// that only knew about ellipses would have gone quietly green here while
// underlining nothing in particular.
//
// HOW THIS IS VERIFIED. The frame goes through the real `renderGrid`. The fake
// 2D context records what was painted: every fillText (the glyphs) and every
// horizontal stroke segment (the rules). The assertion then compares the two
// against each other, measured with the same measureText the renderer used.
// Nothing here restates the renderer's arithmetic, so the test cannot pass by
// agreeing with a wrong implementation.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  cellKey,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type StyleData,
  type StyleDataMap,
  type UnderlineStyle,
  type Viewport,
} from "../../../types";

// ============================================================================
// Recording context
// ============================================================================

/** One glyph run the renderer painted. */
interface TextDraw {
  text: string;
  x: number;
  y: number;
}
/** One horizontal rule the renderer painted. */
interface RuleDraw {
  x0: number;
  x1: number;
  y: number;
}

const CHAR_WIDTH = 6;

function makeRecordingCtx(): {
  ctx: CanvasRenderingContext2D;
  texts: TextDraw[];
  rules: RuleDraw[];
} {
  const texts: TextDraw[] = [];
  const rules: RuleDraw[] = [];
  let path: Array<{ x: number; y: number }> = [];

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
    canvas: { width: 400, height: 120 },

    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ x, y });
    },
    closePath() {},
    rect() {},
    arc() {},
    clip() {},
    fill() {},
    stroke() {
      for (let i = 1; i < path.length; i++) {
        const p0 = path[i - 1];
        const p1 = path[i];
        if (p0.y === p1.y && p0.x !== p1.x) {
          rules.push({ x0: Math.min(p0.x, p1.x), x1: Math.max(p0.x, p1.x), y: p0.y });
        }
      }
    },
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText(text: string, x: number, y: number) {
      texts.push({ text: String(text), x, y });
    },
    strokeText() {},
    measureText(text: string) {
      return { width: String(text).length * CHAR_WIDTH };
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

  return { ctx: api as unknown as CanvasRenderingContext2D, texts, rules };
}

// ============================================================================
// Fixture
// ============================================================================

const ROW = 1;
const COL = 1;

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  totalRows: 50,
  totalCols: 12,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 5,
  colCount: 5,
};

/** paddingX in the cell renderer; the text box is the column minus 2x this. */
const PADDING_X = 3;
const AVAILABLE_WIDTH = CONFIG.defaultCellWidth - PADDING_X * 2;

function styleCacheWith(overrides: Partial<StyleData>): StyleDataMap {
  const cache: StyleDataMap = new Map();
  cache.set(0, DEFAULT_STYLE);
  cache.set(1, { ...DEFAULT_STYLE, ...overrides });
  return cache;
}

/** What the neighbouring cell holds to block the spill. Never a '#'. */
const BLOCKER = "x";

function cellsWith(display: string): CellDataMap {
  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    value: display,
    display,
    styleIndex: 1,
  } as CellData);
  // The neighbour is OCCUPIED on purpose. An empty neighbour makes the renderer
  // spill the text across it (correct, Excel-like), and a spilled value is not
  // clipped at all — so there would be no overflow to measure. The blocker is
  // deliberately NOT "#", so it can never be confused with the overflow marker.
  cells.set(cellKey(ROW, COL + 1), {
    row: ROW,
    col: COL + 1,
    value: BLOCKER,
    display: BLOCKER,
    styleIndex: 0,
  } as CellData);
  return cells;
}

function render(display: string, overrides: Partial<StyleData>) {
  const { ctx, texts, rules } = makeRecordingCtx();
  renderGrid(
    ctx,
    400,
    120,
    CONFIG,
    VIEWPORT,
    null,
    null,
    cellsWith(display),
    DEFAULT_THEME,
    [],
    { columnWidths: new Map(), rowHeights: new Map() },
    styleCacheWith(overrides),
  );
  // Headers paint their own labels and the blocking neighbour paints "x", so
  // keep only the draws that are the fixture value itself or the '####' marker
  // that replaced it.
  const glyphs = texts.filter(
    (t) => t.text !== "" && t.text !== BLOCKER && (t.text === display || /^#+$/.test(t.text)),
  );
  return { glyphs, rules };
}

/**
 * A TEXT value that does not fit: 30 chars at 6px = 180px against a 58px box.
 */
const LONG = "Quarterly revenue, EMEA region";
/** A value that fits comfortably: 5 chars = 30px. */
const SHORT = "Total";
/** A NUMBER that does not fit: 9 chars = 54px of digits into 58px, then the
 *  General ladder rounds it — so make it long enough that even "1235" style
 *  rounding cannot save it. 20 digits under an explicit format cannot negotiate. */
const LONG_NUMBER = "12345678901234.5678";

describe("decorations follow the RENDERED text, not the stored value", () => {
  it("precondition: over-long TEXT is clipped, not ellipsised and not marked", () => {
    const { glyphs } = render(LONG, { underline: "single" as UnderlineStyle });
    expect(glyphs.length).toBeGreaterThan(0);
    const drawn = glyphs[glyphs.length - 1].text;
    // Excel clips mid-glyph: the whole string is painted and the clip cuts it.
    expect(drawn).toBe(LONG);
    expect(drawn).not.toContain("...");
    expect(drawn).not.toMatch(/#/);
  });

  it("underlines CLIPPED text no wider than the box that clips the glyphs", () => {
    const { glyphs, rules } = render(LONG, { underline: "single" as UnderlineStyle });
    const drawn = glyphs[glyphs.length - 1];
    const glyphWidth = drawn.text.length * CHAR_WIDTH;

    const underline = rules.find((r) => Math.abs(r.x0 - drawn.x) < 0.001);
    expect(underline, "an underline was drawn starting at the glyph origin").toBeTruthy();
    // The glyphs overflow the box; the rule must stop at the box, because that
    // is where the clip stops the glyphs.
    expect(glyphWidth).toBeGreaterThan(AVAILABLE_WIDTH);
    expect(underline!.x1 - underline!.x0).toBeCloseTo(AVAILABLE_WIDTH, 6);
  });

  it("strikes CLIPPED text no wider than the box that clips the glyphs", () => {
    const { glyphs, rules } = render(LONG, { strikethrough: true });
    const drawn = glyphs[glyphs.length - 1];

    const strike = rules.find((r) => Math.abs(r.x0 - drawn.x) < 0.001);
    expect(strike).toBeTruthy();
    expect(strike!.x1 - strike!.x0).toBeCloseTo(AVAILABLE_WIDTH, 6);
  });

  it("underlines the '####' MARKER, not the number the marker replaced", () => {
    // An explicit format cannot negotiate, so this lands on the marker rung.
    const { glyphs, rules } = render(LONG_NUMBER, {
      underline: "single" as UnderlineStyle,
      numberFormat: "Number (4 decimals)",
    });
    const drawn = glyphs[glyphs.length - 1];
    expect(drawn.text, "the number was replaced by ASCII hashes").toMatch(/^#+$/);
    // The marker is sized to the box, so its rule is the marker's own width and
    // has nothing to do with the 19-character value underneath it.
    const markerWidth = drawn.text.length * CHAR_WIDTH;
    expect(markerWidth).toBeLessThanOrEqual(AVAILABLE_WIDTH);

    const underline = rules.find((r) => Math.abs(r.x0 - drawn.x) < 0.001);
    expect(underline, "an underline was drawn starting at the marker origin").toBeTruthy();
    expect(underline!.x1 - underline!.x0).toBeCloseTo(markerWidth, 6);
  });

  it("still underlines the whole of a value that FITS", () => {
    const { glyphs, rules } = render(SHORT, { underline: "single" as UnderlineStyle });
    const drawn = glyphs[glyphs.length - 1];
    expect(drawn.text).toBe(SHORT);

    const underline = rules.find((r) => Math.abs(r.x0 - drawn.x) < 0.001);
    expect(underline).toBeTruthy();
    expect(underline!.x1 - underline!.x0).toBeCloseTo(SHORT.length * CHAR_WIDTH, 6);
  });

  it("right-aligned text keeps its rule under the glyphs it was drawn at", () => {
    const { glyphs, rules } = render(SHORT, {
      underline: "single" as UnderlineStyle,
      textAlign: "right",
    });
    const drawn = glyphs[glyphs.length - 1];
    // Right alignment shifts the glyph origin; the rule must shift with it.
    const underline = rules.find((r) => Math.abs(r.x0 - drawn.x) < 0.001);
    expect(underline, "the rule starts where the glyphs start").toBeTruthy();
    expect(underline!.x1 - underline!.x0).toBeCloseTo(SHORT.length * CHAR_WIDTH, 6);
  });

  it("an ACCOUNTING underline still spans the whole cell, truncation or not", () => {
    const { rules } = render(LONG, { underline: "singleAccounting" as UnderlineStyle });
    const spanning = rules.find((r) => Math.abs(r.x1 - r.x0 - AVAILABLE_WIDTH) < 0.001);
    expect(spanning, "accounting underlines are cell-wide by design").toBeTruthy();
  });
});
