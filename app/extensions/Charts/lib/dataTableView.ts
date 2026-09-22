//! FILENAME: app/extensions/Charts/lib/dataTableView.ts
// PURPOSE: The data a chart's DATA TABLE displays, which is not always the data
//          the chart was given.
// CONTEXT: Sibling of lib/datumAddress.ts and exactly the same rule in a second
//          place: two marks paint from a DERIVED view of their data, so anything
//          that describes what was painted has to speak that view.

import type { ChartSpec, ParsedChartData } from "../types";
import { paretoResolveView } from "../rendering/paretoChartPainter";
import { histogramResolveView } from "../rendering/histogramChartPainter";

/**
 * The rows and columns the data table under `spec`'s plot must show.
 *
 * A data table is a transcript of what the plot draws — Excel's `xlDataTable` is
 * one row per plotted series and one column per plotted category — so a mark
 * that plots a DERIVED view has to hand that view to the table as well:
 *
 *   - **histogram**: the datums are BINS. The layout already reserves its band
 *     from `histogramResolveView` (one "Frequency" series), so painting the
 *     table from the raw rows reserved `(1 + 1) * 18 + 4 = 40px` and drew an
 *     `(N + 1) * 18` grid into it — 32px of overrun onto the x-axis title for a
 *     three-series source, or straight off the bottom edge. The header row also
 *     printed the SOURCE ROW labels, which name nothing on a histogram, while
 *     `specForMarkPaint` had already taken the bin labels away from the painter.
 *   - **pareto**: the bars are sorted DESCENDING, and the tick labels that
 *     carried that order are suppressed while the table is on. The header row
 *     therefore has to be the sorted labels; printing `data.categories` put "A"
 *     under the bar for B.
 *
 * Every other mark plots its data as given and gets `data` back unchanged, so
 * this costs nothing on the ordinary path.
 *
 * Pure. `data` is the chart's parsed data as the painter received it.
 */
export function chartDataTableView(spec: ChartSpec, data: ParsedChartData): ParsedChartData {
  if (spec.mark === "pareto") return paretoResolveView(data);
  if (spec.mark === "histogram") return histogramResolveView(data, spec);
  return data;
}
