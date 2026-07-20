//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFit.ts
// PURPOSE: Auto-fit (best-fit) measurement for double-click column/row resize.
// CONTEXT: Mirrors Excel's AutoFit semantics: fit the widest RENDERED cell in
//          the whole column (per-cell fonts, formatted display text), skip
//          wrap-text and merged-across cells, leave empty columns unchanged,
//          reset empty rows to the default height. Extension-rendered content
//          (pivot overlays, filter buttons) participates via the
//          @api/autoFitContributors registry.

import type { CellData, StyleData, RichTextRun } from "../../../types";
import {
  hasAutoFitContributors,
  collectAutoFitColumnContributions,
  collectAutoFitRowContributions,
} from "../../../../api/autoFitContributors";
import { buildCellFont, pointsToPixels } from "../fonts";

/** Horizontal padding inside cells (matches cells.ts paddingX) */
const PADDING_X = 3;
/** Vertical padding inside cells (matches cells.ts paddingY) */
const PADDING_Y = 2;
/** Extra margin to prevent content from touching the border */
const FIT_MARGIN = 2;
/** Line height multiplier for wrapped text (matches cells.ts) */
const LINE_HEIGHT_FACTOR = 1.2;

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

/** Test seam: inject a mock 2D context (jsdom has no real canvas). */
export function setMeasureContextForTesting(ctx: CanvasRenderingContext2D | null): void {
  measureCtx = ctx;
  if (!ctx) measureCanvas = null;
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
  const fontSize = style?.fontSize || themeFontSize; // points
  const fontStyle = style?.italic ? "italic" : "normal";
  const fontWeight = style?.bold ? "bold" : "normal";
  // Delegate to buildCellFont so measurement uses the EXACT font string the
  // renderer draws with (same pt->px conversion, same fallback chain).
  return buildCellFont(fontStyle, fontWeight, fontSize, fontFamily);
}

/** Inclusive row/col span merged from contributor claims. */
interface ClaimedSpan {
  start: number;
  end: number;
}

function isClaimed(index: number, spans: ClaimedSpan[]): boolean {
  for (const span of spans) {
    if (index >= span.start && index <= span.end) return true;
  }
  return false;
}

/** Superscript/subscript scale factor (matches cells.ts SCRIPT_SCALE). */
const SCRIPT_SCALE = 0.65;

/**
 * Total width of rich-text runs, each measured with its own font — mirrors
 * drawRichTextRuns in cells.ts.
 */
function measureRichTextWidth(
  ctx: CanvasRenderingContext2D,
  runs: RichTextRun[],
  style: StyleData | undefined,
  themeFontFamily: string,
  themeFontSize: number
): number {
  const baseBold = style?.bold ?? false;
  const baseItalic = style?.italic ?? false;
  const baseFontSize = style?.fontSize || themeFontSize;
  const baseFontFamily = style?.fontFamily || themeFontFamily;

  let total = 0;
  for (const run of runs) {
    const isBold = run.bold ?? baseBold;
    const isItalic = run.italic ?? baseItalic;
    let fontSize = run.fontSize ?? baseFontSize;
    if (run.superscript === true || run.subscript === true) {
      fontSize = Math.round(fontSize * SCRIPT_SCALE);
    }
    const fontFamily = run.fontFamily ?? baseFontFamily;
    ctx.font = buildCellFont(isItalic ? "italic" : "normal", isBold ? "bold" : "normal", fontSize, fontFamily);
    total += ctx.measureText(run.text).width;
  }
  return total;
}

/** Largest effective font size across a cell's rich-text runs. */
function maxRichTextFontSize(runs: RichTextRun[], baseFontSize: number): number {
  let max = baseFontSize;
  for (const run of runs) {
    if (run.superscript === true || run.subscript === true) continue;
    const size = run.fontSize ?? baseFontSize;
    if (size > max) max = size;
  }
  return max;
}

