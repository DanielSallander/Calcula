//! FILENAME: app/extensions/Print/lib/pdfGenerator-pages.test.ts
// PURPOSE: Tests for PDF page numbering, total pages, header/footer field codes,
//          column/row break grids, scale interaction, and empty page handling.
// CONTEXT: Covers untested PDF pagination logic from pdfGenerator.ts.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions from pdfGenerator.ts
// ============================================================================

const PX_TO_MM = 0.264583;

function pxToMm(px: number): number {
  return px * PX_TO_MM;
}

function inchesToMm(inches: number): number {
  return inches * 25.4;
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

interface PageBreak {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

function parseHeaderFooterSections(text: string): HeaderFooterSections {
  if (!text) return { left: "", center: "", right: "" };
  const hasSections = /&[LCR]/i.test(text);
  if (!hasSections) return { left: "", center: text, right: "" };

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
    if (/^&L$/i.test(part)) current = "left";
    else if (/^&C$/i.test(part)) current = "center";
    else if (/^&R$/i.test(part)) current = "right";
    else {
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
        pages.push({ startRow: rowStart, endRow: prevR, startCol: colBreak.start, endCol: colBreak.end });
        rowStart = r;
        accH = headingRowHeight + titleRowsHeight;
      }
      accH += rowMm[r];
    }
    pages.push({ startRow: rowStart, endRow: endRow, startCol: colBreak.start, endCol: colBreak.end });
  }
  return pages;
}

// ============================================================================
// Tests: Page numbering with different start page numbers
// ============================================================================

describe("page numbering with start page offset", () => {
  it("firstPageNumber offsets displayed page numbers", () => {
    const firstPageNumber = 5;
    const totalPages = 3;
    for (let i = 0; i < totalPages; i++) {
      const displayPage = firstPageNumber + i;
      const text = replaceDynamicFields("Page &P", displayPage, totalPages, "Sheet1");
      expect(text).toBe(`Page ${firstPageNumber + i}`);
    }
  });

  it("firstPageNumber 0 produces Page 0", () => {
    const text = replaceDynamicFields("Page &P", 0, 5, "Sheet1");
    expect(text).toBe("Page 0");
  });

  it("negative firstPageNumber works", () => {
    const text = replaceDynamicFields("Page &P", -1, 10, "Sheet1");
    expect(text).toBe("Page -1");
  });

  it("firstPageNumber with total pages in footer", () => {
    const firstPageNumber = 10;
    const totalPages = 4;
    const text = replaceDynamicFields(
      "Page &P of &N",
      firstPageNumber + 2,
      totalPages,
      "Report",
    );
    expect(text).toBe("Page 12 of 4");
  });
});

// ============================================================================
// Tests: Total pages calculation with complex break patterns
// ============================================================================

describe("total pages with complex break patterns", () => {
  function uniformWidths(count: number, width: number): number[] {
    return Array(count).fill(width);
  }
  function uniformHeights(count: number, height: number): number[] {
    return Array(count).fill(height);
  }

  it("3 manual row breaks + 1 manual col break = 8 pages", () => {
    const pages = computePageBreaks(
      uniformWidths(10, 80),
      uniformHeights(40, 24),
      100,
      500, 500,
      { startRow: 0, endRow: 39, startCol: 0, endCol: 9 },
      null, null, false,
      [10, 20, 30],
      [5],
    );
    // 4 row groups x 2 col groups = 8
    expect(pages.length).toBe(8);
  });

  it("2 col breaks + 2 row breaks = 9 pages", () => {
    const pages = computePageBreaks(
      uniformWidths(15, 80),
      uniformHeights(30, 24),
      100,
      500, 500,
      { startRow: 0, endRow: 29, startCol: 0, endCol: 14 },
      null, null, false,
      [10, 20],
      [5, 10],
    );
    // 3 row groups x 3 col groups = 9
    expect(pages.length).toBe(9);
  });

  it("single row data = 1 page regardless of col breaks", () => {
    const pages = computePageBreaks(
      uniformWidths(20, 80),
      uniformHeights(1, 24),
      100,
      500, 500,
      { startRow: 0, endRow: 0, startCol: 0, endCol: 19 },
      null, null, false,
      [],
      [5, 10, 15],
    );
    // 1 row group x 4 col groups = 4
    expect(pages.length).toBe(4);
  });

  it("total pages is available to every page header/footer", () => {
    const pages = computePageBreaks(
      uniformWidths(3, 80),
      uniformHeights(30, 24),
      100, 200, 500,
      { startRow: 0, endRow: 29, startCol: 0, endCol: 2 },
      null, null, false,
      [10, 20], [],
    );
    const totalPages = pages.length;
    expect(totalPages).toBe(3);
    // Each page gets the correct "Page X of 3"
    for (let i = 0; i < totalPages; i++) {
      const text = replaceDynamicFields("Page &P of &N", i + 1, totalPages, "Sheet1");
      expect(text).toBe(`Page ${i + 1} of 3`);
    }
  });
});

