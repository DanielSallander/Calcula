//! FILENAME: app/extensions/ControlsPane/lib/filterPaneStore.ts
// PURPOSE: Frontend cache for ribbon filter state.
// CONTEXT: All filters are sourced from a Calcula model (BI) connection;
//          item values are fetched through the BI engine. The store also
//          caches connection display info so the UI can attribute each
//          filter to its model connection. A filter reaches the visuals of
//          its connection: the pivots through filterPaneFilterBridge, every
//          other model visual through filterReportPublisher, which publishes
//          what this store has SAID (its events), never an optimistic value.

import type {
  RibbonFilter,
  CreateRibbonFilterParams,
  UpdateRibbonFilterParams,
  SlicerItem,
} from "./filterPaneTypes";
import * as api from "./filterPaneApi";
import { FilterPaneEvents } from "./filterPaneEvents";
import {
  applyRibbonFilter,
  clearModelColumnOnPivots,
  clearRibbonFilter,
  reportRibbonFilterFailures,
  resolveTargetPivots,
  runRibbonFilterSelectionGesture,
  type RibbonFilterFailure,
} from "./filterPaneFilterBridge";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import { cellEvents } from "@api/cellEvents";
import { confirmPivotOverwriteOrUndo } from "@api/pivotOverwrite";
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

/** Ribbon filter changes whose backend command has not landed its step yet. */
let landingGestures = 0;

/**
 * Whether a ribbon filter change's backend command is still landing its one
 * undo step. The backend refuses an undo or redo meanwhile; the keyboard's
 * refusal asks this so the user hears why (the review of BUG-0187).
 */
export function isRibbonFilterChangeLanding(): boolean {
  return landingGestures > 0;
}

/** Cached items per filter (filter id -> items). Refreshed on demand. */
const itemsCache = new Map<string, SlicerItem[]>();

/** Why the last item load of a filter failed (filter id -> sentence). Absent
 *  after a success: the card shows this INSTEAD of an empty list, so a failed
 *  load never reads as "no values". */
const itemsErrorCache = new Map<string, string>();

/** Why the last load could not narrow the values by the filter's dependent
 *  filters (filter id -> sentence). The values are then shown un-narrowed. */
const narrowingErrorCache = new Map<string, string>();

/** How many item loads {@link refreshFilterItems} has STARTED per filter id
 *  since the document opened. A diagnostic: tests and the journey read it to
 *  prove a retry really ran. */
const loadAttempts = new Map<string, number>();

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

/** The last item-load failure of a filter, or null after a success. */
export function getFilterItemsError(filterId: string): string | null {
  return itemsErrorCache.get(filterId) ?? null;
}

/** Why the last item load shows the values un-narrowed by the filter's
 *  dependent filters, or null when the narrowing worked (or was not needed). */
export function getFilterNarrowingError(filterId: string): string | null {
  return narrowingErrorCache.get(filterId) ?? null;
}

/** How many times {@link refreshFilterItems} has started a load for this id
 *  since the document opened (cleared with {@link clearCache}). */
