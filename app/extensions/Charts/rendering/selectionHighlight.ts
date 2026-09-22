//! FILENAME: app/extensions/Charts/rendering/selectionHighlight.ts
// PURPOSE: How a chart shows WHICH element the reader has selected — the
//          outline on the chosen bar, point or slice, the handles on it, the
//          wash over everything else, and (further down) the hairline box and
//          handles on a selected TITLE, AXIS TITLE, LEGEND, LEGEND ENTRY or
//          PLOT AREA.
// CONTEXT: Lifted out of chartRenderer so the rule can be tested directly.
//          The rule it now carries is `dimOthers`, and it exists because of a
//          collision the insight overlay made visible: the wash says "this
//          one, not those", and a lens on the same chart says the same thing
//          about a DIFFERENT set of elements. The overlay is painted AFTER
//          this, so with the wash on, selecting one marked bar leaves the
//          other marked bars pale with their rings still drawn over the
//          ghosts. With a lens on the chart the selection is therefore drawn
//          as an outline alone, which is unambiguous and is what a reader who
//          has just clicked a bar is looking for.
//
//          Pure canvas drawing: no store, no state, no events. Everything it
//          needs arrives as arguments.

import type {
  BarRect,
  ChartElementId,
  ChartElementRect,
  ChartElementRects,
  ChartLayout,
  HitGeometry,
} from "../types";

/**
 * `dimOthers` false keeps the selected element's outline and drops the white
 * wash over everything else.
 *
 * The wash exists to say "this one, not those". An insight overlay says the
 * same thing about a DIFFERENT set of elements at the same time, and the two
 * fight: the moment the reader selects one marked bar, every other bar the
 * overlay exists to point at goes pale with its ring still drawn over the
 * ghost — the overlay is painted after this, so the rings survive the wash
 * their bars do not. The outline alone is unambiguous, and it is what a reader
 * who just clicked a bar is looking for.
 */
export function drawSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  cachedData: { hitGeometry: HitGeometry },
  spec: import("../types").ChartSpec,
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
  dimOthers = true,
): void {
  const { hitGeometry } = cachedData;

  if (hitGeometry.type === "bars") {
    drawBarSelectionHighlights(ctx, chartX, chartY, hitGeometry.rects, level, selSeriesIndex, selCategoryIndex, dimOthers);
  } else if (hitGeometry.type === "points") {
    drawPointSelectionHighlights(ctx, chartX, chartY, hitGeometry.markers, level, selSeriesIndex, selCategoryIndex, dimOthers);
  } else if (hitGeometry.type === "slices") {
    drawSliceSelectionHighlights(ctx, chartX, chartY, hitGeometry.arcs, level, selSeriesIndex, dimOthers);
  } else if (hitGeometry.type === "composite") {
    for (const group of hitGeometry.groups) {
      if (group.type === "bars") {
        drawBarSelectionHighlights(ctx, chartX, chartY, group.rects, level, selSeriesIndex, selCategoryIndex, dimOthers);
      } else if (group.type === "points") {
        drawPointSelectionHighlights(ctx, chartX, chartY, group.markers, level, selSeriesIndex, selCategoryIndex, dimOthers);
      }
    }
  }
}

export function drawBarSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  barRects: BarRect[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
  dimOthers = true,
): void {
  if (barRects.length === 0) return;

  for (const bar of barRects) {
    const bx = chartX + bar.x;
    const by = chartY + bar.y;

    const isSelected =
      level === "series"
        ? bar.seriesIndex === selSeriesIndex
        : bar.seriesIndex === selSeriesIndex && bar.categoryIndex === selCategoryIndex;

    if (isSelected) {
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bar.width, bar.height);
    } else if (dimOthers) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fillRect(bx, by, bar.width, bar.height);
    }
  }

  // Draw selection handles on selected bars (small squares at corners)
  if (level === "dataPoint" && selSeriesIndex != null && selCategoryIndex != null) {
    const selectedBar = barRects.find(
      (b) => b.seriesIndex === selSeriesIndex && b.categoryIndex === selCategoryIndex,
    );
    if (selectedBar) {
      drawElementSelectionHandles(ctx, chartX + selectedBar.x, chartY + selectedBar.y, selectedBar.width, selectedBar.height);
    }
  }
}

