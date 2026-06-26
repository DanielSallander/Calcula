//! FILENAME: app/src/api/scriptHost/renderCache.ts
// PURPOSE: Data-only render protocols for script visuals (sandbox design §6).
//          The render loop NEVER crosses the worker boundary:
//          - Cell onRender: a host-side memoized style cache with
//            stale-while-revalidate. The per-cell interceptor body is one
//            Map lookup; misses are batched per animation frame to a
//            resolver (the worker RPC — or a direct call on the legacy path).
//          - Shape/slicer canvas renderers: cached ImageBitmaps the host
//            blits; production happens in the worker via OffscreenCanvas.
// CONTEXT: Core cells.ts / styleInterceptors.ts are untouched (Alien rule):
//          this module registers ONE ordinary style interceptor per script.

import { registerStyleInterceptor, type IStyleOverride } from "../styleInterceptors";
import { AppEvents, onAppEvent } from "../events";
import type { RenderCellRequest } from "./protocol";

// ============================================================================
// Cell style cache (SWR)
// ============================================================================

/** Resolves a batch of cells to style overrides. Null = degraded (keep base styling). */
export type CellBatchResolver = (
  cells: RenderCellRequest[],
) => Promise<(IStyleOverride | null)[] | null>;

interface CacheEntry {
  style: IStyleOverride | null;
  stale: boolean;
}

/** LRU cap per script (design §6.1). */
const MAX_ENTRIES_PER_SCRIPT = 50_000;

function cellKey(sheetIndex: number, row: number, col: number): string {
  return `${sheetIndex}:${row}:${col}`;
}

class CellRenderCache {
  /** Insertion order doubles as LRU order (Map preserves it; re-set on update). */
  private entries = new Map<string, CacheEntry>();
  private missQueue = new Map<string, RenderCellRequest>();
  private flushScheduled = false;
  private inFlight = false;
  private disposed = false;
  /** Diagnostics for the transparency panel (§13 risk 3). */
  stats = { hits: 0, misses: 0, recomputes: 0 };

  constructor(
    private readonly scriptId: string,
    private readonly resolver: CellBatchResolver,
  ) {}

  /** The style-interceptor body: one Map.get per cell per frame. */
  lookup(value: string, sheetIndex: number, row: number, col: number): IStyleOverride | null {
    const key = cellKey(sheetIndex, row, col);
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      this.stats.hits++;
      if (entry.stale) {
        // Serve the old override while re-evaluating (SWR — no flicker).
        this.queueMiss(key, { row, col, sheetIndex, value });
      }
      return entry.style;
    }
    this.stats.misses++;
    this.queueMiss(key, { row, col, sheetIndex, value });
    return null; // base style this frame; filled next frame
  }

  private queueMiss(key: string, req: RenderCellRequest): void {
    this.missQueue.set(key, req);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  /** Single-flight: one batch per script; new misses accumulate meanwhile. */
  private async flush(): Promise<void> {
    if (this.inFlight || this.disposed || this.missQueue.size === 0) {
      return;
    }
    const batch = [...this.missQueue.values()];
    this.missQueue.clear();
    this.inFlight = true;
    try {
      const styles = await this.resolver(batch);
      if (this.disposed) return;
      if (styles !== null) {
        for (let i = 0; i < batch.length; i++) {
          const req = batch[i];
          this.set(cellKey(req.sheetIndex, req.row, req.col), {
            style: styles[i] ?? null,
            stale: false,
          });
        }
        this.stats.recomputes += batch.length;
        requestRepaint();
      }
      // null = degraded (timeout/fault): cells keep base styling; entries
      // stay absent/stale and will be re-requested naturally.
    } finally {
      this.inFlight = false;
      // Anything that arrived while in flight goes out as the next batch.
      if (!this.disposed && this.missQueue.size > 0) {
        this.scheduleFlush();
      }
    }
  }

  private set(key: string, entry: CacheEntry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= MAX_ENTRIES_PER_SCRIPT) {
      // Evict oldest (first key in insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  /** SWR invalidation: keep serving, mark stale, re-batch on next paint. */
  markStale(sheetIndex: number, row: number, col: number): void {
    const entry = this.entries.get(cellKey(sheetIndex, row, col));
    if (entry) {
      entry.stale = true;
    }
  }

  /** Full clear (theme change, remount, render.invalidate escape hatch). */
  clear(): void {
    this.entries.clear();
    this.missQueue.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

const cellCaches = new Map<string, CellRenderCache>();

// Active sheet index — the fallback for a change that carries no per-change
// sheetIndex (the historical implicit contract: UI edits target the active
// sheet). Cross-sheet edits now tag each change, so they invalidate the right
// sheet's cache rather than the active one.
let activeSheetIndex = 0;
let invalidationWired = false;

function wireInvalidation(): void {
  if (invalidationWired) return;
  invalidationWired = true;
  onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
    const d = detail as { sheetIndex?: number } | undefined;
    if (d && typeof d.sheetIndex === "number") {
      activeSheetIndex = d.sheetIndex;
    }
  });
  onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
    const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number }> } | undefined;
    if (!d?.changes) return;
    for (const cache of cellCaches.values()) {
      for (const change of d.changes) {
        cache.markStale(change.sheetIndex ?? activeSheetIndex, change.row, change.col);
      }
    }
    if (d.changes.length > 0) {
      requestRepaint();
    }
  });
  onAppEvent(AppEvents.THEME_CHANGED, () => {
    for (const cache of cellCaches.values()) {
      cache.clear();
    }
    requestRepaint();
  });
}

