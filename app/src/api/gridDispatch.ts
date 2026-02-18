//! FILENAME: app/src/api/gridDispatch.ts
// PURPOSE: Module-level bridge for dispatching grid actions from non-React code.
// CONTEXT: Extensions run as plain JS modules and cannot use React hooks.
//          This bridge allows them to dispatch grid actions (e.g., setClipboard)
//          by storing a reference to the dispatch function set by the GridProvider.
// NOTE: The GridProvider must call setGridDispatchRef() on mount.

import type { GridAction } from "../core/state/gridActions";

// ============================================================================
// Internal State
// ============================================================================

type DispatchFn = (action: GridAction) => void;
let _dispatch: DispatchFn | null = null;

// ============================================================================
// Registration (called by GridProvider on mount)
// ============================================================================

/**
 * Store a reference to the grid dispatch function.
 * Called once by the GridProvider when it mounts.
 */
export function setGridDispatchRef(dispatch: DispatchFn): void {
  _dispatch = dispatch;
}

// ============================================================================
// Public API (used by extensions)
// ============================================================================

/**
 * Dispatch a grid action from non-React code.
 * @param action - A grid action created by an action creator from gridActions.ts
 */
export function dispatchGridAction(action: GridAction): void {
  if (_dispatch) {
    _dispatch(action);
  } else {
    console.warn("[gridDispatch] Dispatch not initialized. GridProvider may not have mounted yet.");
  }
}
