//! FILENAME: app/extensions/ScenarioManager/__tests__/scenario-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for cell ref parsing, range parsing, and formatting.

import { describe, it, expect } from "vitest";

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
// parseCellRef - 40 address strings
// ============================================================================

describe("parseCellRef parameterized", () => {
  const validRefs: [string, number, number][] = [
    ["A1", 0, 0],
    ["B1", 0, 1],
    ["C1", 0, 2],
    ["Z1", 0, 25],
    ["AA1", 0, 26],
    ["AB1", 0, 27],
    ["AZ1", 0, 51],
    ["BA1", 0, 52],
    ["ZZ1", 0, 701],
    ["AAA1", 0, 702],
    ["A2", 1, 0],
    ["A10", 9, 0],
    ["A100", 99, 0],
    ["A1000", 999, 0],
    ["B2", 1, 1],
    ["C3", 2, 2],
    ["D4", 3, 3],
    ["E5", 4, 4],
    ["J10", 9, 9],
    ["Z26", 25, 25],
    ["$A$1", 0, 0],
    ["$B$2", 1, 1],
    ["$AA$100", 99, 26],
    ["$Z$1", 0, 25],
    ["a1", 0, 0],
    ["b2", 1, 1],
    ["aa1", 0, 26],
    ["  A1  ", 0, 0],
    ["A$1", 0, 0],
    ["$A1", 0, 0],
  ];

  it.each(validRefs)(
    "parses %s -> row=%d col=%d",
    (ref, expectedRow, expectedCol) => {
      const result = parseCellRef(ref);
      expect(result).not.toBeNull();
      expect(result!.row).toBe(expectedRow);
      expect(result!.col).toBe(expectedCol);
    }
  );

  const invalidRefs: [string, string][] = [
    ["", "empty"],
    ["123", "digits only"],
    ["ABC", "letters only"],
    ["A0", "row zero"],
    ["1A", "digit first"],
    ["A-1", "negative"],
    ["!A1", "special char prefix"],
    ["A 1", "space in middle"],
    ["A.1", "dot separator"],
    ["@A1", "at sign prefix"],
  ];

  it.each(invalidRefs)(
    "rejects %s (%s)",
    (ref) => {
      expect(parseCellRef(ref)).toBeNull();
    }
  );
});

// ============================================================================
// parseCellRange - 30 range strings
// ============================================================================

describe("parseCellRange parameterized", () => {
  const rangeCombos: [string, number][] = [
    // [rangeString, expectedCellCount]
    ["A1", 1],
    ["B2", 1],
    ["A1, B1", 2],
    ["A1, B1, C1", 3],
    ["A1, B2, C3, D4, E5", 5],
    ["A1:A1", 1],
    ["A1:A2", 2],
    ["A1:A3", 3],
    ["A1:A5", 5],
    ["A1:A10", 10],
    ["A1:B1", 2],
    ["A1:C1", 3],
    ["A1:E1", 5],
    ["A1:B2", 4],
    ["A1:C3", 9],
    ["A1:B3", 6],
    ["A1:D2", 8],
    ["B2:D4", 9],
    ["$A$1:$B$2", 4],
    ["A1:A1, B1:B1", 2],
    ["A1, B1:B3", 4],
    ["A1:B2, C1:D2", 8],
    ["A1:A5, B1:B5", 10],
    ["A1:C1, A2:C2", 6],
    ["B2:A1", 4],
    ["C3:A1", 9],
    ["invalid", 0],
    ["", 0],
    ["A1, invalid, B1", 2],
    ["Z1:Z10", 10],
  ];

  it.each(rangeCombos)(
    "range=%s -> %d cells",
    (rangeStr, expectedCount) => {
      const result = parseCellRange(rangeStr);
      expect(result).toHaveLength(expectedCount);
    }
  );
});

// ============================================================================
// formatCellRef - 30 row/col combos
// ============================================================================

describe("formatCellRef parameterized", () => {
  const formatCombos: [number, number, string][] = [
    [0, 0, "$A$1"],
    [0, 1, "$B$1"],
    [0, 2, "$C$1"],
    [0, 25, "$Z$1"],
    [0, 26, "$AA$1"],
    [0, 27, "$AB$1"],
    [0, 51, "$AZ$1"],
    [0, 52, "$BA$1"],
    [0, 255, "$IV$1"],
    [0, 701, "$ZZ$1"],
    [0, 702, "$AAA$1"],
    [1, 0, "$A$2"],
    [1, 1, "$B$2"],
    [9, 0, "$A$10"],
    [9, 9, "$J$10"],
    [99, 0, "$A$100"],
    [99, 25, "$Z$100"],
    [99, 26, "$AA$100"],
    [999, 0, "$A$1000"],
    [999, 25, "$Z$1000"],
    [2, 2, "$C$3"],
    [3, 3, "$D$4"],
    [4, 4, "$E$5"],
    [5, 5, "$F$6"],
    [10, 10, "$K$11"],
    [49, 0, "$A$50"],
    [49, 49, "$AX$50"],
    [199, 0, "$A$200"],
    [199, 51, "$AZ$200"],
    [499, 0, "$A$500"],
  ];

  it.each(formatCombos)(
    "row=%d col=%d -> %s",
    (row, col, expected) => {
      expect(formatCellRef(row, col)).toBe(expected);
    }
  );
});

// ============================================================================
// Round-trip: formatCellRef -> parseCellRef
// ============================================================================

describe("format/parse round-trip parameterized", () => {
  const roundTripCombos: [number, number][] = [
    [0, 0], [0, 1], [0, 25], [0, 26], [0, 51], [0, 52],
    [0, 255], [0, 701], [0, 702], [1, 0], [1, 1], [5, 5],
    [9, 9], [10, 10], [25, 25], [50, 50], [99, 99], [100, 100],
    [255, 255], [999, 999],
  ];

  it.each(roundTripCombos)(
    "round-trip row=%d col=%d",
    (row, col) => {
      const ref = formatCellRef(row, col);
      const parsed = parseCellRef(ref);
      expect(parsed).not.toBeNull();
      expect(parsed!.row).toBe(row);
      expect(parsed!.col).toBe(col);
    }
  );
});