/**
 * Register a script's cell onRender as a cached style interceptor.
 * Returns a disposer that unregisters the interceptor and drops the cache.
 */
export function registerCellRenderCache(
  scriptId: string,
  resolver: CellBatchResolver,
): () => void {
  wireInvalidation();
  const cache = new CellRenderCache(scriptId, resolver);
  cellCaches.set(scriptId, cache);

  const unregister = registerStyleInterceptor(
    `objectscript-cell-renderer-${scriptId}`,
    (cellValue, _baseStyle, coords) =>
      cache.lookup(cellValue, coords.sheetIndex ?? 0, coords.row, coords.col),
    1000, // low priority — after other interceptors, same slot as the legacy path
  );

  return () => {
    unregister();
    cache.dispose();
    cellCaches.delete(scriptId);
  };
}

/** render.invalidate() escape hatch: clear one script's entries. */
export function invalidateCellRenderCache(scriptId: string): void {
  cellCaches.get(scriptId)?.clear();
  requestRepaint();
}

/** Per-script stale/recompute counters for the transparency panel. */
export function getCellRenderStats(): Array<{ scriptId: string; hits: number; misses: number; recomputes: number }> {
  return [...cellCaches.entries()].map(([scriptId, c]) => ({ scriptId, ...c.stats }));
}

// ============================================================================
// Bitmap cache (shape canvasRenderer + slicer itemRenderer)
// ============================================================================

export type BitmapKind = "shape" | "slicerItem" | "chartMark";

interface BitmapEntry {
  bitmap: ImageBitmap;
  w: number;
  h: number;
  dpr: number;
}

const bitmapCaches: Record<BitmapKind, Map<string, BitmapEntry>> = {
  shape: new Map(),
  slicerItem: new Map(),
  chartMark: new Map(),
};

/** Per-slicer item-key index so a slicer can be invalidated wholesale. */
const slicerItemIndex = new Map<string, Set<string>>();

export function storeBitmap(kind: BitmapKind, key: string, entry: BitmapEntry): void {
  const existing = bitmapCaches[kind].get(key);
  if (existing) {
    existing.bitmap.close();
  }
  bitmapCaches[kind].set(key, entry);
  if (kind === "slicerItem") {
    const slicerId = key.split(":", 1)[0];
    let keys = slicerItemIndex.get(slicerId);
    if (!keys) {
      keys = new Set();
      slicerItemIndex.set(slicerId, keys);
    }
    keys.add(key);
  }
  requestRepaint();
  // Chart rasters are version-gated (re-rendered only on a version bump), NOT
  // re-blit every frame like shapes/slicers — so a bare repaint would re-composite
  // the SAME stale chart raster (painted before this bitmap arrived). Signal the
  // Charts extension to invalidate + re-render the affected chart so its sandbox
  // shim re-runs and hits this freshly-stored bitmap. Fires only on a real
  // chart-mark bitmap arrival (a miss resolved), so no repaint loop.
  if (kind === "chartMark" && typeof window !== "undefined") {
    window.dispatchEvent(new Event("chartMark:bitmapReady"));
  }
}

export function getBitmap(kind: BitmapKind, key: string): BitmapEntry | undefined {
  return bitmapCaches[kind].get(key);
}

/** Drop a shape's bitmap (property change, watched-cell change, resize, invalidate). */
export function invalidateBitmap(kind: BitmapKind, key: string): void {
  const entry = bitmapCaches[kind].get(key);
  if (entry) {
    entry.bitmap.close();
    bitmapCaches[kind].delete(key);
  }
}

/** Drop all of a slicer's item bitmaps (render.invalidate from its script). */
export function invalidateSlicerBitmaps(slicerId: string): void {
  const keys = slicerItemIndex.get(slicerId);
  if (!keys) return;
  for (const key of keys) {
    invalidateBitmap("slicerItem", key);
  }
  slicerItemIndex.delete(slicerId);
}

/** Drop everything (workbook close / reset). */
export function clearBitmapCaches(): void {
  for (const kind of Object.keys(bitmapCaches) as BitmapKind[]) {
    for (const entry of bitmapCaches[kind].values()) {
      entry.bitmap.close();
    }
    bitmapCaches[kind].clear();
  }
  slicerItemIndex.clear();
}

// ============================================================================
// Repaint
// ============================================================================

// Coalesce repaint requests to one per frame: GridCanvas listens for
// "grid:refresh" (GridCanvas.tsx:750) — the established extension-side
// redraw request.
let repaintScheduled = false;
function requestRepaint(): void {
  if (repaintScheduled) return;
  repaintScheduled = true;
  requestAnimationFrame(() => {
    repaintScheduled = false;
    window.dispatchEvent(new Event("grid:refresh"));
  });
}
