//! FILENAME: app/extensions/Print/lib/pdfGenerator.ts
// PURPOSE: Generates PDF documents from PrintData using jsPDF.
// CONTEXT: Called when user exports via File > Export to PDF.

import { jsPDF } from "jspdf";
import type { PrintData } from "../../../src/api/lib";
import { indexToCol, colToIndex } from "../../../src/api/lib";

// ============================================================================
// Paper sizes in mm (same as printGenerator.ts)
// ============================================================================

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  letter: { width: 216, height: 279 },
  legal: { width: 216, height: 356 },
  tabloid: { width: 279, height: 432 },
};

// ============================================================================
// Constants
// ============================================================================

const PX_TO_MM = 0.264583; // 1px = 0.264583mm at 96 DPI
const PT_TO_MM = 0.352778; // 1pt = 0.352778mm

// Default font size in points
const DEFAULT_FONT_SIZE = 11;

// Cell padding in mm
const CELL_PAD_X = 1.0;

// Header/footer font size in pt
const HEADER_FOOTER_FONT_SIZE = 8;

// ============================================================================
// Helpers
// ============================================================================

function inchesToMm(inches: number): number {
  return inches * 25.4;
}

function pxToMm(px: number): number {
  return px * PX_TO_MM;
}

function ptToMm(pt: number): number {
  return pt * PT_TO_MM;
}

/** Parse a hex or rgba color string to [r, g, b] (0-255). */
function parseColor(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbaMatch) {
    return [parseInt(rgbaMatch[1]), parseInt(rgbaMatch[2]), parseInt(rgbaMatch[3])];
  }
  return [0, 0, 0]; // default black
}

function isWhiteOrTransparent(color: string): boolean {
  if (!color) return true;
  if (color === "#ffffff" || color === "#FFFFFF") return true;
  if (color.startsWith("rgba") && color.includes(", 0)")) return true;
  if (color === "rgba(255, 255, 255, 1)") return true;
  return false;
}

function isBlack(color: string): boolean {
  return color === "#000000" || color === "rgba(0, 0, 0, 1)" || !color;
}

// ============================================================================
// Print Area Parsing
// ============================================================================

interface PrintBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/** Parse a print area string like "A1:F20" into row/col bounds (0-indexed). */
function parsePrintArea(printArea: string): PrintBounds | null {
  if (!printArea || !printArea.trim()) return null;
  const match = printArea.trim().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    startCol: colToIndex(match[1].toUpperCase()),
    startRow: parseInt(match[2]) - 1,
    endCol: colToIndex(match[3].toUpperCase()),
    endRow: parseInt(match[4]) - 1,
  };
}

/** Parse print title rows like "1:3" into [startRow, endRow] (0-indexed). */
function parseTitleRows(spec: string): [number, number] | null {
  if (!spec || !spec.trim()) return null;
  const match = spec.trim().match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return [parseInt(match[1]) - 1, parseInt(match[2]) - 1];
}

/** Parse print title cols like "A:C" into [startCol, endCol] (0-indexed). */
function parseTitleCols(spec: string): [number, number] | null {
  if (!spec || !spec.trim()) return null;
  const match = spec.trim().match(/^([A-Z]+):([A-Z]+)$/i);
  if (!match) return null;
  return [colToIndex(match[1].toUpperCase()), colToIndex(match[2].toUpperCase())];
}

// ============================================================================
// Three-Section Header/Footer Parsing
// ============================================================================

interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

/**
 * Parse header/footer text with &L, &C, &R section codes.
 * Format: "&LLeft text&CCenter text&RRight text"
 * If no section codes are used, the entire text goes to center (Excel behavior).
 */
function parseHeaderFooterSections(text: string): HeaderFooterSections {
  if (!text) return { left: "", center: "", right: "" };

  // Check if any section codes are present
  const hasSections = /&[LCR]/i.test(text);
  if (!hasSections) {
    return { left: "", center: text, right: "" };
  }

  let left = "";
  let center = "";
  let right = "";
  let current: "left" | "center" | "right" = "center"; // default section before any code

  // Split on section codes, keeping track of current section
  let remaining = text;
  // Text before the first section code goes to the first section encountered
  const firstCodeMatch = remaining.match(/&[LCR]/i);
  if (firstCodeMatch && firstCodeMatch.index !== undefined && firstCodeMatch.index > 0) {
    // Text before first code - treat as center (pre-section text)
    center = remaining.slice(0, firstCodeMatch.index);
    remaining = remaining.slice(firstCodeMatch.index);
  }

  // Now process section codes
  const parts = remaining.split(/(&[LCR])/i);
  for (const part of parts) {
    if (/^&L$/i.test(part)) {
      current = "left";
    } else if (/^&C$/i.test(part)) {
      current = "center";
    } else if (/^&R$/i.test(part)) {
      current = "right";
    } else {
      if (current === "left") left += part;
      else if (current === "center") center += part;
      else right += part;
    }
  }

  return { left: left.trim(), center: center.trim(), right: right.trim() };
}

