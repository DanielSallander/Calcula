//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerStore.ts
// PURPOSE: Frontend cache for timeline slicer state + grid region sync.

import type {
  TimelineSlicer,
  CreateTimelineParams,
  UpdateTimelineParams,
  TimelineDataResponse,
} from "./timelineSlicerTypes";
import {
  replaceGridRegionsByType,
  removeGridRegionsByType,
  requestOverlayRedraw,
  type GridRegion,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/state";
import * as api from "./timeline-slicer-api";
import { TimelineSlicerEvents } from "./timelineSlicerEvents";
import { runInUndoTransaction } from "@api/objectGeometry";
import { showToast } from "@api/notifications";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedTimelines: TimelineSlicer[] = [];

/** Cached timeline data per timeline (id -> response). */
const dataCache = new Map<string, TimelineDataResponse>();

// ============================================================================
// Accessors
// ============================================================================

export function getAllTimelines(): TimelineSlicer[] {
  return cachedTimelines;
}

export function getTimelineById(id: string): TimelineSlicer | undefined {
  return cachedTimelines.find((t) => t.id === id);
}

export function getTimelinesForSheet(sheetIndex: number): TimelineSlicer[] {
  return cachedTimelines.filter((t) => t.sheetIndex === sheetIndex);
}

export function getCachedTimelineData(
  timelineId: string,
): TimelineDataResponse | undefined {
  return dataCache.get(timelineId);
}

// ============================================================================
// CRUD operations
// ============================================================================

export async function createTimelineAsync(
  params: CreateTimelineParams,
): Promise<TimelineSlicer | null> {
  try {
    const timeline = await api.createTimelineSlicer(params);
    cachedTimelines = await api.getAllTimelineSlicers();
    await refreshTimelineData(timeline.id);
    syncTimelineRegions();
    requestOverlayRedraw();
    window.dispatchEvent(
      new CustomEvent(TimelineSlicerEvents.TIMELINE_CREATED, {
        detail: timeline,
      }),
    );
    return timeline;
  } catch (err) {
    console.error("[TimelineSlicer] Failed to create timeline:", err);
    return null;
  }
}

export async function deleteTimelineAsync(
  timelineId: string,
): Promise<boolean> {
  try {
    await api.deleteTimelineSlicer(timelineId);
    // TIMELINE_DELETED is NOT dispatched here. `refreshCache` diffs the id set
    // and announces every timeline that went away, whatever removed it
    // (§3cd) -- see its doc comment.
    await refreshCache();
    return true;
  } catch (err) {
    console.error("[TimelineSlicer] Failed to delete timeline:", err);
    return false;
  }
}

export async function updateTimelineAsync(
  timelineId: string,
  params: UpdateTimelineParams,
): Promise<TimelineSlicer | null> {
  try {
    const updated = await api.updateTimelineSlicer(timelineId, params);
    await refreshCache();
    // If level changed, refresh data
    if (params.level != null) {
      await refreshTimelineData(timelineId);
    }
    window.dispatchEvent(
      new CustomEvent(TimelineSlicerEvents.TIMELINE_UPDATED, {
        detail: updated,
      }),
    );
    return updated;
  } catch (err) {
    console.error("[TimelineSlicer] Failed to update timeline:", err);
    return null;
  }
}

export async function updateTimelinePositionAsync(
  timelineId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  try {
    await api.updateTimelinePosition(timelineId, x, y, width, height);
    const tl = cachedTimelines.find((t) => t.id === timelineId);
    if (tl) {
      tl.x = x;
      tl.y = y;
      tl.width = width;
      tl.height = height;
      syncTimelineRegions();
    }
  } catch (err) {
    console.error("[TimelineSlicer] Failed to update position:", err);
  }
}

// ============================================================================
// Geometry batches (co-move, the canvas's arrange / nudge)
// ============================================================================

/** One timeline's new geometry. */
export interface TimelineGeometryWrite {
  timelineId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write several timelines' geometry. The cache moves at once, then each write
 * is sent IN ORDER -- `update_timeline_position` records undo joining an open
 * transaction, so the caller decides the step. Resolves the refusal reasons:
 * empty when every write landed. On any refusal the cache is re-read from the
 * backend, so what the canvas paints is what the workbook holds.
 */
export async function writeTimelineGeometryAsync(writes: readonly TimelineGeometryWrite[]): Promise<string[]> {
  for (const w of writes) {
    const tl = cachedTimelines.find((t) => t.id === w.timelineId);
    if (!tl) continue;
    tl.x = w.x;
    tl.y = w.y;
    tl.width = w.width;
    tl.height = w.height;
  }
  syncTimelineRegions();
  const reasons: string[] = [];
  for (const w of writes) {
    try {
      await api.updateTimelinePosition(w.timelineId, w.x, w.y, w.width, w.height);
    } catch (err) {
      console.error(`[TimelineSlicer] The backend refused the geometry of timeline ${w.timelineId}:`, err);
      reasons.push(describeError(err));
    }
  }
  if (reasons.length > 0) await refreshCache();
  return reasons;
}

/**
 * {@link writeTimelineGeometryAsync} as ONE undo step labelled `label`
 * (joining the open frontend transaction when there is one -- a canvas group
 * drag), and a refusal told in ONE toast. Resolves true when every write
 * landed.
 */
export async function commitTimelineGeometryAsync(
  writes: readonly TimelineGeometryWrite[],
  label: string,
): Promise<boolean> {
  if (writes.length === 0) return true;
  const reasons = await runInUndoTransaction(label, () => writeTimelineGeometryAsync(writes));
  if (reasons.length === 0) return true;
  const what = writes.length === 1 ? "The timeline" : "The timelines";
  const unique = Array.from(new Set(reasons.filter((r) => r !== "")));
  showToast(`${what} could not be moved. ${unique.join(" ")}`.trim(), { type: "error", duration: 8000 });
  return false;
}

export async function updateTimelineSelectionAsync(
  timelineId: string,
  selectionStart: string | null,
  selectionEnd: string | null,
): Promise<void> {
  try {
    await api.updateTimelineSelection({
      timelineId,
      selectionStart,
      selectionEnd,
    });
    // Update local cache
    const tl = cachedTimelines.find((t) => t.id === timelineId);
    if (tl) {
      tl.selectionStart = selectionStart;
      tl.selectionEnd = selectionEnd;
    }
    // Refresh data to update isSelected flags
    await refreshTimelineData(timelineId);
    requestOverlayRedraw();
    window.dispatchEvent(
      new CustomEvent(TimelineSlicerEvents.TIMELINE_SELECTION_CHANGED, {
        detail: { timelineId, selectionStart, selectionEnd },
      }),
    );
  } catch (err) {
    console.error("[TimelineSlicer] Failed to update selection:", err);
  }
}

/**
 * Update the cached position of a timeline without calling the backend.
 * Used for live drag preview rendering.
 */
export function updateCachedTimelinePosition(
  timelineId: string,
  x: number,
  y: number,
): void {
  const tl = cachedTimelines.find((t) => t.id === timelineId);
  if (tl) {
    tl.x = x;
    tl.y = y;
    syncTimelineRegions();
  }
}

/**
 * Update the cached bounds of a timeline without calling the backend.
 * Used for live resize preview rendering.
 */
export function updateCachedTimelineBounds(
  timelineId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const tl = cachedTimelines.find((t) => t.id === timelineId);
  if (tl) {
    tl.x = x;
    tl.y = y;
    tl.width = width;
    tl.height = height;
    syncTimelineRegions();
  }
}

// ============================================================================
// Data fetching
// ============================================================================

export async function refreshTimelineData(
  timelineId: string,
): Promise<TimelineDataResponse | null> {
  try {
    const data = await api.getTimelineData(timelineId);
    dataCache.set(timelineId, data);
    return data;
  } catch (err) {
    console.error(
      "[TimelineSlicer] Failed to get data for timeline",
      timelineId,
      err,
    );
    return null;
  }
}

// ============================================================================
// Cache management
// ============================================================================

/**
 * Re-read the timeline list from the backend — AND ANNOUNCE WHAT VANISHED.
 *
 * §3cd, the timeline half of BUG-0026 and the identical defect. A timeline can
 * only be sourced from a pivot, so `DEPENDENCY_MATRIX` deletes it whenever its
 * last pivot goes (`pivot -> timelineSlicer.sourceId`, CascadeOrRebind) and
 * again when its sheet is deleted — and `TIMELINE_DELETED` was dispatched from
 * exactly one place, the frontend `deleteTimelineAsync`. Every cascade route
 * therefore left the contextual Timeline Options tab addressing an id that no
 * longer resolved.
 *
 * The refresh is the announcer, for the same reason as the canvas slicer's:
 * whatever removed the timeline, the store finds out here.
 */
export async function refreshCache(): Promise<void> {
  try {
    const before = cachedTimelines.map((t) => t.id);
    cachedTimelines = await api.getAllTimelineSlicers();
    const surviving = new Set(cachedTimelines.map((t) => t.id));
    for (const timelineId of before) {
      if (surviving.has(timelineId)) continue;
      // Nothing else prunes the per-timeline data cache; a cascade-deleted
      // timeline leaked its cached response for the session.
      dataCache.delete(timelineId);
      window.dispatchEvent(
        new CustomEvent(TimelineSlicerEvents.TIMELINE_DELETED, {
          detail: { timelineId },
        }),
      );
    }
    syncTimelineRegions();
    await Promise.all(cachedTimelines.map((t) => refreshTimelineData(t.id)));
  } catch (err) {
    console.error("[TimelineSlicer] Failed to refresh cache:", err);
  }
}

export function resetStore(): void {
  cachedTimelines = [];
  dataCache.clear();
  removeGridRegionsByType("timeline-slicer");
}

// ============================================================================
// Grid region synchronization
// ============================================================================

export function syncTimelineRegions(): void {
  const gridState = getGridStateSnapshot();
  const activeSheet = gridState?.sheetContext.activeSheetIndex ?? 0;

  const regions: GridRegion[] = cachedTimelines
    .filter((tl) => tl.sheetIndex === activeSheet)
    .map((tl) => ({
      id: `timeline-slicer-${tl.id}`,
      type: "timeline-slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: {
        x: tl.x,
        y: tl.y,
        width: tl.width,
        height: tl.height,
      },
      data: { timelineId: tl.id },
    }));

  replaceGridRegionsByType("timeline-slicer", regions);
}
