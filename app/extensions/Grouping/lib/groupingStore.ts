//! FILENAME: app/extensions/Grouping/lib/groupingStore.ts
// PURPOSE: State management for the Grouping/Outline extension.
// CONTEXT: Maintains current outline data for the visible viewport,
// applies group results to the grid state, and manages outline bar width.

import {
  groupRows as apiGroupRows,
  ungroupRows as apiUngroupRows,
  groupColumns as apiGroupColumns,
  ungroupColumns as apiUngroupColumns,
  collapseRowGroup as apiCollapseRowGroup,
  expandRowGroup as apiExpandRowGroup,
  collapseColumnGroup as apiCollapseColumnGroup,
  expandColumnGroup as apiExpandColumnGroup,
  showOutlineLevel as apiShowOutlineLevel,
  getOutlineInfo as apiGetOutlineInfo,
  getHiddenRowsByGroup,
  getHiddenColsByGroup,
  clearOutline as apiClearOutline,
  setOutlineSettings as apiSetOutlineSettings,
  setGroupHiddenRows,
  setGroupHiddenCols,
  updateConfig,
  dispatchGridAction,
  requestOverlayRedraw,
} from "../../../src/api";

import type {
  OutlineInfo,
  OutlineSettings,
  GroupResult,
  Viewport,
} from "../../../src/api";

// ============================================================================
// Constants
// ============================================================================

/** Default row header width when there is no outline bar. */
const DEFAULT_ROW_HEADER_WIDTH = 50;

/** Default column header height when there is no outline bar. */
const DEFAULT_COL_HEADER_HEIGHT = 24;

/** Pixels per outline level in the outline bar. */
const PIXELS_PER_LEVEL = 16;

/** Left/top padding so bracket lines are not clipped at the edge. */
const LEFT_PAD = 4;

// ============================================================================
// Module State
// ============================================================================

let currentOutlineInfo: OutlineInfo | null = null;
let lastViewport: Viewport | null = null;

/** Last rendered row Y positions (row index -> pixel Y top). Stored for click hit testing. */
let lastRenderedRowYMap: Map<number, number> = new Map();
/** Last rendered col X positions (col index -> pixel X left). Stored for click hit testing. */
let lastRenderedColXMap: Map<number, number> = new Map();
/** Outline bar width at last render, in pixels. */
let lastRenderedOutlineBarW = 0;
/** Outline bar height at last render, in pixels. */
let lastRenderedOutlineBarH = 0;
/** Column header height at last render, in pixels. */
let lastRenderedColHeaderH = 24;
/** Row header width at last render, in pixels. */
let lastRenderedRowHeaderW = 50;

// ============================================================================
// Public Accessors
// ============================================================================

/** Get the current outline info (used by the renderer). */
export function getCurrentOutlineInfo(): OutlineInfo | null {
  return currentOutlineInfo;
}

/**
 * Store the row Y-position map and config values from the last render pass.
 * Called by outlineBarRenderer after building its maps.
 */
export function updateLastRenderedState(
  rowYMap: Map<number, number>,
  colXMap: Map<number, number>,
  outlineBarW: number,
  outlineBarH: number,
  colHeaderH: number,
  rowHeaderW: number,
): void {
  lastRenderedRowYMap = rowYMap;
  lastRenderedColXMap = colXMap;
  lastRenderedOutlineBarW = outlineBarW;
  lastRenderedOutlineBarH = outlineBarH;
  lastRenderedColHeaderH = colHeaderH;
  lastRenderedRowHeaderW = rowHeaderW;
}

/** Get the render state needed for click hit testing. */
export function getLastRenderedState(): {
  rowYMap: Map<number, number>;
  colXMap: Map<number, number>;
  outlineBarW: number;
  outlineBarH: number;
  colHeaderH: number;
  rowHeaderW: number;
} {
  return {
    rowYMap: lastRenderedRowYMap,
    colXMap: lastRenderedColXMap,
    outlineBarW: lastRenderedOutlineBarW,
    outlineBarH: lastRenderedOutlineBarH,
    colHeaderH: lastRenderedColHeaderH,
    rowHeaderW: lastRenderedRowHeaderW,
  };
}

