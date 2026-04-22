//! FILENAME: app/extensions/ErrorChecking/lib/errorCheckingStore.ts
// PURPOSE: Local state cache for error checking indicators.
// CONTEXT: Caches error indicator data fetched from the backend for fast
//          per-cell lookup during the render loop (hot path).

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

interface UsedRangeResult {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  empty: boolean;
}

// ============================================================================
// Internal State
// ============================================================================

/** Map of "row,col" -> CellErrorIndicator for fast O(1) lookup during render */
let errorIndicatorMap = new Map<string, CellErrorIndicator>();

/** Debounce timer for refresh calls */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

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
 * Refresh the error indicator cache from the backend.
 * Fetches indicators for the entire used range of the active sheet.
 * Uses debouncing (200ms) to avoid hammering the backend during rapid edits.
 */
export function refreshErrorIndicatorsImmediate(): void {
  // Cancel any pending debounced refresh
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    doFetch();
  }, 200);
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
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ============================================================================
// Internal
// ============================================================================

async function doFetch(): Promise<void> {
  try {
    // Get the used range to know how far to scan
    const usedRange = await invoke<UsedRangeResult>("get_used_range");
    if (usedRange.empty) {
      // Empty sheet — no cells to check
      errorIndicatorMap.clear();
      return;
    }

    const indicators = await invoke<CellErrorIndicator[]>("get_error_indicators", {
      startRow: usedRange.startRow,
      startCol: usedRange.startCol,
      endRow: usedRange.endRow,
      endCol: usedRange.endCol,
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
