//! FILENAME: app/extensions/Print/lib/pdfGenerator.ts
// PURPOSE: Generates PDF documents from PrintData using jsPDF.
// CONTEXT: Called when user exports via File > Export to PDF.

import { jsPDF } from "jspdf";
import type { PrintData } from "../../../src/api/lib";
import { indexToCol } from "../../../src/api/lib";

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
): PageBreak[] {
  const { colWidths, rowHeights, bounds, pageSetup } = data;
  const [maxRow, maxCol] = bounds;
  const scalePct = pageSetup.scale || 100;

  // Convert column widths to mm
  const colMm: number[] = [];
  for (let c = 0; c <= maxCol; c++) {
    colMm.push(pxToMm((colWidths[c] ?? 100) * scalePct / 100));
  }

  // Convert row heights to mm
  const rowMm: number[] = [];
  for (let r = 0; r <= maxRow; r++) {
    rowMm.push(pxToMm((rowHeights[r] ?? 24) * scalePct / 100));
  }

  // Account for heading row/column
  const headingColWidth = pageSetup.printHeadings ? 10 : 0; // mm for row numbers
  const headingRowHeight = pageSetup.printHeadings ? 5 : 0;  // mm for column letters

  // Compute column page breaks
  const colBreaks: Array<{ start: number; end: number }> = [];
  let colStart = 0;
  let accW = headingColWidth;
  for (let c = 0; c <= maxCol; c++) {
    if (accW + colMm[c] > contentWidth && c > colStart) {
      colBreaks.push({ start: colStart, end: c - 1 });
      colStart = c;
      accW = headingColWidth;
    }
    accW += colMm[c];
  }
  colBreaks.push({ start: colStart, end: maxCol });

  // Compute row page breaks (per column group)
  const pages: PageBreak[] = [];
  for (const colBreak of colBreaks) {
    let rowStart = 0;
    let accH = headingRowHeight;
    for (let r = 0; r <= maxRow; r++) {
      if (accH + rowMm[r] > contentHeight && r > rowStart) {
        pages.push({
          startRow: rowStart,
          endRow: r - 1,
          startCol: colBreak.start,
          endCol: colBreak.end,
        });
        rowStart = r;
        accH = headingRowHeight;
      }
      accH += rowMm[r];
    }
    pages.push({
      startRow: rowStart,
      endRow: maxRow,
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
  const pages = computePageBreaks(data, contentWidth, contentHeight);

  // Header/footer processing
  const processHeaderFooter = (text: string, pageNum: number, totalPages: number): string => {
    if (!text) return "";
    return text
      .replace(/&P/g, String(pageNum))
      .replace(/&N/g, String(totalPages))
      .replace(/&D/g, new Date().toLocaleDateString())
      .replace(/&T/g, new Date().toLocaleTimeString())
      .replace(/&F/g, sheetName)
      .replace(/&A/g, sheetName);
  };

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

    // Draw header
    const headerText = processHeaderFooter(pageSetup.header, pageIdx + 1, totalPages);
    if (headerText) {
      doc.setFontSize(HEADER_FOOTER_FONT_SIZE);
      doc.setTextColor(100, 100, 100);
      doc.text(headerText, pageW / 2, mHeader + 3, { align: "center" });
    }

    // Draw footer
    const footerText = processHeaderFooter(pageSetup.footer, pageIdx + 1, totalPages);
    if (footerText) {
      doc.setFontSize(HEADER_FOOTER_FONT_SIZE);
      doc.setTextColor(100, 100, 100);
      doc.text(footerText, pageW / 2, pageH - mFooter, { align: "center" });
    }

    // Current drawing position
    let curY = mTop;

    // Compute X offsets for columns in this page
    const colOffsets: number[] = [];
    let xOff = mLeft + headingColWidth;
    for (let c = page.startCol; c <= page.endCol; c++) {
      colOffsets[c] = xOff;
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

      for (let c = page.startCol; c <= page.endCol; c++) {
        const cx = colOffsets[c];
        doc.rect(cx, headY, colMm[c], headingRowHeight, "FD");
        doc.text(indexToCol(c), cx + colMm[c] / 2, headY + headingRowHeight / 2 + 1, {
          align: "center",
        });
      }
    }

    // Draw rows
    for (let r = page.startRow; r <= page.endRow; r++) {
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
      for (let c = page.startCol; c <= page.endCol; c++) {
        const key = `${r},${c}`;
        if (mergedHidden.has(key)) continue;

        const cx = colOffsets[c];
        let cellW = colMm[c];
        let cellH = rowH;

        // Expand for merged cells
        const merge = mergeMap.get(key);
        if (merge) {
          for (let mc = c + 1; mc <= merge.endCol && mc <= page.endCol; mc++) {
            cellW += colMm[mc];
          }
          for (let mr = r + 1; mr <= merge.endRow && mr <= page.endRow; mr++) {
            cellH += rowMm[mr];
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
