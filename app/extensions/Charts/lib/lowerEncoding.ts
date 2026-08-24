//! FILENAME: app/extensions/Charts/lib/lowerEncoding.ts
// PURPOSE: Compile an encoding-channel spec down to the series model (C1).
// CONTEXT: The grammar-of-graphics authoring layer. `encoding` describes a chart
//          in terms of channels over a (typically long) table; this pure
//          function desugars it into the existing ChartSpec fields
//          (categoryIndex / series / transform / xAxis / yAxis) so the fixed
//          painters are untouched. `color` splits the data into one series per
//          distinct value via a pivot; without it, `y` is a single series.

import type { ChartSpec, ScaleType, TransformSpec } from "../types";

/**
 * Marks whose painter lays categories out as BANDS (createBandScale) rather than
 * as points along the axis. Taken from the painters themselves, so the scale an
 * ordinal channel declares is the scale the chart actually draws.
 */
const BAND_SCALE_MARKS = new Set([
  "bar", "horizontalBar", "waterfall", "combo", "histogram", "stock", "boxPlot", "pareto",
]);

/** Find a column index by header name (-1 if absent). */
function findColumn(headers: string[], name: string | undefined): number {
  if (!name) return -1;
  return headers.findIndex((h) => h === name);
}

/**
 * Lower an encoding spec to the series model, given the source header names
 * (one per column for "columns" orientation, per row for "rows"). Returns a new
 * spec WITHOUT `encoding`. If the spec has no encoding, it is returned as-is.
 */
export function lowerEncoding(spec: ChartSpec, headers: string[]): ChartSpec {
  const enc = spec.encoding;
  if (!enc) return spec;

  // Drop the encoding key; everything else carries over.
  const { encoding: _enc, ...rest } = spec;
  const out: ChartSpec = { ...rest };

  const x = enc.x;
  const y = enc.y;
  const color = enc.color;
  const size = enc.size;
  const order = enc.order;

  // ── Axes from x / y channels ──
  out.xAxis = { ...spec.xAxis };
  out.yAxis = { ...spec.yAxis };
  if (x && x.title !== undefined) out.xAxis.title = x.title;
  if (y && y.title !== undefined) out.yAxis.title = y.title;

  if (y?.scale) out.yAxis.scale = y.scale;

  const op = y?.aggregate;
  let transforms: TransformSpec[] = [...(spec.transform ?? [])];

  if (color?.field && x?.field && y?.field) {
    // ── Long data → wide series via pivot (one series per color value). ──
    out.categoryIndex = 0;
    out.series = [];
    transforms = [
      { type: "pivot", category: x.field, key: color.field, value: y.field, op: op ?? "sum" },
      ...transforms,
    ];
  } else {
    out.categoryIndex = findColumn(headers, x?.field) >= 0 ? findColumn(headers, x?.field) : spec.categoryIndex;

    const yIdx = findColumn(headers, y?.field);
    const sizeIdx = findColumn(headers, size?.field);

    if (size?.field && yIdx >= 0 && sizeIdx >= 0) {
      // ── Size channel → bubble: y series + size series, size drives radius. ──
      out.mark = "bubble";
      out.series = [
        { name: y?.field ?? "Value", sourceIndex: yIdx, color: null },
        { name: size.field, sourceIndex: sizeIdx, color: null },
      ];
      out.markOptions = { ...(spec.markOptions ?? {}), sizeSeriesIndex: 1 } as ChartSpec["markOptions"];
    } else {
      // ── Single value series. ──
      out.series = yIdx >= 0
        ? [{ name: y?.field ?? "Value", sourceIndex: yIdx, color: null }]
        : spec.series;
      if (op && y?.field) {
        // Group by category and aggregate the single value series.
        transforms.unshift({ type: "aggregate", groupBy: ["$category"], op, field: y.field, as: y.field });
      }
    }
  }

  // ── X scale from the x channel. ──
  // Resolved down here, after the mark is settled: the ordinal/nominal case picks
  // band vs point from the FINAL mark, and the size channel above can still have
  // turned the chart into a bubble.
  if (x?.scale) out.xAxis.scale = x.scale;
  else if (x?.type === "temporal" || x?.timeUnit) out.xAxis.scale = { type: "time" };
  else if (x?.type === "quantitative") out.xAxis.scale = { type: "linear" };
  else if (x?.type === "ordinal" || x?.type === "nominal" || x?.customOrder !== undefined) {
    // Ordinal and nominal are both categorical — evenly spaced labels in the
    // data's order — and differ only in whether that order carries meaning, which
    // `customOrder` below is what expresses. Naming the scale is what makes the
    // declaration act rather than decorate: it PINS the axis, so category labels
    // that happen to parse as numbers or dates are not silently re-spaced onto a
    // value axis (resolveScatterXAxis).
    const categorical: ScaleType = BAND_SCALE_MARKS.has(out.mark) ? "band" : "point";
    out.xAxis.scale = { type: categorical };
  }

  // ── Ordinal domain order → sort the categories by the declared list. ──
  // Pushed before the order channel so that an explicit `order` — the channel
  // whose whole job is sorting — still wins; the sort is stable, so ties within
  // it keep the domain order rather than falling back to source order.
  if (x?.customOrder !== undefined) {
    transforms.push({ type: "sort", field: "$category", customOrder: x.customOrder });
  }

  // ── Order channel → sort the resulting data. ──
  if (order?.field) {
    transforms.push({ type: "sort", field: order.field, order: order.sort ?? "asc" });
  }

  if (transforms.length > 0) out.transform = transforms;

  return out;
}