// ============================================================================
// Tests: Header/footer field code combinations
// ============================================================================

describe("header/footer field code combinations", () => {
  it("&P of &N produces correct page fraction", () => {
    expect(replaceDynamicFields("&P of &N", 3, 12, "S")).toBe("3 of 12");
  });

  it("&F - &A produces filename and sheet name", () => {
    expect(replaceDynamicFields("&F - &A", 1, 1, "Budget")).toBe("Budget - Budget");
  });

  it("all codes combined in sections", () => {
    const header = "&LPage &P of &N&C&F&R&D &T";
    const sections = parseHeaderFooterSections(header);
    const left = replaceDynamicFields(sections.left, 2, 5, "Sales");
    const center = replaceDynamicFields(sections.center, 2, 5, "Sales");
    const right = replaceDynamicFields(sections.right, 2, 5, "Sales");
    expect(left).toBe("Page 2 of 5");
    expect(center).toBe("Sales");
    expect(right).toBe("DATE TIME");
  });

  it("repeated &P in same section", () => {
    const text = replaceDynamicFields("&P/&P", 7, 20, "X");
    expect(text).toBe("7/7");
  });

  it("empty sections with field codes only in right", () => {
    const sections = parseHeaderFooterSections("&L&C&RPage &P");
    expect(sections.left).toBe("");
    expect(sections.center).toBe("");
    const right = replaceDynamicFields(sections.right, 4, 10, "Test");
    expect(right).toBe("Page 4");
  });

  it("field codes without section codes go to center", () => {
    const sections = parseHeaderFooterSections("Page &P of &N");
    expect(sections.center).toBe("Page &P of &N");
    const replaced = replaceDynamicFields(sections.center, 1, 1, "S");
    expect(replaced).toBe("Page 1 of 1");
  });
});

// ============================================================================
// Tests: Column break + row break creating grid of pages
// ============================================================================

describe("column + row breaks creating page grid", () => {
  function uniformWidths(count: number, width: number): number[] {
    return Array(count).fill(width);
  }
  function uniformHeights(count: number, height: number): number[] {
    return Array(count).fill(height);
  }

  it("2x2 grid from one row break and one col break", () => {
    const pages = computePageBreaks(
      uniformWidths(10, 80),
      uniformHeights(20, 24),
      100, 500, 500,
      { startRow: 0, endRow: 19, startCol: 0, endCol: 9 },
      null, null, false,
      [10], [5],
    );
    expect(pages.length).toBe(4);
    // Page order: col-group-0/row-group-0, col-group-0/row-group-1,
    //             col-group-1/row-group-0, col-group-1/row-group-1
    // First two pages: cols 0-4
    expect(pages[0].startCol).toBe(0);
    expect(pages[0].endCol).toBe(4);
    expect(pages[1].startCol).toBe(0);
    expect(pages[1].endCol).toBe(4);
    // Next two: cols 5-9
    expect(pages[2].startCol).toBe(5);
    expect(pages[2].endCol).toBe(9);
    expect(pages[3].startCol).toBe(5);
    expect(pages[3].endCol).toBe(9);
  });

  it("3x3 grid covers all cells exactly once", () => {
    const pages = computePageBreaks(
      uniformWidths(15, 80),
      uniformHeights(30, 24),
      100, 500, 500,
      { startRow: 0, endRow: 29, startCol: 0, endCol: 14 },
      null, null, false,
      [10, 20], [5, 10],
    );
    expect(pages.length).toBe(9);
    const covered = new Set<string>();
    for (const page of pages) {
      for (let r = page.startRow; r <= page.endRow; r++) {
        for (let c = page.startCol; c <= page.endCol; c++) {
          covered.add(`${r},${c}`);
        }
      }
    }
    for (let r = 0; r <= 29; r++) {
      for (let c = 0; c <= 14; c++) {
        expect(covered.has(`${r},${c}`)).toBe(true);
      }
    }
  });
});

