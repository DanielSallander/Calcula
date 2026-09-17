//! FILENAME: app/extensions/Charts/rendering/cuePainter.ts
// PURPOSE: Turn a data-anchored insight cue into a mark on the chart, through
//          the same hit geometry that tooltips and selection use.
// CONTEXT: IO-0 of docs/design/insight-overlays.md — the placement spike. The
//          one genuinely new thing in that milestone is putting a ring on the
//          RIGHT bar, and this file is where that is decided. Two halves:
//
//          `resolveCueTarget` is PURE: (geometry, anchor) -> the rect, point or
//          arc the cue lands on, or a refusal with a reason. It never guesses.
//          The anchor names a series and a painter-space category index and
//          carries the label the fact used; the geometry the painters computed
//          carries the series name and category label of every datum. When
//          they disagree — a filter hid a category and someone handed over an
//          authoring-space index, or the data changed under a cached bundle —
//          the cue is dropped, because a ring on the wrong bar is the most
//          invisible wrong answer this feature can give.
//
//          `paintChartCues` draws what resolved, at composite time over the
//          cached raster, exactly where selection highlights are drawn. It
//          decides HOW a ring looks on each mark (an ellipse round a bar, a
//          circle round a point, an arc along a slice); the caller only said
//          WHICH datum. Nothing here writes to the spec.

import type { ChartCue, ChartCueDatumAnchor, ChartCuePolarity } from "@api/chartCues";
import type { BarRect, HitGeometry, ParsedChartData, PointMarker, SliceArc } from "../types";

// ============================================================================
// Resolution (pure)
// ============================================================================

export type CueTarget =
  | { kind: "rect"; rect: BarRect }
  | { kind: "point"; marker: PointMarker }
  | { kind: "slice"; arc: SliceArc };

export type CueRefusal =
  | "no-such-datum"
  | "label-mismatch"
  | "series-not-drawn";

export type CueResolution =
  | { ok: true; target: CueTarget }
  | { ok: false; reason: CueRefusal };

/** What the resolver needs to know about the data besides the geometry. */
export interface CueDataContext {
  /** Painter-space series names, in draw order. */
  seriesNames: readonly string[];
}

function fromBars(rects: readonly BarRect[], a: ChartCueDatumAnchor): CueResolution | null {
  const rect = rects.find((r) => r.seriesName === a.series && r.categoryIndex === a.categoryIndex);
  if (!rect) return null;
  if (rect.categoryName !== a.categoryLabel) return { ok: false, reason: "label-mismatch" };
  return { ok: true, target: { kind: "rect", rect } };
}

function fromPoints(markers: readonly PointMarker[], a: ChartCueDatumAnchor): CueResolution | null {
  const marker = markers.find((m) => m.seriesName === a.series && m.categoryIndex === a.categoryIndex);
  if (!marker) return null;
  if (marker.categoryName !== a.categoryLabel) return { ok: false, reason: "label-mismatch" };
  return { ok: true, target: { kind: "point", marker } };
}

/**
 * A pie draws only the FIRST series; its arcs carry the slice index in
 * `seriesIndex` and the category label in `label`. A cue about any other
 * series has no slice to land on, and saying so beats ringing the wrong one.
 */
function fromSlices(
  arcs: readonly SliceArc[],
  a: ChartCueDatumAnchor,
  ctx: CueDataContext,
): CueResolution | null {
  if (ctx.seriesNames[0] !== a.series) return { ok: false, reason: "series-not-drawn" };
  const arc = arcs.find((s) => s.seriesIndex === a.categoryIndex);
  if (!arc) return null;
  if (arc.label !== a.categoryLabel) return { ok: false, reason: "label-mismatch" };
  return { ok: true, target: { kind: "slice", arc } };
}

function resolveIn(geometry: HitGeometry, a: ChartCueDatumAnchor, ctx: CueDataContext): CueResolution | null {
  switch (geometry.type) {
    case "bars":
      return fromBars(geometry.rects, a);
    case "points":
      return fromPoints(geometry.markers, a);
    case "slices":
      return fromSlices(geometry.arcs, a, ctx);
    case "composite": {
      // Combo / pareto / repeat / facet: the first group that KNOWS the datum
      // answers, whether it accepts or refuses. A group that merely lacks it
      // (the line half of a combo, for a bar-series cue) is skipped.
      for (const g of geometry.groups) {
        const r = resolveIn(g, a, ctx);
        if (r) return r;
      }
      return null;
    }
  }
}

