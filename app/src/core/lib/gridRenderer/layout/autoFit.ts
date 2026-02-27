//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFit.ts
// PURPOSE: Auto-fit text measurement utility for columns and rows.
// CONTEXT: Measures optimal column width / row height using an offscreen canvas
//          to calculate text dimensions based on cell content and styles.

import type { CellData, StyleData } from "../../../types";
import { columnToLetter } from "../../../types";

/** Horizontal padding inside cells (matches cells.ts paddingX) */
const PADDING_X = 4;
/** Vertical padding inside cells (matches cells.ts paddingY) */
const PADDING_Y = 2;
/** Extra margin to prevent content from touching the border */
const FIT_MARGIN = 2;
/** Line height multiplier for wrapped text */
const LINE_HEIGHT_FACTOR = 1.2;
/** Font used for column header letters */
const HEADER_FONT = "12px system-ui, -apple-system, sans-serif";

/**
 * Lazy singleton offscreen canvas for text measurement.
 * Avoids creating a new canvas element for every measurement call.
 */
let measureCanvas: HTMLCanvasElement | null = null;
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    measureCanvas = document.createElement("canvas");
    measureCtx = measureCanvas.getContext("2d")!;
  }
  return measureCtx;
}

/**
 * Build a CSS font string from a StyleData.
 * Falls back to theme defaults for unspecified properties.
 */
function buildFontString(
  style: StyleData | undefined,
  themeFontFamily: string,
  themeFontSize: number
): string {
  const fontFamily = style?.fontFamily || themeFontFamily;
  const fontSize = style?.fontSize || themeFontSize;
  const italic = style?.italic ? "italic" : "";
  const bold = style?.bold ? "bold" : "";
  return `${italic} ${bold} ${fontSize}px ${fontFamily}`.trim();
}

/**
 * Measure the optimal width for a column based on its cell contents.
 *
 * For each non-empty cell in the column, measures the display text width
 * using the cell's font style. Returns the maximum width found, plus padding.
 * Merged cells spanning multiple columns are skipped.
 *
 * @param col - Column index (for header letter measurement)
 * @param cells - Non-empty cells in the column (from getCellsInCols)
 * @param styles - All styles from getAllStyles() (index-ordered array)
 * @param theme - Font defaults from the grid theme
 * @param minWidth - Minimum allowed column width
 * @returns Optimal width in pixels
 */
export function measureOptimalColumnWidth(
  col: number,
  cells: CellData[],
  styles: StyleData[],
  theme: { cellFontFamily: string; cellFontSize: number },
  minWidth: number
): number {
  const ctx = getMeasureContext();
  let maxWidth = 0;

  // Measure the header letter so the column is at least as wide as its header
  ctx.font = HEADER_FONT;
  const headerText = columnToLetter(col);
  const headerWidth = ctx.measureText(headerText).width + PADDING_X * 2 + FIT_MARGIN;
  maxWidth = headerWidth;

  // Track the last font string to avoid redundant ctx.font assignments
  let lastFont = HEADER_FONT;

  for (const cell of cells) {
    // Skip merged cells that span multiple columns
    if (cell.colSpan !== undefined && cell.colSpan > 1) {
      continue;
    }

    // Skip empty display values
    if (!cell.display) {
      continue;
    }

    const style = cell.styleIndex < styles.length ? styles[cell.styleIndex] : undefined;
    const fontString = buildFontString(style, theme.cellFontFamily, theme.cellFontSize);

    if (fontString !== lastFont) {
      ctx.font = fontString;
      lastFont = fontString;
    }

    const textWidth = ctx.measureText(cell.display).width;
    const cellWidth = textWidth + PADDING_X * 2 + FIT_MARGIN;

    if (cellWidth > maxWidth) {
      maxWidth = cellWidth;
    }
  }

  return Math.max(minWidth, Math.ceil(maxWidth));
}

/**
 * Measure the optimal height for a row based on its cell contents.
 *
 * For each non-empty cell in the row, calculates the required height
 * based on font size and text wrapping. Returns the maximum height found.
 * Merged cells spanning multiple rows are skipped.
 *
 * @param cells - Non-empty cells in the row (from getCellsInRows)
 * @param styles - All styles from getAllStyles() (index-ordered array)
 * @param columnWidths - Map of column index to custom width
 * @param defaultColWidth - Default column width for columns not in the map
 * @param theme - Font defaults from the grid theme
 * @param minHeight - Minimum allowed row height
 * @returns Optimal height in pixels
 */
export function measureOptimalRowHeight(
  cells: CellData[],
  styles: StyleData[],
  columnWidths: Map<number, number>,
  defaultColWidth: number,
  theme: { cellFontFamily: string; cellFontSize: number },
  minHeight: number
): number {
  const ctx = getMeasureContext();
  let maxHeight = 0;

  let lastFont = "";

  for (const cell of cells) {
    // Skip merged cells that span multiple rows
    if (cell.rowSpan !== undefined && cell.rowSpan > 1) {
      continue;
    }

    // Skip empty display values
    if (!cell.display) {
      continue;
    }

    const style = cell.styleIndex < styles.length ? styles[cell.styleIndex] : undefined;
    const fontSize = style?.fontSize || theme.cellFontSize;
    const fontString = buildFontString(style, theme.cellFontFamily, theme.cellFontSize);

    if (fontString !== lastFont) {
      ctx.font = fontString;
      lastFont = fontString;
    }

    let lineCount = 1;

    // If wrap text is enabled, calculate how many lines this cell needs
    if (style?.wrapText) {
      const colWidth = columnWidths.get(cell.col) ?? defaultColWidth;
      const availableWidth = colWidth - PADDING_X * 2;
      if (availableWidth > 0) {
        const lines = wrapTextForMeasurement(ctx, cell.display, availableWidth);
        lineCount = lines.length;
      }
    }

    const cellHeight = lineCount * fontSize * LINE_HEIGHT_FACTOR + PADDING_Y * 2;
    if (cellHeight > maxHeight) {
      maxHeight = cellHeight;
    }
  }

  // If no cells had content, return default/minimum height
  if (maxHeight === 0) {
    return minHeight;
  }

  return Math.max(minHeight, Math.ceil(maxHeight));
}

/**
 * Word-wrap text into lines that fit within maxWidth.
 * Mirrors the wrapText function in cells.ts for consistent measurement.
 */
function wrapTextForMeasurement(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine + word;
    const testWidth = ctx.measureText(testLine).width;

    if (testWidth <= maxWidth || currentLine === "") {
      currentLine = testLine;
    } else {
      if (currentLine.trim() !== "") {
        lines.push(currentLine);
      }
      // Character wrapping for words wider than maxWidth
      if (ctx.measureText(word).width > maxWidth) {
        let remaining = word;
        while (remaining.length > 0) {
          let charCount = 1;
          while (
            charCount < remaining.length &&
            ctx.measureText(remaining.substring(0, charCount + 1)).width <= maxWidth
          ) {
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
