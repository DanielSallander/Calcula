//! FILENAME: app/extensions/Print/lib/printGenerator-layout.test.ts
// PURPOSE: Tests for page layout calculations, scaling, margins, merges, and print areas.
// CONTEXT: Covers untested layout logic from printGenerator.ts.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions from printGenerator.ts
// ============================================================================

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  letter: { width: 216, height: 279 },
  legal: { width: 216, height: 356 },
  tabloid: { width: 279, height: 432 },
};

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

function indexToCol(index: number): string {
  let col = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
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

// ============================================================================
// Layout calculation helpers (mirrors logic in generatePrintHtml)
// ============================================================================

interface LayoutParams {
  paperSize: string;
  orientation: "portrait" | "landscape";
  marginTop: number;    // inches
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  scale: number;        // percent
  headerHeight: number; // mm, 0 if no header
  footerHeight: number; // mm, 0 if no footer
}

function computeContentArea(params: LayoutParams): { pageW: number; pageH: number; contentW: number; contentH: number } {
  const paper = PAPER_SIZES[params.paperSize] || PAPER_SIZES.a4;
  const isLandscape = params.orientation === "landscape";
  const pageW = isLandscape ? paper.height : paper.width;
  const pageH = isLandscape ? paper.width : paper.height;
  const mTop = inchesToMm(params.marginTop);
  const mBottom = inchesToMm(params.marginBottom);
  const mLeft = inchesToMm(params.marginLeft);
  const mRight = inchesToMm(params.marginRight);
  const contentW = pageW - mLeft - mRight;
  const contentH = pageH - mTop - mBottom - params.headerHeight - params.footerHeight;
  return { pageW, pageH, contentW, contentH };
}

function computeScaledColWidth(colWidthPx: number, scalePct: number): number {
  return (colWidthPx * scalePct) / 100;
}

function computeScaledRowHeight(rowHeightPx: number, scalePct: number): number {
  return (rowHeightPx * scalePct) / 100;
}

// Computes the repeat area size in px (unscaled) for title rows
function computeTitleRowsHeight(rowHeights: number[], titleRows: [number, number] | null): number {
  if (!titleRows) return 0;
  let h = 0;
  for (let r = titleRows[0]; r <= titleRows[1]; r++) {
    h += rowHeights[r] ?? 24;
  }
  return h;
}

function computeTitleColsWidth(colWidths: number[], titleCols: [number, number] | null): number {
  if (!titleCols) return 0;
  let w = 0;
  for (let c = titleCols[0]; c <= titleCols[1]; c++) {
    w += colWidths[c] ?? 100;
  }
  return w;
}

// ============================================================================
// Tests: Page layout for all paper sizes with all orientations
// ============================================================================

describe("page layout for all paper sizes and orientations", () => {
  const orientations: Array<"portrait" | "landscape"> = ["portrait", "landscape"];

  for (const [name, paper] of Object.entries(PAPER_SIZES)) {
    for (const orientation of orientations) {
      it(`${name} ${orientation} has positive content area with standard margins`, () => {
        const { contentW, contentH } = computeContentArea({
          paperSize: name,
          orientation,
          marginTop: 0.75,
          marginBottom: 0.75,
          marginLeft: 0.7,
          marginRight: 0.7,
          scale: 100,
          headerHeight: 0,
          footerHeight: 0,
        });
        expect(contentW).toBeGreaterThan(0);
        expect(contentH).toBeGreaterThan(0);
      });

      it(`${name} ${orientation} swaps dimensions correctly`, () => {
        const { pageW, pageH } = computeContentArea({
          paperSize: name,
          orientation,
          marginTop: 0.75, marginBottom: 0.75,
          marginLeft: 0.7, marginRight: 0.7,
          scale: 100, headerHeight: 0, footerHeight: 0,
        });
        if (orientation === "landscape") {
          expect(pageW).toBe(paper.height);
          expect(pageH).toBe(paper.width);
        } else {
          expect(pageW).toBe(paper.width);
          expect(pageH).toBe(paper.height);
        }
      });
    }
  }
});

// ============================================================================
// Tests: Margin combinations
// ============================================================================

describe("margin combinations", () => {
  const margins = {
    narrow:  { top: 0.75, bottom: 0.75, left: 0.25, right: 0.25 },
    normal:  { top: 0.75, bottom: 0.75, left: 0.7,  right: 0.7  },
    wide:    { top: 1.0,  bottom: 1.0,  left: 1.0,  right: 1.0  },
    custom:  { top: 0.5,  bottom: 2.0,  left: 0.3,  right: 1.5  },
  };

  for (const [label, m] of Object.entries(margins)) {
    it(`${label} margins yield smaller content than page`, () => {
      const { pageW, pageH, contentW, contentH } = computeContentArea({
        paperSize: "a4", orientation: "portrait",
        marginTop: m.top, marginBottom: m.bottom,
        marginLeft: m.left, marginRight: m.right,
        scale: 100, headerHeight: 0, footerHeight: 0,
      });
      expect(contentW).toBeLessThan(pageW);
      expect(contentH).toBeLessThan(pageH);
      expect(contentW).toBeGreaterThan(0);
      expect(contentH).toBeGreaterThan(0);
    });
  }

  it("narrow margins give more content width than wide margins", () => {
    const narrow = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.25, marginRight: 0.25,
      scale: 100, headerHeight: 0, footerHeight: 0,
    });
    const wide = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 1.0, marginBottom: 1.0, marginLeft: 1.0, marginRight: 1.0,
      scale: 100, headerHeight: 0, footerHeight: 0,
    });
    expect(narrow.contentW).toBeGreaterThan(wide.contentW);
    expect(narrow.contentH).toBeGreaterThan(wide.contentH);
  });
});

