//! FILENAME: app/extensions/Charts/rendering/cuePainter.ts
// PURPOSE: Turn a data-anchored insight cue into a mark on the chart, through
//          the same hit geometry that tooltips and selection use.
// CONTEXT: IO-0 of docs/design/insight-overlays.md put a ring on the right bar;
//          IO-2 widened the vocabulary to the closed set in §4.2. Two halves:
//
//          `resolveCue` is PURE: (geometry, cue) -> the rect, point or arc the
//          cue lands on — or the list of them for a whole series, or the x-span
//          for a band — or a refusal with a reason. It never guesses. A datum
//          anchor names a series and a painter-space category index and
//          carries the label the fact used; the geometry the painters computed
//          carries the series name and category label of every datum. When
//          they disagree — a filter hid a category and someone handed over an
//          authoring-space index, or the data changed under a cached bundle —
//          the cue is dropped, because a ring on the wrong bar is the most
//          invisible wrong answer this feature can give.
//
//          `paintChartCues` draws what resolved, at composite time over the
//          cached raster, exactly where selection highlights are drawn. It
//          decides HOW each kind looks on each mark (an ellipse round a bar, a
//          circle round a point, an arc along a slice; a translucent band; a
//          few words beside a callout); the caller only said WHICH datum.
//          Nothing here writes to the spec.
//
//          A `level` anchor (a rule at a data value) needs the value scale,
//          which the hit geometry does not carry; it is refused here with
//          `needs-scale` and is IO-3a's to draw through the rule painter.

import type { ChartCue, ChartCueAnchor, ChartCueDatumAnchor, ChartCuePolarity } from "@api/chartCues";
import { DEFAULT_OVERLAY_STYLE, overlayStyleFor, resolveOverlayStyle } from "@api/insightStyle";
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
  | "series-not-drawn"
  | "needs-scale"
  | "not-drawable";

/** What a whole cue resolves to. */
export type CueShape =
  | { kind: "one"; target: CueTarget }
  | { kind: "many"; targets: CueTarget[] }
  | { kind: "xspan"; x0: number; x1: number; y0: number; y1: number };

export type CueResolution =
  | { ok: true; target: CueTarget }
  | { ok: false; reason: CueRefusal };

export type CueShapeResolution =
  | { ok: true; shape: CueShape }
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
 * Where a datum cue lands, or why it does not. Pure; safe to call per frame.
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

/** Every datum target of a series (or of all series), in draw order. Slices: the first series only. */
function targetsOf(geometry: HitGeometry, series: string | undefined, ctx: CueDataContext, within?: (i: number) => boolean): CueTarget[] {
  const keep = (name: string, ci: number) => (series === undefined || name === series) && (within === undefined || within(ci));
  switch (geometry.type) {
    case "bars":
      return geometry.rects.filter((r) => keep(r.seriesName, r.categoryIndex)).map((rect) => ({ kind: "rect", rect }));
    case "points":
      return geometry.markers.filter((m) => keep(m.seriesName, m.categoryIndex)).map((marker) => ({ kind: "point", marker }));
    case "slices":
      if (series !== undefined && ctx.seriesNames[0] !== series) return [];
      return geometry.arcs.filter((a) => within === undefined || within(a.seriesIndex)).map((arc) => ({ kind: "slice", arc }));
    case "composite":
      return geometry.groups.flatMap((g) => targetsOf(g, series, ctx, within));
  }
}

/** The bounding box of a set of targets. Null for slices (no box worth a band). */
function boxOf(targets: readonly CueTarget[]): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of targets) {
    if (t.kind === "rect") {
      x0 = Math.min(x0, t.rect.x); x1 = Math.max(x1, t.rect.x + t.rect.width);
      y0 = Math.min(y0, t.rect.y); y1 = Math.max(y1, t.rect.y + t.rect.height);
    } else if (t.kind === "point") {
      x0 = Math.min(x0, t.marker.cx - t.marker.radius); x1 = Math.max(x1, t.marker.cx + t.marker.radius);
      y0 = Math.min(y0, t.marker.cy - t.marker.radius); y1 = Math.max(y1, t.marker.cy + t.marker.radius);
    } else {
      return null;
    }
  }
  return Number.isFinite(x0) ? { x0, x1, y0, y1 } : null;
}

/**
 * Where a cue of any anchor lands. A datum → one target; a series → its
 * targets; a span → the x-extent of the named categories over the plot's
 * data extent; a level → refused, the geometry carries no value scale.
 */
