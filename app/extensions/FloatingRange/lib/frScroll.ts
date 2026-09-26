//! FILENAME: app/extensions/FloatingRange/lib/frScroll.ts
// PURPOSE: The session scroll origin of each floating range's cell area, as an
//          id-keyed SIDE MAP.
// CONTEXT: M7 (floating-grid overflow scroll). Scroll is a VIEWING state, like a
//          worksheet's scroll position: never persisted, never in the undo
//          stack, never dirtying the document, never announced with a
//          GRID_REFRESH / MUTATION_REFRESH -- a scroll only asks for an overlay
//          repaint (Pivot/lib/pivotVisualScroll.ts is the precedent).
//
//          It lives HERE and not on FloatingRangeEntry, because the store
//          REBUILDS its entries all the time: every update_floating_range
//          (including a debounced move) announces a MUTATION_REFRESH that comes
//          back as FLOATING_RANGES_CHANGED and `entries = infos.map(fromInfo)`,
//          SHEET_CHANGED reloads, and upsertFromInfo REPLACES the entry. A
//          field on the entry would be zeroed by the user's own drag.
//
//          Lifetime, by design:
//          - KEPT across SHEET_CHANGED, FLOATING_RANGES_CHANGED and
//            PACKAGE_UPDATED (a reload of the same range must not jump it back
//            to the top);
//          - CLEARED by removeFloatingRange and resetFloatingRangeStore (the
//            store calls in here), which is how File > New / Open and
//            deactivate reach it;
//          - PRUNED for rows that no longer exist after a backend reload.
//
//          The values are raw content px and may be past the current maximum:
//          clamping belongs to whoever knows the extent (lib/frView.ts), and it
//          re-clamps on every paint. This module stays import-free so the store
//          can depend on it without a cycle.

/** A scroll origin in the cell area's CONTENT px (0,0 = unscrolled). */
export interface FrScroll {
  left: number;
  top: number;
}

const scrolls = new Map<string, FrScroll>();

/** The range's scroll origin (0,0 until it is scrolled). Never undefined. */
export function getFrScroll(frId: string): FrScroll {
  const s = scrolls.get(frId);
  return s ? { left: s.left, top: s.top } : { left: 0, top: 0 };
}

/** Record a scroll origin. (0,0) forgets the entry: unscrolled is the default. */
export function setFrScroll(frId: string, left: number, top: number): void {
  const l = Number.isFinite(left) ? Math.max(0, left) : 0;
  const t = Number.isFinite(top) ? Math.max(0, top) : 0;
  if (l === 0 && t === 0) scrolls.delete(frId);
  else scrolls.set(frId, { left: l, top: t });
}

/** Forget one range's scroll (the range was removed). */
export function clearFrScroll(frId: string): void {
  scrolls.delete(frId);
}

/** Forget every scroll (a new or opened document, deactivate). */
export function resetFrScrolls(): void {
  scrolls.clear();
}

/** Drop the scroll of every range NOT in `liveIds` (a backend reload pruned it). */
export function pruneFrScrolls(liveIds: ReadonlySet<string>): void {
  for (const id of [...scrolls.keys()]) {
    if (!liveIds.has(id)) scrolls.delete(id);
  }
}

/** How many ranges carry a non-zero scroll (tests). */
export function frScrollCount(): number {
  return scrolls.size;
}
