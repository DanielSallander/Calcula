//! FILENAME: app/extensions/Sparklines/rendering.ts
// PURPOSE: Canvas rendering logic for sparklines inside cells.
// CONTEXT: Registered as a cell decoration. Draws line, column, or win/loss
//          sparklines for cells that have sparkline definitions.
//          Data is fetched asynchronously and cached per group.
//          Supports axis line, min/max scaling, empty cell handling, and plot order.

import type { CellDecorationContext } from "@api/cellDecorations";
import {
  getSparklineForCell,
  getCachedGroupData,
  setCachedGroupData,
  isDataCacheDirty,
  markDataCacheClean,
  getAllGroups,
} from "./store";
import type { SparklineGroup, DataOrientation, EmptyCellHandling } from "./types";

// ============================================================================
// Data Fetching (async, per group)
// ============================================================================

/** Set of group IDs currently being fetched */
const pendingFetches = new Set<number>();

/**
 * Ensure data is available for a sparkline group.
 * Returns the data slice for the given index, or null if still loading.
 */
function ensureData(
  group: SparklineGroup,
  index: number,
  orientation: DataOrientation,
): number[] | null {
  const cached = getCachedGroupData(group.id);
  if (cached !== null && !isDataCacheDirty()) {
    return cached[index] ?? null;
  }

  // Avoid duplicate fetches for the same group
  if (pendingFetches.has(group.id)) {
    return cached?.[index] ?? null;
  }

  pendingFetches.add(group.id);

  fetchGroupData(group, orientation).then((slices) => {
    pendingFetches.delete(group.id);
    setCachedGroupData(group.id, slices);
    markDataCacheClean();

    // Trigger grid repaint
    import("../../src/api/events").then(({ emitAppEvent, AppEvents }) => {
      emitAppEvent(AppEvents.GRID_REFRESH);
    });
  }).catch((err) => {
    pendingFetches.delete(group.id);
    console.error("[Sparklines] Data fetch error:", err);
  });

  return cached?.[index] ?? null;
}

/**
 * Fetch all data for a sparkline group.
 * Returns an array of number arrays: one per sparkline (location cell).
 * NaN values are preserved (not replaced with 0) so that the renderer
 * can apply the group's emptyCellHandling setting.
 */
