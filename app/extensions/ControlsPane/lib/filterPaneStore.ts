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
import { cellEvents } from "@api/cellEvents";
import { showToast } from "@api/notifications";
import {
  confirmPivotOverwriteOrUndo,
  createPivotOverwriteTally,
  isAnyUndoTransactionOpen,
  runNamingItsUndoStep,
} from "@api/pivotOverwrite";
import { emitAppEvent, AppEvents } from "@api/events";
import {
  CONTROL_VALUE_CHANGED,
  type ControlValue,
  type ControlValueChangedDetail,
} from "@api/controlValues";

/** A ribbon filter's value under GET.CONTROLVALUE / @api/controlValues semantics
 *  (mirrors the Rust snapshot builder): all selected -> "(All)", one -> Text,
 *  several -> TextList. Owned here (the ribbon-filter store) and re-used by
 *  controlsPaneStore's buildNamedControlList so the dependency stays one-way. */
export function filterControlValue(selectedItems: string[] | null): ControlValue {
  if (selectedItems === null) return { kind: "text", value: "(All)" };
  if (selectedItems.length === 1) {
    return { kind: "text", value: selectedItems[0] };
  }
  return { kind: "textList", value: selectedItems };
}

/** Fire-and-forget: re-evaluate GET.CONTROLVALUE formulas bound to `names`
 *  (ALL control names when omitted, e.g. after a rename) and apply the
 *  returned cells to the grid — same application pattern as other
 *  extension-triggered recalcs (cellEvents per active-sheet cell +
 *  GRID_REFRESH; see FileExplorer's virtual-file recalc handling). */
function triggerControlValueRecalc(names?: string[]): void {
  api
    .recalcControlDependents(names)
    .then((cells) => {
      if (cells.length === 0) return;
      for (const cell of cells) {
        // Non-active sheets are recalculated backend-side and refresh on
        // sheet switch; only emit for active-sheet cells.
        if (cell.sheetIndex != null) continue;
        cellEvents.emit({
          row: cell.row,
          col: cell.col,
          newValue: cell.display,
          formula: cell.formula ?? null,
        });
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
    })
    .catch((err) => {
      console.warn("[FilterPane] GET.CONTROLVALUE recalc failed:", err);
    });
}

// ============================================================================
// Module-level cache
// ============================================================================

let cachedFilters: RibbonFilter[] = [];

/** False until the first successful cache populate: the initial load (activate /
 *  file open) must NOT diff-dispatch value events — reports would re-query on
 *  every workbook open. */
let cacheInitialized = false;

/** Fire the app-wide facade event for one ribbon filter's value change.
 *  `value` undefined = the name no longer resolves (filter deleted/renamed). */
function dispatchFilterValueChanged(
  id: string,
  name: string,
  value: ControlValue | undefined,
): void {
  const detail: ControlValueChangedDetail = { id, name, value, transient: false };
  window.dispatchEvent(new CustomEvent(CONTROL_VALUE_CHANGED, { detail }));
}

/** Diff two filter snapshots and dispatch CONTROL_VALUE_CHANGED for every
 *  observable value change: selection changes arriving OUTSIDE
 *  updateFilterSelectionAsync (undo/redo, .calp pull), renames (old name stops
 *  resolving, new name starts), deletions and creations. This is what keeps
 *  @Name-bound consumers (grid reports) in sync with non-interactive changes. */
function dispatchFilterValueDiffs(previous: RibbonFilter[], next: RibbonFilter[]): void {
  const prevById = new Map(previous.map((f) => [f.id, f]));
  for (const filter of next) {
    const old = prevById.get(filter.id);
    prevById.delete(filter.id);
    if (!old) {
      // Created (e.g. redo of a create): @Name references start resolving.
      dispatchFilterValueChanged(filter.id, filter.name, filterControlValue(filter.selectedItems));
      continue;
    }
    if (old.name !== filter.name) {
      // Renamed: the old name stops resolving, the new one starts.
      dispatchFilterValueChanged(filter.id, old.name, undefined);
      dispatchFilterValueChanged(filter.id, filter.name, filterControlValue(filter.selectedItems));
    } else if (JSON.stringify(old.selectedItems) !== JSON.stringify(filter.selectedItems)) {
      dispatchFilterValueChanged(filter.id, filter.name, filterControlValue(filter.selectedItems));
    }
  }
  for (const gone of prevById.values()) {
    dispatchFilterValueChanged(gone.id, gone.name, undefined);
  }
}

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
    // GET.CONTROLVALUE: formulas already bound to the new filter's name pick
    // up its value ("(All)" while nothing is selected) instead of staying #N/A.
    triggerControlValueRecalc([filter.name]);
    // The cache was set directly (no refreshCache diff): notify @Name-bound
    // consumers that this name now resolves.
    dispatchFilterValueChanged(filter.id, filter.name, filterControlValue(filter.selectedItems));
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
    // Clear applied filter before deleting; capture the name BEFORE the
    // cache refresh drops the filter (needed for the recalc below).
    const filter = getFilterById(filterId);
    const deletedName = filter?.name;
    if (filter) {
      await clearRibbonFilter(filter);
    }
    await api.deleteRibbonFilter(filterId);
    itemsCache.delete(filterId);
    await refreshCache();
    // GET.CONTROLVALUE: formulas bound to the deleted filter's name go #N/A.
    // Fall back to a full control recalc if the filter wasn't in the cache.
    triggerControlValueRecalc(
      deletedName !== undefined ? [deletedName] : undefined,
    );
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
    // Rename breaks GET.CONTROLVALUE bindings by name (Excel-like): formulas
    // bound to the old name go #N/A, ones bound to the new name pick up the
    // value — full control recalc, no name hint (plan: rename => full recalc).
    if (params.name !== undefined) {
      triggerControlValueRecalc();
    }
    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_UPDATED, { detail: updated }),
    );
    return updated;
  } catch (err) {
    console.error("[FilterPane] Failed to update filter:", err);
    return null;
  }
}

