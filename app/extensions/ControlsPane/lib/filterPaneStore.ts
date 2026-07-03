//! FILENAME: app/extensions/ControlsPane/lib/filterPaneStore.ts
// PURPOSE: Frontend cache for ribbon filter state.
// CONTEXT: All filters are sourced from a Calcula model (BI) connection;
//          item values are fetched through the BI engine. The store also
//          caches connection display info so the UI can attribute each
//          filter to its model connection.

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
const itemsCache = new Map<string, SlicerItem[]>();

/** Cached BI connection info (connection id -> info) for attribution. */
let connectionInfoCache = new Map<string, api.BiConnectionInfo>();

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

export function getFilterById(id: string): RibbonFilter | undefined {
  return cachedFilters.find((f) => f.id === id);
}

export function getCachedItems(filterId: string): SlicerItem[] | undefined {
  return itemsCache.get(filterId);
}

/** Display name of a model connection, or undefined if it no longer exists. */
export function getConnectionName(connectionId: string): string | undefined {
  return connectionInfoCache.get(connectionId)?.name;
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
    await refreshConnectionInfo();
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

export async function deleteFilterAsync(filterId: string): Promise<boolean> {
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
  filterId: string,
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
  filterId: string,
  selectedItems: string[] | null,
): Promise<void> {
  try {
    // Optimistic local update
    const filter = cachedFilters.find((f) => f.id === filterId);
    if (filter) {
      filter.selectedItems = selectedItems;
    }

    await api.updateRibbonFilterSelection(filterId, selectedItems);

    // Apply or clear filter on connected sources
    const updatedFilter = cachedFilters.find((f) => f.id === filterId);
    if (updatedFilter) {
      if (selectedItems === null) {
        await clearRibbonFilter(updatedFilter);
      } else {
        await applyRibbonFilter(updatedFilter);
      }
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

/** Fetch items for a filter via the BI engine. */
export async function refreshFilterItems(filterId: string): Promise<void> {
  try {
    const filter = cachedFilters.find((f) => f.id === filterId);
    if (!filter) return;

    const [table, column] = parseBiFieldName(filter.fieldName);

    // Get ALL unique values for this column
    const allValues = await withBiMutex(() =>
      api.getBiColumnValues(filter.connectionId, table, column),
    );

    // Collect cross-filter constraints from sibling filters on the SAME
    // model connection that have this filter listed in their crossFilterTargets.
    const crossFilters: api.BiCrossFilter[] = [];
    for (const sibling of cachedFilters) {
      if (
        sibling.id === filter.id ||
        sibling.connectionId !== filter.connectionId ||
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

    // If there are cross-filters, get the available values (subset with data)
    let availableSet: Set<string> | null = null;
    if (crossFilters.length > 0) {
      const available = await withBiMutex(() =>
        api.getBiColumnAvailableValues(
          filter.connectionId,
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
  } catch (err) {
    console.error("[FilterPane] Failed to refresh filter items:", err);
  }
}

/** Parse "table.column" BI field name into [table, column]. */
function parseBiFieldName(fieldName: string): [string, string] {
  const dotIdx = fieldName.indexOf(".");
  if (dotIdx >= 0) {
    return [fieldName.substring(0, dotIdx), fieldName.substring(dotIdx + 1)];
  }
  return ["", fieldName];
}

/** Refresh items for sibling filters (those affected by this filter's
 *  selection): cross-filter targets in both directions. Targeted canvas
 *  slicers refresh themselves via the FILTER_SELECTION_CHANGED event. */
async function refreshSiblingFilterItems(filterId: string): Promise<void> {
  const filter = cachedFilters.find((f) => f.id === filterId);
  if (!filter) return;

  const siblingIds = new Set<string>();

  // Filters that this filter targets for cross-filtering
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

/** Refresh the connection-info cache used for per-filter attribution. */
export async function refreshConnectionInfo(): Promise<void> {
  try {
    const connections = await api.getBiConnections();
    connectionInfoCache = new Map(connections.map((c) => [c.id, c]));
  } catch (err) {
    console.warn("[FilterPane] Failed to refresh BI connection info:", err);
  }
}

export async function refreshCache(): Promise<void> {
  try {
    cachedFilters = await api.getAllRibbonFilters();
    await refreshConnectionInfo();
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
  connectionInfoCache = new Map();
}
