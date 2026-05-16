//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterExpression-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for filter expression parsing and color matching.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Global stubs (window/CustomEvent needed by filterStore)
// ============================================================================

vi.stubGlobal('window', {
  dispatchEvent: vi.fn(),
});
vi.stubGlobal('dispatchEvent', vi.fn());
vi.stubGlobal('CustomEvent', class CustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, opts?: { detail?: unknown }) {
    this.type = type;
    this.detail = opts?.detail;
  }
});

// ============================================================================
// Mocks - we mock @api and @api/lib since filterStore depends on them
// ============================================================================

const mockSetColumnCustomFilter = vi.fn();
const mockSetColumnFilterValues = vi.fn();
const mockApplyAutoFilter = vi.fn();
const mockRemoveAutoFilter = vi.fn();
const mockClearAutoFilterCriteria = vi.fn();
const mockReapplyAutoFilter = vi.fn();
const mockClearColumnCriteria = vi.fn();
const mockGetAutoFilter = vi.fn();
const mockGetHiddenRows = vi.fn();
const mockGetFilterUniqueValues = vi.fn();
const mockDetectDataRegion = vi.fn();
const mockSetHiddenRows = vi.fn().mockImplementation((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }));
const mockDispatchGridAction = vi.fn();
const mockEmitAppEvent = vi.fn();
const mockAddGridRegions = vi.fn();
const mockRemoveGridRegionsByType = vi.fn();

vi.mock("@api", () => ({
  applyAutoFilter: (...args: unknown[]) => mockApplyAutoFilter(...args),
  removeAutoFilter: (...args: unknown[]) => mockRemoveAutoFilter(...args),
  clearAutoFilterCriteria: (...args: unknown[]) => mockClearAutoFilterCriteria(...args),
  reapplyAutoFilter: (...args: unknown[]) => mockReapplyAutoFilter(...args),
  clearColumnCriteria: (...args: unknown[]) => mockClearColumnCriteria(...args),
  getAutoFilter: (...args: unknown[]) => mockGetAutoFilter(...args),
  getHiddenRows: (...args: unknown[]) => mockGetHiddenRows(...args),
  setColumnFilterValues: (...args: unknown[]) => mockSetColumnFilterValues(...args),
  getFilterUniqueValues: (...args: unknown[]) => mockGetFilterUniqueValues(...args),
  detectDataRegion: (...args: unknown[]) => mockDetectDataRegion(...args),
  setHiddenRows: (rows: number[]) => mockSetHiddenRows(rows),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  emitAppEvent: (...args: unknown[]) => mockEmitAppEvent(...args),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  addGridRegions: (...args: unknown[]) => mockAddGridRegions(...args),
  removeGridRegionsByType: (...args: unknown[]) => mockRemoveGridRegionsByType(...args),
}));

const mockSortRangeByColumn = vi.fn();
const mockSortRange = vi.fn();
const mockGetViewportCells = vi.fn();
const mockGetStyle = vi.fn();

vi.mock("@api/lib", () => ({
  sortRangeByColumn: (...args: unknown[]) => mockSortRangeByColumn(...args),
  sortRange: (...args: unknown[]) => mockSortRange(...args),
  getViewportCells: (...args: unknown[]) => mockGetViewportCells(...args),
  getStyle: (...args: unknown[]) => mockGetStyle(...args),
  setColumnCustomFilter: (...args: unknown[]) => mockSetColumnCustomFilter(...args),
}));

// Import after mocks
import {
  applyExpressionFilter,
  getUniqueColorsInColumn,
  getFilterState,
  resetState,
} from "../filterStore";

// ============================================================================
// Expression filter parsing - 60 cases
// ============================================================================

