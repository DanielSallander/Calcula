//! FILENAME: app/extensions/Charts/rendering/chartDispatch.ts
// PURPOSE: Centralized dispatch for chart painting, layout computation, and hit geometry.
// CONTEXT: Eliminates the triple duplication of switch statements across chartRenderer.ts,
//          ChartPreview.tsx, and ChartSpecEditorApp.tsx. All three now call through here.
//          Also handles layer composition for the advanced spec editor features.

import type {
  ChartSpec,
  ChartLayout,
  ParsedChartData,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { registerChartMark, getChartMark } from "./markRegistry";

import { paintBarChart, computeLayout as computeBarLayout, computeBarRects } from "./barChartPainter";
import { paintLineChart, computeLineLayout, computeLinePointMarkers } from "./lineChartPainter";
import { paintAreaChart, computeAreaLayout, computeAreaPointMarkers } from "./areaChartPainter";
import { paintHorizontalBarChart, computeHorizontalBarLayout, computeHorizontalBarRects } from "./horizontalBarChartPainter";
import { paintPieChart, computePieLayout, computePieSliceArcs } from "./pieChartPainter";
import { paintScatterChart, computeScatterLayout, computeScatterPointMarkers } from "./scatterChartPainter";
import { paintWaterfallChart, computeWaterfallLayout, computeWaterfallBarRects } from "./waterfallChartPainter";
import { paintComboChart, computeComboLayout, computeComboHitGeometry } from "./comboChartPainter";
import { paintRadarChart, computeRadarLayout, computeRadarPointMarkers } from "./radarChartPainter";
import { paintBubbleChart, computeBubbleLayout, computeBubblePointMarkers } from "./bubbleChartPainter";
import { paintHistogramChart, computeHistogramLayout, computeHistogramBarRects } from "./histogramChartPainter";
import { paintFunnelChart, computeFunnelLayout, computeFunnelBarRects } from "./funnelChartPainter";
import { paintTreemapChart, computeTreemapLayout, computeTreemapBarRects } from "./treemapChartPainter";
import { paintStockChart, computeStockLayout, computeStockBarRects } from "./stockChartPainter";
import { paintBoxPlotChart, computeBoxPlotLayout, computeBoxPlotBarRects } from "./boxPlotChartPainter";
import { paintSunburstChart, computeSunburstLayout, computeSunburstBarRects } from "./sunburstChartPainter";
import { paintParetoChart, computeParetoLayout, computeParetoBarRects, computeParetoHitGeometry } from "./paretoChartPainter";
import { paintRule } from "./rulePainter";
import { paintTextMark } from "./textMarkPainter";
import { paintMarkerMark } from "./markerPainter";
import { paintTrendlines } from "./trendlinePainter";
import { paintDataLabels } from "./dataLabelPainter";
import { paintErrorBars, markSupportsErrorBars } from "./errorBarPainter";
import { paintDataTable, paintDataTableAxisTitle } from "./dataTablePainter";
import { chartShowsDataTable, specForMarkPaint } from "./chartPainterUtils";
import { chartDataTableView } from "../lib/dataTableView";

// ============================================================================
// Built-in Mark Registration
// ============================================================================
// The 18 built-in marks register through the same registry a third-party would
// use, so the dispatch functions below are data-driven lookups rather than
// hardcoded switch statements.

type GeomFn<T> = (data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme) => T;

/** Wrap a *Rects/*Markers/*Arcs geometry function as a HitGeometry producer. */
const asBars = (fn: GeomFn<BarRect[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "bars", rects: fn(d, s, l, t) });
const asPoints = (fn: GeomFn<PointMarker[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "points", markers: fn(d, s, l, t) });
const asSlices = (fn: GeomFn<SliceArc[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "slices", arcs: fn(d, s, l, t) });

/** Build built-in mark metadata (label + axis family). */
const meta = (label: string, layoutFamily: "cartesian" | "radial" | "other") => ({ label, layoutFamily, builtin: true as const });

registerChartMark("bar", { meta: meta("Bar Chart", "cartesian"), paint: paintBarChart, computeLayout: computeBarLayout, computeGeometry: asBars(computeBarRects) });
registerChartMark("horizontalBar", { meta: meta("Horizontal Bar Chart", "cartesian"), paint: paintHorizontalBarChart, computeLayout: computeHorizontalBarLayout, computeGeometry: asBars(computeHorizontalBarRects) });
registerChartMark("line", { meta: meta("Line Chart", "cartesian"), paint: paintLineChart, computeLayout: computeLineLayout, computeGeometry: asPoints(computeLinePointMarkers) });
registerChartMark("area", { meta: meta("Area Chart", "cartesian"), paint: paintAreaChart, computeLayout: computeAreaLayout, computeGeometry: asPoints(computeAreaPointMarkers) });
registerChartMark("scatter", { meta: meta("Scatter Plot", "cartesian"), paint: paintScatterChart, computeLayout: computeScatterLayout, computeGeometry: asPoints(computeScatterPointMarkers) });
registerChartMark("pie", { meta: meta("Pie Chart", "radial"), paint: paintPieChart, computeLayout: computePieLayout, computeGeometry: asSlices(computePieSliceArcs) });
registerChartMark("donut", { meta: meta("Donut Chart", "radial"), paint: paintPieChart, computeLayout: computePieLayout, computeGeometry: asSlices(computePieSliceArcs) });
registerChartMark("waterfall", { meta: meta("Waterfall Chart", "cartesian"), paint: paintWaterfallChart, computeLayout: computeWaterfallLayout, computeGeometry: asBars(computeWaterfallBarRects) });
registerChartMark("combo", { meta: meta("Combo Chart", "cartesian"), paint: paintComboChart, computeLayout: computeComboLayout, computeGeometry: computeComboHitGeometry });
registerChartMark("radar", { meta: meta("Radar Chart", "radial"), paint: paintRadarChart, computeLayout: computeRadarLayout, computeGeometry: asPoints(computeRadarPointMarkers) });
registerChartMark("bubble", { meta: meta("Bubble Chart", "cartesian"), paint: paintBubbleChart, computeLayout: computeBubbleLayout, computeGeometry: asPoints(computeBubblePointMarkers) });
registerChartMark("histogram", { meta: meta("Histogram", "cartesian"), paint: paintHistogramChart, computeLayout: computeHistogramLayout, computeGeometry: asBars(computeHistogramBarRects) });
registerChartMark("funnel", { meta: meta("Funnel Chart", "other"), paint: paintFunnelChart, computeLayout: computeFunnelLayout, computeGeometry: asBars(computeFunnelBarRects) });
registerChartMark("treemap", { meta: meta("Treemap", "other"), paint: paintTreemapChart, computeLayout: computeTreemapLayout, computeGeometry: asBars(computeTreemapBarRects) });
registerChartMark("stock", { meta: meta("Stock (OHLC)", "cartesian"), paint: paintStockChart, computeLayout: computeStockLayout, computeGeometry: asBars(computeStockBarRects) });
registerChartMark("boxPlot", { meta: meta("Box & Whisker", "cartesian"), paint: paintBoxPlotChart, computeLayout: computeBoxPlotLayout, computeGeometry: asBars(computeBoxPlotBarRects) });
registerChartMark("sunburst", { meta: meta("Sunburst", "radial"), paint: paintSunburstChart, computeLayout: computeSunburstLayout, computeGeometry: asBars(computeSunburstBarRects) });
registerChartMark("pareto", { meta: meta("Pareto", "cartesian"), paint: paintParetoChart, computeLayout: computeParetoLayout, computeGeometry: computeParetoHitGeometry });

// ============================================================================
// Paint Dispatch
// ============================================================================

/** Paint a chart to a canvas context, dispatching to the correct painter by mark type. */
export function dispatchPaint(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  // Composition: concat (outermost) > facet > repeat. derivePanels resolves the
  // active mode into a unified (cell, subSpec, subData) list; paintPanels tiles
  // them. The SAME derivation drives composePanelGeometry so panels are
  // hit-testable (cross-panel selection / tooltips), not whole-chart-only.
  if (isComposed(spec, data)) {
    const panels = derivePanels(data, spec, layout);
    if (panels) {
      paintPanels(ctx, panels, theme);
      return;
    }
  }

  // THE DATA THE TABLE SHOWS, which is `data` for sixteen of the eighteen marks
  // and a derived view for the other two (see chartDataTableView). Everything
  // below that is about the table asks IT, never `data`: the band the layout
  // reserved was computed from this same view, and the labels the table's header
  // row takes over from the axis have to be the labels the plot is drawn from.
  const tableData = chartDataTableView(spec, data);

  // The spec the MARK PAINTERS see. Identical to `spec` unless a data table is
  // shown, in which case the category tick labels and the x-axis title are
  // taken away from them here (see specForMarkPaint) and drawn — once, in the
  // right place — by the data-table stage at the bottom of this function.
  const markSpec = specForMarkPaint(spec, tableData);

  // Paint the primary mark
  paintMark(ctx, data, spec.mark, markSpec, layout, theme);

  // Paint error bars (after primary mark, before data labels). The mark list is
  // the painter's own (`markSupportsErrorBars`), not a copy: a local array here
  // and a switch in `getErrorBarOptions` are two spellings of one fact, and the
  // first mark to grow error bars would have been readable, writable from the
  // pane, and never drawn.
  if (markSupportsErrorBars(spec.mark)) {
    const geometry = dispatchComputeGeometry(data, spec, layout, theme);
    if (geometry) {
      paintErrorBars(ctx, data, spec, layout, theme, geometry);
    }
  }

  // Paint data labels (after primary mark)
  if (spec.dataLabels?.enabled) {
    const geometry = dispatchComputeGeometry(data, spec, layout, theme);
    if (geometry) {
      paintDataLabels(ctx, data, spec, layout, theme, geometry);
    }
  }

  // Paint trendlines (after primary mark and data labels, before layers)
  if (spec.trendlines && spec.trendlines.length > 0) {
    paintTrendlines(ctx, data, spec, layout, theme);
  }

  // Paint layers (if any)
  if (spec.layers && spec.layers.length > 0) {
    for (const layer of spec.layers) {
      const layerData = data; // layers share parent data (for now)
      if (layer.mark === "rule") {
        paintRule(ctx, layerData, layer, spec, layout, theme);
      } else if (layer.mark === "text") {
        paintTextMark(ctx, layerData, layer, spec, layout, theme);
      } else if (layer.mark === "marker") {
        paintMarkerMark(ctx, layerData, layer, spec, layout, theme);
      } else {
        // Chart-type layer: build a temporary spec merging layer props with
        // parent. Built from markSpec, so a layer cannot re-introduce the tick
        // labels the data table replaced.
        const layerSpec: ChartSpec = {
          ...markSpec,
          mark: layer.mark,
          markOptions: layer.markOptions ?? spec.markOptions,
          series: layer.series ?? spec.series,
        };
        paintMark(ctx, layerData, layer.mark, layerSpec, layout, theme);
      }
    }
  }

  // Paint the data table and, below it, the x-axis title — the bottom band, in
  // the one order Excel uses: [plot] [table] [axis title].
  if (chartShowsDataTable(spec, tableData)) {
    paintDataTable(ctx, tableData, spec, layout, theme);
    paintDataTableAxisTitle(ctx, tableData, spec, layout, theme);
  }
}

/** Paint a single mark type (no layer iteration). No-op for an unregistered mark. */
function paintMark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  mark: string,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  getChartMark(mark)?.paint(ctx, data, spec, layout, theme);
}