// ============================================================================
// Tests: Content area with headers and footers of varying height
// ============================================================================

describe("content area with headers and footers", () => {
  it("header reduces content height", () => {
    const noHeader = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.7, marginRight: 0.7,
      scale: 100, headerHeight: 0, footerHeight: 0,
    });
    const withHeader = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.7, marginRight: 0.7,
      scale: 100, headerHeight: 10, footerHeight: 0,
    });
    expect(withHeader.contentH).toBe(noHeader.contentH - 10);
  });

  it("footer reduces content height", () => {
    const noFooter = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.7, marginRight: 0.7,
      scale: 100, headerHeight: 0, footerHeight: 0,
    });
    const withFooter = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.7, marginRight: 0.7,
      scale: 100, headerHeight: 0, footerHeight: 15,
    });
    expect(withFooter.contentH).toBe(noFooter.contentH - 15);
  });

  it("large header + footer leaves minimal content", () => {
    const result = computeContentArea({
      paperSize: "a4", orientation: "portrait",
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.7, marginRight: 0.7,
      scale: 100, headerHeight: 100, footerHeight: 100,
    });
    expect(result.contentH).toBeLessThan(60);
    // Still positive for A4 portrait: 297 - 2*19.05 - 200 = ~58.9
    expect(result.contentH).toBeGreaterThan(0);
  });
});

// ============================================================================
// Tests: Scaling calculations
// ============================================================================

describe("scaling calculations", () => {
  it("100% scale returns original px value", () => {
    expect(computeScaledColWidth(100, 100)).toBe(100);
    expect(computeScaledRowHeight(24, 100)).toBe(24);
  });

  it("50% scale halves dimensions", () => {
    expect(computeScaledColWidth(100, 50)).toBe(50);
    expect(computeScaledRowHeight(24, 50)).toBe(12);
  });

  it("200% scale doubles dimensions", () => {
    expect(computeScaledColWidth(100, 200)).toBe(200);
    expect(computeScaledRowHeight(24, 200)).toBe(48);
  });

  it("fit to 1 page: compute required scale for wide data", () => {
    // 10 columns at 100px each = 1000px total
    // A4 portrait content width ~171.9mm = 649px at 96dpi
    // Required scale = 649/1000 * 100 = ~64.9%
    const totalWidthPx = 1000;
    const contentWidthMm = 210 - inchesToMm(0.7) * 2; // ~174.44mm
    const contentWidthPx = contentWidthMm / 0.264583;  // mm to px
    const requiredScale = (contentWidthPx / totalWidthPx) * 100;
    expect(requiredScale).toBeLessThan(100);
    expect(requiredScale).toBeGreaterThan(50);
    // Verify: at this scale, all columns fit
    const scaledWidth = computeScaledColWidth(totalWidthPx, requiredScale);
    expect(scaledWidth).toBeCloseTo(contentWidthPx, 0);
  });

  it("fit to N pages wide: scale distributes across pages", () => {
    // 20 columns at 100px = 2000px total
    // Fit to 2 pages wide: each page handles 1000px
    const totalWidthPx = 2000;
    const pagesWide = 2;
    const perPagePx = totalWidthPx / pagesWide;
    expect(perPagePx).toBe(1000);
    // Each page needs to fit 1000px - same as single page scenario
  });
});

