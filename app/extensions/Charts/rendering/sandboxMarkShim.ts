//! FILENAME: app/extensions/Charts/rendering/sandboxMarkShim.ts
// PURPOSE: Host-side shim that makes a SANDBOXED custom chart mark (B8.D) look
//          like any other registered mark to the sync paint dispatch, while the
//          actual pixels are produced in a Worker realm. The shim's paint() draws
//          the FULL host-owned chrome (background, axes, grid, legend, title — or a
//          radial frame), then blits the worker's ImageBitmap into the chart's
//          CLIPPED plot rectangle — so an untrusted mark can only paint its own
//          plot pixels and never reaches the real canvas/DOM or any ambient-world
//          capability. The mark may also return per-datum hit geometry (sanitized
//          host-side), which the shim offsets into chart space for tooltips/select.
//          The paint payload also carries `datumStyles` — the host's OWN resolved
//          per-point overrides, in the mark's own painter-space indices — because
//          the host cannot apply an override to opaque worker pixels and must not
//          make a mark re-derive which datum an override names.
// CONTEXT: dispatchPaint stays a single synchronous chokepoint; the sandboxed-ness
//          is invisible to it because the registered paint IS this shim. The 18
//          built-in marks are untouched (they keep painting synchronously).

import { getChartMarkBitmap, getChartMarkGeometry } from "@api";
import type { ChartMarkPaintContext } from "@api/chartMarks";
import type { ChartMarkMeta, ChartMarkDefinition } from "./markRegistry";
import { registerChartMark } from "./markRegistry";
import { resolvedDatumStylesForMark } from "../lib/dataPointOverrides";
import { computeCartesianLayout, computeRadialLayout, drawCartesianChrome, drawRadialChrome } from "./chartPainterUtils";
import type { ChartSpec, ChartLayout, ParsedChartData, HitGeometry, BarRect } from "../types";
import type { ChartRenderTheme } from "./chartTheme";

/** djb2 string hash → unsigned 32-bit, base36. Stable + cheap; only computed on a
 *  chart (re)render, not per frame (the chart raster is cached between renders). */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Integer plot dimensions (logical px), floored at 1 — the worker render size. */
function plotPixelSize(layout: ChartLayout): { plotW: number; plotH: number } {
  return {
    plotW: Math.max(1, Math.round(layout.plotArea.width)),
    plotH: Math.max(1, Math.round(layout.plotArea.height)),
  };
}

/**
 * Composite cache key — bakes in mark + spec + data + plot size so it
 * self-invalidates (a spec/data/size change => new key => fresh worker render).
 * Uses ':' (NOT '|', which the requestDraw in-flight key reserves). The SAME key
 * is used by paint() (to fetch the bitmap) and computeGeometry() (to fetch the
 * matching hit geometry) — they must agree, hence one factored helper.
 */
function markCacheKey(markId: string, spec: ChartSpec, data: ParsedChartData, plotW: number, plotH: number): string {
  const sig = hashString(JSON.stringify(spec) + " " + JSON.stringify(data));
  return `${markId}:${sig}:${plotW}x${plotH}`;
}

/**
 * Build a ChartMarkDefinition for a sandboxed mark whose pixels come from the
 * worker `scriptId` (the mounted chart-mark object script). `markId` is the
 * spec.mark value the chart references. meta.sandboxed is forced true.
 */
