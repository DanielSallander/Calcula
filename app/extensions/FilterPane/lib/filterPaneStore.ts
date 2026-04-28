//! FILENAME: app/extensions/FilterPane/lib/filterPaneStore.ts
// PURPOSE: Frontend cache for ribbon filter state.

import type {
  RibbonFilter,
  CreateRibbonFilterParams,
  UpdateRibbonFilterParams,
  SlicerItem,
} from "./filterPaneTypes";
import * as api from "./filterPaneApi";
import { FilterPaneEvents } from "./filterPaneEvents";
import { applyRibbonFilter, clearRibbonFilter } from "./filterPaneFilterBridge";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedFilters: RibbonFilter[] = [];

/** Cached items per filter (filter id -> items). Refreshed on demand. */
const itemsCache = new Map<number, SlicerItem[]>();

/** Simple mutex to serialize BI engine access (take/put pattern can't handle concurrency). */
let biMutex: Promise<void> = Promise.resolve();
function withBiMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = biMutex;
  let resolve: () => void;
  biMutex = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// ============================================================================
// Accessors
// ============================================================================

export function getAllFilters(): RibbonFilter[] {
  return cachedFilters.sort((a, b) => a.order - b.order);
}

export function getFilterById(id: number): RibbonFilter | undefined {
  return cachedFilters.find((f) => f.id === id);
}

export function getCachedItems(filterId: number): SlicerItem[] | undefined {
  return itemsCache.get(filterId);
}

// ============================================================================
// CRUD operations
// ============================================================================

export async function createFilterAsync(
  params: CreateRibbonFilterParams,
): Promise<RibbonFilter | null> {
  try {
    const filter = await api.createRibbonFilter(params);
    cachedFilters = await api.getAllRibbonFilters();
    // Don't refresh items here — it takes the BI engine and conflicts
    // with pivot operations. Items are loaded lazily when the user
    // opens the dropdown for the first time.
    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_CREATED, { detail: filter }),
    );
    return filter;
  } catch (err) {
    console.error("[FilterPane] Failed to create filter:", err);
    return null;
  }
}

export async function deleteFilterAsync(filterId: number): Promise<boolean> {
  try {
    // Clear applied filter before deleting
    const filter = getFilterById(filterId);
    if (filter) {
      await clearRibbonFilter(filter);
    }
    await api.deleteRibbonFilter(filterId);
    itemsCache.delete(filterId);
    await refreshCache();
    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_DELETED, { detail: { filterId } }),
    );
    return true;
  } catch (err) {
    console.error("[FilterPane] Failed to delete filter:", err);
    return false;
  }
}

export async function updateFilterAsync(
  filterId: number,
  params: UpdateRibbonFilterParams,
): Promise<RibbonFilter | null> {
  try {
    const updated = await api.updateRibbonFilter(filterId, params);
    await refreshCache();
    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_UPDATED, { detail: updated }),
    );
    return updated;
  } catch (err) {
    console.error("[FilterPane] Failed to update filter:", err);
    return null;
  }
}

export async function updateFilterSelectionAsync(
  filterId: number,
  selectedItems: string[] | null,
): Promise<void> {
  try {
    // Optimistic local update
    const filter = cachedFilters.find((f) => f.id === filterId);
    if (filter) {
      filter.selectedItems = selectedItems;
    }

    await api.updateRibbonFilterSelection(filterId, selectedItems);

    // Apply filter to connected sources
    const updatedFilter = cachedFilters.find((f) => f.id === filterId);
    if (updatedFilter) {
      await applyRibbonFilter(updatedFilter);
    }

    // Refresh sibling filter items (cross-filtering has_data)
    await refreshSiblingFilterItems(filterId);

    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_SELECTION_CHANGED, {
        detail: { filterId, selectedItems },
      }),
    );
  } catch (err) {
    console.error("[FilterPane] Failed to update filter selection:", err);
  }
}

// ============================================================================
// Item management
// ============================================================================

