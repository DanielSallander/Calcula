//! FILENAME: app/extensions/Charts/rendering/crossHighlight.ts
// PURPOSE: The ONE place the cross-filter paint rules live (P4, G4, S5): how a
//          datum looks while another visual's selection HIGHLIGHTS the chart
//          (`ParsedChartData.highlightValues`) and while the chart's OWN
//          selection holds some datums and not others
//          (`ParsedChartData.crossFilterSelf`).
// CONTEXT: Power BI's look, per mark family (@api/chartMarks `crossFilter`,
//          declared in chartDispatch.ts):
//            - column / bar: the whole datum faded, then the highlighted
//              portion at full strength, grown from the datum's own baseline;
//            - pie / donut: the whole slice faded, then an inner arc whose
//              AREA is the highlighted share of the slice;
//            - scatter / bubble: a point the highlight does not reach is dimmed.
//          A source chart fades the datums its own selection does not hold.
//
//          With neither field present every helper answers "plain" and the
//          painters take their unchanged path: a chart nobody cross-filters
//          paints exactly the canvas calls it painted before P4
//          (rendering/__tests__/crossHighlightPaint.test.ts pins the stream).
//
//          Pure geometry + alpha; the painters keep their own fill (gradient,
//          rounded corners, per-point overrides) and hand it in as a callback.

import type { ParsedChartData } from "../types";

/** The alpha of a faded whole (a highlighted datum's background, an unselected datum of a source). */
export const HIGHLIGHT_FADE_ALPHA = 0.4;
/** The alpha of a scatter / bubble point the highlight does not reach. */
export const DIM_ALPHA = 0.25;

/**
 * How one datum is painted under cross-filtering:
 *   - `plain`: as today (no highlight, no own selection, or the own selection holds it and nothing highlights);
 *   - `faded`: the whole datum at the fade alpha, nothing on top (an unselected datum of a source);
 *   - `partial`: the faded whole, then `ratio` (0..1) of it at full strength.
 */
export type DatumEmphasis =
  | { kind: "plain" }
  | { kind: "faded" }
  | { kind: "partial"; ratio: number };

const PLAIN: DatumEmphasis = { kind: "plain" };
const FADED: DatumEmphasis = { kind: "faded" };

/**
 * The highlighted share of a datum, clamped to 0..1. A negative base MIRRORS:
 * -100 with -40 highlighted is 0.4 (the portion grows from the zero line
 * downward, as the bar does). A zero or non-finite base, or a highlight of the
 * other sign, has no portion to show (0).
 */
export function highlightRatio(base: number, highlighted: number | null | undefined): number {
  if (typeof highlighted !== "number" || !Number.isFinite(highlighted) || !Number.isFinite(base) || base === 0) return 0;
  const r = highlighted / base;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r >= 1 ? 1 : r;
}

/**
 * The emphasis of datum (si, ci) -- PAINTER-space indices, the same pair the
 * painter reads `data.series[si].values[ci]` with. The own selection decides
 * first (a datum it does not hold is faded whatever the highlight says); then
 * a highlight, when one applies, gives the portion.
 */
export function datumEmphasis(data: ParsedChartData, si: number, ci: number): DatumEmphasis {
  const self = data.crossFilterSelf;
  if (self && self.datums[si]?.[ci] !== true) return FADED;
  const hv = data.highlightValues;
  if (hv) {
    const base = data.series[si]?.values[ci] ?? 0;
    return { kind: "partial", ratio: highlightRatio(base, hv[si]?.[ci]) };
  }
  return PLAIN;
}

/**
 * Whether a scatter / bubble point is DIMMED: its own source chart does not
 * hold it, or a highlight applies and leaves nothing of it.
 */
export function pointIsDimmed(data: ParsedChartData, si: number, ci: number): boolean {
  const e = datumEmphasis(data, si, ci);
  if (e.kind === "faded") return true;
  if (e.kind === "partial") {
    const hi = data.highlightValues?.[si]?.[ci];
    return !(typeof hi === "number" && Number.isFinite(hi) && hi !== 0);
  }
  return false;
}

/** Which edge of a bar its value grows from (the zero line, or the segment's lower end in a stack). */
export type BarAnchor = "bottom" | "top" | "left" | "right";

/** The highlighted portion of `rect`: `ratio` of it, measured from `anchor`. */
export function portionRect(
  rect: { x: number; y: number; w: number; h: number },
  ratio: number,
  anchor: BarAnchor,
): { x: number; y: number; w: number; h: number } {
  const r = Math.max(0, Math.min(1, ratio));
  switch (anchor) {
    case "bottom": {
      const h = rect.h * r;
      return { x: rect.x, y: rect.y + rect.h - h, w: rect.w, h };
    }
    case "top":
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h * r };
    case "left":
      return { x: rect.x, y: rect.y, w: rect.w * r, h: rect.h };
    case "right": {
      const w = rect.w * r;
      return { x: rect.x + rect.w - w, y: rect.y, w, h: rect.h };
    }
  }
}

/**
 * Paint a bar that is NOT plain: the whole at `opacity * HIGHLIGHT_FADE_ALPHA`,
 * then (a `partial` with something to show) the portion at `opacity`. `fill`
 * is the painter's own fill of one rectangle (fill style, rounded corners);
 * it is called once for the whole and once for the portion. The alpha is left
 * at 1, as the painters' own path leaves it.
 */
export function paintFadedThenHighlighted(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  emphasis: Exclude<DatumEmphasis, { kind: "plain" }>,
  opacity: number | null | undefined,
  anchor: BarAnchor,
  fill: (x: number, y: number, w: number, h: number) => void,
): void {
  const alpha = opacity ?? 1;
  ctx.globalAlpha = alpha * HIGHLIGHT_FADE_ALPHA;
  fill(rect.x, rect.y, rect.w, rect.h);
  if (emphasis.kind === "partial" && emphasis.ratio > 0) {
    const part = portionRect(rect, emphasis.ratio, anchor);
    if (part.w > 0 && part.h > 0) {
      ctx.globalAlpha = alpha;
      fill(part.x, part.y, part.w, part.h);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * The outer radius of a slice's highlighted inner arc: the ring from
 * `rInner` to it holds the highlighted SHARE of the slice's area (so a 25 %
 * highlight reads as a quarter of the slice, not a quarter of its depth).
 * A pie has `rInner` 0.
 */
export function innerArcRadius(base: number, highlighted: number | null | undefined, rInner: number, rOuter: number): number {
  const ratio = highlightRatio(base, highlighted);
  return Math.sqrt(rInner * rInner + ratio * (rOuter * rOuter - rInner * rInner));
}