export function resolveCue(geometry: HitGeometry, anchor: ChartCueAnchor, ctx: CueDataContext): CueShapeResolution {
  switch (anchor.type) {
    case "datum": {
      const r = resolveCueTarget(geometry, anchor, ctx);
      return r.ok ? { ok: true, shape: { kind: "one", target: r.target } } : r;
    }
    case "series": {
      if (!ctx.seriesNames.includes(anchor.series)) return { ok: false, reason: "no-such-datum" };
      const targets = targetsOf(geometry, anchor.series, ctx);
      return targets.length > 0 ? { ok: true, shape: { kind: "many", targets } } : { ok: false, reason: "series-not-drawn" };
    }
    case "span": {
      const inSpan = (i: number) => i >= anchor.from && i <= anchor.to;
      const spanned = boxOf(targetsOf(geometry, anchor.series, ctx, inSpan));
      const all = boxOf(targetsOf(geometry, undefined, ctx));
      if (!spanned || !all) return { ok: false, reason: "not-drawable" };
      return { ok: true, shape: { kind: "xspan", x0: spanned.x0, x1: spanned.x1, y0: all.y0, y1: all.y1 } };
    }
    case "level":
      return { ok: false, reason: "needs-scale" };
  }
}

/** The data context the painter needs, from the parsed data the raster was drawn from. */
export function cueContextOf(data: Pick<ParsedChartData, "series">): CueDataContext {
  return { seriesNames: data.series.map((s) => s.name) };
}

/**
 * The cue, among those on screen, whose datum a hit on (series, category)
 * belongs to — hovering or clicking the ringed bar addresses the ring.
 * A series-anchored emphasis matches any datum of its series.
 */
export function cueAtDatum(
  cues: readonly ChartCue[],
  hit: { seriesName?: string; categoryIndex?: number } | null | undefined,
): ChartCue | null {
  if (!hit || hit.seriesName === undefined) return null;
  for (const c of cues) {
    const a = c.anchor;
    if (a.type === "datum" && a.series === hit.seriesName && a.categoryIndex === hit.categoryIndex) return c;
    if (a.type === "series" && a.series === hit.seriesName) return c;
    if (a.type === "span" && (a.series === undefined || a.series === hit.seriesName) && hit.categoryIndex !== undefined && hit.categoryIndex >= a.from && hit.categoryIndex <= a.to) return c;
  }
  return null;
}

// ============================================================================
// Look (Charts decides)
// ============================================================================

/**
 * Colour AND shape per polarity, so a colour-blind reader still tells good
 * from bad. THE DEFAULTS: what a document that declares no style gets. The
 * live answer is `cueStyleFor(polarity)`, which reads the document's style
 * through `@api/insightStyle` (the publisher's, in a published application).
 */
export const CUE_STYLES: Readonly<Record<ChartCuePolarity, { stroke: string; dash: readonly number[] }>> = {
  good: { stroke: DEFAULT_OVERLAY_STYLE.polarity.good.color, dash: DEFAULT_OVERLAY_STYLE.polarity.good.dash },
  bad: { stroke: DEFAULT_OVERLAY_STYLE.polarity.bad.color, dash: DEFAULT_OVERLAY_STYLE.polarity.bad.dash },
  attention: { stroke: DEFAULT_OVERLAY_STYLE.polarity.attention.color, dash: DEFAULT_OVERLAY_STYLE.polarity.attention.dash },
  neutral: { stroke: DEFAULT_OVERLAY_STYLE.polarity.neutral.color, dash: DEFAULT_OVERLAY_STYLE.polarity.neutral.dash },
};

/** The colour and dash for a polarity, as the open document declares them (else the defaults). */
export function cueStyleFor(polarity: ChartCuePolarity): { stroke: string; dash: readonly number[] } {
  const s = overlayStyleFor(polarity);
  return { stroke: s.color, dash: s.dash };
}

/** Clearance between a datum's edge and its ring, in logical pixels. */
export const CUE_RING_PAD = 4;
export const CUE_LINE_WIDTH = DEFAULT_OVERLAY_STYLE.lineWidth;
export const CUE_EMPHASIS_LINE_WIDTH = 3;
export const CUE_BAND_ALPHA = DEFAULT_OVERLAY_STYLE.bandOpacity;
export const CUE_CALLOUT_FONT = "11px 'Segoe UI', system-ui, sans-serif";

/** The drawing surface the painter needs; a stub in tests, the grid canvas live. */
export type CuePaintContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "ellipse" | "arc" | "stroke" | "fill" | "fillRect" | "fillText" | "setLineDash"
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