// ============================================================================
// Small Multiples (repeat)
// ============================================================================

/** A single cell rect in the small-multiples grid (in logical pixels). */
export interface RepeatCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tile a `width`x`height` area into a grid of `count` cells. Columns default to
 * ~sqrt(count) for a roughly square grid; the last row may be partially filled.
 * Pure (no canvas) so the grid math is unit-testable.
 */
export function repeatLayout(
  count: number,
  columns: number | undefined,
  width: number,
  height: number,
): RepeatCell[] {
  if (count <= 0) return [];
  const cols = columns && columns > 0 ? Math.min(Math.floor(columns), count) : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = width / cols;
  const cellH = height / rows;
  const cells: RepeatCell[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    cells.push({ x: c * cellW, y: r * cellH, width: cellW, height: cellH });
  }
  return cells;
}

/**
 * Re-index a panel's series onto a shared, ordered category list, filling
 * categories the panel lacks with 0 so every panel plots against the same X.
 * Drops categoryField (the shared union is treated as plain categories).
 */
function alignToCategories(data: ParsedChartData, categories: string[]): ParsedChartData {
  const pos = new Map<string, number>();
  data.categories.forEach((c, i) => { if (!pos.has(c)) pos.set(c, i); });
  const series = data.series.map((s) => ({
    name: s.name,
    color: s.color,
    values: categories.map((c) => {
      const i = pos.get(c);
      return i === undefined ? 0 : (s.values[i] ?? 0);
    }),
  }));
  return { categories, series };
}

