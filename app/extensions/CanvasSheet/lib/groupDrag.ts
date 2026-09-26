//! FILENAME: app/extensions/CanvasSheet/lib/groupDrag.ts
// PURPOSE: The canvas GROUP DRAG: dragging one member of a multi-selection
//          moves every member, across families, as ONE undo step.
// CONTEXT: Core moves exactly ONE region -- the one pressed -- and dispatches
//          `floatingObject:movePreview` / `moveComplete` for it, already
//          snapped and kept on the page. Three families (Controls, Slicer,
//          Timeline) co-move their OWN selection along with a dragged member;
//          nothing moved the rest: a second chart held by the selection set, a
//          slicer when a chart was dragged, a floating range, a pivot box.
//
//          This follows the lead's delta and moves the members nobody else
//          moves, through each family's provider on the object-geometry seam
//          (@api/objectGeometry): previewed on every frame, committed at
//          mouseup. A member is left to its family when that family
//          co-moves its own selection (`coMovesOwnSelection`), belongs to the
//          dragged object's family and is held by it; everything else is
//          moved here -- including a set-held member of the dragged family
//          (a second chart). Locked members, and members whose family refuses
//          moves, stay put. Every mover moves by the lead's (snapped) delta
//          and is then kept on the page, exactly as the lead was.
//
//          ONE UNDO STEP. The transaction is opened at the FIRST preview frame
//          of a group drag -- before any family persists anything -- so every
//          write of the gesture joins it: the lead's family's own persist at
//          moveComplete (Slicer / Timeline / Controls / the pivot box go
//          through the seam's `runInUndoTransaction` / `joinUndoTransaction`,
//          so their work is tracked), the debounced chart and floating-range
//          saves (flushed through the seam before the commit), and the moves
//          made here. The transaction is committed once, after all of it has
//          landed. A single-object drag never opens one.
//
//          Listens to Core's generic floating-object events only (custom
//          events, not input events). The canvas extension activates last, so
//          by the time these listeners run the pressed family has already
//          handled the same event.

import { getGridStateSnapshot } from "@api/grid";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { clampMoveToPage, getLayoutSurface, type LayoutRect } from "@api/layoutSurface";
import {
  commitObjectGeometry,
  familyCoMovesOwnSelection,
  flushObjectGeometry,
  getObjectGeometryProvider,
  openUndoTransaction,
  previewObjectGeometry,
  type ObjectGeometryChange,
  type UndoTransactionHandle,
} from "@api/objectGeometry";
import { getSelectedObjectRegions, getSetHeldObjectRegions } from "@api/objectSelection";
import { isArrangeMovable, type PageSize } from "./arrange";

/** The undo label of a group drag. */
export const GROUP_DRAG_UNDO_LABEL = "Move Objects";

interface DragMember {
  region: GridRegion;
  from: LayoutRect;
}

/** What the press saw: the lead and every member, where they were. */
interface PressSnapshot {
  leadId: string;
  leadStart: LayoutRect;
  lead: GridRegion;
  members: DragMember[];
  setHeldIds: ReadonlySet<string>;
}

interface DragSession {
  press: PressSnapshot;
  movers: DragMember[];
  tx: UndoTransactionHandle | null;
}

let pressed: PressSnapshot | null = null;
let session: DragSession | null = null;

interface MoveDetail {
  regionId?: unknown;
  x?: unknown;
  y?: unknown;
}