/** Replace dynamic field codes with actual values. */
function replaceDynamicFields(
  text: string,
  pageNum: number,
  totalPages: number,
  sheetName: string,
): string {
  if (!text) return "";
  return text
    .replace(/&P/g, String(pageNum))
    .replace(/&N/g, String(totalPages))
    .replace(/&D/g, new Date().toLocaleDateString())
    .replace(/&T/g, new Date().toLocaleTimeString())
    .replace(/&F/g, sheetName)
    .replace(/&A/g, sheetName);
}

// ============================================================================
// Page Break Computation
// ============================================================================

interface PageBreak {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

function computePageBreaks(
  data: PrintData,
  contentWidth: number,
  contentHeight: number,
  printBounds: PrintBounds,
  titleRows: [number, number] | null,
  titleCols: [number, number] | null,
): PageBreak[] {
  const { colWidths, rowHeights, pageSetup } = data;
  const { startRow, endRow, startCol, endCol } = printBounds;
  const scalePct = pageSetup.scale || 100;

  // Convert column widths to mm
  const colMm: number[] = [];
  for (let c = 0; c <= endCol; c++) {
    colMm.push(pxToMm((colWidths[c] ?? 100) * scalePct / 100));
  }

  // Convert row heights to mm
  const rowMm: number[] = [];
  for (let r = 0; r <= endRow; r++) {
    rowMm.push(pxToMm((rowHeights[r] ?? 24) * scalePct / 100));
  }

  // Account for heading row/column
  const headingColWidth = pageSetup.printHeadings ? 10 : 0; // mm for row numbers
  const headingRowHeight = pageSetup.printHeadings ? 5 : 0;  // mm for column letters

  // Calculate space taken by title columns (repeated on each horizontal page)
  let titleColsWidth = 0;
  if (titleCols) {
    for (let c = titleCols[0]; c <= titleCols[1]; c++) {
      titleColsWidth += colMm[c] ?? 0;
    }
  }

  // Calculate space taken by title rows (repeated on each vertical page)
  let titleRowsHeight = 0;
  if (titleRows) {
    for (let r = titleRows[0]; r <= titleRows[1]; r++) {
      titleRowsHeight += rowMm[r] ?? 0;
    }
  }

  // Manual page break sets
  const manualRowBreaks = new Set(data.pageSetup.manualRowBreaks ?? []);
  const manualColBreaks = new Set(data.pageSetup.manualColBreaks ?? []);

  // Compute column page breaks (excluding title columns from content columns)
  const colBreaks: Array<{ start: number; end: number }> = [];
  let colStart = startCol;
  // Skip title columns in the content flow (they repeat on every page)
  if (titleCols) {
    // If title cols overlap with start, skip past them for content
    if (colStart >= titleCols[0] && colStart <= titleCols[1]) {
      colStart = titleCols[1] + 1;
    }
  }
  let accW = headingColWidth + titleColsWidth;
  for (let c = colStart; c <= endCol; c++) {
    // Skip title columns in content flow
    if (titleCols && c >= titleCols[0] && c <= titleCols[1]) continue;

    const isManualBreak = manualColBreaks.has(c) && c > colStart;
    if ((accW + colMm[c] > contentWidth || isManualBreak) && c > colStart) {
      // Find the previous non-title column for the end
      let prevC = c - 1;
      while (titleCols && prevC >= titleCols[0] && prevC <= titleCols[1] && prevC > colStart) {
        prevC--;
      }
      colBreaks.push({ start: colStart, end: prevC });
      colStart = c;
      accW = headingColWidth + titleColsWidth;
    }
    accW += colMm[c];
  }
  colBreaks.push({ start: colStart, end: endCol });

  // Compute row page breaks (per column group)
  const pages: PageBreak[] = [];
  for (const colBreak of colBreaks) {
    let rowStart = startRow;
    // Skip title rows in the content flow
    if (titleRows) {
      if (rowStart >= titleRows[0] && rowStart <= titleRows[1]) {
        rowStart = titleRows[1] + 1;
      }
    }
    let accH = headingRowHeight + titleRowsHeight;
    for (let r = rowStart; r <= endRow; r++) {
      // Skip title rows in content flow
      if (titleRows && r >= titleRows[0] && r <= titleRows[1]) continue;

      const isManualBreak = manualRowBreaks.has(r) && r > rowStart;
      if ((accH + rowMm[r] > contentHeight || isManualBreak) && r > rowStart) {
        let prevR = r - 1;
        while (titleRows && prevR >= titleRows[0] && prevR <= titleRows[1] && prevR > rowStart) {
          prevR--;
        }
        pages.push({
          startRow: rowStart,
          endRow: prevR,
          startCol: colBreak.start,
          endCol: colBreak.end,
        });
        rowStart = r;
        accH = headingRowHeight + titleRowsHeight;
      }
      accH += rowMm[r];
    }
    pages.push({
      startRow: rowStart,
      endRow: endRow,
      startCol: colBreak.start,
      endCol: colBreak.end,
    });
  }

  return pages;
}

// ============================================================================
// PDF Generation
// ============================================================================

/**
 * Generate a PDF from PrintData and return as ArrayBuffer.
 */
export function generatePdf(data: PrintData): ArrayBuffer {
  const { cells, styles, colWidths, rowHeights, mergedRegions, pageSetup, sheetName, bounds } = data;
  const [maxRow, maxCol] = bounds;

  // Parse print area
  const printArea = parsePrintArea(pageSetup.printArea);
  const printBounds: PrintBounds = printArea ?? {
    startRow: 0, endRow: maxRow,
    startCol: 0, endCol: maxCol,
  };

  // Parse print titles
  const titleRows = parseTitleRows(pageSetup.printTitlesRows);
  const titleCols = parseTitleCols(pageSetup.printTitlesCols);

  // Paper dimensions
  const paper = PAPER_SIZES[pageSetup.paperSize] || PAPER_SIZES.a4;
  const isLandscape = pageSetup.orientation === "landscape";
  const pageW = isLandscape ? paper.height : paper.width;
  const pageH = isLandscape ? paper.width : paper.height;

  // Margins in mm
  const mTop = inchesToMm(pageSetup.marginTop);
  const mBottom = inchesToMm(pageSetup.marginBottom);
  const mLeft = inchesToMm(pageSetup.marginLeft);
  const mRight = inchesToMm(pageSetup.marginRight);
  const mHeader = inchesToMm(pageSetup.marginHeader);
  const mFooter = inchesToMm(pageSetup.marginFooter);

  // Content area dimensions
  const contentWidth = pageW - mLeft - mRight;
  const contentHeight = pageH - mTop - mBottom;

  // Scale
  const scalePct = pageSetup.scale || 100;

  // Build cell lookup map
  const cellMap = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) {
    cellMap.set(`${cell.row},${cell.col}`, cell);
  }

