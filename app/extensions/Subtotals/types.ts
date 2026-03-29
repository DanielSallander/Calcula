//! FILENAME: app/extensions/Subtotals/types.ts
// PURPOSE: Type definitions for the Subtotals extension.

/** Aggregate function codes matching Excel's SUBTOTAL function_num values. */
export type SubtotalFunction = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface SubtotalFunctionInfo {
  code: SubtotalFunction;
  name: string;
  label: string;
}

/** All available subtotal aggregate functions. */
export const SUBTOTAL_FUNCTIONS: SubtotalFunctionInfo[] = [
  { code: 9, name: "SUM", label: "Sum" },
  { code: 1, name: "AVERAGE", label: "Average" },
  { code: 2, name: "COUNT", label: "Count" },
  { code: 3, name: "COUNTA", label: "Count Numbers" },
  { code: 4, name: "MAX", label: "Max" },
  { code: 5, name: "MIN", label: "Min" },
  { code: 6, name: "PRODUCT", label: "Product" },
  { code: 7, name: "STDEV", label: "StdDev" },
  { code: 8, name: "STDEVP", label: "StdDevP" },
  { code: 10, name: "VAR", label: "Var" },
  { code: 11, name: "VARP", label: "VarP" },
];

/** Configuration for an automatic subtotal operation. */
export interface SubtotalConfig {
  /** Column index (0-based) to group by (detect changes in this column). */
  groupByCol: number;
  /** Column indices (0-based) to apply the subtotal function to. */
  subtotalCols: number[];
  /** SUBTOTAL function code to use. */
  functionCode: SubtotalFunction;
  /** Whether to replace existing subtotals. */
  replaceExisting: boolean;
  /** Data range (0-based, inclusive). */
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}