function onCanvas(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

function activePage(): PageSize {
  const surface = getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
  return surface?.page ?? null;
}

// ============================================================================
// Pure (exported for tests)
// ============================================================================

/**
 * The members the CANVAS must move when `lead` is dragged: every other member
 * that can be moved, except those the lead's own family co-moves (same
 * family, the family co-moves its selection, and it holds the member itself
 * rather than the set holding it).
 */
export function membersToMove(
  lead: GridRegion,
  members: readonly DragMember[],
  setHeldIds: ReadonlySet<string>,
  canMove: (region: GridRegion) => boolean = isArrangeMovable,
): DragMember[] {
  const leadProvider = getObjectGeometryProvider(lead);
  return members.filter((m) => {
    if (m.region.id === lead.id) return false;
    if (!canMove(m.region)) return false;
    const sameFamily = leadProvider !== null && getObjectGeometryProvider(m.region) === leadProvider;
    if (sameFamily && familyCoMovesOwnSelection(m.region) && !setHeldIds.has(m.region.id)) return false;
    return true;
  });
}

/** Where each mover goes for a lead delta: shifted by it, then kept on the page. */
export function moverChanges(
  movers: readonly DragMember[],
  delta: { dx: number; dy: number },
  page: PageSize,
): ObjectGeometryChange[] {
  return movers.map((m) => {
    const next = clampMoveToPage({ ...m.from, x: m.from.x + delta.dx, y: m.from.y + delta.dy }, page);
    return { region: m.region, ...next, from: m.from };
  });
}

// ============================================================================
// The gesture
// ============================================================================

function numberOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Commit an open session (its transaction) with whatever it has. */
async function closeSession(s: DragSession, final: ObjectGeometryChange[] | null): Promise<void> {
  if (!s.tx) return;
  const tx = s.tx;
  try {
    if (final && final.length > 0) {
      await tx.run(() => commitObjectGeometry(final, GROUP_DRAG_UNDO_LABEL));
    }
    // The lead's family may have debounced its own persist (charts, floating
    // ranges): land it INSIDE the transaction.
    await tx.run(() => flushObjectGeometry());
  } finally {
    try {
      await tx.commit();
    } catch (err) {
      console.error("[CanvasSheet] group drag: the undo transaction could not be committed:", err);
    }
  }
}

/**
 * The press (Core's `floatingObject:selected`, after every family handled
 * it): remember the lead and the whole selection, where they were.
 */
export function handleGroupDragPress(e: Event): void {
  // A session whose mouseup never arrived ends here, with what it has.
  if (session) {
    const stale = session;
    session = null;
    void closeSession(stale, null);
  }
  pressed = null;
  if (!onCanvas()) return;
  const d = ((e as CustomEvent).detail ?? {}) as { regionId?: unknown };
  if (typeof d.regionId !== "string") return;
  const lead = getGridRegions().find((r) => r.id === d.regionId);
  if (!lead?.floating) return;
  const members = getSelectedObjectRegions()
    .filter((r) => !!r.floating)
    .map((region) => ({ region, from: { ...region.floating! } }));
  if (members.length < 2 || !members.some((m) => m.region.id === lead.id)) return;
  pressed = {
    leadId: lead.id,
    leadStart: { ...lead.floating },
    lead,
    members,
    setHeldIds: new Set(getSetHeldObjectRegions().map((r) => r.id)),
  };
}

function deltaOf(p: PressSnapshot, d: MoveDetail): { dx: number; dy: number } | null {
  const x = numberOr(d.x);
  const y = numberOr(d.y);
  if (x === null || y === null) return null;
  return { dx: x - p.leadStart.x, dy: y - p.leadStart.y };
}

/** A preview frame of the lead: move the other members along (no write). */
export function handleGroupDragPreview(e: Event): void {
  const p = pressed;
  if (!p) return;
  const d = ((e as CustomEvent).detail ?? {}) as MoveDetail;
  if (d.regionId !== p.leadId) return;
  const delta = deltaOf(p, d);
  if (!delta) return;
  if (!session || session.press !== p) {
    const movers = membersToMove(p.lead, p.members, p.setHeldIds);
    // Open the ONE transaction before any family persists anything of this
    // gesture; a group with nothing for the canvas to move needs none.
    session = { press: p, movers, tx: movers.length > 0 ? openUndoTransaction(GROUP_DRAG_UNDO_LABEL) : null };
  }
  if (session.movers.length === 0) return;
  previewObjectGeometry(moverChanges(session.movers, delta, activePage()));
}

/**
 * The lead's move completed (mouseup). Resolves when every write of the
 * gesture has landed and the one undo step is committed.
 */
export async function handleGroupDragComplete(e: Event): Promise<void> {
  const p = pressed;
  const s = session;
  if (!p || !s || s.press !== p) return;
  const d = ((e as CustomEvent).detail ?? {}) as MoveDetail;
  if (d.regionId !== p.leadId) return;
  pressed = null;
  session = null;
  const delta = deltaOf(p, d);
  const final = delta && s.movers.length > 0 ? moverChanges(s.movers, delta, activePage()) : null;
  await closeSession(s, final);
}

/** Install the listeners; returns the cleanups. */
export function installCanvasGroupDrag(): Array<() => void> {
  const onComplete = (e: Event): void => {
    void handleGroupDragComplete(e);
  };
  window.addEventListener("floatingObject:selected", handleGroupDragPress);
  window.addEventListener("floatingObject:movePreview", handleGroupDragPreview);
  window.addEventListener("floatingObject:moveComplete", onComplete);
  return [
    () => window.removeEventListener("floatingObject:selected", handleGroupDragPress),
    () => window.removeEventListener("floatingObject:movePreview", handleGroupDragPreview),
    () => window.removeEventListener("floatingObject:moveComplete", onComplete),
    () => {
      const s = session;
      session = null;
      pressed = null;
      if (s) void closeSession(s, null);
    },
  ];
}

/** Test hook: forget the press and any session WITHOUT committing. */
export function resetCanvasGroupDrag(): void {
  pressed = null;
  session = null;
}