export function drawPointSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  markers: import("../types").PointMarker[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
  dimOthers = true,
): void {
  if (markers.length === 0) return;

  for (const marker of markers) {
    const mx = chartX + marker.cx;
    const my = chartY + marker.cy;

    const isSelected =
      level === "series"
        ? marker.seriesIndex === selSeriesIndex
        : marker.seriesIndex === selSeriesIndex && marker.categoryIndex === selCategoryIndex;

    if (isSelected) {
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(mx, my, marker.radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (dimOthers) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.beginPath();
      ctx.arc(mx, my, marker.radius + 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawSliceSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  arcs: import("../types").SliceArc[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  dimOthers = true,
): void {
  if (arcs.length === 0) return;

  for (const arc of arcs) {
    const isSelected = arc.seriesIndex === selSeriesIndex;

    // Selected FIRST. Inverting this (dim unless selected) makes the two
    // branches disagree the moment dimming is off: a slice that is neither
    // selected nor dimmed would fall into the highlight branch and every
    // slice would be outlined.
    if (isSelected) {
      // Highlight selected slice
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(
        chartX + arc.centerX,
        chartY + arc.centerY,
        arc.outerRadius + 2,
        arc.startAngle,
        arc.endAngle,
      );
      ctx.stroke();
    } else if (dimOthers) {
      // Dim non-selected slices
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.beginPath();
      ctx.moveTo(chartX + arc.centerX, chartY + arc.centerY);
      ctx.arc(
        chartX + arc.centerX,
        chartY + arc.centerY,
        arc.outerRadius,
        arc.startAngle,
        arc.endAngle,
      );
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ============================================================================
// Element-level selection (title, axis titles, legend, legend entry, plot area)
// ============================================================================

/**
 * The selection colour every chart highlight in this file already uses. Named
 * once so the element chrome cannot drift from the datum chrome by a hex digit.
 */
export const CHART_SELECTION_COLOR = "#0e639c";

/**
 * Breathing room between the MEASURED glyph box and the selection border, in
 * chart-local px. Excel's title box does not sit on the letters; two pixels is
 * enough to read as a box around the text rather than a strikethrough of it.
 *
 * Deliberately much smaller than the text editor's own padding
 * (`CHART_TEXT_EDITOR_PAD_X/Y`, handlers/chartTextEditing.ts): the two boxes are
 * never on screen together — see the text-editing rule below — so they do not
 * have to agree, and a selection box that matched the editor's padding would
 * look loose around a short title.
 */
export const CHART_ELEMENT_SELECTION_PAD = 2;

/**
 * The element ids that get a selection box HERE.
 *
 * This is every element the ladder can actually put at `level: "element"` today
 * — `advanceSelection` produces all six, and `buildChartNavGroups`' Up/Down walk
 * reaches the same six — and nothing else. Painting an element nothing can select is
 * the same defect in the other direction, and the taxonomy's own header says so:
 * `"title"` and `"legend"` sat in the union for a year with no producer.
 *
 * `chartArea` is absent ON PURPOSE: a selected chart ALREADY gets its border and
 * its resize handles from `renderChart` step 5, so an element box for it would
 * be a second, slightly smaller frame inside the first. `datum` belongs to
 * {@link drawSelectionHighlights}, `xAxis`/`yAxis` to the axis highlight, and
 * `filterButton`/`none` are not selectable furniture.
 *
 * THE IN-PLOT FURNITURE IS HERE NOW, and not all of it is a box:
 *
 *   * `dataLabel` and `dataTable` have one measured rect each and take the
 *     ordinary box.
 *   * `errorBars` has MANY rects and ONE identity (Excel has no per-point error
 *     bar), so it is boxed bar by bar by {@link drawErrorBarsSelectionHighlight}.
 *   * `trendline` is recorded as a POLYLINE, because its bounding box would
 *     cover the whole plot for any fit that runs corner to corner — the same
 *     reason the hit test measures distance to a segment. It gets
 *     {@link drawTrendlineSelectionHighlight}, a line with handles at its ends.
 */
export const CHART_SELECTABLE_ELEMENT_IDS = [
  "title",
  "xAxisTitle",
  "yAxisTitle",
  "legend",
  "legendEntry",
  "plotArea",
  "trendline",
  "errorBars",
  "dataLabel",
  "dataTable",
] as const;

/** An element id that {@link drawElementSelectionHighlight} can paint. */
export type SelectableChartElementId = (typeof CHART_SELECTABLE_ELEMENT_IDS)[number];

/** Is this element one that gets a selection box? */
export function isSelectableChartElement(
  id: ChartElementId | undefined,
): id is SelectableChartElementId {
  return id !== undefined && (CHART_SELECTABLE_ELEMENT_IDS as readonly string[]).includes(id);
}

/**
 * The elements whose SELECTION BOX stands down while the in-place text editor is
 * open. Exactly the elements the editor can be opened on
 * (`CHART_TEXT_ELEMENT_IDS`, handlers/chartTextEditing.ts); re-stated here as a
 * local constant rather than imported, because importing a handler into a
 * painter would close a cycle (chartTextEditing already imports chartRenderer,
 * which imports this file).
 */
const TEXT_EDITABLE_ELEMENT_IDS: readonly ChartElementId[] = ["title", "xAxisTitle", "yAxisTitle"];

/**
 * The MEASURED rect for one selectable element, straight out of the layout —
 * never re-derived from the margins.
 *
 * Re-deriving is the whole defect this avoids: every rect in `layout.elements`
 * except `chartArea` and `title` is a function of `margin`/`plotArea`, and
 * several stages mutate those AFTER layout (the data table, the pivot field
 * buttons, the secondary axis, the horizontal-bar relayout). `layout.elements`
 * is reflowed by those stages and then OVERWRITTEN with painter-measured truth
 * for the title and the legend entries, so it is the only place that knows where
 * the glyphs actually landed. See {@link ChartElementRects} for the two-stage
 * contract.
 *
 * `plotArea` is the ONE id read off `layout` itself rather than
 * `layout.elements`, because that is where it lives — `ChartElementRects` has no
 * `plotArea` member, and inventing a second copy of a rect every painter already
 * reads is how two spellings of one fact start drifting. It is therefore also
 * the one id that still resolves on a layout with no `elements` at all.
 *
 * A `legendEntry` whose series has no entry falls back to the WHOLE legend box.
 * The alternative is painting nothing, and painting nothing is the exact defect
 * this function exists to fix: the reader clicked, something was selected, and
 * the chart said so in no way at all.
 */
export function elementSelectionRect(
  layout: ChartLayout,
  elementId: SelectableChartElementId,
  seriesIndex?: number,
  categoryIndex?: number,
): ChartElementRect | undefined {
  if (elementId === "plotArea") return layout.plotArea;
  const elements: ChartElementRects | undefined = layout.elements;
  if (!elements) return undefined;
  switch (elementId) {
    case "title":
      return elements.title;
    case "xAxisTitle":
      return elements.xAxisTitle;
    case "yAxisTitle":
      return elements.yAxisTitle;
    case "legend":
      return elements.legend;
    case "legendEntry": {
      const entry =
        seriesIndex === undefined
          ? undefined
          : elements.legendItems?.find((i) => i.seriesIndex === seriesIndex);
      return entry?.rect ?? elements.legend;
    }
    case "dataTable":
      return elements.dataTable;
    case "dataLabel": {
      // Per POINT, so BOTH indices have to match. A label whose point has gone
      // (the data reshaped under a live selection) gets NO fallback, unlike a
      // legend entry: the legend at least still exists as a thing to point at,
      // whereas "some other label of this series" would be a box over a datum
      // the reader never selected.
      if (seriesIndex === undefined || categoryIndex === undefined) return undefined;
      return elements.dataLabels?.find(
        (l) => l.seriesIndex === seriesIndex && l.pointIndex === categoryIndex,
      )?.rect;
    }
    case "trendline":
    case "errorBars":
      // Not a single rect. A trendline is a polyline and error bars are many
      // boxes under one identity; both have their own painters below, and
      // answering a rect here would invite a caller to box the wrong shape.
      return undefined;
  }
}

/**
 * The selection BOX for a measured rect: the rect, outset by
 * {@link CHART_ELEMENT_SELECTION_PAD} on every side. Pure, so the geometry is a
 * tested fact and a test can assert the painted box IS a function of the
 * measured rect.
 */
export function elementSelectionBox(rect: ChartElementRect): ChartElementRect {
  const pad = CHART_ELEMENT_SELECTION_PAD;
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/**
 * Paint the selection chrome for a non-datum, non-axis chart element: a hairline
 * border plus the same small square handles the datum highlight uses.
 *
 * WHY A HAIRLINE AND NOT THE DATUM'S 2px OUTLINE — Excel gives a selected title,
 * axis title or legend a LIGHT border with handles; the handles carry the
 * "selected, and movable" message and a heavy border round a piece of text reads
 * as a formatting change rather than a selection. The colour and the handle size
 * are the repo's existing ones (`drawElementSelectionHandles`), so the element
 * chrome is recognisably the same language as the bar chrome.
 *
 * WHY NO WASH, EVER — the datum highlight pales everything it did not select
 * ("this one, not those"), and that wash is skipped while an insight lens is on
 * the chart, because it would pale the very bars the lens exists to point at
 * (docs/design/insight-overlays.md section 5h). Element selection sidesteps the
 * collision instead of re-litigating it: selecting a TITLE says nothing about
 * the bars, so nothing is dimmed and there is no `dimOthers` argument to get
 * wrong. Excel does not dim for a title either. A future change that adds a wash
 * here inherits the lens rule and must take the flag — which is why the absence
 * is stated rather than merely true.
 *
 * WHILE THE TEXT EDITOR IS OPEN, NOTHING IS PAINTED for a text element. The
 * editor is a real `<textarea>` mounted over the canvas with its own focus ring,
 * and its box is grown from the same rect by a LARGER padding
 * (`editorBoxForElement`), so a selection border behind it would show as a
 * second, offset frame a few pixels inside the editor — two boxes around one
 * title, neither of them wrong. The editor IS the "this is selected" signal
 * while it is up. The suppression is limited to text elements so that an editor
 * opened somewhere else entirely (another overlay, another object) cannot blank
 * a selected legend's box.
 *
 * Returns true when something was painted, so a caller — or a test — can tell
 * "nothing to draw" from "drew it".
 */
/**
 * The rest of the sub-selection, plus the one environment fact.
 *
 * `elementId` and `seriesIndex` stay positional because every element that has
 * an identity at all has a series; these two are the indices only SOME elements
 * carry, and passing them positionally would mean four indices in a row that a
 * caller can transpose silently. They are the same fields
 * {@link ChartSubSelection} spells, so `paintSelectionChrome` copies them across
 * rather than deriving anything.
 */
export interface ElementSelectionPaintOptions {
  /** An in-place overlay text editor is open; a TEXT element's box stands down. */
  textEditing?: boolean;
  /** Which point, for the per-POINT furniture (`dataLabel`). */
  categoryIndex?: number;
  /** Which of the series' trendlines, for `trendline`. */
  trendlineIndex?: number;
}

export function drawElementSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  layout: ChartLayout | undefined,
  elementId: ChartElementId | undefined,
  seriesIndex?: number,
  opts: ElementSelectionPaintOptions = {},
): boolean {
  if (!layout) return false;
  if (!isSelectableChartElement(elementId)) return false;
  if (opts.textEditing === true && TEXT_EDITABLE_ELEMENT_IDS.includes(elementId)) return false;

  // The two elements that are not a box. Dispatched here rather than at the
  // call site so there is ONE entry point for "paint the selected element" and
  // a caller cannot reach the rect painter with a polyline.
  if (elementId === "trendline") {
    return drawTrendlineSelectionHighlight(ctx, chartX, chartY, layout, seriesIndex, opts.trendlineIndex);
  }
  if (elementId === "errorBars") {
    return drawErrorBarsSelectionHighlight(ctx, chartX, chartY, layout, seriesIndex);
  }

  const measured = elementSelectionRect(layout, elementId, seriesIndex, opts.categoryIndex);
  if (!measured) return false;
  // A zero-area rect is a layout that has not measured this element yet; a box
  // around nothing is noise, not feedback.
  if (measured.width <= 0 || measured.height <= 0) return false;

  const box = elementSelectionBox(measured);
  const bx = chartX + box.x;
  const by = chartY + box.y;

  ctx.save();
  ctx.strokeStyle = CHART_SELECTION_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  // Half-pixel inset for a crisp 1px line, the same way `renderChart`'s own
  // border and the axis highlight do it.
  ctx.strokeRect(bx + 0.5, by + 0.5, box.width - 1, box.height - 1);
  drawElementSelectionHandles(ctx, bx, by, box.width, box.height);
  ctx.restore();
  return true;
}

// ----------------------------------------------------------------------------
// The furniture that is not a box
// ----------------------------------------------------------------------------

/**
 * How much wider than the trendline's own stroke the selection stroke is drawn.
 * The line under it is 2px by default and may be dashed; 4px solid in the
 * selection colour reads as "this line is selected" without hiding the fit.
 */
const TRENDLINE_SELECTION_WIDTH = 4;

/**
 * A SELECTED TRENDLINE IS A LINE, NOT A BOX.
 *
 * Its bounding box is useless as chrome for exactly the reason it is useless as
 * a hit target: a fit running from the plot's bottom-left to its top-right has a
 * box covering the entire plot, so a box would say "the whole plot is selected"
 * — and would sit on top of every bar underneath it. Excel highlights the line
 * itself and puts handles at its ENDS, which is what this does: the recorded
 * polyline is re-stroked in the selection colour, then one handle at each
 * endpoint.
 *
 * TWO HANDLES, NOT SIX. The six-square set says "this rectangle, resizable on
 * every side"; a line has two ends and nothing in between to drag, and drawing
 * six squares round a line would be chrome describing a shape that is not there.
 *
 * `trendlineIndex` is required in practice and optional in the signature: a
 * series can carry a linear fit AND a moving average, so matching on the series
 * alone would highlight whichever was recorded first. When it is absent — a
 * selection made before the index travelled, or a hand-built sub-selection —
 * the series' FIRST recorded trendline is used, because painting nothing is the
 * defect this whole file exists to close.
 */
export function drawTrendlineSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  layout: ChartLayout,
  seriesIndex?: number,
  trendlineIndex?: number,
): boolean {
  const recorded = layout.elements?.trendlines;
  if (!recorded || recorded.length === 0) return false;

  const match =
    recorded.find(
      (t) =>
        (seriesIndex === undefined || t.seriesIndex === seriesIndex) &&
        (trendlineIndex === undefined || t.trendlineIndex === trendlineIndex),
    ) ?? undefined;
  if (!match || match.points.length < 2) return false;

  ctx.save();
  ctx.strokeStyle = CHART_SELECTION_COLOR;
  ctx.lineWidth = TRENDLINE_SELECTION_WIDTH;
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(chartX + match.points[0].x, chartY + match.points[0].y);
  for (let i = 1; i < match.points.length; i++) {
    ctx.lineTo(chartX + match.points[i].x, chartY + match.points[i].y);
  }
  ctx.stroke();

  const first = match.points[0];
  const last = match.points[match.points.length - 1];
  ctx.fillStyle = CHART_SELECTION_COLOR;
  for (const p of [first, last]) {
    drawHandleSquare(ctx, chartX + p.x, chartY + p.y);
  }
  ctx.restore();
  return true;
}

/**
 * A SELECTED ERROR-BAR SET IS EVERY BAR OF THAT SERIES.
 *
 * Excel's error bars are a per-SERIES object with no per-point member — you
 * cannot select the error bar on March alone — so selecting one selects them
 * all, and the chrome has to say so. Each recorded bar gets its own hairline
 * box; the alternative, a single union box, would span most of the plot and
 * claim the empty space between the bars as part of the object.
 *
 * NO HANDLES, deliberately. A handle says "this one thing, here, with edges you
 * can drag"; there are many boxes and none of them is the object. The boxes plus
 * the Name Box's "Series 1 Error Bars" are the message, and adding six squares
 * to each would turn a selection into a field of confetti.
 *
 * `seriesIndex` absent selects nothing rather than everything: an error-bar rung
 * without a series is a rung that was never produced, and highlighting every
 * series' bars for it would invent an object the format pane cannot target.
 */
export function drawErrorBarsSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  layout: ChartLayout,
  seriesIndex?: number,
): boolean {
  if (seriesIndex === undefined) return false;
  const recorded = layout.elements?.errorBars;
  if (!recorded || recorded.length === 0) return false;

  const mine = recorded.filter((b) => b.seriesIndex === seriesIndex);
  if (mine.length === 0) return false;

  ctx.save();
  ctx.strokeStyle = CHART_SELECTION_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  let painted = false;
  for (const bar of mine) {
    if (bar.rect.width <= 0 && bar.rect.height <= 0) continue;
    const box = elementSelectionBox(bar.rect);
    ctx.strokeRect(chartX + box.x + 0.5, chartY + box.y + 0.5, box.width - 1, box.height - 1);
    painted = true;
  }
  ctx.restore();
  return painted;
}

/** One 5x5 selection square, centred on the point. */
function drawHandleSquare(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const size = 5;
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
}

/**
 * Draw small selection handles at corners and midpoints.
 */
function drawElementSelectionHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const size = 5;
  const half = size / 2;
  ctx.fillStyle = "#0e639c";

  // Four corners
  ctx.fillRect(x - half, y - half, size, size);
  ctx.fillRect(x + w - half, y - half, size, size);
  ctx.fillRect(x - half, y + h - half, size, size);
  ctx.fillRect(x + w - half, y + h - half, size, size);

  // Midpoints of top and bottom edges
  ctx.fillRect(x + w / 2 - half, y - half, size, size);
  ctx.fillRect(x + w / 2 - half, y + h - half, size, size);
}