export function getFilterLoadAttempts(filterId: string): number {
  return loadAttempts.get(filterId) ?? 0;
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
    itemsErrorCache.delete(filterId);
    narrowingErrorCache.delete(filterId);
    loadAttempts.delete(filterId);
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
 * A ribbon filter's selection change: the selection AND the filter on every
 * target pivot, as ONE backend command that records ONE step at the end
 * (`runRibbonFilterSelectionGesture`, BUG-0187). The backend used to record
 * the selection as a step of its own (committing any open transaction), and
 * the pivots joined a frontend transaction held open across their model
 * re-queries, so an unrelated edit made meanwhile joined the change.
 *
 * OVERWRITE. A pivot the change grows over the user's cells is recorded in
 * the change's own step, with its cells. Once the step has landed, the user is
 * asked ONCE for the whole change (every pivot, how many cells) through
 * `@api/pivotOverwrite`, failing closed, and a decline takes back THE WHOLE
 * CHANGE -- the selection with its pivots, one step. The pivots the change
 * masked without overwriting recorded nothing; the take-back's announcement
 * re-reads this store, whose reconcile re-derives them from the restored
 * selection ({@link refreshCacheAndReapplyChangedFilters}), and a declined
 * change resolves only once that has landed ({@link settleAfterTakeBack}).
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
    if (!filter) {
      // Not in the store (yet): the selection alone, nothing to filter.
      await api.updateRibbonFilterSelection(filterId, selectedItems);
      return;
    }
    // Counted BEFORE the change: a take-back's announcement starts a
    // reconcile after this point, and the decline below waits for it.
    const reconcilesBefore = reconcilesStarted;
    filter.selectedItems = selectedItems;
    // LANDING until its one step is pushed: an Undo meanwhile -- Ctrl+Z, the
    // ribbon, the Edit menu -- is refused with a sentence (index.ts; the
    // backend refuses it anyway). Armed before the first await, so an Undo
    // issued right after the change already sees it.
    landingGestures += 1;
    let gesture: Awaited<ReturnType<typeof runRibbonFilterSelectionGesture>>;
    try {
      gesture = await runRibbonFilterSelectionGesture({ ...filter, selectedItems });
    } finally {
      landingGestures -= 1;
    }
    const { step, overwrites } = gesture;
    if (step === "pushed") {
      const outcome = await confirmPivotOverwriteOrUndo(overwrites);
      if (outcome === "undone") {
        // The take-back announced what it restored ("ribbonFilter"): the
        // reconcile it started re-reads this cache and re-derives the masks
        // the step did not carry. Formulas bound to the filter follow.
        await settleAfterTakeBack(reconcilesBefore);
        triggerControlValueRecalc([filter.name]);
        return;
      }
    }
    // GET.CONTROLVALUE: formulas bound to this filter's name react to the
    // new selection (multi-select spills handled backend-side).
    triggerControlValueRecalc([filter.name]);

    // Refresh sibling filter items (the dependent filters' has_data)
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
    dispatchFilterValueChanged(filter.id, filter.name, filterControlValue(selectedItems));
  } catch (err) {
    // Roll back the optimistic update: the backend never saw this selection.
    if (filter) {
      filter.selectedItems = previousSelection;
    }
    console.error("[FilterPane] Failed to update filter selection:", err);
  }
}

// ============================================================================
// Reconcile after an outside change (undo / redo / a declined change / pull)
// ============================================================================

/** The part of a ribbon filter that decides what it filters. */
export type RibbonFilterState = Pick<
  RibbonFilter,
  "id" | "selectedItems" | "filterLevel" | "connectionMode" | "connectedPivots" | "connectedSheets"
>;

function selectionKey(f: Pick<RibbonFilter, "selectedItems">): string {
  return JSON.stringify(f.selectedItems ?? null);
}

/** Whether what a filter REACHES moved (its mode, manual pivots or sheets). */
function targetsDefinitionChanged(a: RibbonFilterState, b: RibbonFilterState): boolean {
  const sorted = (v: ReadonlyArray<string | number> | undefined) => JSON.stringify([...(v ?? [])].sort());
  return (
    (a.connectionMode ?? "manual") !== (b.connectionMode ?? "manual") ||
    sorted(a.connectedPivots) !== sorted(b.connectedPivots) ||
    sorted(a.connectedSheets) !== sorted(b.connectedSheets)
  );
}