async function fetchGroupData(
  group: SparklineGroup,
  orientation: DataOrientation,
): Promise<number[][]> {
  const { getCell } = await import("../../src/api/lib");

  const dr = group.dataRange;
  const dataRows = dr.endRow - dr.startRow + 1;
  const dataCols = dr.endCol - dr.startCol + 1;

  const locRows = group.location.endRow - group.location.startRow + 1;
  const locCols = group.location.endCol - group.location.startCol + 1;
  const count = Math.max(locRows, locCols);

  // Read all cells in the data range into a 2D grid (preserve NaN for empty cells)
  const rawGrid: number[][] = [];
  for (let r = 0; r < dataRows; r++) {
    const row: number[] = [];
    for (let c = 0; c < dataCols; c++) {
      const cell = await getCell(dr.startRow + r, dr.startCol + c);
      const num = cell ? parseFloat(cell.display.replace(/[^0-9.\-]/g, "")) : NaN;
      row.push(num); // Keep NaN — renderer handles it via emptyCellHandling
    }
    rawGrid.push(row);
  }

  // Slice the data according to orientation
  const slices: number[][] = [];

  if (orientation === "byRow") {
    for (let i = 0; i < count; i++) {
      if (i < dataRows) {
        slices.push(rawGrid[i]);
      } else {
        slices.push([]);
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      const colData: number[] = [];
      for (let r = 0; r < dataRows; r++) {
        colData.push(i < dataCols ? rawGrid[r][i] : NaN);
      }
      slices.push(colData);
    }
  }

  return slices;
}

// ============================================================================
// Data preprocessing: empty cell handling and plot order
// ============================================================================

/**
 * A data point with its original index and value.
 * Used to track positions for gap handling and special point detection.
 */
interface DataPoint {
  /** Original index in the raw data array */
  originalIndex: number;
  /** Numeric value (NaN = empty/gap) */
  value: number;
}

/**
 * Preprocess raw data according to group settings:
 * - Apply plot order (reverse if rightToLeft)
 * - Apply empty cell handling (gaps, zero, connect)
 * Returns processed DataPoint array.
 */
function preprocessData(
  rawData: number[],
  group: SparklineGroup,
): DataPoint[] {
  let data = rawData.map((value, i) => ({ originalIndex: i, value }));

  // Apply plot order
  if (group.plotOrder === "rightToLeft") {
    data.reverse();
    // Re-index after reversal
    data = data.map((d, i) => ({ ...d, originalIndex: i }));
  }

  // Apply empty cell handling
  const handling = group.emptyCellHandling;
  if (handling === "zero") {
    // Replace NaN with 0
    for (const d of data) {
      if (isNaN(d.value)) d.value = 0;
    }
  } else if (handling === "connect") {
    // Interpolate over NaN gaps (for line sparklines)
    // For column/winloss, treat as zero
    interpolateGaps(data);
  }
  // "gaps" mode: leave NaN as-is, renderer will skip those points

  return data;
}

/**
 * Linear interpolation over NaN gaps in data.
 * Leading/trailing NaNs are left as NaN (they become gaps at the edges).
 */
function interpolateGaps(data: DataPoint[]): void {
  let i = 0;
  while (i < data.length) {
    if (!isNaN(data[i].value)) {
      i++;
      continue;
    }

    // Find the start of the gap
    const gapStart = i;

    // Find the end of the gap
    while (i < data.length && isNaN(data[i].value)) {
      i++;
    }
    const gapEnd = i;

    // Interpolate if we have values on both sides
    const prevIdx = gapStart - 1;
    const nextIdx = gapEnd;

    if (prevIdx >= 0 && nextIdx < data.length) {
      const prevVal = data[prevIdx].value;
      const nextVal = data[nextIdx].value;
      const span = gapEnd - gapStart + 2; // +2 for the boundary points
      for (let j = gapStart; j < gapEnd; j++) {
        const t = (j - prevIdx) / (span - 1);
        data[j].value = prevVal + t * (nextVal - prevVal);
      }
    }
    // Leading/trailing NaNs stay NaN
  }
}

// ============================================================================
// Helpers: min/max with axis scaling
// ============================================================================

/**
 * Compute the effective min/max for rendering based on axis scale settings.
 */
function getScaleMinMax(
  group: SparklineGroup,
  dataPoints: DataPoint[],
): { min: number; max: number } {
  // Get data min/max (ignoring NaN)
  const values = dataPoints.map((d) => d.value).filter((v) => !isNaN(v));
  if (values.length === 0) return { min: 0, max: 1 };

  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);

  if (group.axisScaleType === "custom") {
    if (group.axisMinValue !== null) dataMin = group.axisMinValue;
    if (group.axisMaxValue !== null) dataMax = group.axisMaxValue;
  } else if (group.axisScaleType === "sameForAll") {
    // Compute min/max across ALL sparklines in this group's data
    const allGroups = getAllGroups();
    const sameGroup = allGroups.find((g) => g.id === group.id);
    if (sameGroup) {
      // The cached data for this group contains all slices
      const allData = getCachedGroupData(group.id);
      if (allData) {
        for (const slice of allData) {
          for (const v of slice) {
            if (!isNaN(v)) {
              if (v < dataMin) dataMin = v;
              if (v > dataMax) dataMax = v;
            }
          }
        }
      }
    }
  }

  if (dataMin === dataMax) {
    // Avoid zero range
    dataMin -= 0.5;
    dataMax += 0.5;
  }

  return { min: dataMin, max: dataMax };
}

// ============================================================================
// Helpers: find special data point indices
// ============================================================================

/** Find the index of the maximum value in data (skipping NaN). */
function findHighIndex(data: DataPoint[]): number {
  let maxIdx = -1;
  let maxVal = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (!isNaN(data[i].value) && data[i].value > maxVal) {
      maxVal = data[i].value;
      maxIdx = i;
    }
  }
  return maxIdx;
}

/** Find the index of the minimum value in data (skipping NaN). */
function findLowIndex(data: DataPoint[]): number {
  let minIdx = -1;
  let minVal = Infinity;
  for (let i = 0; i < data.length; i++) {
    if (!isNaN(data[i].value) && data[i].value < minVal) {
      minVal = data[i].value;
      minIdx = i;
    }
  }
  return minIdx;
}

/**
 * Determine the fill color for a bar at a given index, accounting for
 * special point visibility flags. Returns the override color or null.
 * Priority (last applied wins): negative < first < last < low < high.
 */
function getBarPointColor(
  group: SparklineGroup,
  data: DataPoint[],
  i: number,
  highIdx: number,
  lowIdx: number,
): string | null {
  let color: string | null = null;
  if (group.showNegativePoints && data[i].value < 0) color = group.negativePointColor;
  if (group.showFirstPoint && i === 0) color = group.firstPointColor;
  if (group.showLastPoint && i === data.length - 1) color = group.lastPointColor;
  if (group.showLowPoint && i === lowIdx) color = group.lowPointColor;
  if (group.showHighPoint && i === highIdx) color = group.highPointColor;
  return color;
}

