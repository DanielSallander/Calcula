import { describe, it, expect } from "vitest";
import {
  cellToReference,
  rangeToReference,
  columnToReference,
  rowToReference,
  formatSheetName,
  columnRangeToReference,
  rowRangeToReference,
} from "./conversion";
import { columnToLetter, letterToColumn } from "../../../types";

// =============================================================================
// 1. rangeToReference - 40 parameterized cases
// =============================================================================

describe("rangeToReference - parameterized", () => {
  describe("single-cell ranges (collapse to cell ref)", () => {
    it.each([
      [0, 0, 0, 0, null, null, "A1"],
      [0, 1, 0, 1, null, null, "B1"],
      [9, 9, 9, 9, null, null, "J10"],
      [0, 25, 0, 25, null, null, "Z1"],
      [0, 26, 0, 26, null, null, "AA1"],
      [1048575, 0, 1048575, 0, null, null, "A1048576"],
    ] as [number, number, number, number, string | null, string | null, string][])(
      "rangeToReference(%i,%i,%i,%i) => %s",
      (sR, sC, eR, eC, target, current, expected) => {
        expect(rangeToReference(sR, sC, eR, eC, target, current)).toBe(expected);
      },
    );
  });

  describe("multi-cell ranges", () => {
    it.each([
      [0, 0, 1, 1, null, null, "A1:B2"],
      [0, 0, 99, 25, null, null, "A1:Z100"],
      [2, 1, 6, 3, null, null, "B3:D7"],
      [0, 0, 9, 9, null, null, "A1:J10"],
      [10, 10, 20, 20, null, null, "K11:U21"],
      [0, 26, 49, 51, null, null, "AA1:AZ50"],
      [4, 2, 8, 5, null, null, "C5:F9"],
      [0, 0, 0, 5, null, null, "A1:F1"],
      [0, 0, 5, 0, null, null, "A1:A6"],
    ] as [number, number, number, number, string | null, string | null, string][])(
      "rangeToReference(%i,%i,%i,%i) => %s",
      (sR, sC, eR, eC, target, current, expected) => {
        expect(rangeToReference(sR, sC, eR, eC, target, current)).toBe(expected);
      },
    );
  });

  describe("reversed coordinates (normalized)", () => {
    it.each([
      [1, 1, 0, 0, null, null, "A1:B2"],
      [6, 3, 2, 1, null, null, "B3:D7"],
      [9, 9, 0, 0, null, null, "A1:J10"],
      [20, 20, 10, 10, null, null, "K11:U21"],
      [5, 0, 0, 5, null, null, "A1:F6"],
    ] as [number, number, number, number, string | null, string | null, string][])(
      "reversed rangeToReference(%i,%i,%i,%i) => %s",
      (sR, sC, eR, eC, target, current, expected) => {
        expect(rangeToReference(sR, sC, eR, eC, target, current)).toBe(expected);
      },
    );
  });

  describe("with sheet prefixes", () => {
    it.each([
      [0, 0, 1, 1, "Sheet1", null, "Sheet1!A1:B2"],
      [0, 0, 0, 0, "Sheet1", null, "Sheet1!A1"],
      [0, 0, 1, 1, "Sheet1", "Sheet1", "A1:B2"], // same sheet, no prefix
      [0, 0, 1, 1, "Sheet1", "Sheet2", "Sheet1!A1:B2"],
      [0, 0, 1, 1, "My Sheet", null, "'My Sheet'!A1:B2"],
      [2, 1, 6, 3, "Data", null, "Data!B3:D7"],
      [0, 0, 0, 0, null, "Sheet1", "A1"], // no target sheet
      [0, 0, 0, 0, null, null, "A1"],
      [0, 0, 9, 9, "Q1 2024", null, "'Q1 2024'!A1:J10"],
      [5, 5, 5, 5, "Summary", "Other", "Summary!F6"],
    ] as [number, number, number, number, string | null, string | null, string][])(
      "rangeToReference(%i,%i,%i,%i, %s, %s) => %s",
      (sR, sC, eR, eC, target, current, expected) => {
        expect(rangeToReference(sR, sC, eR, eC, target, current)).toBe(expected);
      },
    );
  });
});

// =============================================================================
// 2. cellToReference - 50 parameterized cases
// =============================================================================

