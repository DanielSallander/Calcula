//! FILENAME: app/extensions/Charts/lib/chartSpecDefaults.ts
// PURPOSE: THE default skeleton every new chart starts from, and the specs built
//          from it: a range chart (`buildDefaultSpec`) and a design-query chart
//          a caller OUTSIDE Charts asks for (`buildDesignQueryChartSpec`, behind
//          the @api chart store seam `IChartStoreService.buildDesignQueryChartSpec`).
// CONTEXT: A copied recipe is a second source of truth that drifts on the
//          owner's first default change (CLAUDE.md, the Seam Rule). The
//          drill-through runner (_shared/drillThrough/runDrillThrough.ts) used
//          to hand-copy this file's axes, legend and palette literals, because
//          Charts/lib is not importable from _shared; it now says WHAT it wants
//          through the seam and Charts decides HOW, from the SAME skeleton
//          `buildDefaultSpec` builds from. So a default changed here reaches
//          every new range spec and every drill chart together, and
//          chartSpecDefaults.test.ts pins the seam's output against the WHOLE
//          schema (not a hand-written key list) for every built-in mark.

import type {
  ChartMark,
  ChartSeries,
  ChartSpec,
  ChartType,
  DataRangeRef,
  MarkOptions,
  SeriesOrientation,
} from "../types";
import { markFurniture } from "../types";

/** The structural fields of a new chart that are not its data, its series or its mark. */
export type ChartSkeleton = Pick<
  ChartSpec,
  "hasHeaders" | "seriesOrientation" | "categoryIndex" | "title" | "xAxis" | "yAxis" | "legend" | "palette"
>;

/**
 * THE default skeleton of a new chart of `mark`: headers on, series in
 * columns, the first column as the categories, no title, an X axis without
 * gridlines and a Y axis with them, the default palette, and a legend at the
 * bottom -- shown only for a mark that HAS a legend. A Card / Multi-row card /
 * KPI / Gauge tile draws none (`markFurniture` "titleOnly"), so starting it
 * "on" would only write a setting the painter never reads; the Insert Chart
 * dialog starts a new tile the same way (createChartDialogSkeleton.test.tsx
 * holds the two together).
 *
 * A FRESH object on every call: callers own what they get and may change it.
 */
export function defaultChartSkeleton(mark: ChartMark): ChartSkeleton {
  return {
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    title: null,
    xAxis: {
      title: null,
      gridLines: false,
      showLabels: true,
      labelAngle: 0,
      min: null,
      max: null,
    },
    yAxis: {
      title: null,
      gridLines: true,
      showLabels: true,
      labelAngle: 0,
      min: null,
      max: null,
    },
    legend: {
      visible: markFurniture(mark) === "full",
      position: "bottom",
    },
    palette: "default",
  };
}

/**
 * Build a default ChartSpec from a data range and auto-detected series: the
 * skeleton for `mark` with the range, the header flag and the detection laid
 * over it.
 */
export function buildDefaultSpec(
  dataRange: DataRangeRef,
  hasHeaders: boolean,
  autoDetected: {
    categoryIndex: number;
    series: ChartSeries[];
    orientation: SeriesOrientation;
  },
  mark: ChartType = "bar",
): ChartSpec {
  return {
    ...defaultChartSkeleton(mark),
    mark,
    data: dataRange,
    hasHeaders,
    seriesOrientation: autoDetected.orientation,
    categoryIndex: autoDetected.categoryIndex,
    series: autoDetected.series,
  };
}

/**
 * What a caller outside Charts asks for when it wants a design-query chart:
 * the @api seam's request (`IChartStoreService.buildDesignQueryChartSpec`).
 * WHAT it wants -- never how a chart spec is laid out.
 */
export interface DesignQueryChartRequest {
  /** The design-query DSL the chart runs (a drill-through passes its BAKED text). */
  dslText: string;
  /** The BI connection the query runs against. */
  connectionId: string;
  /** The chart's mark: a built-in or a registered custom mark id. */
  mark: string;
  /** The mark's options, exactly as a ChartSpec carries them for that mark. */
  markOptions?: Record<string, unknown>;
  /** The chart's title. */
  title: string;
}

/**
 * The COMPLETE spec of a design-query chart a caller outside Charts asks for
 * -- today the drill-through's result chart (docs/design/model-drillthrough.md
 * 2.8): the default skeleton for the mark, a design-query source holding the
 * text and the connection, NO series (a design query's measures are its
 * series), the mark, a copy of its options, and the title.
 *
 * PURE: nothing is validated, created or stored. The caller runs the seam's
 * `validateChartSpec` on the result BEFORE it commits to anything a refused
 * create would leave behind (an empty temporary canvas), and creates with
 * `createChart`, which validates the same spec again.
 *
 * No `packageDataSourceId`: Rust stamps the application connection's stable key
 * at the serialization boundary (`collect_charts_for_save`) from the LIVE
 * connection, for every chart however it was made.
 */
export function buildDesignQueryChartSpec(req: DesignQueryChartRequest): ChartSpec {
  const spec: ChartSpec = {
    ...defaultChartSkeleton(req.mark),
    mark: req.mark,
    data: { type: "designQuery", dslText: req.dslText, connectionId: req.connectionId },
    series: [],
    title: req.title,
  };
  if (req.markOptions !== undefined) {
    // A COPY: the options belong to a definition another object owns (a
    // chart's drillThrough, a pivot's drill behaviour), and the new chart's
    // later edits must never reach back into it.
    spec.markOptions = JSON.parse(JSON.stringify(req.markOptions)) as MarkOptions;
  }
  return spec;
}
