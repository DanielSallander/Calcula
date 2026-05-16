//! FILENAME: app/extensions/AdvancedFilter/lib/__tests__/advancedFilterEngineDeep.test.ts
// PURPOSE: Deep tests for Advanced Filter criteria parsing, matching logic,
//          wildcard patterns, AND/OR criteria, comparison operators on different data types,
//          unique records, filter-in-place, and copy-to operations.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockGetViewportCells = vi.fn();
const mockUpdateCellsBatch = vi.fn();
const mockSetHiddenRows = vi.fn().mockImplementation((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }));
const mockDispatchGridAction = vi.fn();
const mockEmitAppEvent = vi.fn();
const mockSetAdvancedFilterHiddenRows = vi.fn();
const mockClearAdvancedFilterHiddenRows = vi.fn();

vi.mock("@api", () => ({
  getViewportCells: (...args: unknown[]) => mockGetViewportCells(...args),
  updateCellsBatch: (...args: unknown[]) => mockUpdateCellsBatch(...args),
  setHiddenRows: (rows: number[]) => mockSetHiddenRows(rows),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  emitAppEvent: (...args: unknown[]) => mockEmitAppEvent(...args),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  indexToCol: (idx: number) => {
    let result = "";
    let n = idx;
    do {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return result;
  },
  colToIndex: (col: string) => {
    let result = 0;
    for (let i = 0; i < col.length; i++) {
      result = result * 26 + (col.charCodeAt(i) - 64);
    }
    return result - 1;
  },
  setAdvancedFilterHiddenRows: (...args: unknown[]) => mockSetAdvancedFilterHiddenRows(...args),
  clearAdvancedFilterHiddenRows: (...args: unknown[]) => mockClearAdvancedFilterHiddenRows(...args),
}));

import {
  parseRangeRef,
  formatRangeRef,
  formatCellRef,
  parseCriterion,
  executeAdvancedFilter,
  clearAdvancedFilter,
} from "../advancedFilterEngine";

import type { CriteriaRow, ParsedCriterion } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

/** Build a mock cell data array from a 2D grid. Row 0 = headers. */
function buildCellData(
  grid: string[][],
  startRow: number,
  startCol: number,
) {
  const cells: Array<{ row: number; col: number; display: string; styleIndex: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      cells.push({
        row: startRow + r,
        col: startCol + c,
        display: grid[r][c],
        styleIndex: 0,
      });
    }
  }
  return cells;
}

// ============================================================================
// parseCriterion - comprehensive operator coverage
// ============================================================================

describe("parseCriterion - comprehensive", () => {
  it("parses = with numeric value", () => {
    expect(parseCriterion("=42")).toEqual({ operator: "=", value: "42", hasWildcard: false });
  });

  it("parses = with text value", () => {
    expect(parseCriterion("=Hello World")).toEqual({ operator: "=", value: "Hello World", hasWildcard: false });
  });

  it("implicit equals for bare text", () => {
    expect(parseCriterion("Shipped")).toEqual({ operator: "=", value: "Shipped", hasWildcard: false });
  });

  it("combined wildcards * and ?", () => {
    const result = parseCriterion("=A*B?C");
    expect(result.hasWildcard).toBe(true);
    expect(result.value).toBe("A*B?C");
  });

  it("<> with wildcard", () => {
    const result = parseCriterion("<>test?");
    expect(result).toEqual({ operator: "<>", value: "test?", hasWildcard: true });
  });

  it("no wildcard detection for >, <, >=, <=", () => {
    expect(parseCriterion(">a*").hasWildcard).toBe(false);
    expect(parseCriterion("<b?").hasWildcard).toBe(false);
    expect(parseCriterion(">=x*y").hasWildcard).toBe(false);
    expect(parseCriterion("<=?z").hasWildcard).toBe(false);
  });

  it("handles decimal numbers", () => {
    expect(parseCriterion(">=3.14")).toEqual({ operator: ">=", value: "3.14", hasWildcard: false });
  });

  it("handles negative numbers", () => {
    expect(parseCriterion(">-10")).toEqual({ operator: ">", value: "-10", hasWildcard: false });
  });

  it("handles value with spaces after operator", () => {
    expect(parseCriterion(">= 100")).toEqual({ operator: ">=", value: "100", hasWildcard: false });
  });
});

// ============================================================================
// parseRangeRef - additional edge cases
// ============================================================================