/**
 * Where a cue lands, or why it does not. Pure; safe to call per frame.
 *
 * Match rule: series by NAME and category by painter-space INDEX; then the
 * datum's own label must equal the label the fact used, or the cue is refused.
 */
export function resolveCueTarget(
  geometry: HitGeometry,
  anchor: ChartCueDatumAnchor,
  ctx: CueDataContext,
): CueResolution {
  return resolveIn(geometry, anchor, ctx) ?? { ok: false, reason: "no-such-datum" };
}

/** The data context the painter needs, from the parsed data the raster was drawn from. */
export function cueContextOf(data: Pick<ParsedChartData, "series">): CueDataContext {
  return { seriesNames: data.series.map((s) => s.name) };
}

// ============================================================================
// Look (Charts decides)
// ============================================================================

/**
 * Colour AND shape per polarity, so a colour-blind reader still tells good
 * from bad. Literals for the spike; IO-3 binds these to the skin's tokens.
 */
export const CUE_STYLES: Readonly<Record<ChartCuePolarity, { stroke: string; dash: readonly number[] }>> = {
  good: { stroke: "#1e8e3e", dash: [] },
  bad: { stroke: "#d93025", dash: [] },
  attention: { stroke: "#e37400", dash: [6, 4] },
  neutral: { stroke: "#0e639c", dash: [2, 3] },
};

/** Clearance between a datum's edge and its ring, in logical pixels. */
export const CUE_RING_PAD = 4;
export const CUE_LINE_WIDTH = 2;

/** The drawing surface the painter needs; a stub in tests, the grid canvas live. */
export type CuePaintContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "ellipse" | "arc" | "stroke" | "setLineDash"
> & { strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number };

function strokeTarget(ctx: CuePaintContext, chartX: number, chartY: number, target: CueTarget): void {
  ctx.beginPath();
  switch (target.kind) {
    case "rect": {
      const { rect } = target;
      const cx = chartX + rect.x + rect.width / 2;
      const cy = chartY + rect.y + rect.height / 2;
      // An ellipse hugging the bar's box: reads as "encircled" on a tall bar
      // and on a stacked segment alike, and never hides the bar it marks.
      ctx.ellipse(cx, cy, rect.width / 2 + CUE_RING_PAD, rect.height / 2 + CUE_RING_PAD, 0, 0, Math.PI * 2);
      break;
    }
    case "point": {
      const { marker } = target;
      ctx.arc(chartX + marker.cx, chartY + marker.cy, marker.radius + CUE_RING_PAD + 2, 0, Math.PI * 2);
      break;
    }
    case "slice": {
      // A ring is meaningless on a wedge; the cue is an arc along its outer
      // edge, just outside the slice, over exactly its angular span.
      const { arc } = target;
      ctx.arc(chartX + arc.centerX, chartY + arc.centerY, arc.outerRadius + CUE_RING_PAD, arc.startAngle, arc.endAngle);
      break;
    }
  }
  ctx.stroke();
}

/**
 * Draw every cue that resolves; skip, silently, every one that does not. The
 * refusals are the mapper's to report (it has the fact ids); the painter's job
 * is only to never draw a ring it cannot justify.
 *
 * Returns the number of cues drawn, so a caller can tell "nothing to show"
 * from "everything was refused".
 */
export function paintChartCues(
  ctx: CuePaintContext,
  chartX: number,
  chartY: number,
  geometry: HitGeometry,
  data: Pick<ParsedChartData, "series">,
  cues: readonly ChartCue[],
): number {
  if (cues.length === 0) return 0;
  const context = cueContextOf(data);
  let drawn = 0;
  ctx.save();
  ctx.lineWidth = CUE_LINE_WIDTH;
  for (const cue of cues) {
    const r = resolveCueTarget(geometry, cue.anchor, context);
    if (!r.ok) continue;
    const style = CUE_STYLES[cue.polarity];
    ctx.strokeStyle = style.stroke;
    ctx.setLineDash([...style.dash]);
    strokeTarget(ctx, chartX, chartY, r.target);
    drawn++;
  }
  ctx.setLineDash([]);
  ctx.restore();
  return drawn;
}