// ============================================================================
// Draw axis line
// ============================================================================

function drawAxisLine(
  ctx: CanvasRenderingContext2D,
  plotLeft: number,
  plotTop: number,
  plotWidth: number,
  plotHeight: number,
  min: number,
  max: number,
): void {
  const range = max - min;
  if (range === 0) return;

  // Only draw if zero is within the visible range
  if (min > 0 || max < 0) return;

  const zeroY = plotTop + plotHeight - ((0 - min) / range) * plotHeight;

  ctx.save();
  ctx.strokeStyle = "#999999";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(plotLeft, Math.round(zeroY) + 0.5);
  ctx.lineTo(plotLeft + plotWidth, Math.round(zeroY) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ============================================================================
// Cell Decoration Entry Point
// ============================================================================

/**
 * Cell decoration function for sparklines.
 * Called for every visible cell during the render loop.
 * Only draws for cells that belong to a sparkline group.
 */
export function drawSparkline(context: CellDecorationContext): void {
  const { row, col } = context;

  const entry = getSparklineForCell(row, col);
  if (!entry) return;

  const rawData = ensureData(entry.group, entry.index, entry.orientation);
  if (!rawData || rawData.length === 0) return;

  // Preprocess: apply plot order and empty cell handling
  const data = preprocessData(rawData, entry.group);
  if (data.length === 0) return;

  // Compute scale
  const { min, max } = getScaleMinMax(entry.group, data);

  switch (entry.group.type) {
    case "line":
      drawLineSparkline(context, entry.group, data, min, max);
      break;
    case "column":
      drawColumnSparkline(context, entry.group, data, min, max);
      break;
    case "winloss":
      drawWinLossSparkline(context, entry.group, data, min, max);
      break;
  }
}

// ============================================================================
// Line Sparkline
// ============================================================================

function drawLineSparkline(
  context: CellDecorationContext,
  group: SparklineGroup,
  data: DataPoint[],
  scaleMin: number,
  scaleMax: number,
): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  const padding = 3;
  const plotLeft = cellLeft + padding;
  const plotTop = cellTop + padding;
  const plotWidth = cellRight - cellLeft - padding * 2;
  const plotHeight = cellBottom - cellTop - padding * 2;

  if (plotWidth < 4 || plotHeight < 4) return;

  const range = scaleMax - scaleMin || 1;

  const pointX = (i: number) => plotLeft + (i / Math.max(data.length - 1, 1)) * plotWidth;
  const pointY = (val: number) => plotTop + plotHeight - ((val - scaleMin) / range) * plotHeight;

  ctx.save();

  // Draw axis line if enabled
  if (group.showAxis) {
    drawAxisLine(ctx, plotLeft, plotTop, plotWidth, plotHeight, scaleMin, scaleMax);
  }

  // Draw the line path (handling gaps)
  ctx.strokeStyle = group.color;
  ctx.lineWidth = group.lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Collect segments (break at NaN gaps)
  const segments: Array<{ startIdx: number; points: Array<{ x: number; y: number }> }> = [];
  let currentSegment: Array<{ x: number; y: number }> | null = null;
  let segStartIdx = 0;

  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i].value)) {
      if (currentSegment && currentSegment.length > 0) {
        segments.push({ startIdx: segStartIdx, points: currentSegment });
      }
      currentSegment = null;
      continue;
    }

    if (!currentSegment) {
      currentSegment = [];
      segStartIdx = i;
    }
    currentSegment.push({ x: pointX(i), y: pointY(data[i].value) });
  }

  if (currentSegment && currentSegment.length > 0) {
    segments.push({ startIdx: segStartIdx, points: currentSegment });
  }

  // Draw each segment
  for (const seg of segments) {
    if (seg.points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg.points[0].x, seg.points[0].y);
    for (let j = 1; j < seg.points.length; j++) {
      ctx.lineTo(seg.points[j].x, seg.points[j].y);
    }
    ctx.stroke();
  }

  // Draw general markers if enabled (only on non-NaN points)
  if (group.showMarkers && data.length <= 50) {
    const markerRadius = Math.max(1.5, group.lineWidth);
    ctx.fillStyle = group.markerColor || group.color;
    for (let i = 0; i < data.length; i++) {
      if (isNaN(data[i].value)) continue;
      ctx.beginPath();
      ctx.arc(pointX(i), pointY(data[i].value), markerRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw special point markers (on top, slightly larger)
  const highIdx = findHighIndex(data);
  const lowIdx = findLowIndex(data);
  const specialRadius = Math.max(2.5, group.lineWidth + 1);

  const drawSpecialMarker = (index: number, color: string) => {
    if (index < 0 || isNaN(data[index].value)) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pointX(index), pointY(data[index].value), specialRadius, 0, Math.PI * 2);
    ctx.fill();
  };

  // Draw in priority order (lowest priority first, highest last so it paints on top)
  if (group.showNegativePoints) {
    for (let i = 0; i < data.length; i++) {
      if (!isNaN(data[i].value) && data[i].value < 0) drawSpecialMarker(i, group.negativePointColor);
    }
  }
  if (group.showFirstPoint) drawSpecialMarker(0, group.firstPointColor);
  if (group.showLastPoint) drawSpecialMarker(data.length - 1, group.lastPointColor);
  if (group.showLowPoint) drawSpecialMarker(lowIdx, group.lowPointColor);
  if (group.showHighPoint) drawSpecialMarker(highIdx, group.highPointColor);

  ctx.restore();
}

// ============================================================================
// Column Sparkline
// ============================================================================

function drawColumnSparkline(
  context: CellDecorationContext,
  group: SparklineGroup,
  data: DataPoint[],
  scaleMin: number,
  scaleMax: number,
): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  const padding = 3;
  const plotLeft = cellLeft + padding;
  const plotTop = cellTop + padding;
  const plotWidth = cellRight - cellLeft - padding * 2;
  const plotHeight = cellBottom - cellTop - padding * 2;

  if (plotWidth < 4 || plotHeight < 4) return;

  const min = Math.min(scaleMin, 0);
  const max = Math.max(scaleMax, 0);
  const range = max - min || 1;

  const barGap = 1;
  const totalBarWidth = plotWidth / data.length;
  const barWidth = Math.max(1, totalBarWidth - barGap);

  const zeroY = plotTop + plotHeight - ((0 - min) / range) * plotHeight;

  const highIdx = findHighIndex(data);
  const lowIdx = findLowIndex(data);

  ctx.save();

  // Draw axis line if enabled
  if (group.showAxis) {
    drawAxisLine(ctx, plotLeft, plotTop, plotWidth, plotHeight, min, max);
  }

  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i].value)) continue; // Skip gaps

    const x = plotLeft + i * totalBarWidth + (totalBarWidth - barWidth) / 2;
    const valueY = plotTop + plotHeight - ((data[i].value - min) / range) * plotHeight;

    const barTop = Math.min(valueY, zeroY);
    const barHeight = Math.max(Math.abs(valueY - zeroY), 1);

    // Default bar color
    let barColor = data[i].value >= 0 ? group.color : group.negativeColor;

    // Override with special point color if applicable
    const pointColor = getBarPointColor(group, data, i, highIdx, lowIdx);
    if (pointColor) barColor = pointColor;

    ctx.fillStyle = barColor;
    ctx.fillRect(Math.round(x), Math.round(barTop), Math.round(barWidth), Math.round(barHeight));
  }

  ctx.restore();
}