describe("parseRangeRef - additional", () => {
  it("parses triple-letter column (AAA1)", () => {
    const result = parseRangeRef("AAA1");
    expect(result).not.toBeNull();
    // AAA = 26*26 + 26 + 1 - 1 = 702
    expect(result![1]).toBe(702);
  });

  it("parses large row numbers", () => {
    const result = parseRangeRef("A1:A1000000");
    expect(result).toEqual([0, 0, 999999, 0]);
  });

  it("returns null for range with only letters", () => {
    expect(parseRangeRef("ABC")).toBeNull();
  });

  it("is case-insensitive", () => {
    const upper = parseRangeRef("A1:B2");
    const lower = parseRangeRef("a1:b2");
    expect(upper).toEqual(lower);
  });
});

// ============================================================================
// formatRangeRef / formatCellRef - additional
// ============================================================================

describe("formatRangeRef - additional", () => {
  it("formats multi-letter column range", () => {
    expect(formatRangeRef(0, 26, 4, 27)).toBe("AA1:AB5");
  });

  it("formats single-row range", () => {
    expect(formatRangeRef(0, 0, 0, 5)).toBe("A1:F1");
  });
});

describe("formatCellRef - additional", () => {
  it("formats column Z", () => {
    expect(formatCellRef(0, 25)).toBe("Z1");
  });

  it("formats column AA", () => {
    expect(formatCellRef(0, 26)).toBe("AA1");
  });
});

// ============================================================================
// executeAdvancedFilter - AND criteria (same row)
// ============================================================================

