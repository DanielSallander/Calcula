//! FILENAME: app/extensions/Print/lib/printGenerator.ts
// PURPOSE: Generates print-ready HTML from grid data and triggers browser print.
// CONTEXT: Called when user prints via Ctrl+P or File > Print.

import type { PrintData, PageSetup } from "@api/lib";
import { indexToCol, colToIndex } from "@api/lib";

// ============================================================================
// Paper sizes in CSS (mm)
// ============================================================================

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  letter: { width: 216, height: 279 },
  legal: { width: 216, height: 356 },
  tabloid: { width: 279, height: 432 },
};

// ============================================================================
// Helpers
// ============================================================================

function inchesToMm(inches: number): number {
  return inches * 25.4;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================
// Print Area & Title Parsing
// ============================================================================

interface PrintBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

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

function parseTitleRows(spec: string): [number, number] | null {
  if (!spec || !spec.trim()) return null;
  const match = spec.trim().match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return [parseInt(match[1]) - 1, parseInt(match[2]) - 1];
}

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

function parseHeaderFooterSections(text: string): HeaderFooterSections {
  if (!text) return { left: "", center: "", right: "" };

  const hasSections = /&[LCR]/i.test(text);
  if (!hasSections) {
    return { left: "", center: text, right: "" };
  }

  let left = "";
  let center = "";
  let right = "";
  let current: "left" | "center" | "right" = "center";

  let remaining = text;
  const firstCodeMatch = remaining.match(/&[LCR]/i);
  if (firstCodeMatch && firstCodeMatch.index !== undefined && firstCodeMatch.index > 0) {
    center = remaining.slice(0, firstCodeMatch.index);
    remaining = remaining.slice(firstCodeMatch.index);
  }

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

function replaceDynamicFields(text: string, sheetName: string): string {
  if (!text) return "";
  return text
    .replace(/&P/g, "1") // Page number placeholder (browser handles pagination)
    .replace(/&N/g, "1") // Total pages placeholder
    .replace(/&D/g, new Date().toLocaleDateString())
    .replace(/&T/g, new Date().toLocaleTimeString())
    .replace(/&F/g, sheetName)
    .replace(/&A/g, sheetName);
}

// ============================================================================
// Cell Style Builder
// ============================================================================

function buildCellStyle(
  styleData: PrintData["styles"][number],
  pageSetup: PageSetup,
): string {
  const parts: string[] = [];

  if (styleData.bold) parts.push("font-weight:bold");
  if (styleData.italic) parts.push("font-style:italic");
  const hasUnderline = styleData.underline && styleData.underline !== "none";
  if (hasUnderline) parts.push("text-decoration:underline");
  if (styleData.strikethrough) {
    parts.push(
      hasUnderline
        ? "text-decoration:underline line-through"
        : "text-decoration:line-through",
    );
  }
  if (styleData.fontSize && styleData.fontSize !== 11) {
    parts.push(`font-size:${styleData.fontSize}pt`);
  }
  if (styleData.fontFamily && styleData.fontFamily !== "Calibri") {
    parts.push(`font-family:"${styleData.fontFamily}",sans-serif`);
  }
  if (styleData.textColor && styleData.textColor !== "#000000" && styleData.textColor !== "rgba(0, 0, 0, 1)") {
    parts.push(`color:${styleData.textColor}`);
  }
  if (styleData.backgroundColor && styleData.backgroundColor !== "#ffffff" && styleData.backgroundColor !== "rgba(255, 255, 255, 1)") {
    parts.push(`background-color:${styleData.backgroundColor}`);
  }

  // Alignment
  const align = styleData.textAlign;
  if (align === "center") parts.push("text-align:center");
  else if (align === "right") parts.push("text-align:right");
  else if (align === "left") parts.push("text-align:left");

  const vAlign = styleData.verticalAlign;
  if (vAlign === "top") parts.push("vertical-align:top");
  else if (vAlign === "bottom") parts.push("vertical-align:bottom");

  if (styleData.wrapText) parts.push("white-space:pre-wrap;word-wrap:break-word");

  // Borders
  const borderSide = (side: string, b: { style: string; color: string; width: number }) => {
    if (!b || b.style === "none") return;
    const w = b.width || 1;
    const s = b.style === "double" ? "double" : b.style === "dashed" ? "dashed" : b.style === "dotted" ? "dotted" : "solid";
    parts.push(`border-${side}:${w}px ${s} ${b.color}`);
  };
  if (styleData.borderTop) borderSide("top", styleData.borderTop);
  if (styleData.borderBottom) borderSide("bottom", styleData.borderBottom);
  if (styleData.borderLeft) borderSide("left", styleData.borderLeft);
  if (styleData.borderRight) borderSide("right", styleData.borderRight);

  // Gridlines (when no explicit border, add light gridlines if enabled)
  if (pageSetup.printGridlines) {
    if (!styleData.borderTop) parts.push("border-top:1px solid #d0d0d0");
    if (!styleData.borderBottom) parts.push("border-bottom:1px solid #d0d0d0");
    if (!styleData.borderLeft) parts.push("border-left:1px solid #d0d0d0");
    if (!styleData.borderRight) parts.push("border-right:1px solid #d0d0d0");
  }

  return parts.join(";");
}

// ============================================================================
// HTML Generation
// ============================================================================

function generatePrintHtml(data: PrintData): string {
  const { cells, styles, colWidths, rowHeights, mergedRegions, pageSetup, sheetName, bounds } = data;
  const [maxRow, maxCol] = bounds;

  // Parse print area
  const printArea = parsePrintArea(pageSetup.printArea);
  const startRow = printArea?.startRow ?? 0;
  const endRow = printArea?.endRow ?? maxRow;
  const startCol = printArea?.startCol ?? 0;
  const endCol = printArea?.endCol ?? maxCol;

  // Parse print titles
  const titleRows = parseTitleRows(pageSetup.printTitlesRows);
  const titleCols = parseTitleCols(pageSetup.printTitlesCols);

  // Paper dimensions
  const paper = PAPER_SIZES[pageSetup.paperSize] || PAPER_SIZES.a4;
  const isLandscape = pageSetup.orientation === "landscape";
  const pageW = isLandscape ? paper.height : paper.width;
  const pageH = isLandscape ? paper.width : paper.height;

  // Margins
  const mTop = inchesToMm(pageSetup.marginTop);
  const mBottom = inchesToMm(pageSetup.marginBottom);
  const mLeft = inchesToMm(pageSetup.marginLeft);
  const mRight = inchesToMm(pageSetup.marginRight);

  // Build cell lookup map
  const cellMap = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) {
    cellMap.set(`${cell.row},${cell.col}`, cell);
  }

  // Build merged cell set (cells hidden by merges)
  const mergedHidden = new Set<string>();
  for (const mr of mergedRegions) {
    for (let r = mr.startRow; r <= mr.endRow; r++) {
      for (let c = mr.startCol; c <= mr.endCol; c++) {
        if (r !== mr.startRow || c !== mr.startCol) {
          mergedHidden.add(`${r},${c}`);
        }
      }
    }
  }

  // Scale factor
  const scalePct = pageSetup.scale || 100;

  // Process three-section header/footer
  const headerSections = parseHeaderFooterSections(pageSetup.header);
  const footerSections = parseHeaderFooterSections(pageSetup.footer);
  const headerLeft = replaceDynamicFields(headerSections.left, sheetName);
  const headerCenter = replaceDynamicFields(headerSections.center, sheetName);
  const headerRight = replaceDynamicFields(headerSections.right, sheetName);
  const footerLeft = replaceDynamicFields(footerSections.left, sheetName);
  const footerCenter = replaceDynamicFields(footerSections.center, sheetName);
  const footerRight = replaceDynamicFields(footerSections.right, sheetName);

  const hasHeader = headerLeft || headerCenter || headerRight;
  const hasFooter = footerLeft || footerCenter || footerRight;

  // Build col widths as CSS (only for print area columns)
  const colWidthsCss: Record<number, string> = {};
  for (let c = startCol; c <= endCol; c++) {
    colWidthsCss[c] = `${((colWidths[c] ?? 100) * scalePct) / 100}px`;
  }
  // Also include title columns
  if (titleCols) {
    for (let c = titleCols[0]; c <= titleCols[1]; c++) {
      colWidthsCss[c] = `${((colWidths[c] ?? 100) * scalePct) / 100}px`;
    }
  }

  // Generate table rows
  const tableRows: string[] = [];

  // Build the list of columns to include
  const colsList: number[] = [];
  if (titleCols) {
    for (let c = titleCols[0]; c <= titleCols[1]; c++) {
      if (c < startCol || c > endCol) colsList.push(c);
    }
  }
  for (let c = startCol; c <= endCol; c++) {
    if (!colsList.includes(c)) colsList.push(c);
  }

  // Column headings row (if enabled)
  if (pageSetup.printHeadings) {
    const headingCells = ['<th style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666"></th>'];
    for (const c of colsList) {
      headingCells.push(
        `<th style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666;width:${colWidthsCss[c]};min-width:${colWidthsCss[c]}">${indexToCol(c)}</th>`,
      );
    }
    tableRows.push(`<tr>${headingCells.join("")}</tr>`);
  }

  for (let r = startRow; r <= endRow; r++) {
    const rowCells: string[] = [];

    // Row heading
    if (pageSetup.printHeadings) {
      rowCells.push(
        `<td style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666;text-align:center">${r + 1}</td>`,
      );
    }

    for (const c of colsList) {
      const key = `${r},${c}`;

      // Skip merged hidden cells
      if (mergedHidden.has(key)) continue;

      const cell = cellMap.get(key);
      const styleIndex = cell?.styleIndex ?? 0;
      const style = styles[styleIndex];
      const cellCss = style ? buildCellStyle(style, pageSetup) : "";
      const display = cell?.display ?? "";
      const rowSpan = cell?.rowSpan ?? 1;
      const colSpan = cell?.colSpan ?? 1;

      // Row height
      const rh = ((rowHeights[r] ?? 24) * scalePct) / 100;
      const heightCss = `height:${rh}px`;

      // Column width
      const widthCss = `width:${colWidthsCss[c]};min-width:${colWidthsCss[c]}`;

      const fullCss = [cellCss, heightCss, widthCss, "padding:2px 4px", "overflow:hidden"].filter(Boolean).join(";");

      const spanAttrs = (rowSpan > 1 ? ` rowspan="${rowSpan}"` : "") + (colSpan > 1 ? ` colspan="${colSpan}"` : "");

      rowCells.push(`<td style="${fullCss}"${spanAttrs}>${escapeHtml(display)}</td>`);
    }

    tableRows.push(`<tr>${rowCells.join("")}</tr>`);
  }

  const centerH = pageSetup.centerHorizontally ? "margin-left:auto;margin-right:auto;" : "";

  // Build three-section header HTML
  const headerHtml = hasHeader ? `
  <div class="header-bar">
    <span class="header-left">${escapeHtml(headerLeft)}</span>
    <span class="header-center">${escapeHtml(headerCenter)}</span>
    <span class="header-right">${escapeHtml(headerRight)}</span>
  </div>` : "";

  // Build three-section footer HTML
  const footerHtml = hasFooter ? `
  <div class="footer-bar">
    <span class="footer-left">${escapeHtml(footerLeft)}</span>
    <span class="footer-center">${escapeHtml(footerCenter)}</span>
    <span class="footer-right">${escapeHtml(footerRight)}</span>
  </div>` : "";

  // Print title info for display
  const titleInfo: string[] = [];
  if (titleRows) titleInfo.push(`Rows ${titleRows[0] + 1}-${titleRows[1] + 1} repeat at top`);
  if (titleCols) titleInfo.push(`Cols ${indexToCol(titleCols[0])}-${indexToCol(titleCols[1])} repeat at left`);
  if (printArea) titleInfo.push(`Print area: ${pageSetup.printArea}`);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Print - ${escapeHtml(sheetName)}</title>
<style>
  @page {
    size: ${pageW}mm ${pageH}mm;
    margin: ${mTop}mm ${mRight}mm ${mBottom}mm ${mLeft}mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Calibri", "Segoe UI", sans-serif;
    font-size: 11pt;
    color: #000;
    background: #fff;
  }
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .header-bar, .footer-bar {
      position: fixed;
    }
    .header-bar {
      top: 0;
      left: 0;
      right: 0;
    }
    .footer-bar {
      bottom: 0;
      left: 0;
      right: 0;
    }
  }
  @media screen {
    body { padding: 20px; background: #e0e0e0; }
    .page-container {
      background: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      width: ${pageW - inchesToMm(pageSetup.marginLeft) - inchesToMm(pageSetup.marginRight)}mm;
      min-height: ${pageH - mTop - mBottom}mm;
      margin: 0 auto 20px;
      padding: ${mTop}mm ${mRight}mm ${mBottom}mm ${mLeft}mm;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #333;
      color: #fff;
      padding: 10px 20px;
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 20px;
      border-radius: 4px;
    }
    .toolbar button {
      background: #0078d4;
      color: #fff;
      border: none;
      padding: 8px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    .toolbar button:hover { background: #106ebe; }
    .toolbar .close-btn {
      background: #555;
      margin-left: auto;
    }
    .toolbar .close-btn:hover { background: #777; }
    .toolbar .info {
      font-size: 11px;
      color: #aaa;
      margin-left: 8px;
    }
  }
  table {
    border-collapse: collapse;
    ${centerH}
    table-layout: fixed;
  }
  td, th {
    vertical-align: middle;
    white-space: nowrap;
  }
  .header-bar, .footer-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 9pt;
    color: #666;
    padding: 4px 0;
  }
  .header-left, .footer-left { text-align: left; flex: 1; }
  .header-center, .footer-center { text-align: center; flex: 1; }
  .header-right, .footer-right { text-align: right; flex: 1; }
</style>
</head>
<body>
<div class="toolbar no-print">
  <button onclick="window.print()">Print</button>
  <span>${escapeHtml(sheetName)}</span>
  ${titleInfo.length > 0 ? `<span class="info">${escapeHtml(titleInfo.join(" | "))}</span>` : ""}
  <button class="close-btn" onclick="window.close()">Close</button>
</div>
${headerHtml}
<div class="page-container">
  <table>
    ${tableRows.join("\n    ")}
  </table>
</div>
${footerHtml}
</body>
</html>`;
}

// ============================================================================
// Print Execution
// ============================================================================

/**
 * Open a print preview window with the generated HTML.
 * Uses window.open to create a new window, writes the HTML, and triggers print.
 */
export function executePrint(data: PrintData): void {
  const html = generatePrintHtml(data);

  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    alert("Could not open print window. Please allow pop-ups for this application.");
    return;
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Auto-trigger print after a short delay to let styles render
  setTimeout(() => {
    printWindow.print();
  }, 500);
}