  // Build merged cell set (cells hidden by merges)
  const mergedHidden = new Set<string>();
  const mergeMap = new Map<string, { endRow: number; endCol: number }>();
  for (const mr of mergedRegions) {
    mergeMap.set(`${mr.startRow},${mr.startCol}`, { endRow: mr.endRow, endCol: mr.endCol });
    for (let r = mr.startRow; r <= mr.endRow; r++) {
      for (let c = mr.startCol; c <= mr.endCol; c++) {
        if (r !== mr.startRow || c !== mr.startCol) {
          mergedHidden.add(`${r},${c}`);
        }
      }
    }
  }

  // Convert dimensions to mm
  const colMm: number[] = [];
  for (let c = 0; c <= maxCol; c++) {
    colMm.push(pxToMm((colWidths[c] ?? 100) * scalePct / 100));
  }
  const rowMm: number[] = [];
  for (let r = 0; r <= maxRow; r++) {
    rowMm.push(pxToMm((rowHeights[r] ?? 24) * scalePct / 100));
  }

  // Heading dimensions
  const headingColWidth = pageSetup.printHeadings ? 10 : 0;
  const headingRowHeight = pageSetup.printHeadings ? 5 : 0;

  // Compute page breaks
  const pages = computePageBreaks(data, contentWidth, contentHeight, printBounds, titleRows, titleCols);

  // Create PDF
  const orientation = isLandscape ? "landscape" : "portrait";
  const doc = new jsPDF({
    orientation,
    unit: "mm",
    format: [pageW, pageH],
  });

  const totalPages = pages.length;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (pageIdx > 0) doc.addPage([pageW, pageH], orientation);