/**
 * A ribbon filter's selection change: the selection write, then the filter on
 * every target pivot (ONE "Ribbon filter change" step for the pivots).
 *
 * OVERWRITE. A pivot the change grows over the user's cells records a step
 * holding them. Once the pivot step has committed, the user is asked ONCE for
 * the whole change (every pivot, how many cells) through `@api/pivotOverwrite`,
 * failing closed. A decline takes back the pivot step AND the selection step
 * beneath it -- the backend records the selection as a step of its own, before
 * the pivots' -- but that one only when it is PROVABLY this change's (exactly
 * one entry appeared for the write; `runNamingItsUndoStep`), never a guess. A
 * change that runs inside someone else's open transaction -- the frontend's,
 * or a script batch's opened on the backend directly -- never asks. After a
 * decline, the pivots the change masked without overwriting (they recorded
 * nothing, so the take-back could not restore them) are re-derived from the
 * restored selection ({@link rederiveAfterDecline}).
 */
export async function updateFilterSelectionAsync(
  filterId: string,
  selectedItems: string[] | null,
): Promise<void> {
  // Optimistic local update — rolled back if the backend rejects, so the cache
  // (which feeds getControlValue/@Name substitution) never holds a selection
  // that was never persisted.
  const filter = cachedFilters.find((f) => f.id === filterId);
  const previousSelection = filter ? filter.selectedItems : null;
  try {
    if (filter) {
      filter.selectedItems = selectedItems;
    }

    const joined = await isAnyUndoTransactionOpen();
    const { seq: selectionStep } = await runNamingItsUndoStep(() =>
      api.updateRibbonFilterSelection(filterId, selectedItems),
    );

    // Apply or clear filter on connected sources
    const updatedFilter = cachedFilters.find((f) => f.id === filterId);
    if (updatedFilter) {
      const overwrites = createPivotOverwriteTally();
      if (selectedItems === null) {
        await clearRibbonFilter(updatedFilter, undefined, overwrites);
      } else {
        await applyRibbonFilter(updatedFilter, undefined, overwrites);
      }
      if (!joined) {
        const outcome = await confirmPivotOverwriteOrUndo(overwrites, { thenUndoSeq: selectionStep });
        if (outcome === "undone") {
          // The take-back announced what it restored: the "ribbonFilter"
          // domain re-reads this cache (and tells @Name consumers). Formulas
          // bound to the filter follow the restored selection.
          await rederiveAfterDecline(filterId, selectedItems, overwrites.pivotIds);
          triggerControlValueRecalc([updatedFilter.name]);
          return;
        }
      }
      // GET.CONTROLVALUE: formulas bound to this filter's name react to the
      // new selection (multi-select spills handled backend-side).
      triggerControlValueRecalc([updatedFilter.name]);
    }

    // Refresh sibling filter items (cross-filtering has_data)
    await refreshSiblingFilterItems(filterId);

    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_SELECTION_CHANGED, {
        detail: { filterId, selectedItems },
      }),
    );

    // Complete the @api/controlValues facade for the ribbon-filter family: any
    // consumer observing onControlValueChange (e.g. a grid report bound to this
    // filter via @Name) reacts to the new selection, exactly as it would for a
    // pane control. Non-transient — a ribbon selection is a committed change,
    // never a mid-drag preview frame.
    if (updatedFilter) {
      dispatchFilterValueChanged(
        updatedFilter.id,
        updatedFilter.name,
        filterControlValue(selectedItems),
      );
    }
  } catch (err) {
    // Roll back the optimistic update: the backend never saw this selection.
    if (filter) {
      filter.selectedItems = previousSelection;
    }
    console.error("[FilterPane] Failed to update filter selection:", err);
  }
}

