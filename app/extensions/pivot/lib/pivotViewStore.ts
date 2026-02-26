//! FILENAME: app/extensions/Pivot/lib/pivotViewStore.ts
// PURPOSE: Shared pivot view cache accessible from both index.ts and pivot-api.ts.
// CONTEXT: Avoids circular imports while allowing IPC responses to be cached immediately.

import type { PivotViewResponse } from "./pivot-api";

/** Cache of the latest PivotViewResponse for each pivot table. */
const pivotViewCache = new Map<number, PivotViewResponse>();

/**
 * Tracks which pivotIds were just cached by updatePivotFields/togglePivotGroup.
 * refreshPivotViewCache only skips the IPC fetch when this flag is set,
 * ensuring that other refresh paths (filters, dialogs, context menu) always
 * fetch fresh data from the backend.
 */
const freshCacheIds = new Set<number>();

/**
 * Store a PivotViewResponse in the cache and mark it as fresh.
 * Called by updatePivotFields/togglePivotGroup after IPC completes.
 */
export function cachePivotView(pivotId: number, view: PivotViewResponse): void {
  pivotViewCache.set(pivotId, view);
  freshCacheIds.add(pivotId);
}

/**
 * Check if the cache for a pivotId was freshly populated (by updatePivotFields
 * or togglePivotGroup) and hasn't been consumed yet.
 */
export function isCacheFresh(pivotId: number): boolean {
  return freshCacheIds.has(pivotId);
}

/**
 * Consume the freshness flag after refreshPivotViewCache uses it.
 */
export function consumeFreshFlag(pivotId: number): void {
  freshCacheIds.delete(pivotId);
}

/**
 * Store a PivotViewResponse WITHOUT marking it as fresh.
 * Used by refreshPivotViewCache's fallback getPivotView path — this avoids
 * polluting the fresh flag which would incorrectly cause the NEXT refresh to skip.
 */
export function setCachedPivotView(pivotId: number, view: PivotViewResponse): void {
  pivotViewCache.set(pivotId, view);
}

/**
 * Get a cached PivotViewResponse by pivotId (synchronous).
 * Used by context menu helpers for synchronous cell type checks.
 */
export function getCachedPivotView(pivotId: number): PivotViewResponse | undefined {
  return pivotViewCache.get(pivotId);
}

/**
 * Get the cached version for a pivotId, or -1 if not cached.
 */
export function getCachedPivotVersion(pivotId: number): number {
  return pivotViewCache.get(pivotId)?.version ?? -1;
}

/**
 * Delete a cached view.
 */
export function deleteCachedPivotView(pivotId: number): void {
  pivotViewCache.delete(pivotId);
}
