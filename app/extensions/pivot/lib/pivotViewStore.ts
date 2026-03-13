//! FILENAME: app/extensions/Pivot/lib/pivotViewStore.ts
// PURPOSE: Shared pivot view cache accessible from both index.ts and pivot-api.ts.
// CONTEXT: Avoids circular imports while allowing IPC responses to be cached immediately.

import type { PivotViewResponse, PivotRowData, PivotCellWindowResponse } from "./pivot-api";

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
  // Seed cell window cache with the initial window from the response
  if (view.isWindowed) {
    const cache = getOrCreateCellWindowCache(pivotId);
    cache.invalidate();
    cache.version = view.version;
    if (view.rows.length > 0) {
      cache.setWindow(view.windowStartRow ?? 0, view.rows);
    }
  } else {
    // Non-windowed: clear any stale cell window cache
    cellWindowCaches.delete(pivotId);
  }
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
  // Also seed cell window cache for windowed responses
  if (view.isWindowed) {
    const cache = getOrCreateCellWindowCache(pivotId);
    cache.invalidate();
    cache.version = view.version;
    if (view.rows.length > 0) {
      cache.setWindow(view.windowStartRow ?? 0, view.rows);
    }
  } else {
    cellWindowCaches.delete(pivotId);
  }
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
  cellWindowCaches.delete(pivotId);
  loadingPivots.delete(pivotId);
  previousViews.delete(pivotId);
}

// ============================================================================
// OPERATION SUPERSEDING (newer operation cancels in-flight older one)
// ============================================================================

/** Monotonically increasing operation sequence per pivot. */
const operationSeq = new Map<number, number>();

/** Promise of the currently in-flight operation per pivot. */
const inflightOps = new Map<number, Promise<unknown>>();

/**
 * Start a new operation for a pivot. Returns the sequence number.
 * If an operation is already in flight, it will be implicitly superseded
 * (its sequence check will fail when it completes).
 */
export function startOperation(pivotId: number): number {
  const seq = (operationSeq.get(pivotId) ?? 0) + 1;
  operationSeq.set(pivotId, seq);
  return seq;
}

/**
 * Check if the given sequence is still the latest operation for this pivot.
 * Returns false if a newer operation has superseded it.
 */
export function isCurrentOperation(pivotId: number, seq: number): boolean {
  return operationSeq.get(pivotId) === seq;
}

/**
 * Get the in-flight operation promise for a pivot (if any).
 * The caller should await this before starting a new IPC to avoid
 * concurrent backend operations on the same resource (e.g., BI engine Mutex).
 */
export function getInflightOperation(pivotId: number): Promise<unknown> | undefined {
  return inflightOps.get(pivotId);
}

/**
 * Register an in-flight operation promise. Automatically clears when it settles.
 */
export function setInflightOperation(pivotId: number, promise: Promise<unknown>): void {
  inflightOps.set(pivotId, promise);
  promise.finally(() => {
    // Only clear if this is still the registered promise (not replaced by a newer one)
    if (inflightOps.get(pivotId) === promise) {
      inflightOps.delete(pivotId);
    }
  });
}

// ============================================================================
// USER CANCELLATION (suppresses result caching after frontend cancel)
// ============================================================================

const userCancelledPivots = new Set<number>();

/** Mark a pivot as user-cancelled so incoming results are suppressed. */
export function markUserCancelled(pivotId: number): void {
  userCancelledPivots.add(pivotId);
}

/** Check if a pivot operation was cancelled by the user. */
export function isUserCancelled(pivotId: number): boolean {
  return userCancelledPivots.has(pivotId);
}

/** Clear the user-cancelled flag (after the operation's Promise settles). */
export function clearUserCancelled(pivotId: number): void {
  userCancelledPivots.delete(pivotId);
}

// ============================================================================
// LOADING STATE (per-pivot loading indicators)
// ============================================================================

interface PivotLoadingState {
  stage: string;
  stageIndex: number;
  totalStages: number;
  startedAt: number;
}

const loadingPivots = new Map<number, PivotLoadingState>();

/** Mark a pivot as loading with a stage description and optional step info. */
export function setLoading(
  pivotId: number,
  stage: string,
  stageIndex = 0,
  totalStages = 0,
): void {
  const existing = loadingPivots.get(pivotId);
  if (existing) {
    existing.stage = stage;
    existing.stageIndex = stageIndex;
    existing.totalStages = totalStages;
  } else {
    loadingPivots.set(pivotId, { stage, stageIndex, totalStages, startedAt: performance.now() });
  }
}

/** Clear loading state for a pivot. */
export function clearLoading(pivotId: number): void {
  loadingPivots.delete(pivotId);
}

/** Check if a pivot is currently loading. */
export function isLoading(pivotId: number): boolean {
  return loadingPivots.has(pivotId);
}

