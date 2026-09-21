//! FILENAME: app/extensions/Charts/rendering/chartHitTesting.ts
// PURPOSE: Hit-testing for every addressable chart element — data points AND
//          the furniture around them (title, axis titles, axis label bands,
//          legend, legend entries, plot area, chart area, pivot filter buttons).
// CONTEXT: Given a point in chart-local coordinates and the pre-computed
//          geometry + layout, answers WHICH element the point falls on. Used by
//          hover, the selection ladder, the cue lens, point-select params and
//          the brush.
//
// THE TAXONOMY IS EXCEL'S. `Chart.GetChartElement` answers
// `ElementID + SeriesIndex + PointIndex`, where PointIndex = -1 means "the whole
// series". This module answers the same three things, spelled
// `{ element, seriesIndex?, pointIndex? }` with pointIndex ABSENT standing for
// Excel's -1. There is exactly ONE datum element (`datum`) rather than the old
// bar/point/slice trio, because every caller only ever asked "did this land on a
// data point?" — the mark kind is already known from the spec, so carrying it in
// the hit result was a third spelling of something the caller had.
//
// WHY THIS WAS REWRITTEN: `ChartHitResult.type` used to declare "title" and
// "legend" and NOTHING in the repository produced either one. They were dead
// members, and the only test guarding the union asserted that it had nine
// entries — which is precisely why nobody noticed. Meanwhile `hitTestAxes`
// answered "axis" for the WHOLE left and bottom margin, so a bottom/left legend
// and the rotated y-axis title both resolved as "axis", and the top and right
// margins were dead pixels that resolved as nothing at all.
// `elementHitTest-drift.test.ts` now asserts that every declared
// `ChartElementId` is genuinely PRODUCED by a path in this file, so a member
// cannot go dead again.
//
// Z-ORDER: a datum beats furniture that overlaps it, and the ladder keeps the
// click. That is settled precedent — docs/design/insight-overlays.md §5h — and
// is not re-litigated here. Among furniture: a legend ENTRY beats the legend
// box that contains it, the legend and the titles beat everything below them,
// then the IN-PLOT furniture in reverse paint order (trendline, then data
// label, then error bar — chartDispatch paints them in that order, so the last
// painted wins a shared pixel), then the data table, then the plot area, then
// the axis bands. Anything inside the canvas that matched nothing is
// `chartArea` (never `none`), so the top and right margins stop being dead
// pixels; `none` now means only "outside the chart object".
//
// EXCEL'S GRANULARITY ASYMMETRIES ARE REPRODUCED ON PURPOSE. An error-bar hit
// answers the SERIES with no point index (Excel has no per-point error bar); a
// data-label hit answers both indices; a trendline hit adds `trendlineIndex`
// because one series can carry several. Tick labels are not separable from
// their axis and have no element of their own. See CHART_ELEMENT_IDS in
// ../types for why `gridlines` is still absent.
//
// COMPOSED CHARTS (facet / concat / combo layers) CARRY NO PANEL INDEX — an
// explicit decision. `HitGeometry.composite` is built by TWO unrelated
// producers: `composePanelGeometry` (chartDispatch) makes one group per FACET or
// CONCAT PANEL, while `comboChartPainter` and `paretoChartPainter` make one
// group per MARK LAYER over a SINGLE panel. A group index therefore is not a
// panel index, and stamping it as one would be a fabricated identity that means
// two different things depending on which painter produced the geometry — the
// exact shape of defect this rewrite exists to remove. Composed charts stay
// inert at the panel level: the first datum hit across the groups wins (as
// before), and its `seriesIndex` / `pointIndex` are the datum's own, which is
// what every consumer actually uses. A real panel index belongs with a
// `HitGeometry` variant that records one at construction, not with a guess here.

import type {
  BarRect,
  PointMarker,
  SliceArc,
  HitGeometry,
  ChartHitResult,
  ChartLayout,
  ChartElementId,
  ChartElementRect,
  PivotChartFieldButton,
} from "../types";
import { rectContains } from "./chartPainterUtils";

// ============================================================================
// Result construction — the ONE writer of the legacy mirror fields
// ============================================================================

