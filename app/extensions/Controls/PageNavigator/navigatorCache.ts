//! FILENAME: app/extensions/Controls/PageNavigator/navigatorCache.ts
// PURPOSE: A Page Navigator's resolved settings, read from the backend
//          asynchronously and served synchronously to paint, zone and press
//          (WP-B, D-NAV).
// CONTEXT: The same pattern as the button's cache (Button/floatingRenderer.ts
//          `fetchButtonData`): the overlay paints synchronously every frame, so
//          the async `resolve_control_properties` read fills a map the paint
//          reads, and the read's arrival requests a redraw.
//
//          STALE WHILE REFETCHING. An invalidation keeps the old settings
//          visible (a navigator never blinks to its defaults while a property
//          write lands) but marks them not FRESH; the renderer -- the ONE
//          place that starts a fetch -- starts one when the settings are
//          missing or not fresh. A read that started BEFORE an invalidation is
//          dropped when it lands: it describes the old value, and the fetch
//          the invalidation provokes is the one that counts.
//
//          ONE INVALIDATION ENTRY POINT. `invalidateFloatingButtonCache(id)` and
//          `invalidateAllFloatingButtonCaches()` (Button/floatingRenderer.ts)
//          call this module's invalidators too, so every existing invalidate
//          call site in Controls/index.ts covers the navigator with no new one.
//
//          THE GEOMETRY RULE (BUG-0268). Never read under a geometry write in
//          flight, and when the resolved width/height arrive, write them back
//          into the floating store only if nothing changed the geometry while
//          the read was on its way; otherwise the settings stay not-fresh and
//          the size is read again at the next paint.

import { requestOverlayRedraw } from "@api/gridOverlays";
import { resolveControlProperties } from "../lib/controlApi";
import { beginControlGeometryRead, controlGeometryWritesInFlight } from "../lib/geometryWriteOrder";
import { applyResolvedControlSize } from "../lib/floatingStore";
import { readPageNavigatorProps, type PageNavigatorProps } from "./navigatorModel";
import { noteControlProperties } from "../lib/controlContainer";
import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";

const propsCache = new Map<string, PageNavigatorProps>();
/** Controls whose cached settings are kept visible but must be read again. */
const staleEntries = new Set<string>();
/** Controls with a read on its way. */
const pendingFetches = new Set<string>();
/** Per-control invalidation count: a read started under an older count is dropped. */
const generations = new Map<string, number>();

function generationOf(controlId: string): number {
  return generations.get(controlId) ?? 0;
}

/** The cached settings of this navigator (possibly stale), or undefined. Sync. */
export function getPageNavigatorProps(controlId: string): PageNavigatorProps | undefined {
  return propsCache.get(controlId);
}

/** True when settings are cached AND no invalidation has happened since they were read. */
export function isPageNavigatorCacheFresh(controlId: string): boolean {
  return propsCache.has(controlId) && !staleEntries.has(controlId);
}

/** True while a read for this navigator is on its way. */
export function isPageNavigatorFetchPending(controlId: string): boolean {
  return pendingFetches.has(controlId);
}

/** Mark this navigator's settings stale (they stay visible until the next read lands). */
export function invalidatePageNavigatorCache(controlId: string): void {
  // Every control's invalidation passes through here (the button cache's entry
  // point); one this cache has never read and is not reading is not ours.
  if (!propsCache.has(controlId) && !pendingFetches.has(controlId)) return;
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
  generations.set(controlId, generationOf(controlId) + 1);
}

/** Mark every navigator's settings stale. */
export function invalidateAllPageNavigatorCaches(): void {
  const ids = new Set<string>([...propsCache.keys(), ...pendingFetches]);
  for (const id of ids) {
    staleEntries.add(id);
    generations.set(id, generationOf(id) + 1);
  }
  pendingFetches.clear();
}

/** Tests: forget everything. */
export function resetPageNavigatorCache(): void {
  propsCache.clear();
  staleEntries.clear();
  pendingFetches.clear();
  generations.clear();
}

/**
 * Read this navigator's resolved properties into the cache, then request a
 * redraw. A no-op while a read for it is already on its way. Only the renderer
 * calls this (describe and zoneAt are read-only).
 */
export async function fetchPageNavigatorProps(
  controlId: string,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  if (pendingFetches.has(controlId)) return;
  pendingFetches.add(controlId);
  const startedAt = generationOf(controlId);
  try {
    const anchor = { sheetIndex, row, col };
    const writes = controlGeometryWritesInFlight(anchor);
    if (writes) await writes;
    const readIsCurrent = beginControlGeometryRead(anchor);
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    // Invalidated while the read was on its way: this answer describes the
    // old value. The invalidation cleared the pending mark, so the next paint
    // starts the read that counts.
    if (generationOf(controlId) !== startedAt) return;
    if (!resolved || Object.keys(resolved).length === 0) return;

    propsCache.set(controlId, readPageNavigatorProps(resolved));
    staleEntries.delete(controlId);
    // The same read is the navigator's visual container (WP-C D-FORMAT): its
    // padding is this `padding`, so the items and Core's band move together.
    noteControlProperties(controlId, PAGE_NAVIGATOR_CONTROL_TYPE, resolved);

    if (resolved.width || resolved.height) {
      if (applyResolvedControlSize(controlId, resolved, readIsCurrent) === "superseded") {
        staleEntries.add(controlId);
      }
    }
    requestOverlayRedraw();
  } catch (err) {
    console.error(`[Controls] Failed to fetch page navigator settings for ${controlId}:`, err);
  } finally {
    // Only the read that still owns the pending mark clears it: an
    // invalidation may already have let a newer read start.
    if (generationOf(controlId) === startedAt) pendingFetches.delete(controlId);
  }
}