/** Get loading state details (for rendering the indicator). */
export function getLoadingState(pivotId: number): PivotLoadingState | undefined {
  return loadingPivots.get(pivotId);
}

// ============================================================================
// PREVIOUS VIEW PRESERVATION (for cancellation reversion)
// ============================================================================

const previousViews = new Map<number, PivotViewResponse>();

/** Save the current cached view before starting an operation (for cancel reversion). */
export function preserveCurrentView(pivotId: number): void {
  const current = pivotViewCache.get(pivotId);
  if (current) previousViews.set(pivotId, current);
}

/** Restore the previous view on cancel/error. Returns the restored view or undefined. */
export function restorePreviousView(pivotId: number): PivotViewResponse | undefined {
  const prev = previousViews.get(pivotId);
  if (prev) {
    pivotViewCache.set(pivotId, prev);
    previousViews.delete(pivotId);
  }
  return prev;
}

/** Clear the previous view backup after successful completion. */
export function clearPreviousView(pivotId: number): void {
  previousViews.delete(pivotId);
}

// ============================================================================
// CELL WINDOW CACHE (for windowed/large pivots)
// ============================================================================

const WINDOW_FETCH_SIZE = 200;

/** Per-pivot cell window cache for large/windowed pivot tables. */
class CellWindowCache {
  /** Row index -> PivotRowData (with cells). */
  private rows = new Map<number, PivotRowData>();
  /** Start rows of windows currently being fetched. */
  private pending = new Set<number>();
  /** Version of the PivotView these windows belong to. */
  version = 0;

  /** Get a cached row with cells, or null if not yet loaded. */
  getRow(rowIndex: number): PivotRowData | null {
    return this.rows.get(rowIndex) ?? null;
  }

  /** Check if a row's cells are cached. */
  hasRow(rowIndex: number): boolean {
    return this.rows.has(rowIndex);
  }

  /** Store a fetched window of rows. */
  setWindow(startRow: number, rows: PivotRowData[]): void {
    for (let i = 0; i < rows.length; i++) {
      this.rows.set(startRow + i, rows[i]);
    }
    this.pending.delete(startRow);
  }

  /** Clear all cached windows (on pivot recalculation). */
  invalidate(): void {
    this.rows.clear();
    this.pending.clear();
  }

  /** Check if a fetch is already in flight for this window start. */
  isPending(startRow: number): boolean {
    return this.pending.has(startRow);
  }

  /** Mark a window as being fetched. */
  markPending(startRow: number): void {
    this.pending.add(startRow);
  }

  /** Clear a pending fetch marker. */
  clearPending(startRow: number): void {
    this.pending.delete(startRow);
  }
}

const cellWindowCaches = new Map<number, CellWindowCache>();

function getOrCreateCellWindowCache(pivotId: number): CellWindowCache {
  let cache = cellWindowCaches.get(pivotId);
  if (!cache) {
    cache = new CellWindowCache();
    cellWindowCaches.set(pivotId, cache);
  }
  return cache;
}

/** Get the cell window cache for a pivot (if windowed). */
export function getCellWindowCache(pivotId: number): CellWindowCache | undefined {
  return cellWindowCaches.get(pivotId);
}

/** Fetch function type for cell window loading (avoids circular import). */
export type CellWindowFetcher = (
  pivotId: number,
  startRow: number,
  rowCount: number
) => Promise<PivotCellWindowResponse>;

/**
 * Ensure cells are loaded for the given row range. Triggers async fetch if needed.
 * Calls `onLoaded` when the window is fetched so the caller can re-render.
 * @param fetchFn - The IPC fetch function (getPivotCellWindow from pivot-api)
 */
export function ensureCellWindow(
  pivotId: number,
  version: number,
  startRow: number,
  rowCount: number,
  fetchFn: CellWindowFetcher,
  onLoaded: () => void
): void {
  const cache = getOrCreateCellWindowCache(pivotId);

  // Check if all requested rows are already cached
  let allCached = true;
  for (let i = startRow; i < startRow + rowCount; i++) {
    if (!cache.hasRow(i)) {
      allCached = false;
      break;
    }
  }
  if (allCached) return;

  // Align to window boundaries for efficient fetching
  const windowStart = Math.floor(startRow / WINDOW_FETCH_SIZE) * WINDOW_FETCH_SIZE;
  if (cache.isPending(windowStart)) return;

  cache.markPending(windowStart);
  fetchFn(pivotId, windowStart, WINDOW_FETCH_SIZE)
    .then((resp: PivotCellWindowResponse) => {
      // Discard stale responses
      if (resp.version !== version) {
        cache.clearPending(windowStart);
        return;
      }
      cache.setWindow(resp.startRow, resp.rows);
      onLoaded();
    })
    .catch((err) => {
      console.warn(`[pivot] cell window fetch failed: ${err}`);
      cache.pending.delete(windowStart);
    });
}
