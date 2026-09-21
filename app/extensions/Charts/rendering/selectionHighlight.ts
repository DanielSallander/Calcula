//! FILENAME: app/extensions/Charts/rendering/selectionHighlight.ts
// PURPOSE: How a chart shows WHICH element the reader has selected — the
//          outline on the chosen bar, point or slice, the handles on it, and
//          the wash over everything else.
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

import type { BarRect, HitGeometry } from "../types";

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