// ============================================================================
// Unified panel derivation (repeat / facet / concat)
// ============================================================================

/** One tiled panel: its grid cell + the (spec, data) to render inside it. */
interface DerivedPanel {
  cell: RepeatCell;
  subSpec: ChartSpec;
  subData: ParsedChartData;
  /**
   * concat panels are COMPLETE charts (own axes/mark/legend, may nest) painted
   * via the full dispatchPaint / dispatchComputeGeometry; repeat & facet panels
   * are a single mark of the parent spec (paintMark / mark.computeGeometry).
   */
  composed: boolean;
}

/** Is this spec+data an active composition (concat > facet > repeat)? */
export function isComposed(spec: ChartSpec, data: ParsedChartData): boolean {
  return !!(
    (spec.concat && data.concat && data.concat.length > 0) ||
    (spec.facet && data.facets && data.facets.length > 0) ||
    spec.repeat
  );
}

/** Strip composition + per-chart annotations from a sub-panel's spec (shared by
 *  repeat & facet), applying an optional shared Y domain for comparable scales. */
function panelSubSpec(spec: ChartSpec, title: string, sharedMin: number | null, sharedMax: number | null): ChartSpec {
  return {
    ...spec,
    facet: undefined,
    repeat: undefined,
    title,
    legend: { ...spec.legend, visible: false },
    layers: undefined,
    trendlines: undefined,
    dataLabels: undefined,
    dataTable: undefined,
    yAxis: sharedMin !== null && sharedMax !== null ? { ...spec.yAxis, min: sharedMin, max: sharedMax } : spec.yAxis,
  };
}

