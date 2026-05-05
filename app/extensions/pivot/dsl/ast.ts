//! FILENAME: app/extensions/Pivot/dsl/ast.ts
// PURPOSE: Abstract Syntax Tree types for the Pivot Layout DSL.
// CONTEXT: Produced by the parser, consumed by the compiler.

import type { SourceLocation } from './errors';
import type { AggregationType } from '../../_shared/components/types';

/** Root AST node representing a complete pivot layout definition. */
export interface PivotLayoutAST {
  rows: FieldNode[];
  columns: FieldNode[];
  values: ValueFieldNode[];
  filters: FilterFieldNode[];
  sort: SortNode[];
  layout: LayoutDirective[];
  calculatedFields: CalcFieldNode[];
  topN?: TopNNode;
  saveAs?: string;
}

/** A field reference in ROWS, COLUMNS, or as part of other clauses. */
export interface FieldNode {
  /** Raw name as written: "Region", "Customers.Region", etc. */
  name: string;
  /** For BI dotted notation: the table part. */
  table?: string;
  /** For BI dotted notation: the column part. */
  column?: string;
  /** Whether LOOKUP keyword was present. */
  isLookup: boolean;
  /** Subtotals control: undefined = default, false = no-subtotals. */
  subtotals?: boolean;
  /** Date/number grouping specification. */
  grouping?: GroupingNode;
  /** VIA relationship disambiguation (BI). */
  via?: ViaNode;
  location: SourceLocation;
}

/** A value field in the VALUES clause. */
export interface ValueFieldNode {
  /** The source field name (inside aggregation parens, or a bracket measure). */
  fieldName: string;
  /** For BI dotted notation: the table part. */
  table?: string;
  /** For BI dotted notation: the column part. */
  column?: string;
  /** Aggregation function (sum, count, etc.). Undefined for bracket measures. */
  aggregation?: AggregationType;
  /** Whether this is a bracket measure reference [MeasureName]. */
  isMeasure: boolean;
  /** Custom display name from AS "alias". */
  alias?: string;
  /** Show-values-as from [% of Row] etc. */
  showValuesAs?: string;
  location: SourceLocation;
}

/** A filter specification in the FILTERS clause. */
export interface FilterFieldNode {
  /** Field name to filter on. */
  fieldName: string;
  /** For BI dotted notation: the table part. */
  table?: string;
  /** For BI dotted notation: the column part. */
  column?: string;
  /** Values to include (= "a", "b") or exclude (NOT IN "a", "b"). */
  values: string[];
  /** Whether this is an exclusion filter (NOT IN). */
  exclude: boolean;
  location: SourceLocation;
}

/** A sort specification in the SORT clause. */
export interface SortNode {
  fieldName: string;
  direction: 'asc' | 'desc';
  location: SourceLocation;
}

/** A layout directive in the LAYOUT clause. */
export interface LayoutDirective {
  key: string;
  location: SourceLocation;
}

/** A calculated field in the CALC clause. */
export interface CalcFieldNode {
  name: string;
  /** Raw expression text (not parsed by the DSL parser). */
  expression: string;
  location: SourceLocation;
}

/** Top/Bottom N specification. */
export interface TopNNode {
  count: number;
  /** true = TOP, false = BOTTOM */
  top: boolean;
  /** Field to rank by. */
  byField: string;
  /** Aggregation on the rank field. */
  byAggregation?: AggregationType;
  location: SourceLocation;
}

/** Date or number grouping on a field. */
export interface GroupingNode {
  type: 'date' | 'number';
  /** For date grouping: level names (years, quarters, months, weeks, days). */
  levels?: string[];
  /** For number binning: [start, end, interval] or just [interval]. */
  params?: number[];
  location: SourceLocation;
}

/** VIA relationship disambiguation. */
export interface ViaNode {
  /** e.g., "Orders.OrderDate" */
  path: string;
  location: SourceLocation;
}

/** Create an empty AST. */
export function emptyAST(): PivotLayoutAST {
  return {
    rows: [],
    columns: [],
    values: [],
    filters: [],
    sort: [],
    layout: [],
    calculatedFields: [],
  };
}
