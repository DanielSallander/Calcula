//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFit.test.ts
// PURPOSE: Excel-semantics tests for double-click best-fit measurement,
//          including extension contributions via @api/autoFitContributors.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  measureOptimalColumnWidth,
  measureOptimalRowHeight,
  setMeasureContextForTesting,
} from "./autoFit";
import {
  registerAutoFitContributor,
  unregisterAutoFitContributor,
  listAutoFitContributors,
} from "../../../../api/autoFitContributors";
import type { CellData, StyleData } from "../../../types";

// Mock 2D context: 10px per character, 12px when the font is bold.
function createMockCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: "",
    measureText: vi.fn((text: string) => ({
      width: text.length * (ctx.font.includes("bold") ? 12 : 10),
    })),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const THEME = { cellFontFamily: "TestFont", cellFontSize: 13 };
const MIN_WIDTH = 20;
const MIN_HEIGHT = 16;
const DEFAULT_ROW_HEIGHT = 24;
const DEFAULT_COL_WIDTH = 100;

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    row: 0,
    col: 0,
    display: "",
    formula: null,
    styleIndex: 0,
    ...overrides,
  } as CellData;
}

const defaultStyle = { bold: false, italic: false, fontSize: 0, fontFamily: "", wrapText: false } as StyleData;
const boldStyle = { ...defaultStyle, bold: true } as StyleData;
const wrapStyle = { ...defaultStyle, wrapText: true } as StyleData;
const bigFontStyle = { ...defaultStyle, fontSize: 26 } as StyleData;
const indentStyle = { ...defaultStyle, indent: 2 } as StyleData;
const STYLES: StyleData[] = [defaultStyle, boldStyle, wrapStyle, bigFontStyle, indentStyle];

let mockCtx: CanvasRenderingContext2D;

beforeEach(() => {
  mockCtx = createMockCtx();
  setMeasureContextForTesting(mockCtx);
});

afterEach(() => {
  setMeasureContextForTesting(null);
  for (const contributor of listAutoFitContributors()) {
    unregisterAutoFitContributor(contributor.id);
  }
});

