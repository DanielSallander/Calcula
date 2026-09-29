//! FILENAME: app/src/api/objectGeometry.ts
// PURPOSE: The OBJECT GEOMETRY seam: move (and, where a family allows it,
//          resize) floating objects of EVERY family without a mouse gesture --
//          and do it as ONE undo step however many families are involved.
// CONTEXT: Core owns the pointer gesture for a floating object and each family
//          persists what `floatingObject:moveComplete` hands it. That covers
//          one dragged object. The canvas's ARRANGE commands (align,
//          distribute), its arrow-key NUDGE and its cross-family GROUP DRAG
//          move several objects of several families at once, and they must not
//          do it by dispatching synthetic `floatingObject:*` events: every
//          family reads those as a live pointer gesture (Controls co-moves its
//          selection with stale drag state, Slicer and Timeline complete a
//          pending click, Charts advances its sub-selection).
//
//          So each family registers ONE provider for the region types it owns
//          (the objectSelection / controlsService precedent: the owning
//          extension decides HOW, callers say WHAT). A provider can PREVIEW a
//          change (its local cache only: no write, no undo, no dirty flag) and
//          COMMIT it (persist it; its backend commands record undo JOINING an
//          open transaction, and its debounced saves have been flushed by the
//          time the commit resolves).
//
//          `commitObjectGeometry` groups the changes by provider and runs every
//          commit inside ONE frontend-owned undo transaction, so an align that
//          moves a chart, two slicers and a button is one Ctrl+Z.
//
// REFUSALS. A commit the backend refuses (a protected sheet that disallows
//          editing objects, a vanished object) REJECTS, after the provider has
//          put its local geometry back to what the backend holds -- a moved-
//          looking object the backend refused is a lie. `commitObjectGeometry`
//          collects every refusal of the call and shows ONE error toast.
//
// THE UNDO TRANSACTION. The backend keeps one open transaction: `begin` is a
//          no-op while one is open, but `commit` is not -- an unconditional
//          begin/commit pair inside someone else's group closes it early and
//          splits their undo step. `openUndoTransaction` keeps the frontend's
//          own nesting here: the first caller opens the backend transaction,
//          every later caller JOINS it (its work is tracked), and only the
//          opener commits -- after every joined piece of work has landed. A
//          group drag opens one at its first preview frame; the dragged
//          family's own persist (Slicer's co-move, Controls' batch, the pivot
//          box's frame) joins it through `runInUndoTransaction` /
//          `joinUndoTransaction`, and the canvas commits once at mouseup.
//
//          The frontend's nesting cannot see a transaction opened on the
//          BACKEND by another caller -- a script's `beginBatch`, a Core
//          gesture's own begin. The backend's begin answers whether it OPENED
//          the transaction (W3); a frontend opener whose begin only JOINED one
//          never commits it -- the caller that opened it does. Committing
//          anyway closed a script's batch half-way: a timeline selection made
//          inside `beginBatch` split the batch into two Ctrl+Z steps. And an
//          opener commits with the TICKET its begin was handed: a sheet change
//          in between ends its transaction (Excel parity), and a bare commit
//          then closed whatever a stranger had opened since.
//
//          Seams point one way: this module imports nothing from extensions.

import { requestOverlayRedraw, type GridRegion } from "./gridOverlays";
import { showToast } from "./notifications";
import { clampMoveToPage, getLayoutSurface, isRegionLocked } from "./layoutSurface";
import {
  beginUndoTransaction,
  commitUndoTransaction,
  readUndoBeginAnswer,
  type UndoTransactionTicket,
} from "../core/lib/tauri-api";
import { registerCommandRefusal } from "./keybindings";
import { CoreCommands } from "./commands";

// ============================================================================
// Types
// ============================================================================

/** A rectangle in logical sheet px (the units of `GridRegion.floating`). */
export interface ObjectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where ONE object should be. */
export interface ObjectGeometryChange extends ObjectRect {
  /** The object's region (its type picks the provider, its data names the object). */
  region: GridRegion;
  /**
   * Where the object was before this gesture began (a nudge burst, a group
   * drag). Defaults to `region.floating`. A provider whose refused write
   * changed nothing uses it to put the object back exactly.
   */
  from?: ObjectRect;
}

