//! FILENAME: app/extensions/Slicer/lib/slicerStore.ts
// PURPOSE: Frontend cache for slicer state + grid region synchronization.

import type {
  Slicer,
  CreateSlicerParams,
  UpdateSlicerParams,
  SlicerItem,
  SlicerConnection,
} from "./slicerTypes";
import {
  replaceGridRegionsByType,
  removeGridRegionsByType,
  requestOverlayRedraw,
  type GridRegion,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/state";
import * as api from "./slicer-api";
import { SlicerEvents } from "./slicerEvents";
import {
  applySlicerFilter,
  connectionsToExistingPivots,
  listPivotSlicerItemsFromModel,
  reportSlicerFilterFailures,
  runSlicerSelectionGesture,
  type SlicerFilterFailure,
} from "./slicerFilterBridge";
import {
  selectionAfterClear,
  selectionAfterItemClick,
  selectionAfterItemRun,
  type SlicerSelectionChange,
} from "./slicerClickSelection";
import { emitAppEvent, AppEvents } from "@api/events";
import { runInUndoTransaction } from "@api/objectGeometry";
import { showToast } from "@api/notifications";
import { confirmPivotOverwriteOrUndo } from "@api/pivotOverwrite";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedSlicers: Slicer[] = [];

/** Cached items per slicer (slicer id -> items). Refreshed on demand. */
const itemsCache = new Map<string, SlicerItem[]>();

// ============================================================================
// Accessors
// ============================================================================

export function getAllSlicers(): Slicer[] {
  return cachedSlicers;
}

export function getSlicerById(id: string): Slicer | undefined {
  return cachedSlicers.find((s) => s.id === id);
}

export function getSlicersForSheet(sheetIndex: number): Slicer[] {
  return cachedSlicers.filter((s) => s.sheetIndex === sheetIndex);
}

export function getCachedItems(slicerId: string): SlicerItem[] | undefined {
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

/**
 * Delete one slicer. The BACKEND takes the slicer's filter off everything it
 * filtered -- a model slicer's page, a pivot slicer's connections, any pin it
 * set, a table slicer's AutoFilter column -- in the same undo step as the
 * delete (owner decision 3, 2026-09-27: deleting ANY slicer removes its
 * filter, one Ctrl+Z restores slicer and filter). So this route never clears
 * anything itself; it only refreshes the views the backend just changed.
 */
export async function deleteSlicerAsync(slicerId: string): Promise<boolean> {
  try {
    const effect = deleteEffect(cachedSlicers.find((s) => s.id === slicerId));
    await api.deleteSlicer(slicerId);
    // SLICER_DELETED is NOT dispatched here. `refreshCache` diffs the id set
    // and announces every slicer that went away, whatever removed it — see its
    // doc comment for the defect that split (§3cd).
    await refreshCache();
    announceSlicersDeleted(effect);
    return true;
  } catch (err) {
    console.error("[Slicer] Failed to delete slicer:", err);
    // The door's user is TOLD (a sheet protected against object edits refuses
    // the delete): the menu item used to do nothing, silently.
    showToast(`The slicer could not be deleted. ${describeError(err)}`.trim(), { type: "error", duration: 8000 });
    return false;
  }
}

/**
 * Delete several slicers as ONE undo step labelled `label` (the backend's
 * per-slicer delete joins the open transaction), one after another -- never
 * concurrently, so each delete's own filter clear sees the store as the
 * previous one left it. Resolves the ids that could not be deleted.
 */
export async function deleteSlicersAsync(
  slicerIds: readonly string[],
  label = "Delete Slicers",
): Promise<string[]> {
  return (await deleteSlicersReporting(slicerIds, label)).map((r) => r.slicerId);
}

/** A slicer a delete could not remove, and the backend's reason. */
export interface SlicerDeleteRefusal {
  slicerId: string;
  reason: string;
}

/**
 * {@link deleteSlicersAsync}, handing back WHY each refused delete was
 * refused. Resolves only once every delete has LANDED and the store (and the
 * regions it publishes) re-read the backend -- the contract of the canvas-wide
 * Delete (`@api/objectSelection` `deleteObjects`, wave B A4).
 */
export async function deleteSlicersReporting(
  slicerIds: readonly string[],
  label = "Delete Slicers",
): Promise<SlicerDeleteRefusal[]> {
  if (slicerIds.length === 0) return [];
  const refused: SlicerDeleteRefusal[] = [];
  const effect: SlicerDeleteEffect = { pivots: false, tableFilter: false };
  await runInUndoTransaction(label, async () => {
    for (const slicerId of slicerIds) {
      const doomed = deleteEffect(cachedSlicers.find((s) => s.id === slicerId));
      try {
        await api.deleteSlicer(slicerId);
        effect.pivots = effect.pivots || doomed.pivots;
        effect.tableFilter = effect.tableFilter || doomed.tableFilter;
      } catch (err) {
        console.error("[Slicer] Failed to delete slicer:", slicerId, err);
        refused.push({ slicerId, reason: describeError(err) });
      }
    }
  });
  await refreshCache();
  announceSlicersDeleted(effect);
  return refused;
}

/** What the backend's clear changes when a slicer is deleted. */
interface SlicerDeleteEffect {
  /** It filtered pivots: the backend re-wrote them. */
  pivots: boolean;
  /** It filtered a table: the backend cleared the table's AutoFilter column. */
  tableFilter: boolean;
}

/**
 * What deleting `slicer` changes besides the slicer store. Only a slicer WITH
 * a selection filters anything (an idle slicer's delete clears nothing, and
 * must not). A slicer can reach tables and pivots at once through Report
 * Connections, so both are read off its connections, not its source type.
 */
function deleteEffect(slicer: Slicer | undefined): SlicerDeleteEffect {
  if (!slicer || slicer.selectedItems === null) return { pivots: false, tableFilter: false };
  const kinds = new Set<string>([
    slicer.sourceType,
    ...(slicer.connectedSources ?? []).map((c) => c.sourceType),
  ]);
  return {
    pivots: kinds.has("pivot") || kinds.has("biConnection"),
    tableFilter: kinds.has("table"),
  };
}

/** What a slicer delete disturbs outside the slicer store (the cascade
 *  census follows this helper by its `announce` name). */
function announceSlicersDeleted(effect: SlicerDeleteEffect): void {
  // §3bn: ribbon filters name canvas slicers in crossFilterSlicerTargets, and
  // the backend just pruned this one out of them. The Controls pane caches
  // those filters, so without the announcement it keeps a cross-link to a
  // slicer that no longer exists and re-resolves it on every selection.
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["ribbonFilter"],
    source: "commit",
  });
  if (effect.tableFilter) {
    // The backend cleared the table's AutoFilter column: the rows it hid are
    // visible again. The AutoFilter owner re-reads its filter and pushes the
    // hidden-row set into the grid on the "objects" domain -- the domain the
    // backend reports when an undo restores that same AutoFilter, so the
    // delete and its Ctrl+Z refresh the view the same way. A redraw alone
    // (GRID_REFRESH) left the un-hidden rows off screen.
    emitAppEvent(AppEvents.MUTATION_REFRESH, {
      domains: ["objects"],
      source: "commit",
    });
  }
  if (effect.pivots) {
    // The backend re-wrote the pivots the slicer filtered: repaint them.
    window.dispatchEvent(new Event("pivot:refresh"));
  }
  if (effect.pivots || effect.tableFilter) emitAppEvent(AppEvents.GRID_REFRESH);
}

