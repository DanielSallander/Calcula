//! FILENAME: app/src/api/designQueryAssist/types.ts
// PURPOSE: The shapes the design-query assistant works over: a model reduced
//          to names, the strategy reduced to what choosing names needs, and
//          the candidate lists a model is shown.
// CONTEXT: Structural on purpose. `@api` may not import an extension, and the
//          model info a dialog holds (`BiPivotModelInfo`, in `_shared`) is
//          wider than this; any object with these fields is accepted, so a
//          caller passes what it has and nothing is copied.
//
//          `DesignStrategySummary` MIRRORS the Rust struct of the same name in
//          `app/src-tauri/src/insights/describe.rs`, field for field, camelCase
//          over the wire. A test parses the Rust struct and diffs it against
//          this interface, so the two cannot drift in silence.

/** One column of a model table, as the candidate chooser sees it. */
export interface DesignQueryColumn {
  name: string;
  /** The engine's data type name ("Float64", "String", "Date"...). */
  dataType?: string;
  isNumeric?: boolean;
}

export interface DesignQueryTable {
  name: string;
  columns: DesignQueryColumn[];
}

export interface DesignQueryMeasure {
  name: string;
  table?: string;
}

/** What the strategy says about one measure that decides which names to offer. */
export interface DesignMeasureHints {
  /** The resolved direction's wire word, when one resolved. Informational. */
  direction?: string | null;
  /** Columns the business breaks this measure down by, as `Table[Column]`. */
  analysisDimensions: string[];
  /** Columns that must never appear in a breakdown of it, as `Table[Column]`. */
  neverSliceBy: string[];
}

/**
 * The strategy document, reduced to the structured attributes that decide
 * WHICH names a model is shown and how they RANK. Prose never appears here.
 */
export interface DesignStrategySummary {
  /** Measures in the run's own order: declared priority, KPIs, then the rest. */
  measureOrder: string[];
  measures: Record<string, DesignMeasureHints>;
  /** `Table[Column]` -> role wire word (`key`, `analysis`, `label`, `filter`, `hierarchy`, `ignore`). */
  columnRoles: Record<string, string>;
  /** Table -> the column a reader recognises a row by. */
  labelColumns: Record<string, string>;
  /** The time axis as `Table[Column]`, when the document or the calendar names one. */
  timeAxis?: string | null;
  calendarTable?: string | null;
}

/** A model as the assistant needs it. `BiPivotModelInfo` satisfies this. */
export interface DesignQueryModel {
  tables: DesignQueryTable[];
  measures: DesignQueryMeasure[];
  strategy?: DesignStrategySummary | null;
}

/** The names a model is shown, in the order it is shown them. */
export interface DesignQueryCandidates {
  /** Measure names, bare (the prompt brackets them). Most important first. */
  measures: string[];
  /** Dimensions in DSL spelling: `Product.Category`, or `[Sales.Order Date]` when quoting is needed. */
  dimensions: string[];
  /** Numeric columns a query may aggregate with sum()/average()/count(), in DSL spelling. */
  numericColumns: string[];
  /** The time axis in DSL spelling, or null when the model has none. */
  timeAxis: string | null;
  /** The calendar's grouping columns in DSL spelling (Year, Month...), coarse first. */
  timeGroupings: string[];
  /** How many measures and dimensions the caps cut, so the prompt can say so. */
  droppedMeasures: number;
  droppedDimensions: number;
}

/** What the model proposed, once extracted from its reply. */
export interface DesignQueryProposal {
  /** The query text, one clause per line. */
  dsl: string;
  explanation: string;
}
