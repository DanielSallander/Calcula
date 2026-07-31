//! FILENAME: app/src/api/scriptHost/pivotLayoutVocabulary.ts
// PURPOSE: The words a script uses to reshape a pivot — areas, aggregations and
//          layout directives — mapped to the @api/pivot request enums (B3 §4).
// CONTEXT: These ARE the Pivot Layout DSL's words (extensions/_shared/dsl/
//          pivotLayout: the ROWS/COLUMNS/VALUES/FILTERS clauses, AGGREGATION_NAMES
//          and LAYOUT_DIRECTIVES). A script that writes
//          `pivot.addField("Region", "rows")` and a user who types
//          `ROWS Region` are saying the same thing.
//
//          WHY THE VOCABULARY IS RESTATED HERE RATHER THAN IMPORTED: the DSL
//          lives in extensions/_shared, and the API facade must never import an
//          extension (API NEUTRALITY, eslint.boundaries.js). So this module is
//          the api-side twin, and `pivotVocabulary.test.ts` pins it against the
//          DSL's own constant sets so the two cannot drift silently.
//
//          Everything here is PURE (no state, no I/O) so it is fully testable.

import type { AggregationFunction, ExtendedLayoutConfig, PivotAxis } from "../pivotTypes";

// ============================================================================
// Areas (the DSL's ROWS / COLUMNS / VALUES / FILTERS clauses)
// ============================================================================

/** A pivot layout area, named as the DSL names it. */
export type PivotArea = "rows" | "columns" | "values" | "filters";

export const PIVOT_AREAS: ReadonlySet<string> = new Set<PivotArea>([
  "rows",
  "columns",
  "values",
  "filters",
]);

/** DSL area -> the PivotAxis the backend requests use. */
const AREA_TO_AXIS: Record<PivotArea, PivotAxis> = {
  rows: "row",
  columns: "column",
  values: "data",
  filters: "filter",
};

/** DSL area -> PivotAxis. Returns null for anything not in PIVOT_AREAS. */
export function areaToAxis(area: string): PivotAxis | null {
  return Object.prototype.hasOwnProperty.call(AREA_TO_AXIS, area)
    ? AREA_TO_AXIS[area as PivotArea]
    : null;
}

/** PivotAxis -> DSL area (the inverse of areaToAxis; null for "unknown"). */
export function axisToArea(axis: string): PivotArea | null {
  for (const [area, mapped] of Object.entries(AREA_TO_AXIS)) {
    if (mapped === axis) return area as PivotArea;
  }
  return null;
}

// ============================================================================
// Aggregations (the DSL's AGGREGATION_NAMES)
// ============================================================================

/**
 * DSL aggregation word -> the backend's AggregationFunction.
 *
 * The DSL spells these lowercase and compact (`countnumbers`, `stddevp`); the
 * Excel-shaped API enum spells them out (`countNumbers`, `standardDeviationP`).
 * This map is the ONLY place that translation happens.
 */
const AGGREGATION_TO_FUNCTION: Record<string, AggregationFunction> = {
  sum: "sum",
  count: "count",
  average: "average",
  min: "min",
  max: "max",
  countnumbers: "countNumbers",
  stddev: "standardDeviation",
  stddevp: "standardDeviationP",
  var: "variance",
  varp: "varianceP",
  product: "product",
};

/** Every aggregation word a script may use (matches the DSL's set). */
export const PIVOT_AGGREGATIONS: ReadonlySet<string> = new Set(
  Object.keys(AGGREGATION_TO_FUNCTION),
);

/** DSL aggregation word -> AggregationFunction; null when unrecognized. */
export function aggregationToFunction(aggregation: string): AggregationFunction | null {
  return Object.prototype.hasOwnProperty.call(AGGREGATION_TO_FUNCTION, aggregation)
    ? AGGREGATION_TO_FUNCTION[aggregation]
    : null;
}

// ============================================================================
// Layout directives (the DSL's LAYOUT clause)
// ============================================================================

/**
 * Every LAYOUT directive a script may pass, in the DSL's spelling. Kept in sync
 * with the DSL's LAYOUT_DIRECTIVES set (pinned by the vocabulary test).
 */
export const PIVOT_LAYOUT_DIRECTIVES: ReadonlySet<string> = new Set([
  "compact",
  "outline",
  "tabular",
  "repeat-labels",
  "no-repeat-labels",
  "no-grand-totals",
  "no-row-totals",
  "no-column-totals",
  "grand-totals",
  "row-totals",
  "column-totals",
  "show-empty-rows",
  "show-empty-cols",
  "values-on-rows",
  "values-on-columns",
  "auto-fit",
  "subtotals-top",
  "subtotals-bottom",
  "subtotals-off",
]);

/**
 * Fold a list of DSL layout directives into ONE ExtendedLayoutConfig, applied
 * left to right (a later directive wins, exactly as the DSL compiler folds a
 * LAYOUT clause). An unknown directive is REPORTED, never silently dropped —
 * a script author must not be left staring at an unchanged pivot.
 */
export function layoutDirectivesToConfig(
  directives: readonly string[],
): { layout: ExtendedLayoutConfig; unknown: string[] } {
  const layout: ExtendedLayoutConfig = {};
  const unknown: string[] = [];
  for (const directive of directives) {
    switch (directive) {
      case "compact":
        layout.reportLayout = "compact";
        break;
      case "outline":
        layout.reportLayout = "outline";
        break;
      case "tabular":
        layout.reportLayout = "tabular";
        break;
      case "repeat-labels":
        layout.repeatRowLabels = true;
        break;
      case "no-repeat-labels":
        layout.repeatRowLabels = false;
        break;
      case "no-grand-totals":
        layout.showRowGrandTotals = false;
        layout.showColumnGrandTotals = false;
        break;
      case "grand-totals":
        layout.showRowGrandTotals = true;
        layout.showColumnGrandTotals = true;
        break;
      case "no-row-totals":
        layout.showRowGrandTotals = false;
        break;
      case "row-totals":
        layout.showRowGrandTotals = true;
        break;
      case "no-column-totals":
        layout.showColumnGrandTotals = false;
        break;
      case "column-totals":
        layout.showColumnGrandTotals = true;
        break;
      case "show-empty-rows":
        layout.showEmptyRows = true;
        break;
      case "show-empty-cols":
        layout.showEmptyCols = true;
        break;
      case "values-on-rows":
        layout.valuesPosition = "rows";
        break;
      case "values-on-columns":
        layout.valuesPosition = "columns";
        break;
      case "auto-fit":
        layout.autoFitColumnWidths = true;
        break;
      // The DSL lexer accepts these three but its compiler does not map them
      // (it warns "Unknown layout directive"). ExtendedLayoutConfig DOES carry
      // subtotalLocation, so the script surface honours them.
      case "subtotals-top":
        layout.subtotalLocation = "atTop";
        break;
      case "subtotals-bottom":
        layout.subtotalLocation = "atBottom";
        break;
      case "subtotals-off":
        layout.subtotalLocation = "off";
        break;
      default:
        unknown.push(directive);
    }
  }
  return { layout, unknown };
}