/**
 * Resolve the active composition into a flat list of tiled panels — the SINGLE
 * source of truth for both painting (paintPanels) and hit geometry
 * (composePanelGeometry), so the two never drift. Precedence concat > facet >
 * repeat mirrors dispatchPaint. Returns null when nothing is composed.
 *
 * repeat/facet panels carry the parent's live `selection` so a point-selection
 * highlights the matching datum in EVERY panel (linked / cross-panel highlight).
 * concat panels are independent charts and keep their own (read-time) data.
 */
function derivePanels(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout): DerivedPanel[] | null {
  // Concatenation: several independent child charts (outermost composition).
  if (spec.concat && data.concat && data.concat.length > 0) {
    const panels = data.concat;
    const cells = repeatLayout(panels.length, spec.concat.columns, layout.width, layout.height);
    return panels.map((p, i) => ({ cell: cells[i], subSpec: p.spec, subData: p.data, composed: true }));
  }

  // Faceting: one panel per distinct field value.
  if (spec.facet && data.facets && data.facets.length > 0) {
    const facets = data.facets;
    const cells = repeatLayout(facets.length, spec.facet.columns, layout.width, layout.height);

    // Shared X = ordered union of every panel's categories (0-filling gaps). Only
    // safe when categories are nominal AND unique per panel: a typed (numeric/
    // temporal) X would lose its proportional axis, and duplicate category labels
    // would collapse rows and drop data. Otherwise keep each panel's own X.
    const canShareX = spec.facet.sharedXScale !== false
      && !facets.some((f) => f.data.categoryField)
      && !facets.some((f) => new Set(f.data.categories).size !== f.data.categories.length);

    let sharedCategories: string[] | null = null;
    if (canShareX) {
      const seen = new Set<string>();
      const union: string[] = [];
      for (const f of facets) {
        for (const c of f.data.categories) {
          if (!seen.has(c)) { seen.add(c); union.push(c); }
        }
      }
      sharedCategories = union;
    }

    // Align to shared X first so the shared Y domain includes any 0-fills.
    const aligned = facets.map((f) => (sharedCategories ? alignToCategories(f.data, sharedCategories) : f.data));

    let sharedMin: number | null = null;
    let sharedMax: number | null = null;
    if (spec.facet.sharedYScale !== false) {
      const all = aligned.flatMap((p) => p.series.flatMap((s) => s.values));
      if (all.length > 0) {
        sharedMin = Math.min(...all);
        sharedMax = Math.max(...all);
      }
    }

    return facets.map((f, i) => ({
      cell: cells[i],
      subSpec: panelSubSpec(spec, f.value, sharedMin, sharedMax),
      // Thread the parent selection so the highlight is linked across panels.
      subData: { ...aligned[i], selection: data.selection },
      composed: false,
    }));
  }

  // Small multiples: one single-series sub-chart per series.
  if (spec.repeat) {
    const seriesList = data.series;
    if (seriesList.length === 0) return [];
    const cells = repeatLayout(seriesList.length, spec.repeat.columns, layout.width, layout.height);

    let sharedMin: number | null = null;
    let sharedMax: number | null = null;
    if (spec.repeat.sharedYScale !== false) {
      const all = seriesList.flatMap((s) => s.values);
      if (all.length > 0) {
        sharedMin = Math.min(...all);
        sharedMax = Math.max(...all);
      }
    }

    return seriesList.map((series, i) => ({
      cell: cells[i],
      subSpec: panelSubSpec(spec, series.name, sharedMin, sharedMax),
      // Single-series panel; thread the parent selection for linked highlight.
      subData: { categories: data.categories, series: [series], categoryField: data.categoryField, selection: data.selection },
      composed: false,
    }));
  }

  return null;
}