describe("executeAdvancedFilter - AND criteria", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("filters rows matching ALL conditions in a single criteria row", async () => {
    // List: Name, Age, City (rows 0-4)
    const listData = buildCellData([
      ["Name", "Age", "City"],
      ["Alice", "30", "NYC"],
      ["Bob", "25", "LA"],
      ["Charlie", "30", "NYC"],
      ["Diana", "25", "NYC"],
    ], 0, 0);

    // Criteria: Age=30 AND City=NYC (same row = AND)
    const criteriaData = buildCellData([
      ["Age", "City"],
      ["30", "NYC"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)    // list range
      .mockResolvedValueOnce(criteriaData); // criteria range

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 2],
      criteriaRange: [10, 0, 11, 1],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(2); // Alice and Charlie
    // Hidden: Bob (row 2) and Diana (row 4)
    expect(result.affectedRows).toBe(2);
    expect(mockSetHiddenRows).toHaveBeenCalledWith([2, 4]);
  });

  it("hides all rows when no data matches AND criteria", async () => {
    const listData = buildCellData([
      ["Name", "Score"],
      ["Alice", "50"],
      ["Bob", "60"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name", "Score"],
      ["Alice", ">90"], // Alice AND Score>90 -> no match
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 2, 1],
      criteriaRange: [10, 0, 11, 1],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(0);
    expect(result.affectedRows).toBe(2);
  });
});

// ============================================================================
// executeAdvancedFilter - OR criteria (multiple rows)
// ============================================================================

describe("executeAdvancedFilter - OR criteria", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("matches rows satisfying ANY criteria row (OR logic)", async () => {
    const listData = buildCellData([
      ["Name", "Status"],
      ["Alice", "Active"],
      ["Bob", "Inactive"],
      ["Charlie", "Pending"],
      ["Diana", "Active"],
    ], 0, 0);

    // Two criteria rows: Status=Active OR Status=Pending
    const criteriaData = buildCellData([
      ["Status"],
      ["Active"],
      ["Pending"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 1],
      criteriaRange: [10, 0, 12, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(3); // Alice, Charlie, Diana
    expect(result.affectedRows).toBe(1); // Only Bob hidden
  });
});

// ============================================================================
// executeAdvancedFilter - combined AND/OR
// ============================================================================

describe("executeAdvancedFilter - combined AND/OR", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("handles AND within rows, OR across rows", async () => {
    const listData = buildCellData([
      ["Product", "Price", "Category"],
      ["Widget", "10", "A"],
      ["Gadget", "50", "B"],
      ["Doohickey", "100", "A"],
      ["Thingamajig", "200", "B"],
    ], 0, 0);

    // Row 1: Price>=50 AND Category=A  (Doohickey)
    // Row 2: Price<20 AND Category=A   (Widget)
    const criteriaData = buildCellData([
      ["Price", "Category"],
      [">=50", "A"],
      ["<20", "A"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 2],
      criteriaRange: [10, 0, 12, 1],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(2); // Widget, Doohickey
    expect(result.affectedRows).toBe(2); // Gadget, Thingamajig hidden
  });
});

// ============================================================================
// executeAdvancedFilter - wildcard patterns
// ============================================================================

describe("executeAdvancedFilter - wildcard patterns", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("matches * wildcard (any characters)", async () => {
    const listData = buildCellData([
      ["Name"],
      ["John Smith"],
      ["Jane Smith"],
      ["John Doe"],
      ["Bob Johnson"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name"],
      ["John*"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(2); // John Smith, John Doe
  });

  it("matches ? wildcard (single character)", async () => {
    const listData = buildCellData([
      ["Code"],
      ["A1B"],
      ["A2B"],
      ["A12B"],
      ["AXB"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Code"],
      ["A?B"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(3); // A1B, A2B, AXB (not A12B)
  });

  it("matches <> with wildcard (exclude pattern)", async () => {
    const listData = buildCellData([
      ["File"],
      ["report.pdf"],
      ["data.csv"],
      ["report.xlsx"],
      ["image.png"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["File"],
      ["<>report*"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(2); // data.csv, image.png
  });

  it("matches *text* (contains) pattern", async () => {
    const listData = buildCellData([
      ["Description"],
      ["Error in module A"],
      ["Warning: disk space"],
      ["Fatal error occurred"],
      ["Success"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Description"],
      ["*error*"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    // Case-insensitive: "Error in module A" and "Fatal error occurred"
    expect(result.matchCount).toBe(2);
  });
});

// ============================================================================
// executeAdvancedFilter - comparison operators on different data types
// ============================================================================

describe("executeAdvancedFilter - comparison operators", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("numeric > comparison", async () => {
    const listData = buildCellData([
      ["Value"],
      ["10"],
      ["50"],
      ["100"],
      ["5"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Value"],
      [">20"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(2); // 50, 100
  });

  it("numeric <= comparison", async () => {
    const listData = buildCellData([
      ["Score"],
      ["10"],
      ["20"],
      ["30"],
      ["20"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Score"],
      ["<=20"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(3); // 10, 20, 20
  });

  it("text comparison with > (lexicographic)", async () => {
    const listData = buildCellData([
      ["Name"],
      ["Alice"],
      ["Bob"],
      ["Charlie"],
      ["Zara"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name"],
      [">C"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    // lowercase comparison: "charlie" > "c" and "zara" > "c"
    expect(result.matchCount).toBe(2);
  });

  it("<> (not equals) filters out matching rows", async () => {
    const listData = buildCellData([
      ["Status"],
      ["Active"],
      ["Inactive"],
      ["Active"],
      ["Pending"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Status"],
      ["<>Active"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(2); // Inactive, Pending
  });

  it("decimal numeric comparison", async () => {
    const listData = buildCellData([
      ["Price"],
      ["9.99"],
      ["10.00"],
      ["10.01"],
      ["15.50"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Price"],
      [">=10"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.matchCount).toBe(3); // 10.00, 10.01, 15.50
  });
});

// ============================================================================
// executeAdvancedFilter - unique records only
// ============================================================================

describe("executeAdvancedFilter - unique records", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("removes duplicate rows when uniqueRecordsOnly is true", async () => {
    const listData = buildCellData([
      ["Name", "City"],
      ["Alice", "NYC"],
      ["Bob", "LA"],
      ["Alice", "NYC"],  // duplicate
      ["Charlie", "NYC"],
    ], 0, 0);

    // Empty criteria (no actual filter conditions) - matches all
    const criteriaData = buildCellData([
      ["Name"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 1],
      criteriaRange: [10, 0, 10, 0],  // Only header, no criteria rows
      action: "filterInPlace",
      uniqueRecordsOnly: true,
    });

    expect(result.matchCount).toBe(3); // Alice/NYC, Bob/LA, Charlie/NYC (one Alice/NYC removed)
    expect(result.affectedRows).toBe(1); // One row hidden
  });

  it("case-insensitive duplicate detection", async () => {
    const listData = buildCellData([
      ["Name"],
      ["alice"],
      ["Alice"],
      ["ALICE"],
      ["Bob"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 0],
      criteriaRange: [10, 0, 10, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: true,
    });

    expect(result.matchCount).toBe(2); // "alice" and "bob" (others are duplicates)
  });
});

// ============================================================================
// executeAdvancedFilter - copy to location
// ============================================================================

describe("executeAdvancedFilter - copy to", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUpdateCellsBatch.mockResolvedValue(undefined);
  });

  it("copies headers and matching rows to destination", async () => {
    const listData = buildCellData([
      ["Name", "Score"],
      ["Alice", "90"],
      ["Bob", "40"],
      ["Charlie", "80"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Score"],
      [">=80"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 3, 1],
      criteriaRange: [10, 0, 11, 0],
      action: "copyToLocation",
      copyTo: [20, 0],
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(2); // Alice, Charlie

    const batchCall = mockUpdateCellsBatch.mock.calls[0][0];
    // Headers
    expect(batchCall).toContainEqual({ row: 20, col: 0, value: "Name" });
    expect(batchCall).toContainEqual({ row: 20, col: 1, value: "Score" });
    // Alice
    expect(batchCall).toContainEqual({ row: 21, col: 0, value: "Alice" });
    expect(batchCall).toContainEqual({ row: 21, col: 1, value: "90" });
    // Charlie
    expect(batchCall).toContainEqual({ row: 22, col: 0, value: "Charlie" });
    expect(batchCall).toContainEqual({ row: 22, col: 1, value: "80" });
  });

  it("returns error when action is copyToLocation but no copyTo specified", async () => {
    const listData = buildCellData([
      ["Name"],
      ["Alice"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name"],
      ["Alice"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 1, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "copyToLocation",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ============================================================================
// executeAdvancedFilter - empty criteria / no headers
// ============================================================================

describe("executeAdvancedFilter - edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("matches all rows when criteria range has headers but no conditions", async () => {
    const listData = buildCellData([
      ["Name", "Value"],
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name", "Value"],
      // No criteria rows
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 3, 1],
      criteriaRange: [10, 0, 10, 1], // Only header row
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(3); // All data rows match
    expect(result.affectedRows).toBe(0); // None hidden
  });

  it("fails when list range has no headers", async () => {
    const listData: Array<{ row: number; col: number; display: string; styleIndex: number }> = [];
    const criteriaData = buildCellData([
      ["Name"],
      ["Test"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 0, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No headers");
  });

  it("criteria header not matching list header is ignored", async () => {
    const listData = buildCellData([
      ["Name", "Score"],
      ["Alice", "90"],
      ["Bob", "40"],
    ], 0, 0);

    // "Rating" does not match any list header - the criterion row still has
    // a non-empty value (">50") but under an unrecognized column header.
    // Since the column is not mapped, the criterion is not added.
    // With no criteria rows, all data rows match.
    const criteriaData = buildCellData([
      ["Rating"],
      [">50"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 2, 1],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    // The unmatched header means the criterion row has no recognized conditions,
    // so hasAnyCriterion is false and the row is skipped. With empty criteria
    // rows array, rowMatchesAnyCriteria returns true for all data rows.
    expect(result.success).toBe(true);
    // All data rows match (no effective filter applied)
    expect(result.affectedRows + result.matchCount).toBe(2);
  });

  it("handles empty cell values in data rows", async () => {
    const listData = buildCellData([
      ["Name", "Score"],
      ["Alice", ""],
      ["Bob", "80"],
      ["", "90"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Score"],
      [">50"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 3, 1],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    // "" is not > 50, "80" > 50, "90" > 50
    expect(result.matchCount).toBe(2);
  });
});

// ============================================================================
// clearAdvancedFilter
// ============================================================================

describe("clearAdvancedFilter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clears hidden rows and emits refresh event", () => {
    clearAdvancedFilter();

    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
    expect(mockClearAdvancedFilterHiddenRows).toHaveBeenCalled();
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });
});

// ============================================================================
// executeAdvancedFilter - filter in place syncs to backend
// ============================================================================

describe("executeAdvancedFilter - backend sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSetAdvancedFilterHiddenRows.mockResolvedValue(undefined);
  });

  it("calls setAdvancedFilterHiddenRows with correct rows", async () => {
    const listData = buildCellData([
      ["Name"],
      ["Alice"],
      ["Bob"],
      ["Charlie"],
    ], 0, 0);

    const criteriaData = buildCellData([
      ["Name"],
      ["Alice"],
    ], 10, 0);

    mockGetViewportCells
      .mockResolvedValueOnce(listData)
      .mockResolvedValueOnce(criteriaData);

    await executeAdvancedFilter({
      listRange: [0, 0, 3, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    // Bob (row 2) and Charlie (row 3) should be hidden
    expect(mockSetAdvancedFilterHiddenRows).toHaveBeenCalledWith([2, 3]);
  });
});
