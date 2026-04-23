//! FILENAME: app/extensions/ErrorChecking/lib/errorCheckingStore.ts
// PURPOSE: Local state cache for error checking indicators.
// CONTEXT: Caches error indicator data fetched from the backend for fast
//          per-cell lookup during the render loop (hot path).
//          Only scans the current VIEWPORT (not the full used range) for performance.

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export interface CellErrorIndicator {
  row: number;
  col: number;
  errorType: string;
  message: string;
}

// ============================================================================
// Internal State
// ============================================================================

/** Map of "row,col" -> CellErrorIndicator for fast O(1) lookup during render */
let errorIndicatorMap = new Map<string, CellErrorIndicator>();

/** Debounce timer for refresh calls */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Last viewport bounds used for fetch, so invalidation can re-evaluate */
let lastViewport: { startRow: number; startCol: number; endRow: number; endCol: number } | null = null;

// ============================================================================
// Key helpers
// ============================================================================

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Refresh the error indicator cache from the backend for the given viewport.
 * Only scans visible rows/cols (plus a small buffer) instead of the full used range.
 * Uses debouncing (200ms) to avoid hammering the backend during rapid edits.
 *
 * @param startRow - First visible row
 * @param startCol - First visible column
 * @param endRow   - Last visible row
 * @param endCol   - Last visible column
 */
export function refreshErrorIndicators(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): void {
  // Add a buffer around the viewport for smoother scrolling
  const bufferRows = 20;
  const bufferCols = 5;
  lastViewport = {
    startRow: Math.max(0, startRow - bufferRows),
    startCol: Math.max(0, startCol - bufferCols),
    endRow: endRow + bufferRows,
    endCol: endCol + bufferCols,
  };

  // Cancel any pending debounced refresh
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    doFetch(lastViewport!.startRow, lastViewport!.startCol, lastViewport!.endRow, lastViewport!.endCol);
  }, 200);
}

/**
 * Re-evaluate using the last known viewport bounds (e.g., after a data change).
 * If no viewport has been set yet, this is a no-op.
 */
export function refreshErrorIndicatorsFromLastViewport(): void {
  if (!lastViewport) return;
  refreshErrorIndicators(
    lastViewport.startRow,
    lastViewport.startCol,
    lastViewport.endRow,
    lastViewport.endCol,
  );
}

/**
 * Get the error indicator at a specific cell, if any.
 * Called from the cell decoration render function (hot path).
 */
export function getErrorIndicatorAt(
  row: number,
  col: number,
): CellErrorIndicator | undefined {
  return errorIndicatorMap.get(cellKey(row, col));
}

/**
 * Reset the store (on deactivation or sheet change).
 */
export function resetErrorStore(): void {
  errorIndicatorMap.clear();
  lastViewport = null;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ============================================================================
// Internal
// ============================================================================

async function doFetch(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  try {
    const indicators = await invoke<CellErrorIndicator[]>("get_error_indicators", {
      startRow,
      startCol,
      endRow,
      endCol,
    });

    // Rebuild the lookup map
    errorIndicatorMap = new Map<string, CellErrorIndicator>();
    for (const indicator of indicators) {
      errorIndicatorMap.set(cellKey(indicator.row, indicator.col), indicator);
    }
  } catch (error) {
    console.error("[ErrorChecking] Failed to fetch error indicators:", error);
  }
}
