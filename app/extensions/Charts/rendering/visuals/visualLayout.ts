//! FILENAME: app/extensions/Charts/rendering/visuals/visualLayout.ts
// PURPOSE: The layout and the small drawing helpers the four tile visuals share
//          (Card, Multi-row card, KPI, Gauge).
// CONTEXT: A tile visual has a title and NOTHING ELSE for furniture (it
//          registers `furniture: "titleOnly"`). So its layout is the radial
//          layout with the legend and the data table switched off: the same
//          title band and margins every other chart has, the same element rects
//          (chartArea, title) for the hit-tester, and no reservation for a
//          legend the spec may still say is visible — a Card inserted with the
//          dialog's default `legend.visible: true` must not lose a strip of its
//          box to a legend it never draws.

import type { ChartSpec, ChartLayout, ParsedChartData } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";
import { computeRadialLayout, drawTitle } from "../chartPainterUtils";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The spec a tile is laid out with: no legend, no data table. */
export function tileLayoutSpec(spec: ChartSpec): ChartSpec {
  return { ...spec, legend: { ...spec.legend, visible: false }, dataTable: undefined };
}

/** Layout for every tile visual (see the module header). */
export function computeVisualLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeRadialLayout(width, height, tileLayoutSpec(spec), data, theme);
}

/** The title block when there is one — the frame every tile shares (the background is the container's, painted under the raster). */
export function drawVisualFrame(ctx: Ctx, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): void {
  drawTitle(ctx, spec.title, layout, theme);
}

/**
 * The largest font size, between `min` and `max`, at which `text` fits in
 * `maxWidth` — measured, not estimated, so a long currency value shrinks
 * instead of running out of its card. Leaves `ctx.font` set to the answer.
 */
export function fitFontSize(
  ctx: Ctx,
  text: string,
  maxWidth: number,
  max: number,
  min: number,
  weight: string,
  family: string,
): number {
  let size = Math.max(min, Math.floor(max));
  for (;;) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (size <= min || ctx.measureText(text).width <= maxWidth) return size;
    size = Math.max(min, Math.floor(size * 0.9));
  }
}

/** Mix a hex colour toward white by `amount` (0..1); non-hex input is returned unchanged. */
export function tint(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}
