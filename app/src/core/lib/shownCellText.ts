//! FILENAME: app/src/core/lib/shownCellText.ts
// PURPOSE: The text a GENERAL number cell SHOWS at its column's width -- what
//          Increase / Decrease Decimal counts its decimals from (BUG-0355).
// CONTEXT: Excel 16 [LIVE, 2026-11-04, lane multiarea probe3]: 1234.5678 in a
//          default column shows `1234,568` (General drops decimals until the
//          number fits, then goes scientific), and Increase Decimal makes it
//          `0.0000`, Decrease `0.00` -- counted from the SHOWN decimals. The
//          backend formats without a width, so it counted the full rendering
//          (`1234.5678`, 4) and gave `0.00000`. The grid's own ladder decides
//          what is shown: `fitNumericDisplay` (rendering/overflowMarker.ts),
//          measured at the font the cell paints with (`buildCellFont`, the one
//          the renderer and AutoFit use) inside the width the painter gives the
//          text -- the column less its inset each side (cells.ts `paddingX`, as
//          layout/autoFit.ts measures it) and the indent the painter draws
//          (layout/cellIndent.ts). Read-only, and never throws: no answer
//          (anything but a General number, no grid, no canvas) is `null`, and
//          the step then counts the full rendering as before.

import { getCell, getStyle } from "./tauri-api";
import { getGridStateSnapshot } from "../state/GridContext";
import { getColumnWidth } from "./gridRenderer/layout/dimensions";
import { effectiveIndentPx } from "./gridRenderer/layout/cellIndent";
import { buildCellFont } from "./gridRenderer/fonts";
import { fitNumericDisplay, isGeneralFormat, parseGeneralNumber } from "./gridRenderer/rendering/overflowMarker";
import { getActiveGridTheme } from "../theme/skinLoader";
import type { StyleData } from "../types";

/** The painter's text inset on each side of a cell (cells.ts `paddingX`). */
const TEXT_INSET_PX = 3;

let measureCtx: CanvasRenderingContext2D | null = null;

function measureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Test seam: a measuring context (jsdom has no canvas). */
export function setShownTextMeasureContextForTesting(ctx: CanvasRenderingContext2D | null): void {
  measureCtx = ctx;
}

/**
 * The text `display` -- a General number's full rendering -- shows in a column
 * `columnWidth` pixels wide, at `style`'s font. Pure over the measuring
 * context. `null` when it is not a General number or nothing fits (`####`).
 */
export function shownGeneralText(
  display: string,
  style: StyleData | undefined,
  columnWidth: number,
  theme: { cellFontFamily: string; cellFontSize: number },
  ctx: CanvasRenderingContext2D,
): string | null {
  if (!isGeneralFormat(style?.numberFormat ?? "General") || parseGeneralNumber(display) === null) return null;
  ctx.font = buildCellFont(
    style?.italic ? "italic" : "normal",
    style?.bold ? "bold" : "normal",
    style?.fontSize || theme.cellFontSize,
    style?.fontFamily || theme.cellFontFamily,
  );
  const availableWidth =
    columnWidth - TEXT_INSET_PX * 2 - effectiveIndentPx(style?.textAlign, (style as { indent?: number } | undefined)?.indent);
  const fit = fitNumericDisplay({
    display,
    numberFormat: style?.numberFormat ?? "General",
    availableWidth,
    measure: (text) => ctx.measureText(text).width,
  });
  return fit.marker ? null : fit.text;
}

/**
 * What the ACTIVE sheet's (row, col) shows, when it holds a General number:
 * read from the backend (its display and style) and Core's column width.
 * `null` otherwise, and on any failure.
 */
export async function shownGeneralTextAt(row: number, col: number): Promise<string | null> {
  try {
    const snapshot = getGridStateSnapshot();
    const ctx = measureContext();
    if (!snapshot || !ctx) return null;
    const cell = await getCell(row, col);
    if (!cell || !cell.display) return null;
    const style = await getStyle(cell.styleIndex ?? 0);
    const width = getColumnWidth(col, snapshot.config, snapshot.dimensions);
    const theme = getActiveGridTheme();
    return shownGeneralText(cell.display, style, width, theme, ctx);
  } catch {
    return null;
  }
}
