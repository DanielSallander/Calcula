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
import {
  isUndoTransactionOpen,
  joinUndoTransaction,
  runInUndoTransaction,
  undoCommitsSettled,
} from "@api/objectGeometry";
import { beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction } from "@api/lib";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { showToast } from "@api/notifications";
import {
  confirmPivotOverwriteOrUndo,
  createPivotOverwriteTally,
  type PivotOverwriteTally,
} from "@api/pivotOverwrite";
import { applyTimelineFilter } from "./timelineSlicerFilterBridge";

// ============================================================================
// Module-level cache
// ============================================================================

let cachedTimelines: TimelineSlicer[] = [];

/** Cached timeline data per timeline (id -> response). */
const dataCache = new Map<string, TimelineDataResponse>();

/** A timeline's selected range. */
interface SelectionRange {
  start: string | null;
  end: string | null;
}

/**
 * The range each timeline's pivot masks were last derived from, by timeline
 * id: what its pivots SHOW. Seeded from the backend the first time a timeline
 * is read (its pivots were saved with its filter), moved by every apply, and
 * compared by {@link refreshCacheAndReconcile} to find the timelines an undo
 * moved.
 */
const appliedRanges = new Map<string, SelectionRange>();

function rangeOf(tl: TimelineSlicer | undefined): SelectionRange {
  return { start: tl?.selectionStart ?? null, end: tl?.selectionEnd ?? null };
}

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
    // The door's user is TOLD (a sheet protected against object edits refuses
    // the delete since W1): the menu item used to do nothing, silently.
    const reason = err instanceof Error ? err.message : String(err);
    showToast(`The timeline could not be deleted. ${reason}`.trim(), { type: "error", duration: 8000 });
    return false;
  }
}

/** A timeline a delete could not remove, and the backend's reason. */
export interface TimelineDeleteRefusal {
  timelineId: string;
  reason: string;
}

/**
 * Delete several timelines one after another, handing back WHY each refused
 * one was refused. Resolves only once every delete has LANDED and the store
 * (and the regions it publishes) re-read the backend -- the contract of the
 * canvas-wide Delete (`@api/objectSelection` `deleteObjects`, wave B A4).
 */