/**
 * How each element projects onto the narrower pre-Excel-taxonomy `type` field.
 *
 * `ChartHitResult.type` and `.categoryIndex` are COMPATIBILITY MIRRORS kept
 * while `rendering/chartRenderer.ts` (hover + tooltips + pivot buttons) is
 * still on the old spelling; see that file's handoff note. Elements the old,
 * narrower union simply could not express project to "none", which is exactly
 * what the old code would have answered for them anyway. Everything in this
 * module goes through `datumHit` / `elementHit`, so there is ONE writer and the
 * mirror cannot drift from the element it mirrors.
 */
const LEGACY_TYPE: Readonly<Record<ChartElementId, ChartHitResult["type"]>> = {
  chartArea: "none",
  plotArea: "plotArea",
  datum: "none", // never taken: datumHit is handed the mark kind directly
  title: "none",
  xAxisTitle: "none",
  yAxisTitle: "none",
  xAxis: "axis",
  yAxis: "axis",
  legend: "none",
  legendEntry: "none",
  trendline: "none",
  errorBars: "none",
  dataLabel: "none",
  dataTable: "none",
  filterButton: "filterButton",
  none: "none",
};

/** The mark kinds the legacy `type` field spelled a datum as. */
type LegacyDatumKind = "bar" | "point" | "slice";

/**
 * A data-point hit. `pointIndex` absent means Excel's PointIndex = -1, "the
 * whole series"; every producer here hits an individual point, so it is always
 * set. `kind` feeds the legacy mirror only.
 */
function datumHit(
  kind: LegacyDatumKind,
  d: {
    seriesIndex: number;
    pointIndex: number;
    value: number;
    seriesName: string;
    categoryName: string;
  },
): ChartHitResult {
  return {
    element: "datum",
    seriesIndex: d.seriesIndex,
    pointIndex: d.pointIndex,
    value: d.value,
    seriesName: d.seriesName,
    categoryName: d.categoryName,
    type: kind,
    categoryIndex: d.pointIndex,
  };
}

/**
 * A non-datum element hit.
 *
 * `pointIndex` is spread only when the caller passes one, which is how Excel's
 * PointIndex = -1 ("the whole series") is spelled here. That is not a detail:
 * `errorBars` MUST leave it out — Excel has no per-point error bar and
 * answering one would invent an object the format pane cannot target — while
 * `dataLabel` MUST carry it, because a data label is per point.
 */
function elementHit(
  element: Exclude<ChartElementId, "datum">,
  extra?: {
    seriesIndex?: number;
    pointIndex?: number;
    trendlineIndex?: number;
    axisType?: "x" | "y";
    fieldButton?: PivotChartFieldButton;
  },
): ChartHitResult {
  return {
    element,
    ...(extra?.seriesIndex !== undefined ? { seriesIndex: extra.seriesIndex } : {}),
    ...(extra?.pointIndex !== undefined ? { pointIndex: extra.pointIndex, categoryIndex: extra.pointIndex } : {}),
    ...(extra?.trendlineIndex !== undefined ? { trendlineIndex: extra.trendlineIndex } : {}),
    ...(extra?.axisType !== undefined ? { axisType: extra.axisType } : {}),
    ...(extra?.fieldButton !== undefined ? { fieldButton: extra.fieldButton } : {}),
    type: LEGACY_TYPE[element],
  };
}

/**
 * The element a hit result names, tolerating a result built before this module
 * owned the taxonomy (older hand-built fixtures, and anything still writing the
 * legacy `type` alone). Producers in this file always set `element`; this is
 * the ONE place that derives it from the mirror, so no consumer has to.
 */
export function chartElementOf(
  hit: { element?: ChartElementId; type?: string; axisType?: "x" | "y" } | null | undefined,
): ChartElementId {
  if (hit == null) return "none";
  if (hit.element !== undefined) return hit.element;
  switch (hit.type) {
    case "bar":
    case "point":
    case "slice":
      return "datum";
    case "plotArea":
      return "plotArea";
    case "axis":
      return hit.axisType === "y" ? "yAxis" : "xAxis";
    case "filterButton":
      return "filterButton";
    default:
      return "none";
  }
}

