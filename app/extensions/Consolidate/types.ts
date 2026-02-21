//! FILENAME: app/extensions/Consolidate/types.ts
// PURPOSE: Local types for the Consolidate extension.
// CONTEXT: Not shared with the API layer - used only within this extension.

/** A parsed source range reference with display string. */
export interface SourceRangeEntry {
  /** The display string, e.g. "Sheet1!$A$1:$D$10" */
  display: string;
  /** Resolved sheet index */
  sheetIndex: number;
  /** Sheet name */
  sheetName: string;
  /** Start row (0-based) */
  startRow: number;
  /** Start column (0-based) */
  startCol: number;
  /** End row (0-based, inclusive) */
  endRow: number;
  /** End column (0-based, inclusive) */
  endCol: number;
}

/** Consolidation function option for the dropdown. */
export interface FunctionOption {
  value: string;
  label: string;
}

/** All 11 consolidation functions. */
export const CONSOLIDATION_FUNCTIONS: FunctionOption[] = [
  { value: "sum", label: "Sum" },
  { value: "count", label: "Count" },
  { value: "average", label: "Average" },
  { value: "max", label: "Max" },
  { value: "min", label: "Min" },
  { value: "product", label: "Product" },
  { value: "countNums", label: "Count Nums" },
  { value: "stdDev", label: "StdDev" },
  { value: "stdDevP", label: "StdDevP" },
  { value: "var", label: "Var" },
  { value: "varP", label: "VarP" },
];