export async function updateSlicerAsync(
  slicerId: string,
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
  slicerId: string,
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

// ============================================================================
// Geometry batches (co-move, the Size fields, the canvas's arrange / nudge)
// ============================================================================

/** One slicer's new geometry. */
export interface SlicerGeometryWrite {
  slicerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write several slicers' geometry. The cache moves at once (the slicers are
 * painted where the user put them while the writes are in flight), then each
 * write is sent IN ORDER -- `update_slicer_position` records undo joining an
 * open transaction, so the caller decides the step. Resolves the refusal
 * reasons: empty when every write landed. On any refusal the cache is re-read
 * from the backend, so what the canvas paints is what the workbook holds (a
 * moved-looking slicer the backend refused is a lie).
 */
export async function writeSlicerGeometryAsync(writes: readonly SlicerGeometryWrite[]): Promise<string[]> {
  for (const w of writes) {
    const slicer = cachedSlicers.find((s) => s.id === w.slicerId);
    if (!slicer) continue;
    slicer.x = w.x;
    slicer.y = w.y;
    slicer.width = w.width;
    slicer.height = w.height;
  }
  syncSlicerRegions();
  const reasons: string[] = [];
  for (const w of writes) {
    try {
      await api.updateSlicerPosition(w.slicerId, w.x, w.y, w.width, w.height);
    } catch (err) {
      console.error(`[Slicer] The backend refused the geometry of slicer ${w.slicerId}:`, err);
      reasons.push(describeError(err));
    }
  }
  if (reasons.length > 0) await refreshCache();
  return reasons;
}

/**
 * {@link writeSlicerGeometryAsync} as ONE undo step labelled `label` (joining
 * the open frontend transaction when there is one -- a canvas group drag), and
 * a refusal told in ONE toast. Resolves true when every write landed.
 */
export async function commitSlicerGeometryAsync(
  writes: readonly SlicerGeometryWrite[],
  label: string,
): Promise<boolean> {
  if (writes.length === 0) return true;
  const reasons = await runInUndoTransaction(label, () => writeSlicerGeometryAsync(writes));
  if (reasons.length === 0) return true;
  const what = writes.length === 1 ? "The slicer" : "The slicers";
  const unique = Array.from(new Set(reasons.filter((r) => r !== "")));
  showToast(`${what} could not be moved. ${unique.join(" ")}`.trim(), { type: "error", duration: 8000 });
  return false;
}

/**
 * A slicer click: the new selection AND the filter it puts on every pivot /
 * table the slicer reaches, as ONE undo step -- ONE backend command for the
 * selection and every pivot write, which records the step once, at the end
 * (`runSlicerSelectionGesture`, BUG-0187). No undo transaction is held open
 * across a model re-query any more: an unrelated edit made during a slow
 * click is a step of its own, and a script batch begun meanwhile never joins
 * the click (BUG-0200). A plain level-1 pivot mask still records nothing --
 * the reconcile re-derives it after an undo.
 *
 * A user click (`askBeforeOverwrite`) comes through {@link queueSlicerClick},
 * never straight here, and is a step of its own -- unless a transaction that
 * already holds changes is open, which it joins ("joined": it never asks). A
 * script's call (no `askBeforeOverwrite`) joins the batch the script opened.
 *
 * OVERWRITE (a user click): a pivot the click grows over the user's cells is
 * recorded in the click's own step, with its cells. Once that step has
 * landed, the user is asked ONCE for the whole click (every pivot it filtered,
 * how many cells) -- through `@api/pivotOverwrite`, failing closed -- and a
 * decline takes back THE WHOLE CLICK, never another step: the selection comes
 * back with its pivots, and the reconcile that the take-back's refresh
 * triggers re-derives the level-1 masks the step did not carry. A click whose
 * step is not its own (nothing was recorded) never asks.
 *
 * A declined click resolves only once the store holds the RESTORED selection
 * again ({@link settleAfterTakeBack}): the next queued click computes its
 * selection from the cache, and a Ctrl+click queued behind the declined one
 * used to toggle the DECLINED selection -- re-applying the very item the user
 * had refused, and asking about the same overwrite a second time.
 */
export async function updateSlicerSelectionAsync(
  slicerId: string,
  selectedItems: string[] | null,
  options: { askBeforeOverwrite?: boolean } = {},
): Promise<void> {
  try {
    // Counted BEFORE the gesture: a take-back's announcement starts a
    // reconcile after this point, and the decline below waits for it.
    const reconcilesBefore = reconcilesStarted;
    const slicer = cachedSlicers.find((s) => s.id === slicerId);
    if (!slicer) {
      // Not in the store (yet): the selection alone, nothing to filter.
      await api.updateSlicerSelection(slicerId, selectedItems);
      return;
    }
    // LANDING until its one step is pushed: an Undo meanwhile -- Ctrl+Z, the
    // ribbon, the Edit menu -- is refused with a sentence (index.ts; the
    // backend refuses it anyway). Armed before the first await, so an Undo
    // issued right after the click already sees it.
    landingGestures += 1;
    let gesture: Awaited<ReturnType<typeof runSlicerSelectionGesture>>;
    try {
      gesture = await runSlicerSelectionGesture(
        { ...slicer, selectedItems },
        options.askBeforeOverwrite ? "user" : "script",
      );
    } finally {
      landingGestures -= 1;
    }
    const { step, overwrites } = gesture;
    // The backend holds the new selection now. The cache follows BEFORE any
    // question: a take-back's reconcile diffs against it.
    slicer.selectedItems = selectedItems;
    if (options.askBeforeOverwrite && step === "pushed") {
      const outcome = await confirmPivotOverwriteOrUndo(overwrites);
      if (outcome === "undone") {
        // Nothing about THIS selection is true any more, so nothing is
        // announced for it; the store is brought back to what came back.
        await settleAfterTakeBack(reconcilesBefore);
        requestOverlayRedraw();
        return;
      }
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

/** Slicer gestures whose backend command has not landed its step yet. */
let landingGestures = 0;

/**
 * Whether a slicer gesture's backend command is still landing its one undo
 * step (a model re-query can take seconds). The backend refuses an undo or
 * redo meanwhile (`undo_commands::history_move_refusal`); the keyboard's
 * refusal asks this so the user hears why (the review of BUG-0187).
 */
export function isSlicerGestureLanding(): boolean {
  return landingGestures > 0;
}

// ============================================================================
// User clicks: one at a time
// ============================================================================

/** The tail of the user-click queue. Never rejects. */
let clickQueue: Promise<void> = Promise.resolve();

/**
 * Run a USER click on a slicer (an item, the Clear button, Select All, the
 * context menu) after every earlier click has LANDED its undo step, and
 * compute the new selection from `change` only then -- from the committed
 * selection and items, not from what was on screen when the button went down.
 * `change` returns the new selection, or `undefined` for "nothing to do".
 *
 * Why a queue: a click's apply is a BI query on a model or pinned slicer and
 * can take seconds. A Ctrl+click toggle read the selection before the first
 * click had written it, so it dropped the first item; and two clicks whose
 * steps land in the order their queries finish would undo out of order.
 *
 * Only user clicks are queued. A script that opened a batch on purpose (to
 * set several slicers) calls {@link updateSlicerSelectionAsync} directly and
 * joins its own batch; queuing it behind a click would make the script wait
 * for the user.
 */
export function queueSlicerClick(
  slicerId: string,
  change: (slicer: Slicer, items: SlicerItem[] | undefined) => SlicerSelectionChange,
): Promise<void> {
  const run = clickQueue.then(async () => {
    // An outside change (an undo, a declined click's take-back) brings the
    // store back through a RECONCILE, whose re-read is an IPC round trip.
    // Compute from what it restores, not from the cache it is replacing --
    // and never race its mask re-derive with this click's own apply.
    await reconcilesSettled;
    const slicer = cachedSlicers.find((s) => s.id === slicerId);
    if (!slicer) return;
    const next = change(slicer, itemsCache.get(slicerId));
    if (next === undefined) return;
    await updateSlicerSelectionAsync(slicerId, next, { askBeforeOverwrite: true });
  });
  clickQueue = run.catch((err) => {
    console.error("[Slicer] A slicer click failed:", err);
  });
  return clickQueue;
}

/** A click on one item (Ctrl held or not), queued. */
export function clickSlicerItem(slicerId: string, itemValue: string, ctrlHeld: boolean): Promise<void> {
  return queueSlicerClick(slicerId, (slicer, items) =>
    selectionAfterItemClick(slicer, items, itemValue, ctrlHeld),
  );
}

/**
 * A drag across items (BUG-0258 design phase 4), queued as ONE click: one
 * commit, one undo step, computed from the committed selection when it runs.
 * `values` is the run in the order the drag swept it (the last is the item
 * under the release); `additive` is Ctrl (see `selectionAfterItemRun`).
 */
export function clickSlicerItemRun(slicerId: string, values: readonly string[], additive: boolean): Promise<void> {
  return queueSlicerClick(slicerId, (slicer, items) => selectionAfterItemRun(slicer, items, values, additive));
}

/** Clear the slicer's filter (Clear button, Select All, the context menu), queued. */
export function clickSlicerClearFilter(slicerId: string): Promise<void> {
  return queueSlicerClick(slicerId, (slicer) => selectionAfterClear(slicer));
}

/**
 * Update the cached position of a slicer without calling the backend.
 * Used for live drag preview rendering.
 */
export function updateCachedSlicerPosition(
  slicerId: string,
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
  slicerId: string,
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

/**
 * Tell whoever follows the store (SlicerEvents.SLICER_DATA_CHANGED) that what
 * it holds changed. Called AFTER the cache holds the new state.
 */
function announceDataChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
}

export async function refreshSlicerItems(slicerId: string): Promise<SlicerItem[]> {
  try {
    const items = await api.getSlicerItems(slicerId);
    itemsCache.set(slicerId, items);
    announceDataChanged();
    return items;
  } catch (err) {
    // A PIVOT slicer whose column left its BI pivot (dragged out of Rows, or
    // a Clear followed by a layout edit): list its items from the pivot's
    // MODEL. This path is a READ -- every sheet switch comes through here --
    // so it never puts the column back; the next click does, inside its own
    // undo step. (It used to re-add the column right here: a BI re-query, a
    // dirty document and a standalone undo step on a sheet-tab click.)
    // Model slicers never come here: their items are read from the model.
    const slicer = cachedSlicers.find((s) => s.id === slicerId);
    if (
      slicer &&
      slicer.sourceType === "pivot" &&
      String(err).includes("not found in pivot cache")
    ) {
      try {
        const items = await listPivotSlicerItemsFromModel(slicer);
        if (items) {
          itemsCache.set(slicerId, items);
          announceDataChanged();
          return items;
        }
      } catch (modelErr) {
        console.error("[Slicer] Could not list slicer", slicerId, "from its model:", modelErr);
      }
    }
    console.error("[Slicer] Failed to get items for slicer", slicerId, err);
    return [];
  }
}

// ============================================================================
// Cache management
// ============================================================================

/**
 * Re-read the slicer list from the backend — AND ANNOUNCE WHAT VANISHED.
 *
 * §3cd, BUG-0026. `SLICER_DELETED` used to be dispatched from exactly one
 * place: `deleteSlicerAsync`, the route the user takes when they delete a
 * slicer THEMSELVES. Every other way a slicer can disappear is a backend
 * cascade — delete the table it filters, delete its pivot, delete the sheet it
 * sits on, or have an AI client do any of those over MCP — and not one of them
 * emitted anything. The measured symptom was three actions long
 * (`table.create` -> `slicer.create` -> `table.delete`): the backend cascade
 * removed the slicer correctly, the store re-read correctly, and the contextual
 * Slicer ribbon tab stayed on screen with zero slicers in the workbook, because
 * the SELECTION still named an id that no longer resolved.
 *
 * The fix is not another announcement at the new call site — that is how the
 * first one came to have exactly one caller. THE REFRESH IS THE ANNOUNCER:
 * whatever removed the slicer, the store finds out here, so this is the one
 * place that can tell the truth about every route at once. `deleteSlicerAsync`
 * no longer dispatches the event itself.
 */
export async function refreshCache(): Promise<void> {
  try {
    const before = cachedSlicers.map((s) => s.id);
    cachedSlicers = await api.getAllSlicers();
    const surviving = new Set(cachedSlicers.map((s) => s.id));
    for (const slicerId of before) {
      if (surviving.has(slicerId)) continue;
      // The item list is keyed by slicer id and nothing else prunes it: before
      // this, a cascade-deleted slicer leaked its items for the session.
      itemsCache.delete(slicerId);
      window.dispatchEvent(
        new CustomEvent(SlicerEvents.SLICER_DELETED, { detail: { slicerId } }),
      );
    }
    syncSlicerRegions();
    announceDataChanged();
    // Also refresh items for all slicers so hit-testing works
    await Promise.all(cachedSlicers.map((s) => refreshSlicerItems(s.id)));
  } catch (err) {
    console.error("[Slicer] Failed to refresh cache:", err);
  }
}

// ============================================================================
// Reconcile after an outside change (undo / redo / pull / computed property)
// ============================================================================

/** The part of a slicer that decides what it filters: its selection, its
 *  level, and WHAT it reaches (its Report Connections). */
export type SlicerFilterState = Pick<Slicer, "id" | "selectedItems" | "filterLevel"> & {
  connectedSources?: readonly SlicerConnection[];
};

function filterSignature(s: SlicerFilterState): string {
  return JSON.stringify([s.selectedItems ?? null, s.filterLevel ?? 1]);
}

function connectionKey(c: SlicerConnection): string {
  return `${c.sourceType}:${c.sourceId}`;
}

/**
 * What an outside change did to a slicer's Report Connections: the
 * connections it had `before` and has no more (`dropped`), and the ones it
 * has now and did not have (`added`). Pure.
 */
export function connectionChanges(
  before: Pick<SlicerFilterState, "connectedSources">,
  after: Pick<SlicerFilterState, "connectedSources">,
): { dropped: SlicerConnection[]; added: SlicerConnection[] } {
  const was = before.connectedSources ?? [];
  const now = after.connectedSources ?? [];
  const wasKeys = new Set(was.map(connectionKey));
  const nowKeys = new Set(now.map(connectionKey));
  return {
    dropped: was.filter((c) => !nowKeys.has(connectionKey(c))),
    added: now.filter((c) => !wasKeys.has(connectionKey(c))),
  };
}

/**
 * The slicers whose filter must be RE-APPLIED after the store re-read the
 * backend: those present BOTH before and after, ORDINARY (level 1) on both
 * sides, whose selection changed -- or whose Report Connections changed while
 * the slicer filters something (fix round 5 review: an undone, or declined,
 * Report Connections save restored the connection list, but the level-1 mask
 * it had put on an ADDED pivot recorded nothing, so that pivot stayed
 * filtered by a slicer no longer connected to it, and a REMOVED pivot whose
 * mask the save had taken off stayed unfiltered though it was connected
 * again). Pure.
 *
 * Why level 1 only: an ordinary PIVOT filter is a host-side mask that records
 * no undo of its own, so an undone click restores the slicer and leaves the
 * pivot filtered -- it has to be re-derived here (and only the masks are: the
 * reconcile passes `masksOnly`, because a TABLE target's AutoFilter write
 * records undo in the click's own step, so the undo already restored it).
 *
 * A PINNED filter (level 2+) is part of the pivot's query: applying,
 * re-routing or dropping one re-queries the pivot, and the backend records
 * that step with the pivot's PRE-mutation definition and cache --
 * `apply_pivot_filter_core` / `clear_pivot_filter_core` snapshot them before
 * the pinned, pin-drop or calculation-group branch re-queries (pinned by
 * `undoing_a_pinned_apply_restores_the_pre_pin_definition` and
 * `undoing_a_level_change_to_pinned_restores_the_mask` in
 * app/src-tauri/src/slicer/model_slicer_tests.rs). So undoing a pinned click,
 * or a level change to or from pinned, already puts the pivot back as it was,
 * pin and mask included. Re-applying here would only re-query again: a fresh
 * undo step that wipes the redo stack. Hence a slicer that is pinned on
 * EITHER side is skipped.
 *
 * A slicer that VANISHED is deliberately absent: every route that removes a
 * slicer has already taken its filter off on the backend -- `delete_slicer`
 * in the delete's own undo step (owner decision 3), and `delete_sheet` for
 * every slicer on the deleted sheet (sheets.rs: host-side masks cleared in
 * the command, a dropped pin re-queried in the background; a sheet delete ends
 * the undo history, so there is no step to restore). A frontend clear here
 * would be a second clear, and keyed by the cached sheet index it would hit
 * the wrong page once a sheet delete has renumbered the sheets (it would wipe
 * the NEXT canvas's own filter). A slicer that APPEARED (an undone delete) is
 * absent too: the same undo step put its targets back.
 */
export function slicersWhoseFilterChanged(
  before: readonly SlicerFilterState[],
  after: readonly Slicer[],
): Slicer[] {
  const prior = new Map(before.map((s) => [s.id, s]));
  return after.filter((s) => {
    const was = prior.get(s.id);
    if (!was) return false;
    if ((was.filterLevel ?? 1) !== 1 || (s.filterLevel ?? 1) !== 1) return false;
    if (filterSignature(was) !== filterSignature(s)) return true;
    // Same selection: only the connections can have moved it, and a slicer
    // that filters nothing put nothing on any of them.
    if (s.selectedItems === null) return false;
    const { dropped, added } = connectionChanges(was, s);
    return dropped.length > 0 || added.length > 0;
  });
}

/**
 * Re-read the store after a mutation the frontend did not make itself (the
 * `slicers:refresh` fan-out: undo, redo, a pull, a computed property) and
 * re-apply the PIVOT MASKS of every ordinary slicer whose selection changed
 * (see {@link slicersWhoseFilterChanged}). An undone click restores the
 * slicer's selection on the backend, but a plain pivot filter records no undo
 * of its own -- without this the pivot kept the filter the user had just
 * undone. Table targets are never written from here (`masksOnly`): their
 * AutoFilter write was part of the undone step. Never called for the initial
 * load (the pivots' hidden items are persisted with the document). Resolves
 * the slicers it re-applied. One Ctrl+Z is one gesture: a pivot that refuses
 * a re-apply is told in ONE toast for all the slicers re-applied here.
 *
 * CONNECTIONS. A slicer whose Report Connections the outside change moved
 * (see {@link slicersWhoseFilterChanged}) has its mask taken OFF the pivots it
 * no longer reaches -- only those that still exist: a pivot disconnected
 * because it was DELETED has nothing left to clear -- and put ON the ones it
 * reaches again. Every one of these is a reconcile write (`masksOnly`, so
 * `reconcile: true`): it records nothing.
 *
 * The before-state is captured SYNCHRONOUSLY at the call (the Shell's fan-out
 * calls this inside the announcement), so a caller that changed the cache
 * just before announcing -- a declined click -- is diffed against what it
 * wrote. Every call is tracked ({@link reconcilesSettled}): a user click waits
 * for the reconciles in flight before it reads the store.
 */
export function refreshCacheAndReapplyChangedFilters(): Promise<Slicer[]> {
  const run = reconcileAfterOutsideChange();
  reconcilesStarted += 1;
  reconcilesSettled = Promise.allSettled([reconcilesSettled, run]).then(() => undefined);
  return run;
}

/** How many reconciles have started (monotonic). */
let reconcilesStarted = 0;
/** Settles once every reconcile started so far has settled. Never rejects. */
let reconcilesSettled: Promise<void> = Promise.resolve();

async function reconcileAfterOutsideChange(): Promise<Slicer[]> {
  const before: SlicerFilterState[] = cachedSlicers.map((s) => ({
    id: s.id,
    selectedItems: s.selectedItems === null ? null : [...s.selectedItems],
    filterLevel: s.filterLevel,
    connectedSources: (s.connectedSources ?? []).map((c) => ({ ...c })),
  }));
  await refreshCache();
  const changed = slicersWhoseFilterChanged(before, cachedSlicers);
  const prior = new Map(before.map((s) => [s.id, s]));
  const failures: SlicerFilterFailure[] = [];
  for (const slicer of changed) {
    const was = prior.get(slicer.id);
    if (!was) continue;
    const { dropped, added } = connectionChanges(was, slicer);
    // 1. This slicer's mask OFF the pivots it no longer reaches (it put one
    //    there only when it filtered something).
    if (was.selectedItems !== null && dropped.length > 0) {
      let stillThere: SlicerConnection[] = [];
      try {
        stillThere = await connectionsToExistingPivots(dropped);
      } catch (err) {
        failures.push({ slicer: slicer.name, target: "pivot", clearing: true, message: describeError(err) });
      }
      if (stillThere.length > 0) {
        await applySlicerFilter(
          { ...slicer, connectedSources: stillThere, selectedItems: null },
          { masksOnly: true, failures },
        );
      }
    }
    // 2. The selection ON what it reaches now: every target when the
    //    selection changed, else only the ones it reaches again.
    if (filterSignature(was) !== filterSignature(slicer)) {
      await applySlicerFilter(slicer, { masksOnly: true, failures });
    } else if (added.length > 0) {
      await applySlicerFilter({ ...slicer, connectedSources: added }, { masksOnly: true, failures });
    }
  }
  reportSlicerFilterFailures(failures);
  return changed;
}

/**
 * After a declined click was taken back: bring the store to the RESTORED
 * selection before anything reads it. The take-back announced the "slicer"
 * domain, and the Shell's fan-out started a reconcile INSIDE that
 * announcement -- capturing the declined selection as its before-state,
 * which is what makes it re-derive the masks the step did not carry -- whose
 * re-read is an IPC round trip. Wait for it; if the take-back started none
 * (it announced no slicer change), run one here.
 */
async function settleAfterTakeBack(reconcilesBefore: number): Promise<void> {
  if (reconcilesStarted > reconcilesBefore) await reconcilesSettled;
  else await refreshCacheAndReapplyChangedFilters();
}

export function resetStore(): void {
  cachedSlicers = [];
  itemsCache.clear();
  clickQueue = Promise.resolve();
  reconcilesSettled = Promise.resolve();
  removeGridRegionsByType("slicer");
  announceDataChanged();
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
      // A slicer with its header HIDDEN has only a thin border and padding to
      // grab (its items are content): Core shows its six-dot grip while it is
      // hovered or selected (@api/gridOverlays, BUG-0258 design phase 5).
      data: { slicerId: slicer.id, ...(slicer.showHeader === false ? { grip: "hover" } : {}) },
    }));

  replaceGridRegionsByType("slicer", regions);
}
