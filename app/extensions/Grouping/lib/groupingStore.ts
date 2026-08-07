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
  createCoalescedRefresh,
} from "@api";

import type {
  OutlineInfo,
  OutlineSettings,
  GroupResult,
  Viewport,
} from "@api";

// ============================================================================
// Constants
// ============================================================================

/** Default row header width when there is no outline bar (matches DEFAULT_GRID_CONFIG). */
const DEFAULT_ROW_HEADER_WIDTH = 22;

/** Default column header height when there is no outline bar (matches DEFAULT_GRID_CONFIG). */
const DEFAULT_COL_HEADER_HEIGHT = 20;

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
 *
 * The corner hosts (maxRowLevel + 1) horizontal level buttons (Excel shows a
 * "collapse all" button plus one per level), so the bar must be wide enough for
 * all of them — otherwise the last button spills into the row-number header.
 */
export function updateOutlineBarWidth(maxRowLevel: number): void {
  const outlineBarWidth = maxRowLevel > 0 ? LEFT_PAD + (maxRowLevel + 1) * PIXELS_PER_LEVEL : 0;
  const rowHeaderWidth = DEFAULT_ROW_HEADER_WIDTH + outlineBarWidth;
  dispatchGridAction(updateConfig({ rowHeaderWidth, outlineBarWidth }));
}

/**
 * Adjust colHeaderHeight and outlineBarHeight in GridConfig based on max column level.
 *
 * The corner hosts (maxColLevel + 1) vertically-stacked level buttons, so the
 * bar must be tall enough for all of them.
 */
export function updateOutlineBarHeight(maxColLevel: number): void {
  const outlineBarHeight = maxColLevel > 0 ? LEFT_PAD + (maxColLevel + 1) * PIXELS_PER_LEVEL : 0;
  const colHeaderHeight = DEFAULT_COL_HEADER_HEIGHT + outlineBarHeight;
  dispatchGridAction(updateConfig({ colHeaderHeight, outlineBarHeight }));
}

// ============================================================================
// Apply Group Result
// ============================================================================

/**
 * Re-read the whole outline from the backend and put the grid in step with it:
 * the group-hidden row/col sets, the outline bar size, and the cached symbols
 * the renderer paints.
 *
 * THIS IS THE ONLY PLACE THAT SYNCS, and it is deliberately usable with no
 * local knowledge of what changed — that is what lets an out-of-band mutation
 * (a sheet switch onto a sheet that already has an outline, a freshly opened
 * workbook, an AppEvents.OUTLINE_CHANGED dispatched by something that never
 * called through here) recover the same state a local group/ungroup does.
 *
 * The max row/column levels are SHEET-level in the backend, not viewport-level,
 * so a probe range is enough when nothing has been rendered yet. That matters:
 * `renderOutlineBar` returns immediately while the bar has zero width AND zero
 * height, so a state where the bar is 0 and only the renderer would re-fetch is
 * a state the outline can never come back from. Sizing the bar here is what
 * restarts that loop; the renderer's own refreshOutlineState then fills in the
 * symbols for the real viewport.
 *
 * Never rejects — a failed resync logs and leaves the previous state, exactly
 * as refreshOutlineState does.
 */
const outlineRefresh = createCoalescedRefresh(async (stillCurrent) => {
  try {
    const hiddenRows = await getHiddenRowsByGroup();
    if (!stillCurrent()) return;
    dispatchGridAction(setGroupHiddenRows(hiddenRows));

    const hiddenCols = await getHiddenColsByGroup();
    if (!stillCurrent()) return;
    dispatchGridAction(setGroupHiddenCols(hiddenCols));

    const vp = lastViewport;
    const info = await apiGetOutlineInfo(
      vp ? vp.startRow : 0,
      vp ? vp.startRow + vp.rowCount + 5 : 0,
      vp ? vp.startCol : 0,
      vp ? vp.startCol + vp.colCount + 5 : 0,
    );
    if (!stillCurrent()) return;

    updateOutlineBarWidth(info.maxRowLevel);
    updateOutlineBarHeight(info.maxColLevel);

    // Only adopt the symbols when they were fetched for the viewport actually
    // on screen. With no viewport yet, leaving the cache empty makes the very
    // next render pass fetch the right range instead of painting a probe.
    currentOutlineInfo = vp ? info : null;
  } catch (err) {
    console.error("[Grouping] outline resync failed:", err);
  }
  requestOverlayRedraw();
});

