//! FILENAME: app/src/api/grid.ts
// PURPOSE: Grid-related API exports for extensions.
// CONTEXT: Re-exports grid state hooks and actions from core.

// Re-export the context hook
export { useGridContext, useGridState, useGridDispatch } from "../core/state/GridContext";

// Re-export grid actions
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
  setFindResults,
  setFindCurrentIndex,
  clearFind,
  openFind,
  closeFind,
  setFindOptions,
  setFreezeConfig,
} from "../core/state/gridActions";

// Re-export action types
export type { GridAction, SetSelectionPayload } from "../core/state/gridActions";

// ============================================================================
// Freeze Panes Orchestration
// ============================================================================

import {
  setFreezePanes as backendSetFreezePanes,
  getFreezePanes as backendGetFreezePanes,
} from "../core/lib/tauri-api";
import { emitAppEvent, AppEvents } from "./events";

/**
 * Set freeze panes via backend and emit events for Shell/Core sync.
 */
export async function freezePanes(
  freezeRow: number | null,
  freezeCol: number | null,
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