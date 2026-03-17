//! FILENAME: app/extensions/Print/lib/printGenerator.ts
// PURPOSE: Generates print-ready HTML from grid data and triggers browser print.
// CONTEXT: Called when user prints via Ctrl+P or File > Print.

import type { PrintData, PageSetup } from "../../../src/api/lib";
import { indexToCol } from "../../../src/api/lib";

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

function buildCellStyle(
  styleData: PrintData["styles"][number],
  pageSetup: PageSetup,
): string {
  const parts: string[] = [];

  if (styleData.bold) parts.push("font-weight:bold");
  if (styleData.italic) parts.push("font-style:italic");
  if (styleData.underline) parts.push("text-decoration:underline");
  if (styleData.strikethrough) {
    parts.push(
      styleData.underline
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

  // Header/footer processing
  const processHeaderFooter = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/&P/g, "1") // Page number placeholder
      .replace(/&N/g, "1") // Total pages placeholder
      .replace(/&D/g, new Date().toLocaleDateString())
      .replace(/&T/g, new Date().toLocaleTimeString())
      .replace(/&F/g, sheetName)
      .replace(/&A/g, sheetName);
  };

  const footerText = processHeaderFooter(pageSetup.footer);
  const headerText = processHeaderFooter(pageSetup.header);

  // Build col widths as CSS
  const colWidthsCss = colWidths.map((w) => `${(w * scalePct) / 100}px`);

  // Generate table rows
  const tableRows: string[] = [];

  // Column headings row (if enabled)
  if (pageSetup.printHeadings) {
    const headingCells = ['<th style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666"></th>'];
    for (let c = 0; c <= maxCol; c++) {
      headingCells.push(
        `<th style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666;width:${colWidthsCss[c]};min-width:${colWidthsCss[c]}">${indexToCol(c)}</th>`,
      );
    }
    tableRows.push(`<tr>${headingCells.join("")}</tr>`);
  }

  for (let r = 0; r <= maxRow; r++) {
    const rowCells: string[] = [];

    // Row heading
    if (pageSetup.printHeadings) {
      rowCells.push(
        `<td style="background:#f0f0f0;border:1px solid #ccc;padding:2px 4px;font-weight:bold;font-size:10px;color:#666;text-align:center">${r + 1}</td>`,
      );
    }

    for (let c = 0; c <= maxCol; c++) {
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
      const rh = (rowHeights[r] * scalePct) / 100;
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
  .header-text, .footer-text {
    font-size: 9pt;
    color: #666;
    text-align: center;
    padding: 4px 0;
  }
</style>
</head>
<body>
<div class="toolbar no-print">
  <button onclick="window.print()">Print</button>
  <span>${escapeHtml(sheetName)}</span>
  <button class="close-btn" onclick="window.close()">Close</button>
</div>
${headerText ? `<div class="header-text no-print">${escapeHtml(headerText)}</div>` : ""}
<div class="page-container">
  <table>
    ${tableRows.join("\n    ")}
  </table>
</div>
${footerText ? `<div class="footer-text">${escapeHtml(footerText)}</div>` : ""}
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
