//! FILENAME: app/extensions/Charts/lib/designQuerySeriesBinding.ts
// PURPOSE: Which model measure a design-query chart's plotted series is —
//          pure, so the rule is testable without a model or a backend.
// CONTEXT: `extractChartData` names a series from the pivot view's column
//          headers: a lone value field is captioned by its measure (or its
//          `customName`), and a value field under column fields is captioned
//          "<member> - <measure>" with the parts joined by " - " (see
//          `extractColumnNames` in pivotChartDataReader.ts). The insights
//          route needs the reverse map so a fact about series "West - Cost"
//          can carry Cost's declared direction.
//
//          THE MATCH IS EXACT OR BY LAST PART, NEVER BY SUBSTRING. A measure
//          called "Cost" must not claim a series called "Cost of Sales" — a
//          direction on the wrong series is the wrong-coloured ring.

/** One value field as the compiled design query names it. */
export interface ValueFieldCaption {
  measureName: string;
  customName?: string;
}

const JOINER = " - ";

function captionOf(field: ValueFieldCaption): string {
  return field.customName && field.customName.trim() !== "" ? field.customName : field.measureName;
}

/**
 * Bind plotted series names to measures. A series that matches no field, or
 * matches two, is left out: no binding is better than a guessed one.
 */
export function bindSeriesToMeasures(
  seriesNames: readonly string[],
  valueFields: readonly ValueFieldCaption[],
): Array<{ series: string; measure: string }> {
  const out: Array<{ series: string; measure: string }> = [];
  for (const series of seriesNames) {
    const lastPart = series.includes(JOINER) ? series.slice(series.lastIndexOf(JOINER) + JOINER.length) : series;
    const matches = valueFields.filter((f) => {
      const caption = captionOf(f);
      return series === caption || lastPart === caption;
    });
    if (matches.length !== 1) continue;
    out.push({ series, measure: matches[0].measureName });
  }
  return out;
}
