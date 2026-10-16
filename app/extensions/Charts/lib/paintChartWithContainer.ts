//! FILENAME: app/extensions/Charts/lib/paintChartWithContainer.ts
// PURPOSE: Paint a chart AND its visual container into a context that Core's
//          `renderOverlayRegion` never sees: the PNG export (chartRaster.ts),
//          the Insert/Create Chart dialog preview (ChartPreview.tsx) and the
//          chart spec editor window (ChartSpecEditorApp.tsx).
// CONTEXT: On the grid, Core paints a chart's container (shadow, background,
//          border) around the chart's raster, and the raster itself is
//          TRANSPARENT outside its marks -- the chart painters no longer fill a
//          background of their own (D-FORMAT). A route that paints the raster
//          without Core would therefore show a transparent chart with no frame
//          (review R1-3). This is the ONE helper those routes use, so the
//          dialog preview, the editor preview and the exported PNG look like
//          the chart on the canvas, with no second copy of the container rules:
//
//            measureVisualContainerLayout at (0, 0)
//            paintVisualContainerUnder        (shadow, background)
//            the chart, laid out at the CONTENT size and translated to the
//              content origin, inside withContainerContentClip
//            paintVisualContainerOver         (border)

import {
  measureVisualContainerLayout,
  paintVisualContainerOver,
  paintVisualContainerUnder,
  withContainerContentClip,
  type ContainerRegion,
} from "@api/visualContainerPaint";
import type { ContainerRect, ResolvedVisualContainer } from "@api/visualContainer";
import type { ChartLayout, ChartSpec, ParsedChartData } from "../types";
import { dispatchComputeLayout, dispatchPaint } from "../rendering/chartDispatch";
import { resolveChartTheme, type ChartRenderTheme } from "../rendering/chartTheme";
import { resolveChartContainer } from "./chartObjectFormat";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What a container-aware paint produced (the caller may draw more over the chart, e.g. the export's cues). */
export interface ChartContainerPaint {
  container: ResolvedVisualContainer;
  theme: ChartRenderTheme;
  /** Where the chart was laid out, in the context's logical px (outer at 0, 0). */
  content: ContainerRect;
  /** The chart's own layout, in chart-local px (content origin); null when the content had no room. */
  layout: ChartLayout | null;
}

/**
 * Paint `spec` over `data` at `width` x `height` logical px, container
 * included. `chartId` names a PLACED chart, whose container bindings are laid
 * over the literal (`resolveChartContainer`); a preview of an unsaved spec
 * passes none. The context must already carry its device scale.
 */
export function paintChartWithContainer(
  ctx: Ctx,
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  chartId?: string | null,
): ChartContainerPaint {
  const container = resolveChartContainer(chartId ?? null, spec);
  const theme = resolveChartTheme(spec.config, container);
  const outer: ContainerRect = { x: 0, y: 0, width, height };
  const origin = { dx: 0, dy: 0 };
  const containerLayout = measureVisualContainerLayout(ctx, outer, container);
  const content = containerLayout.content;

  paintVisualContainerUnder(ctx, containerLayout, container, origin);

  let layout: ChartLayout | null = null;
  if (content.width >= 1 && content.height >= 1) {
    const region = { container } as unknown as ContainerRegion;
    withContainerContentClip(ctx, region, outer, content, () => {
      ctx.save();
      try {
        ctx.translate(content.x, content.y);
        layout = dispatchComputeLayout(content.width, content.height, spec, data, theme);
        dispatchPaint(ctx, data, spec, layout, theme);
      } finally {
        ctx.restore();
      }
    });
  }

  paintVisualContainerOver(ctx, containerLayout, container, origin);
  return { container, theme, content: { ...content }, layout };
}