describe("applyExpressionFilter - expression parsing", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  // We need to have an active filter for expression filter to work
  function activateFilter(): void {
    // Directly set the state by toggling with a mock
    const stateObj = getFilterState();
    (stateObj as any).autoFilterInfo = {
      startRow: 0, startCol: 0, endRow: 10, endCol: 5, enabled: true,
      columns: [],
    };
    (stateObj as any).isActive = true;
  }

  // Cases: [label, expression, shouldCallBackend]
  // applyExpressionFilter trims and calls setColumnCustomFilter if non-empty
  const expressionCases: Array<[string, string, boolean]> = [
    // Numeric comparison expressions
    ["equals number", "=100", true],
    ["greater than", ">50", true],
    ["less than", "<200", true],
    ["greater or equal", ">=100", true],
    ["less or equal", "<=500", true],
    ["not equal number", "<>0", true],
    ["plain number (implicit =)", "42", true],
    ["negative number", ">-10", true],
    ["decimal number", ">=3.14", true],
    ["zero", "=0", true],
    // String comparison expressions
    ["equals string", "=hello", true],
    ["not equal string", "<>done", true],
    ["greater string", ">M", true],
    ["less string", "<Z", true],
    ["plain string", "hello", true],
    ["mixed case", "=Hello", true],
    // Wildcard expressions
    ["star prefix", "=*text", true],
    ["star suffix", "=text*", true],
    ["star both", "=*text*", true],
    ["question mark", "=te?t", true],
    ["complex wildcard", "=*test?value*", true],
    ["just star", "=*", true],
    ["just question", "=?", true],
    ["star no equals", "*text*", true],
    ["question no equals", "t?st", true],
    // Empty/whitespace (should NOT call backend)
    ["empty string", "", false],
    ["single space", " ", false],
    ["multiple spaces", "   ", false],
    ["tab", "\t", false],
    // Operator-only expressions
    ["equals only", "=", true],
    ["not-equal only", "<>", true],
    ["gt only", ">", true],
    ["lt only", "<", true],
    ["gte only", ">=", true],
    ["lte only", "<=", true],
    // Special values
    ["boolean TRUE", "=TRUE", true],
    ["boolean FALSE", "=FALSE", true],
    ["date-like", ">=2024-01-01", true],
    ["time-like", "<=12:30", true],
    ["percentage-like", ">50%", true],
    ["currency-like", ">$100", true],
    // Long expressions
    ["very long value", "=" + "a".repeat(500), true],
    ["number with spaces", "> 100", true],
    ["padded expression", "  >=50  ", true],
    // Multiple operators (first valid wins)
    ["double equals", "==value", true],
    ["gte then extra", ">==5", true],
    // Unicode
    ["unicode value", "=\u00e4\u00f6\u00fc", true],
    ["emoji-like", "=\u2605", true],
    // Numeric edge cases
    ["scientific notation", "=1e5", true],
    ["leading zeros", "=007", true],
    ["NaN", "=NaN", true],
    ["Infinity", "=Infinity", true],
    // Special characters
    ["at sign", "=user@example.com", true],
    ["hash", "=#REF!", true],
    ["parentheses", "=(test)", true],
    ["brackets", "=[value]", true],
    ["forward slash", "=a/b", true],
    ["backslash", "=a\\b", true],
    ["comma", "=a,b", true],
    ["semicolon", "=a;b", true],
    ["colon", "=a:b", true],
  ];

  it.each(expressionCases)(
    "%s: applyExpressionFilter(0, %j) => callsBackend=%s",
    async (_label, expression, shouldCall) => {
      activateFilter();
      mockSetColumnCustomFilter.mockResolvedValue({
        success: true,
        autoFilter: {
          startRow: 0, startCol: 0, endRow: 10, endCol: 5, enabled: true, columns: [],
        },
        hiddenRows: [],
      });

      await applyExpressionFilter(0, expression);

      if (shouldCall) {
        expect(mockSetColumnCustomFilter).toHaveBeenCalledTimes(1);
        expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, expression.trim());
      } else {
        expect(mockSetColumnCustomFilter).not.toHaveBeenCalled();
      }
    },
  );
});