function pathAround(ctx: CuePaintContext, chartX: number, chartY: number, target: CueTarget, pad: number): void {
  ctx.beginPath();
  switch (target.kind) {
    case "rect": {
      const { rect } = target;
      const cx = chartX + rect.x + rect.width / 2;
      const cy = chartY + rect.y + rect.height / 2;
      // An ellipse hugging the bar's box: reads as "encircled" on a tall bar
      // and on a stacked segment alike, and never hides the bar it marks.
      ctx.ellipse(cx, cy, rect.width / 2 + pad, rect.height / 2 + pad, 0, 0, Math.PI * 2);
      break;
    }
    case "point": {
      const { marker } = target;
      ctx.arc(chartX + marker.cx, chartY + marker.cy, marker.radius + pad + 2, 0, Math.PI * 2);
      break;
    }
    case "slice": {
      // A ring is meaningless on a wedge; the cue is an arc along its outer
      // edge, just outside the slice, over exactly its angular span.
      const { arc } = target;
      ctx.arc(chartX + arc.centerX, chartY + arc.centerY, arc.outerRadius + pad, arc.startAngle, arc.endAngle);
      break;
    }
  }
}

/** The point a callout's words hang from: above a bar or point, at a slice's outer edge. */
function calloutAnchorOf(chartX: number, chartY: number, target: CueTarget): { x: number; y: number } {
  switch (target.kind) {
    case "rect":
      return { x: chartX + target.rect.x + target.rect.width / 2, y: chartY + target.rect.y - CUE_RING_PAD - 6 };
    case "point":
      return { x: chartX + target.marker.cx, y: chartY + target.marker.cy - target.marker.radius - CUE_RING_PAD - 8 };
    case "slice": {
      const { arc } = target;
      const mid = (arc.startAngle + arc.endAngle) / 2;
      const r = arc.outerRadius + CUE_RING_PAD + 10;
      return { x: chartX + arc.centerX + Math.cos(mid) * r, y: chartY + arc.centerY + Math.sin(mid) * r };
    }
  }
}

function paintOne(ctx: CuePaintContext, chartX: number, chartY: number, cue: ChartCue, shape: CueShape, selected: boolean): void {
  const style = cueStyleFor(cue.polarity);
  const live = resolveOverlayStyle();
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.stroke;
  ctx.setLineDash([...style.dash]);
  // A selected cue is drawn heavier, the way a selected bar gets its outline.
  const extra = selected ? 2 : 0;

  switch (cue.kind) {
    case "ring": {
      if (shape.kind !== "one") return;
      ctx.lineWidth = live.lineWidth + extra;
      pathAround(ctx, chartX, chartY, shape.target, CUE_RING_PAD);
      ctx.stroke();
      return;
    }
    case "emphasis": {
      const targets = shape.kind === "one" ? [shape.target] : shape.kind === "many" ? shape.targets : [];
      ctx.lineWidth = live.lineWidth + 1 + extra;
      for (const t of targets) {
        pathAround(ctx, chartX, chartY, t, 1);
        ctx.stroke();
      }
      return;
    }
    case "band": {
      if (shape.kind !== "xspan") return;
      ctx.globalAlpha = live.bandOpacity;
      ctx.fillRect(chartX + shape.x0, chartY + shape.y0, shape.x1 - shape.x0, shape.y1 - shape.y0);
      ctx.globalAlpha = 1;
      return;
    }
    case "callout": {
      if (shape.kind !== "one") return;
      ctx.lineWidth = live.lineWidth + extra;
      pathAround(ctx, chartX, chartY, shape.target, CUE_RING_PAD);
      ctx.stroke();
      const at = calloutAnchorOf(chartX, chartY, shape.target);
      ctx.font = CUE_CALLOUT_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.setLineDash([]);
      ctx.fillText(cue.description ?? cue.label ?? "", at.x, at.y);
      return;
    }
    case "rule":
      // A level needs the value scale; resolveCue refuses it before this.
      return;
  }
}

/**
 * Draw every cue that resolves; skip, silently, every one that does not. The
 * refusals are the mapper's to report (it has the fact ids); the painter's job
 * is only to never draw a mark it cannot justify.
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
  selectedFactId: string | null = null,
): number {
  if (cues.length === 0) return 0;
  const context = cueContextOf(data);
  let drawn = 0;
  ctx.save();
  ctx.lineWidth = CUE_LINE_WIDTH;
  for (const cue of cues) {
    const r = resolveCue(geometry, cue.anchor, context);
    if (!r.ok) continue;
    paintOne(ctx, chartX, chartY, cue, r.shape, selectedFactId !== null && cue.factId === selectedFactId);
    drawn++;
  }
  ctx.setLineDash([]);
  ctx.restore();
  return drawn;
}