/** Did this hit land on an actual data point (vs furniture or a miss)? */
export function isDatumHit(
  hit: { element?: ChartElementId; type?: string; axisType?: "x" | "y" } | null | undefined,
): boolean {
  return chartElementOf(hit) === "datum";
}

// ============================================================================
// Unified Hit-Test Dispatch
// ============================================================================

/**
 * Hit-test a point against any chart type's geometry, falling through to the
 * chart's furniture (legend, titles, axis bands, plot area, chart area) when no
 * datum is under it.
 */
export function hitTestGeometry(
  localX: number,
  localY: number,
  geometry: HitGeometry,
  layout: ChartLayout,
): ChartHitResult {
  const datum = hitTestDatum(localX, localY, geometry);
  if (datum !== null) return datum;
  return hitTestChartElements(localX, localY, layout);
}

/**
 * The datum half of the dispatch: the topmost data point under the pixel, or
 * null when none. Separated from the furniture half so the z-order rule ("a
 * datum beats furniture that overlaps it") is one readable statement rather
 * than an ordering that has to be re-derived in four places.
 *
 * Composed geometry recurses group by group and the first datum wins; see the
 * header for why no panel index is carried.
 */
export function hitTestDatum(
  localX: number,
  localY: number,
  geometry: HitGeometry,
): ChartHitResult | null {
  switch (geometry.type) {
    case "bars":
      return hitTestBarRects(localX, localY, geometry.rects);
    case "points":
      return hitTestPointMarkers(localX, localY, geometry.markers);
    case "slices":
      return hitTestSliceArcs(localX, localY, geometry.arcs);
    case "composite":
      for (const group of geometry.groups) {
        const hit = hitTestDatum(localX, localY, group);
        if (hit !== null) return hit;
      }
      return null;
  }
}

// ============================================================================
// Rectangle (Brush) Hit-Testing — interval selection (C5 S6, additive half)
// ============================================================================

/**
 * Return every datum whose geometry intersects a brush rectangle (chart-local
 * coords). Bars use AABB intersection; points use centre-in-rect; radial slices
 * are not brushable in v1 (returns none). Pure — drives interval selection once
 * Core surfaces the in-plot drag gesture (the gesture itself is Core-owned).
 */
export function hitTestRect(
  rect: { x: number; y: number; width: number; height: number },
  geometry: HitGeometry,
): ChartHitResult[] {
  const x0 = Math.min(rect.x, rect.x + rect.width);
  const x1 = Math.max(rect.x, rect.x + rect.width);
  const y0 = Math.min(rect.y, rect.y + rect.height);
  const y1 = Math.max(rect.y, rect.y + rect.height);
  const out: ChartHitResult[] = [];

  const pushBars = (rects: BarRect[]) => {
    for (const b of rects) {
      if (b.x <= x1 && b.x + b.width >= x0 && b.y <= y1 && b.y + b.height >= y0) {
        out.push(datumHit("bar", {
          seriesIndex: b.seriesIndex,
          pointIndex: b.categoryIndex,
          value: b.value,
          seriesName: b.seriesName,
          categoryName: b.categoryName,
        }));
      }
    }
  };
  const pushPoints = (markers: PointMarker[]) => {
    const bonus = HIT_RADIUS_BONUS; // generous hit radius (matches the click path) so a click lands
    for (const m of markers) {
      // Treat each marker as a disc: include it when its centre is within the
      // rect inflated by the radius. This makes a zero-size brush (a plain click)
      // select the marker under it, not just markers whose centre is inside.
      const dx = m.cx < x0 ? x0 - m.cx : m.cx > x1 ? m.cx - x1 : 0;
      const dy = m.cy < y0 ? y0 - m.cy : m.cy > y1 ? m.cy - y1 : 0;
      const reach = m.radius + bonus;
      if (dx * dx + dy * dy <= reach * reach) {
        out.push(datumHit("point", {
          seriesIndex: m.seriesIndex,
          pointIndex: m.categoryIndex,
          value: m.value,
          seriesName: m.seriesName,
          categoryName: m.categoryName,
        }));
      }
    }
  };

  switch (geometry.type) {
    case "bars": pushBars(geometry.rects); break;
    case "points": pushPoints(geometry.markers); break;
    case "slices": break; // radial marks are not brushable in v1
    case "composite":
      for (const g of geometry.groups) {
        if (g.type === "bars") pushBars(g.rects);
        else if (g.type === "points") pushPoints(g.markers);
      }
      break;
  }
  return out;
}