// ============================================================================
// Color filter matching - 30 cases
// ============================================================================

describe("getUniqueColorsInColumn - color matching", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  function activateFilter(): void {
    const stateObj = getFilterState();
    (stateObj as any).autoFilterInfo = {
      startRow: 0, startCol: 0, endRow: 10, endCol: 5, enabled: true,
      columns: [],
    };
    (stateObj as any).isActive = true;
  }

  // Cases: [label, cells, styleMap, colorType, expectedColors]
  type ColorCase = [
    string,
    Array<{ row: number; col: number; display: string; styleIndex: number }>,
    Record<number, { backgroundColor: string; textColor: string }>,
    "cellColor" | "fontColor",
    string[],
  ];

  const colorCases: ColorCase[] = [
    [
      "single red background",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#ff0000", textColor: "#000000" } },
      "cellColor",
      ["#ff0000"],
    ],
    [
      "single blue font",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "transparent", textColor: "#0000ff" } },
      "fontColor",
      ["#0000ff"],
    ],
    [
      "no cells => empty",
      [],
      {},
      "cellColor",
      [],
    ],
    [
      "style 0 skipped for cellColor",
      [{ row: 1, col: 2, display: "A", styleIndex: 0 }],
      { 0: { backgroundColor: "#ff0000", textColor: "#000000" } },
      "cellColor",
      [],
    ],
    [
      "transparent background filtered out",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "transparent", textColor: "#000000" } },
      "cellColor",
      [],
    ],
    [
      "rgba(0,0,0,0) filtered out",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "rgba(0, 0, 0, 0)", textColor: "#000000" } },
      "cellColor",
      [],
    ],
    [
      "#000000 font filtered out",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#ffffff", textColor: "#000000" } },
      "fontColor",
      [],
    ],
    [
      "multiple distinct backgrounds",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
        { row: 3, col: 2, display: "C", styleIndex: 3 },
      ],
      {
        1: { backgroundColor: "#ff0000", textColor: "#000000" },
        2: { backgroundColor: "#00ff00", textColor: "#000000" },
        3: { backgroundColor: "#0000ff", textColor: "#000000" },
      },
      "cellColor",
      ["#ff0000", "#00ff00", "#0000ff"],
    ],
    [
      "duplicate colors deduplicated",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 1 },
      ],
      { 1: { backgroundColor: "#ff0000", textColor: "#000000" } },
      "cellColor",
      ["#ff0000"],
    ],
    [
      "case normalization",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "#FF0000", textColor: "#000000" },
        2: { backgroundColor: "#ff0000", textColor: "#000000" },
      },
      "cellColor",
      ["#ff0000"],
    ],
    [
      "mixed valid and transparent",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "#ff0000", textColor: "#000000" },
        2: { backgroundColor: "transparent", textColor: "#000000" },
      },
      "cellColor",
      ["#ff0000"],
    ],
    [
      "font color green",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#ffffff", textColor: "#00ff00" } },
      "fontColor",
      ["#00ff00"],
    ],
    [
      "multiple font colors",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "#ffffff", textColor: "#ff0000" },
        2: { backgroundColor: "#ffffff", textColor: "#0000ff" },
      },
      "fontColor",
      ["#ff0000", "#0000ff"],
    ],
    [
      "style 0 NOT skipped for fontColor",
      [{ row: 1, col: 2, display: "A", styleIndex: 0 }],
      { 0: { backgroundColor: "#ffffff", textColor: "#ff0000" } },
      "fontColor",
      ["#ff0000"],
    ],
    [
      "3-digit hex still works",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#f00", textColor: "#000000" } },
      "cellColor",
      ["#f00"],
    ],
    [
      "rgb() format",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "rgb(255, 0, 0)", textColor: "#000000" } },
      "cellColor",
      ["rgb(255, 0, 0)"],
    ],
    [
      "five cells three unique colors",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
        { row: 3, col: 2, display: "C", styleIndex: 3 },
        { row: 4, col: 2, display: "D", styleIndex: 1 },
        { row: 5, col: 2, display: "E", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "#aaa", textColor: "#000000" },
        2: { backgroundColor: "#bbb", textColor: "#000000" },
        3: { backgroundColor: "#ccc", textColor: "#000000" },
      },
      "cellColor",
      ["#aaa", "#bbb", "#ccc"],
    ],
    [
      "all transparent => empty",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "transparent", textColor: "#000000" },
        2: { backgroundColor: "transparent", textColor: "#000000" },
      },
      "cellColor",
      [],
    ],
    [
      "all #000000 font => empty",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
      ],
      {
        1: { backgroundColor: "#fff", textColor: "#000000" },
        2: { backgroundColor: "#fff", textColor: "#000000" },
      },
      "fontColor",
      [],
    ],
    [
      "named color string",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "red", textColor: "#000000" } },
      "cellColor",
      ["red"],
    ],
    [
      "single cell with both bg and font color",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#ff0000", textColor: "#0000ff" } },
      "cellColor",
      ["#ff0000"],
    ],
    [
      "same cell font color check",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#ff0000", textColor: "#0000ff" } },
      "fontColor",
      ["#0000ff"],
    ],
    [
      "hsl color format",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "hsl(0, 100%, 50%)", textColor: "#000000" } },
      "cellColor",
      ["hsl(0, 100%, 50%)"],
    ],
    [
      "ten cells same color",
      Array.from({ length: 10 }, (_, i) => ({ row: i + 1, col: 2, display: String(i), styleIndex: 1 })),
      { 1: { backgroundColor: "#abcdef", textColor: "#000000" } },
      "cellColor",
      ["#abcdef"],
    ],
    [
      "empty string background treated as falsy",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "", textColor: "#ff0000" } },
      "cellColor",
      [],
    ],
    [
      "null-ish background",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: undefined as any, textColor: "#ff0000" } },
      "cellColor",
      [],
    ],
    [
      "uppercase hex normalized to lowercase",
      [{ row: 1, col: 2, display: "A", styleIndex: 1 }],
      { 1: { backgroundColor: "#AABBCC", textColor: "#000000" } },
      "cellColor",
      ["#aabbcc"],
    ],
    [
      "mixed case duplicates collapsed",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 2 },
        { row: 3, col: 2, display: "C", styleIndex: 3 },
      ],
      {
        1: { backgroundColor: "#AABBCC", textColor: "#000000" },
        2: { backgroundColor: "#aabbcc", textColor: "#000000" },
        3: { backgroundColor: "#AaBbCc", textColor: "#000000" },
      },
      "cellColor",
      ["#aabbcc"],
    ],
    [
      "getStyle throws for invalid index",
      [{ row: 1, col: 2, display: "A", styleIndex: 999 }],
      {}, // no style for 999
      "cellColor",
      [],
    ],
    [
      "mix of valid cells and invalid style indices",
      [
        { row: 1, col: 2, display: "A", styleIndex: 1 },
        { row: 2, col: 2, display: "B", styleIndex: 999 },
      ],
      { 1: { backgroundColor: "#ff0000", textColor: "#000000" } },
      "cellColor",
      ["#ff0000"],
    ],
  ];

  it.each(colorCases)(
    "%s",
    async (_label, cells, styleMap, colorType, expectedColors) => {
      activateFilter();
      mockGetViewportCells.mockResolvedValue(cells);
      mockGetStyle.mockImplementation((idx: number) => {
        if (styleMap[idx]) {
          return Promise.resolve(styleMap[idx]);
        }
        return Promise.reject(new Error(`No style for index ${idx}`));
      });

      const result = await getUniqueColorsInColumn(2, colorType);

      expect(result.sort()).toEqual(expectedColors.sort());
    },
  );
});
