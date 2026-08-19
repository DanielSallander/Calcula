//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.ts
// PURPOSE: Cell text rendering with style support
// CONTEXT: Draws cell content with formatting, colors, and truncation
// UPDATED: Added style interceptor support for conditional formatting
// UPDATED: Added vertical alignment, text wrapping, text rotation, and empty cell background rendering

import type { RenderState } from "../types";
import type { RichTextRun, AccountingLayout, UnderlineStyle } from "../../../types";
import { formulaA1ToR1C1 } from "../../r1c1";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { getStyleFromCache, isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "../styles/styleUtils";
// `isNumericValue` is no longer called here: the value-vs-text question is
// asked once, by `classifyCellContent`, which consults the number format as
// well as the string. It still lives in cellFormatting.ts and is still what
// that function falls back to for a General cell.
import { isErrorValue } from "../styles/cellFormatting";
import { cellKey } from "../../../types";
import {
  hasStyleInterceptors,
  applyStyleInterceptors,
  type BaseStyleInfo
} from "../../../../api/styleInterceptors";
import {
  hasCellDecorations,
  applyCellDecorations,
  type CellDecorationContext,
} from "../../../../api/cellDecorations";
import {
  hasCellTypes,
  getCellTypeAt,
  renderCellTypeCell,
} from "../../../../api/cellTypes";
import { drawCellFill } from "../styles/fillRenderer";
import { buildMergeSlaveIndex } from "./mergeIndex";
import {
  classifyCellContent,
  fitNumericDisplay,
  blocksSpill,
  type CellContentKind,
} from "./overflowMarker";
import { pointsToPixels, buildCellFont } from "../fonts";
import { rowHeaderGutter, colHeaderGutter } from "../layout/headerVisibility";

// ============================================================================
// Over-selection cell decorations
// ============================================================================

/** An inclusive cell rectangle covered by selection chrome. */
export interface ChromeRect {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

/**
 * The cell rectangles that selection chrome paints over this frame: the main
 * selection, every Ctrl+click additional range, and the clipboard (marching
 * ants) range.
 *
 * Only decorations on THESE cells need replaying above the chrome — everywhere
 * else nothing paints between the cell pass and the replay point, so the output
 * is identical and the work is skipped.
 */
export function collectChromeRects(state: RenderState): ChromeRect[] {
  const rects: ChromeRect[] = [];
  const push = (r: { startRow: number; endRow: number; startCol: number; endCol: number }) => {
    rects.push({
      minRow: Math.min(r.startRow, r.endRow),
      maxRow: Math.max(r.startRow, r.endRow),
      minCol: Math.min(r.startCol, r.endCol),
      maxCol: Math.max(r.startCol, r.endCol),
    });
  };

  const { selection, clipboardSelection, clipboardMode } = state;
  if (selection) {
    push(selection);
    if (selection.additionalRanges) {
      for (const range of selection.additionalRanges) push(range);
    }
  }
  if (clipboardSelection && clipboardMode && clipboardMode !== "none") {
    push(clipboardSelection);
  }
  return rects;
}

export function isCoveredByChrome(rects: ChromeRect[], row: number, col: number): boolean {
  for (const r of rects) {
    if (row >= r.minRow && row <= r.maxRow && col >= r.minCol && col <= r.maxCol) {
      return true;
    }
  }
  return false;
}

/**
 * One captured "over-selection" decoration, waiting for the selection chrome to
 * be down.
 *
 * `clip` is the PANE the cell was painted in, and it is not optional detail:
 * with frozen or split panes the cell pass runs inside `renderZone`'s clip, and
 * the replay happens long after that clip was restored. Without carrying it, a
 * decoration captured in one pane could paint over another.
 */
export interface DeferredCellDecoration {
  context: CellDecorationContext;
  clip: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Replay the decorations captured by {@link drawCellText} above the selection
 * chrome.
 *
 * WHY REPLAY RATHER THAN A SECOND LOOP. The cell pass already owns the
 * geometry — visible range, merge masters, insertion-animation offsets, header
 * clipping. A second loop would have to reproduce all of it and would drift
 * from it on the first change to either. Capturing the already-computed
 * contexts costs one object per chrome-covered cell (one, for the usual
 * single-cell selection) and cannot disagree with the pass that produced it.
 */
export function drawDeferredCellDecorations(deferred: DeferredCellDecoration[]): void {
  for (const { context, clip } of deferred) {
    if (clip) {
      context.ctx.save();
      context.ctx.beginPath();
      context.ctx.rect(clip.x, clip.y, clip.width, clip.height);
      context.ctx.clip();
    }
    applyCellDecorations(context, "over-selection");
    if (clip) context.ctx.restore();
  }
}

/**
 * What a call to {@link drawTextWithTruncationMetrics} actually put on the canvas.
 *
 * `fullWidth` is the width the whole string would occupy — the overflow signal
 * callers use to decide whether a cell spills into its neighbour.
 * `renderedWidth` / `renderedX` describe the glyphs that were really drawn.
 *
 * The two used to differ because an over-long string was ELLIPSISED, and a
 * decoration measured on `fullWidth` (clamped to the cell) was therefore drawn
 * wider than the text it decorated: "Quarterly reven..." got an underline the
 * length of the whole cell. Excel does not ellipsise — it CLIPS at the cell edge
 * mid-glyph — so the glyph run now really is the whole string and the clip
 * rectangle cuts it. `renderedWidth` is that whole-string width; callers still
 * clamp it to the cell, and the clamp and the clip agree by construction.
 */
export interface DrawnTextMetrics {
  /** Width of the full string at the current font. */
  fullWidth: number;
  /** Width of the glyph run actually passed to fillText. */
  renderedWidth: number;
  /** Left edge of the glyphs actually painted. */
  renderedX: number;
  /** True when the string did not fit and was clipped at the cell edge. */
  truncated: boolean;
}

/**
 * Draw text, letting the caller's clip rectangle cut it where it does not fit,
 * and report what was drawn.
 *
 * EXCEL'S RULE, AND WHY THERE IS NO ELLIPSIS. Excel clips an over-long value
 * mid-glyph; it never prints "..." and never prints a Unicode ellipsis. Drawing
 * the whole string inside the clip the cell pass has already established
 * reproduces that exactly — and is strictly cheaper than what it replaced, which
 * binary-searched the truncation point with O(log n) `measureText` calls per
 * over-long cell.
 *
 * Decorations (underline, strikethrough) MUST measure against the returned
 * `renderedWidth`/`renderedX`, never against the source string.
 */
export function drawTextWithTruncationMetrics(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: "left" | "right" | "center" = "left",
  /**
   * Width of `text` at the current font, when the caller has already measured
   * it. `measureText` is the single most-called thing on this path, and the
   * numeric branch has necessarily measured its candidate already; without this
   * every numeric cell in the viewport would pay for the same measurement twice.
   */
  knownWidth?: number
): DrawnTextMetrics {
  const textWidth = knownWidth ?? ctx.measureText(text).width;

  // If text fits, draw it directly
  if (textWidth <= maxWidth) {
    let drawX = x;
    if (align === "right") {
      drawX = x + maxWidth - textWidth;
    } else if (align === "center") {
      drawX = x + (maxWidth - textWidth) / 2;
    }
    ctx.fillText(text, drawX, y);
    return {
      fullWidth: textWidth,
      renderedWidth: textWidth,
      renderedX: drawX,
      truncated: false,
    };
  }
  // Does not fit: paint the whole string from the cell's own origin and let the
  // clip cut it. A value that has run out of room fills the box regardless of
  // alignment, so the rendered origin is `x` — the same origin the ellipsised
  // version used, which keeps the START of the value visible.
  ctx.fillText(text, x, y);
  return {
    fullWidth: textWidth,
    renderedWidth: textWidth,
    renderedX: x,
    truncated: true,
  };
}

/**
 * Draw text, clipped at the available width by the caller's clip rectangle.
 * Returns the measured width of the FULL text (the overflow signal).
 */
export function drawTextWithTruncation(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: "left" | "right" | "center" = "left"
): number {
  return drawTextWithTruncationMetrics(ctx, text, x, y, maxWidth, align).fullWidth;
}

/**
 * Superscript/subscript scale factor relative to base font size.
 */
const SCRIPT_SCALE = 0.65;
/** Superscript vertical offset as fraction of base font size (negative = up). */
const SUPERSCRIPT_OFFSET = -0.35;
/** Subscript vertical offset as fraction of base font size (positive = down). */
const SUBSCRIPT_OFFSET = 0.2;

/**
 * Draw rich text runs within a cell.
 * Each run can have its own bold, italic, underline, strikethrough, color,
 * font size, font family, superscript, and subscript formatting.
 *
 * Returns the total measured width of all runs (may exceed maxWidth).
 */
export function drawRichTextRuns(
  ctx: CanvasRenderingContext2D,
  runs: RichTextRun[],
  x: number,
  y: number,
  maxWidth: number,
  align: "left" | "right" | "center",
  baseFontSize: number,
  baseFontFamily: string,
  baseFontWeight: string,
  baseFontStyle: string,
  baseTextColor: string,
  baseBold: boolean,
  baseItalic: boolean,
  baseUnderline: boolean,
  baseStrikethrough: boolean,
): number {
  // First pass: measure all runs to determine total width and check if truncation is needed
  interface MeasuredRun {
    run: RichTextRun;
    fontSize: number;
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
    color: string;
    fontString: string;
    width: number;
    hasUnderline: boolean;
    hasStrikethrough: boolean;
    superscript: boolean;
    subscript: boolean;
  }

  const measured: MeasuredRun[] = [];
  let totalWidth = 0;

  for (const run of runs) {
    const isBold = run.bold ?? baseBold;
    const isItalic = run.italic ?? baseItalic;
    const isSuperscript = run.superscript === true;
    const isSubscript = run.subscript === true;

    let fontSize = run.fontSize ?? baseFontSize;
    if (isSuperscript || isSubscript) {
      fontSize = Math.round(fontSize * SCRIPT_SCALE);
    }

    const fontFamily = run.fontFamily ?? baseFontFamily;
    const fontWeight = isBold ? "bold" : "normal";
    const fontStyle = isItalic ? "italic" : "normal";
    const color = run.color ?? baseTextColor;
    // fontSize is in POINTS (rich-text runs and base size are stored as points);
    // buildCellFont converts to pixels for the canvas.
    const fontString = buildCellFont(fontStyle, fontWeight, fontSize, fontFamily);

    ctx.font = fontString;
    const width = ctx.measureText(run.text).width;

    measured.push({
      run,
      fontSize,
      fontFamily,
      fontWeight,
      fontStyle,
      color,
      fontString,
      width,
      hasUnderline: run.underline != null ? run.underline !== "none" : baseUnderline,
      hasStrikethrough: run.strikethrough ?? baseStrikethrough,
      superscript: isSuperscript,
      subscript: isSubscript,
    });
    totalWidth += width;
  }

  // Calculate draw start X based on alignment
  let drawX = x;
  if (totalWidth <= maxWidth) {
    if (align === "right") {
      drawX = x + maxWidth - totalWidth;
    } else if (align === "center") {
      drawX = x + (maxWidth - totalWidth) / 2;
    }
  }

  // Over-long rich text is CLIPPED at the cell edge, exactly as plain text is:
  // rich text is text by construction, so Excel's `####` never applies to it and
  // an ellipsis is not Excel's marker either. Every run is drawn in full and the
  // caller's clip rectangle cuts the overhang; runs that start beyond the box are
  // skipped so a long value does not cost a fillText per run for nothing.
  const needsTruncation = totalWidth > maxWidth;
  const remainingWidth = maxWidth;

  // Second pass: draw each run
  let currentX = drawX;

  for (const m of measured) {
    // A run that begins past the right edge of the box has nothing visible to
    // contribute — the clip would swallow every glyph of it — so stop.
    if (needsTruncation && currentX - drawX >= remainingWidth) break;

    ctx.font = m.fontString;
    ctx.fillStyle = m.color;

    const textToDraw = m.run.text;
    const drawWidth = m.width;

    // Calculate vertical offset for superscript/subscript (offset is in px)
    const baseFontPx = pointsToPixels(baseFontSize);
    let runY = y;
    if (m.superscript) {
      runY = y + baseFontPx * SUPERSCRIPT_OFFSET;
    } else if (m.subscript) {
      runY = y + baseFontPx * SUBSCRIPT_OFFSET;
    }

    // Draw the text
    if (textToDraw.length > 0) {
      ctx.fillText(textToDraw, currentX, runY);
    }

    // Draw underline
    if (m.hasUnderline && textToDraw.length > 0) {
      const underlineY = runY + pointsToPixels(m.fontSize) / 2 + 1;
      ctx.beginPath();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.moveTo(currentX, underlineY);
      ctx.lineTo(currentX + drawWidth, underlineY);
      ctx.stroke();
    }

    // Draw strikethrough
    if (m.hasStrikethrough && textToDraw.length > 0) {
      const strikeY = runY;
      ctx.beginPath();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.moveTo(currentX, strikeY);
      ctx.lineTo(currentX + drawWidth, strikeY);
      ctx.stroke();
    }

    currentX += drawWidth;
  }


  return totalWidth;
}

/**
 * Calculate the total width of a merged cell spanning multiple columns.
 */
function getMergedCellWidth(
  startCol: number,
  colSpan: number,
  config: RenderState["config"],
  dimensions: RenderState["dimensions"]
): number {
  let totalWidth = 0;
  for (let c = startCol; c < startCol + colSpan; c++) {
    totalWidth += getColumnWidth(c, config, dimensions);
  }
  return totalWidth;
}

/**
 * Calculate the total height of a merged cell spanning multiple rows.
 */
function getMergedCellHeight(
  startRow: number,
  rowSpan: number,
  config: RenderState["config"],
  dimensions: RenderState["dimensions"]
): number {
  let totalHeight = 0;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    totalHeight += getRowHeight(r, config, dimensions);
  }
  return totalHeight;
}

/**
 * Break text into lines that fit within maxWidth.
 * Uses word-boundary wrapping with fallback to character wrapping for long words.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/(\s+)/); // Split keeping whitespace
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine + word;
    const testWidth = ctx.measureText(testLine).width;

    if (testWidth <= maxWidth || currentLine === "") {
      currentLine = testLine;
    } else {
      // Current line is full, push it and start new line
      if (currentLine.trim() !== "") {
        lines.push(currentLine);
      }
      // Check if the word itself is wider than maxWidth (needs character wrapping)
      if (ctx.measureText(word).width > maxWidth) {
        let remaining = word;
        while (remaining.length > 0) {
          let charCount = 1;
          while (charCount < remaining.length && ctx.measureText(remaining.substring(0, charCount + 1)).width <= maxWidth) {
            charCount++;
          }
          if (charCount < remaining.length) {
            lines.push(remaining.substring(0, charCount));
            remaining = remaining.substring(charCount);
          } else {
            currentLine = remaining;
            remaining = "";
          }
        }
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine.trim() !== "") {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * The line weight a border STYLE paints at, in logical pixels. The style string
 * decides the weight; `BorderSideData.width` is the backend's 0..3 weight and is
 * read only as an on/off gate at the call sites. Exported so the border pass can
 * resolve a contested boundary by weight without a second copy of this map.
 */
export function borderLineWidth(style: string): number {
  if (style === "medium") return 2;
  if (style === "thick") return 3;
  return 1;
}

/**
 * The four EDGE borders a cell actually shows, after conditional formatting has
 * had its say. Exported because TWO painters need it and a copy would drift:
 * `drawCellText` (the ordinary grid) and `drawCellTextZone` (every frozen or
 * split pane). The second one drew no borders at all until 2026-08-19 — BUG-0102.
 *
 * Diagonals are deliberately NOT included: they are interior lines, they stay
 * inside the per-cell clip, and only the four edges participate in the
 * straddle/dedupe pass.
 */
export function resolveEdgeBorders(
  effectiveStyle: {
    borderTopColor?: string; borderTopStyle?: string;
    borderRightColor?: string; borderRightStyle?: string;
    borderBottomColor?: string; borderBottomStyle?: string;
    borderLeftColor?: string; borderLeftStyle?: string;
  },
  baseCellStyle: {
    borderTop?: { style: string; color: string; width: number };
    borderRight?: { style: string; color: string; width: number };
    borderBottom?: { style: string; color: string; width: number };
    borderLeft?: { style: string; color: string; width: number };
  },
): {
  top?: { style: string; color: string; width: number };
  right?: { style: string; color: string; width: number };
  bottom?: { style: string; color: string; width: number };
  left?: { style: string; color: string; width: number };
} {
  const visible = (b?: { style: string; color: string; width: number }) =>
    b && b.style !== "none" && b.width > 0 ? b : undefined;
  return {
    top: visible(
      effectiveStyle.borderTopColor
        ? { style: effectiveStyle.borderTopStyle || "solid", color: effectiveStyle.borderTopColor, width: 1 }
        : baseCellStyle.borderTop,
    ),
    right: visible(
      effectiveStyle.borderRightColor
        ? { style: effectiveStyle.borderRightStyle || "solid", color: effectiveStyle.borderRightColor, width: 1 }
        : baseCellStyle.borderRight,
    ),
    bottom: visible(
      effectiveStyle.borderBottomColor
        ? { style: effectiveStyle.borderBottomStyle || "solid", color: effectiveStyle.borderBottomColor, width: 1 }
        : baseCellStyle.borderBottom,
    ),
    left: visible(
      effectiveStyle.borderLeftColor
        ? { style: effectiveStyle.borderLeftStyle || "solid", color: effectiveStyle.borderLeftColor, width: 1 }
        : baseCellStyle.borderLeft,
    ),
  };
}

/**
 * Stroke a cell's four EDGE borders directly.
 *
 * Used by the PANE painter, which has no frame-wide deferred queue: a pane is
 * clipped to itself and repainted as a unit, so the straddle-and-dedupe pass the
 * ordinary grid runs has nothing to attach to. Borders inside a pane are
 * therefore drawn in place — they can still be clipped at the pane edge, which
 * is correct, because that is where the pane ends.
 */
export function strokeEdgeBorders(
  ctx: CanvasRenderingContext2D,
  edges: ReturnType<typeof resolveEdgeBorders>,
  cellLeft: number,
  cellTop: number,
  cellRight: number,
  cellBottom: number,
): void {
  if (edges.top) drawBorderLine(ctx, cellLeft, cellTop, cellRight, cellTop, edges.top);
  if (edges.bottom) drawBorderLine(ctx, cellLeft, cellBottom, cellRight, cellBottom, edges.bottom);
  if (edges.left) drawBorderLine(ctx, cellLeft, cellTop, cellLeft, cellBottom, edges.left);
  if (edges.right) drawBorderLine(ctx, cellRight, cellTop, cellRight, cellBottom, edges.right);
}

/** One cell EDGE border, captured during the cell pass and stroked afterwards. */
interface QueuedBorder {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  border: { style: string; color: string; width: number };
}

/**
 * Draw a single border line between two points with the given border style.
 */
export function drawBorderLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  border: { style: string; color: string; width: number }
): void {
  ctx.save();
  ctx.strokeStyle = border.color;

  const lineWidth = borderLineWidth(border.style);

  // DEVICE-PIXEL SNAPPING. The canvas transform is a pure scale by
  // devicePixelRatio*zoom, so a logical coordinate must be taken into DEVICE
  // space before it can be snapped at all. `drawGridLines` has always done this
  // for its hairline (rendering/grid.ts:189-191); borders never did. Because row
  // boundaries are integral (defaultCellHeight 20) while column boundaries are
  // not (defaultCellWidth 64.29, core/types/types.ts:256), on a dpr-1 machine
  // every VERTICAL border smeared across two partially covered device pixels
  // while horizontal ones came out solid.
  //
  // MEASURED, from the trace of the test that caught this: the 5x12 probe band
  // on the right edge of X63 held, on every one of its 12 rows,
  //     255,255,255 | 255,107,107 | 238,131,131 | 255,255,255 | 255,255,255
  // i.e. one red line spread over two pixels at ~58%/42% -- against a predicate
  // needing >=64.7% coverage, so it read as NO red at all. The top edge of the
  // same outline was a single fully covered row of pure 255,0,0.
  //
  // A stroke of W device pixels centred at device coordinate d covers
  // [d - W/2, d + W/2], which lands on whole device pixels only when d - W/2 is
  // an integer: an ODD W must sit on a pixel CENTRE, an EVEN W on a pixel EDGE.
  // Worked, boundary x = 150.58 (rowHeaderWidth 22 + 2 * 64.29):
  //   dpr 1  thin   -> 151.5, lw 1 -> device [151,152]   (the pixel grid.ts picks)
  //   dpr 1  medium -> 151,   lw 2 -> device [150,152]   (the smear, gone)
  //   dpr 1  thick  -> 151.5, lw 3 -> device [150,153]
  //   dpr 2  medium -> 150.5, lw 2 -> device [299,303]
  // For W = 1 at dpr 1 this reduces algebraically to grid.ts:191, which is why
  // the odd case uses Math.round(d) + 0.5 rather than the nearer-centre form: a
  // thin border must land on the SAME device pixel as the gridline it replaces,
  // or toggling gridlines would shift it.
  const deviceScale = (ctx.getTransform?.().a) || 1;
  const deviceWidth = Math.max(1, Math.round(lineWidth * deviceScale));
  ctx.lineWidth = deviceWidth / deviceScale;
  const snap = (v: number): number => {
    const edge = Math.round(v * deviceScale);
    return (deviceWidth % 2 === 1 ? edge + 0.5 : edge) / deviceScale;
  };

  // Set dash pattern
  if (border.style === "dashed") {
    ctx.setLineDash([4, 2]);
  } else if (border.style === "dotted") {
    ctx.setLineDash([1, 2]);
  } else {
    ctx.setLineDash([]);
  }

  const isHorizontal = y1 === y2;
  const isVertical = x1 === x2;

  if (border.style === "double") {
    // Double border: two 1-device-px rules with a gap.
    //
    // BOTH RULES COME FROM ONE SNAPPED BOUNDARY. Snapping each rule
    // independently is what breaks: Math.round ties UP, so on an INTEGRAL
    // boundary (row boundaries are integral) y-1.5 and y+1.5 round the SAME
    // direction and the whole ornament shifts one device pixel off the boundary.
    //   dpr 1, y = 180: today 178.5/181.5 (device 178 and 181, centred on 180)
    //                   per-rule snap 179.5/182.5 (centred 181) -- WRONG
    //                   derived below  178.5/181.5 -- identical to today
    //   dpr 1, x = 150.58: today 149.08/152.08 (blurred)
    //                   derived 149.5/152.5, symmetric about the snapped 151
    // So this is provably a NO-OP on the axis that is already crisp, and only
    // sharpens the fractional (vertical) one.
    const offset = 1.5;
    const halfIn = deviceWidth % 2 === 1 ? 0.5 : 0;
    const rules = (v: number): [number, number] => {
      const dEdge = Math.round(v * deviceScale);
      const dGap = Math.max(1, Math.round(offset * deviceScale));
      return [(dEdge - dGap + halfIn) / deviceScale, (dEdge + dGap - halfIn) / deviceScale];
    };

    if (isHorizontal) {
      const [near, far] = rules(y1);
      ctx.beginPath();
      ctx.moveTo(x1, near);
      ctx.lineTo(x2, near);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, far);
      ctx.lineTo(x2, far);
      ctx.stroke();
    } else if (isVertical) {
      const [near, far] = rules(x1);
      ctx.beginPath();
      ctx.moveTo(near, y1);
      ctx.lineTo(near, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(far, y1);
      ctx.lineTo(far, y2);
      ctx.stroke();
    } else {
      // Diagonal line: offset perpendicular to the line direction
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len * offset;
      const ny = dx / len * offset;
      ctx.beginPath();
      ctx.moveTo(x1 + nx, y1 + ny);
      ctx.lineTo(x2 + nx, y2 + ny);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1 - nx, y1 - ny);
      ctx.lineTo(x2 - nx, y2 - ny);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    if (isVertical) {
      ctx.moveTo(snap(x1), y1);
      ctx.lineTo(snap(x2), y2);
    } else if (isHorizontal) {
      ctx.moveTo(x1, snap(y1));
      ctx.lineTo(x2, snap(y2));
    } else {
      // Diagonal: snapping one axis of a diagonal only skews it.
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draw text content for all visible cells.
 * Applies cell styles from styleCache including colors, fonts, and formatting.
 * Handles merged cells by drawing master cells with expanded dimensions.
 * Applies style interceptors for features like conditional formatting.
 */
export function drawCellText(state: RenderState): DeferredCellDecoration[] {
  const { ctx, width, height, config, viewport, theme, cells, editing, dimensions, styleCache, insertionAnimation } = state;
  const rowHeaderWidth = rowHeaderGutter(config);
  const colHeaderHeight = colHeaderGutter(config);
  // One measure closure for the whole frame — `fitNumericDisplay` is pure and
  // takes measurement as a callback, and allocating that callback per CELL would
  // be a fresh function object per visible cell per frame. `ctx.font` is set by
  // the caller before every use, so this always measures at the painting font.
  const measureAt = (text: string) => ctx.measureText(text).width;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);

  // Padding inside cells. paddingX = 3 matches Excel's left text inset
  // (~2px pad + the 1px gridline) so the first glyph lands where Excel's does.
  const paddingX = 3;
  const paddingY = 2;

  // Check if we need to run style interceptors
  const useInterceptors = hasStyleInterceptors();

  // Decorations. Hoisted out of the per-cell loop: nothing can register or
  // unregister mid-frame, so the answers are constant for this pass.
  const useDecorations = hasCellDecorations();
  // Indicator chrome (note/error triangles, bookmark dots) declares the
  // "over-selection" anchor so the active-cell border and tint stop hiding a
  // cell's own indicator.
  //
  // Only the cells the chrome actually COVERS are deferred to the replay; on
  // every other cell the decoration is drawn here, in the normal pass. Nothing
  // paints between this point and the replay on an uncovered cell, so the frame
  // is identical either way — and deferring the whole viewport would allocate a
  // context per visible cell per frame to no effect.
  const useOverSelection = hasCellDecorations("over-selection");
  const chromeRects = useOverSelection ? collectChromeRects(state) : [];
  const deferred: DeferredCellDecoration[] = [];

  // Cell EDGE borders, held back until every background in the viewport is down.
  //
  // WHY A SECOND PASS IS REQUIRED, NOT MERELY TIDIER. A border straddles the
  // boundary it names -- a "medium" is 2px centred on the edge, so half of it
  // lies in the NEXT cell. This loop paints row-major, so cell (r,c) is finished
  // before (r,c+1). Painted in place, a RIGHT or BOTTOM border spilling forward
  // is erased the moment the neighbour fills its own background, while LEFT and
  // TOP borders spill backwards onto already-painted cells and survive. Neither
  // widening the per-cell clip nor restoring around the border pass fixes that:
  // the ORDERING is the defect, not only the clip.
  //
  // ONE STROKE PER BOUNDARY. Until now the per-cell clip left cell A's right half
  // and cell B's left half DISJOINT, so both were visible and each was half its
  // nominal weight. Full-weight strokes at the same coordinate are not disjoint:
  // a "thick" black right border and a "thin" grey left border would paint
  // black|grey|black, and an rgba border would double-composite. So contested
  // boundaries are collapsed here -- HEAVIER WINS, ties to the LATER cell,
  // preserving the row-major intuition. This IS a behaviour change on a contested
  // edge, and it is deliberate.
  //
  // Diagonals are NOT queued: they are interior lines and stay inside the
  // per-cell clip, so a 3px "thick" diagonal cannot bleed out of its own box.
  const deferredBorders = new Map<string, QueuedBorder>();
  const queueBorder = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    border: { style: string; color: string; width: number },
  ): void => {
    // Key on the RAW boundary coordinate, not the snapped one: two weights snap
    // to different coordinates (at dpr 1, x=150.58 -> medium 151, thin 151.5) and
    // would then never collide. A's cellRight and B's cellLeft are the identical
    // float, so exact equality holds.
    const key = x1 === x2 ? `v|${x1}|${y1}|${y2}` : `h|${y1}|${x1}|${x2}`;
    const prev = deferredBorders.get(key);
    if (prev && borderLineWidth(border.style) < borderLineWidth(prev.border.style)) return;
    deferredBorders.set(key, { x1, y1, x2, y2, border });
  };

  // Cell types render as their own content (suppressed in Show Formulas mode,
  // where the raw value/formula must stay visible).
  const useCellTypes = hasCellTypes() && !state.showFormulas;

  // Calculate insertion/deletion animation offset
  let rowAnimOffset = 0;
  let colAnimOffset = 0;
  let rowAnimIndex = -1;
  let colAnimIndex = -1;

  if (insertionAnimation) {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;

    if (insertionAnimation.type === "row") {
      rowAnimIndex = insertionAnimation.index;
      rowAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
    } else {
      colAnimIndex = insertionAnimation.index;
      colAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
    }
  }

  // Track which cells we've already drawn (to avoid drawing slave cells)
  const drawnCells = new Set<string>();

  // C3b: precompute slave->master once (O(cache)) instead of re-scanning the
  // whole cache for every visible cell (O(visible x cache)).
  const mergeIndex = buildMergeSlaveIndex(cells as Map<string, { rowSpan?: number; colSpan?: number }>);

  // Iterate through visible cells
  let baseY = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);

    // Apply row animation offset for rows at or after the change point
    const y = row >= rowAnimIndex && rowAnimIndex >= 0 ? baseY + rowAnimOffset : baseY;

    let baseX = rowHeaderWidth + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);

      // Apply column animation offset for columns at or after the change point
      const x = col >= colAnimIndex && colAnimIndex >= 0 ? baseX + colAnimOffset : baseX;

      const key = cellKey(row, col);

      // Skip if already drawn (slave cells)
      if (drawnCells.has(key)) {
        baseX += colWidth;
        continue;
      }

      // Check if this cell is a slave (part of another cell's merge)
      const masterKey = mergeIndex.get(key) ?? null;
      if (masterKey) {
        // This is a slave cell - skip rendering
        drawnCells.add(key);
        baseX += colWidth;
        continue;
      }

      // Skip if this cell is being edited (the input field handles display)
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }

      // Look up cell data
      const cell = cells.get(key);

      // Cell-type assignment (checkbox/progress/button ...): typed cells
      // render even when empty or without backend data.
      const cellTypeHere = useCellTypes && getCellTypeAt(row, col) !== null;

      // No cell data at all - but still apply style interceptors (e.g., table banding)
      // and cell decorations (e.g., sparklines) for cells that have no backend data.
      if (!cell) {
        const cellLeft = Math.max(x, rowHeaderWidth);
        const cellTop = Math.max(y, colHeaderHeight);
        const cellRight = Math.min(x + colWidth, width);
        const cellBottom = Math.min(y + rowHeight, height);
        if (cellRight > cellLeft && cellBottom > cellTop) {
          // Apply style interceptors for empty cells (e.g., table banded rows)
          if (useInterceptors) {
            const baseStyle: BaseStyleInfo = { styleIndex: 0 };
            const effective = applyStyleInterceptors("", baseStyle, { row, col });
            if (effective.backgroundColor && isValidColor(effective.backgroundColor) && !isDefaultBackgroundColor(effective.backgroundColor)) {
              ctx.fillStyle = effective.backgroundColor;
              ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
            }
            // Draw CF border overrides on empty cells
            if (effective.borderTopColor) {
              queueBorder(cellLeft, cellTop, cellRight, cellTop, { style: effective.borderTopStyle || "solid", color: effective.borderTopColor, width: 1 });
            }
            if (effective.borderBottomColor) {
              queueBorder(cellLeft, cellBottom, cellRight, cellBottom, { style: effective.borderBottomStyle || "solid", color: effective.borderBottomColor, width: 1 });
            }
            if (effective.borderLeftColor) {
              queueBorder(cellLeft, cellTop, cellLeft, cellBottom, { style: effective.borderLeftStyle || "solid", color: effective.borderLeftColor, width: 1 });
            }
            if (effective.borderRightColor) {
              queueBorder(cellRight, cellTop, cellRight, cellBottom, { style: effective.borderRightStyle || "solid", color: effective.borderRightColor, width: 1 });
            }
          }
          if (useDecorations || useOverSelection) {
            const decorationContext: CellDecorationContext = {
              ctx, row, col,
              cellLeft, cellTop, cellRight, cellBottom,
              config, viewport, dimensions,
              display: "",
              styleIndex: 0,
              styleCache,
            };
            if (useDecorations) applyCellDecorations(decorationContext);
            if (useOverSelection) {
              if (isCoveredByChrome(chromeRects, row, col)) deferred.push({ context: decorationContext, clip: null });
              else applyCellDecorations(decorationContext, "over-selection");
            }
          }
          if (cellTypeHere) {
            renderCellTypeCell({
              ctx, row, col,
              cellLeft, cellTop, cellRight, cellBottom,
              config, viewport, dimensions,
              display: "",
              styleIndex: 0,
              styleCache,
            });
          }
        }
        baseX += colWidth;
        continue;
      }

      // In Show Formulas mode, display "=formula" for formula cells
      // (converted to R1C1 notation when that reference style is active).
      const rawDisplay = cell.display ?? "";
      let displayValue = (state.showFormulas && cell.formula)
        ? (state.referenceStyle === "R1C1"
            ? formulaA1ToR1C1(cell.formula, row, col)
            : cell.formula)
        : rawDisplay;

      // In Display Zeros = false mode, hide zero values for non-formula cells
      if (state.displayZeros === false && !cell.formula && displayValue !== "") {
        const num = Number(displayValue);
        if (num === 0 && !isNaN(num)) {
          displayValue = "";
        }
      }

      const isEmpty = displayValue === "";

      // Get merge spans BEFORE the empty-cell-skip check.
      // Merged master cells must never be skipped even if empty,
      // because they need to draw backgrounds/borders and mark slave cells.
      const rowSpan = (cell as { rowSpan?: number }).rowSpan ?? 1;
      const colSpan = (cell as { colSpan?: number }).colSpan ?? 1;
      const isMergedMaster = rowSpan > 1 || colSpan > 1;

      // For empty cells with default style, skip entirely (unless merged,
      // interceptors, decorations, or a cell-type assignment).
      //
      // BOTH anchors count. This used to ask `hasCellDecorations()`, which
      // answers for the UNDER-selection registry alone, so an existing-but-empty
      // unstyled cell was skipped before its note/error/bookmark indicator could
      // paint — unless some unrelated extension (Sparklines, Checkbox) happened
      // to have registered an under-selection decoration. The Review
      // extension's triangle depended on Sparklines being loaded.
      const hasDecorations = useDecorations || useOverSelection;
      if (isEmpty && !isMergedMaster && !cellTypeHere) {
        const si = cell.styleIndex ?? 0;
        if (si === 0 && !hasDecorations && !useInterceptors) {
          baseX += colWidth;
          continue;
        }
        // Cell has a non-default style - check if it has a visible background or borders
        if (si !== 0) {
          const emptyStyle = getStyleFromCache(styleCache, si);
          const hasFill = emptyStyle.fill != null && emptyStyle.fill.type !== "none";
          const hasBg = hasFill || (isValidColor(emptyStyle.backgroundColor) && !isDefaultBackgroundColor(emptyStyle.backgroundColor));
          const hasBorder = (emptyStyle.borderTop && emptyStyle.borderTop.style !== "none" && emptyStyle.borderTop.width > 0) ||
            (emptyStyle.borderRight && emptyStyle.borderRight.style !== "none" && emptyStyle.borderRight.width > 0) ||
            (emptyStyle.borderBottom && emptyStyle.borderBottom.style !== "none" && emptyStyle.borderBottom.width > 0) ||
            (emptyStyle.borderLeft && emptyStyle.borderLeft.style !== "none" && emptyStyle.borderLeft.width > 0) ||
            (emptyStyle.borderDiagonalDown && emptyStyle.borderDiagonalDown.style !== "none" && emptyStyle.borderDiagonalDown.width > 0) ||
            (emptyStyle.borderDiagonalUp && emptyStyle.borderDiagonalUp.style !== "none" && emptyStyle.borderDiagonalUp.width > 0);
          if (!hasBg && !hasBorder && !hasDecorations) {
            baseX += colWidth;
            continue;
          }
        }
      }

      // Calculate actual cell dimensions (may span multiple cells)
      const actualWidth = colSpan > 1
        ? getMergedCellWidth(col, colSpan, config, dimensions)
        : colWidth;
      const actualHeight = rowSpan > 1
        ? getMergedCellHeight(row, rowSpan, config, dimensions)
        : rowHeight;

      // Mark all cells in the merge region as drawn
      if (rowSpan > 1 || colSpan > 1) {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            drawnCells.add(cellKey(r, c));
          }
        }
      }

      // Skip if cell is not visible (considering animation offset)
      if (x + actualWidth < rowHeaderWidth || x > width || y + actualHeight < colHeaderHeight || y > height) {
        baseX += colWidth;
        continue;
      }

      // Calculate visible cell bounds
      const cellLeft = Math.max(x, rowHeaderWidth);
      const cellTop = Math.max(y, colHeaderHeight);
      const cellRight = Math.min(x + actualWidth, width);
      const cellBottom = Math.min(y + actualHeight, height);

      // Get style data from the styleCache using the cell's styleIndex
      const styleIndex = cell.styleIndex ?? 0;
      const baseCellStyle = getStyleFromCache(styleCache, styleIndex);

      // Calculate indent offset (each level = 8px at zoom 1.0)
      const indentLevel = (baseCellStyle as { indent?: number }).indent ?? 0;
      const indentOffset = indentLevel * 8;

      // Available width for text (reduced by indent) — may be extended by overflow later
      let availableWidth = cellRight - cellLeft - paddingX * 2 - indentOffset;

      if (availableWidth <= 0) {
        baseX += colWidth;
        continue;
      }

      // Build base style info for interceptors
      // Note: interceptors use boolean underline, so convert enum to bool for them
      let effectiveStyle: BaseStyleInfo = {
        styleIndex,
        backgroundColor: baseCellStyle.backgroundColor,
        textColor: baseCellStyle.textColor,
        bold: baseCellStyle.bold,
        italic: baseCellStyle.italic,
        underline: baseCellStyle.underline !== "none",
        strikethrough: baseCellStyle.strikethrough,
        fontSize: baseCellStyle.fontSize,
        fontFamily: baseCellStyle.fontFamily,
      };

      // Apply style interceptors (e.g., conditional formatting)
      if (useInterceptors) {
        effectiveStyle = applyStyleInterceptors(
          displayValue,
          effectiveStyle,
          { row, col }
        );
      }

      // Initialize style variables with theme defaults
      let textColor = theme.cellText;
      let backgroundColor: string | null = null;
      let textAlign: "left" | "right" | "center" = "left";
      let fontWeight = "normal";
      let fontStyle = "normal";
      let fontSize = theme.cellFontSize;
      let fontFamily = theme.cellFontFamily;
      // Resolve underline style: interceptors may set boolean, base style has enum
      let underlineStyle: UnderlineStyle = "none";
      let hasStrikethrough = false;

      // Apply all style properties from effectiveStyle (includes interceptor overrides)
      if (effectiveStyle.bold === true) {
        fontWeight = "bold";
      }
      if (effectiveStyle.italic === true) {
        fontStyle = "italic";
      }
      // Interceptors produce boolean underline; base style uses UnderlineStyle enum.
      // If interceptor set underline=true, use "single"; otherwise use the enum from baseCellStyle.
      if (effectiveStyle.underline === true) {
        underlineStyle = baseCellStyle.underline !== "none" ? baseCellStyle.underline : "single";
      }
      if (effectiveStyle.strikethrough === true) {
        hasStrikethrough = true;
      }

      if (typeof effectiveStyle.fontSize === "number" && effectiveStyle.fontSize > 0 && effectiveStyle.fontSize < 200) {
        fontSize = effectiveStyle.fontSize;
      }

      if (typeof effectiveStyle.fontFamily === "string" && effectiveStyle.fontFamily.trim() !== "") {
        fontFamily = effectiveStyle.fontFamily;
      }

      const textColorValid = isValidColor(effectiveStyle.textColor);
      const textColorIsDefault = isDefaultTextColor(effectiveStyle.textColor);
      if (textColorValid && !textColorIsDefault) {
        textColor = effectiveStyle.textColor!;
      }

      const bgColorValid = isValidColor(effectiveStyle.backgroundColor);
      const bgColorIsDefault = isDefaultBackgroundColor(effectiveStyle.backgroundColor);
      if (bgColorValid && !bgColorIsDefault) {
        backgroundColor = effectiveStyle.backgroundColor!;
      }

      // Get textAlign from base style (interceptors don't modify alignment)
      if (baseCellStyle.textAlign === "left") {
        textAlign = "left";
      } else if (baseCellStyle.textAlign === "center") {
        textAlign = "center";
      } else if (baseCellStyle.textAlign === "right") {
        textAlign = "right";
      }

      // Apply format-driven color override (e.g., [Red] from custom number format)
      if (cell.displayColor && isValidColor(cell.displayColor)) {
        textColor = cell.displayColor;
      }

      // Which of Excel's TWO overflow rules this cell gets. Text spills and
      // clips; a number, date, time or error cannot spill at all and is marked
      // with '####' when it does not fit. Decided ONCE, and used by everything
      // downstream that needs to know what kind of value this is: General
      // alignment just below, the spill gate, and every drawing path.
      const contentKind: CellContentKind = classifyCellContent(
        displayValue,
        baseCellStyle.numberFormat ?? "",
        state.showFormulas === true && !!cell.formula,
        // Decided in Rust where the CellValue and CellStyle were both in
        // hand; beats any inference from the formatted string (BUG-0066).
        cell.overflow
      );
      const shrinkToFit = (baseCellStyle as { shrinkToFit?: boolean }).shrinkToFit === true;

      // In Show Formulas mode, force left alignment for formula cells
      if (state.showFormulas && cell.formula) {
        textAlign = "left";
      } else if (baseCellStyle.textAlign === "general" || baseCellStyle.textAlign === "") {
        // GENERAL ALIGNMENT AND THE OVERFLOW RULE ASK THE SAME QUESTION — is
        // this value text or is it a number? — so they get the same answer.
        //
        // They used to disagree, because this branch tested the DISPLAY STRING
        // with `isNumericValue` while the format was ignored, and the two
        // diverge in both directions. Measured live on 2026-08-15: a cell
        // formatted Date (YYYY-MM-DD) was LEFT-aligned, because "2024-01-15"
        // parses as no number; and "1234567890" under the TEXT format `@` was
        // RIGHT-aligned, because its digits parse as one. Excel does the
        // opposite of both — dates, times and currency are right-aligned, and a
        // Text-format value "is shown exactly as typed; left-aligned".
        //
        // Left alone this would have become a contradiction inside one cell:
        // the same date counted as numeric for '####' and as text for
        // alignment, and alignment is what decides which way a value spills.
        if (isErrorValue(displayValue)) {
          textColor = theme.cellTextError;
          textAlign = "center";
        } else if (contentKind === "numeric") {
          textAlign = "right";
        }
      }

      // Calculate overflow width for text that extends beyond the cell.
      //
      // EXCEL'S FIVE SPILL CONDITIONS, all of which must hold: the value exceeds
      // the column width; THE VALUE IS TEXT; neither this cell nor the adjacent
      // one is merged; the adjacent cell is absolutely empty; wrap text is off.
      //
      // The `contentKind` term is the one that was missing, and its absence was a
      // defect in its own right (BUG-0067): the gate keyed on alignment alone, so
      // a NUMBER carrying an explicit Align Left spilled across its empty
      // neighbours instead of showing '####'. Numbers usually escaped only
      // because General alignment happens to right-align them.
      //
      // Shrink-to-fit is excluded because it is the competing remedy: Excel
      // shrinks the font until the value fits, so there is no overhang to spill.
      let overflowRight = cellRight;
      const shouldWrapEarly = baseCellStyle.wrapText === true;
      // The width this block measured, kept so the draw below does not measure
      // the same string at the same font a second time. Only set when the spill
      // block ran, which is exactly when shrink-to-fit is off — and shrink is
      // the only thing downstream that can still change the font.
      let preMeasuredTextWidth: number | null = null;
      // Collect overflowed cells so we can draw their backgrounds
      const overflowedCells: Array<{ key: string; col: number; x: number; width: number; styleIndex: number }> = [];
      if (
        !shouldWrapEarly &&
        !isMergedMaster &&
        !shrinkToFit &&
        contentKind === "text" &&
        (textAlign === "left" || textAlign === "center")
      ) {
        // Measure text to see if it exceeds cell width
        const testFont = buildCellFont(fontStyle, fontWeight, fontSize, fontFamily);
        ctx.font = testFont;
        preMeasuredTextWidth = ctx.measureText(displayValue).width;
        const textWidth = preMeasuredTextWidth + paddingX * 2 + indentOffset;
        if (textWidth > actualWidth) {
          // Extend overflow into adjacent empty columns
          let overflowCol = col + 1;
          let overflowW = actualWidth;
          let adjX = x + actualWidth;
          while (overflowW < textWidth && overflowCol < totalCols) {
            const adjKey = cellKey(row, overflowCol);
            const adjCell = cells.get(adjKey);
            // Stop at the first neighbour that is not ABSOLUTELY empty. Excel's
            // wording is deliberate — "does not contain spaces, non-printing
            // characters, empty strings, etc." — so a cell holding `=""` blocks
            // the spill even though it displays nothing (BUG-0068).
            if (blocksSpill(adjCell)) break;
            const adjWidth = getColumnWidth(overflowCol, config, dimensions);
            overflowW += adjWidth;
            // Track overflowed cell info so we can draw its background
            overflowedCells.push({
              key: adjKey,
              col: overflowCol,
              x: adjX,
              width: adjWidth,
              styleIndex: adjCell?.styleIndex ?? 0,
            });
            // Mark overflowed cells so they won't draw their own content
            drawnCells.add(adjKey);
            adjX += adjWidth;
            overflowCol++;
          }
          overflowRight = Math.min(x + overflowW, width);
        }
      }

      // Update available width if overflow extended the region
      if (overflowRight > cellRight) {
        availableWidth = overflowRight - cellLeft - paddingX * 2 - indentOffset;
      }

      // Set up clipping region (extended for text overflow)
      ctx.save();
      ctx.beginPath();
      ctx.rect(cellLeft, cellTop, overflowRight - cellLeft, cellBottom - cellTop);
      ctx.clip();

      // Draw background: use advanced fill if present, otherwise solid color
      const cellFill = baseCellStyle.fill;
      if (cellFill && cellFill.type !== "none") {
        drawCellFill(ctx, cellFill, cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      } else if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      }

      // Draw backgrounds and borders of overflowed-into cells (they're skipped in the main loop)
      for (const oc of overflowedCells) {
        if (oc.styleIndex > 0) {
          const ocStyle = getStyleFromCache(styleCache, oc.styleIndex);
          const ocLeft = Math.max(oc.x, rowHeaderWidth);
          const ocRight = Math.min(oc.x + oc.width, width);
          if (ocRight > ocLeft) {
            // Background
            const ocFill = ocStyle.fill;
            if (ocFill && ocFill.type !== "none") {
              drawCellFill(ctx, ocFill, ocLeft, cellTop, ocRight - ocLeft, cellBottom - cellTop);
            } else {
              const ocBg = ocStyle.backgroundColor;
              if (isValidColor(ocBg) && !isDefaultBackgroundColor(ocBg)) {
                ctx.fillStyle = ocBg;
                ctx.fillRect(ocLeft, cellTop, ocRight - ocLeft, cellBottom - cellTop);
              }
            }
            // Borders
            const ocBorders = [
              { b: ocStyle.borderTop, x1: ocLeft, y1: cellTop, x2: ocRight, y2: cellTop },
              { b: ocStyle.borderBottom, x1: ocLeft, y1: cellBottom, x2: ocRight, y2: cellBottom },
              { b: ocStyle.borderLeft, x1: ocLeft, y1: cellTop, x2: ocLeft, y2: cellBottom },
              { b: ocStyle.borderRight, x1: ocRight, y1: cellTop, x2: ocRight, y2: cellBottom },
            ];
            for (const { b, x1, y1, x2, y2 } of ocBorders) {
              if (b && b.style !== "none" && b.width > 0) {
                queueBorder(x1, y1, x2, y2, b);
              }
            }
          }
        }
      }

      // Draw cell borders (with CF overrides from style interceptors)
      const bTop = effectiveStyle.borderTopColor
        ? { style: effectiveStyle.borderTopStyle || "solid", color: effectiveStyle.borderTopColor, width: 1 }
        : baseCellStyle.borderTop;
      const bRight = effectiveStyle.borderRightColor
        ? { style: effectiveStyle.borderRightStyle || "solid", color: effectiveStyle.borderRightColor, width: 1 }
        : baseCellStyle.borderRight;
      const bBottom = effectiveStyle.borderBottomColor
        ? { style: effectiveStyle.borderBottomStyle || "solid", color: effectiveStyle.borderBottomColor, width: 1 }
        : baseCellStyle.borderBottom;
      const bLeft = effectiveStyle.borderLeftColor
        ? { style: effectiveStyle.borderLeftStyle || "solid", color: effectiveStyle.borderLeftColor, width: 1 }
        : baseCellStyle.borderLeft;
      const bDiagDown = baseCellStyle.borderDiagonalDown;
      const bDiagUp = baseCellStyle.borderDiagonalUp;

      if (bTop && bTop.style !== "none" && bTop.width > 0) {
        queueBorder(cellLeft, cellTop, cellRight, cellTop, bTop);
      }
      if (bBottom && bBottom.style !== "none" && bBottom.width > 0) {
        queueBorder(cellLeft, cellBottom, cellRight, cellBottom, bBottom);
      }
      if (bLeft && bLeft.style !== "none" && bLeft.width > 0) {
        queueBorder(cellLeft, cellTop, cellLeft, cellBottom, bLeft);
      }
      if (bRight && bRight.style !== "none" && bRight.width > 0) {
        queueBorder(cellRight, cellTop, cellRight, cellBottom, bRight);
      }
      // Diagonal down: top-left to bottom-right (\)
      if (bDiagDown && bDiagDown.style !== "none" && bDiagDown.width > 0) {
        drawBorderLine(ctx, cellLeft, cellTop, cellRight, cellBottom, bDiagDown);
      }
      // Diagonal up: bottom-left to top-right (/)
      if (bDiagUp && bDiagUp.style !== "none" && bDiagUp.width > 0) {
        drawBorderLine(ctx, cellLeft, cellBottom, cellRight, cellTop, bDiagUp);
      }

      // Draw cell decorations (e.g., sparklines, checkboxes) between background/borders and text
      if (useDecorations || useOverSelection) {
        const decorationContext: CellDecorationContext = { ctx, row, col, cellLeft, cellTop, cellRight, cellBottom, config, viewport, dimensions, display: displayValue, styleIndex, styleCache };
        if (useDecorations) applyCellDecorations(decorationContext);
        if (useOverSelection) {
          if (isCoveredByChrome(chromeRects, row, col)) deferred.push({ context: decorationContext, clip: null });
          else applyCellDecorations(decorationContext, "over-selection");
        }
      }

      // Cell-type renderer: a typed cell can take over content rendering
      // entirely (checkbox/progress/button). Handled -> skip the text pass.
      if (cellTypeHere && renderCellTypeCell({
        ctx, row, col, cellLeft, cellTop, cellRight, cellBottom,
        config, viewport, dimensions,
        display: rawDisplay,
        styleIndex, styleCache,
        hasFormula: !!cell.formula,
      })) {
        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // If cell has no text to display, restore and skip text rendering
      if (isEmpty) {
        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // Shrink-to-fit: reduce font size to fit cell width.
      //
      // ORDER MATTERS AND IT IS THIS ONE. Excel evaluates Shrink to Fit BEFORE
      // it gives up on a value: Microsoft lists it as a remedy for '#####', so
      // the marker appears only if even the shrunken text will not fit. Running
      // it here means every measurement below — including the '####' decision —
      // is taken at the font the cell will really paint.
      if (shrinkToFit && availableWidth > 0 && !isEmpty) {
        const testFont = buildCellFont(fontStyle, fontWeight, fontSize, fontFamily);
        ctx.font = testFont;
        const textWidth = ctx.measureText(displayValue).width;
        if (textWidth > availableWidth) {
          const scaledSize = Math.max(1, Math.floor(fontSize * (availableWidth / textWidth)));
          if (scaledSize < fontSize) {
            fontSize = scaledSize;
          }
        }
      }

      // Build font string. fontSize is in POINTS; buildCellFont converts to px.
      const fontString = buildCellFont(fontStyle, fontWeight, fontSize, fontFamily);
      ctx.font = fontString;
      ctx.fillStyle = textColor;
      ctx.textAlign = "left";
      // Pixel font size for all vertical metrics (line height, baseline offsets).
      const fontSizePx = pointsToPixels(fontSize);

      // Get vertical alignment and text rotation from style
      const vAlign = baseCellStyle.verticalAlign || "bottom";
      const textRotation = baseCellStyle.textRotation || "none";

      // -----------------------------------------------------------------------
      // Text Rotation
      // -----------------------------------------------------------------------
      if (textRotation !== "none" && textRotation !== "0") {
        let angleDeg = 0;
        if (textRotation === "rotate90" || textRotation === "90") {
          angleDeg = -90;
        } else if (textRotation === "rotate270" || textRotation === "270" || textRotation === "-90") {
          angleDeg = 90;
        } else if (textRotation.startsWith("custom:")) {
          angleDeg = -(parseInt(textRotation.substring(7), 10) || 0);
        }

        if (angleDeg !== 0) {
          const angleRad = (angleDeg * Math.PI) / 180;
          const centerX = (cellLeft + cellRight) / 2;
          const centerY = (cellTop + cellBottom) / 2;

          ctx.translate(centerX, centerY);
          ctx.rotate(angleRad);

          // For rotated text, use available height as the "width" for truncation
          const rotatedMaxWidth = cellBottom - cellTop - paddingY * 2;
          ctx.textBaseline = "middle";
          drawTextWithTruncation(ctx, displayValue, -rotatedMaxWidth / 2, 0, rotatedMaxWidth, textAlign);

          // Reset transform (restore handles this)
          ctx.restore();
          baseX += colWidth;
          continue;
        }
      }

      // -----------------------------------------------------------------------
      // Text Wrapping
      // -----------------------------------------------------------------------
      //
      // WRAP IS A TEXT OPERATION. Excel does not break a formatted number across
      // lines, so Wrap Text does not rescue a too-narrow numeric — it still shows
      // '####'. Numerics therefore fall through to the single-line path below,
      // which is where the marker decision lives. (The old code sent them to
      // `wrapText`, whose long-word fallback chops on CHARACTERS, so a wrapped
      // "1234.5678" was cut into "1234." / "5678" — a number Excel never shows.)
      const shouldWrap = baseCellStyle.wrapText === true;

      if (shouldWrap && contentKind === "text") {
        const lines = wrapText(ctx, displayValue, availableWidth);
        const lineHeight = fontSizePx * 1.2;
        const totalTextHeight = lines.length * lineHeight;
        const cellHeight = cellBottom - cellTop;

        // Calculate starting Y based on vertical alignment
        let startY: number;
        if (vAlign === "top") {
          startY = cellTop + paddingY + lineHeight / 2;
        } else if (vAlign === "bottom") {
          startY = cellBottom - paddingY - totalTextHeight + lineHeight / 2;
        } else {
          // middle (explicit only -- the DOCUMENT default is bottom)
          startY = cellTop + (cellHeight - totalTextHeight) / 2 + lineHeight / 2;
        }

        ctx.textBaseline = "middle";

        for (let i = 0; i < lines.length; i++) {
          const lineY = startY + i * lineHeight;
          // Stop drawing lines that are below the cell
          if (lineY - lineHeight / 2 > cellBottom) break;
          // Skip lines above the cell
          if (lineY + lineHeight / 2 < cellTop) continue;

          const lineTextX = cellLeft + paddingX + indentOffset;
          drawTextWithTruncation(ctx, lines[i], lineTextX, lineY, availableWidth, textAlign);
        }

        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // -----------------------------------------------------------------------
      // Rich Text rendering (partial formatting within a cell)
      // -----------------------------------------------------------------------
      const richTextRuns = (cell as { richText?: RichTextRun[] }).richText;
      if (richTextRuns && richTextRuns.length > 0 && !state.showFormulas) {
        ctx.textBaseline = "middle";
        const textX = cellLeft + paddingX + indentOffset;
        const textY = vAlign === "top"
          ? cellTop + paddingY + fontSizePx / 2
          : vAlign === "bottom"
            ? cellBottom - paddingY - fontSizePx / 2
            : y + actualHeight / 2;

        drawRichTextRuns(
          ctx, richTextRuns, textX, textY, availableWidth, textAlign,
          fontSize, fontFamily, fontWeight, fontStyle, textColor,
          effectiveStyle.bold === true,
          effectiveStyle.italic === true,
          underlineStyle !== "none", hasStrikethrough,
        );

        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // -----------------------------------------------------------------------
      // Accounting layout: symbol at left edge, value at right edge
      // -----------------------------------------------------------------------
      const acctLayout = (cell as { accountingLayout?: AccountingLayout }).accountingLayout;
      if (acctLayout) {
        let acctTextY: number;
        if (vAlign === "top") {
          ctx.textBaseline = "top";
          acctTextY = cellTop + paddingY;
        } else if (vAlign === "bottom") {
          ctx.textBaseline = "bottom";
          acctTextY = cellBottom - paddingY;
        } else {
          ctx.textBaseline = "middle";
          acctTextY = y + actualHeight / 2;
        }

        const symbolX = cellLeft + paddingX;
        const valueX = cellLeft + paddingX;
        const valueWidth = availableWidth;

        // Accounting is a currency layout and currency is a number: an
        // Accounting cell too narrow for symbol + value shows '####' across the
        // whole box, exactly as any other explicit format does. Excel will not
        // drop the symbol or the decimals to make it fit.
        const acctWidth =
          ctx.measureText(acctLayout.symbol).width + ctx.measureText(acctLayout.value).width;
        if (acctWidth > valueWidth) {
          const marker = fitNumericDisplay({
            display: acctLayout.value,
            numberFormat: baseCellStyle.numberFormat ?? "",
            availableWidth: valueWidth,
            measure: measureAt,
            displayWidth: acctWidth,
            transported: cell.overflow,
          });
          ctx.fillText(marker.text, valueX, acctTextY);
          ctx.restore();
          baseX += colWidth;
          continue;
        }

        if (acctLayout.symbolBefore) {
          // Symbol left-aligned, value right-aligned
          ctx.fillText(acctLayout.symbol, symbolX, acctTextY);
          drawTextWithTruncation(ctx, acctLayout.value, valueX, acctTextY, valueWidth, "right");
        } else {
          // Value left-aligned, symbol right-aligned
          drawTextWithTruncation(ctx, acctLayout.value, valueX, acctTextY, valueWidth, "left");
          const symbolWidth = ctx.measureText(acctLayout.symbol).width;
          ctx.fillText(acctLayout.symbol, cellRight - paddingX - symbolWidth, acctTextY);
        }

        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // -----------------------------------------------------------------------
      // Standard (single-line) rendering with vertical alignment
      // -----------------------------------------------------------------------
      const textX = cellLeft + paddingX + indentOffset;
      let textY: number;

      if (vAlign === "top") {
        ctx.textBaseline = "top";
        textY = cellTop + paddingY;
      } else if (vAlign === "bottom") {
        ctx.textBaseline = "bottom";
        textY = cellBottom - paddingY;
      } else {
        // "middle" -- reached only when the cell carries an EXPLICIT middle
        // alignment. The DOCUMENT default is "bottom" (Excel parity) and is
        // applied by the `|| "bottom"` fallback above.
        ctx.textBaseline = "middle";
        textY = y + actualHeight / 2;
      }
      // Snap the baseline to a whole device pixel so the rasterizer can hint the
      // stems onto the pixel grid (crisper text, closer to Excel's ClearType).
      textY = Math.round(textY);

      // What actually gets painted, and this is where Excel's two overflow rules
      // part company:
      //
      //   TEXT      -> the string, clipped at the box edge by the clip rectangle
      //                established above. Never a marker, never an ellipsis.
      //   NUMERIC   -> `fitNumericDisplay`'s ladder: it fits; or General drops
      //                decimals and then goes scientific; or '####' repeated to
      //                fill the width.
      //
      // The numeric branch measures ONCE up front and hands that measurement to
      // the ladder, so a numeric cell that fits — the overwhelming majority —
      // costs exactly the one `measureText` the old ellipsis path already spent.
      let drawn: DrawnTextMetrics;
      if (contentKind === "numeric") {
        const fit = fitNumericDisplay({
          display: displayValue,
          numberFormat: baseCellStyle.numberFormat ?? "",
          availableWidth,
          measure: measureAt,
          transported: cell.overflow,
        });
        drawn = drawTextWithTruncationMetrics(
          ctx, fit.text, textX, textY, availableWidth, textAlign, fit.width
        );
      } else {
        // The metrics describe what was really painted; decorations follow the
        // glyphs, not the data, and the same clip that cuts the glyphs cuts the
        // rules drawn under them.
        drawn = drawTextWithTruncationMetrics(
          ctx, displayValue, textX, textY, availableWidth, textAlign,
          preMeasuredTextWidth ?? undefined
        );
      }

      // Draw underline if needed
      if (underlineStyle !== "none") {
        const isAccounting = underlineStyle === "singleAccounting" || underlineStyle === "doubleAccounting";
        const isDouble = underlineStyle === "double" || underlineStyle === "doubleAccounting";

        // Accounting underlines span the full cell width at the cell bottom;
        // standard underlines follow the RENDERED text under the text baseline.
        const ulWidth = isAccounting
          ? (cellRight - cellLeft - paddingX * 2)
          : Math.min(drawn.renderedWidth, availableWidth);
        const underlineX = isAccounting ? cellLeft + paddingX : drawn.renderedX;

        // Position underline Y: accounting styles sit at the cell bottom, standard styles under the text
        let underlineY: number;
        if (isAccounting) {
          underlineY = cellBottom - paddingY;
        } else if (vAlign === "top") {
          underlineY = cellTop + paddingY + fontSizePx + 1;
        } else if (vAlign === "bottom") {
          underlineY = cellBottom - paddingY + 1;
        } else {
          underlineY = textY + fontSizePx / 2 + 1;
        }

        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;

        // Draw first line
        ctx.beginPath();
        ctx.moveTo(underlineX, underlineY);
        ctx.lineTo(underlineX + ulWidth, underlineY);
        ctx.stroke();

        // Draw second line for double styles (2px gap)
        if (isDouble) {
          const secondY = underlineY - 2;
          ctx.beginPath();
          ctx.moveTo(underlineX, secondY);
          ctx.lineTo(underlineX + ulWidth, secondY);
          ctx.stroke();
        }
      }

      // Draw strikethrough if needed
      if (hasStrikethrough) {
        // Same rule as the underline: measure the glyphs that were painted.
        const textWidth = Math.min(drawn.renderedWidth, availableWidth);
        const strikeX = drawn.renderedX;
        // Position strikethrough at vertical center of text
        let strikeY: number;
        if (vAlign === "top") {
          strikeY = cellTop + paddingY + fontSizePx / 2;
        } else if (vAlign === "bottom") {
          strikeY = cellBottom - paddingY - fontSizePx / 2;
        } else {
          strikeY = textY;
        }
        ctx.beginPath();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.moveTo(strikeX, strikeY);
        ctx.lineTo(strikeX + textWidth, strikeY);
        ctx.stroke();
      }

      ctx.restore();

      baseX += colWidth;
    }

    baseY += rowHeight;
  }

  // Handed to drawDeferredCellDecorations() once the selection chrome is down.
  // ---------------------------------------------------------------------
  // BORDER PASS
  // ---------------------------------------------------------------------
  // Every background in the viewport is down, so a border may now straddle its
  // boundary without the next cell's background erasing the half on its side.
  //
  // The clip is INSURANCE, not load-bearing: cellLeft/cellTop are clamped to the
  // gutters, so a straddling border on the first visible row/column could reach
  // ~1.5px into a gutter -- which the header repaint covers anyway (headers are
  // drawn after this pass), and which is a no-op when headings are hidden and
  // both gutters are 0. It is kept so this pass does not DEPEND on that
  // ordering. Do not delete it as dead code.
  if (deferredBorders.size > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderWidth, colHeaderHeight, width - rowHeaderWidth, height - colHeaderHeight);
    ctx.clip();
    for (const b of deferredBorders.values()) {
      drawBorderLine(ctx, b.x1, b.y1, b.x2, b.y2, b.border);
    }
    ctx.restore();
  }

  return deferred;
}