/**
 * Measure the optimal width for a column based on its cell contents.
 *
 * Excel semantics:
 * - Each cell measured with its own font on its formatted display text.
 * - Wrap-text cells never widen a column (their text fits any width).
 * - Cells merged across columns are ignored.
 * - The header letter is NOT content — an empty column stays unchanged.
 *
 * Extension contributions (pivot overlays, filter buttons) are folded in:
 * claimed cells are skipped (the contributor measures them itself), per-cell
 * chrome widths are added, and contributor required widths compete in the max.
 *
 * @param col - Column index
 * @param cells - Non-empty cells in the column (from getCellsInCols)
 * @param styles - All styles from getAllStyles() (index-ordered array)
 * @param theme - Font defaults from the grid theme
 * @param minWidth - Minimum allowed column width
 * @returns Optimal width in pixels, or null when there is nothing to fit
 *          (Excel leaves the column width unchanged in that case)
 */
export function measureOptimalColumnWidth(
  col: number,
  cells: CellData[],
  styles: StyleData[],
  theme: { cellFontFamily: string; cellFontSize: number },
  minWidth: number
): number | null {
  const ctx = getMeasureContext();
  let maxWidth = 0;
  let hasContent = false;

  const contributions = hasAutoFitContributors()
    ? collectAutoFitColumnContributions(col, ctx)
    : [];

  const claimedRows: ClaimedSpan[] = [];
  const extraCellWidth = new Map<number, number>();
  for (const contribution of contributions) {
    if (contribution.claimedRowRanges) {
      for (const range of contribution.claimedRowRanges) {
        claimedRows.push({ start: range.startRow, end: range.endRow });
      }
    }
    if (contribution.requiredWidth !== undefined && contribution.requiredWidth > 0) {
      hasContent = true;
      if (contribution.requiredWidth > maxWidth) {
        maxWidth = contribution.requiredWidth;
      }
    }
    if (contribution.extraCellWidth) {
      for (const [row, extra] of contribution.extraCellWidth) {
        const prev = extraCellWidth.get(row) ?? 0;
        if (extra > prev) extraCellWidth.set(row, extra);
      }
    }
  }

  // Track the last font string to avoid redundant ctx.font assignments
  let lastFont = "";

  for (const cell of cells) {
    // Skip merged cells that span multiple columns (Excel ignores them)
    if (cell.colSpan !== undefined && cell.colSpan > 1) {
      continue;
    }

    // Skip empty display values
    if (!cell.display) {
      continue;
    }

    // Skip cells a contributor renders itself (pivot overlay repaints them)
    if (claimedRows.length > 0 && isClaimed(cell.row, claimedRows)) {
      continue;
    }

    const style = cell.styleIndex < styles.length ? styles[cell.styleIndex] : undefined;

    // Wrap-text cells never widen a column (Excel: their text is defined to
    // fit whatever width the column has)
    if (style?.wrapText) {
      continue;
    }

    hasContent = true;
    let textWidth: number;
    if (cell.richText && cell.richText.length > 0) {
      // Rich text: each run renders with its own font
      textWidth = measureRichTextWidth(ctx, cell.richText, style, theme.cellFontFamily, theme.cellFontSize);
      lastFont = "";
    } else {
      const fontString = buildFontString(style, theme.cellFontFamily, theme.cellFontSize);
      if (fontString !== lastFont) {
        ctx.font = fontString;
        lastFont = fontString;
      }
      textWidth = ctx.measureText(cell.display).width;
    }

    // The renderer shifts text right by the style indent (8px per level)
    const indentWidth = (style?.indent ?? 0) * 8;
    const chrome = extraCellWidth.get(cell.row) ?? 0;
    const cellWidth = textWidth + indentWidth + PADDING_X * 2 + FIT_MARGIN + chrome;

    if (cellWidth > maxWidth) {
      maxWidth = cellWidth;
    }
  }

  // Nothing to fit: Excel leaves the column width unchanged
  if (!hasContent) {
    return null;
  }

  return Math.max(minWidth, Math.ceil(maxWidth));
}

/**
 * Measure the optimal height for a row based on its cell contents.
 *
 * Excel semantics:
 * - Height follows the largest font size applied in the row — even on cells
 *   with no text (a 24px-formatted empty cell still raises the row).
 * - Wrapped cells contribute their line count at the CURRENT column width.
 * - Cells merged across rows are ignored.
 * - A row whose default-size content fits the default height gets exactly the
 *   default height (never a cramped fit below it).
 * - An entirely empty row resets to the default height (return null; the
 *   caller applies the default).
 *
 * @param cells - Cells in the row (from getCellsInRows)
 * @param styles - All styles from getAllStyles() (index-ordered array)
 * @param columnWidths - Map of column index to custom width
 * @param defaultColWidth - Default column width for columns not in the map
 * @param theme - Font defaults from the grid theme
 * @param minHeight - Minimum allowed row height
 * @param defaultRowHeight - Default row height (floor for default-size text)
 * @param row - Row index (for contributor lookup)
 * @returns Optimal height in pixels, or null when the row is empty
 *          (Excel resets an empty row to the default height)
 */
