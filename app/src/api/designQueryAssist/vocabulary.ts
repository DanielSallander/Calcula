//! FILENAME: app/src/api/designQueryAssist/vocabulary.ts
// PURPOSE: The design-query DSL's closed vocabularies, as the prompt and the
//          grammar need them.
// CONTEXT: The DSL itself lives in `extensions/_shared/dsl/pivotLayout/`,
//          which `@api` may not import. These lists are COPIES of the
//          aggregation names, layout directives and show-values-as labels in
//          `tokens.ts` there, and a test on the `_shared` side diffs them
//          against the originals — so a directive added to the DSL without
//          being added here fails a test rather than silently never being
//          offered to a model.

/** Aggregations a VALUES entry may apply to a column: `sum(Sales.Amount)`. */
export const DSL_AGGREGATIONS: readonly string[] = [
  "sum", "count", "average", "min", "max",
  "countnumbers", "stddev", "stddevp", "var", "varp", "product",
];

/** The subset a model is TAUGHT. The rest stay legal and stay out of the prompt. */
export const DSL_TAUGHT_AGGREGATIONS: readonly string[] = ["sum", "count", "average", "min", "max"];

/** LAYOUT directives. */
export const DSL_LAYOUT_DIRECTIVES: readonly string[] = [
  "compact", "outline", "tabular",
  "repeat-labels", "no-repeat-labels",
  "no-grand-totals", "no-row-totals", "no-column-totals",
  "grand-totals", "row-totals", "column-totals",
  "show-empty-rows", "show-empty-cols",
  "values-on-rows", "values-on-columns",
  "auto-fit",
  "subtotals-top", "subtotals-bottom", "subtotals-off",
];

/** The show-values-as labels written in brackets after a measure. */
export const DSL_SHOW_VALUES_AS: readonly string[] = [
  "% of grand total",
  "% of row",
  "% of row total",
  "% of column",
  "% of column total",
  "% of parent row",
  "% of parent column",
  "difference",
  "% difference",
  "running total",
  "index",
];

/** The clause keywords, as the extractor recognises a line by them. */
export const DSL_CLAUSE_KEYWORDS: readonly string[] = [
  "ROWS", "COLUMNS", "VALUES", "FILTERS", "SORT", "LAYOUT", "CALC", "TOP", "BOTTOM", "SAVE",
];
