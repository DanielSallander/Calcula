//! FILENAME: app/src/core/lib/gridRenderer/rendering/styledCellBox.ts
// PURPOSE: Paint ONE formatted cell into an arbitrary box -- the primitive an
//          object that shows cells of its own (a floating grid) paints with, so
//          its cells look exactly like the sheet's.
// CONTEXT: The ordinary grid paints through `drawCellText` (cells.ts), which is a
//          whole-viewport pass: it owns the visible range, merges, text spill
//          into empty neighbours, the frame-wide border queue and the style
//          interceptors keyed on the ACTIVE sheet's (row, col). None of that
//          fits an object whose cells live on another (backing) sheet and sit in
//          a box the object positions itself. This function is the per-cell part
//          of that painter, and nothing more.
//
// ONE SET OF HELPERS, NEVER A COPY. Every drawing decision that has a rule of its
// own is delegated to the helper the grid painter already uses: `drawCellFill`,
// `resolveEdgeBorders` / `strokeEdgeBorders` / `drawBorderLine` (and through it
// `borderLineWidth`), `drawOrientedText`, `paintAccountingValue`,
// `drawRichTextRuns`, `drawTextWithTruncationMetrics`, `fitNumericDisplay`,
// `wrapText` / `splitHardBreaks`, `alignmentWithIndent` / `effectiveIndentPx` /
// `indentedTextBox` and `buildCellFont`. What is left here is the ORDER in which
// they run, which mirrors `drawCellText`; `styledCellBox.test.ts` pins the two
// painters together on a fixture cell (same fill colour, same font, same text x)
// so they cannot quietly drift apart.
//
// NO STYLE INTERCEPTORS. Interceptors are keyed on the active sheet's (row, col):
// a floating grid's cell (r, c) asking them would be handed the HOST sheet's
// conditional formatting for whatever cell happens to sit at (r, c) there. The
// caller passes the cell's own conditional result instead, as `conditional`,
// evaluated on the backing sheet.

import type { CellData, StyleData, RichTextRun, AccountingLayout, UnderlineStyle } from "../../../types";
import type { IStyleOverride } from "../../../../api/styleInterceptors";
import { DEFAULT_THEME, type GridTheme } from "../types";
import { drawCellFill } from "../styles/fillRenderer";
import { isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "../styles/styleUtils";
import { isErrorValue } from "../styles/cellFormatting";
import { pointsToPixels, buildCellFont } from "../fonts";
import { wrapText, splitHardBreaks, hasHardBreak } from "../layout/autoFit";
import { parseTextOrientation } from "../layout/textOrientation";
import { alignmentWithIndent, effectiveIndentPx, indentedTextBox } from "../layout/cellIndent";
import { classifyCellContent, fitNumericDisplay, type CellContentKind } from "./overflowMarker";
import {
  drawOrientedText,
  paintAccountingValue,
  drawRichTextRuns,
  drawTextWithTruncationMetrics,
  drawBorderLine,
  resolveEdgeBorders,
  strokeEdgeBorders,
  type DrawnTextMetrics,
} from "./cells";

/** Excel's largest font size, in points (the grid painter's bound, cells.ts). */
const MAX_FONT_SIZE_POINTS = 409;
/** The grid painter's text insets (drawCellText's paddingX / paddingY). */
const PADDING_X = 3;
const PADDING_Y = 2;

/** A cell's box in canvas coordinates (the caller's transform applies). */
export interface CellBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the backend says the cell's VALUE is ("number" | "text" | "boolean" |
 * "error" | "empty"). It decides General alignment, and which of Excel's two
 * overflow rules applies, without re-parsing the display string.
 */
export type CellValueKind = "number" | "text" | "boolean" | "error" | "empty";

/** The theme fields the cell painter reads. */
export type StyledCellTheme = Pick<GridTheme, "cellText" | "cellTextError" | "cellFontSize" | "cellFontFamily">;

export interface StyledCellPaint {
  /** The cell as the backend sends it (display, richText, accountingLayout, ...). */
  cell: Pick<CellData, "display"> &
    Partial<Pick<CellData, "displayColor" | "overflow" | "richText" | "accountingLayout">>;
  /** The cell's resolved style (the style cache entry for its styleIndex). */
  style: StyleData;
  /** The backend's value kind; an unknown string is treated as "text". */
  valueKind: CellValueKind | string;
  /**
   * The cell's conditional-format style, evaluated on the sheet the cell really
   * lives on. It overrides the static style exactly as the interceptor result
   * does on the grid (`resolveEffectiveStyle`, cells.ts).
   */
  conditional?: IStyleOverride | null;
  /**
   * Extra scale for the cell's CONTENT (font sizes, insets, indent) relative to
   * the box. 1 = the sheet's own proportions. The canvas transform (dpr, sheet
   * zoom) is the caller's and is NOT folded in here.
   */
  zoom?: number;
  /** Theme defaults for an unstyled cell; the light grid theme when omitted. */
  theme?: StyledCellTheme;
  /**
   * Paint the four EDGE borders (default true). An object painting a block of
   * boxes can pass false and call {@link paintStyledCellEdges} for every box
   * after all fills are down, so a border that straddles its boundary is not
   * covered by the neighbour's fill -- the order the grid painter keeps.
   */
  edgeBorders?: boolean;
}