export function buildSandboxMarkDefinition(
  scriptId: string,
  markId: string,
  meta: Omit<ChartMarkMeta, "sandboxed" | "builtin">,
): ChartMarkDefinition {
  const isRadial = meta.layoutFamily === "radial";

  return {
    meta: { ...meta, builtin: false, sandboxed: true },

    // NOTE ON PER-POINT OVERRIDES (design doc §6.7, gap 2). The host cannot
    // apply `spec.dataPointOverrides` to an opaque worker bitmap, so the mark
    // has to do it — but it must not RE-DERIVE which datum an override names.
    // The paint payload therefore carries `datumStyles`, the host's own
    // resolver's answer in the mark's own (painter-space) indices. Whether the
    // mark then USES it is a promise it declares
    // (`meta.honoursDataPointOverrides`), because the pixels are opaque and a
    // promise that cannot be checked is at least one that can be ASKED about —
    // see `chartMarkHonoursDataPointOverrides` in @api/chartMarks, which is
    // what a per-point formatting UI must gate on. Shipping the payload to a
    // mark that did not declare costs one empty array on a chart with no
    // overrides, so it is shipped unconditionally: a mark that starts honouring
    // them needs a flag change, not a host change.

    paint(ctx, data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): void {
      // Host owns the FULL chrome (background + axes/grid/legend/title, or a radial
      // frame) so the chart is complete + themed even while the worker bitmap is in
      // flight, and a buggy/hostile mark can never paint the axes or labels.
      if (isRadial) {
        drawRadialChrome(ctx, data, spec, layout, theme);
      } else {
        drawCartesianChrome(ctx, data, spec, layout, theme, meta.yDomain);
      }

      const pa = layout.plotArea;
      const { plotW, plotH } = plotPixelSize(layout);
      if (plotW < 2 || plotH < 2) return;

      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const key = markCacheKey(markId, spec, data, plotW, plotH);

      // The worker paints in LOCAL coords (origin 0,0, plot-sized); ship it the
      // structured-clone paint context. Returns the cached bitmap, or null (and
      // single-flight-requests one) on a miss — then paint nothing this frame.
      //
      // `datumStyles` needs NO extra cache-key input: it is a pure function of
      // (spec, data), and `key` already hashes both. A spec whose overrides
      // changed is a different key, so the bitmap is re-rendered with the new
      // styles rather than served stale.
      const paintContext: ChartMarkPaintContext = {
        spec,
        data,
        layout,
        theme,
        datumStyles: resolvedDatumStylesForMark(spec, data),
      };
      const bmp = getChartMarkBitmap(scriptId, key, paintContext, plotW, plotH, dpr);
      if (!bmp) return;

      // Clip to the plot rect so a buggy/malicious bitmap can't overpaint chrome.
      ctx.save();
      ctx.beginPath();
      ctx.rect(pa.x, pa.y, pa.width, pa.height);
      ctx.clip();
      // Blit at LOGICAL size; ctx is already dpr-scaled (the chart raster scales
      // by dpr), so the physical bitmap maps 1:1 — same convention as slicers.
      ctx.drawImage(bmp, pa.x, pa.y, pa.width, pa.height);
      ctx.restore();
    },

    computeLayout(width, height, spec, data, theme): ChartLayout {
      return isRadial
        ? computeRadialLayout(width, height, spec, data, theme)
        : computeCartesianLayout(width, height, spec, data, theme);
    },

    // Hit geometry: if the worker returned (sanitized, host-cached) per-datum rects
    // for this exact spec/data/size, offset them from LOCAL plot coords into chart
    // space so tooltips/selection work like a built-in mark. Otherwise (radial, or
    // no geometry yet/at all) degrade to whole-chart — empty rects.
    computeGeometry(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout): HitGeometry {
      if (isRadial) return { type: "bars", rects: [] };
      const { plotW, plotH } = plotPixelSize(layout);
      const geo = getChartMarkGeometry(markCacheKey(markId, spec, data, plotW, plotH));
      if (!geo || geo.rects.length === 0) return { type: "bars", rects: [] };

      const pa = layout.plotArea;
      const rects: BarRect[] = geo.rects.map((r) => ({
        seriesIndex: r.seriesIndex ?? 0,
        categoryIndex: r.categoryIndex ?? 0,
        x: r.x + pa.x,
        y: r.y + pa.y,
        width: r.w,
        height: r.h,
        value: r.value ?? 0,
        seriesName: r.seriesName ?? data.series[r.seriesIndex ?? 0]?.name ?? "",
        categoryName: r.categoryName ?? data.categories[r.categoryIndex ?? 0] ?? "",
      }));
      return { type: "bars", rects };
    },
  };
}

/**
 * Register a sandboxed mark into the chart-mark registry so charts can use it via
 * spec.mark === markId. Called by the chart-mark object-script mount glue (D.2);
 * `scriptId` is the mounted worker instance that declared the markRenderer hook.
 */
export function registerSandboxMark(
  scriptId: string,
  markId: string,
  meta: Omit<ChartMarkMeta, "sandboxed" | "builtin">,
): void {
  registerChartMark(markId, buildSandboxMarkDefinition(scriptId, markId, meta));
}