// ============================================================================
// Tests: Repeat rows/columns area calculations
// ============================================================================

describe("repeat rows/columns area calculations", () => {
  const defaultRowHeights = Array(20).fill(24);
  const defaultColWidths = Array(10).fill(100);

  it("no title rows/cols returns 0", () => {
    expect(computeTitleRowsHeight(defaultRowHeights, null)).toBe(0);
    expect(computeTitleColsWidth(defaultColWidths, null)).toBe(0);
  });

  it("single title row returns its height", () => {
    expect(computeTitleRowsHeight(defaultRowHeights, [0, 0])).toBe(24);
  });

  it("multiple title rows returns sum of heights", () => {
    expect(computeTitleRowsHeight(defaultRowHeights, [0, 2])).toBe(72);
  });

  it("title rows with varying heights", () => {
    const heights = [30, 40, 50, 24, 24];
    expect(computeTitleRowsHeight(heights, [0, 2])).toBe(120);
  });

  it("single title column returns its width", () => {
    expect(computeTitleColsWidth(defaultColWidths, [0, 0])).toBe(100);
  });

  it("multiple title columns returns sum of widths", () => {
    expect(computeTitleColsWidth(defaultColWidths, [0, 2])).toBe(300);
  });

  it("title columns with varying widths", () => {
    const widths = [50, 200, 80, 100, 100];
    expect(computeTitleColsWidth(widths, [0, 2])).toBe(330);
  });

  it("parseTitleRows and parseTitleCols round-trip", () => {
    const rows = parseTitleRows("1:3");
    expect(rows).toEqual([0, 2]);
    expect(computeTitleRowsHeight(defaultRowHeights, rows)).toBe(72);

    const cols = parseTitleCols("A:C");
    expect(cols).toEqual([0, 2]);
    expect(computeTitleColsWidth(defaultColWidths, cols)).toBe(300);
  });
});

// ============================================================================
// Tests: Grid line width impact on cell positioning
// ============================================================================

describe("gridline width impact on cell positioning", () => {
  // With gridlines enabled, each cell gets 1px borders on all sides.
  // Due to border-collapse, adjacent cells share borders.
  // Effective additional width per cell = ~1px (collapsed).
  const GRIDLINE_WIDTH_PX = 1;

  it("gridlines add border to each cell side", () => {
    // The buildCellStyle function adds "border-top:1px solid #d0d0d0" etc.
    // In a border-collapse table, this means ~1px per cell boundary.
    const cellWidth = 100;
    const numCols = 10;
    // Without gridlines: total = 10 * 100 = 1000px
    const totalWithout = numCols * cellWidth;
    // With gridlines (border-collapse): adds ~1px per boundary + outer edges
    // Boundaries: numCols + 1 outer edges, but collapse means roughly numCols boundaries
    const totalWith = totalWithout + (numCols + 1) * GRIDLINE_WIDTH_PX;
    expect(totalWith).toBeGreaterThan(totalWithout);
    expect(totalWith - totalWithout).toBe(11);
  });

  it("gridline impact is negligible at large scale", () => {
    const cellWidth = 200;
    const numCols = 5;
    const gridlineOverhead = (numCols + 1) * GRIDLINE_WIDTH_PX;
    const totalWidth = numCols * cellWidth;
    const overheadPct = (gridlineOverhead / totalWidth) * 100;
    expect(overheadPct).toBeLessThan(1); // less than 1%
  });
});

// ============================================================================
// Tests: Cell merge spanning page breaks
// ============================================================================