/** Paint every derived panel into its clipped, translated cell. */
function paintPanels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  panels: DerivedPanel[],
  theme: ChartRenderTheme,
): void {
  for (const { cell, subSpec, subData, composed } of panels) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.width, cell.height);
    ctx.clip();
    ctx.translate(cell.x, cell.y);
    const subLayout = dispatchComputeLayout(cell.width, cell.height, subSpec, subData, theme);
    if (composed) dispatchPaint(ctx, subData, subSpec, subLayout, theme);
    else paintMark(ctx, subData, subSpec.mark, subSpec, subLayout, theme);
    ctx.restore();
  }
}

/** Translate every coordinate in a hit geometry by (dx, dy). Pure. */
function offsetGeometry(g: HitGeometry, dx: number, dy: number): HitGeometry {
  switch (g.type) {
    case "bars":
      return { type: "bars", rects: g.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    case "points":
      return { type: "points", markers: g.markers.map((m) => ({ ...m, cx: m.cx + dx, cy: m.cy + dy })) };
    case "slices":
      return { type: "slices", arcs: g.arcs.map((a) => ({ ...a, centerX: a.centerX + dx, centerY: a.centerY + dy })) };
    case "composite":
      return { type: "composite", groups: g.groups.map((gr) => offsetGeometry(gr, dx, dy)) };
  }
}

/**
 * Compose per-panel hit geometry for a composed chart: compute each panel's
 * geometry at its own cell-local layout (the SAME layout paintPanels paints
 * with), translate it into chart-local space by the cell offset, and union as a
 * composite. concat panels recurse through dispatchComputeGeometry (so a nested
 * facet/concat panel is itself hit-testable). Returns empty bars when nothing
 * is composed. Mirrors paintPanels so hit geometry never drifts from the paint.
 */
function composePanelGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  const panels = derivePanels(data, spec, layout);
  if (!panels) return { type: "bars", rects: [] };
  const groups: HitGeometry[] = [];
  for (const { cell, subSpec, subData, composed } of panels) {
    const subLayout = dispatchComputeLayout(cell.width, cell.height, subSpec, subData, theme);
    const g = composed
      ? dispatchComputeGeometry(subData, subSpec, subLayout, theme)
      : (getChartMark(subSpec.mark)?.computeGeometry(subData, subSpec, subLayout, theme) ?? { type: "bars", rects: [] });
    groups.push(offsetGeometry(g, cell.x, cell.y));
  }
  return { type: "composite", groups };
}

// ============================================================================
// Layout Dispatch
// ============================================================================

/** Compute layout for any chart type. */
export function dispatchComputeLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  // Unregistered marks fall back to the bar layout (always registered).
  //
  // The data table's band is NOT folded in here any more. It used to be: this
  // function shortened the plot and grew margin.bottom after the fact, which
  // left the tick-label and axis-title reservations inside computeCartesianLayout
  // untouched — two places computing one band, and the painters kept drawing
  // into the half that had moved. The band is now decided once, by
  // computeCartesianLayout / computeRadialLayout, which every registered mark's
  // computeLayout bottoms out in. A mark registered from outside that computes
  // its own margins from scratch gets no data-table reservation, and that is
  // the honest answer: this function cannot know where such a mark put its plot.
  const def = getChartMark(spec.mark) ?? getChartMark("bar")!;
  return def.computeLayout(width, height, spec, data, theme);
}

// ============================================================================
// Hit Geometry Dispatch
// ============================================================================

/** Compute hit geometry for any chart type. Empty geometry for an unregistered mark. */
export function dispatchComputeGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  // Composed charts (repeat / facet / concat) compose per-panel geometry offset
  // into chart-local space, so individual panel datums are hit-testable
  // (cross-panel tooltips + point-selection) — not whole-chart-only as in v1.
  if (isComposed(spec, data)) {
    return composePanelGeometry(data, spec, layout, theme);
  }
  const def = getChartMark(spec.mark);
  return def ? def.computeGeometry(data, spec, layout, theme) : { type: "bars", rects: [] };
}