describe("cellToReference - parameterized", () => {
  describe("basic cell references", () => {
    it.each([
      [0, 0, "A1"],
      [0, 1, "B1"],
      [0, 25, "Z1"],
      [0, 26, "AA1"],
      [0, 51, "AZ1"],
      [0, 52, "BA1"],
      [0, 701, "ZZ1"],
      [0, 702, "AAA1"],
      [1, 0, "A2"],
      [9, 9, "J10"],
      [99, 0, "A100"],
      [999, 2, "C1000"],
      [1048575, 0, "A1048576"],
      [0, letterToColumn("XFD"), "XFD1"],
      [5, 5, "F6"],
      [14, 25, "Z15"],
      [49, 12, "M50"],
      [0, 17, "R1"],
      [3, 3, "D4"],
      [7, 7, "H8"],
    ] as [number, number, string][])(
      "cellToReference(%i, %i) => %s",
      (row, col, expected) => {
        expect(cellToReference(row, col)).toBe(expected);
      },
    );
  });

  describe("with sheet prefix", () => {
    it.each([
      [0, 0, "Sheet1", null, "Sheet1!A1"],
      [0, 0, "Sheet1", "Sheet1", "A1"], // same sheet
      [0, 0, "Sheet1", "Sheet2", "Sheet1!A1"],
      [5, 5, "Data", null, "Data!F6"],
      [0, 0, "My Sheet", null, "'My Sheet'!A1"],
      [0, 0, "Q1 2024", null, "'Q1 2024'!A1"],
      [9, 9, "Summary", "Other", "Summary!J10"],
      [0, 0, null, "Sheet1", "A1"],
      [0, 0, null, null, "A1"],
      [0, 26, "Sheet1", null, "Sheet1!AA1"],
    ] as [number, number, string | null, string | null, string][])(
      "cellToReference(%i, %i, %s, %s) => %s",
      (row, col, target, current, expected) => {
        expect(cellToReference(row, col, target, current)).toBe(expected);
      },
    );
  });

  describe("round-trip with columnToLetter", () => {
    it.each(
      Array.from({ length: 20 }, (_, i) => {
        const col = i * 37; // spread across column space
        return [0, col, columnToLetter(col) + "1"] as [number, number, string];
      }),
    )(
      "cellToReference(0, %i) => %s",
      (row, col, expected) => {
        expect(cellToReference(row, col)).toBe(expected);
      },
    );
  });
});

// =============================================================================
// 3. columnToReference - 30 parameterized cases
// =============================================================================

describe("columnToReference - parameterized", () => {
  it.each([
    [0, null, null, "A:A"],
    [1, null, null, "B:B"],
    [2, null, null, "C:C"],
    [25, null, null, "Z:Z"],
    [26, null, null, "AA:AA"],
    [27, null, null, "AB:AB"],
    [51, null, null, "AZ:AZ"],
    [52, null, null, "BA:BA"],
    [701, null, null, "ZZ:ZZ"],
    [702, null, null, "AAA:AAA"],
    [letterToColumn("XFD"), null, null, "XFD:XFD"],
    [0, "Sheet1", null, "Sheet1!A:A"],
    [0, "Sheet1", "Sheet1", "A:A"],
    [0, "Sheet1", "Sheet2", "Sheet1!A:A"],
    [0, "My Sheet", null, "'My Sheet'!A:A"],
    [5, "Data", null, "Data!F:F"],
    [25, "Summary", "Other", "Summary!Z:Z"],
    [26, "Q1 2024", null, "'Q1 2024'!AA:AA"],
    [3, null, null, "D:D"],
    [9, null, null, "J:J"],
    [10, null, null, "K:K"],
    [15, null, null, "P:P"],
    [17, null, null, "R:R"],
    [19, null, null, "T:T"],
    [20, null, null, "U:U"],
    [100, null, null, columnToLetter(100) + ":" + columnToLetter(100)],
    [200, null, null, columnToLetter(200) + ":" + columnToLetter(200)],
    [500, null, null, columnToLetter(500) + ":" + columnToLetter(500)],
    [1000, null, null, columnToLetter(1000) + ":" + columnToLetter(1000)],
    [16383, null, null, "XFD:XFD"],
  ] as [number, string | null, string | null, string][])(
    "columnToReference(%i, %s, %s) => %s",
    (col, target, current, expected) => {
      expect(columnToReference(col, target, current)).toBe(expected);
    },
  );
});

// =============================================================================
// 4. rowToReference - 30 parameterized cases
// =============================================================================