export function measureOptimalRowHeight(
  cells: CellData[],
  styles: StyleData[],
  columnWidths: Map<number, number>,
  defaultColWidth: number,
  theme: { cellFontFamily: string; cellFontSize: number },
  minHeight: number,
  defaultRowHeight: number,
  row: number
): number | null {
  const ctx = getMeasureContext();
  let maxHeight = 0;
  let hasContent = false;

  const contributions = hasAutoFitContributors()
    ? collectAutoFitRowContributions(row, ctx)
    : [];

  const claimedCols: ClaimedSpan[] = [];
  for (const contribution of contributions) {
    if (contribution.claimedColRanges) {
      for (const range of contribution.claimedColRanges) {
        claimedCols.push({ start: range.startCol, end: range.endCol });
      }
    }
    if (contribution.requiredHeight !== undefined && contribution.requiredHeight > 0) {
      hasContent = true;
      if (contribution.requiredHeight > maxHeight) {
        maxHeight = contribution.requiredHeight;
      }
    }
  }

  let lastFont = "";
  let hasCellContent = false;

  for (const cell of cells) {
    // Skip merged cells entirely (Excel ignores merged cells for row autofit;
    // a colSpan merge would also wrap at the wrong single-column width)
    if (
      (cell.rowSpan !== undefined && cell.rowSpan > 1) ||
      (cell.colSpan !== undefined && cell.colSpan > 1)
    ) {
      continue;
    }

    // Skip cells a contributor renders itself
    if (claimedCols.length > 0 && isClaimed(cell.col, claimedCols)) {
      continue;
    }

    const style = cell.styleIndex < styles.length ? styles[cell.styleIndex] : undefined;
    let fontSize = style?.fontSize || theme.cellFontSize;

    // Rich text: the tallest run drives the height
    if (cell.richText && cell.richText.length > 0) {
      fontSize = maxRichTextFontSize(cell.richText, fontSize);
    }

    let lineCount = 1;

    // If wrap text is enabled, calculate how many lines this cell needs
    // (only cells with text can wrap)
    if (style?.wrapText && cell.display) {
      const fontString = buildFontString(style, theme.cellFontFamily, theme.cellFontSize);
      if (fontString !== lastFont) {
        ctx.font = fontString;
        lastFont = fontString;
      }
      const colWidth = columnWidths.get(cell.col) ?? defaultColWidth;
      const availableWidth = colWidth - PADDING_X * 2 - (style?.indent ?? 0) * 8;
      if (availableWidth > 0) {
        const lines = wrapTextForMeasurement(ctx, cell.display, availableWidth);
        lineCount = lines.length;
      }
    }

    hasContent = true;
    hasCellContent = true;
    // fontSize is in points; the line box is measured in pixels.
    let cellHeight = lineCount * pointsToPixels(fontSize) * LINE_HEIGHT_FACTOR + PADDING_Y * 2;

    // A single line at (or below) the default font size lands EXACTLY on the
    // standard row height — match Excel, where autofit of default-size text
    // yields the standard height. (The 1.2x line box computes slightly taller
    // than Excel's tighter default, so clamp to the default rather than max().)
    if (lineCount === 1 && fontSize <= theme.cellFontSize) {
      cellHeight = defaultRowHeight;
    }

    if (cellHeight > maxHeight) {
      maxHeight = cellHeight;
    }
  }

  // Entirely empty row: Excel resets it to the default height
  if (!hasContent) {
    return null;
  }

  // A row whose only contribution is extension chrome (e.g. a filter button
  // on an otherwise empty header row) still resets to at least the default —
  // chrome heights are minimums, not fits
  if (!hasCellContent) {
    maxHeight = Math.max(maxHeight, defaultRowHeight);
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
