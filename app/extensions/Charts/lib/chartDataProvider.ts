//! FILENAME: app/extensions/Charts/lib/chartDataProvider.ts
// PURPOSE: Charts' implementation of the `@api/chartData` seam — the chart's
//          numbers, made reachable from outside the Charts extension.
// CONTEXT: A chart's resolution only exists in TypeScript, inside this
//          extension: the pivot source, the design query, the transforms, the
//          filters, the params. So the seam runs the other way from most —
//          Charts RESOLVES and the analysis happens elsewhere, on the result.
//
//          THE ONE THING THIS FILE EXISTS FOR IS `null`.
//
//          `chartDataReader` reads FORMATTED DISPLAY STRINGS and coerces
//          anything it cannot parse to zero (`isNaN(num) ? 0 : num`, twice, in
//          parseColumnOriented / parseRowOriented). For DRAWING that is right:
//          a bar of height 0 is a reasonable picture of a cell with nothing in
//          it. For COMPUTING it is a lie of the worst kind, because it is
//          silent — a blank month arrives as a real 0, the mean drops, the
//          trend line bends, and a fact says "revenue collapsed in March" about
//          a month nobody has typed yet. Text and error cells do the same.
//
//          So for the case where it is possible — a plain cell range with no
//          transform, facet or concat between the cells and the picture — this
//          provider throws away the reader's numbers and RE-READS THE SOURCE
//          RANGE TYPED (`getRangeCellsTyped`, which carries the engine's own
//          `type` field). A cell that is not a number becomes `null`, never 0.
//
//          Pivot- and design-query-backed charts have no source cells to
//          re-read: their numbers are aggregates computed by the pivot engine
//          or the BI model. Those keep the resolved values and say so in
//          `assumptions`, so a downstream fact can hedge instead of guessing.

import { getRangeCellsTyped, type TypedCellData } from "@api/lib";
import {
  CHART_SERIES_MAX_POINTS,
  type ChartDataProvider,
  type ChartDataSummary,
  type ChartSeriesSnapshot,
} from "@api/chartData";

import { getAllCharts, getChartById } from "./chartStore";
import { readChartDataResolved } from "./chartDataReader";
import { resolveDataSource } from "./dataSourceResolver";
import { getCurrentChartId } from "../handlers/selectionHandler";
import { isDesignQueryDataSource, isPivotDataSource } from "../types";
import type { ChartSpec, ParsedChartData } from "../types";

// ============================================================================
// Public shape
// ============================================================================

/** Where a series' numbers physically live, so a fact can point at the cells. */
type SeriesEvidence = NonNullable<ChartSeriesSnapshot["series"][number]["evidence"]>;

/**
 * A snapshot whose caveats are always present rather than optional.
 *
 * `assumptions` now lives on `ChartSeriesSnapshot` in `@api/chartData`, where it
 * belongs: the caveat has to travel with the numbers, because the code that
 * turns them into a sentence is the code that has to hedge. This alias only
 * narrows the seam's optional field to a required one for this file's own
 * construction sites, so a new return path cannot forget it.
 *
 * The caveats are not decoration. "These values were re-read typed" and "these
 * values came from a pivot aggregate that may have coerced a blank to zero" are
 * different epistemic positions, and a fact built on the second must say so.
 */
export interface ChartSeriesSnapshotWithAssumptions extends ChartSeriesSnapshot {
  readonly assumptions: readonly string[];
}

// ============================================================================
// Summaries
// ============================================================================

function sourceKindOf(spec: ChartSpec): ChartDataSummary["sourceKind"] {
  // Concat is checked FIRST: a container's own `data` is ignored by the reader,
  // so reporting it as a range would name a source nothing reads.
  if (spec.concat && spec.concat.charts.length > 0) return "concat";
  if (isPivotDataSource(spec.data)) return "pivot";
  if (isDesignQueryDataSource(spec.data)) return "designQuery";
  return "range";
}

/** A non-blank title, or null. A blank title is absence, not an empty label. */
function titleOf(spec: ChartSpec): string | null {
  const t = spec.title;
  return typeof t === "string" && t.trim() !== "" ? t : null;
}

function listCharts(sheetIndex?: number): ChartDataSummary[] {
  const out: ChartDataSummary[] = [];
  for (const chart of getAllCharts()) {
    // Same guard the pivot-refresh handler uses: during create/delete/undo churn
    // the store can briefly hand back an entry whose spec is not yet populated.
    // A spec-less entry has nothing to summarise, so skip it rather than throw
    // inside whatever is enumerating charts.
    if (!chart.spec) continue;
    if (sheetIndex !== undefined && chart.sheetIndex !== sheetIndex) continue;
    out.push({
      chartId: chart.chartId,
      name: chart.name,
      title: titleOf(chart.spec),
      sheetIndex: chart.sheetIndex,
      mark: chart.spec.mark,
      sourceKind: sourceKindOf(chart.spec),
    });
  }
  return out;
}

