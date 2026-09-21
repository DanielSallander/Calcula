//! FILENAME: app/extensions/Charts/lib/datumAddress.ts
// PURPOSE: Translate a HIT-SPACE datum (the indices the selection ladder
//          carries, taken straight off the hit geometry) into the address the
//          PAINTER resolves per-point overrides at.
// CONTEXT: Read by the Format pane's write/read path. The painters are the
//          other end of the same contract.

import type { ChartSpec, ParsedChartData } from "../types";
import { paretoResolveView } from "../rendering/paretoChartPainter";
import { histogramResolveView } from "../rendering/histogramChartPainter";

/**
 * Where ONE datum's override lives: the data the painter resolves it against,
 * plus the painter-space index pair inside that view.
 */
export interface DatumAddress {
  /** The data `resolveDatumStyle` is called with for this datum. */
  view: ParsedChartData;
  seriesIndex: number;
  categoryIndex: number;
}

/**
 * Marks whose geometry stamps the CATEGORY into `seriesIndex` because the mark
 * is single-series and "a slice IS its category" — the convention
 * `hitTestSliceArcs`, `geometryHasDatum` and the keyboard walk all share.
 *
 * Their painters resolve every datum at series 0, which is the honest address
 * (`data.series[0]` is the only series there is). The two spellings are both
 * deliberate and they disagreed: the pane wrote the override at `(i, i)` while
 * the painter read `(0, i)`, so every datum after the first silently discarded
 * the colour the reader picked — and the pane went on SHOWING it, because it
 * read the override back at the same wrong address. Slice 0 worked by
 * coincidence, which is exactly why it survived a spot check.
 */
const CATEGORY_AS_SERIES_MARKS = new Set(["pie", "donut", "funnel", "treemap", "sunburst"]);

/**
 * The painter's override address for a hit-space datum.
 *
 * THE RULE: a per-point override is addressed the way the PAINTER addresses
 * it, never the way the hit geometry happens to be indexed. The hit geometry
 * exists to answer "which datum is under this pixel"; some marks encode that
 * answer in a shape the data model does not share (a radial mark walks its
 * categories through `seriesIndex`; a Pareto chart RE-SORTS its bars; a
 * histogram's datums are bins, not source rows). Every one of those is a place
 * where the write path and the paint path can name different datums, and each
 * time they do the reader sets a colour, the control insists it is set, and the
 * chart never changes.
 *
 * Pure. `data` is the chart's parsed data as the painter received it.
 */
export function datumAddress(
  spec: ChartSpec,
  data: ParsedChartData,
  hitSeriesIndex: number,
  hitCategoryIndex: number,
): DatumAddress {
  // A Pareto chart paints its bars in DESCENDING value order, so bar `i` is
  // sorted position `i` and its label is the sorted label. Stamping the key
  // from `data.categories[i]` named a different bar, and `buildOverrideIndex`
  // then honoured that key onto it.
  if (spec.mark === "pareto") {
    return { view: paretoResolveView(data), seriesIndex: 0, categoryIndex: hitCategoryIndex };
  }

  // A histogram's bars are BINS. The raw rows are not datums, so the key has to
  // be stamped from the binned view the painter resolves against.
  if (spec.mark === "histogram") {
    return { view: histogramResolveView(data, spec), seriesIndex: 0, categoryIndex: hitCategoryIndex };
  }

  if (CATEGORY_AS_SERIES_MARKS.has(spec.mark)) {
    return { view: data, seriesIndex: 0, categoryIndex: hitCategoryIndex };
  }

  return { view: data, seriesIndex: hitSeriesIndex, categoryIndex: hitCategoryIndex };
}