/** One family's geometry provider. */
export interface ObjectGeometryProvider {
  /** The `GridRegion.type` values this provider owns. */
  types: readonly string[];
  /**
   * Whether this object's SIZE may change through the seam. Default true. A
   * provider that answers false (a floating range: whole rows and columns)
   * has width/height of every change replaced by the object's current size.
   */
  canResize?(region: GridRegion): boolean;
  /**
   * Show the changes WITHOUT persisting them: the family's local cache only,
   * no backend write, no undo entry, no debounced save scheduled. A commit
   * always follows (or the caller previews the original geometry back).
   */
  preview?(changes: readonly ObjectGeometryChange[]): void;
  /**
   * Persist the changes. Undo records must JOIN an open transaction, and any
   * debounced save must have landed by the time this resolves. REJECTS when
   * the backend refused some or all of them -- after the provider has put its
   * local geometry back to what the backend holds.
   */
  commit(changes: readonly ObjectGeometryChange[]): Promise<void>;
  /**
   * Write out whatever geometry this family has debounced or in flight (a
   * drag's own persist) and resolve when it has landed. Optional: a family
   * whose writes are immediate has nothing to flush.
   */
  flush?(): Promise<void>;
  /**
   * True when the family moves its OWN multi-selection along with a dragged
   * member (Controls, Slicer, Timeline). A canvas group drag leaves those
   * members to the family and moves only the others.
   */
  coMovesOwnSelection?: boolean;
}

/** What a commit did. */
export interface ObjectGeometryOutcome {
  /** Changes whose provider committed them. */
  committed: number;
  /** Changes whose provider refused them (reverted; one toast told the user). */
  refused: number;
  /** Changes no provider owns (ignored). */
  skipped: number;
}

// ============================================================================
// Registry
// ============================================================================

const providers = new Map<string, ObjectGeometryProvider>();

/**
 * Register a family's provider for each of its region types. Last
 * registration wins per type; the cleanup removes only what is still this
 * provider's (a stale cleanup cannot remove a newer registration).
 */
export function registerObjectGeometryProvider(provider: ObjectGeometryProvider): () => void {
  for (const t of provider.types) providers.set(t, provider);
  return () => {
    for (const t of provider.types) {
      if (providers.get(t) === provider) providers.delete(t);
    }
  };
}

/** Whether some provider owns this region type. */
export function hasObjectGeometryProvider(type: string): boolean {
  return providers.has(type);
}

/** The provider for `region`'s type, or null. */
export function getObjectGeometryProvider(region: GridRegion): ObjectGeometryProvider | null {
  return providers.get(region.type) ?? null;
}

/** Whether the object behind `region` can be moved through this seam. */
export function canMoveObject(region: GridRegion): boolean {
  return !!region.floating && providers.has(region.type);
}

/** Whether the object behind `region` can be RESIZED through this seam. */
export function canResizeObject(region: GridRegion): boolean {
  const p = providers.get(region.type);
  if (!p || !region.floating) return false;
  if (!p.canResize) return true;
  try {
    return p.canResize(region) !== false;
  } catch (err) {
    console.error("[objectGeometry] provider canResize threw:", err);
    return false;
  }
}

/** Whether the object's family co-moves its own selection with a dragged member. */
export function familyCoMovesOwnSelection(region: GridRegion): boolean {
  return providers.get(region.type)?.coMovesOwnSelection === true;
}

/**
 * Where a member a FAMILY co-moves with its dragged lead goes -- Controls,
 * Slicer and Timeline move their own multi-selection along with a dragged
 * member (`coMovesOwnSelection`) -- by the SAME rule the canvas group drag
 * applies to the members it moves itself (CanvasSheet lib/groupDrag.ts
 * `moverChanges`):
 *
 *   - `from` is the member's rect when the drag BEGAN and `delta` the lead's
 *     total move so far, already snapped by Core -- never a per-frame
 *     increment, which a clamp turns into drift (a member pushed against an
 *     edge and brought back ended up displaced);
 *   - on a sheet with a PAGE (a canvas) the result is kept on the page
 *     (`clampMoveToPage`: the size is kept, the origin clamped), exactly as the
 *     lead was;
 *   - a member the surface LOCKS stays where it was (pass its `region`);
 *   - off a page (a worksheet) the families' historical clamp at 0 holds.
 *
 * Until this existed each family clamped its members at 0 only, so a family-
 * led drag on a canvas pushed its other members off the page that a
 * Core-led drag of the very same selection kept them on, and moved locked
 * ones.
 */