// ============================================================================
// Outline Bar Size Management
// ============================================================================

/**
 * Adjust rowHeaderWidth and outlineBarWidth in GridConfig based on max row level.
 */
export function updateOutlineBarWidth(maxRowLevel: number): void {
  const outlineBarWidth = maxRowLevel > 0 ? LEFT_PAD + maxRowLevel * PIXELS_PER_LEVEL + 4 : 0;
  const rowHeaderWidth = DEFAULT_ROW_HEADER_WIDTH + outlineBarWidth;
  dispatchGridAction(updateConfig({ rowHeaderWidth, outlineBarWidth }));
}

/**
 * Adjust colHeaderHeight and outlineBarHeight in GridConfig based on max column level.
 */
export function updateOutlineBarHeight(maxColLevel: number): void {
  const outlineBarHeight = maxColLevel > 0 ? LEFT_PAD + maxColLevel * PIXELS_PER_LEVEL + 4 : 0;
  const colHeaderHeight = DEFAULT_COL_HEADER_HEIGHT + outlineBarHeight;
  dispatchGridAction(updateConfig({ colHeaderHeight, outlineBarHeight }));
}

// ============================================================================
// Apply Group Result
// ============================================================================

/**
 * After any grouping operation, apply the result to grid state:
 * - Update group-hidden rows/cols
 * - Update the outline bar width
 * - Refresh the outline info for rendering
 */
async function applyGroupResult(result: GroupResult): Promise<void> {
  if (!result.success) {
    if (result.error) console.warn("[Grouping]", result.error);
    return;
  }

  // Sync group-hidden rows with grid state
  const hiddenRows = await getHiddenRowsByGroup();
  dispatchGridAction(setGroupHiddenRows(hiddenRows));

  const hiddenCols = await getHiddenColsByGroup();
  dispatchGridAction(setGroupHiddenCols(hiddenCols));

  // Update outline bar dimensions based on max levels
  const maxRowLevel = result.outline?.maxRowLevel ?? 0;
  updateOutlineBarWidth(maxRowLevel);
  const maxColLevel = result.outline?.maxColLevel ?? 0;
  updateOutlineBarHeight(maxColLevel);

  // Invalidate cached outline info so refreshOutlineState() re-fetches
  // even when the viewport hasn't changed (collapse/expand changes symbols,
  // not the viewport).
  currentOutlineInfo = null;

  // Refresh outline info for the renderer
  await refreshOutlineState();
}

// ============================================================================
// Outline Info Refresh
// ============================================================================

/** Returns true if two viewports cover the same visible row/col range. */
function viewportEqual(a: Viewport, b: Viewport): boolean {
  return (
    a.startRow === b.startRow &&
    a.startCol === b.startCol &&
    a.rowCount === b.rowCount &&
    a.colCount === b.colCount
  );
}

/**
 * Fetch updated outline info for the given viewport range.
 * Stores result in module state so the renderer can access it synchronously.
 * Skips the backend call when the viewport hasn't changed since the last fetch.
 */
export async function refreshOutlineState(viewport?: Viewport): Promise<void> {
  const vp = viewport ?? lastViewport;
  if (!vp) {
    currentOutlineInfo = null;
    requestOverlayRedraw();
    return;
  }

  // Skip fetch if viewport unchanged (called on every render frame by the renderer)
  if (lastViewport && viewportEqual(vp, lastViewport) && currentOutlineInfo !== null) {
    return;
  }

  lastViewport = vp;

  try {
    const info = await apiGetOutlineInfo(
      vp.startRow,
      vp.startRow + vp.rowCount + 5, // slight buffer
      vp.startCol,
      vp.startCol + vp.colCount + 5,
    );
    currentOutlineInfo = info;
  } catch (err) {
    console.error("[Grouping] refreshOutlineState failed:", err);
    currentOutlineInfo = null;
  }

  requestOverlayRedraw();
}