// ============================================================================
// Bar Chart Hit-Testing
// ============================================================================

/** The topmost bar under the pixel, or null. Last drawn = topmost. */
function hitTestBarRects(localX: number, localY: number, barRects: BarRect[]): ChartHitResult | null {
  for (let i = barRects.length - 1; i >= 0; i--) {
    const bar = barRects[i];
    if (
      localX >= bar.x &&
      localX <= bar.x + bar.width &&
      localY >= bar.y &&
      localY <= bar.y + bar.height
    ) {
      return datumHit("bar", {
        seriesIndex: bar.seriesIndex,
        pointIndex: bar.categoryIndex,
        value: bar.value,
        seriesName: bar.seriesName,
        categoryName: bar.categoryName,
      });
    }
  }
  return null;
}

/**
 * Hit-test a point against bars and, failing that, the chart's furniture.
 * Tests bars in reverse order so that bars drawn later (on top) win.
 */
export function hitTestBarChart(
  localX: number,
  localY: number,
  barRects: BarRect[],
  layout: ChartLayout,
): ChartHitResult {
  return hitTestBarRects(localX, localY, barRects) ?? hitTestChartElements(localX, localY, layout);
}

// ============================================================================
// Point Hit-Testing (line, area, scatter)
// ============================================================================

/** Extra pixels beyond a marker's radius, so a small marker is still clickable. */
const HIT_RADIUS_BONUS = 3;

/** The topmost marker under the pixel, or null. Last drawn = topmost. */
function hitTestPointMarkers(localX: number, localY: number, markers: PointMarker[]): ChartHitResult | null {
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    const dx = localX - marker.cx;
    const dy = localY - marker.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= marker.radius + HIT_RADIUS_BONUS) {
      return datumHit("point", {
        seriesIndex: marker.seriesIndex,
        pointIndex: marker.categoryIndex,
        value: marker.value,
        seriesName: marker.seriesName,
        categoryName: marker.categoryName,
      });
    }
  }
  return null;
}

/**
 * Hit-test a point against point markers (line/area/scatter charts), falling
 * through to the chart's furniture. Uses a generous hit radius.
 */
export function hitTestPoints(
  localX: number,
  localY: number,
  markers: PointMarker[],
  layout: ChartLayout,
): ChartHitResult {
  return hitTestPointMarkers(localX, localY, markers) ?? hitTestChartElements(localX, localY, layout);
}

// ============================================================================
// Slice Hit-Testing (pie, donut)
// ============================================================================