export function coMovedMemberRect(
  sheetIndex: number,
  from: ObjectRect,
  delta: { dx: number; dy: number },
  region?: GridRegion | null,
): ObjectRect {
  const surface = getLayoutSurface(sheetIndex);
  if (region && isRegionLocked(surface, region)) return { ...from };
  const moved = { x: from.x + delta.dx, y: from.y + delta.dy, width: from.width, height: from.height };
  if (surface?.page) return clampMoveToPage(moved, surface.page);
  return { ...moved, x: Math.max(0, moved.x), y: Math.max(0, moved.y) };
}

/** Test hook: forget every provider and any open frontend transaction. */
export function resetObjectGeometryProviders(): void {
  providers.clear();
  current = null;
  lastClosing = null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A change with the size pinned where the family cannot resize. */
function normalized(change: ObjectGeometryChange): ObjectGeometryChange {
  const f = change.region.floating;
  if (!f || canResizeObject(change.region)) return change;
  return { ...change, width: f.width, height: f.height };
}

/** Group changes by provider, in first-seen order; unknown types dropped. */
function groupByProvider(
  changes: readonly ObjectGeometryChange[],
): { groups: Map<ObjectGeometryProvider, ObjectGeometryChange[]>; skipped: number } {
  const groups = new Map<ObjectGeometryProvider, ObjectGeometryChange[]>();
  let skipped = 0;
  for (const c of changes) {
    const p = providers.get(c.region.type);
    if (!p || !c.region.floating) {
      skipped++;
      continue;
    }
    const list = groups.get(p);
    if (list) list.push(normalized(c));
    else groups.set(p, [normalized(c)]);
  }
  return { groups, skipped };
}

// ============================================================================
// Preview / commit / flush
// ============================================================================

/**
 * Show `changes` without persisting them (each family's local cache), then
 * repaint once. Types no provider owns are ignored.
 */
export function previewObjectGeometry(changes: readonly ObjectGeometryChange[]): void {
  const { groups } = groupByProvider(changes);
  for (const [p, list] of groups) {
    if (!p.preview) continue;
    try {
      p.preview(list);
    } catch (err) {
      console.error("[objectGeometry] provider preview threw:", err);
    }
  }
  if (groups.size > 0) requestOverlayRedraw();
}

/** Ask the given providers (default: every one) to land what they have in flight. */
async function flushProviders(list: Iterable<ObjectGeometryProvider>): Promise<void> {
  for (const p of list) {
    if (!p.flush) continue;
    try {
      await p.flush();
    } catch (err) {
      console.error("[objectGeometry] provider flush threw:", err);
    }
  }
}

/**
 * Land every family's debounced / in-flight geometry writes (a drag's own
 * persist), so an open transaction can be committed around them.
 */
export function flushObjectGeometry(): Promise<void> {
  return flushProviders(new Set(providers.values()));
}

/** The one toast for a call's refusals. */
function reportRefusals(label: string, refused: number, reasons: readonly string[]): void {
  const what = refused === 1 ? "1 object" : `${refused} objects`;
  const unique = Array.from(new Set(reasons.filter((r) => r.trim() !== "")));
  const because = unique.length > 0 ? ` ${unique.join(" ")}` : "";
  showToast(`${label}: ${what} could not be moved.${because} They are back where they were.`, {
    type: "error",
    duration: 8000,
  });
}

/**
 * Persist `changes` -- grouped by provider, every commit inside ONE undo
 * transaction labelled `label` (joined when one is already open), and every
 * involved provider flushed before the transaction commits. Resolves when all
 * of it has landed. Refusals are reverted by their providers and reported in
 * ONE error toast; they never reject this call.
 */
export async function commitObjectGeometry(
  changes: readonly ObjectGeometryChange[],
  label: string,
): Promise<ObjectGeometryOutcome> {
  const { groups, skipped } = groupByProvider(changes);
  if (groups.size === 0) return { committed: 0, refused: 0, skipped };

  let committed = 0;
  let refused = 0;
  const reasons: string[] = [];
  try {
    await runInUndoTransaction(label, async () => {
      for (const [p, list] of groups) {
        try {
          await p.commit(list);
          committed += list.length;
        } catch (err) {
          refused += list.length;
          reasons.push(describe(err));
          console.error(`[objectGeometry] "${label}" refused for ${list.length} object(s):`, err);
        }
      }
      await flushProviders(groups.keys());
    });
  } catch (err) {
    // The transaction itself could not be opened or closed. Whatever did not
    // run counts as refused; what ran is on the undo stack either way.
    const notRun = Array.from(groups.values()).reduce((n, l) => n + l.length, 0) - committed - refused;
    if (notRun > 0) refused += notRun;
    reasons.push(describe(err));
    console.error(`[objectGeometry] "${label}" transaction failed:`, err);
  }
  if (refused > 0) reportRefusals(label, refused, reasons);
  requestOverlayRedraw();
  return { committed, refused, skipped };
}

// ============================================================================
// The frontend-owned undo transaction
// ============================================================================

/** A handle on the open undo transaction (opened here, or joined). */
export interface UndoTransactionHandle {
  /** True when an outer caller opened the transaction and this one joined it. */
  readonly joined: boolean;
  /**
   * Run `fn` inside the transaction: after the backend `begin` has landed,
   * tracked so the opener's commit waits for it.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  /**
   * The opener: wait for every piece of tracked work (including work joined
   * while waiting), then commit the backend transaction -- only when its
   * begin OPENED it; one whose begin joined another caller's backend
   * transaction leaves it to that caller. A joined handle's commit does
   * nothing -- the opener commits.
   */
  commit(): Promise<void>;
  /**
   * Whether THIS handle's backend begin OPENED the transaction -- the
   * backend's own answer, decided under the one lock that opens. False for a
   * joined handle, and for a begin that joined another caller's backend
   * transaction (a script's batch). A caller deciding "was this step mine?"
   * asks THIS, never a probe taken before the begin, which can be stale by the
   * time the begin lands in either direction.
   */
  openedBackend(): Promise<boolean>;
}

interface TransactionState {
  label: string;
  ready: Promise<void>;
  /**
   * Whether this transaction's backend begin OPENED the backend transaction.
   * False when it JOINED one another caller holds open (the begin answered
   * `null`): that caller commits it, never this one. Settled with `ready`.
   */
  opensBackend: boolean;
  /**
   * The ticket the opening begin was handed. The commit presents it, so it
   * closes the backend slot only while the slot still holds THIS transaction
   * -- a sheet change or a document swap in between ends it (Excel parity),
   * and a bare commit then closed whatever a stranger had opened since.
   */
  ticket: UndoTransactionTicket | null;
  pending: Set<Promise<unknown>>;
  closing: boolean;
  done: Promise<void> | null;
}

let current: TransactionState | null = null;
/** The last transaction being committed, so the next begin is sent after it. */
let lastClosing: Promise<void> | null = null;

function tracked<T>(tx: TransactionState, fn: () => Promise<T> | T): Promise<T> {
  // After `begin` has landed -- and even when it FAILED: the user's write must
  // still happen (outside a transaction, then) rather than be silently lost.
  const p = tx.ready.then(
    () => fn(),
    () => fn(),
  );
  tx.pending.add(p);
  // Never an unhandled rejection from the tracking copy: the caller awaits `p`.
  p.catch(() => {});
  return p;
}

/**
 * Open the frontend's undo transaction, or JOIN the one already open. Pair
 * every open with a `commit()` on the returned handle (a joined handle's is a
 * no-op).
 */
export function openUndoTransaction(label: string): UndoTransactionHandle {
  const open = current;
  if (open && !open.closing) {
    return {
      joined: true,
      run: (fn) => tracked(open, fn),
      commit: async () => {},
      openedBackend: async () => false,
    };
  }
  const after = lastClosing ?? Promise.resolve();
  const tx: TransactionState = {
    label,
    ready: Promise.resolve(),
    opensBackend: true,
    ticket: null,
    pending: new Set(),
    closing: false,
    done: null,
  };
  tx.ready = after
    .catch(() => {})
    .then(() => beginUndoTransaction(label))
    .then((answer) => {
      // Only a "joined" (null) hands the commit to the other caller; the
      // backend decides it under the one lock that opens.
      const own = readUndoBeginAnswer(answer);
      tx.opensBackend = own.opened;
      tx.ticket = own.ticket;
    });
  tx.ready.catch(() => {});
  current = tx;
  return {
    joined: false,
    run: (fn) => tracked(tx, fn),
    openedBackend: async () => {
      try {
        await tx.ready;
      } catch {
        return false;
      }
      return tx.opensBackend;
    },
    commit: () => {
      if (tx.done) return tx.done;
      tx.done = (async () => {
        try {
          await tx.ready;
        } catch (err) {
          // `begin` never landed: there is nothing to commit.
          tx.closing = true;
          if (current === tx) current = null;
          throw err;
        }
        // Work may join while we wait on earlier work: settle until stable.
        let seen = -1;
        while (tx.pending.size !== seen) {
          seen = tx.pending.size;
          await Promise.allSettled(Array.from(tx.pending));
        }
        tx.closing = true;
        if (!tx.opensBackend) {
          // Joined another caller's BACKEND transaction: everything tracked
          // has landed inside it, and its opener commits it.
          if (current === tx) current = null;
          return;
        }
        try {
          await (tx.ticket === null ? commitUndoTransaction() : commitUndoTransaction(tx.ticket));
        } finally {
          if (current === tx) current = null;
        }
      })();
      const done = tx.done;
      lastClosing = done.catch(() => {});
      return done;
    },
  };
}

/**
 * Run `fn` as (part of) ONE undo step labelled `label`: inside the open
 * frontend transaction when there is one (joined and tracked), otherwise in a
 * transaction opened and committed around it. The commit runs even when `fn`
 * throws -- whatever it wrote is on the backend and belongs in one step.
 */
export async function runInUndoTransaction<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const handle = openUndoTransaction(label);
  try {
    return await handle.run(fn);
  } finally {
    await handle.commit();
  }
}

