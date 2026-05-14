//! FILENAME: app/extensions/ScenarioManager/__tests__/scenarioHelpers.test.ts
// PURPOSE: Tests for Scenario Manager helper functions (cell ref parsing, formatting, range parsing).

import { describe, it, expect } from "vitest";

// The helper functions are defined inside the dialog component.
// We re-implement them here for isolated testing (they are pure functions).
// This also validates the logic independently of React rendering.

// ============================================================================
// Re-export pure helpers (copied from ScenarioManagerDialog.tsx)
// ============================================================================

function parseCellRef(ref: string): { row: number; col: number } | null {
  const cleaned = ref.trim().replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;
  let colIdx = 0;
  for (let i = 0; i < colStr.length; i++) {
    colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: colIdx - 1 };
}

function columnToLetter(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode((c % 26) + 65) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

function parseCellRange(rangeStr: string): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  const parts = rangeStr.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes(":")) {
      const [startRef, endRef] = trimmed.split(":");
      const start = parseCellRef(startRef);
      const end = parseCellRef(endRef);
      if (start && end) {
        for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
          for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
            cells.push({ row: r, col: c });
          }
        }
      }
    } else {
      const cell = parseCellRef(trimmed);
      if (cell) cells.push(cell);
    }
  }
  return cells;
}

// ============================================================================
// parseCellRef
// ============================================================================

describe("parseCellRef", () => {
  it("parses A1", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
  });

  it("parses B2", () => {
    expect(parseCellRef("B2")).toEqual({ row: 1, col: 1 });
  });

  it("parses Z1", () => {
    expect(parseCellRef("Z1")).toEqual({ row: 0, col: 25 });
  });

  it("parses AA1 (column 26)", () => {
    expect(parseCellRef("AA1")).toEqual({ row: 0, col: 26 });
  });

  it("parses lowercase a1", () => {
    expect(parseCellRef("a1")).toEqual({ row: 0, col: 0 });
  });

  it("strips dollar signs from absolute refs", () => {
    expect(parseCellRef("$A$1")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef("$B$3")).toEqual({ row: 2, col: 1 });
  });

  it("handles mixed absolute refs", () => {
    expect(parseCellRef("$A1")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef("A$1")).toEqual({ row: 0, col: 0 });
  });

  it("returns null for empty string", () => {
    expect(parseCellRef("")).toBeNull();
  });

  it("returns null for invalid ref (no number)", () => {
    expect(parseCellRef("ABC")).toBeNull();
  });

  it("returns null for row 0", () => {
    expect(parseCellRef("A0")).toBeNull();
  });

  it("returns null for purely numeric ref", () => {
    expect(parseCellRef("123")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseCellRef("  A1  ")).toEqual({ row: 0, col: 0 });
  });

  it("parses AZ100", () => {
    const result = parseCellRef("AZ100");
    expect(result).not.toBeNull();
    expect(result!.row).toBe(99);
    // AZ = 26*1 + 26 = 52 -> col index 51
    expect(result!.col).toBe(51);
  });
});

// ============================================================================
// formatCellRef
// ============================================================================

describe("formatCellRef", () => {
  it("formats row 0, col 0 as $A$1", () => {
    expect(formatCellRef(0, 0)).toBe("$A$1");
  });

  it("formats row 1, col 1 as $B$2", () => {
    expect(formatCellRef(1, 1)).toBe("$B$2");
  });

  it("formats col 25 as $Z", () => {
    expect(formatCellRef(0, 25)).toBe("$Z$1");
  });

  it("formats col 26 as $AA", () => {
    expect(formatCellRef(0, 26)).toBe("$AA$1");
  });
});

// ============================================================================
// parseCellRange
// ============================================================================

describe("parseCellRange", () => {
  it("parses single cell", () => {
    expect(parseCellRange("A1")).toEqual([{ row: 0, col: 0 }]);
  });

  it("parses comma-separated cells", () => {
    const result = parseCellRange("A1, B2, C3");
    expect(result).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 2 },
    ]);
  });

  it("parses range A1:A3 (single column)", () => {
    const result = parseCellRange("A1:A3");
    expect(result).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
    ]);
  });

  it("parses range A1:C1 (single row)", () => {
    const result = parseCellRange("A1:C1");
    expect(result).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ]);
  });

  it("parses 2D range A1:B2", () => {
    const result = parseCellRange("A1:B2");
    expect(result).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it("parses range with absolute refs", () => {
    const result = parseCellRange("$A$1:$B$2");
    expect(result).toHaveLength(4);
  });

  it("parses mixed cells and ranges", () => {
    const result = parseCellRange("A1, B1:B3");
    expect(result).toHaveLength(4); // A1 + B1,B2,B3
  });

  it("returns empty for invalid ref", () => {
    expect(parseCellRange("invalid")).toEqual([]);
  });

  it("handles reversed range (end before start)", () => {
    const result = parseCellRange("B2:A1");
    expect(result).toHaveLength(4);
    // Should still produce A1:B2 cells
    expect(result).toContainEqual({ row: 0, col: 0 });
    expect(result).toContainEqual({ row: 1, col: 1 });
  });

  it("handles empty string", () => {
    expect(parseCellRange("")).toEqual([]);
  });
});

// ============================================================================
// Round-trip: format -> parse
// ============================================================================

describe("format/parse round-trip", () => {
  it("formatCellRef then parseCellRef returns original coords", () => {
    for (const [r, c] of [[0, 0], [5, 3], [99, 51]]) {
      const ref = formatCellRef(r, c);
      const parsed = parseCellRef(ref);
      expect(parsed).toEqual({ row: r, col: c });
    }
  });
});