/**
 * The style the cell shows: the static style seeded the way
 * `resolveEffectiveStyle` seeds it, then the conditional override on top. Only
 * the keys the override actually DEFINES win -- an absent key never blanks the
 * static value.
 */
export function effectiveCellStyle(
  style: StyleData,
  conditional: IStyleOverride | null | undefined,
): IStyleOverride {
  const seed: IStyleOverride = {
    backgroundColor: style.backgroundColor,
    textColor: style.textColor,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline !== "none",
    strikethrough: style.strikethrough,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
  };
  if (!conditional) return seed;
  const out: IStyleOverride = { ...seed };
  for (const key of Object.keys(conditional) as (keyof IStyleOverride)[]) {
    const v = conditional[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/**
 * Stroke the four EDGE borders of one box (conditional overrides first, as on
 * the grid). Exported for the two-pass use described on `edgeBorders`.
 */
export function paintStyledCellEdges(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  paint: Pick<StyledCellPaint, "style" | "conditional">,
): void {
  const effective = effectiveCellStyle(paint.style, paint.conditional);
  const edges = resolveEdgeBorders(effective, paint.style);
  if (edges.top || edges.right || edges.bottom || edges.left) {
    strokeEdgeBorders(ctx, edges, box.x, box.y, box.x + box.width, box.y + box.height);
  }
}

/** Map the backend's value kind onto the painter's overflow class. */
function contentKindOf(
  valueKind: string,
  display: string,
  numberFormat: string,
  transported: CellData["overflow"],
): CellContentKind {
  if (valueKind === "number" || valueKind === "error") return "numeric";
  if (valueKind === "text" || valueKind === "boolean") return "text";
  return classifyCellContent(display, numberFormat, false, transported);
}

/**
 * Paint one formatted cell -- fill, borders (edges plus diagonals) and text --
 * into `box`.
 *
 * The text is clipped to the box (Excel clips an over-long value at the cell
 * edge; there is no spill here, because spilling needs the neighbours). Merged
 * cells are the caller's business: pass the merged region's box for the
 * anchor and skip the covered cells.
 */
export function paintStyledCellBox(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  paint: StyledCellPaint,
): void {
  if (!(box.width > 0) || !(box.height > 0)) return;
  const { cell, style } = paint;
  const theme = paint.theme ?? DEFAULT_THEME;
  const zoom = paint.zoom && paint.zoom > 0 ? paint.zoom : 1;
  const padX = PADDING_X * zoom;
  const padY = PADDING_Y * zoom;

  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  const effective = effectiveCellStyle(style, paint.conditional);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, box.width, box.height);
  ctx.clip();

  // ---- Fill. A conditional fill beats the static one (Excel: a conditional
  // format's fill is drawn over the cell's own); otherwise the advanced fill,
  // then the solid colour -- the grid painter's order.
  const cfBackground = paint.conditional?.backgroundColor;
  if (cfBackground && isValidColor(cfBackground) && !isDefaultBackgroundColor(cfBackground)) {
    ctx.fillStyle = cfBackground;
    ctx.fillRect(left, top, box.width, box.height);
  } else if (style.fill && style.fill.type !== "none") {
    drawCellFill(ctx, style.fill, left, top, box.width, box.height);
  } else if (isValidColor(effective.backgroundColor) && !isDefaultBackgroundColor(effective.backgroundColor)) {
    ctx.fillStyle = effective.backgroundColor!;
    ctx.fillRect(left, top, box.width, box.height);
  }

  // ---- Diagonals: interior lines, inside the clip (as on the grid).
  const dDown = style.borderDiagonalDown;
  if (dDown && dDown.style !== "none" && dDown.width > 0) {
    drawBorderLine(ctx, left, top, right, bottom, dDown);
  }
  const dUp = style.borderDiagonalUp;
  if (dUp && dUp.style !== "none" && dUp.width > 0) {
    drawBorderLine(ctx, left, bottom, right, top, dUp);
  }

  paintCellText(ctx, box, paint, effective, theme, zoom, padX, padY);

  ctx.restore();

  // ---- Edge borders: OUTSIDE the text clip, so a medium or thick border
  // straddles its boundary at full weight instead of losing its outer half.
  if (paint.edgeBorders !== false) {
    paintStyledCellEdges(ctx, box, paint);
  }
}

/** The text pass, inside the box clip. Mirrors drawCellText's branch order. */
function paintCellText(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  paint: StyledCellPaint,
  effective: IStyleOverride,
  theme: StyledCellTheme,
  zoom: number,
  padX: number,
  padY: number,
): void {
  const { cell, style } = paint;
  const display = cell.display ?? "";
  if (display === "") return;

  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  // ---- Font and colour.
  const fontWeight = effective.bold === true ? "bold" : "normal";
  const fontStyle = effective.italic === true ? "italic" : "normal";
  let fontSize = theme.cellFontSize;
  if (
    typeof effective.fontSize === "number" &&
    effective.fontSize > 0 &&
    effective.fontSize <= MAX_FONT_SIZE_POINTS
  ) {
    fontSize = effective.fontSize;
  }
  const fontFamily =
    typeof effective.fontFamily === "string" && effective.fontFamily.trim() !== ""
      ? effective.fontFamily
      : theme.cellFontFamily;
  let underlineStyle: UnderlineStyle = "none";
  if (effective.underline === true) {
    underlineStyle = style.underline !== "none" ? style.underline : "single";
  }
  const hasStrikethrough = effective.strikethrough === true;

  let textColor = theme.cellText;
  if (isValidColor(effective.textColor) && !isDefaultTextColor(effective.textColor)) {
    textColor = effective.textColor!;
  }
  if (cell.displayColor && isValidColor(cell.displayColor)) {
    textColor = cell.displayColor;
  }

  // ---- Alignment. General follows the VALUE kind: numbers right, booleans and
  // errors centred (errors in the error ink), text left; an indent turns
  // General into Left (layout/cellIndent.ts).
  const numberFormat = style.numberFormat ?? "";
  const contentKind = contentKindOf(String(paint.valueKind), display, numberFormat, cell.overflow);
  let textAlign: "left" | "right" | "center" = "left";
  if (style.textAlign === "left" || style.textAlign === "center" || style.textAlign === "right") {
    textAlign = style.textAlign;
  } else if (style.textAlign === "general" || style.textAlign === "" || style.textAlign == null) {
    if (paint.valueKind === "error" || isErrorValue(display)) {
      textColor = theme.cellTextError;
      textAlign = "center";
    } else if (paint.valueKind === "boolean") {
      textAlign = "center";
    } else if (contentKind === "numeric") {
      textAlign = "right";
    }
    textAlign = alignmentWithIndent(style.textAlign, textAlign, style.indent);
  }
  const indentOffset = effectiveIndentPx(style.textAlign, style.indent) * zoom;
  const textBox = indentedTextBox(textAlign, left + padX, right - padX, indentOffset);
  const availableWidth = textBox.width;
  const orientation = parseTextOrientation(style.textRotation);
  const isHorizontal = orientation.kind === "horizontal";

  // ---- Shrink to fit (before any '####' decision, as Excel orders it).
  if (style.shrinkToFit === true && isHorizontal && availableWidth > 0) {
    ctx.font = buildCellFont(fontStyle, fontWeight, fontSize * zoom, fontFamily);
    const w = ctx.measureText(display).width;
    if (w > availableWidth) {
      const scaled = Math.max(1, Math.floor(fontSize * (availableWidth / w)));
      if (scaled < fontSize) fontSize = scaled;
    }
  }

  const sizePoints = fontSize * zoom;
  ctx.font = buildCellFont(fontStyle, fontWeight, sizePoints, fontFamily);
  ctx.fillStyle = textColor;
  ctx.textAlign = "left";
  const fontSizePx = pointsToPixels(sizePoints);
  const vAlign = style.verticalAlign || "bottom";

  // ---- Rotated / stacked text.
  if (!isHorizontal) {
    drawOrientedText(
      ctx,
      orientation,
      display,
      { left: left + padX, top: top + padY, right: right - padX, bottom: bottom - padY },
      style.textAlign,
      vAlign,
      fontSizePx,
    );
    return;
  }

  // ---- Wrapped text, or a hard break with wrap off (text only; rich text
  // keeps its own painter).
  const richText = cell.richText as RichTextRun[] | undefined;
  const hasRichText = !!richText && richText.length > 0;
  const hardBreak = hasHardBreak(display);
  const shouldWrap = style.wrapText === true;
  const breakWithoutWrap = hardBreak && !shouldWrap && !hasRichText;
  if ((shouldWrap || breakWithoutWrap) && (contentKind === "text" || hardBreak)) {
    const lines = shouldWrap ? wrapText(ctx, display, availableWidth) : splitHardBreaks(display);
    const lineHeight = fontSizePx * 1.2;
    const totalTextHeight = lines.length * lineHeight;
    let startY: number;
    if (vAlign === "top") {
      startY = top + padY + lineHeight / 2;
    } else if (vAlign === "bottom") {
      startY = bottom - padY - totalTextHeight + lineHeight / 2;
    } else {
      startY = top + (box.height - totalTextHeight) / 2 + lineHeight / 2;
    }
    ctx.textBaseline = "middle";
    for (let i = 0; i < lines.length; i++) {
      const lineY = startY + i * lineHeight;
      if (lineY - lineHeight / 2 > bottom) break;
      if (lineY + lineHeight / 2 < top) continue;
      drawTextWithTruncationMetrics(ctx, lines[i], textBox.x, lineY, availableWidth, textAlign);
    }
    return;
  }

  // ---- Rich text runs.
  if (richText && hasRichText) {
    ctx.textBaseline = "middle";
    const textY =
      vAlign === "top"
        ? top + padY + fontSizePx / 2
        : vAlign === "bottom"
          ? bottom - padY - fontSizePx / 2
          : top + box.height / 2;
    const runs = zoom === 1
      ? richText
      : richText.map((r) => (r.fontSize != null ? { ...r, fontSize: r.fontSize * zoom } : r));
    drawRichTextRuns(
      ctx, runs, textBox.x, textY, availableWidth, textAlign,
      sizePoints, fontFamily, fontWeight, fontStyle, textColor,
      effective.bold === true, effective.italic === true,
      underlineStyle !== "none", hasStrikethrough,
    );
    return;
  }

  // ---- Accounting runs: edge to edge, never moved by alignment or indent.
  const acct = cell.accountingLayout as AccountingLayout | undefined;
  if (acct) {
    let acctY: number;
    if (vAlign === "top") {
      ctx.textBaseline = "top";
      acctY = top + padY;
    } else if (vAlign === "bottom") {
      ctx.textBaseline = "bottom";
      acctY = bottom - padY;
    } else {
      ctx.textBaseline = "middle";
      acctY = top + box.height / 2;
    }
    paintAccountingValue(ctx, acct, left + padX, right - padX, acctY, numberFormat, cell.overflow);
    return;
  }

  // ---- Single line.
  let textY: number;
  if (vAlign === "top") {
    ctx.textBaseline = "top";
    textY = top + padY;
  } else if (vAlign === "bottom") {
    ctx.textBaseline = "bottom";
    textY = bottom - padY;
  } else {
    ctx.textBaseline = "middle";
    textY = top + box.height / 2;
  }
  textY = Math.round(textY);

  let drawn: DrawnTextMetrics;
  if (contentKind === "numeric") {
    const fit = fitNumericDisplay({
      display,
      numberFormat,
      availableWidth,
      measure: (t: string) => ctx.measureText(t).width,
      transported: cell.overflow,
    });
    drawn = drawTextWithTruncationMetrics(ctx, fit.text, textBox.x, textY, availableWidth, textAlign, fit.width);
  } else {
    drawn = drawTextWithTruncationMetrics(ctx, display, textBox.x, textY, availableWidth, textAlign);
  }

  if (underlineStyle !== "none") {
    const isAccounting = underlineStyle === "singleAccounting" || underlineStyle === "doubleAccounting";
    const isDouble = underlineStyle === "double" || underlineStyle === "doubleAccounting";
    const ulWidth = isAccounting ? box.width - padX * 2 : Math.min(drawn.renderedWidth, availableWidth);
    const ulX = isAccounting ? left + padX : drawn.renderedX;
    let ulY: number;
    if (isAccounting) ulY = bottom - padY;
    else if (vAlign === "top") ulY = top + padY + fontSizePx + 1;
    else if (vAlign === "bottom") ulY = bottom - padY + 1;
    else ulY = textY + fontSizePx / 2 + 1;
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ulX, ulY);
    ctx.lineTo(ulX + ulWidth, ulY);
    ctx.stroke();
    if (isDouble) {
      ctx.beginPath();
      ctx.moveTo(ulX, ulY - 2);
      ctx.lineTo(ulX + ulWidth, ulY - 2);
      ctx.stroke();
    }
  }

  if (hasStrikethrough) {
    const w = Math.min(drawn.renderedWidth, availableWidth);
    let sY: number;
    if (vAlign === "top") sY = top + padY + fontSizePx / 2;
    else if (vAlign === "bottom") sY = bottom - padY - fontSizePx / 2;
    else sY = textY;
    ctx.beginPath();
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1;
    ctx.moveTo(drawn.renderedX, sY);
    ctx.lineTo(drawn.renderedX + w, sY);
    ctx.stroke();
  }
}