// ============================================================================
// Win/Loss Sparkline
// ============================================================================

function drawWinLossSparkline(
  context: CellDecorationContext,
  group: SparklineGroup,
  data: DataPoint[],
  _scaleMin: number,
  _scaleMax: number,
): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  const padding = 3;
  const plotLeft = cellLeft + padding;
  const plotTop = cellTop + padding;
  const plotWidth = cellRight - cellLeft - padding * 2;
  const plotHeight = cellBottom - cellTop - padding * 2;

  if (plotWidth < 4 || plotHeight < 4) return;

  const barGap = 1;
  const totalBarWidth = plotWidth / data.length;
  const barWidth = Math.max(1, totalBarWidth - barGap);
  const halfHeight = plotHeight / 2;
  const midY = plotTop + halfHeight;
  const barHeight = halfHeight - 1;

  const highIdx = findHighIndex(data);
  const lowIdx = findLowIndex(data);

  ctx.save();

  // Draw axis line at midpoint if enabled
  if (group.showAxis) {
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(midY) + 0.5);
    ctx.lineTo(plotLeft + plotWidth, Math.round(midY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i].value) || data[i].value === 0) continue;

    const x = plotLeft + i * totalBarWidth + (totalBarWidth - barWidth) / 2;

    // Default bar color
    let barColor = data[i].value > 0 ? group.color : group.negativeColor;

    // Override with special point color if applicable
    const pointColor = getBarPointColor(group, data, i, highIdx, lowIdx);
    if (pointColor) barColor = pointColor;

    ctx.fillStyle = barColor;
    if (data[i].value > 0) {
      ctx.fillRect(Math.round(x), Math.round(midY - barHeight), Math.round(barWidth), Math.round(barHeight));
    } else {
      ctx.fillRect(Math.round(x), Math.round(midY + 1), Math.round(barWidth), Math.round(barHeight));
    }
  }

  ctx.restore();
}