describe("rowToReference - parameterized", () => {
  it.each([
    [0, null, null, "1:1"],
    [1, null, null, "2:2"],
    [2, null, null, "3:3"],
    [9, null, null, "10:10"],
    [99, null, null, "100:100"],
    [999, null, null, "1000:1000"],
    [1048575, null, null, "1048576:1048576"],
    [49, null, null, "50:50"],
    [4, null, null, "5:5"],
    [14, null, null, "15:15"],
    [24, null, null, "25:25"],
    [0, "Sheet1", null, "Sheet1!1:1"],
    [0, "Sheet1", "Sheet1", "1:1"],
    [0, "Sheet1", "Sheet2", "Sheet1!1:1"],
    [0, "My Sheet", null, "'My Sheet'!1:1"],
    [5, "Data", null, "Data!6:6"],
    [9, "Summary", "Other", "Summary!10:10"],
    [0, "Q1 2024", null, "'Q1 2024'!1:1"],
    [19, null, null, "20:20"],
    [29, null, null, "30:30"],
    [39, null, null, "40:40"],
    [59, null, null, "60:60"],
    [79, null, null, "80:80"],
    [149, null, null, "150:150"],
    [199, null, null, "200:200"],
    [499, null, null, "500:500"],
    [9999, null, null, "10000:10000"],
    [99999, null, null, "100000:100000"],
    [249, null, null, "250:250"],
    [74, null, null, "75:75"],
  ] as [number, string | null, string | null, string][])(
    "rowToReference(%i, %s, %s) => %s",
    (row, target, current, expected) => {
      expect(rowToReference(row, target, current)).toBe(expected);
    },
  );
});

// =============================================================================
// 5. formatSheetName - 30 parameterized cases
// =============================================================================

describe("formatSheetName - parameterized", () => {
  it.each([
    // Plain names - no quoting needed
    ["Sheet1", "Sheet1"],
    ["Data", "Data"],
    ["Summary", "Summary"],
    ["MySheet", "MySheet"],
    ["ABC", "ABC"],
    ["Test_Sheet", "Test_Sheet"],
    ["a", "a"],
    ["Sheet123", "Sheet123"],
    // Names needing quoting - spaces
    ["My Sheet", "'My Sheet'"],
    ["Sheet 1", "'Sheet 1'"],
    ["Q1 2024", "'Q1 2024'"],
    ["Hello World", "'Hello World'"],
    // Names needing quoting - starts with digit
    ["1Sheet", "'1Sheet'"],
    ["2024Q1", "'2024Q1'"],
    ["123", "'123'"],
    ["0Data", "'0Data'"],
    // Names needing quoting - special characters
    ["Sheet!1", "'Sheet!1'"],
    ["My[Sheet]", "'My[Sheet]'"],
    ["Sheet'Name", "'Sheet''Name'"], // single quotes doubled
    ["It's", "'It''s'"],
    ["Can't Stop", "'Can''t Stop'"],
    // Names with multiple special chars
    ["A B!C", "'A B!C'"],
    ["[Data]", "'[Data]'"],
    ["Tab\tName", "'Tab\tName'"], // tab is whitespace
    // Edge cases
    ["A", "A"],
    ["Z", "Z"],
    ["ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOP"],
    ["Sheet_With_Underscores", "Sheet_With_Underscores"],
    ["MixedCase", "MixedCase"],
    ["x", "x"],
  ] as [string, string][])(
    "formatSheetName(%s) => %s",
    (input, expected) => {
      expect(formatSheetName(input)).toBe(expected);
    },
  );
});

// =============================================================================
// 6. columnRangeToReference - parameterized
// =============================================================================

describe("columnRangeToReference - parameterized", () => {
  it.each([
    [0, 0, null, null, "A:A"],
    [0, 2, null, null, "A:C"],
    [0, 25, null, null, "A:Z"],
    [0, 26, null, null, "A:AA"],
    [26, 51, null, null, "AA:AZ"],
    [5, 5, null, null, "F:F"],
    [3, 1, null, null, "B:D"], // reversed
    [0, 2, "Sheet1", null, "Sheet1!A:C"],
    [0, 2, "Sheet1", "Sheet1", "A:C"],
    [0, 2, "My Sheet", null, "'My Sheet'!A:C"],
  ] as [number, number, string | null, string | null, string][])(
    "columnRangeToReference(%i, %i, %s, %s) => %s",
    (startCol, endCol, target, current, expected) => {
      expect(columnRangeToReference(startCol, endCol, target, current)).toBe(expected);
    },
  );
});

// =============================================================================
// 7. rowRangeToReference - parameterized
// =============================================================================

describe("rowRangeToReference - parameterized", () => {
  it.each([
    [0, 0, null, null, "1:1"],
    [0, 2, null, null, "1:3"],
    [0, 99, null, null, "1:100"],
    [5, 5, null, null, "6:6"],
    [9, 0, null, null, "1:10"], // reversed
    [0, 2, "Sheet1", null, "Sheet1!1:3"],
    [0, 2, "Sheet1", "Sheet1", "1:3"],
    [0, 2, "My Sheet", null, "'My Sheet'!1:3"],
    [49, 99, null, null, "50:100"],
    [999, 1048575, null, null, "1000:1048576"],
  ] as [number, number, string | null, string | null, string][])(
    "rowRangeToReference(%i, %i, %s, %s) => %s",
    (startRow, endRow, target, current, expected) => {
      expect(rowRangeToReference(startRow, endRow, target, current)).toBe(expected);
    },
  );
});
