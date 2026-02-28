//! FILENAME: app/extensions/Sparklines/rendering.ts
// PURPOSE: Canvas rendering logic for sparklines inside cells.
// CONTEXT: Registered as a cell decoration. Draws line, column, or win/loss
//          sparklines for cells that have sparkline definitions.
//          Data is fetched asynchronously and cached per group.

import type { CellDecorationContext } from "../../src/api/cellDecorations";
import {
  getSparklineForCell,
  getCachedGroupData,
  setCachedGroupData,
  isDataCacheDirty,
  markDataCacheClean,
} from "./store";
import type { SparklineGroup, DataOrientation } from "./types";

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
 *
 * For byRow orientation: each row of the data range becomes one sparkline.
 * For byCol orientation: each column of the data range becomes one sparkline.
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

  // Read all cells in the data range into a 2D grid
  const rawGrid: number[][] = [];
  for (let r = 0; r < dataRows; r++) {
    const row: number[] = [];
    for (let c = 0; c < dataCols; c++) {
      const cell = await getCell(dr.startRow + r, dr.startCol + c);
      const num = cell ? parseFloat(cell.display.replace(/[^0-9.\-]/g, "")) : NaN;
      row.push(isNaN(num) ? 0 : num);
    }
    rawGrid.push(row);
  }

  // Slice the data according to orientation
  const slices: number[][] = [];

  if (orientation === "byRow") {
    // Each row of data -> one sparkline
    for (let i = 0; i < count; i++) {
      if (i < dataRows) {
        slices.push(rawGrid[i]);
      } else {
        slices.push([]);
      }
    }
  } else {
    // byCol: each column of data -> one sparkline
    for (let i = 0; i < count; i++) {
      const colData: number[] = [];
      for (let r = 0; r < dataRows; r++) {
        colData.push(i < dataCols ? rawGrid[r][i] : 0);
      }
      slices.push(colData);
    }
  }

  return slices;
}

// ============================================================================
// Helpers: find special data point indices
// ============================================================================

/** Find the index of the maximum value in data. */
function findHighIndex(data: number[]): number {
  let maxIdx = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] > data[maxIdx]) maxIdx = i;
  }
  return maxIdx;
}

/** Find the index of the minimum value in data. */
function findLowIndex(data: number[]): number {
  let minIdx = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] < data[minIdx]) minIdx = i;
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
  data: number[],
  i: number,
  highIdx: number,
  lowIdx: number,
): string | null {
  let color: string | null = null;
  if (group.showNegativePoints && data[i] < 0) color = group.negativePointColor;
  if (group.showFirstPoint && i === 0) color = group.firstPointColor;
  if (group.showLastPoint && i === data.length - 1) color = group.lastPointColor;
  if (group.showLowPoint && i === lowIdx) color = group.lowPointColor;
  if (group.showHighPoint && i === highIdx) color = group.highPointColor;
  return color;
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

  const data = ensureData(entry.group, entry.index, entry.orientation);
  if (!data || data.length === 0) return;

  switch (entry.group.type) {
    case "line":
      drawLineSparkline(context, entry.group, data);
      break;
    case "column":
      drawColumnSparkline(context, entry.group, data);
      break;
    case "winloss":
      drawWinLossSparkline(context, entry.group, data);
      break;
  }
}

// ============================================================================
// Line Sparkline
// ============================================================================

function drawLineSparkline(
  context: CellDecorationContext,
  group: SparklineGroup,
  data: number[],
): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  const padding = 3;
  const plotLeft = cellLeft + padding;
  const plotTop = cellTop + padding;
  const plotWidth = cellRight - cellLeft - padding * 2;
  const plotHeight = cellBottom - cellTop - padding * 2;

  if (plotWidth < 4 || plotHeight < 4) return;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const pointX = (i: number) => plotLeft + (i / Math.max(data.length - 1, 1)) * plotWidth;
  const pointY = (val: number) => plotTop + plotHeight - ((val - min) / range) * plotHeight;

  ctx.save();

  // Draw the line path
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = pointX(i);
    const y = pointY(data[i]);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = group.color;
  ctx.lineWidth = group.lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Draw general markers if enabled
  if (group.showMarkers && data.length <= 50) {
    const markerRadius = Math.max(1.5, group.lineWidth);
    ctx.fillStyle = group.markerColor || group.color;
    for (let i = 0; i < data.length; i++) {
      ctx.beginPath();
      ctx.arc(pointX(i), pointY(data[i]), markerRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw special point markers (on top, slightly larger)
  const highIdx = findHighIndex(data);
  const lowIdx = findLowIndex(data);
  const specialRadius = Math.max(2.5, group.lineWidth + 1);

  const drawSpecialMarker = (index: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pointX(index), pointY(data[index]), specialRadius, 0, Math.PI * 2);
    ctx.fill();
  };

  // Draw in priority order (lowest priority first, highest last so it paints on top)
  if (group.showNegativePoints) {
    for (let i = 0; i < data.length; i++) {
      if (data[i] < 0) drawSpecialMarker(i, group.negativePointColor);
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
  data: number[],
): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  const padding = 3;
  const plotLeft = cellLeft + padding;
  const plotTop = cellTop + padding;
  const plotWidth = cellRight - cellLeft - padding * 2;
  const plotHeight = cellBottom - cellTop - padding * 2;

  if (plotWidth < 4 || plotHeight < 4) return;

  const min = Math.min(...data, 0);
  const max = Math.max(...data, 0);
  const range = max - min || 1;

  const barGap = 1;
  const totalBarWidth = plotWidth / data.length;
  const barWidth = Math.max(1, totalBarWidth - barGap);

  const zeroY = plotTop + plotHeight - ((0 - min) / range) * plotHeight;

  const highIdx = findHighIndex(data);
  const lowIdx = findLowIndex(data);

  ctx.save();

  for (let i = 0; i < data.length; i++) {
    const x = plotLeft + i * totalBarWidth + (totalBarWidth - barWidth) / 2;
    const valueY = plotTop + plotHeight - ((data[i] - min) / range) * plotHeight;

    const barTop = Math.min(valueY, zeroY);
    const barHeight = Math.max(Math.abs(valueY - zeroY), 1);

    // Default bar color
    let barColor = data[i] >= 0 ? group.color : group.negativeColor;

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
  data: number[],
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

  for (let i = 0; i < data.length; i++) {
    const x = plotLeft + i * totalBarWidth + (totalBarWidth - barWidth) / 2;

    if (data[i] === 0) continue;

    // Default bar color
    let barColor = data[i] > 0 ? group.color : group.negativeColor;

    // Override with special point color if applicable
    const pointColor = getBarPointColor(group, data, i, highIdx, lowIdx);
    if (pointColor) barColor = pointColor;

    ctx.fillStyle = barColor;
    if (data[i] > 0) {
      ctx.fillRect(Math.round(x), Math.round(midY - barHeight), Math.round(barWidth), Math.round(barHeight));
    } else {
      ctx.fillRect(Math.round(x), Math.round(midY + 1), Math.round(barWidth), Math.round(barHeight));
    }
  }

  ctx.restore();
}
