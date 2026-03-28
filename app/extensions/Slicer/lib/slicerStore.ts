//! FILENAME: app/extensions/Slicer/lib/slicerStore.ts
// PURPOSE: Frontend cache for slicer state + grid region synchronization.

import type { Slicer, CreateSlicerParams, UpdateSlicerParams, SlicerItem } from "./slicerTypes";
import {
  replaceGridRegionsByType,
  removeGridRegionsByType,
  requestOverlayRedraw,
  type GridRegion,
} from "../../../src/api/gridOverlays";
import { getGridStateSnapshot } from "../../../src/api/state";
import * as api from "./slicer-api";
import { SlicerEvents } from "./slicerEvents";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedSlicers: Slicer[] = [];

/** Cached items per slicer (slicer id -> items). Refreshed on demand. */
const itemsCache = new Map<number, SlicerItem[]>();

// ============================================================================
// Accessors
// ============================================================================

export function getAllSlicers(): Slicer[] {
  return cachedSlicers;
}

export function getSlicerById(id: number): Slicer | undefined {
  return cachedSlicers.find((s) => s.id === id);
}

export function getSlicersForSheet(sheetIndex: number): Slicer[] {
  return cachedSlicers.filter((s) => s.sheetIndex === sheetIndex);
}

export function getCachedItems(slicerId: number): SlicerItem[] | undefined {
  return itemsCache.get(slicerId);
}

// ============================================================================
// CRUD operations
// ============================================================================

export async function createSlicerAsync(
  params: CreateSlicerParams,
): Promise<Slicer | null> {
  try {
    const slicer = await api.createSlicer(params);
    // Fetch items BEFORE syncing regions so the first paint shows items
    cachedSlicers = await api.getAllSlicers();
    await refreshSlicerItems(slicer.id);
    syncSlicerRegions();
    requestOverlayRedraw();
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_CREATED, { detail: slicer }));
    return slicer;
  } catch (err) {
    console.error("[Slicer] Failed to create slicer:", err);
    return null;
  }
}

export async function deleteSlicerAsync(slicerId: number): Promise<boolean> {
  try {
    await api.deleteSlicer(slicerId);
    itemsCache.delete(slicerId);
    await refreshCache();
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_DELETED, { detail: { slicerId } }));
    return true;
  } catch (err) {
    console.error("[Slicer] Failed to delete slicer:", err);
    return false;
  }
}

export async function updateSlicerAsync(
  slicerId: number,
  params: UpdateSlicerParams,
): Promise<Slicer | null> {
  try {
    const updated = await api.updateSlicer(slicerId, params);
    await refreshCache();
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_UPDATED, { detail: updated }));
    return updated;
  } catch (err) {
    console.error("[Slicer] Failed to update slicer:", err);
    return null;
  }
}

export async function updateSlicerPositionAsync(
  slicerId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  try {
    await api.updateSlicerPosition(slicerId, x, y, width, height);
    // Update local cache immediately for smooth rendering
    const slicer = cachedSlicers.find((s) => s.id === slicerId);
    if (slicer) {
      slicer.x = x;
      slicer.y = y;
      slicer.width = width;
      slicer.height = height;
      syncSlicerRegions();
    }
  } catch (err) {
    console.error("[Slicer] Failed to update position:", err);
  }
}

export async function updateSlicerSelectionAsync(
  slicerId: number,
  selectedItems: string[] | null,
): Promise<void> {
  try {
    await api.updateSlicerSelection(slicerId, selectedItems);
    // Update local cache
    const slicer = cachedSlicers.find((s) => s.id === slicerId);
    if (slicer) {
      slicer.selectedItems = selectedItems;
    }
    // Refresh items to update selection state
    await refreshSlicerItems(slicerId);
    requestOverlayRedraw();
    window.dispatchEvent(
      new CustomEvent(SlicerEvents.SLICER_SELECTION_CHANGED, {
        detail: { slicerId, selectedItems },
      }),
    );
  } catch (err) {
    console.error("[Slicer] Failed to update selection:", err);
  }
}

/**
 * Update the cached position of a slicer without calling the backend.
 * Used for live drag preview rendering.
 */
export function updateCachedSlicerPosition(
  slicerId: number,
  x: number,
  y: number,
): void {
  const slicer = cachedSlicers.find((s) => s.id === slicerId);
  if (slicer) {
    slicer.x = x;
    slicer.y = y;
    syncSlicerRegions();
  }
}

/**
 * Update the cached bounds of a slicer without calling the backend.
 * Used for live resize preview rendering.
 */
export function updateCachedSlicerBounds(
  slicerId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const slicer = cachedSlicers.find((s) => s.id === slicerId);
  if (slicer) {
    slicer.x = x;
    slicer.y = y;
    slicer.width = width;
    slicer.height = height;
    syncSlicerRegions();
  }
}

// ============================================================================
// Item fetching
// ============================================================================

export async function refreshSlicerItems(slicerId: number): Promise<SlicerItem[]> {
  try {
    const items = await api.getSlicerItems(slicerId);
    itemsCache.set(slicerId, items);
    return items;
  } catch (err) {
    console.error("[Slicer] Failed to get items for slicer", slicerId, err);
    return [];
  }
}

// ============================================================================
// Cache management
// ============================================================================

export async function refreshCache(): Promise<void> {
  try {
    cachedSlicers = await api.getAllSlicers();
    syncSlicerRegions();
    // Also refresh items for all slicers so hit-testing works
    await Promise.all(cachedSlicers.map((s) => refreshSlicerItems(s.id)));
  } catch (err) {
    console.error("[Slicer] Failed to refresh cache:", err);
  }
}

export function resetStore(): void {
  cachedSlicers = [];
  itemsCache.clear();
  removeGridRegionsByType("slicer");
}

// ============================================================================
// Grid region synchronization
// ============================================================================

export function syncSlicerRegions(): void {
  // Only register regions for slicers on the active sheet
  const gridState = getGridStateSnapshot();
  const activeSheet = gridState?.sheetContext.activeSheetIndex ?? 0;

  const regions: GridRegion[] = cachedSlicers
    .filter((slicer) => slicer.sheetIndex === activeSheet)
    .map((slicer) => ({
      id: `slicer-${slicer.id}`,
      type: "slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: {
        x: slicer.x,
        y: slicer.y,
        width: slicer.width,
        height: slicer.height,
      },
      data: { slicerId: slicer.id },
    }));

  replaceGridRegionsByType("slicer", regions);
}