/** The slice under the pixel, or null. Polar containment, no furniture fallback. */
function hitTestSliceArcs(localX: number, localY: number, arcs: SliceArc[]): ChartHitResult | null {
  if (arcs.length === 0) return null;

  const cx = arcs[0].centerX;
  const cy = arcs[0].centerY;
  const dx = localX - cx;
  const dy = localY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  for (const arc of arcs) {
    if (dist < arc.innerRadius || dist > arc.outerRadius) continue;

    // Normalize to [0, 2PI] range
    const testAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const start = ((arc.startAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const end = ((arc.endAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    const inArc = start <= end
      ? testAngle >= start && testAngle <= end
      : testAngle >= start || testAngle <= end; // arc wraps around 0

    if (inArc) {
      return datumHit("slice", {
        seriesIndex: arc.seriesIndex,
        // A slice IS its category: the series axis and the category axis are
        // the same axis for a radial mark, so both indices are the arc's.
        pointIndex: arc.seriesIndex,
        value: arc.value,
        seriesName: arc.label,
        categoryName: arc.label,
      });
    }
  }

  return null;
}

/**
 * Hit-test a point against pie/donut slices.
 *
 * Deliberately arc-only: a miss answers `none`, NOT the furniture under the
 * pixel. This is the low-level arc tester — "is there a slice here?" — and a
 * caller that wants the full answer asks `hitTestGeometry`, which applies the
 * furniture fallback (so a click in the donut hole still selects the plot area,
 * as Excel does). Keeping the two apart is what lets the radial geometry be
 * asked its own question without a layout having to be meaningful.
 */
export function hitTestSlices(
  localX: number,
  localY: number,
  arcs: SliceArc[],
  _layout: ChartLayout,
): ChartHitResult {
  return hitTestSliceArcs(localX, localY, arcs) ?? elementHit("none");
}

// ============================================================================
// Chart Furniture Hit-Testing (title, axis titles, legend, axes, areas)
// ============================================================================

/**
 * Which element of the chart's FURNITURE a pixel lands on, once no datum has
 * claimed it.
 *
 * Consults `layout.elements` (the measured/estimated rects, Wave B) FIRST, so a
 * legend, an axis title and a tick-label band are told apart instead of the
 * whole left margin answering "axis". Falls back to the old margin bands for
 * the axes when a band rect is missing — a hand-built layout in a test has no
 * `elements` at all, and such a layout must keep behaving exactly as it did.
 *
 * The margin fallback is CARTESIAN-ONLY when `elements` is present: a pie has no
 * axes, and the old code reported its left margin as the y-axis.
 */
export function hitTestChartElements(
  localX: number,
  localY: number,
  layout: ChartLayout,
): ChartHitResult {
  const el = layout.elements;

  // --- Furniture painted over everything: legend entries, legend, titles ---
  if (el) {
    if (el.legendItems) {
      for (const item of el.legendItems) {
        if (rectContains(item.rect, localX, localY)) {
          return elementHit("legendEntry", { seriesIndex: item.seriesIndex });
        }
      }
    }
    if (el.legend && rectContains(el.legend, localX, localY)) return elementHit("legend");
    if (el.title && rectContains(el.title, localX, localY)) return elementHit("title");
    if (el.xAxisTitle && rectContains(el.xAxisTitle, localX, localY)) return elementHit("xAxisTitle");
    if (el.yAxisTitle && rectContains(el.yAxisTitle, localX, localY)) return elementHit("yAxisTitle");

    // --- In-plot furniture, tested in REVERSE PAINT ORDER ---
    // chartDispatch paints error bars, then data labels, then trendlines, so
    // the last painted is the topmost and wins a shared pixel. (A datum still
    // beats all of it: that is decided above this function, in hitTestGeometry.)
    if (el.trendlines) {
      for (const t of el.trendlines) {
        if (polylineHit(t.points, localX, localY)) {
          return elementHit("trendline", { seriesIndex: t.seriesIndex, trendlineIndex: t.trendlineIndex });
        }
      }
    }
    if (el.dataLabels) {
      for (const label of el.dataLabels) {
        if (rectContains(label.rect, localX, localY)) {
          // Per POINT — both indices travel.
          return elementHit("dataLabel", { seriesIndex: label.seriesIndex, pointIndex: label.pointIndex });
        }
      }
    }
    if (el.errorBars) {
      for (const bar of el.errorBars) {
        if (rectContains(inflate(bar.rect, ERROR_BAR_HIT_PAD), localX, localY)) {
          // Per SERIES — no pointIndex, which IS Excel's answer here.
          return elementHit("errorBars", { seriesIndex: bar.seriesIndex });
        }
      }
    }
    // The data table is painted LAST of everything, over the strip where the
    // x tick labels also sit, so it wins that strip — which is what the reader
    // sees there. Consequence, stated rather than discovered later: while a
    // data table is shown, the horizontal axis is reached from its tick marks
    // and axis line, not from the label band underneath the table.
    if (el.dataTable && rectContains(el.dataTable, localX, localY)) return elementHit("dataTable");
  }

  // --- The plot area ---
  const pa = layout.plotArea;
  if (
    localX >= pa.x &&
    localX <= pa.x + pa.width &&
    localY >= pa.y &&
    localY <= pa.y + pa.height
  ) {
    return elementHit("plotArea");
  }

  // --- The axis label bands ---
  const axis = hitTestAxes(localX, localY, layout);
  if (axis !== null) return axis;

  // --- Anywhere else inside the object is the chart area, not nothing ---
  if (localX >= 0 && localX <= layout.width && localY >= 0 && localY <= layout.height) {
    return elementHit("chartArea");
  }

  return elementHit("none");
}

/** A rect the layout measured, when present. */
function bandHit(rect: ChartElementRect | undefined, x: number, y: number): boolean {
  return rect !== undefined && rectContains(rect, x, y);
}

// ----------------------------------------------------------------------------
// Geometry for the thin furniture
// ----------------------------------------------------------------------------

/**
 * How far outside its drawn box an error bar still counts as clicked. A stem is
 * one or two pixels wide; without a pad the element is unhittable in practice,
 * which is indistinguishable from not being selectable at all. Matches the
 * spirit of {@link HIT_RADIUS_BONUS} for small markers.
 */
const ERROR_BAR_HIT_PAD = 3;

/** How far from a trendline's stroke a click still lands on it. */
const TRENDLINE_HIT_TOLERANCE = 4;

/** A rect grown by `pad` on every side. */
function inflate(rect: ChartElementRect, pad: number): ChartElementRect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/**
 * Is the point within {@link TRENDLINE_HIT_TOLERANCE} of ANY segment of the
 * polyline?
 *
 * Deliberately not a bounding-box test: a fit that rises from the plot's
 * bottom-left to its top-right has a box covering the entire plot, so a box
 * test would make the plot area unselectable the moment a trendline was added
 * — the chart-wide version of the ring defect that stole the click from a bar.
 */
function polylineHit(points: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1], points[i]) <= TRENDLINE_HIT_TOLERANCE) return true;
  }
  return false;
}

