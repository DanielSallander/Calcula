//! FILENAME: app/src/core/lib/__tests__/formulaRef-massive.test.ts
// PURPOSE: Massive parameterized tests for formulaRefParser functions
// TARGET: 400 tests via it.each

import { describe, it, expect } from "vitest";
import {
  parseFormulaReferences,
  buildCellReference,
  buildRangeReference,
} from "../formulaRefParser";

// --- parseFormulaReferences: 100 formulas with known ref counts ---

const formulaRefCases: [string, number][] = [
  // No refs
  ["=1+2", 0],
  ["=TRUE", 0],
  ['="hello"', 0],
  // Single cell refs
  ["=A1", 1],
  ["=B2+1", 1],
  ["=SUM(C3)", 1],
  ["=$D$4", 1],
  ["=A1+B2", 2],
  ["=A1+B2+C3", 3],
  ["=A1+B2+C3+D4", 4],
  ["=A1+B2+C3+D4+E5", 5],
  // Range refs
  ["=SUM(A1:B2)", 1],
  ["=SUM(A1:B2)+C3", 2],
  ["=SUM(A1:B10,C1:C10)", 2],
  ["=SUM(A1:Z100)", 1],
  // Cross-sheet
  ["=Sheet1!A1", 1],
  ["='My Sheet'!B2", 1],
  ["=Sheet1!A1+Sheet2!B2", 2],
  // Absolute mixed
  ["=$A1+B$2+$C$3", 3],
  ["=$A$1:$B$2", 1],
  // Not a formula
  ["hello", 0],
  ["A1+B2", 0],
  // Complex formulas
  ["=IF(A1>B1,C1,D1)", 4],
  ["=VLOOKUP(A1,B1:D10,2,FALSE)", 2],
  ["=INDEX(A1:Z100,MATCH(B1,A1:A100,0),1)", 3],
  ["=SUMPRODUCT(A1:A10,B1:B10)", 2],
  ["=A1*B1+C1*D1-E1/F1", 6],
  ["=AVERAGE(A1:A50)+STDEV(B1:B50)", 2],
  ["=CONCATENATE(A1,B1,C1,D1,E1,F1,G1,H1)", 8],
  ["=A1+A2+A3+A4+A5+A6+A7+A8+A9+A10", 10],
];

// Generate more formulas programmatically
for (let i = 1; i <= 20; i++) {
  const cells = Array.from({ length: i }, (_, j) => String.fromCharCode(65 + (j % 26)) + (j + 1));
  formulaRefCases.push([`=${cells.join("+")}`, i]);
}

// Add range formulas
for (let i = 1; i <= 15; i++) {
  const col = String.fromCharCode(65 + (i % 26));
  formulaRefCases.push([`=SUM(${col}1:${col}${i * 10})`, 1]);
}

// Multi-range formulas
for (let i = 2; i <= 10; i++) {
  const ranges = Array.from({ length: i }, (_, j) => {
    const c = String.fromCharCode(65 + j);
    return `${c}1:${c}10`;
  });
  formulaRefCases.push([`=SUM(${ranges.join(",")})`, i]);
}

// Ensure we have at least 100
while (formulaRefCases.length < 100) {
  const n = formulaRefCases.length;
  formulaRefCases.push([`=A${n}+B${n}`, 2]);
}

const formula100 = formulaRefCases.slice(0, 100);

describe("parseFormulaReferences - 100 formula cases", () => {
  it.each(formula100)(
    "parseFormulaReferences(%s) should find %i refs",
    (formula, expectedCount) => {
      const refs = parseFormulaReferences(formula);
      expect(refs).toHaveLength(expectedCount);
    }
  );
});

// --- buildCellReference: 200 row/col/absolute combos ---

interface CellRefCase {
  row: number;
  col: number;
  colAbs: boolean;
  rowAbs: boolean;
  sheet?: string;
  expected: string;
}