// ============================================================================
// Public Operations
// ============================================================================

/** Group the given row range (0-based, inclusive). */
export async function performGroupRows(startRow: number, endRow: number): Promise<void> {
  const result = await apiGroupRows(startRow, endRow);
  await applyGroupResult(result);
}

/** Ungroup the given row range. */
export async function performUngroupRows(startRow: number, endRow: number): Promise<void> {
  const result = await apiUngroupRows(startRow, endRow);
  await applyGroupResult(result);
}

/** Group the given column range (0-based, inclusive). */
export async function performGroupColumns(startCol: number, endCol: number): Promise<void> {
  const result = await apiGroupColumns(startCol, endCol);
  await applyGroupResult(result);
}

/** Ungroup the given column range. */
export async function performUngroupColumns(startCol: number, endCol: number): Promise<void> {
  const result = await apiUngroupColumns(startCol, endCol);
  await applyGroupResult(result);
}

/** Collapse the group(s) at the given summary row. */
export async function performCollapseRow(row: number): Promise<void> {
  const result = await apiCollapseRowGroup(row);
  await applyGroupResult(result);
}

/** Expand the group(s) at the given summary row. */
export async function performExpandRow(row: number): Promise<void> {
  const result = await apiExpandRowGroup(row);
  await applyGroupResult(result);
}

/** Collapse the group(s) at the given summary column. */
export async function performCollapseColumn(col: number): Promise<void> {
  const result = await apiCollapseColumnGroup(col);
  await applyGroupResult(result);
}

/** Expand the group(s) at the given summary column. */
export async function performExpandColumn(col: number): Promise<void> {
  const result = await apiExpandColumnGroup(col);
  await applyGroupResult(result);
}

/**
 * Show rows/columns only up to the given outline level.
 * Collapses any groups deeper than the level.
 */
export async function performShowLevel(rowLevel: number): Promise<void> {
  const result = await apiShowOutlineLevel(rowLevel, undefined);
  await applyGroupResult(result);
}

/** Show columns only up to the given outline level. */
export async function performShowColLevel(colLevel: number): Promise<void> {
  const result = await apiShowOutlineLevel(undefined, colLevel);
  await applyGroupResult(result);
}

/** Update outline settings (summary row/col direction). */
export async function performSetOutlineSettings(settings: OutlineSettings): Promise<void> {
  const result = await apiSetOutlineSettings(settings);
  await applyGroupResult(result);
}

/** Remove all grouping from the current sheet. */
export async function performClearOutline(): Promise<void> {
  const result = await apiClearOutline();
  if (result.success) {
    // No groups remain - clear hidden rows from grouping
    dispatchGridAction(setGroupHiddenRows([]));
    dispatchGridAction(setGroupHiddenCols([]));
    updateOutlineBarWidth(0);
    updateOutlineBarHeight(0);
    currentOutlineInfo = null;
    requestOverlayRedraw();
  }
}

/** Reset all local state (called on sheet change). */
export function resetGroupingState(): void {
  currentOutlineInfo = null;
  lastViewport = null;
  lastRenderedRowYMap = new Map();
  lastRenderedColXMap = new Map();
  lastRenderedOutlineBarW = 0;
  lastRenderedOutlineBarH = 0;
  lastRenderedColHeaderH = 24;
  lastRenderedRowHeaderW = 50;
  dispatchGridAction(setGroupHiddenRows([]));
  dispatchGridAction(setGroupHiddenCols([]));
  updateOutlineBarWidth(0);
  updateOutlineBarHeight(0);
  requestOverlayRedraw();
}