/** Shortest distance from a point to a line SEGMENT (not the infinite line). */
function distanceToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  // A degenerate segment (two identical points) collapses to point distance.
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

/**
 * Hit-test the X/Y tick-label bands. Prefers the measured band rects; falls
 * back, per axis, to the margin strip adjacent to the plot area.
 *
 * Returns null (not a "none" hit) so the caller can keep looking.
 */
function hitTestAxes(
  localX: number,
  localY: number,
  layout: ChartLayout,
): ChartHitResult | null {
  const el = layout.elements;
  const pa = layout.plotArea;

  if (bandHit(el?.xAxisBand, localX, localY)) return elementHit("xAxis", { axisType: "x" });
  if (bandHit(el?.yAxisBand, localX, localY)) return elementHit("yAxis", { axisType: "y" });

  // A radial layout that told us about its elements has no axes at all; only a
  // cartesian layout (or one that never described itself) gets the margin bands.
  if (el && el.family !== "cartesian") return null;

  // X axis region: below the plot area, within horizontal plot bounds
  if (
    el?.xAxisBand === undefined &&
    localX >= pa.x &&
    localX <= pa.x + pa.width &&
    localY > pa.y + pa.height &&
    localY <= pa.y + pa.height + layout.margin.bottom
  ) {
    return elementHit("xAxis", { axisType: "x" });
  }

  // Y axis region: to the left of the plot area, within vertical plot bounds
  if (
    el?.yAxisBand === undefined &&
    localX >= 0 &&
    localX < pa.x &&
    localY >= pa.y &&
    localY <= pa.y + pa.height
  ) {
    return elementHit("yAxis", { axisType: "y" });
  }

  return null;
}

// ============================================================================
// PivotChart Filter Buttons
// ============================================================================

/**
 * Hit-test a point against a PivotChart's filter dropdown buttons.
 *
 * Lives here rather than in chartRenderer so that `filterButton` has a producer
 * inside the one module the drift test can hold to the taxonomy. Buttons are
 * painted ON TOP of the chart and are tested by the caller BEFORE the geometry,
 * which is why this is a separate entry point rather than a branch of
 * `hitTestChartElements`: the button strip sits in the chart's top margin, so
 * folding it in would make it lose to nothing, but keeping the order explicit
 * at the call site is what preserves it.
 */
export function hitTestFilterButtons(
  localX: number,
  localY: number,
  buttons?: PivotChartFieldButton[],
): ChartHitResult | null {
  if (!buttons || buttons.length === 0) return null;
  for (const btn of buttons) {
    if (
      localX >= btn.x &&
      localX <= btn.x + btn.width &&
      localY >= btn.y &&
      localY <= btn.y + btn.height
    ) {
      return elementHit("filterButton", { fieldButton: btn });
    }
  }
  return null;
}