/**
 * Request an outline resync. This is what an ANNOUNCEMENT listener calls
 * (AppEvents.OUTLINE_CHANGED), and what a sheet change / workbook open calls.
 */
export function resyncOutlineFromBackend(): Promise<void> {
  return outlineRefresh.request();
}

/**
 * After any grouping operation, put the grid back in step with the backend.
 *
 * Awaiting the resync here is what keeps the GroupingController contract: the
 * grid, the outline bar and the backend agree before the operation resolves.
 */
async function applyGroupResult(result: GroupResult): Promise<void> {
  if (!result.success) {
    if (result.error) console.warn("[Grouping]", result.error);
    return;
  }
  await outlineRefresh.join();
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
  // Through the same resync as every other operation rather than zeroing the
  // local state by hand: "the backend says there is no outline" and "we assume
  // there is no outline" are different claims, and only the first one survives
  // a clear that the backend partially refused.
  await applyGroupResult(await apiClearOutline());
}

// ============================================================================
// Controller Operations (the @api/groupingService seam)
// ============================================================================
//
// Same backend calls, same grid sync as the perform* handlers above — the
// difference is the CONTRACT. A ribbon handler swallows a failure into a
// console.warn because the user is looking at the sheet; a script is not, so
// the controller THROWS on failure and answers with what actually changed.

/** Apply a result for the controller: sync the grid, then answer or throw. */
async function applyForController(result: GroupResult): Promise<{
  maxRowLevel: number;
  maxColLevel: number;
  hiddenRowsChanged: number[];
  hiddenColsChanged: number[];
}> {
  if (!result.success) {
    throw new Error(result.error || "The grouping operation failed");
  }
  await applyGroupResult(result);
  return {
    maxRowLevel: result.outline?.maxRowLevel ?? 0,
    maxColLevel: result.outline?.maxColLevel ?? 0,
    hiddenRowsChanged: result.hiddenRowsChanged ?? [],
    hiddenColsChanged: result.hiddenColsChanged ?? [],
  };
}

/** Controller: group a row span (throws on failure). */
export async function controllerGroupRows(startRow: number, endRow: number) {
  return applyForController(await apiGroupRows(startRow, endRow));
}

/** Controller: ungroup a row span (throws on failure). */
export async function controllerUngroupRows(startRow: number, endRow: number) {
  return applyForController(await apiUngroupRows(startRow, endRow));
}

/** Controller: group a column span (throws on failure). */
export async function controllerGroupColumns(startCol: number, endCol: number) {
  return applyForController(await apiGroupColumns(startCol, endCol));
}

/** Controller: ungroup a column span (throws on failure). */
export async function controllerUngroupColumns(startCol: number, endCol: number) {
  return applyForController(await apiUngroupColumns(startCol, endCol));
}

/** Controller: show rows/columns up to an outline level (null = leave that
 *  axis alone). ONE backend call, so both axes land as one operation. */
export async function controllerShowOutlineLevel(
  rowLevel: number | null,
  colLevel: number | null,
) {
  return applyForController(
    await apiShowOutlineLevel(rowLevel ?? undefined, colLevel ?? undefined),
  );
}

/**
 * Reset all local state.
 *
 * Used on DEACTIVATION, and by the sheet-change handler as the first half of
 * "forget this sheet's outline, then read the next one's" — on its own it makes
 * the outline unrecoverable, because it zeroes the bar and `renderOutlineBar`
 * bails while the bar is zero-sized, so nothing ever re-fetches. Callers that
 * are not tearing down MUST follow it with resyncOutlineFromBackend().
 */
export function resetGroupingState(): void {
  // Abandon any in-flight resync: it is reading the sheet we are leaving, and
  // its hidden-row set would hide the wrong rows on the sheet we arrive at.
  outlineRefresh.invalidate();
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