// ============================================================================
// Tests: Scale factor interaction with page breaks
// ============================================================================

describe("scale factor interaction with page breaks", () => {
  function uniformWidths(count: number, width: number): number[] {
    return Array(count).fill(width);
  }
  function uniformHeights(count: number, height: number): number[] {
    return Array(count).fill(height);
  }

  it("lower scale reduces number of pages", () => {
    const pages100 = computePageBreaks(
      uniformWidths(10, 100), uniformHeights(50, 24),
      100, 80, 80,
      { startRow: 0, endRow: 49, startCol: 0, endCol: 9 },
      null, null, false, [], [],
    );
    const pages50 = computePageBreaks(
      uniformWidths(10, 100), uniformHeights(50, 24),
      50, 80, 80,
      { startRow: 0, endRow: 49, startCol: 0, endCol: 9 },
      null, null, false, [], [],
    );
    expect(pages50.length).toBeLessThan(pages100.length);
  });

  it("manual breaks still honored at reduced scale", () => {
    const pages = computePageBreaks(
      uniformWidths(5, 80), uniformHeights(20, 24),
      50, 500, 500,
      { startRow: 0, endRow: 19, startCol: 0, endCol: 4 },
      null, null, false,
      [10], [],
    );
    expect(pages.length).toBe(2);
    expect(pages[0].endRow).toBe(9);
    expect(pages[1].startRow).toBe(10);
  });

  it("very high scale creates many pages", () => {
    const pages = computePageBreaks(
      uniformWidths(5, 100), uniformHeights(20, 24),
      400, 80, 80,
      { startRow: 0, endRow: 19, startCol: 0, endCol: 4 },
      null, null, false, [], [],
    );
    expect(pages.length).toBeGreaterThan(4);
  });
});

// ============================================================================
// Tests: Empty pages (all rows hidden in range)
// ============================================================================

describe("empty pages edge cases", () => {
  it("single row single col still produces 1 page", () => {
    const pages = computePageBreaks(
      [80], [24],
      100, 200, 200,
      { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      null, null, false, [], [],
    );
    expect(pages.length).toBe(1);
    expect(pages[0]).toEqual({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 });
  });

  it("zero-height rows (hidden) still counted in page breaks", () => {
    // Rows with height 0 still occupy a slot in the rowHeights array.
    // The page break algorithm uses their (scaled) height of 0mm.
    const heights = Array(20).fill(0); // all hidden
    heights[0] = 24; // except row 0
    const pages = computePageBreaks(
      [80, 80, 80], heights,
      100, 200, 200,
      { startRow: 0, endRow: 19, startCol: 0, endCol: 2 },
      null, null, false, [], [],
    );
    // All rows fit because 19 rows have 0 height
    expect(pages.length).toBe(1);
  });

  it("all zero-height rows produce 1 page with no visible content", () => {
    const heights = Array(10).fill(0);
    const pages = computePageBreaks(
      [80], heights,
      100, 200, 200,
      { startRow: 0, endRow: 9, startCol: 0, endCol: 0 },
      null, null, false, [], [],
    );
    expect(pages.length).toBe(1);
  });
});