export async function refreshFilterItems(filterId: number): Promise<void> {
  try {
    const filter = cachedFilters.find((f) => f.id === filterId);

    if (filter && filter.sourceType === "biConnection") {
      await refreshBiFilterItems(filter);
      return;
    }

    // Table/Pivot sources: use the standard backend command
    try {
      const items = await api.getRibbonFilterItems(filterId);
      itemsCache.set(filterId, items);
    } catch (err) {
      // If the standard API fails (e.g., BiConnection source type mismatch),
      // try the BI path as fallback
      const filter2 = cachedFilters.find((f) => f.id === filterId);
      if (filter2) {
        await refreshBiFilterItems(filter2);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("[FilterPane] Failed to refresh filter items:", err);
  }
}

/** Fetch items for a BI connection filter via the BI engine. */
async function refreshBiFilterItems(filter: RibbonFilter): Promise<void> {
  const [table, column] = parseBiFieldName(filter.fieldName);

  // Get ALL unique values for this column
  const allValues = await withBiMutex(() =>
    api.getBiColumnValues(filter.cacheSourceId, table, column),
  );

  // Collect cross-filter constraints from sibling BI filters
  // that have this filter listed in their crossFilterTargets.
  const crossFilters: api.BiCrossFilter[] = [];
  {
    for (const sibling of cachedFilters) {
      if (
        sibling.id === filter.id ||
        sibling.sourceType !== "biConnection" ||
        sibling.cacheSourceId !== filter.cacheSourceId ||
        sibling.selectedItems === null ||
        !(sibling.crossFilterTargets ?? []).includes(filter.id)
      ) {
        continue;
      }
      const [sTable, sColumn] = parseBiFieldName(sibling.fieldName);
      crossFilters.push({
        table: sTable,
        column: sColumn,
        values: sibling.selectedItems,
      });
    }
  }

  // If there are cross-filters, get the available values (subset with data)
  let availableSet: Set<string> | null = null;
  if (crossFilters.length > 0) {
    const available = await withBiMutex(() =>
      api.getBiColumnAvailableValues(
        filter.cacheSourceId,
        table,
        column,
        crossFilters,
      ),
    );
    availableSet = new Set(available);
  }

  const selectedSet = filter.selectedItems
    ? new Set(filter.selectedItems)
    : null;
  const items: SlicerItem[] = allValues.map((v) => ({
    value: v,
    selected: selectedSet === null || selectedSet.has(v),
    hasData: availableSet === null || availableSet.has(v),
  }));
  itemsCache.set(filter.id, items);
}

/** Parse "table.column" BI field name into [table, column]. */
function parseBiFieldName(fieldName: string): [string, string] {
  const dotIdx = fieldName.indexOf(".");
  if (dotIdx >= 0) {
    return [fieldName.substring(0, dotIdx), fieldName.substring(dotIdx + 1)];
  }
  return ["", fieldName];
}

/** Refresh items for sibling filters (those affected by this filter's selection).
 *  Includes: filters sharing connected sources + BI filters on the same connection. */
async function refreshSiblingFilterItems(filterId: number): Promise<void> {
  const filter = cachedFilters.find((f) => f.id === filterId);
  if (!filter) return;

  const siblingIds = new Set<number>();

  // Siblings sharing connected sources (table/pivot cross-filtering)
  const connected = filter.connectedSources ?? [];
  if (connected.length > 0) {
    const connectedIds = new Set(connected.map((c) => c.sourceId));
    for (const f of cachedFilters) {
      if (
        f.id !== filterId &&
        (f.connectedSources ?? []).some((c) => connectedIds.has(c.sourceId))
      ) {
        siblingIds.add(f.id);
      }
    }
  }

  // BI siblings: filters that this filter targets for cross-filtering
  const targets = filter.crossFilterTargets ?? [];
  for (const targetId of targets) {
    siblingIds.add(targetId);
  }

  // Also refresh any filter that targets US (reverse direction)
  for (const f of cachedFilters) {
    if (
      f.id !== filterId &&
      (f.crossFilterTargets ?? []).includes(filterId)
    ) {
      siblingIds.add(f.id);
    }
  }

  // Refresh sequentially to avoid concurrent BI engine access
  for (const id of siblingIds) {
    await refreshFilterItems(id);
  }
}

// ============================================================================
// Cache management
// ============================================================================

export async function refreshCache(): Promise<void> {
  try {
    cachedFilters = await api.getAllRibbonFilters();
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTERS_REFRESHED));
  } catch (err) {
    console.error("[FilterPane] Failed to refresh cache:", err);
  }
}

/** Refresh items for all cached filters. */
export async function refreshAllItems(): Promise<void> {
  await Promise.all(cachedFilters.map((f) => refreshFilterItems(f.id)));
}

/** Clear all cached state (used on extension deactivation). */
export function clearCache(): void {
  cachedFilters = [];
  itemsCache.clear();
}
