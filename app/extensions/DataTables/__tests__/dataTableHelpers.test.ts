//! FILENAME: app/extensions/DataTables/__tests__/dataTableHelpers.test.ts
// PURPOSE: Tests for Data Table helper functions and validation logic.

import { describe, it, expect } from "vitest";

// ============================================================================
// Re-export pure helpers (copied from DataTableDialog.tsx)
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

// Validation logic extracted from handleOk
interface DataTableValidation {
  valid: boolean;
  error?: string;
  type?: "one-var" | "two-var";
  rowInput?: { row: number; col: number } | null;
  colInput?: { row: number; col: number } | null;
}

function validateDataTableInputs(
  rowInputRef: string,
  colInputRef: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): DataTableValidation {
  const hasRowInput = rowInputRef.trim().length > 0;
  const hasColInput = colInputRef.trim().length > 0;

  if (!hasRowInput && !hasColInput) {
    return { valid: false, error: "Specify at least one input cell (Row or Column)." };
  }

  if (startRow === endRow && startCol === endCol) {
    return { valid: false, error: "Select a table range first (at least 2x2 cells)." };
  }

  let rowInput: { row: number; col: number } | null = null;
  let colInput: { row: number; col: number } | null = null;

  if (hasRowInput) {
    rowInput = parseCellRef(rowInputRef);
    if (!rowInput) {
      return { valid: false, error: "Invalid Row input cell reference." };
    }
  }

  if (hasColInput) {
    colInput = parseCellRef(colInputRef);
    if (!colInput) {
      return { valid: false, error: "Invalid Column input cell reference." };
    }
  }

  const type = hasRowInput && hasColInput ? "two-var" : "one-var";
  return { valid: true, type, rowInput, colInput };
}

// ============================================================================
// parseCellRef
// ============================================================================

describe("parseCellRef", () => {
  it("parses simple refs", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef("C5")).toEqual({ row: 4, col: 2 });
  });

  it("strips dollar signs", () => {
    expect(parseCellRef("$B$1")).toEqual({ row: 0, col: 1 });
  });

  it("returns null for garbage", () => {
    expect(parseCellRef("")).toBeNull();
    expect(parseCellRef("123")).toBeNull();
    expect(parseCellRef("XY")).toBeNull();
  });

  it("returns null for row 0", () => {
    expect(parseCellRef("A0")).toBeNull();
  });
});

// ============================================================================
// formatCellRef
// ============================================================================

describe("formatCellRef", () => {
  it("formats with dollar signs", () => {
    expect(formatCellRef(0, 0)).toBe("$A$1");
    expect(formatCellRef(4, 2)).toBe("$C$5");
  });

  it("formats multi-letter columns", () => {
    expect(formatCellRef(0, 26)).toBe("$AA$1");
    expect(formatCellRef(0, 27)).toBe("$AB$1");
  });
});

// ============================================================================
// validateDataTableInputs
// ============================================================================

describe("validateDataTableInputs", () => {
  it("fails when no inputs provided", () => {
    const result = validateDataTableInputs("", "", 0, 0, 5, 3);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("at least one input cell");
  });

  it("fails when table range is single cell", () => {
    const result = validateDataTableInputs("A1", "", 2, 2, 2, 2);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("table range");
  });

  it("fails on invalid row input ref", () => {
    const result = validateDataTableInputs("INVALID", "", 0, 0, 5, 3);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Row input cell");
  });

  it("fails on invalid column input ref", () => {
    const result = validateDataTableInputs("", "NOTACELL", 0, 0, 5, 3);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Column input cell");
  });

  it("identifies one-variable table (row input only)", () => {
    const result = validateDataTableInputs("$B$1", "", 0, 0, 5, 3);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("one-var");
    expect(result.rowInput).toEqual({ row: 0, col: 1 });
    expect(result.colInput).toBeNull();
  });

  it("identifies one-variable table (column input only)", () => {
    const result = validateDataTableInputs("", "$A$1", 0, 0, 5, 3);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("one-var");
    expect(result.rowInput).toBeNull();
    expect(result.colInput).toEqual({ row: 0, col: 0 });
  });

  it("identifies two-variable table", () => {
    const result = validateDataTableInputs("$B$1", "$A$1", 0, 0, 5, 3);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("two-var");
    expect(result.rowInput).toEqual({ row: 0, col: 1 });
    expect(result.colInput).toEqual({ row: 0, col: 0 });
  });

  it("trims whitespace from refs", () => {
    const result = validateDataTableInputs("  $B$1  ", "", 0, 0, 5, 3);
    expect(result.valid).toBe(true);
  });

  it("treats whitespace-only as empty", () => {
    const result = validateDataTableInputs("   ", "   ", 0, 0, 5, 3);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("at least one input cell");
  });

  it("validates with minimum 2x2 range", () => {
    const result = validateDataTableInputs("$A$1", "", 0, 0, 1, 1);
    expect(result.valid).toBe(true);
  });

  it("validates with large range", () => {
    const result = validateDataTableInputs("$A$1", "$B$1", 0, 0, 100, 50);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("two-var");
  });

  it("fails when only row differs but cols same for single cell check", () => {
    // startRow !== endRow, so this is a valid range
    const result = validateDataTableInputs("$A$1", "", 0, 0, 5, 0);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Range label formatting
// ============================================================================

describe("range label", () => {
  it("formats table range label correctly", () => {
    const label = `${formatCellRef(0, 0)}:${formatCellRef(5, 3)}`;
    expect(label).toBe("$A$1:$D$6");
  });

  it("shows no range for single cell", () => {
    const startRow = 2, startCol = 2, endRow = 2, endCol = 2;
    const label = startRow !== endRow || startCol !== endCol
      ? `${formatCellRef(startRow, startCol)}:${formatCellRef(endRow, endCol)}`
      : "(no range selected)";
    expect(label).toBe("(no range selected)");
  });
});