// ============================================================================
// The typed re-read
// ============================================================================

/** Key a sparse typed read by absolute cell address. */
function addr(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * The engine's own answer for "is there a number in this cell".
 *
 * `undefined` means the cell was absent from the read — `get_range_cells_typed`
 * returns a SPARSE list, so an empty cell simply is not there. Everything that
 * is not a finite number — text, boolean, error, empty — is `null`. This is the
 * single line that the whole module is built around; changing it to fall back
 * to 0 re-introduces the defect described in the file header.
 */
function numberOrNull(cell: TypedCellData | undefined): number | null {
  if (!cell) return null;
  if (cell.type !== "number") return null;
  return typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
}

/**
 * True when the chart's numbers can be traced back to individual source cells.
 *
 * A transform rebuilds the series set (an aggregate/pivot/fold step can produce
 * values that exist in no cell at all), a facet partitions the rows into panels
 * the top-level series no longer describes, and a concat container has no series
 * of its own. In any of those cases position (series index, category index) no
 * longer names a cell, so re-reading by position would be worse than the
 * display-string parse: confidently wrong instead of merely coarse.
 */
function isTraceableToCells(spec: ChartSpec): boolean {
  if (isPivotDataSource(spec.data) || isDesignQueryDataSource(spec.data)) return false;
  if (spec.transform && spec.transform.length > 0) return false;
  if (spec.facet?.field) return false;
  if (spec.concat && spec.concat.charts.length > 0) return false;
  return true;
}

/**
 * Re-read the chart's source range typed, laid out to match the RESOLVED data.
 *
 * The resolved data may be shorter than the source: a category filter, a series
 * filter or a click-to-keep selection drops entries and records what survived in
 * `keptCategoryIndices` / `keptSeriesIndices` (painter index -> authoring
 * index). Walking those maps is what keeps `values[i]` aligned with
 * `categories[i]` — reading the source in source order and hoping the lengths
 * match would silently shift every value by the number of hidden categories.
 *
 * Returns null when the spec and the resolved data cannot be lined up (a series
 * the spec no longer declares), so the caller falls back rather than inventing
 * an alignment.
 */
async function readTypedSeries(
  spec: ChartSpec,
  data: ParsedChartData,
): Promise<{ values: (number | null)[][]; evidence: SeriesEvidence[] } | null> {
  const ref = await resolveDataSource(spec.data);
  const cells = await getRangeCellsTyped(
    ref.startRow,
    ref.startCol,
    ref.endRow,
    ref.endCol,
    ref.sheetIndex,
  );

  const byAddr = new Map<string, TypedCellData>();
  for (const cell of cells) byAddr.set(addr(cell.row, cell.col), cell);

  const columns = spec.seriesOrientation !== "rows";
  // Same offset the reader uses: a header row/column is not data.
  const dataStart = spec.hasHeaders ? 1 : 0;

  const values: (number | null)[][] = [];
  const evidence: SeriesEvidence[] = [];

  for (let si = 0; si < data.series.length; si++) {
    const authoringSeries = data.keptSeriesIndices ? data.keptSeriesIndices[si] : si;
    const def = spec.series[authoringSeries];
    if (!def) return null;

    const row: (number | null)[] = [];
    for (let ci = 0; ci < data.categories.length; ci++) {
      const authoringCategory = data.keptCategoryIndices ? data.keptCategoryIndices[ci] : ci;
      const cellRow = columns
        ? ref.startRow + dataStart + authoringCategory
        : ref.startRow + def.sourceIndex;
      const cellCol = columns
        ? ref.startCol + def.sourceIndex
        : ref.startCol + dataStart + authoringCategory;
      row.push(numberOrNull(byAddr.get(addr(cellRow, cellCol))));
    }
    values.push(row);

    // The series' full extent in the sheet — the column (columns orientation) or
    // the row (rows orientation) it was read from, minus the header cell.
    evidence.push(
      columns
        ? {
            sheetIndex: ref.sheetIndex,
            startRow: ref.startRow + dataStart,
            startCol: ref.startCol + def.sourceIndex,
            endRow: ref.endRow,
            endCol: ref.startCol + def.sourceIndex,
          }
        : {
            sheetIndex: ref.sheetIndex,
            startRow: ref.startRow + def.sourceIndex,
            startCol: ref.startCol + dataStart,
            endRow: ref.startRow + def.sourceIndex,
            endCol: ref.endCol,
          },
    );
  }

  return { values, evidence };
}

// ============================================================================
// Stride sampling
// ============================================================================

/**
 * Indices of an evenly-spaced sample of `length` points, first and last kept.
 *
 * Returns null when nothing needs dropping. The step is `(n - 1) / (cap - 1)`,
 * so index 0 and index n-1 fall out exactly — a downsampled series still starts
 * and ends where the chart does, which is what "the value went from X to Y"
 * depends on. The step is always > 1 here (n > cap), so the rounded indices are
 * strictly increasing and no point is emitted twice.
 */
export function strideIndices(length: number, cap: number): number[] | null {
  if (cap <= 0 || length <= cap) return null;
  if (cap === 1) return [0];
  const step = (length - 1) / (cap - 1);
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(Math.round(i * step));
  out[out.length - 1] = length - 1;
  return out;
}

function pick<T>(source: readonly T[], indices: readonly number[]): T[] {
  return indices.map((i) => source[i]);
}

// ============================================================================
// resolveSeries
// ============================================================================

const PIVOT_ASSUMPTION =
  "Values come from the pivot/BI aggregate the chart renders, not from source cells; " +
  "they cannot be re-read typed, so a blank or non-numeric input may already have " +
  "been folded into an aggregate as zero.";

const COMPOSED_ASSUMPTION =
  "The chart transforms or facets its data before drawing, so a value no longer " +
  "corresponds to one source cell; values come from the rendered result, where an " +
  "unparseable cell reads as zero.";

const REREAD_FAILED_ASSUMPTION =
  "The source range could not be re-read typed, so values come from the rendered " +
  "result, where an unparseable cell reads as zero.";

async function resolveSeries(
  chartId: string,
  maxPoints: number,
): Promise<ChartSeriesSnapshotWithAssumptions | null> {
  const chart = getChartById(chartId);
  if (!chart?.spec) return null;

  // A concat container tiles independent child charts; it has no series set of
  // its own (its top-level `series` is always empty). Answer null so the caller
  // can say "pick one of its child charts" instead of analysing an empty set.
  if (chart.spec.concat && chart.spec.concat.charts.length > 0) return null;

  const resolved = await readChartDataResolved(chart.spec, 0, chartId);
  const spec = resolved.spec;
  const data = resolved.data;
  if (data.concat && data.concat.length > 0) return null;

  const assumptions: string[] = [];

  // Start from the reader's numbers, then replace them when a typed re-read is
  // possible. `NaN`/`Infinity` cannot survive the JSON hop to an analysis, and
  // an absent point is what they actually mean, so they become null here too.
  let values: (number | null)[][] = data.series.map((s) =>
    s.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
  );
  let evidence: SeriesEvidence[] | null = null;

  if (isTraceableToCells(spec)) {
    try {
      const typed = await readTypedSeries(spec, data);
      if (typed) {
        values = typed.values;
        evidence = typed.evidence;
      } else {
        assumptions.push(REREAD_FAILED_ASSUMPTION);
      }
    } catch {
      // A named range that no longer resolves, a sheet that has been deleted, a
      // backend that refused the read. The chart still drew something, so return
      // that rather than nothing — flagged, so nobody treats it as measured.
      assumptions.push(REREAD_FAILED_ASSUMPTION);
    }
  } else if (isPivotDataSource(spec.data) || isDesignQueryDataSource(spec.data)) {
    assumptions.push(PIVOT_ASSUMPTION);
  } else {
    assumptions.push(COMPOSED_ASSUMPTION);
  }

  // Sampling happens LAST so it applies to whichever numbers won above, and to
  // the categories and their typed positions in lockstep.
  const cap = Number.isFinite(maxPoints) && maxPoints > 0
    ? Math.floor(maxPoints)
    : CHART_SERIES_MAX_POINTS;
  const indices = strideIndices(data.categories.length, cap);

  const categories = indices ? pick(data.categories, indices) : [...data.categories];
  const rawCategoryValues = data.categoryField?.values;
  const categoryValues = rawCategoryValues
    ? indices
      ? pick(rawCategoryValues, indices)
      : [...rawCategoryValues]
    : undefined;

  const snapshot: ChartSeriesSnapshotWithAssumptions = {
    chartId,
    name: chart.name,
    title: titleOf(spec),
    sheetIndex: chart.sheetIndex,
    mark: spec.mark,
    categories,
    categoryKind: data.categoryField?.type ?? "nominal",
    ...(categoryValues ? { categoryValues } : {}),
    series: data.series.map((s, si) => ({
      name: s.name,
      values: indices ? pick(values[si] ?? [], indices) : [...(values[si] ?? [])],
      // Evidence is emitted ONLY on the typed path. On every other path the
      // (series, category) position does not name a cell, and evidence that
      // points at the wrong cells is worse than none.
      ...(evidence ? { evidence: evidence[si] } : {}),
    })),
    truncated: indices !== null,
    assumptions,
  };
  return snapshot;
}

// ============================================================================
// The provider
// ============================================================================

/**
 * Registered by the Charts extension in `activate()` and withdrawn (null) in
 * `deactivate()`, exactly like `chartParamController`. `@api` imports no
 * extension; the extension pushes its implementation in.
 */
export const chartDataProvider: ChartDataProvider = {
  listCharts,
  resolveSeries,
  getSelectedChartId: () => getCurrentChartId(),
};