    // --- Draw three-section header ---
    const headerSections = parseHeaderFooterSections(pageSetup.header);
    const headerLeft = replaceDynamicFields(headerSections.left, pageIdx + 1, totalPages, sheetName);
    const headerCenter = replaceDynamicFields(headerSections.center, pageIdx + 1, totalPages, sheetName);
    const headerRight = replaceDynamicFields(headerSections.right, pageIdx + 1, totalPages, sheetName);

    if (headerLeft || headerCenter || headerRight) {
      doc.setFontSize(HEADER_FOOTER_FONT_SIZE);
      doc.setTextColor(100, 100, 100);
      doc.setFont("helvetica", "normal");
      const headerY = mHeader + 3;
      if (headerLeft) {
        doc.text(headerLeft, mLeft, headerY, { align: "left" });
      }
      if (headerCenter) {
        doc.text(headerCenter, pageW / 2, headerY, { align: "center" });
      }
      if (headerRight) {
        doc.text(headerRight, pageW - mRight, headerY, { align: "right" });
      }
    }

    // --- Draw three-section footer ---
    const footerSections = parseHeaderFooterSections(pageSetup.footer);
    const footerLeft = replaceDynamicFields(footerSections.left, pageIdx + 1, totalPages, sheetName);
    const footerCenter = replaceDynamicFields(footerSections.center, pageIdx + 1, totalPages, sheetName);
    const footerRight = replaceDynamicFields(footerSections.right, pageIdx + 1, totalPages, sheetName);

    if (footerLeft || footerCenter || footerRight) {
      doc.setFontSize(HEADER_FOOTER_FONT_SIZE);
      doc.setTextColor(100, 100, 100);
      doc.setFont("helvetica", "normal");
      const footerY = pageH - mFooter;
      if (footerLeft) {
        doc.text(footerLeft, mLeft, footerY, { align: "left" });
      }
      if (footerCenter) {
        doc.text(footerCenter, pageW / 2, footerY, { align: "center" });
      }
      if (footerRight) {
        doc.text(footerRight, pageW - mRight, footerY, { align: "right" });
      }
    }

    // --- Build list of rows to draw on this page ---
    // Title rows come first (if not on the first page where they're naturally included)
    const rowsToDraw: number[] = [];

    // Add title rows at the top (if they exist and aren't already part of this page's range)
    if (titleRows) {
      for (let r = titleRows[0]; r <= titleRows[1]; r++) {
        // Only add title rows if they aren't already in the page range
        if (r < page.startRow || r > page.endRow) {
          rowsToDraw.push(r);
        }
      }
    }

    // Add the page's content rows (skip title rows already added)
    for (let r = page.startRow; r <= page.endRow; r++) {
      if (titleRows && r >= titleRows[0] && r <= titleRows[1]) {
        // Include title rows in their natural position on the first vertical page
        rowsToDraw.push(r);
      } else {
        rowsToDraw.push(r);
      }
    }

    // --- Build list of columns to draw on this page ---
    const colsToDraw: number[] = [];

    // Add title columns at the left (if they exist and aren't already in range)
    if (titleCols) {
      for (let c = titleCols[0]; c <= titleCols[1]; c++) {
        if (c < page.startCol || c > page.endCol) {
          colsToDraw.push(c);
        }
      }
    }

    // Add the page's content columns
    for (let c = page.startCol; c <= page.endCol; c++) {
      if (titleCols && c >= titleCols[0] && c <= titleCols[1] && colsToDraw.includes(c)) {
        continue; // Already added as title col
      }
      colsToDraw.push(c);
    }

    // Current drawing position
    let curY = mTop;

    // Compute X offsets for columns on this page
    const colOffsets: Map<number, number> = new Map();
    let xOff = mLeft + headingColWidth;
    for (const c of colsToDraw) {
      colOffsets.set(c, xOff);
      xOff += colMm[c];
    }

    // Draw column headings
    if (pageSetup.printHeadings) {
      const headY = curY;
      curY += headingRowHeight;

      doc.setFillColor(240, 240, 240);
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.2);
      doc.setFontSize(7);
      doc.setTextColor(100, 100, 100);
      doc.setFont("helvetica", "bold");

      // Empty corner cell
      doc.rect(mLeft, headY, headingColWidth, headingRowHeight, "FD");

