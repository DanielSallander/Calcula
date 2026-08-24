//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFit.ts
// PURPOSE: Auto-fit (best-fit) measurement for double-click column/row resize.
// CONTEXT: Mirrors Excel's AutoFit semantics: fit the widest RENDERED cell in
//          the whole column (per-cell fonts, formatted display text), skip
//          wrap-text and merged-across cells, leave empty columns unchanged,
//          reset empty rows to the default height. Extension-rendered content
//          (pivot overlays, filter buttons) participates via the
//          @api/autoFitContributors registry.
//          ALSO OWNS the line-breaking recipe (hard breaks + word wrap) that
//          rendering/cells.ts paints with -- see the section at the bottom.
//
// HIDDEN ROWS/COLUMNS ARE DELIBERATELY NOT CONSULTED HERE.
//   Excel's AutoFit measures every cell in the column, hidden and filtered
//   rows included — it is a long-standing complaint, not an oversight: the
//   whole family of "autofit visible cells only" VBA recipes
//   (`SpecialCells(xlCellTypeVisible).EntireColumn.AutoFit`, or looping over
//   columns testing `.Hidden = False`) exists precisely because
//   `EntireColumn.AutoFit` takes hidden rows and columns into account and
//   there is no native way to tell it otherwise. Blogs claiming AutoFit
//   "ignores hidden rows" are SEO filler and contradict those workarounds.
//   So passing the full cell list from getCellsInCols/getCellsInRows — which
//   is what the callers do — is the Excel-correct behaviour. Do NOT filter
//   the input by dimensions.hiddenRows/hiddenCols: a column would silently
//   change width whenever a filter is applied or cleared, and re-widen on
//   unhide, which Excel never does.
//
//   Not covered here: Excel also UNHIDES a hidden row/column that you
//   autofit (its hidden flag is a zero size, so assigning a size reveals it).
//   Calcula keeps hidden-ness in its own per-sheet state, orthogonal to
//   height/width, so an autofit resizes a hidden line without revealing it.
//   That is a gesture-level decision for the resize handler, not a
//   measurement one, and it must never apply to filter-hidden lines.

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

/**
 * Width of the WIDEST line of a value, at the current font.
 *
 * A hard break paints as a break whether or not Wrap Text is on, so the column
 * has to fit the widest LINE. Measuring the raw string instead runs the lines
 * together -- `measureText` applies the same "every space character becomes
 * U+0020" preparation `fillText` does -- and autofits the column to the summed
 * width of lines that are never side by side.
 */
function measureWidestLine(ctx: CanvasRenderingContext2D, text: string): number {
  if (!hasHardBreak(text)) return ctx.measureText(text).width;
  let widest = 0;
  for (const line of splitHardBreaks(text)) {
    const width = ctx.measureText(line).width;
    if (width > widest) widest = width;
  }
  return widest;
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
      textWidth = measureWidestLine(ctx, cell.display);
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
      // No `availableWidth > 0` guard: `wrapText` falls back to hard-break
      // splitting alone when there is no usable width, which is one line for
      // ordinary text -- the same answer the guard used to hard-code -- and the
      // right line COUNT for a cell whose breaks the painter honours anyway.
      lineCount = wrapText(ctx, cell.display, availableWidth).length;
    } else if (cell.display) {
      // HARD BREAKS RAISE THE ROW WITH WRAP TEXT OFF TOO, because the painter
      // breaks on them either way (rendering/cells.ts). Measuring one line here
      // would hand back the default height and the row would then CLIP every
      // line the painter drew below the first -- so fixing only the painter
      // trades one wrong answer for another.
      lineCount = splitHardBreaks(cell.display).length;
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

// ---------------------------------------------------------------------------
// Line breaking -- ONE recipe, shared with the painter
// ---------------------------------------------------------------------------
//
// `rendering/cells.ts` imports these three. It used to carry its own
// byte-identical copy of the wrapper under a different name, and the copy is
// exactly what let a hard break be ignored in TWO places at once: the text
// painted on one line AND the row refused to grow for it, so autofitting the
// row could not even reveal the defect.
//
// THE DIRECTION IS rendering -> layout, and it is not arbitrary. The painter
// already imports viewport/dimensions/headerVisibility from this folder; the
// reverse edge would drag the painter's whole graph -- `@api/cellTypes`, and
// through it `@tauri-apps/api/core` -- into a module whose only job is to
// measure text.

/**
 * A HARD line break, in every spelling text arrives in: LF (Alt+Enter and
 * `CHAR(10)`), CRLF (a Windows paste) and a bare CR (an old-Mac paste, and what
 * some editors leave behind).
 *
 * An alternation rather than a character class, because CRLF must be tried
 * FIRST -- `[\r\n]` would break a Windows paste twice per line and produce a
 * blank line between every pair. Deliberately not `/g`: a global regex carries
 * `lastIndex` between `.test` calls and would answer false every other time.
 */
const HARD_BREAK = /\r\n|\r|\n/;

/**
 * Split a value at its hard breaks.
 *
 * AN EMPTY SEGMENT IS A LINE. `"a" & CHAR(10) & CHAR(10) & "b"` is three lines
 * with the middle one deliberately blank, so nothing here -- and nothing
 * downstream -- may filter empties out.
 */
export function splitHardBreaks(text: string): string[] {
  return text.split(HARD_BREAK);
}

/** True when a value carries a hard break in any of its spellings. */
export function hasHardBreak(text: string): boolean {
  return HARD_BREAK.test(text);
}

/**
 * Word-wrap text into lines that fit within maxWidth, breaking unconditionally
 * at every hard break first.
 *
 * WHY THE HARD BREAKS COME OFF BEFORE ANY WRAPPING HAPPENS. The word splitter
 * is `/(\s+)/`, which counts LF as ordinary inter-word whitespace -- so a
 * newline used to be a mere wrap CANDIDATE, and once the line fit, canvas
 * `fillText` rendered the LF as U+0020 and the two lines painted as one with a
 * space between them.
 *
 * Splitting first is also what keeps a deliberately blank line alive: the
 * `currentLine.trim() !== ""` guard in `wrapSegment` drops a whitespace-only
 * line, which is right INSIDE a wrapped paragraph and wrong for a line the user
 * typed on purpose. After the split it can no longer see one.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const segments = splitHardBreaks(text);
  if (maxWidth <= 0) return segments;

  const lines: string[] = [];
  for (const segment of segments) {
    for (const line of wrapSegment(ctx, segment, maxWidth)) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Wrap ONE hard-break-free segment. Never returns an empty array: a segment
 * that produces no glyphs is still a line on screen.
 */
function wrapSegment(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine + word;
    const testWidth = ctx.measureText(testLine).width;

    if (testWidth <= maxWidth || currentLine === "") {
      currentLine = testLine;
    } else {
      // Whitespace-only leftovers are dropped so a wrapped line does not START
      // with the space run that pushed it over. SAFE ONLY BECAUSE HARD BREAKS
      // ARE ALREADY GONE -- applied to a whole value this same guard swallows a
      // deliberately blank line, and `"a" & CHAR(10) & CHAR(10) & "b"` came back
      // as two lines instead of three.
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
