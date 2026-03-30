//! FILENAME: app/src/api/grid.ts
// PURPOSE: Grid-related API exports for extensions.
// CONTEXT: Re-exports grid state hooks and actions from core.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.

// Re-export the context hook and non-React state getter
export { useGridContext, useGridState, useGridDispatch, getGridStateSnapshot } from "../core/state/GridContext";

// Re-export hit-testing for extensions
export { getCellFromPixel } from "../core/lib/gridRenderer";

// Re-export grid actions (Find actions removed - they live in FindReplaceDialog extension)
export {
  setSelection,
  clearSelection,
  extendSelection,
  moveSelection,
  setViewport,
  updateScroll,
  scrollBy,
  scrollToCell,
  scrollToPosition,
  startEditing,
  updateEditing,
  stopEditing,
  updateConfig,
  setViewportSize,
  setViewportDimensions,
  expandVirtualBounds,
  setVirtualBounds,
  resetVirtualBounds,
  setFormulaReferences,
  clearFormulaReferences,
  setColumnWidth,
  setRowHeight,
  setAllDimensions,
  setClipboard,
  clearClipboard,
  setSheetContext,
  setActiveSheet,
  setFreezeConfig,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setZoom,
  setSplitConfig,
  setViewMode,
} from "../core/state/gridActions";

// Re-export action types
export type { GridAction, SetSelectionPayload } from "../core/state/gridActions";

// ============================================================================
// Freeze Panes Orchestration
// ============================================================================

import {
  setFreezePanes as backendSetFreezePanes,
  getFreezePanes as backendGetFreezePanes,
  setSplitWindow as backendSetSplitWindow,
  getSplitWindow as backendGetSplitWindow,
  goToSpecial as backendGoToSpecial,
} from "../core/lib/tauri-api";
import { emitAppEvent, AppEvents } from "./events";

/**
 * Set freeze panes via backend and emit events for Shell/Core sync.
 */
export async function freezePanes(
  freezeRow: number | null,
  freezeCol: number | null
): Promise<void> {
  await backendSetFreezePanes(freezeRow, freezeCol);
  emitAppEvent(AppEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Load freeze panes config from backend and emit FREEZE_CHANGED event.
 */
export async function loadFreezePanesConfig(): Promise<{
  freezeRow: number | null;
  freezeCol: number | null;
}> {
  const config = await backendGetFreezePanes();
  emitAppEvent(AppEvents.FREEZE_CHANGED, config);
  return config;
}

// ============================================================================
// Split Window Orchestration
// ============================================================================

/**
 * Set split window via backend and emit events for Shell/Core sync.
 */
export async function splitWindow(
  splitRow: number | null,
  splitCol: number | null
): Promise<void> {
  await backendSetSplitWindow(splitRow, splitCol);
  emitAppEvent(AppEvents.SPLIT_CHANGED, { splitRow, splitCol });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Load split window config from backend and emit SPLIT_CHANGED event.
 */
export async function loadSplitWindowConfig(): Promise<{
  splitRow: number | null;
  splitCol: number | null;
}> {
  const config = await backendGetSplitWindow();
  emitAppEvent(AppEvents.SPLIT_CHANGED, config);
  return config;
}

/**
 * Remove split window.
 */
export async function removeSplitWindow(): Promise<void> {
  await splitWindow(null, null);
}

// ============================================================================
// Go To Special
// ============================================================================

export interface GoToSpecialResult {
  cells: Array<{ row: number; col: number }>;
}

export type GoToSpecialCriteria =
  | "blanks"
  | "formulas"
  | "constants"
  | "errors"
  | "comments"
  | "notes"
  | "conditionalFormats"
  | "dataValidation";

/**
 * Find cells matching specific criteria.
 */
export async function goToSpecial(
  criteria: GoToSpecialCriteria,
  searchRange?: { startRow: number; startCol: number; endRow: number; endCol: number }
): Promise<GoToSpecialResult> {
  const range = searchRange
    ? [searchRange.startRow, searchRange.startCol, searchRange.endRow, searchRange.endCol] as [number, number, number, number]
    : null;
  return await backendGoToSpecial(criteria, range);
}