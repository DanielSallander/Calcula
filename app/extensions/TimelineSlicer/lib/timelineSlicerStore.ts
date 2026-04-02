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
} from "../../../src/api/gridOverlays";
import { getGridStateSnapshot } from "../../../src/api/state";
import * as api from "./timeline-slicer-api";
import { TimelineSlicerEvents } from "./timelineSlicerEvents";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedTimelines: TimelineSlicer[] = [];

/** Cached timeline data per timeline (id -> response). */
const dataCache = new Map<number, TimelineDataResponse>();

// ============================================================================
// Accessors
// ============================================================================

export function getAllTimelines(): TimelineSlicer[] {
  return cachedTimelines;
}

export function getTimelineById(id: number): TimelineSlicer | undefined {
  return cachedTimelines.find((t) => t.id === id);
}

export function getTimelinesForSheet(sheetIndex: number): TimelineSlicer[] {
  return cachedTimelines.filter((t) => t.sheetIndex === sheetIndex);
}

export function getCachedTimelineData(
  timelineId: number,
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
  timelineId: number,
): Promise<boolean> {
  try {
    await api.deleteTimelineSlicer(timelineId);
    dataCache.delete(timelineId);
    await refreshCache();
    window.dispatchEvent(
      new CustomEvent(TimelineSlicerEvents.TIMELINE_DELETED, {
        detail: { timelineId },
      }),
    );
    return true;
  } catch (err) {
    console.error("[TimelineSlicer] Failed to delete timeline:", err);
    return false;
  }
}

export async function updateTimelineAsync(
  timelineId: number,
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
  timelineId: number,
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

export async function updateTimelineSelectionAsync(
  timelineId: number,
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
  timelineId: number,
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
  timelineId: number,
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
  timelineId: number,
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

export async function refreshCache(): Promise<void> {
  try {
    cachedTimelines = await api.getAllTimelineSlicers();
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
