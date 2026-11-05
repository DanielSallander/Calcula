//! FILENAME: app/src/core/lib/gridRenderer/rendering/hideValue.test.ts
// PURPOSE: A conditional format's Show Bar Only / Show Icon Only hides the cell's
//          VALUE in every cell painter (BUG-0511).
// CONTEXT: The rule options `showValue` (data bar) and `showIconOnly` (icon set)
//          had no reader anywhere in the app: the value was always painted. The
//          backend now flags the result (`hideValue`), the CF fold turns it into
//          the style override `hideValue`, and the painters skip the text pass
//          -- the grid, a frozen pane, and a floating grid's cell box. Asserted at
//          the interceptor seam, as frozenPaneInterceptors.test.ts does, so no CF
//          rule engine is needed here.

import { describe, it, expect, afterEach } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import { registerStyleInterceptor, unregisterStyleInterceptor } from "../../../../api/styleInterceptors";
import { conditionalResultsToOverride } from "../../../../api/conditionalFormatPaint";
import { paintStyledCellBox } from "./styledCellBox";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  cellKey,
  type CellData,
  type CellDataMap,
  type StyleDataMap,
  type Viewport,
} from "../../../types";

const INTERCEPTOR_ID = "bug-0511-hide-value";
const VALUE = "12345";

afterEach(() => unregisterStyleInterceptor(INTERCEPTOR_ID));

function makeCtx(): { ctx: CanvasRenderingContext2D; texts: string[]; fills: string[] } {
  const texts: string[] = [];
  const fills: string[] = [];
  const api: Record<string, unknown> = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    canvas: { width: 600, height: 300 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getLineDash: () => [],
    fillText: (t: string) => texts.push(String(t)),
    fillRect: () => fills.push(String(api.fillStyle)),
  };
  for (const name of [
    "save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "rect", "arc", "clip", "fill",
    "stroke", "strokeRect", "clearRect", "strokeText", "setLineDash", "translate", "rotate", "scale",
  ]) {
    api[name] = () => {};
  }
  return { ctx: api as unknown as CanvasRenderingContext2D, texts, fills };
}

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 10, colCount: 6 };

function renderTexts(freeze?: { freezeRow: number; freezeCol: number }): { texts: string[]; fills: string[] } {
  const styles: StyleDataMap = new Map([[0, DEFAULT_STYLE]]);
  const cells: CellDataMap = new Map();
  cells.set(cellKey(3, 2), { row: 3, col: 2, display: VALUE, formula: null, styleIndex: 0 } as CellData);
  const { ctx, texts, fills } = makeCtx();
  renderGrid(
    ctx, 600, 300, { ...DEFAULT_GRID_CONFIG, totalRows: 50, totalCols: 20 }, VIEWPORT, null, null, cells,
    DEFAULT_THEME, [], { columnWidths: new Map(), rowHeights: new Map() }, styles,
    null, null, "move", null, "none", 0, null, freeze,
  );
  return { texts, fills };
}

function hideAt(row: number, col: number): void {
  registerStyleInterceptor(INTERCEPTOR_ID, (_v, _s, coords) =>
    coords.row === row && coords.col === col ? { hideValue: true, backgroundColor: "#ccddee" } : null,
  );
}

describe("Show Bar Only / Show Icon Only hides the value (BUG-0511)", () => {
  it("control: the value paints without the flag", () => {
    expect(renderTexts().texts).toContain(VALUE);
  });

  it("the grid paints the cell's fill but not its value", () => {
    hideAt(3, 2);
    const { texts, fills } = renderTexts();
    expect(texts).not.toContain(VALUE);
    expect(fills, "the rest of the cell still paints").toContain("#ccddee");
  });

  it("a frozen pane hides it too (one painter)", () => {
    hideAt(3, 2);
    expect(renderTexts({ freezeRow: 2, freezeCol: 1 }).texts).not.toContain(VALUE);
  });

  it("the CF fold carries the backend's flag into the override", () => {
    expect(conditionalResultsToOverride([{ row: 0, col: 0, format: {}, hideValue: true, iconIndex: 0 }]))
      .toMatchObject({ hideValue: true });
    expect(conditionalResultsToOverride([{ row: 0, col: 0, format: {}, iconIndex: 0 }])).toBeNull();
  });

  it("a floating grid's cell box hides it as well", () => {
    const shown = makeCtx();
    paintStyledCellBox(shown.ctx, { x: 0, y: 0, width: 80, height: 20 }, { cell: { display: VALUE }, style: DEFAULT_STYLE, valueKind: "number" });
    expect(shown.texts).toContain(VALUE);
    const hidden = makeCtx();
    paintStyledCellBox(hidden.ctx, { x: 0, y: 0, width: 80, height: 20 }, {
      cell: { display: VALUE },
      style: DEFAULT_STYLE,
      valueKind: "number",
      conditional: { hideValue: true },
    });
    expect(hidden.texts).not.toContain(VALUE);
  });
});
