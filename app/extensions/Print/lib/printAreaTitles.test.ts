//! FILENAME: app/extensions/Print/lib/printAreaTitles.test.ts
// PURPOSE: Tests for print area parsing, title parsing, and break computation logic.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline utilities (same logic as printGenerator.ts / pageBreakOverlay.ts)
// We test the pure functions directly to avoid Tauri import mocking.
// ============================================================================

function colToIndex(col: string): number {
  let result = 0;
  for (let i = 0; i < col.length; i++) {
    result = result * 26 + (col.charCodeAt(i) - 64);
  }
  return result - 1;
}

function indexToCol(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
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

interface PageSetupLike {
  paperSize: string;
  orientation: string;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  scale: number;
  manualRowBreaks: number[];
  manualColBreaks: number[];
}

const PAPER_SIZES_PX: Record<string, { width: number; height: number }> = {
  a4: { width: 794, height: 1123 },
  letter: { width: 816, height: 1056 },
};

function inchesToPx(inches: number): number {
  return inches * 96;
}

function computeBreakPositions(
  pageSetup: PageSetupLike,
  maxRow: number,
  maxCol: number,
  getColWidth: (col: number) => number,
  getRowHeight: (row: number) => number,
): { rowBreaks: number[]; colBreaks: number[] } {
  const paper = PAPER_SIZES_PX[pageSetup.paperSize] || PAPER_SIZES_PX.a4;
  const isLandscape = pageSetup.orientation === "landscape";
  const pageW = isLandscape ? paper.height : paper.width;
  const pageH = isLandscape ? paper.width : paper.height;

  const mLeft = inchesToPx(pageSetup.marginLeft);
  const mRight = inchesToPx(pageSetup.marginRight);
  const mTop = inchesToPx(pageSetup.marginTop);
  const mBottom = inchesToPx(pageSetup.marginBottom);

  const scalePct = pageSetup.scale || 100;
  const contentWidth = pageW - mLeft - mRight;
  const contentHeight = pageH - mTop - mBottom;

  const manualRowSet = new Set(pageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(pageSetup.manualColBreaks ?? []);

  const colBreaks: number[] = [];
  let accW = 0;
  for (let c = 0; c <= maxCol; c++) {
    const w = (getColWidth(c) * scalePct) / 100;
    if (accW + w > contentWidth && c > 0) {
      colBreaks.push(c);
      accW = 0;
    }
    if (manualColSet.has(c) && c > 0 && !colBreaks.includes(c)) {
      colBreaks.push(c);
      accW = 0;
    }
    accW += w;
  }

  const rowBreaks: number[] = [];
  let accH = 0;
  for (let r = 0; r <= maxRow; r++) {
    const h = (getRowHeight(r) * scalePct) / 100;
    if (accH + h > contentHeight && r > 0) {
      rowBreaks.push(r);
      accH = 0;
    }
    if (manualRowSet.has(r) && r > 0 && !rowBreaks.includes(r)) {
      rowBreaks.push(r);
      accH = 0;
    }
    accH += h;
  }

  return { rowBreaks, colBreaks };
}

// ============================================================================
// Tests: Column Indexing
// ============================================================================

describe("colToIndex", () => {
  it("converts single letters", () => {
    expect(colToIndex("A")).toBe(0);
    expect(colToIndex("B")).toBe(1);
    expect(colToIndex("Z")).toBe(25);
  });

  it("converts double letters", () => {
    expect(colToIndex("AA")).toBe(26);
    expect(colToIndex("AB")).toBe(27);
    expect(colToIndex("AZ")).toBe(51);
    expect(colToIndex("BA")).toBe(52);
    expect(colToIndex("ZZ")).toBe(701);
  });

  it("converts triple letters", () => {
    expect(colToIndex("AAA")).toBe(702);
  });
});

describe("indexToCol", () => {
  it("converts single-letter indices", () => {
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(1)).toBe("B");
    expect(indexToCol(25)).toBe("Z");
  });

  it("converts double-letter indices", () => {
    expect(indexToCol(26)).toBe("AA");
    expect(indexToCol(27)).toBe("AB");
    expect(indexToCol(51)).toBe("AZ");
    expect(indexToCol(52)).toBe("BA");
    expect(indexToCol(701)).toBe("ZZ");
  });

  it("round-trips with colToIndex", () => {
    for (let i = 0; i < 100; i++) {
      expect(colToIndex(indexToCol(i))).toBe(i);
    }
  });
});

// ============================================================================
// Tests: Print Area Parsing
// ============================================================================

describe("parsePrintArea", () => {
  it("returns null for empty string", () => {
    expect(parsePrintArea("")).toBeNull();
    expect(parsePrintArea("  ")).toBeNull();
  });

  it("parses a simple range", () => {
    const result = parsePrintArea("A1:F20");
    expect(result).toEqual({
      startCol: 0,
      startRow: 0,
      endCol: 5,
      endRow: 19,
    });
  });

  it("parses a range with double-letter columns", () => {
    const result = parsePrintArea("AA1:AZ50");
    expect(result).toEqual({
      startCol: 26,
      startRow: 0,
      endCol: 51,
      endRow: 49,
    });
  });

  it("is case-insensitive", () => {
    const result = parsePrintArea("a1:f20");
    expect(result).toEqual({
      startCol: 0,
      startRow: 0,
      endCol: 5,
      endRow: 19,
    });
  });

  it("returns null for invalid format", () => {
    expect(parsePrintArea("invalid")).toBeNull();
    expect(parsePrintArea("A1")).toBeNull();
    expect(parsePrintArea("A1:")).toBeNull();
  });
});

// ============================================================================
// Tests: Title Row/Column Parsing
// ============================================================================

describe("parseTitleRows", () => {
  it("returns null for empty string", () => {
    expect(parseTitleRows("")).toBeNull();
    expect(parseTitleRows("  ")).toBeNull();
  });

  it("parses a row range", () => {
    expect(parseTitleRows("1:2")).toEqual([0, 1]);
    expect(parseTitleRows("1:5")).toEqual([0, 4]);
    expect(parseTitleRows("3:10")).toEqual([2, 9]);
  });

  it("returns null for invalid format", () => {
    expect(parseTitleRows("A:B")).toBeNull();
    expect(parseTitleRows("1")).toBeNull();
  });
});

describe("parseTitleCols", () => {
  it("returns null for empty string", () => {
    expect(parseTitleCols("")).toBeNull();
    expect(parseTitleCols("  ")).toBeNull();
  });

  it("parses a column range", () => {
    expect(parseTitleCols("A:B")).toEqual([0, 1]);
    expect(parseTitleCols("A:C")).toEqual([0, 2]);
    expect(parseTitleCols("B:F")).toEqual([1, 5]);
  });

  it("handles double-letter columns", () => {
    expect(parseTitleCols("AA:AZ")).toEqual([26, 51]);
  });

  it("returns null for invalid format", () => {
    expect(parseTitleCols("1:2")).toBeNull();
    expect(parseTitleCols("A")).toBeNull();
  });
});

// ============================================================================
// Tests: Break Computation
// ============================================================================

describe("computeBreakPositions", () => {
  const defaultSetup: PageSetupLike = {
    paperSize: "a4",
    orientation: "portrait",
    marginLeft: 0.75,
    marginRight: 0.75,
    marginTop: 1.0,
    marginBottom: 1.0,
    scale: 100,
    manualRowBreaks: [],
    manualColBreaks: [],
  };

  it("computes column breaks when columns exceed page width", () => {
    // A4 portrait: 794px wide - margins (0.75*96 = 72 each side) = 650px content
    const colWidth = 100; // 100px per column -> ~6.5 cols per page
    const { colBreaks } = computeBreakPositions(
      defaultSetup,
      10,
      20,
      () => colWidth,
      () => 24,
    );

    // First break should be around column 6 or 7
    expect(colBreaks.length).toBeGreaterThan(0);
    expect(colBreaks[0]).toBeGreaterThanOrEqual(6);
    expect(colBreaks[0]).toBeLessThanOrEqual(7);
  });

  it("computes row breaks when rows exceed page height", () => {
    // A4 portrait: 1123px tall - margins (1.0*96 = 96 each) = 931px content
    const rowHeight = 24; // 24px per row -> ~38 rows per page
    const { rowBreaks } = computeBreakPositions(
      defaultSetup,
      100,
      5,
      () => 100,
      () => rowHeight,
    );

    expect(rowBreaks.length).toBeGreaterThan(0);
    expect(rowBreaks[0]).toBeGreaterThanOrEqual(37);
    expect(rowBreaks[0]).toBeLessThanOrEqual(39);
  });

  it("includes manual breaks", () => {
    const setup = { ...defaultSetup, manualRowBreaks: [10], manualColBreaks: [3] };
    const { rowBreaks, colBreaks } = computeBreakPositions(
      setup,
      50,
      20,
      () => 100,
      () => 24,
    );

    expect(rowBreaks).toContain(10);
    expect(colBreaks).toContain(3);
  });

  it("respects scale factor", () => {
    // At 200% scale, effective column width doubles -> fewer cols per page
    const setup200 = { ...defaultSetup, scale: 200 };
    const { colBreaks: breaks200 } = computeBreakPositions(
      setup200,
      10,
      20,
      () => 100,
      () => 24,
    );

    const { colBreaks: breaks100 } = computeBreakPositions(
      defaultSetup,
      10,
      20,
      () => 100,
      () => 24,
    );

    // At 200% scale, breaks should occur earlier (more breaks)
    expect(breaks200.length).toBeGreaterThan(breaks100.length);
  });

  it("handles landscape orientation", () => {
    const landscape = { ...defaultSetup, orientation: "landscape" };
    const { colBreaks: landscapeBreaks } = computeBreakPositions(
      landscape,
      10,
      30,
      () => 100,
      () => 24,
    );

    const { colBreaks: portraitBreaks } = computeBreakPositions(
      defaultSetup,
      10,
      30,
      () => 100,
      () => 24,
    );

    // Landscape has more horizontal space -> fewer column breaks
    expect(landscapeBreaks.length).toBeLessThan(portraitBreaks.length);
  });

  it("returns no breaks when content fits on one page", () => {
    const { rowBreaks, colBreaks } = computeBreakPositions(
      defaultSetup,
      5,
      3,
      () => 100,
      () => 24,
    );

    expect(rowBreaks.length).toBe(0);
    expect(colBreaks.length).toBe(0);
  });
});

// ============================================================================
// Tests: Selection Bounds Normalization
// ============================================================================

describe("selection bounds normalization", () => {
  function getSelectionBounds(selection: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  }) {
    const sr = Math.min(selection.startRow, selection.endRow);
    const er = Math.max(selection.startRow, selection.endRow);
    const sc = Math.min(selection.startCol, selection.endCol);
    const ec = Math.max(selection.startCol, selection.endCol);
    return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
  }

  it("normalizes forward selection", () => {
    const bounds = getSelectionBounds({ startRow: 0, startCol: 0, endRow: 5, endCol: 3 });
    expect(bounds).toEqual({ startRow: 0, startCol: 0, endRow: 5, endCol: 3 });
  });

  it("normalizes backward selection", () => {
    const bounds = getSelectionBounds({ startRow: 5, startCol: 3, endRow: 0, endCol: 0 });
    expect(bounds).toEqual({ startRow: 0, startCol: 0, endRow: 5, endCol: 3 });
  });

  it("handles single cell", () => {
    const bounds = getSelectionBounds({ startRow: 2, startCol: 2, endRow: 2, endCol: 2 });
    expect(bounds).toEqual({ startRow: 2, startCol: 2, endRow: 2, endCol: 2 });
  });

  it("normalizes mixed direction selection", () => {
    const bounds = getSelectionBounds({ startRow: 10, startCol: 0, endRow: 2, endCol: 5 });
    expect(bounds).toEqual({ startRow: 2, startCol: 0, endRow: 10, endCol: 5 });
  });
});