/**
 * The ribbon filters whose pivot MASKS must be re-derived after the store
 * re-read the backend (BUG-0200, "a general ribbon reconcile after a plain
 * Ctrl+Z"): present BOTH before and after, ORDINARY (level 1) on both sides,
 * whose selection changed -- or whose targets moved while it filters
 * something. An ordinary mask records no undo of its own, so an undone
 * change restored the filter's selection and left its pivots masked with the
 * undone one. A PINNED level on either side is skipped: its re-query recorded
 * the pivot's pre-state in the step the undo restored.
 *
 * A filter that APPEARED (absent before) is named too when it is ordinary and
 * carries a selection: Ctrl+Z of its DELETE brings it back with its selection,
 * but the delete had cleared its masks first (recording nothing), so its
 * pivots showed everything while its card showed the selection (the review of
 * S2). The initial load never diffs (there is no "before" yet). Pure.
 */
export function ribbonFiltersWhoseFilterChanged(
  before: readonly RibbonFilterState[],
  after: readonly RibbonFilter[],
): RibbonFilter[] {
  const prior = new Map(before.map((f) => [f.id, f]));
  return after.filter((f) => {
    const was = prior.get(f.id);
    if (!was) return f.selectedItems !== null && (f.filterLevel ?? 1) === 1;
    if ((was.filterLevel ?? 1) !== 1 || (f.filterLevel ?? 1) !== 1) return false;
    if (selectionKey(was) !== selectionKey(f)) return true;
    if (f.selectedItems === null) return false;
    return targetsDefinitionChanged(was, f);
  });
}

/** How many reconciles have started (monotonic). */
let reconcilesStarted = 0;
/** Settles once every reconcile started so far has settled. Never rejects. */
let reconcilesSettled: Promise<void> = Promise.resolve();

/**
 * Re-read the store after a mutation the frontend did not make itself (the
 * "ribbonFilter" fan-out: undo, redo, a declined change's take-back, a pull)
 * and re-derive the pivot masks of every filter
 * {@link ribbonFiltersWhoseFilterChanged} names -- recording NOTHING (every
 * write is a reconcile: `reconcile: true`, no undo step, never a column
 * added). A filter whose targets moved has its mask taken OFF the pivots it
 * no longer reaches first. Pivots that refuse are told in ONE toast. The
 * before-state is captured SYNCHRONOUSLY at the call, so a change that set
 * the cache just before announcing (a declined one) is diffed against it.
 */
export function refreshCacheAndReapplyChangedFilters(): Promise<RibbonFilter[]> {
  const run = reconcileAfterOutsideChange();
  reconcilesStarted += 1;
  reconcilesSettled = Promise.allSettled([reconcilesSettled, run]).then(() => undefined);
  return run;
}