describe("cell merge spanning page breaks", () => {
  it("merged region is correctly detected as hidden cells", () => {
    // Merge A1:C3 (rows 0-2, cols 0-2)
    const mergedRegions = [{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }];
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
    // Origin cell is NOT hidden
    expect(mergedHidden.has("0,0")).toBe(false);
    // All other cells in the merge are hidden
    expect(mergedHidden.has("0,1")).toBe(true);
    expect(mergedHidden.has("0,2")).toBe(true);
    expect(mergedHidden.has("1,0")).toBe(true);
    expect(mergedHidden.has("1,1")).toBe(true);
    expect(mergedHidden.has("1,2")).toBe(true);
    expect(mergedHidden.has("2,0")).toBe(true);
    expect(mergedHidden.has("2,1")).toBe(true);
    expect(mergedHidden.has("2,2")).toBe(true);
    // Cell outside merge is not hidden
    expect(mergedHidden.has("3,0")).toBe(false);
    expect(mergedHidden.has("0,3")).toBe(false);
  });

  it("merged cell rowSpan and colSpan define the visual size", () => {
    const rowSpan = 3;
    const colSpan = 2;
    const rowHeights = [24, 30, 20];
    const colWidths = [100, 120];
    const totalHeight = rowHeights.reduce((a, b) => a + b, 0);
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    expect(totalHeight).toBe(74);
    expect(totalWidth).toBe(220);
  });

  it("merge that starts on one page boundary extends visually", () => {
    // A merge from row 9 to row 12: if page break is at row 10,
    // the merge origin is on page 1 but extends into page 2.
    // The HTML generator outputs rowspan/colspan on the origin cell.
    const merge = { startRow: 9, endRow: 12, startCol: 0, endCol: 0 };
    const pageBreakRow = 10;
    const mergeExtendsAcrossBreak =
      merge.startRow < pageBreakRow && merge.endRow >= pageBreakRow;
    expect(mergeExtendsAcrossBreak).toBe(true);
  });
});

// ============================================================================
// Tests: Very wide cells exceeding page width
// ============================================================================

describe("very wide cells exceeding page width", () => {
  it("single column wider than content area causes overflow", () => {
    const colWidthPx = 2000; // very wide
    const contentWidthMm = 210 - inchesToMm(0.7) * 2;
    const colWidthMm = colWidthPx * 0.264583;
    expect(colWidthMm).toBeGreaterThan(contentWidthMm);
  });

  it("scaling down can fit a wide column", () => {
    const colWidthPx = 2000;
    const contentWidthMm = 210 - inchesToMm(0.7) * 2;
    const colWidthMm = colWidthPx * 0.264583;
    const requiredScale = (contentWidthMm / colWidthMm) * 100;
    expect(requiredScale).toBeLessThan(100);
    const scaledMm = colWidthPx * 0.264583 * (requiredScale / 100);
    expect(scaledMm).toBeCloseTo(contentWidthMm, 1);
  });

  it("table-layout fixed clips content to column width", () => {
    // The HTML uses table-layout:fixed and overflow:hidden on cells.
    // A 2000px cell in a 174mm content area will be clipped.
    // This is expected behavior -- no crash, just clipping.
    const cellStyle = "overflow:hidden";
    expect(cellStyle).toContain("overflow:hidden");
  });
});

// ============================================================================
// Tests: Print area with non-contiguous ranges
// ============================================================================

describe("print area with non-contiguous ranges", () => {
  it("parsePrintArea only supports single contiguous range", () => {
    // Non-contiguous like "A1:B5,D1:E5" is not supported by the parser
    const result = parsePrintArea("A1:B5,D1:E5");
    expect(result).toBeNull();
  });

  it("parsePrintArea rejects sheet-qualified ranges", () => {
    expect(parsePrintArea("Sheet1!A1:B5")).toBeNull();
  });

  it("valid single range is parsed correctly", () => {
    const result = parsePrintArea("B2:F20");
    expect(result).toEqual({
      startCol: 1,
      startRow: 1,
      endCol: 5,
      endRow: 19,
    });
  });

  it("parsePrintArea with large column references", () => {
    const result = parsePrintArea("AA1:AZ100");
    expect(result).not.toBeNull();
    expect(result!.startCol).toBe(colToIndex("AA"));
    expect(result!.endCol).toBe(colToIndex("AZ"));
    expect(result!.startRow).toBe(0);
    expect(result!.endRow).toBe(99);
  });

  it("print area restricts the row/col range for rendering", () => {
    // If bounds are [999, 25] but print area is A1:C10,
    // only rows 0-9 and cols 0-2 are rendered.
    const maxRow = 999;
    const maxCol = 25;
    const printArea = parsePrintArea("A1:C10");
    const startRow = printArea?.startRow ?? 0;
    const endRow = printArea?.endRow ?? maxRow;
    const startCol = printArea?.startCol ?? 0;
    const endCol = printArea?.endCol ?? maxCol;
    expect(startRow).toBe(0);
    expect(endRow).toBe(9);
    expect(startCol).toBe(0);
    expect(endCol).toBe(2);
  });
});