// ============================================================================
// Tests: Print Area Range String Generation
// ============================================================================

describe("print area range string generation", () => {
  function selectionToRangeString(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): string {
    return `${indexToCol(startCol)}${startRow + 1}:${indexToCol(endCol)}${endRow + 1}`;
  }

  it("generates correct range for simple selection", () => {
    expect(selectionToRangeString(0, 0, 19, 5)).toBe("A1:F20");
  });

  it("generates correct range for single cell", () => {
    expect(selectionToRangeString(0, 0, 0, 0)).toBe("A1:A1");
  });

  it("generates correct range for double-letter columns", () => {
    expect(selectionToRangeString(0, 26, 49, 51)).toBe("AA1:AZ50");
  });

  it("round-trips through parse", () => {
    const rangeStr = selectionToRangeString(2, 1, 10, 7);
    const parsed = parsePrintArea(rangeStr);
    expect(parsed).toEqual({
      startRow: 2,
      startCol: 1,
      endRow: 10,
      endCol: 7,
    });
  });
});

// ============================================================================
// Tests: Title Rows/Cols String Generation
// ============================================================================

describe("title rows string generation", () => {
  function rowsToTitleString(startRow: number, endRow: number): string {
    return `${startRow + 1}:${endRow + 1}`;
  }

  it("generates correct title rows", () => {
    expect(rowsToTitleString(0, 1)).toBe("1:2");
    expect(rowsToTitleString(0, 4)).toBe("1:5");
    expect(rowsToTitleString(2, 9)).toBe("3:10");
  });

  it("round-trips through parse", () => {
    const str = rowsToTitleString(0, 4);
    expect(parseTitleRows(str)).toEqual([0, 4]);
  });
});

describe("title cols string generation", () => {
  function colsToTitleString(startCol: number, endCol: number): string {
    return `${indexToCol(startCol)}:${indexToCol(endCol)}`;
  }

  it("generates correct title cols", () => {
    expect(colsToTitleString(0, 1)).toBe("A:B");
    expect(colsToTitleString(0, 2)).toBe("A:C");
    expect(colsToTitleString(1, 5)).toBe("B:F");
  });

  it("round-trips through parse", () => {
    const str = colsToTitleString(0, 2);
    expect(parseTitleCols(str)).toEqual([0, 2]);
  });
});