describe("measureOptimalColumnWidth (Excel semantics)", () => {
  it("returns null for an empty column (Excel leaves the width unchanged)", () => {
    expect(measureOptimalColumnWidth(0, [], STYLES, THEME, MIN_WIDTH)).toBeNull();
  });

  it("does not use the header letter as a width floor", () => {
    // A single tiny cell: 1 char * 10px + padding 6 + margin 2 = 18, clamped up
    // to the MIN_WIDTH floor of 20.
    const cells = [makeCell({ display: "1" })];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(20);
  });

  it("fits the widest rendered cell with padding", () => {
    const cells = [
      makeCell({ row: 0, display: "abc" }),
      makeCell({ row: 1, display: "abcdefghij" }),
      makeCell({ row: 2, display: "ab" }),
    ];
    // 10 chars * 10px + 6 + 2 = 108
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(108);
  });

  it("measures each cell with its own font (bold is wider)", () => {
    const cells = [
      makeCell({ row: 0, display: "abcde", styleIndex: 1 }),
      makeCell({ row: 1, display: "abcde" }),
    ];
    // Bold: 5 * 12 + 8 = 68 beats normal 5 * 10 + 8 = 58
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(68);
  });

  it("ignores cells merged across columns", () => {
    const cells = [
      makeCell({ row: 0, display: "wide merged content", colSpan: 3 }),
      makeCell({ row: 1, display: "abc" }),
    ];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(38);
  });

  it("ignores wrap-text cells; an all-wrapped column is a no-op", () => {
    const mixed = [
      makeCell({ row: 0, display: "very long wrapped text here", styleIndex: 2 }),
      makeCell({ row: 1, display: "abc" }),
    ];
    expect(measureOptimalColumnWidth(0, mixed, STYLES, THEME, MIN_WIDTH)).toBe(38);

    const allWrapped = [
      makeCell({ row: 0, display: "very long wrapped text here", styleIndex: 2 }),
    ];
    expect(measureOptimalColumnWidth(0, allWrapped, STYLES, THEME, MIN_WIDTH)).toBeNull();
  });

  it("clamps to the minimum width", () => {
    const cells = [makeCell({ display: "" })];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBeNull();
    const tiny = [makeCell({ display: "a" })];
    expect(measureOptimalColumnWidth(0, tiny, STYLES, THEME, 50)).toBe(50);
  });

  it("skips contributor-claimed cells and uses the contributor's required width", () => {
    registerAutoFitContributor({
      id: "test-pivot",
      measureColumn: (col) =>
        col === 2
          ? { claimedRowRanges: [{ startRow: 5, endRow: 10 }], requiredWidth: 150 }
          : null,
    });
    const cells = [
      // Claimed: would measure 300+ wide, but the contributor speaks for it
      makeCell({ row: 7, display: "x".repeat(30) }),
      makeCell({ row: 20, display: "abc" }),
    ];
    expect(measureOptimalColumnWidth(2, cells, STYLES, THEME, MIN_WIDTH)).toBe(150);
  });

  it("lets a core-measured cell beat a smaller contributor width", () => {
    registerAutoFitContributor({
      id: "test-pivot",
      measureColumn: () => ({
        claimedRowRanges: [{ startRow: 0, endRow: 0 }],
        requiredWidth: 30,
      }),
    });
    const cells = [makeCell({ row: 1, display: "abcdefghij" })];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(108);
  });

  it("adds contributor extra cell width (in-cell chrome like filter buttons)", () => {
    registerAutoFitContributor({
      id: "test-autofilter",
      measureColumn: () => ({ extraCellWidth: new Map([[0, 20]]) }),
    });
    const cells = [
      makeCell({ row: 0, display: "Header" }),
      makeCell({ row: 1, display: "Header" }),
    ];
    // Header row: 6*10 + 8 + 20 = 88 beats data row 68
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(88);
  });

  it("returns null when contributors claim everything and report no width", () => {
    registerAutoFitContributor({
      id: "test-pivot",
      measureColumn: () => ({ claimedRowRanges: [{ startRow: 0, endRow: 100 }] }),
    });
    const cells = [makeCell({ row: 3, display: "claimed content" })];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBeNull();
  });

  it("contains a throwing contributor and still measures", () => {
    registerAutoFitContributor({
      id: "test-broken",
      measureColumn: () => {
        throw new Error("boom");
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cells = [makeCell({ display: "abc" })];
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(38);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("adds the style indent the renderer shifts text by (8px per level)", () => {
    const cells = [makeCell({ display: "abc", styleIndex: 4 })];
    // 3 * 10 + 8 padding + 2 * 8 indent = 54
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(54);
  });

  it("measures rich-text cells per run with each run's own font", () => {
    const cells = [
      makeCell({
        display: "abcdef",
        richText: [
          { text: "abc" },
          { text: "def", bold: true },
        ],
      }),
    ];
    // 3*10 (normal) + 3*12 (bold) + 8 padding = 74 vs plain 6*10+8 = 68
    expect(measureOptimalColumnWidth(0, cells, STYLES, THEME, MIN_WIDTH)).toBe(74);
  });
});

describe("measureOptimalRowHeight (Excel semantics)", () => {
  const measure = (cells: CellData[], row = 0, widths = new Map<number, number>()) =>
    measureOptimalRowHeight(
      cells,
      STYLES,
      widths,
      DEFAULT_COL_WIDTH,
      THEME,
      MIN_HEIGHT,
      DEFAULT_ROW_HEIGHT,
      row
    );

  it("returns null for an empty row (caller resets to the default height)", () => {
    expect(measure([])).toBeNull();
  });

  it("default-size single-line text lands exactly on the default row height", () => {
    const cells = [makeCell({ display: "abc" })];
    expect(measure(cells)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("larger fonts raise the row, even on cells without text", () => {
    // Excel: height follows the applied font size, not text presence
    const cells = [makeCell({ display: "", styleIndex: 3 })];
    // fontSize 26pt -> 34.667px; 34.667 * 1.2 + 4 = 45.6 -> 46
    expect(measure(cells)).toBe(46);
  });

  it("wrapped text contributes its line count at the current column width", () => {
    const cells = [makeCell({ col: 0, display: "aaaa bbbb cccc", styleIndex: 2 })];
    // Column width 60 -> available 54 -> "aaaa bbbb cccc" wraps to 3 lines
    // (each "aaaa " chunk is 50px); 3 * 17.333px(=13pt) * 1.2 + 4 = 66.4 -> 67
    expect(measure(cells, 0, new Map([[0, 60]]))).toBe(67);
  });

  it("ignores cells merged across rows", () => {
    const cells = [
      makeCell({ display: "x", styleIndex: 3, rowSpan: 2 }),
      makeCell({ col: 1, display: "abc" }),
    ];
    expect(measure(cells)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("ignores cells merged across columns (their wrap width is the merged span, not one column)", () => {
    const cells = [
      makeCell({ display: "aaaa bbbb cccc dddd eeee", styleIndex: 2, colSpan: 3 }),
      makeCell({ col: 3, display: "abc" }),
    ];
    expect(measure(cells, 0, new Map([[0, 60]]))).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("uses the tallest rich-text run for the row height", () => {
    const cells = [
      makeCell({
        display: "abc",
        richText: [{ text: "ab" }, { text: "c", fontSize: 26 }],
      }),
    ];
    // tallest run 26pt -> 34.667px; 34.667 * 1.2 + 4 = 45.6 -> 46
    expect(measure(cells)).toBe(46);
  });

  it("floors contributor-only chrome rows at the default height", () => {
    registerAutoFitContributor({
      id: "test-autofilter",
      measureRow: () => ({ requiredHeight: 22 }),
    });
    // No cells at all: the chrome minimum (22) must not undercut the default
    expect(measure([])).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("lets contributor chrome exceed the default when it is taller", () => {
    registerAutoFitContributor({
      id: "test-tall-chrome",
      measureRow: () => ({ requiredHeight: 40 }),
    });
    expect(measure([])).toBe(40);
  });

  it("skips contributor-claimed cells and honors required height", () => {
    registerAutoFitContributor({
      id: "test-pivot",
      measureRow: (row) =>
        row === 4
          ? { claimedColRanges: [{ startCol: 0, endCol: 5 }], requiredHeight: 28 }
          : null,
    });
    const cells = [makeCell({ col: 2, display: "x", styleIndex: 3 })];
    // The big-font cell is claimed; the contributor's 28 wins
    expect(measure(cells, 4)).toBe(28);
  });
});

describe("autoFitContributors registry", () => {
  it("register returns a cleanup that unregisters", () => {
    const cleanup = registerAutoFitContributor({ id: "test-a" });
    expect(listAutoFitContributors().map((c) => c.id)).toContain("test-a");
    cleanup();
    expect(listAutoFitContributors().map((c) => c.id)).not.toContain("test-a");
  });

  it("unregisterAutoFitContributor removes by id", () => {
    registerAutoFitContributor({ id: "test-b" });
    unregisterAutoFitContributor("test-b");
    expect(listAutoFitContributors().map((c) => c.id)).not.toContain("test-b");
  });
});
