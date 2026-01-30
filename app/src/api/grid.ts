//! FILENAME: app/src/api/grid.ts
// PURPOSE: Grid operations API for extensions.
// CONTEXT: Extensions call these functions to manipulate grid state (freeze panes, etc.)
// instead of importing directly from core/lib or core/state.
// The Shell listens for the emitted events and updates Core state accordingly.

import {
  setFreezePanes as setFreezePanesBackend,
  getFreezePanes as getFreezePanesBackend,
} from "../core/lib/tauri-api";
import { AppEvents, emitAppEvent } from "./events";

// ============================================================================
// Freeze Panes API
// ============================================================================

/**
 * Set freeze panes configuration.
 * Calls the Tauri backend, then emits FREEZE_CHANGED so the Shell can
 * update Core state, and emits GRID_REFRESH to repaint.
 *
 * @param freezeRow - Row to freeze at (1 = top row), or null to unfreeze rows
 * @param freezeCol - Column to freeze at (1 = first column), or null to unfreeze columns
 */
export async function freezePanes(
  freezeRow: number | null,
  freezeCol: number | null,
): Promise<void> {
  await setFreezePanesBackend(freezeRow, freezeCol);
  emitAppEvent(AppEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Load the current freeze panes configuration from the backend.
 * Also emits FREEZE_CHANGED so the Shell can sync Core state.
 *
 * @returns The current freeze configuration
 */
export async function loadFreezePanesConfig(): Promise<{
  freezeRow: number | null;
  freezeCol: number | null;
}> {
  const config = await getFreezePanesBackend();
  emitAppEvent(AppEvents.FREEZE_CHANGED, config);
  return config;
}

/**
 * Get the current freeze panes configuration from the backend (read-only, no event).
 *
 * @returns The current freeze configuration
 */
export async function getFreezePanesConfig(): Promise<{
  freezeRow: number | null;
  freezeCol: number | null;
}> {
  return getFreezePanesBackend();
}
