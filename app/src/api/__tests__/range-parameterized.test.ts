import { describe, it, expect } from "vitest";
import { CellRange } from "../range";
import { columnToLetter, letterToColumn } from "../types";

// =============================================================================
// 1. CellRange.fromAddress - 80 parameterized cases
// =============================================================================

describe("CellRange.fromAddress - parameterized", () => {
  // -------------------------------------------------------------------------
  // Single cells: A-Z row 1
  // -------------------------------------------------------------------------
  describe("single cells A1-Z1", () => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    it.each(
      letters.map((l, i) => [l + "1", 0, i] as const),
    )("parses %s to row=0, col=%i", (addr, expectedRow, expectedCol) => {
      const r = CellRange.fromAddress(addr);
      expect(r.startRow).toBe(expectedRow);
      expect(r.startCol).toBe(expectedCol);
      expect(r.isSingleCell).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Single cells: A1-A100 (various rows)
  // -------------------------------------------------------------------------
  describe("single cells A1-A100 (row variation)", () => {
    const rows = [1, 2, 5, 10, 25, 50, 99, 100];
    it.each(rows.map((r) => [`A${r}`, r - 1, 0] as const))(
      "parses %s to row=%i, col=0",
      (addr, expectedRow, expectedCol) => {
        const r = CellRange.fromAddress(addr);
        expect(r.startRow).toBe(expectedRow);
        expect(r.startCol).toBe(expectedCol);
        expect(r.isSingleCell).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Multi-letter columns
  // -------------------------------------------------------------------------
  describe("multi-letter columns", () => {
    it.each([
      ["AA1", 0, letterToColumn("AA")],
      ["AZ1", 0, letterToColumn("AZ")],
      ["BA1", 0, letterToColumn("BA")],
      ["ZZ1", 0, letterToColumn("ZZ")],
      ["AAA1", 0, letterToColumn("AAA")],
      ["XFD1", 0, letterToColumn("XFD")],
      ["AB10", 9, letterToColumn("AB")],
      ["CD200", 199, letterToColumn("CD")],
    ])("parses %s to row=%i, col=%i", (addr, expectedRow, expectedCol) => {
      const r = CellRange.fromAddress(addr);
      expect(r.startRow).toBe(expectedRow);
      expect(r.startCol).toBe(expectedCol);
      expect(r.isSingleCell).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Range addresses
  // -------------------------------------------------------------------------
  describe("range addresses", () => {
    it.each([
      ["A1:B2", 0, 0, 1, 1],
      ["A1:Z100", 0, 0, 99, 25],
      ["B3:D7", 2, 1, 6, 3],
      ["AA1:AZ50", 0, letterToColumn("AA"), 49, letterToColumn("AZ")],
      ["XFD1:XFD1048576", 0, letterToColumn("XFD"), 1048575, letterToColumn("XFD")],
      ["C5:C5", 4, 2, 4, 2],
      ["A1:A1", 0, 0, 0, 0],
      ["Z1:A1", 0, 0, 0, 25], // reversed cols normalized
      ["A10:A1", 0, 0, 9, 0], // reversed rows normalized
      ["D3:B1", 0, 1, 2, 3], // both reversed
    ] as [string, number, number, number, number][])(
      "parses %s to (%i,%i):(%i,%i)",
      (addr, sR, sC, eR, eC) => {
        const r = CellRange.fromAddress(addr);
        expect(r.startRow).toBe(sR);
        expect(r.startCol).toBe(sC);
        expect(r.endRow).toBe(eR);
        expect(r.endCol).toBe(eC);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Sheet-qualified addresses
  // -------------------------------------------------------------------------
  describe("sheet-qualified addresses", () => {
    it.each([
      ["Sheet1!A1", 0, 0, 0, 0],
      ["Sheet1!B5", 4, 1, 4, 1],
      ["Sheet1!A1:B5", 0, 0, 4, 1],
      ["'My Sheet'!A1:B5", 0, 0, 4, 1],
      ["'Sheet With Spaces'!C3", 2, 2, 2, 2],
      ["Data!AA1:AZ50", 0, letterToColumn("AA"), 49, letterToColumn("AZ")],
      ["'Q1 2024'!A1", 0, 0, 0, 0],
      ["Summary!Z100", 99, 25, 99, 25],
    ] as [string, number, number, number, number][])(
      "parses %s (sheet ignored in range coords)",
      (addr, sR, sC, eR, eC) => {
        const r = CellRange.fromAddress(addr);
        expect(r.startRow).toBe(sR);
        expect(r.startCol).toBe(sC);
        expect(r.endRow).toBe(eR);
        expect(r.endCol).toBe(eC);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Absolute references ($ signs stripped)
  // -------------------------------------------------------------------------
  describe("absolute references", () => {
    it.each([
      ["$A$1", 0, 0, 0, 0],
      ["A$1", 0, 0, 0, 0],
      ["$A1", 0, 0, 0, 0],
      ["$A$1:$B$5", 0, 0, 4, 1],
      ["$C$3:D7", 2, 2, 6, 3],
      ["A$1:$B5", 0, 0, 4, 1],
      ["Sheet1!$A$1", 0, 0, 0, 0],
      ["'My Sheet'!$A$1:$B$5", 0, 0, 4, 1],
      ["$AA$1", 0, letterToColumn("AA"), 0, letterToColumn("AA")],
      ["$XFD$1048576", 1048575, letterToColumn("XFD"), 1048575, letterToColumn("XFD")],
    ] as [string, number, number, number, number][])(
      "parses %s with $ stripped",
      (addr, sR, sC, eR, eC) => {
        const r = CellRange.fromAddress(addr);
        expect(r.startRow).toBe(sR);
        expect(r.startCol).toBe(sC);
        expect(r.endRow).toBe(eR);
        expect(r.endCol).toBe(eC);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Invalid addresses (should throw)
  // -------------------------------------------------------------------------
  describe("invalid addresses", () => {
    it.each([
      ["", "empty string"],
      ["A", "letter only"],
      ["1", "number only"],
      ["A:B", "column-only range"],
      ["1:5", "row-only range"],
      ["!", "just bang"],
      ["Sheet1!", "sheet with no ref"],
      ["A1:B", "partial range (missing row)"],
      [":A1", "leading colon"],
      ["A1:", "trailing colon"],
      ["A1:B:C", "too many colons"],
      ["@#$", "special characters only"],
    ])("throws for %s (%s)", (addr) => {
      expect(() => CellRange.fromAddress(addr)).toThrow();
    });
  });
});

// =============================================================================
// 2. CellRange methods - 60 parameterized cases
// =============================================================================

describe("CellRange.contains - parameterized", () => {
  const range = new CellRange(2, 3, 8, 10); // rows 2-8, cols 3-10

  it.each([
    // Inside
    [2, 3, true, "top-left corner"],
    [8, 10, true, "bottom-right corner"],
    [2, 10, true, "top-right corner"],
    [8, 3, true, "bottom-left corner"],
    [5, 6, true, "center"],
    [2, 5, true, "top edge mid"],
    [8, 5, true, "bottom edge mid"],
    [5, 3, true, "left edge mid"],
    [5, 10, true, "right edge mid"],
    [3, 4, true, "arbitrary inside"],
    // Outside
    [1, 3, false, "above top-left"],
    [9, 10, false, "below bottom-right"],
    [2, 2, false, "left of range"],
    [2, 11, false, "right of range"],
    [0, 0, false, "origin"],
    [1, 2, false, "diagonal above-left"],
    [9, 11, false, "diagonal below-right"],
    [100, 100, false, "far away"],
    [5, 0, false, "correct row wrong col"],
    [0, 6, false, "correct col wrong row"],
  ] as [number, number, boolean, string][])(
    "(%i, %i) => %s (%s)",
    (row, col, expected) => {
      expect(range.contains(row, col)).toBe(expected);
    },
  );
});

describe("CellRange.intersects - parameterized", () => {
  const base = new CellRange(5, 5, 10, 10);

  it.each([
    // Overlapping
    [new CellRange(5, 5, 10, 10), true, "identical"],
    [new CellRange(0, 0, 5, 5), true, "touches top-left corner"],
    [new CellRange(10, 10, 15, 15), true, "touches bottom-right corner"],
    [new CellRange(7, 7, 8, 8), true, "fully inside"],
    [new CellRange(0, 0, 20, 20), true, "fully contains base"],
    [new CellRange(3, 3, 7, 7), true, "overlaps top-left"],
    [new CellRange(8, 8, 12, 12), true, "overlaps bottom-right"],
    [new CellRange(5, 0, 10, 20), true, "same rows wider cols"],
    [new CellRange(0, 5, 20, 10), true, "same cols wider rows"],
    [new CellRange(5, 10, 10, 15), true, "shares right edge"],
    // Non-overlapping
    [new CellRange(0, 0, 4, 4), false, "fully above-left"],
    [new CellRange(11, 11, 15, 15), false, "fully below-right"],
    [new CellRange(0, 0, 4, 10), false, "above"],
    [new CellRange(11, 0, 15, 10), false, "below"],
    [new CellRange(5, 11, 10, 15), false, "to the right"],
    [new CellRange(5, 0, 10, 4), false, "to the left"],
    [new CellRange(0, 11, 4, 15), false, "above-right"],
    [new CellRange(11, 0, 15, 4), false, "below-left"],
    [new CellRange(0, 0, 0, 0), false, "single cell far away"],
    [new CellRange(100, 100, 200, 200), false, "very far away"],
  ] as [CellRange, boolean, string][])(
    "vs %s => %s (%s)",
    (other, expected) => {
      expect(base.intersects(other)).toBe(expected);
    },
  );
});

describe("CellRange.intersection - parameterized", () => {
  const base = new CellRange(5, 5, 10, 10);

  // Overlapping pairs - should return intersection
  describe("overlapping pairs", () => {
    it.each([
      [new CellRange(5, 5, 10, 10), new CellRange(5, 5, 10, 10), "identical"],
      [new CellRange(0, 0, 7, 7), new CellRange(5, 5, 7, 7), "top-left overlap"],
      [new CellRange(8, 8, 15, 15), new CellRange(8, 8, 10, 10), "bottom-right overlap"],
      [new CellRange(7, 7, 8, 8), new CellRange(7, 7, 8, 8), "fully inside"],
      [new CellRange(0, 0, 20, 20), new CellRange(5, 5, 10, 10), "fully contains"],
      [new CellRange(0, 5, 7, 10), new CellRange(5, 5, 7, 10), "top overlap same cols"],
      [new CellRange(5, 0, 10, 7), new CellRange(5, 5, 10, 7), "left overlap same rows"],
      [new CellRange(10, 10, 15, 15), new CellRange(10, 10, 10, 10), "single corner cell"],
      [new CellRange(5, 10, 10, 15), new CellRange(5, 10, 10, 10), "right edge"],
      [new CellRange(3, 6, 12, 9), new CellRange(5, 6, 10, 9), "vertical strip overlap"],
    ] as [CellRange, CellRange, string][])(
      "base & %s => %s (%s)",
      (other, expectedRange) => {
        const result = base.intersection(other);
        expect(result).not.toBeNull();
        expect(result!.startRow).toBe(expectedRange.startRow);
        expect(result!.startCol).toBe(expectedRange.startCol);
        expect(result!.endRow).toBe(expectedRange.endRow);
        expect(result!.endCol).toBe(expectedRange.endCol);
      },
    );
  });

  // Non-overlapping pairs - should return null
  describe("non-overlapping pairs", () => {
    it.each([
      [new CellRange(0, 0, 4, 4), "fully above-left"],
      [new CellRange(11, 11, 15, 15), "fully below-right"],
      [new CellRange(0, 0, 4, 10), "above"],
      [new CellRange(11, 5, 15, 10), "below"],
      [new CellRange(5, 11, 10, 15), "right"],
      [new CellRange(5, 0, 10, 4), "left"],
      [new CellRange(0, 0, 0, 0), "far origin"],
      [new CellRange(11, 0, 15, 4), "below-left"],
      [new CellRange(0, 11, 4, 15), "above-right"],
      [new CellRange(100, 100, 200, 200), "very far"],
    ] as [CellRange, string][])(
      "base & %s => null (%s)",
      (other) => {
        expect(base.intersection(other)).toBeNull();
      },
    );
  });
});

// =============================================================================
// 3. CellRange.address round-trip - 50 cases
// =============================================================================

describe("CellRange.address round-trip - parameterized", () => {
  describe("single cell round-trips", () => {
    it.each([
      [0, 0, "A1"],
      [0, 1, "B1"],
      [0, 25, "Z1"],
      [0, 26, "AA1"],
      [0, 51, "AZ1"],
      [0, 52, "BA1"],
      [0, 701, "ZZ1"],
      [0, 702, "AAA1"],
      [0, letterToColumn("XFD"), "XFD1"],
      [99, 0, "A100"],
      [999, 0, "A1000"],
      [1048575, 0, "A1048576"],
      [5, 5, "F6"],
      [9, 9, "J10"],
      [0, 2, "C1"],
      [3, 3, "D4"],
      [49, 12, "M50"],
      [0, 17, "R1"],
      [14, 25, "Z15"],
      [0, 100, columnToLetter(100) + "1"],
    ] as [number, number, string][])(
      "CellRange.fromCell(%i, %i).address === %s",
      (row, col, expected) => {
        const r = CellRange.fromCell(row, col);
        expect(r.address).toBe(expected);
      },
    );
  });

  describe("range address round-trips", () => {
    it.each([
      [0, 0, 1, 1, "A1:B2"],
      [0, 0, 99, 25, "A1:Z100"],
      [0, 0, 0, 0, "A1"], // single cell collapses
      [2, 1, 6, 3, "B3:D7"],
      [0, 0, 9, 9, "A1:J10"],
      [4, 2, 4, 2, "C5"], // single cell
      [0, 26, 49, 51, "AA1:AZ50"],
      [0, 0, 1048575, letterToColumn("XFD"), "A1:XFD1048576"],
      [10, 10, 20, 20, "K11:U21"],
      [99, 99, 199, 199, columnToLetter(99) + "100:" + columnToLetter(199) + "200"],
    ] as [number, number, number, number, string][])(
      "CellRange(%i,%i,%i,%i).address === %s",
      (sR, sC, eR, eC, expected) => {
        const r = new CellRange(sR, sC, eR, eC);
        expect(r.address).toBe(expected);
      },
    );
  });

  describe("fromAddress -> address round-trip", () => {
    it.each([
      "A1",
      "B2",
      "Z1",
      "AA1",
      "AZ50",
      "A1:B2",
      "A1:Z100",
      "C5:D7",
      "AA1:AZ50",
      "K11:U21",
      "A1:A1",
      "XFD1",
      "A1048576",
      "B3:D7",
      "J10:J10",
      "M50",
      "R1",
      "Z15",
      "F6",
      "D4",
    ])("fromAddress(%s).address === %s", (addr) => {
      // Single-cell ranges like "A1:A1" collapse to "A1"
      const r = CellRange.fromAddress(addr);
      const result = r.address;
      // Re-parse to confirm structural equality
      const r2 = CellRange.fromAddress(result);
      expect(r.equals(r2)).toBe(true);
    });
  });
});

// =============================================================================
// 4. CellRange properties - parameterized
// =============================================================================

describe("CellRange properties - parameterized", () => {
  it.each([
    [0, 0, 0, 0, 1, 1, 1, true],
    [0, 0, 9, 9, 10, 10, 100, false],
    [5, 3, 5, 3, 1, 1, 1, true],
    [0, 0, 99, 25, 100, 26, 2600, false],
    [0, 0, 0, 5, 1, 6, 6, false],
    [0, 0, 5, 0, 6, 1, 6, false],
    [10, 10, 19, 14, 10, 5, 50, false],
    [0, 0, 1048575, 16383, 1048576, 16384, 1048576 * 16384, false],
  ] as [number, number, number, number, number, number, number, boolean][])(
    "CellRange(%i,%i,%i,%i) => rows=%i, cols=%i, cells=%i, single=%s",
    (sR, sC, eR, eC, rows, cols, cells, single) => {
      const r = new CellRange(sR, sC, eR, eC);
      expect(r.rowCount).toBe(rows);
      expect(r.colCount).toBe(cols);
      expect(r.cellCount).toBe(cells);
      expect(r.isSingleCell).toBe(single);
    },
  );
});

// =============================================================================
// 5. CellRange.offset & resize - parameterized
// =============================================================================

describe("CellRange.offset - parameterized", () => {
  it.each([
    [0, 0, 5, 5, 1, 1, 1, 1, 6, 6],
    [0, 0, 0, 0, 10, 10, 10, 10, 10, 10],
    [5, 5, 10, 10, -5, -5, 0, 0, 5, 5],
    [0, 0, 9, 9, 0, 0, 0, 0, 9, 9],
    [3, 3, 7, 7, 2, 3, 5, 6, 9, 10],
  ] as [number, number, number, number, number, number, number, number, number, number][])(
    "CellRange(%i,%i,%i,%i).offset(%i,%i) => (%i,%i,%i,%i)",
    (sR, sC, eR, eC, rOff, cOff, exSR, exSC, exER, exEC) => {
      const r = new CellRange(sR, sC, eR, eC).offset(rOff, cOff);
      expect(r.startRow).toBe(exSR);
      expect(r.startCol).toBe(exSC);
      expect(r.endRow).toBe(exER);
      expect(r.endCol).toBe(exEC);
    },
  );
});

describe("CellRange.resize - parameterized", () => {
  it.each([
    [0, 0, 5, 5, 3, 3, 0, 0, 2, 2],
    [5, 5, 10, 10, 1, 1, 5, 5, 5, 5],
    [0, 0, 0, 0, 10, 10, 0, 0, 9, 9],
    [2, 3, 8, 10, 5, 4, 2, 3, 6, 6],
  ] as [number, number, number, number, number, number, number, number, number, number][])(
    "CellRange(%i,%i,%i,%i).resize(%i,%i) => (%i,%i,%i,%i)",
    (sR, sC, eR, eC, rows, cols, exSR, exSC, exER, exEC) => {
      const r = new CellRange(sR, sC, eR, eC).resize(rows, cols);
      expect(r.startRow).toBe(exSR);
      expect(r.startCol).toBe(exSC);
      expect(r.endRow).toBe(exER);
      expect(r.endCol).toBe(exEC);
    },
  );
});

// =============================================================================
// 6. CellRange.union - parameterized
// =============================================================================

describe("CellRange.union - parameterized", () => {
  it.each([
    [new CellRange(0, 0, 5, 5), new CellRange(0, 0, 5, 5), new CellRange(0, 0, 5, 5), "identical"],
    [new CellRange(0, 0, 5, 5), new CellRange(3, 3, 10, 10), new CellRange(0, 0, 10, 10), "overlapping"],
    [new CellRange(0, 0, 0, 0), new CellRange(10, 10, 10, 10), new CellRange(0, 0, 10, 10), "two single cells"],
    [new CellRange(5, 5, 10, 10), new CellRange(0, 0, 3, 3), new CellRange(0, 0, 10, 10), "non-overlapping"],
    [new CellRange(0, 0, 5, 5), new CellRange(0, 0, 0, 0), new CellRange(0, 0, 5, 5), "range + contained cell"],
  ] as [CellRange, CellRange, CellRange, string][])(
    "%s union %s => %s (%s)",
    (a, b, expected) => {
      const result = a.union(b);
      expect(result.startRow).toBe(expected.startRow);
      expect(result.startCol).toBe(expected.startCol);
      expect(result.endRow).toBe(expected.endRow);
      expect(result.endCol).toBe(expected.endCol);
    },
  );
});

// =============================================================================
// 7. CellRange.equals - parameterized
// =============================================================================

describe("CellRange.equals - parameterized", () => {
  it.each([
    [new CellRange(0, 0, 0, 0), new CellRange(0, 0, 0, 0), true],
    [new CellRange(0, 0, 5, 5), new CellRange(0, 0, 5, 5), true],
    [new CellRange(0, 0, 5, 5), new CellRange(0, 0, 5, 6), false],
    [new CellRange(0, 0, 5, 5), new CellRange(1, 0, 5, 5), false],
    [new CellRange(1, 2, 3, 4), new CellRange(1, 2, 3, 4), true],
    [new CellRange(1, 2, 3, 4), new CellRange(4, 3, 2, 1), false],
  ] as [CellRange, CellRange, boolean][])(
    "%s.equals(%s) => %s",
    (a, b, expected) => {
      expect(a.equals(b)).toBe(expected);
    },
  );
});
