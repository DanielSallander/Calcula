//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/viewBookmarkStore.ts
// PURPOSE: Module-scoped state management for view bookmarks.
// CONTEXT: View bookmarks capture and restore application view state (filters, zoom, scroll, etc.).
//          Follows the same module-scoped store pattern as bookmarkStore.ts.

import type {
  ViewBookmark,
  ViewBookmarkCreateOptions,
  ViewStateDimensions,
  ViewStateSnapshot,
  AutoFilterSnapshot,
  SelectionSnapshot,
} from "./viewBookmarkTypes";
import { DEFAULT_VIEW_DIMENSIONS } from "./viewBookmarkTypes";
import type { BookmarkColor } from "./bookmarkTypes";
import {
  dispatchGridAction,
  setSelection,
  setViewport,
  setZoom,
  setViewMode,
  setShowFormulas,
  setFreezeConfig,
  setSplitConfig,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setColumnWidth,
  setRowHeight,
  setActiveSheet,
  setActiveSheetApi,
  scrollToPosition,
  emitAppEvent,
  AppEvents,
  getAutoFilter,
  applyAutoFilter,
  setColumnFilterValues,
  removeAutoFilter,
  clearAutoFilterCriteria,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";

// ============================================================================
// Internal State
// ============================================================================

/** View bookmarks keyed by ID */
const viewBookmarks = new Map<string, ViewBookmark>();

/** Change listeners for reactivity */
const changeListeners = new Set<() => void>();

/** Counter for generating unique IDs */
let nextId = 1;

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return `vb-${nextId++}`;
}

function notifyChange(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[ViewBookmarks] Error in change listener:", error);
    }
  }
}

/** Convert a Map to a plain object for serialization */
function mapToRecord(map: Map<number, number>): Record<number, number> {
  const record: Record<number, number> = {};
  for (const [key, value] of map) {
    record[key] = value;
  }
  return record;
}

/** Convert a Set to a sorted array */
function setToArray(set: Set<number> | undefined): number[] {
  return set ? Array.from(set).sort((a, b) => a - b) : [];
}

// ============================================================================
// State Capture
// ============================================================================

/**
 * Capture the current view state for the specified dimensions.
 * Reads from GridState (synchronous) and AutoFilter (async).
 */
export async function captureCurrentState(
  dimensions: ViewStateDimensions
): Promise<ViewStateSnapshot> {
  const state = getGridStateSnapshot();
  if (!state) return {};

  const snapshot: ViewStateSnapshot = {};

  if (dimensions.selection && state.selection) {
    const sel: SelectionSnapshot = {
      startRow: state.selection.startRow,
      startCol: state.selection.startCol,
      endRow: state.selection.endRow,
      endCol: state.selection.endCol,
      type: state.selection.type,
    };
    if (state.selection.additionalRanges && state.selection.additionalRanges.length > 0) {
      sel.additionalRanges = state.selection.additionalRanges.map((r) => ({
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      }));
    }
    snapshot.selection = sel;
  }

  if (dimensions.viewport) {
    snapshot.viewport = {
      scrollX: state.viewport.scrollX,
      scrollY: state.viewport.scrollY,
    };
  }

  if (dimensions.zoom) {
    snapshot.zoom = state.zoom;
  }

  if (dimensions.activeSheet) {
    snapshot.activeSheet = {
      index: state.sheetContext.activeSheetIndex,
      name: state.sheetContext.activeSheetName,
    };
  }

  if (dimensions.viewMode) {
    snapshot.viewMode = state.viewMode;
  }

  if (dimensions.showFormulas) {
    snapshot.showFormulas = state.showFormulas;
  }

  if (dimensions.freezeConfig) {
    snapshot.freezeConfig = {
      freezeRow: state.freezeConfig.freezeRow,
      freezeCol: state.freezeConfig.freezeCol,
    };
  }

  if (dimensions.splitConfig) {
    snapshot.splitConfig = {
      splitRow: state.splitConfig.splitRow,
      splitCol: state.splitConfig.splitCol,
    };
  }

  if (dimensions.hiddenRows) {
    snapshot.hiddenRows = setToArray(state.dimensions.hiddenRows);
  }

  if (dimensions.hiddenCols) {
    snapshot.hiddenCols = setToArray(state.dimensions.hiddenCols);
  }

  if (dimensions.columnWidths) {
    snapshot.columnWidths = mapToRecord(state.dimensions.columnWidths);
  }

  if (dimensions.rowHeights) {
    snapshot.rowHeights = mapToRecord(state.dimensions.rowHeights);
  }

  if (dimensions.autoFilter) {
    try {
      const filterInfo = await getAutoFilter();
      if (filterInfo) {
        snapshot.autoFilter = {
          startRow: filterInfo.startRow,
          startCol: filterInfo.startCol,
          endRow: filterInfo.endRow,
          endCol: filterInfo.endCol,
          criteria: filterInfo.criteria,
        };
      } else {
        snapshot.autoFilter = null;
      }
    } catch {
      snapshot.autoFilter = null;
    }
  }

  return snapshot;
}

