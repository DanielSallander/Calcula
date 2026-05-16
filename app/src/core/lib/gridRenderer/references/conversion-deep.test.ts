//! FILENAME: app/src/core/lib/gridRenderer/references/conversion-deep.test.ts
// PURPOSE: Deep tests for reference conversion - special chars, boundaries, round-trips, performance

import { describe, it, expect } from "vitest";
import {
  formatSheetName,
  cellToReference,
  rangeToReference,
  columnToReference,
  rowToReference,
} from "./conversion";
import { columnToLetter } from "../../../types";

// ============================================================================
// formatSheetName - all special character cases
// ============================================================================

describe("formatSheetName special characters", () => {
  it("quotes name with tab character", () => {
    expect(formatSheetName("Sheet\t1")).toBe("'Sheet\t1'");
  });

  it("quotes name with exclamation mark mid-string", () => {
    expect(formatSheetName("Hello!World")).toBe("'Hello!World'");
  });

  it("quotes name with opening square bracket", () => {
    expect(formatSheetName("Data[1")).toBe("'Data[1'");
  });

  it("quotes name with closing square bracket", () => {
    expect(formatSheetName("Data]1")).toBe("'Data]1'");
  });

  it("escapes multiple single quotes", () => {
    expect(formatSheetName("it's Bob's")).toBe("'it''s Bob''s'");
  });

  it("does not quote simple alphanumeric names", () => {
    expect(formatSheetName("Sheet1")).toBe("Sheet1");
    expect(formatSheetName("Data")).toBe("Data");
    expect(formatSheetName("MySheet")).toBe("MySheet");
  });

  it("quotes name starting with 0", () => {
    expect(formatSheetName("0abc")).toBe("'0abc'");
  });

  it("quotes name that is entirely digits", () => {
    expect(formatSheetName("123")).toBe("'123'");
  });

  it("handles empty-ish names with only a single quote", () => {
    expect(formatSheetName("'")).toBe("''''");
  });

  it("quotes name with leading space", () => {
    expect(formatSheetName(" Sheet")).toBe("' Sheet'");
  });

  it("quotes name with trailing space", () => {
    expect(formatSheetName("Sheet ")).toBe("'Sheet '");
  });
});

// ============================================================================
// cellToReference - absolute/relative combinations
// ============================================================================

describe("cellToReference absolute/relative combinations", () => {
  // The current implementation does not support $-notation, so we test
  // the standard relative references at key positions

  it("A1 - origin", () => {
    expect(cellToReference(0, 0)).toBe("A1");
  });

  it("Z1 - last single letter column", () => {
    expect(cellToReference(0, 25)).toBe("Z1");
  });

  it("AA1 - first double letter column", () => {
    expect(cellToReference(0, 26)).toBe("AA1");
  });

  it("AZ1 - col 51", () => {
    expect(cellToReference(0, 51)).toBe("AZ1");
  });

  it("BA1 - col 52", () => {
    expect(cellToReference(0, 52)).toBe("BA1");
  });

  it("XFD1 - col 16383 (Excel max)", () => {
    // columnToLetter(16383) should be XFD
    expect(cellToReference(0, 16383)).toBe("XFD1");
  });

  it("A1048576 - row 1048575 (Excel max row 0-based)", () => {
    expect(cellToReference(1048575, 0)).toBe("A1048576");
  });

  it("cross-sheet reference with special sheet name", () => {
    expect(cellToReference(0, 0, "My Sheet", "Sheet1")).toBe("'My Sheet'!A1");
  });
});

// ============================================================================
// rangeToReference - cross-sheet and reversed ranges
// ============================================================================

describe("rangeToReference cross-sheet and reversed", () => {
  it("reversed row and col coordinates normalize", () => {
    expect(rangeToReference(5, 3, 0, 0)).toBe("A1:D6");
  });

  it("reversed cols only", () => {
    expect(rangeToReference(0, 5, 2, 0)).toBe("A1:F3");
  });

  it("reversed rows only", () => {
    expect(rangeToReference(10, 0, 0, 0)).toBe("A1:A11");
  });

  it("cross-sheet range with quoted name", () => {
    expect(rangeToReference(0, 0, 1, 1, "Bob's Data", "Sheet1")).toBe("'Bob''s Data'!A1:B2");
  });

  it("single-cell range with cross-sheet", () => {
    expect(rangeToReference(3, 3, 3, 3, "Other", "Sheet1")).toBe("Other!D4");
  });

  it("large range", () => {
    expect(rangeToReference(0, 0, 999, 25)).toBe("A1:Z1000");
  });
});

// ============================================================================
// columnToReference and rowToReference at boundaries
// ============================================================================

describe("columnToReference at boundaries", () => {
  it("column 0 -> A:A", () => {
    expect(columnToReference(0)).toBe("A:A");
  });

  it("column 25 -> Z:Z", () => {
    expect(columnToReference(25)).toBe("Z:Z");
  });

  it("column 26 -> AA:AA", () => {
    expect(columnToReference(26)).toBe("AA:AA");
  });

  it("column 701 -> ZZ:ZZ", () => {
    expect(columnToReference(701)).toBe("ZZ:ZZ");
  });

  it("column 702 -> AAA:AAA", () => {
    expect(columnToReference(702)).toBe("AAA:AAA");
  });

  it("cross-sheet column reference", () => {
    expect(columnToReference(0, "Data", "Sheet1")).toBe("Data!A:A");
  });
});

describe("rowToReference at boundaries", () => {
  it("row 0 -> 1:1", () => {
    expect(rowToReference(0)).toBe("1:1");
  });

  it("row 999 -> 1000:1000", () => {
    expect(rowToReference(999)).toBe("1000:1000");
  });

  it("row 1048575 -> 1048576:1048576", () => {
    expect(rowToReference(1048575)).toBe("1048576:1048576");
  });

  it("cross-sheet row reference", () => {
    expect(rowToReference(0, "Data", "Sheet1")).toBe("Data!1:1");
  });
});

// ============================================================================
// Round-trip: cellToReference -> parse -> verify coordinates
// ============================================================================

describe("round-trip cellToReference -> manual parse", () => {
  function parseReference(ref: string): { col: string; row: number } {
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) throw new Error(`Cannot parse: ${ref}`);
    return { col: match[1], row: parseInt(match[2], 10) };
  }

  it("round-trips A1 through Z1", () => {
    for (let c = 0; c < 26; c++) {
      const ref = cellToReference(0, c);
      const parsed = parseReference(ref);
      expect(parsed.col).toBe(columnToLetter(c));
      expect(parsed.row).toBe(1);
    }
  });

  it("round-trips AA1 through AZ1", () => {
    for (let c = 26; c < 52; c++) {
      const ref = cellToReference(0, c);
      const parsed = parseReference(ref);
      expect(parsed.col).toBe(columnToLetter(c));
      expect(parsed.row).toBe(1);
    }
  });

  it("round-trips rows 0-99 at column 0", () => {
    for (let r = 0; r < 100; r++) {
      const ref = cellToReference(r, 0);
      const parsed = parseReference(ref);
      expect(parsed.col).toBe("A");
      expect(parsed.row).toBe(r + 1);
    }
  });
});

// ============================================================================
// Performance: 10K references formatted under 200ms
// ============================================================================

describe("performance", () => {
  it("formats 10K cell references under 200ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      cellToReference(i % 1000, i % 100);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("formats 10K range references under 200ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      rangeToReference(i % 500, i % 50, (i % 500) + 10, (i % 50) + 5);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("formats 10K sheet name references under 200ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      formatSheetName(`Sheet ${i}`);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