/**
 * Run a SINGLE backend write inside the open frontend transaction when there
 * is one (tracked, so the opener's commit waits for it); otherwise run it as
 * is -- one write records its own undo step and needs no transaction.
 */
export function joinUndoTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
  const open = current;
  if (open && !open.closing) return tracked(open, fn);
  return Promise.resolve().then(() => fn());
}

/** Whether the frontend holds an open undo transaction right now. */
export function isUndoTransactionOpen(): boolean {
  return current !== null && !current.closing;
}

/**
 * Settles once the frontend's last undo transaction that started COMMITTING
 * has finished (never rejects). While a commit is in flight the BACKEND still
 * reports its transaction open, so a gesture that asks "is a transaction open
 * anywhere?" in that window was falsely told it JOINED one -- and was never
 * asked about the cells it overwrote (BUG-0200). Such a gesture waits for
 * this first. Never await it from work tracked INSIDE an open transaction:
 * that transaction's own commit waits for the work (`isAnyUndoTransactionOpen`
 * answers "open" before it would wait).
 */
export function undoCommitsSettled(): Promise<void> {
  return lastClosing ?? Promise.resolve();
}

// ============================================================================
// Gestures that LAND their undo step at the end (the review of BUG-0187)
// ============================================================================
//
// A slicer click or a ribbon filter change is ONE backend command that pushes
// its step when it lands, after a model re-query that can take seconds. The
// backend REFUSES an undo or redo meanwhile (`undo_commands::
// history_move_refusal`): taken back under the gesture, the step before it came
// off, the gesture landed on top of it -- clearing that undo's redo -- and a
// click whose previous click was undone underneath left the slicer and its
// pivots disagreeing. The refusal is silent where Core ignores its result, so
// the frontend says it, once per press, while such a gesture lands -- at the
// keyboard's Ctrl+Z / Ctrl+Y AND at every other door (CommandRegistry.execute:
// the ribbon, the Edit menu, the Quick Access Toolbar). Only the keyboard asked
// until 2026-09-29 (e2e fixall-edit W15), and a ribbon Undo could overtake the
// gesture's start and reach the backend before its refusal was armed.

/** What a refused undo or redo says while a gesture lands. */
export const UNDO_WHILE_A_GESTURE_LANDS =
  "A slicer or filter change is still being applied. Undo or redo once it has finished.";

/**
 * Refuse Undo / Redo from every door, with {@link UNDO_WHILE_A_GESTURE_LANDS},
 * while `isLanding()` says a gesture of the caller's that pushes its step
 * when it lands is in flight (a slicer click, a ribbon filter change). Asked
 * at every keystroke; returns the cleanup.
 */
export function refuseUndoWhileAGestureLands(isLanding: () => boolean): () => void {
  return registerCommandRefusal({
    commandIds: [CoreCommands.UNDO, CoreCommands.REDO],
    refuse: () => (isLanding() ? UNDO_WHILE_A_GESTURE_LANDS : null),
  });
}