      for (const c of colsToDraw) {
        const cx = colOffsets.get(c)!;
        doc.rect(cx, headY, colMm[c], headingRowHeight, "FD");
        doc.text(indexToCol(c), cx + colMm[c] / 2, headY + headingRowHeight / 2 + 1, {
          align: "center",
        });
      }
    }

    // Draw rows
    for (const r of rowsToDraw) {
      const rowH = rowMm[r];

      // Row heading
      if (pageSetup.printHeadings) {
        doc.setFillColor(240, 240, 240);
        doc.setDrawColor(200, 200, 200);
        doc.setLineWidth(0.2);
        doc.setFontSize(7);
        doc.setTextColor(100, 100, 100);
        doc.setFont("helvetica", "bold");
        doc.rect(mLeft, curY, headingColWidth, rowH, "FD");
        doc.text(String(r + 1), mLeft + headingColWidth / 2, curY + rowH / 2 + 1, {
          align: "center",
        });
      }

      // Data cells
      for (const c of colsToDraw) {
        const key = `${r},${c}`;
        if (mergedHidden.has(key)) continue;

        const cx = colOffsets.get(c)!;
        let cellW = colMm[c];
        let cellH = rowH;

        // Expand for merged cells
        const merge = mergeMap.get(key);
        if (merge) {
          for (let mc = c + 1; mc <= merge.endCol; mc++) {
            if (colOffsets.has(mc)) {
              cellW += colMm[mc];
            }
          }
          for (let mr = r + 1; mr <= merge.endRow; mr++) {
            if (rowsToDraw.includes(mr)) {
              cellH += rowMm[mr];
            }
          }
        }

        const cell = cellMap.get(key);
        const styleIndex = cell?.styleIndex ?? 0;
        const style = styles[styleIndex];
        const display = cell?.display ?? "";

        // Background fill
        if (style && !isWhiteOrTransparent(style.backgroundColor)) {
          const [br, bg, bb] = parseColor(style.backgroundColor);
          doc.setFillColor(br, bg, bb);
          doc.rect(cx, curY, cellW, cellH, "F");
        }

        // Gridlines
        if (pageSetup.printGridlines) {
          doc.setDrawColor(210, 210, 210);
          doc.setLineWidth(0.1);
          doc.rect(cx, curY, cellW, cellH, "S");
        }

        // Cell borders
        if (style) {
          drawBorder(doc, style.borderTop, cx, curY, cx + cellW, curY);
          drawBorder(doc, style.borderBottom, cx, curY + cellH, cx + cellW, curY + cellH);
          drawBorder(doc, style.borderLeft, cx, curY, cx, curY + cellH);
          drawBorder(doc, style.borderRight, cx + cellW, curY, cx + cellW, curY + cellH);
          // Diagonal borders
          if (style.borderDiagonalDown) drawBorder(doc, style.borderDiagonalDown, cx, curY, cx + cellW, curY + cellH);
          if (style.borderDiagonalUp) drawBorder(doc, style.borderDiagonalUp, cx, curY + cellH, cx + cellW, curY);
        }

        // Cell text
        if (display) {
          const fontSize = (style?.fontSize || DEFAULT_FONT_SIZE) * scalePct / 100;
          const fontStyle = (style?.bold ? "bold" : "") + (style?.italic ? "italic" : "") || "normal";

          doc.setFontSize(fontSize);
          doc.setFont("helvetica", fontStyle);

          if (style && !isBlack(style.textColor)) {
            const [tr, tg, tb] = parseColor(style.textColor);
            doc.setTextColor(tr, tg, tb);
          } else {
            doc.setTextColor(0, 0, 0);
          }

          // Alignment
          let textX = cx + CELL_PAD_X;
          let align: "left" | "center" | "right" = "left";
          if (style?.textAlign === "center") {
            textX = cx + cellW / 2;
            align = "center";
          } else if (style?.textAlign === "right") {
            textX = cx + cellW - CELL_PAD_X;
            align = "right";
          }

          // Vertical positioning (approximate middle)
          const textY = curY + cellH / 2 + ptToMm(fontSize) * 0.35;

          // Clip text to cell width
          const maxTextWidth = cellW - CELL_PAD_X * 2;
          if (maxTextWidth > 0) {
            doc.text(display, textX, textY, {
              align,
              maxWidth: maxTextWidth,
            });
          }
        }
      }

      curY += rowH;
    }
  }

  return doc.output("arraybuffer");
}

// ============================================================================
// Border Drawing
// ============================================================================

function drawBorder(
  doc: jsPDF,
  border: { style: string; color: string; width: number } | null | undefined,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  if (!border || border.style === "none" || border.width === 0) return;

  const [r, g, b] = parseColor(border.color);
  doc.setDrawColor(r, g, b);
  doc.setLineWidth(Math.max(0.1, border.width * PX_TO_MM));

  doc.line(x1, y1, x2, y2);
}
