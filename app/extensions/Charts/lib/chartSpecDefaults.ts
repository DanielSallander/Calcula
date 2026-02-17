//! FILENAME: app/extensions/Charts/lib/chartSpecDefaults.ts
// PURPOSE: Build default chart specs for new charts.
// CONTEXT: Called when the user creates a new chart to generate a sensible
//          starting configuration based on the data range and auto-detected series.

import type {
  ChartSpec,
  ChartSeries,
  DataRangeRef,
  SeriesOrientation,
} from "../types";

/**
 * Build a default ChartSpec from a data range and auto-detected series.
 */
export function buildDefaultSpec(
  dataRange: DataRangeRef,
  hasHeaders: boolean,
  autoDetected: {
    categoryIndex: number;
    series: ChartSeries[];
    orientation: SeriesOrientation;
  },
): ChartSpec {
  return {
    mark: "bar",
    data: dataRange,
    hasHeaders,
    seriesOrientation: autoDetected.orientation,
    categoryIndex: autoDetected.categoryIndex,
    series: autoDetected.series,
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
      visible: true,
      position: "bottom",
    },
    palette: "default",
  };
}
