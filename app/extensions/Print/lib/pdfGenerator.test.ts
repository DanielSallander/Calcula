//! FILENAME: app/extensions/Print/lib/pdfGenerator.test.ts
// PURPOSE: Tests for PDF generator pure helper functions.
// CONTEXT: Tests color parsing, page break computation, unit conversions,
//          header/footer parsing with page numbers, and print bounds logic.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions from pdfGenerator.ts
// ============================================================================

const PX_TO_MM = 0.264583;
const PT_TO_MM = 0.352778;

function inchesToMm(inches: number): number {
  return inches * 25.4;
}

function pxToMm(px: number): number {
  return px * PX_TO_MM;
}

function ptToMm(pt: number): number {
  return pt * PT_TO_MM;
}

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
  return [0, 0, 0];
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

function colToIndex(col: string): number {
  let result = 0;
  for (let i = 0; i < col.length; i++) {
    result = result * 26 + (col.charCodeAt(i) - 64);
  }
  return result - 1;
}

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
    .replace(/&D/g, "DATE")
    .replace(/&T/g, "TIME")
    .replace(/&F/g, sheetName)
    .replace(/&A/g, sheetName);
}

// Page break computation (from pdfGenerator.ts)
interface PageBreak {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

function computePageBreaks(
  colWidths: number[],
  rowHeights: number[],
  scalePct: number,
  contentWidth: number,
  contentHeight: number,
  printBounds: PrintBounds,
  titleRows: [number, number] | null,
  titleCols: [number, number] | null,
  printHeadings: boolean,
  manualRowBreaks: number[],
  manualColBreaks: number[],
): PageBreak[] {
  const { startRow, endRow, startCol, endCol } = printBounds;

  const colMm: number[] = [];
  for (let c = 0; c <= endCol; c++) {
    colMm.push(pxToMm((colWidths[c] ?? 100) * scalePct / 100));
  }

  const rowMm: number[] = [];
  for (let r = 0; r <= endRow; r++) {
    rowMm.push(pxToMm((rowHeights[r] ?? 24) * scalePct / 100));
  }

  const headingColWidth = printHeadings ? 10 : 0;
  const headingRowHeight = printHeadings ? 5 : 0;

  let titleColsWidth = 0;
  if (titleCols) {
    for (let c = titleCols[0]; c <= titleCols[1]; c++) {
      titleColsWidth += colMm[c] ?? 0;
    }
  }

  let titleRowsHeight = 0;
  if (titleRows) {
    for (let r = titleRows[0]; r <= titleRows[1]; r++) {
      titleRowsHeight += rowMm[r] ?? 0;
    }
  }

  const manualRowSet = new Set(manualRowBreaks);
  const manualColSet = new Set(manualColBreaks);

  const colBreaks: Array<{ start: number; end: number }> = [];
  let colStart = startCol;
  if (titleCols) {
    if (colStart >= titleCols[0] && colStart <= titleCols[1]) {
      colStart = titleCols[1] + 1;
    }
  }
  let accW = headingColWidth + titleColsWidth;
  for (let c = colStart; c <= endCol; c++) {
    if (titleCols && c >= titleCols[0] && c <= titleCols[1]) continue;

    const isManualBreak = manualColSet.has(c) && c > colStart;
    if ((accW + colMm[c] > contentWidth || isManualBreak) && c > colStart) {
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

  const pages: PageBreak[] = [];
  for (const colBreak of colBreaks) {
    let rowStart = startRow;
    if (titleRows) {
      if (rowStart >= titleRows[0] && rowStart <= titleRows[1]) {
        rowStart = titleRows[1] + 1;
      }
    }
    let accH = headingRowHeight + titleRowsHeight;
    for (let r = rowStart; r <= endRow; r++) {
      if (titleRows && r >= titleRows[0] && r <= titleRows[1]) continue;

      const isManualBreak = manualRowSet.has(r) && r > rowStart;
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
// Tests: Unit Conversions
// ============================================================================

describe("pxToMm", () => {
  it("converts 0px to 0mm", () => {
    expect(pxToMm(0)).toBe(0);
  });

  it("converts 96px to ~25.4mm (1 inch)", () => {
    expect(pxToMm(96)).toBeCloseTo(25.4, 0);
  });

  it("converts 1px correctly", () => {
    expect(pxToMm(1)).toBeCloseTo(0.264583, 4);
  });
});

describe("ptToMm", () => {
  it("converts 0pt to 0mm", () => {
    expect(ptToMm(0)).toBe(0);
  });

  it("converts 72pt to ~25.4mm (1 inch)", () => {
    expect(ptToMm(72)).toBeCloseTo(25.4, 0);
  });

  it("converts 11pt (default font size)", () => {
    expect(ptToMm(11)).toBeCloseTo(3.88, 1);
  });
});

// ============================================================================
// Tests: Color Parsing
// ============================================================================

describe("parseColor", () => {
  it("parses 6-digit hex colors", () => {
    expect(parseColor("#ff0000")).toEqual([255, 0, 0]);
    expect(parseColor("#00ff00")).toEqual([0, 255, 0]);
    expect(parseColor("#0000ff")).toEqual([0, 0, 255]);
    expect(parseColor("#000000")).toEqual([0, 0, 0]);
    expect(parseColor("#ffffff")).toEqual([255, 255, 255]);
  });

  it("parses 3-digit hex colors", () => {
    expect(parseColor("#f00")).toEqual([255, 0, 0]);
    expect(parseColor("#0f0")).toEqual([0, 255, 0]);
    expect(parseColor("#00f")).toEqual([0, 0, 255]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
  });

  it("parses rgb() colors", () => {
    expect(parseColor("rgb(128, 64, 32)")).toEqual([128, 64, 32]);
    expect(parseColor("rgb(0, 0, 0)")).toEqual([0, 0, 0]);
    expect(parseColor("rgb(255, 255, 255)")).toEqual([255, 255, 255]);
  });

  it("parses rgba() colors", () => {
    expect(parseColor("rgba(100, 200, 50, 1)")).toEqual([100, 200, 50]);
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0]);
  });

  it("returns black for unrecognized format", () => {
    expect(parseColor("red")).toEqual([0, 0, 0]);
    expect(parseColor("invalid")).toEqual([0, 0, 0]);
  });

  it("parses uppercase hex", () => {
    expect(parseColor("#FF8800")).toEqual([255, 136, 0]);
  });
});

// ============================================================================
// Tests: Color Classification
// ============================================================================

describe("isWhiteOrTransparent", () => {
  it("returns true for empty string", () => {
    expect(isWhiteOrTransparent("")).toBe(true);
  });

  it("returns true for lowercase white hex", () => {
    expect(isWhiteOrTransparent("#ffffff")).toBe(true);
  });

  it("returns true for uppercase white hex", () => {
    expect(isWhiteOrTransparent("#FFFFFF")).toBe(true);
  });

  it("returns true for fully opaque white rgba", () => {
    expect(isWhiteOrTransparent("rgba(255, 255, 255, 1)")).toBe(true);
  });

  it("returns true for transparent rgba", () => {
    expect(isWhiteOrTransparent("rgba(128, 128, 128, 0)")).toBe(true);
  });

  it("returns false for colored values", () => {
    expect(isWhiteOrTransparent("#ff0000")).toBe(false);
    expect(isWhiteOrTransparent("#e0f0ff")).toBe(false);
    expect(isWhiteOrTransparent("rgba(200, 200, 200, 1)")).toBe(false);
  });

  it("returns true for null-like input", () => {
    expect(isWhiteOrTransparent(undefined as unknown as string)).toBe(true);
  });
});

describe("isBlack", () => {
  it("returns true for hex black", () => {
    expect(isBlack("#000000")).toBe(true);
  });

  it("returns true for rgba black", () => {
    expect(isBlack("rgba(0, 0, 0, 1)")).toBe(true);
  });

  it("returns true for empty/falsy values", () => {
    expect(isBlack("")).toBe(true);
    expect(isBlack(undefined as unknown as string)).toBe(true);
  });

  it("returns false for non-black colors", () => {
    expect(isBlack("#ff0000")).toBe(false);
    expect(isBlack("#ffffff")).toBe(false);
    expect(isBlack("rgba(128, 128, 128, 1)")).toBe(false);
  });
});

// ============================================================================
// Tests: PDF Dynamic Field Replacement (with page numbers)
// ============================================================================

describe("replaceDynamicFields (PDF version)", () => {
  it("replaces &P with actual page number", () => {
    expect(replaceDynamicFields("Page &P", 3, 10, "Sheet1")).toBe("Page 3");
  });

  it("replaces &N with total pages", () => {
    expect(replaceDynamicFields("of &N", 1, 5, "Sheet1")).toBe("of 5");
  });

  it("replaces &P and &N together", () => {
    expect(replaceDynamicFields("Page &P of &N", 2, 8, "Report")).toBe("Page 2 of 8");
  });

  it("replaces sheet name codes", () => {
    expect(replaceDynamicFields("&F - &A", 1, 1, "Summary")).toBe("Summary - Summary");
  });

  it("handles multiple occurrences of same code", () => {
    expect(replaceDynamicFields("&P-&P", 5, 10, "X")).toBe("5-5");
  });
});

// ============================================================================
// Tests: Page Break Computation
// ============================================================================

describe("computePageBreaks", () => {
  // Helper: create uniform column widths and row heights (in px)
  function uniformWidths(count: number, width: number): number[] {
    return Array(count).fill(width);
  }
  function uniformHeights(count: number, height: number): number[] {
    return Array(count).fill(height);
  }

  it("returns one page when all data fits", () => {
    // Small data set: 5 cols x 10 rows at 100px/col and 24px/row
    const pages = computePageBreaks(
      uniformWidths(5, 100),
      uniformHeights(10, 24),
      100,        // scale
      200,        // contentWidth in mm (generous)
      300,        // contentHeight in mm (generous)
      { startRow: 0, endRow: 9, startCol: 0, endCol: 4 },
      null, null, false, [], [],
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ startRow: 0, endRow: 9, startCol: 0, endCol: 4 });
  });

  it("splits rows across pages when they exceed content height", () => {
    // 100 rows at 24px each = 2400px -> pxToMm(2400) ~= 634mm
    // Content height = 100mm -> should split
    const pages = computePageBreaks(
      uniformWidths(3, 80),
      uniformHeights(100, 24),
      100,
      200,   // contentWidth (generous for 3 cols)
      100,   // contentHeight (small => many row pages)
      { startRow: 0, endRow: 99, startCol: 0, endCol: 2 },
      null, null, false, [], [],
    );
    expect(pages.length).toBeGreaterThan(1);
    // All pages cover the same columns
    for (const page of pages) {
      expect(page.startCol).toBe(0);
      expect(page.endCol).toBe(2);
    }
    // First page starts at row 0
    expect(pages[0].startRow).toBe(0);
    // Last page ends at row 99
    expect(pages[pages.length - 1].endRow).toBe(99);
    // Pages should be contiguous
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].startRow).toBe(pages[i - 1].endRow + 1);
    }
  });

  it("splits columns across pages when they exceed content width", () => {
    // 20 columns at 100px each = 2000px -> pxToMm(2000) ~= 529mm
    // Content width = 60mm -> should split into multiple column groups
    const pages = computePageBreaks(
      uniformWidths(20, 100),
      uniformHeights(5, 24),
      100,
      60,    // contentWidth (small)
      200,   // contentHeight (generous)
      { startRow: 0, endRow: 4, startCol: 0, endCol: 19 },
      null, null, false, [], [],
    );
    expect(pages.length).toBeGreaterThan(1);
    // All pages cover the same rows
    for (const page of pages) {
      expect(page.startRow).toBe(0);
      expect(page.endRow).toBe(4);
    }
    // Pages should cover all columns
    expect(pages[0].startCol).toBe(0);
    expect(pages[pages.length - 1].endCol).toBe(19);
  });

  it("respects manual row breaks", () => {
    const pages = computePageBreaks(
      uniformWidths(3, 80),
      uniformHeights(20, 24),
      100,
      200,
      500,   // generous height (no auto breaks needed)
      { startRow: 0, endRow: 19, startCol: 0, endCol: 2 },
      null, null, false,
      [10],  // manual row break at row 10
      [],
    );
    expect(pages.length).toBe(2);
    expect(pages[0].endRow).toBe(9);
    expect(pages[1].startRow).toBe(10);
    expect(pages[1].endRow).toBe(19);
  });

  it("respects manual column breaks", () => {
    const pages = computePageBreaks(
      uniformWidths(10, 80),
      uniformHeights(5, 24),
      100,
      500,   // generous width
      500,   // generous height
      { startRow: 0, endRow: 4, startCol: 0, endCol: 9 },
      null, null, false,
      [],
      [5],   // manual col break at column 5
    );
    expect(pages.length).toBe(2);
    expect(pages[0].endCol).toBe(4);
    expect(pages[1].startCol).toBe(5);
  });

  it("accounts for scale factor", () => {
    // At 200% scale, effective sizes double -> more page breaks
    const pages100 = computePageBreaks(
      uniformWidths(10, 100),
      uniformHeights(50, 24),
      100, 100, 100,
      { startRow: 0, endRow: 49, startCol: 0, endCol: 9 },
      null, null, false, [], [],
    );
    const pages200 = computePageBreaks(
      uniformWidths(10, 100),
      uniformHeights(50, 24),
      200, 100, 100,
      { startRow: 0, endRow: 49, startCol: 0, endCol: 9 },
      null, null, false, [], [],
    );
    expect(pages200.length).toBeGreaterThan(pages100.length);
  });

  it("accounts for print headings taking space", () => {
    // Print headings add 10mm col width + 5mm row height
    const pagesWithoutHeadings = computePageBreaks(
      uniformWidths(5, 100),
      uniformHeights(30, 24),
      100, 100, 100,
      { startRow: 0, endRow: 29, startCol: 0, endCol: 4 },
      null, null, false, [], [],
    );
    const pagesWithHeadings = computePageBreaks(
      uniformWidths(5, 100),
      uniformHeights(30, 24),
      100, 100, 100,
      { startRow: 0, endRow: 29, startCol: 0, endCol: 4 },
      null, null, true, [], [],
    );
    expect(pagesWithHeadings.length).toBeGreaterThanOrEqual(pagesWithoutHeadings.length);
  });

  it("skips title rows in content flow", () => {
    // Title rows 0-1, data rows 2-19
    const pages = computePageBreaks(
      uniformWidths(3, 80),
      uniformHeights(20, 24),
      100,
      200,
      500,
      { startRow: 0, endRow: 19, startCol: 0, endCol: 2 },
      [0, 1],  // title rows
      null, false, [], [],
    );
    // Content rows start after title rows
    expect(pages[0].startRow).toBe(2);
  });

  it("skips title cols in content flow", () => {
    // Title cols 0-1, data cols 2-9
    const pages = computePageBreaks(
      uniformWidths(10, 80),
      uniformHeights(5, 24),
      100,
      500,
      500,
      { startRow: 0, endRow: 4, startCol: 0, endCol: 9 },
      null,
      [0, 1],  // title cols
      false, [], [],
    );
    // Content cols start after title cols
    expect(pages[0].startCol).toBe(2);
  });
});
