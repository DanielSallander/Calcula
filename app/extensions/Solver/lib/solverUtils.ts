//! FILENAME: app/extensions/Solver/lib/solverUtils.ts
// PURPOSE: Pure utility functions extracted from SolverDialog for testability.
// CONTEXT: Cell reference parsing and constraint formatting.

import { columnToLetter } from "@api";
import type { ConstraintOperator, SolverVariableCell } from "@api";

// ============================================================================
// Cell Reference Parsing
// ============================================================================

/**
 * Parse a cell reference like "A1", "$A$1", "b5" to 0-based {row, col}.
 * Returns null if the reference is invalid.
 */
export function parseCellRef(ref: string): { row: number; col: number } | null {
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

/**
 * Format a 0-based (row, col) as an absolute cell reference like "$A$1".
 */
export function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

/**
 * Parse a comma-separated list of cell references and ranges into variable cells.
 * Supports "A1", "A1:B3", "A1,B2,C3:D5".
 */
export function parseCellList(refs: string): SolverVariableCell[] {
  const cells: SolverVariableCell[] = [];
  const parts = refs.split(",");
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
// Constraint Formatting
// ============================================================================

export const operatorLabels: Record<ConstraintOperator, string> = {
  lessEqual: "<=",
  greaterEqual: ">=",
  equal: "=",
  integer: "int",
  binary: "bin",
  allDifferent: "dif",
};

export interface ConstraintEntry {
  cellRef: string;
  operator: ConstraintOperator;
  rhsRef: string;
}

/**
 * Format a constraint entry as a human-readable string.
 */
export function formatConstraint(c: ConstraintEntry): string {
  const op = operatorLabels[c.operator];
  if (c.operator === "integer" || c.operator === "binary" || c.operator === "allDifferent") {
    return `${c.cellRef} = ${op}`;
  }
  return `${c.cellRef} ${op} ${c.rhsRef}`;
}