export async function deleteTimelinesReporting(
  timelineIds: readonly string[],
): Promise<TimelineDeleteRefusal[]> {
  const refused: TimelineDeleteRefusal[] = [];
  for (const timelineId of timelineIds) {
    try {
      await api.deleteTimelineSlicer(timelineId);
    } catch (err) {
      console.error("[TimelineSlicer] Failed to delete timeline:", timelineId, err);
      refused.push({ timelineId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  await refreshCache();
  return refused;
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

/** Why a declined timeline selection is still selected (a toast). */
export const TIMELINE_SELECTION_NOT_TAKEN_BACK =
  "The timeline's selection could not be taken back with its filter: something else changed the workbook in between. Use Undo (Ctrl+Z) to step back to it.";

/**
 * The closes a timeline selection's step makes, bound to its begin's answer by
 * `ownUndoTransaction` (and read when the close runs, so the commit is always
 * the current backend door).
 */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * A timeline selection's OWN undo step while it is open: the step one
 * selection's begin asked for, which every later selection JOINS until it
 * closes (the review of Z3).
 */
interface TimelineSelectionStep {
  /** Settles once the step's begin has landed (never rejects). */
  ready: Promise<void>;
  /** Selections that joined the step: its commit waits for every one. */
  pending: Set<Promise<unknown>>;
  /** What every selection in the step overwrote: its opener asks about all of it. */
  overwrites: PivotOverwriteTally;
  /** Its joined work has settled and its commit is under way: nothing joins now. */
  closing: boolean;
}

/** The timeline selection step open right now, if any. */
let openSelectionStep: TimelineSelectionStep | null = null;

/**
 * The last timeline selection step being COMMITTED (never rejects). It holds
 * the backend slot until the commit lands: a step begun in that window would
 * JOIN it, never ask, and see the rest of its writes land outside every step
 * -- the timeline's own BUG-0200 window, which the frontend's
 * `undoCommitsSettled` cannot see.
 */
let selectionStepClosing: Promise<void> = Promise.resolve();

/** How often a closing step looks again for a frontend transaction that joined it. */
const FRONTEND_TRANSACTION_POLL_MS = 16;

/**
 * Settles once no frontend transaction is open or committing. A frontend
 * gesture begun while a selection's OWN step is open (a chart move through
 * `runInUndoTransaction`, a group drag) JOINS that step on the backend -- its
 * begin answers null -- so it commits nothing, and the step must stay open
 * until its last write has landed or the rest of it becomes a step of its own.
 * `@api/objectGeometry` announces a transaction's END only once its commit has
 * begun (`undoCommitsSettled`), not its opener's last write, so the step looks
 * again until none is open. Only a selection that OPENED its own step waits
 * here, never work tracked inside a frontend transaction (that would wait for
 * itself).
 */
async function frontendTransactionsLanded(): Promise<void> {
  while (isUndoTransactionOpen()) {
    await new Promise<void>((resolve) => setTimeout(resolve, FRONTEND_TRANSACTION_POLL_MS));
  }
  await undoCommitsSettled();
}

/**
 * Join the step that is open right now, if any, answering the joined work --
 * or null when there is none to join. Synchronous up to the join, so nothing
 * opens or closes a step in between.
 *
 * - This store's OWN open selection step (another click still landing -- the
 *   UI fires one at mousedown and again at mouseup, neither awaited): tracked,
 *   so the step's commit waits for it; its overwrites go into the step's tally,
 *   so the one question counts every cell the one step holds.
 * - A FRONTEND transaction (a canvas group drag, another gesture's step):
 *   joined and tracked, so its opener's commit waits for these writes.
 */
function joinOpenStep<T>(
  body: (overwrites: PivotOverwriteTally) => Promise<T>,
  overwrites: PivotOverwriteTally,
): Promise<T> | null {
  const step = openSelectionStep;
  if (step && !step.closing) {
    // After the step's begin has landed, and inside a frontend transaction
    // opened while it was in flight, when there is one.
    const work = step.ready.then(() => joinUndoTransaction(() => body(step.overwrites)));
    step.pending.add(work);
    // Never an unhandled rejection from the tracking copy: the caller awaits `work`.
    work.catch(() => {});
    return work;
  }
  if (isUndoTransactionOpen()) return joinUndoTransaction(() => body(overwrites));
  return null;
}

/**
 * Run a timeline selection's writes as ONE undo step, and say whether that
 * step is the gesture's OWN -- the only step it may ask about and offer to
 * take back (wave F, Z3).
 *
 * THE BEGIN'S OWN ANSWER DECIDES, never a probe before it. The gesture asked
 * `isAnyUndoTransactionOpen()` and THEN began, and every begin is an IPC round
 * trip a script runs beside: a script's `beginBatch` landing in between made
 * the begin JOIN the batch while the gesture believed the step was its own (it
 * asked, and a decline aimed at the script's step), and a batch committing in
 * between made the begin OPEN the gesture's own step while the gesture
 * believed it had joined (it never asked about the cells it overwrote).
 *
 * - A step open right now -- another selection's, or a FRONTEND transaction
 *   -- is joined and tracked ({@link joinOpenStep}); never this gesture's to
 *   ask about.
 * - Otherwise the step is registered BEFORE its begin is sent (a selection
 *   made while the begin is in flight joins it), and the backend's begin
 *   decides, under the one lock that opens: a TICKET -- the step is this
 *   gesture's, committed presenting it; null -- another caller's transaction
 *   (a script's batch, a frontend gesture whose begin landed first) holds the
 *   slot, which the writes join and the gesture neither closes nor asks about.
 * - A begin that FAILED: the writes still land (outside a transaction, as the
 *   frontend's own transaction does it), and a step that cannot be proved the
 *   gesture's own is never offered back.
 *
 * KEPT WHOLE (the review of Z3). The step is not a frontend transaction, so
 * `@api/objectGeometry` cannot see it: a frontend gesture begun while it is
 * open joins it on the BACKEND and commits nothing. The writes run inside a
 * frontend transaction opened meanwhile (tracked, so a transaction whose
 * begin landed first waits for them), and the commit waits for every joined
 * selection and every frontend transaction to land
 * ({@link frontendTransactionsLanded}). That step also holds the other
 * gesture's change and the backend marks it shared: a decline of its
 * overwrite is then refused, never a take-back of the other change too.
 *
 * The commit runs even when `body` throws: whatever it wrote is on the
 * backend and belongs in the one step.
 */
async function runTimelineSelectionStep<T>(
  label: string,
  overwrites: PivotOverwriteTally,
  body: (overwrites: PivotOverwriteTally) => Promise<T>,
): Promise<{ result: T; own: boolean }> {
  const joined = joinOpenStep(body, overwrites);
  if (joined) return { result: await joined, own: false };
  // A frontend transaction or a selection step still COMMITTING holds the
  // backend slot until its commit lands: begun in that window, this step
  // would join it (BUG-0200).
  await Promise.all([undoCommitsSettled(), selectionStepClosing]);
  const joinedLate = joinOpenStep(body, overwrites);
  if (joinedLate) return { result: await joinedLate, own: false };

  const begun: Promise<OwnedUndoTransaction | null> = (async () => {
    try {
      return ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);
    } catch (err) {
      console.error("[TimelineSlicer] The selection's undo step could not be opened; applying it without one:", err);
      return null;
    }
  })();
  const step: TimelineSelectionStep = {
    ready: begun.then(() => undefined),
    pending: new Set(),
    overwrites,
    closing: false,
  };
  openSelectionStep = step;
  const tx = await begun;
  try {
    const result = await joinUndoTransaction(() => body(overwrites));
    return { result, own: tx?.opened === true };
  } finally {
    // Work may join while earlier work settles: settle until stable.
    let seen = -1;
    while (step.pending.size !== seen) {
      seen = step.pending.size;
      await Promise.allSettled(Array.from(step.pending));
    }
    step.closing = true;
    if (openSelectionStep === step) openSelectionStep = null;
    const closed = (async () => {
      await frontendTransactionsLanded();
      await tx?.commit();
    })();
    selectionStepClosing = closed.catch(() => {});
    await closed;
  }
}

/** Whether two selection ranges are the same. */
function sameRange(
  a: { start: string | null; end: string | null },
  b: { start: string | null; end: string | null },
): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * A timeline selection AND the filter it puts on its pivots, as ONE gesture
 * (BUG-0200, S2): the filter used to be applied by a fire-and-forget listener,
 * outside any undo step and without ever asking -- a pivot it grew over the
 * user's cells recorded a step of its own, separate from the selection.
 *
 * The selection AND its pivots' writes are ONE undo step (W1): the backend's
 * `update_timeline_selection` JOINS the transaction this opens, where it used
 * to commit a step of its own beneath the pivots' -- so a decline had to take
 * that second step back by its history id, and could only when it was
 * provably this gesture's (the backend no longer takes back any step by id).
 * A user gesture (`askBeforeOverwrite`) whose pivots grew over the user's
 * cells is asked ONCE after the step committed,
 * and a decline takes the whole step back by its overwrite token: the
 * selection comes back WITH its pivots. The restored selection is then
 * re-applied to the pivots the step did not carry (a level-1 mask records no
 * undo of its own), recording nothing -- and only when the selection did come
 * back; when it did not, nothing is re-applied and the user is told. A gesture
 * inside someone else's open transaction never asks -- and "inside" is what
 * the gesture's OWN begin answered, never a probe made before it
 * ({@link runTimelineSelectionStep}, Z3). A selection made while another one's
 * step is still landing joins that step and never asks either: the step's
 * opener asks ONCE, counting the cells both overwrote (the review of Z3).
 */
export async function updateTimelineSelectionAsync(
  timelineId: string,
  selectionStart: string | null,
  selectionEnd: string | null,
  options: { askBeforeOverwrite?: boolean } = {},
): Promise<void> {
  try {
    const prior = cachedTimelines.find((t) => t.id === timelineId);
    const before = { start: prior?.selectionStart ?? null, end: prior?.selectionEnd ?? null };
    const declined = { start: selectionStart, end: selectionEnd };
    const overwrites = createPivotOverwriteTally();
    // ONE step for the selection and its pivots (W1). LANDING meanwhile: the
    // backend refuses an undo or redo while a pivot filter that records at its
    // end is in flight (W4), and the keyboard says why (index.ts).
    landingGestures += 1;
    let tl: TimelineSlicer | undefined;
    let own = false;
    try {
      // `tally` is this gesture's own `overwrites` when it opens the step, and
      // the step's when it joins another selection's (its opener asks).
      const step = await runTimelineSelectionStep("Timeline Filter", overwrites, async (tally) => {
        await api.updateTimelineSelection({
          timelineId,
          selectionStart,
          selectionEnd,
        });
        // Update local cache
        const cached = cachedTimelines.find((t) => t.id === timelineId);
        if (cached) {
          cached.selectionStart = selectionStart;
          cached.selectionEnd = selectionEnd;
          await applyTimelineFilter(cached, { overwrites: tally });
          appliedRanges.set(timelineId, rangeOf(cached));
        }
        return cached;
      });
      tl = step.result;
      own = step.own;
    } finally {
      landingGestures -= 1;
    }
    if (tl) {
      // Asked only by a user gesture whose OWN begin opened the step; a
      // script's call (no askBeforeOverwrite) never asks.
      if (options.askBeforeOverwrite && own) {
        const outcome = await confirmPivotOverwriteOrUndo(overwrites);
        if (outcome === "undone") {
          // Back to what the take-back restored, and its masks re-derived on
          // the pivots the step did not carry (recording nothing) -- but ONLY
          // when the selection came back. The one step holds the selection,
          // so it comes back with the pivots; should it not have (the backend
          // refused the take-back of part of it), the backend still holds the
          // DECLINED selection, and re-deriving from it would grow the pivots
          // over the cells the decline had just restored, recording nothing
          // (the review of S2).
          await refreshCache();
          const restored = cachedTimelines.find((t) => t.id === timelineId);
          const now = { start: restored?.selectionStart ?? null, end: restored?.selectionEnd ?? null };
          if (restored && !sameRange(now, declined)) {
            await applyTimelineFilter(restored, { reconcile: true });
            appliedRanges.set(timelineId, now);
          } else if (!sameRange(before, declined)) {
            showToast(TIMELINE_SELECTION_NOT_TAKEN_BACK, { type: "error", duration: 8000 });
          }
          await refreshTimelineData(timelineId);
          requestOverlayRedraw();
          return;
        }
      }
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

/** Timeline selections whose filter has not landed its undo step yet. */
let landingGestures = 0;

/**
 * Whether a timeline selection is still applying its filter (a pivot filter
 * that records its step when it LANDS). The backend refuses an undo or redo
 * meanwhile (`undo_commands::history_move_refusal`, W4); the keyboard's
 * refusal asks this so the user hears why.
 */
export function isTimelineGestureLanding(): boolean {
  return landingGestures > 0;
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
    for (const tl of cachedTimelines) {
      if (!appliedRanges.has(tl.id)) appliedRanges.set(tl.id, rangeOf(tl));
    }
    for (const timelineId of before) {
      if (surviving.has(timelineId)) continue;
      appliedRanges.delete(timelineId);
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

/**
 * Re-read the timelines after an OUTSIDE change -- an undo or redo, a
 * declined gesture's take-back (the `slicer` domain the Shell fans out to
 * "timelineslicers:refresh") -- and re-derive the pivot masks of every
 * timeline whose selection that change moved, recording NOTHING
 * (`reconcile: true`).
 *
 * WHY. A timeline's filter on its pivots is a level-1 mask, and a mask records
 * no undo of its own (only one that grows a pivot over the user's cells
 * does): Ctrl+Z of a timeline selection put the timeline's range back and
 * left its pivots filtered by the range just undone -- the timeline said one
 * thing, its pivots showed another, and Ctrl+Y did the same the other way.
 * The Slicer's store has run this reconcile since BUG-0187; the timeline had
 * none. What its pivots show is the ledger ({@link appliedRanges}), not a diff
 * of the cache: any "pivot:refresh" re-reads the cache too, and a diff taken
 * after one of those would miss the undo. While a timeline gesture is landing
 * nothing is reconciled: that gesture applies its filter itself.
 */
export async function refreshCacheAndReconcile(): Promise<void> {
  await refreshCache();
  if (landingGestures > 0) return;
  for (const tl of cachedTimelines) {
    const shown = appliedRanges.get(tl.id);
    const now = rangeOf(tl);
    if (!shown || sameRange(shown, now)) continue;
    await applyTimelineFilter(tl, { reconcile: true });
    appliedRanges.set(tl.id, now);
  }
}

export function resetStore(): void {
  cachedTimelines = [];
  dataCache.clear();
  appliedRanges.clear();
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
