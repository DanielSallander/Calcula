//! FILENAME: app/extensions/Charts/lib/lowerEncoding.ts
// PURPOSE: Compile an encoding-channel spec down to the series model (C1).
// CONTEXT: The grammar-of-graphics authoring layer. `encoding` describes a chart
//          in terms of channels over a (typically long) table; this pure
//          function desugars it into the existing ChartSpec fields
//          (categoryIndex / series / transform / xAxis / yAxis) so the fixed
//          painters are untouched. `color` splits the data into one series per
//          distinct value via a pivot; without it, `y` is a single series.

import type { ChartSpec, TransformSpec } from "../types";

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

  // ── Axes from x / y channels ──
  out.xAxis = { ...spec.xAxis };
  out.yAxis = { ...spec.yAxis };
  if (x && x.title !== undefined) out.xAxis.title = x.title;
  if (y && y.title !== undefined) out.yAxis.title = y.title;

  if (x?.scale) out.xAxis.scale = x.scale;
  else if (x?.type === "temporal" || x?.timeUnit) out.xAxis.scale = { type: "time" };
  else if (x?.type === "quantitative") out.xAxis.scale = { type: "linear" };

  if (y?.scale) out.yAxis.scale = y.scale;

  const op = y?.aggregate;

  if (color?.field && x?.field && y?.field) {
    // ── Long data → wide series via pivot (one series per color value). ──
    out.categoryIndex = 0;
    out.series = [];
    out.transform = [
      { type: "pivot", category: x.field, key: color.field, value: y.field, op: op ?? "sum" },
      ...(spec.transform ?? []),
    ];
    return out;
  }

  // ── Single value series. ──
  const catIdx = findColumn(headers, x?.field);
  const yIdx = findColumn(headers, y?.field);

  out.categoryIndex = catIdx >= 0 ? catIdx : spec.categoryIndex;
  out.series = yIdx >= 0
    ? [{ name: y?.field ?? "Value", sourceIndex: yIdx, color: null }]
    : spec.series;

  const transforms: TransformSpec[] = [...(spec.transform ?? [])];
  if (op && y?.field) {
    // Group by category and aggregate the single value series.
    transforms.unshift({ type: "aggregate", groupBy: ["$category"], op, field: y.field, as: y.field });
  }
  if (transforms.length > 0) out.transform = transforms;

  return out;
}