function expectedCellRef(row: number, col: number, colAbs: boolean, rowAbs: boolean, sheet?: string): string {
  let colStr = "";
  let c = col;
  while (c >= 0) {
    colStr = String.fromCharCode((c % 26) + 65) + colStr;
    c = Math.floor(c / 26) - 1;
  }
  const cp = colAbs ? "$" : "";
  const rp = rowAbs ? "$" : "";
  const ref = `${cp}${colStr}${rp}${row + 1}`;
  if (sheet) {
    const needsQuote = /[\s'![\]]/.test(sheet) || /^\d/.test(sheet);
    const formatted = needsQuote ? `'${sheet.replace(/'/g, "''")}'` : sheet;
    return `${formatted}!${ref}`;
  }
  return ref;
}

const cellRefCases: [number, number, boolean, boolean, string | undefined, string][] = [];

// Generate 200 cases
const rows = [0, 1, 5, 10, 99, 999, 9999, 65535];
const cols = [0, 1, 25, 26, 51, 100, 255, 702, 16383];
const absOptions: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];
const sheets: (string | undefined)[] = [undefined, "Sheet1", "My Sheet"];

let cellCount = 0;
for (const row of rows) {
  for (const col of cols) {
    for (const [ca, ra] of absOptions) {
      for (const sheet of sheets) {
        if (cellCount >= 200) break;
        const exp = expectedCellRef(row, col, ca, ra, sheet);
        cellRefCases.push([row, col, ca, ra, sheet, exp]);
        cellCount++;
      }
      if (cellCount >= 200) break;
    }
    if (cellCount >= 200) break;
  }
  if (cellCount >= 200) break;
}

describe("buildCellReference - 200 parameterized cases", () => {
  it.each(cellRefCases)(
    "buildCellReference(row=%i, col=%i, colAbs=%s, rowAbs=%s, sheet=%s) => %s",
    (row, col, colAbs, rowAbs, sheet, expected) => {
      const result = buildCellReference(row, col, colAbs, rowAbs, sheet);
      expect(result).toBe(expected);
    }
  );
});

// --- buildRangeReference: 100 start/end/absolute combos ---

const rangeRefCases: [number, number, number, number, boolean, boolean, boolean, boolean, string | undefined][] = [];

const startRows = [0, 1, 10, 50, 999];
const startCols = [0, 1, 25, 26, 100];
const endOffsets = [1, 5, 10, 25];

let rangeCount = 0;
for (const sr of startRows) {
  for (const sc of startCols) {
    for (const eo of endOffsets) {
      for (const [sca, sra] of absOptions) {
        if (rangeCount >= 100) break;
        // Alternate end absolute markers
        const eca = rangeCount % 2 === 0;
        const era = rangeCount % 3 === 0;
        const sheet = rangeCount % 5 === 0 ? "Data" : undefined;
        rangeRefCases.push([sr, sc, sr + eo, sc + eo, sca, sra, eca, era, sheet]);
        rangeCount++;
      }
      if (rangeCount >= 100) break;
    }
    if (rangeCount >= 100) break;
  }
  if (rangeCount >= 100) break;
}

describe("buildRangeReference - 100 parameterized cases", () => {
  it.each(rangeRefCases)(
    "buildRangeReference(sr=%i, sc=%i, er=%i, ec=%i, sca=%s, sra=%s, eca=%s, era=%s, sheet=%s)",
    (sr, sc, er, ec, sca, sra, eca, era, sheet) => {
      const result = buildRangeReference(sr, sc, er, ec, sca, sra, eca, era, sheet);
      // Verify structure
      expect(result).toBeTruthy();
      // Should contain colon for actual ranges
      if (sr !== er || sc !== ec) {
        expect(result).toContain(":");
      }
      // Should contain sheet prefix if provided
      if (sheet) {
        expect(result).toContain("!");
      }
      // Verify absolute markers
      if (sca) expect(result).toMatch(/\$/);
      // Verify row numbers are present (1-based)
      expect(result).toContain(String(sr + 1));
      expect(result).toContain(String(er + 1));
    }
  );
});