async function reconcileAfterOutsideChange(): Promise<RibbonFilter[]> {
  const before: RibbonFilterState[] | null = cacheInitialized
    ? cachedFilters.map((f) => ({
        id: f.id,
        selectedItems: f.selectedItems === null ? null : [...f.selectedItems],
        filterLevel: f.filterLevel,
        connectionMode: f.connectionMode,
        connectedPivots: [...(f.connectedPivots ?? [])],
        connectedSheets: [...(f.connectedSheets ?? [])],
      }))
    : null;
  await refreshCache();
  if (!before) return [];
  const changed = ribbonFiltersWhoseFilterChanged(before, cachedFilters);
  const prior = new Map(before.map((f) => [f.id, f]));
  const refused: RibbonFilterFailure[] = [];
  const reconcile = { skipPivotIds: [] as string[] };
  for (const filter of changed) {
    // Absent before: a filter that came back (an undone delete) -- nothing of
    // its old reach to take off, only its selection to re-derive.
    const was = prior.get(filter.id);
    if (was && was.selectedItems !== null && targetsDefinitionChanged(was, filter)) {
      try {
        const reached = new Set(await resolveTargetPivots(filter));
        const dropped = (await resolveTargetPivots({ ...filter, ...was } as RibbonFilter)).filter(
          (pivotId) => !reached.has(pivotId),
        );
        await clearModelColumnOnPivots(filter.fieldName, dropped, {
          label: filter.name,
          failures: refused,
          reconcile: true,
        });
      } catch (err) {
        refused.push({
          filter: filter.name,
          pivotId: "",
          clearing: true,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (filter.selectedItems === null) {
      await clearRibbonFilter(filter, refused, undefined, reconcile);
    } else {
      await applyRibbonFilter(filter, refused, undefined, reconcile);
    }
  }
  reportRibbonFilterFailures(refused);
  return changed;
}

/**
 * After a declined change was taken back: bring the store to the RESTORED
 * selection -- and its masks -- before anything reads it. The take-back
 * announced the "ribbonFilter" domain and the Shell's fan-out started a
 * reconcile INSIDE that announcement; wait for it, or run one here when the
 * take-back started none.
 */
async function settleAfterTakeBack(reconcilesBefore: number): Promise<void> {
  if (reconcilesStarted > reconcilesBefore) await reconcilesSettled;
  else await refreshCacheAndReapplyChangedFilters();
}

// ============================================================================
// Item management
// ============================================================================

/** What one item load of a ribbon filter came to. */
export type FilterItemsOutcome =
  /** The values loaded. `narrowingError` set: the dependent-filter narrowing
   *  failed, so the values are shown un-narrowed (never hidden). */
  | { ok: true; narrowingError: string | null }
  /** Nothing loaded; `error` is the sentence the card shows. */
  | { ok: false; error: string };

function errorSentence(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.trim() === "" ? "The model reported an error without a message." : text;
}

/** The sentence for a field key whose table is not one of the model's. */
function namesNoTable(fieldName: string): string {
  return `"${fieldName}" names no table of this model.`;
}

/**
 * Split a "Table.Column" field key against the model's OWN table names.
 * Table names may contain dots ("BI.dim_date"), so a first-dot split sends
 * table "BI" to the engine; `splitBiFieldKey` takes the longest table that
 * prefixes the key. Its fallback (the first-dot split, for a key no table
 * prefixes) is refused here: a key whose table was renamed or removed would
 * otherwise reproduce exactly that wrong table.
 */
function splitInModel(
  fieldName: string,
  tableNames: readonly string[],
): { table: string; column: string } | null {
  const split = splitBiFieldKey(fieldName, tableNames);
  return tableNames.includes(split.table) ? split : null;
}

/**
 * Fetch the values of a ribbon filter through the BI engine, marking each
 * selected and whether it has data under the filter's dependent filters (the
 * siblings on the same connection that name this filter as a dependent).
 *
 * A failure is REPORTED, never an empty list: the items cache entry is
 * dropped, the sentence is kept for {@link getFilterItemsError}, and the
 * outcome says so. A failed narrowing keeps the values, un-narrowed, and is
 * kept for {@link getFilterNarrowingError}.
 */
export async function refreshFilterItems(filterId: string): Promise<FilterItemsOutcome> {
  const filter = cachedFilters.find((f) => f.id === filterId);
  if (!filter) {
    return failItems(filterId, "This filter is no longer in the workbook.");
  }
  loadAttempts.set(filterId, (loadAttempts.get(filterId) ?? 0) + 1);

  try {
    // The model's table names and the column's values in ONE turn of the
    // engine: the split needs the names, and both read the same engine.
    const loaded = await withBiMutex(async () => {
      const info = await api.getBiModelInfo(filter.connectionId);
      if (info === null) {
        return {
          ok: false as const,
          error: "The model of this filter's connection is not loaded.",
        };
      }
      const tableNames = info.tables.map((t) => t.name);
      const own = splitInModel(filter.fieldName, tableNames);
      if (!own) return { ok: false as const, error: namesNoTable(filter.fieldName) };
      const values = await api.getBiColumnValues(filter.connectionId, own.table, own.column);
      return { ok: true as const, tableNames, own, values };
    });
    if (!loaded.ok) return failItems(filterId, loaded.error);
    const { tableNames, own, values: allValues } = loaded;

    // The value constraints of the siblings on the SAME model connection that
    // list this filter among their dependentFilters.
    // A sibling whose table is not in the model is left out and named: the
    // values are then shown un-narrowed by it, never hidden.
    const narrowingProblems: string[] = [];
    const constraints: api.BiValueConstraint[] = [];
    for (const sibling of cachedFilters) {
      if (
        sibling.id === filter.id ||
        sibling.connectionId !== filter.connectionId ||
        sibling.selectedItems === null ||
        !(sibling.dependentFilters ?? []).includes(filter.id)
      ) {
        continue;
      }
      const theirs = splitInModel(sibling.fieldName, tableNames);
      if (!theirs) {
        narrowingProblems.push(namesNoTable(sibling.fieldName));
        continue;
      }
      constraints.push({
        table: theirs.table,
        column: theirs.column,
        values: sibling.selectedItems,
      });
    }

    // With constraints: the values that still have data (a subset).
    let availableSet: Set<string> | null = null;
    if (constraints.length > 0) {
      try {
        const available = await withBiMutex(() =>
          api.getBiColumnAvailableValues(filter.connectionId, own.table, own.column, constraints),
        );
        availableSet = new Set(available);
      } catch (err) {
        narrowingProblems.push(errorSentence(err));
      }
    }

    const selectedSet = filter.selectedItems ? new Set(filter.selectedItems) : null;
    // Selection and has-data match on the member KEY (the selection stores
    // keys; the available set is a key set); the label is only shown.
    const items: SlicerItem[] = allValues.map((m) => ({
      key: m.key,
      label: m.label,
      selected: selectedSet === null || selectedSet.has(m.key),
      hasData: availableSet === null || availableSet.has(m.key),
    }));
    itemsCache.set(filter.id, items);
    itemsErrorCache.delete(filter.id);
    const narrowingError = narrowingProblems.length > 0 ? narrowingProblems.join(" ") : null;
    if (narrowingError === null) narrowingErrorCache.delete(filter.id);
    else narrowingErrorCache.set(filter.id, narrowingError);
    return { ok: true, narrowingError };
  } catch (err) {
    return failItems(filterId, errorSentence(err));
  }
}

/** Record a failed item load: no cached items (never a stale or empty list
 *  that reads as "no values"), and the sentence kept for the card. */
function failItems(filterId: string, error: string): FilterItemsOutcome {
  console.warn(`[FilterPane] Could not load the values of filter ${filterId}: ${error}`);
  itemsCache.delete(filterId);
  itemsErrorCache.set(filterId, error);
  narrowingErrorCache.delete(filterId);
  return { ok: false, error };
}

/** Refresh items for sibling filters (those affected by this filter's
 *  selection): dependent filters in both directions. Targeted canvas
 *  slicers refresh themselves via the FILTER_SELECTION_CHANGED event.
 *  Outcomes are not returned: a failure lives in the error maps, where the
 *  card reads it. */
async function refreshSiblingFilterItems(filterId: string): Promise<void> {
  const filter = cachedFilters.find((f) => f.id === filterId);
  if (!filter) return;

  const siblingIds = new Set<string>();

  // This filter's dependent filters
  const targets = filter.dependentFilters ?? [];
  for (const targetId of targets) {
    siblingIds.add(targetId);
  }

  // Also refresh any filter that targets US (reverse direction)
  for (const f of cachedFilters) {
    if (
      f.id !== filterId &&
      (f.dependentFilters ?? []).includes(filterId)
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

/** Refresh items for all cached filters. Outcomes are not returned: a
 *  failure lives in the error maps, where each card reads it. */
export async function refreshAllItems(): Promise<void> {
  await Promise.all(cachedFilters.map((f) => refreshFilterItems(f.id)));
}

/** Clear all cached state (used on extension deactivation). */
export function clearCache(): void {
  cachedFilters = [];
  cacheInitialized = false;
  reconcilesSettled = Promise.resolve();
  itemsCache.clear();
  itemsErrorCache.clear();
  narrowingErrorCache.clear();
  loadAttempts.clear();
  connectionInfoCache = new Map();
}