// ============================================================================
// State Restore
// ============================================================================

/**
 * Restore view state from a snapshot.
 * Only restores dimensions that were captured (present in the snapshot).
 */
export async function restoreState(
  snapshot: ViewStateSnapshot,
  dimensions: ViewStateDimensions
): Promise<void> {
  // Restore active sheet first so subsequent actions apply to the right sheet
  if (dimensions.activeSheet && snapshot.activeSheet) {
    const state = getGridStateSnapshot();
    const currentSheet = state?.sheetContext.activeSheetIndex ?? 0;
    if (snapshot.activeSheet.index !== currentSheet) {
      setActiveSheetApi(snapshot.activeSheet.index);
      dispatchGridAction(
        setActiveSheet(snapshot.activeSheet.index, snapshot.activeSheet.name)
      );
      emitAppEvent(AppEvents.SHEET_CHANGED, {
        index: snapshot.activeSheet.index,
        name: snapshot.activeSheet.name,
      });
    }
  }

  if (dimensions.zoom && snapshot.zoom !== undefined) {
    dispatchGridAction(setZoom(snapshot.zoom));
  }

  if (dimensions.viewMode && snapshot.viewMode !== undefined) {
    dispatchGridAction(setViewMode(snapshot.viewMode));
  }

  if (dimensions.showFormulas && snapshot.showFormulas !== undefined) {
    dispatchGridAction(setShowFormulas(snapshot.showFormulas));
  }

  if (dimensions.freezeConfig && snapshot.freezeConfig) {
    dispatchGridAction(
      setFreezeConfig(snapshot.freezeConfig.freezeRow, snapshot.freezeConfig.freezeCol)
    );
  }

  if (dimensions.splitConfig && snapshot.splitConfig) {
    dispatchGridAction(
      setSplitConfig(snapshot.splitConfig.splitRow, snapshot.splitConfig.splitCol)
    );
  }

  if (dimensions.hiddenRows && snapshot.hiddenRows) {
    dispatchGridAction(setHiddenRows(snapshot.hiddenRows));
  }

  if (dimensions.hiddenCols && snapshot.hiddenCols) {
    dispatchGridAction(setHiddenCols(snapshot.hiddenCols));
  }

  if (dimensions.columnWidths && snapshot.columnWidths) {
    for (const [col, width] of Object.entries(snapshot.columnWidths)) {
      dispatchGridAction(setColumnWidth(Number(col), width));
    }
  }

  if (dimensions.rowHeights && snapshot.rowHeights) {
    for (const [row, height] of Object.entries(snapshot.rowHeights)) {
      dispatchGridAction(setRowHeight(Number(row), height));
    }
  }

  // Restore AutoFilter (async)
  if (dimensions.autoFilter) {
    try {
      if (snapshot.autoFilter) {
        const af = snapshot.autoFilter;
        // Apply the filter range first
        await applyAutoFilter(af.startRow, af.startCol, af.endRow, af.endCol);
        // Restore per-column criteria
        for (let i = 0; i < af.criteria.length; i++) {
          const criteria = af.criteria[i];
          if (criteria && criteria.values.length > 0) {
            await setColumnFilterValues(i, criteria.values, !criteria.filterOutBlanks);
          }
        }
      } else {
        // Snapshot captured "no filter" — remove any active filter
        await removeAutoFilter();
      }
    } catch (error) {
      console.warn("[ViewBookmarks] Failed to restore AutoFilter:", error);
    }
  }

  // Restore selection and viewport last
  if (dimensions.selection && snapshot.selection) {
    dispatchGridAction(
      setSelection(
        snapshot.selection.startRow,
        snapshot.selection.startCol,
        snapshot.selection.endRow,
        snapshot.selection.endCol
      )
    );
  }

  if (dimensions.viewport && snapshot.viewport) {
    dispatchGridAction(
      scrollToPosition(snapshot.viewport.scrollX, snapshot.viewport.scrollY)
    );
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/** Create a new view bookmark by capturing current state. */
export async function addViewBookmark(
  options: ViewBookmarkCreateOptions
): Promise<ViewBookmark> {
  const dims = options.dimensions ?? DEFAULT_VIEW_DIMENSIONS;
  const snapshot = await captureCurrentState(dims);
  const now = Date.now();

  const bookmark: ViewBookmark = {
    id: generateId(),
    label: options.label,
    description: options.description,
    color: options.color ?? "blue",
    createdAt: now,
    updatedAt: now,
    dimensions: dims,
    snapshot,
    onActivateScriptId: options.onActivateScriptId,
  };

  viewBookmarks.set(bookmark.id, bookmark);
  notifyChange();
  return bookmark;
}

/** Remove a view bookmark by ID. Returns true if found and removed. */
export function removeViewBookmark(id: string): boolean {
  const removed = viewBookmarks.delete(id);
  if (removed) {
    notifyChange();
  }
  return removed;
}

/** Remove all view bookmarks. */
export function removeAllViewBookmarks(): void {
  if (viewBookmarks.size === 0) return;
  viewBookmarks.clear();
  notifyChange();
}

/** Update a view bookmark's metadata. */
export function updateViewBookmark(
  id: string,
  updates: {
    label?: string;
    description?: string;
    color?: BookmarkColor;
    onActivateScriptId?: string | null;
  }
): boolean {
  const bm = viewBookmarks.get(id);
  if (!bm) return false;

  if (updates.label !== undefined) bm.label = updates.label;
  if (updates.description !== undefined) bm.description = updates.description;
  if (updates.color !== undefined) bm.color = updates.color;
  if (updates.onActivateScriptId !== undefined) {
    bm.onActivateScriptId = updates.onActivateScriptId === null
      ? undefined
      : updates.onActivateScriptId;
  }
  bm.updatedAt = Date.now();
  notifyChange();
  return true;
}

/** Recapture the snapshot for an existing view bookmark. */
export async function recaptureViewBookmark(
  id: string,
  newDimensions?: ViewStateDimensions
): Promise<boolean> {
  const bm = viewBookmarks.get(id);
  if (!bm) return false;

  const dims = newDimensions ?? bm.dimensions;
  const snapshot = await captureCurrentState(dims);

  bm.dimensions = dims;
  bm.snapshot = snapshot;
  bm.updatedAt = Date.now();
  notifyChange();
  return true;
}

/**
 * Optional script runner injected by the extension's activate() function.
 * This avoids the bookmark store needing direct access to the ScriptEditor extension.
 * Signature: (scriptId: string) => Promise<void>
 */
let scriptRunner: ((scriptId: string) => Promise<void>) | null = null;

/** Set the script runner callback (called from extension index.ts during activation). */
export function setScriptRunner(runner: ((scriptId: string) => Promise<void>) | null): void {
  scriptRunner = runner;
}

/** Activate a view bookmark — restore its state and optionally run its script. */
export async function activateViewBookmark(id: string): Promise<boolean> {
  const bm = viewBookmarks.get(id);
  if (!bm) return false;

  await restoreState(bm.snapshot, bm.dimensions);

  // Run onActivate script if linked
  if (bm.onActivateScriptId && scriptRunner) {
    try {
      await scriptRunner(bm.onActivateScriptId);
    } catch (error) {
      console.warn("[ViewBookmarks] Failed to run onActivate script:", error);
    }
  }

  return true;
}

// ============================================================================
// Query Operations
// ============================================================================

/** Get a view bookmark by ID. */
export function getViewBookmark(id: string): ViewBookmark | undefined {
  return viewBookmarks.get(id);
}

/** Get all view bookmarks as an array. */
export function getAllViewBookmarks(): ViewBookmark[] {
  return Array.from(viewBookmarks.values());
}

/** Get total view bookmark count. */
export function getViewBookmarkCount(): number {
  return viewBookmarks.size;
}

/** Get view bookmarks sorted by creation time (newest first). */
export function getSortedViewBookmarks(): ViewBookmark[] {
  return Array.from(viewBookmarks.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
}

// ============================================================================
// Serialization (for persistence)
// ============================================================================

/** Serialize all view bookmarks for saving. */
export function serializeViewBookmarks(): ViewBookmark[] {
  return Array.from(viewBookmarks.values());
}

/** Load view bookmarks from saved data (replaces current state). */
export function loadViewBookmarks(data: ViewBookmark[]): void {
  viewBookmarks.clear();
  let maxId = 0;
  for (const bm of data) {
    viewBookmarks.set(bm.id, bm);
    const numPart = parseInt(bm.id.replace("vb-", ""), 10);
    if (!isNaN(numPart) && numPart > maxId) {
      maxId = numPart;
    }
  }
  nextId = maxId + 1;
  notifyChange();
}

/** Clear all view bookmarks (for new workbook). */
export function clearViewBookmarks(): void {
  viewBookmarks.clear();
  nextId = 1;
  notifyChange();
}

// ============================================================================
// Observer
// ============================================================================

/** Subscribe to view bookmark changes. Returns cleanup function. */
export function onViewBookmarkChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