/** Told when the pivots a declined change left on its selection could not be
 *  put back (the filter could not be re-read). */
export const RIBBON_DECLINE_NOT_REDERIVED =
  "Some PivotTables may still show the filter you declined. Select the filter's items again to update them.";

/**
 * After a DECLINED selection change was taken back (fix round 5 review): the
 * take-back restored every pivot whose step it holds -- the ones that grew
 * over the user's cells -- but a pivot the change masked WITHOUT overwriting
 * recorded nothing (a level-1 mask records no step), so it still showed the
 * declined selection while the card showed the restored one. Re-derive
 * exactly those from the selection the take-back RESTORED, read back from
 * the backend (the cache still holds the declined one until the take-back's
 * own re-read lands), recording nothing: `RibbonFilterReconcile` sends
 * `reconcile: true`, opens no step, and skips `restoredPivotIds`.
 *
 * Nothing is re-derived when the selection did not come back (its step was
 * not provably this change's, so the backend still holds the declined
 * selection and the untouched pivots agree with it), or at a PINNED level
 * (every pivot's re-query recorded its pre-state in the step that came back).
 */
async function rederiveAfterDecline(
  filterId: string,
  declined: string[] | null,
  restoredPivotIds: readonly string[],
): Promise<void> {
  let restored: RibbonFilter | undefined;
  try {
    restored = (await api.getAllRibbonFilters()).find((f) => f.id === filterId);
  } catch (err) {
    console.warn("[FilterPane] Could not re-read the filter after a declined change:", err);
    showToast(RIBBON_DECLINE_NOT_REDERIVED, { type: "error", duration: 8000 });
    return;
  }
  if (!restored) return;
  if (JSON.stringify(restored.selectedItems) === JSON.stringify(declined)) return;
  if ((restored.filterLevel ?? 1) !== 1) return;
  const reconcile = { skipPivotIds: restoredPivotIds };
  if (restored.selectedItems === null) {
    await clearRibbonFilter(restored, undefined, undefined, reconcile);
  } else {
    await applyRibbonFilter(restored, undefined, undefined, reconcile);
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
    const previous = cacheInitialized ? cachedFilters : null;
    cachedFilters = await api.getAllRibbonFilters();
    cacheInitialized = true;
    await refreshConnectionInfo();
    // Backend-side changes (undo/redo restores, .calp pulls) reach the cache
    // only through here — diff so @Name-bound consumers hear about them.
    if (previous) {
      dispatchFilterValueDiffs(previous, cachedFilters);
    }
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
  cacheInitialized = false;
  itemsCache.clear();
  connectionInfoCache = new Map();
}
