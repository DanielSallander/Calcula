//! FILENAME: app/extensions/FloatingRange/lib/frExtent.ts
// PURPOSE: The CONTENT extent of each floating range -- how many rows and
//          columns its cell area can scroll through -- as an id-keyed cache.
// CONTEXT: M7. The frame is the WINDOW (rows x cols), but the backing sheet can
//          hold cells beyond it: a window shrink HIDES cells without deleting
//          them (floating_range.rs), and a formula in the range can SPILL past
//          the window. Those cells must be reachable, so the cell area scrolls
//          over
//
//              extent = min(cap, max(window, usedRangeEnd + 1))
//
//          per axis, with the cap the backend's own window bound (1000 x 256).
//
//          WHERE THE USED RANGE COMES FROM. The existing `get_used_range`
//          command, asked about the BACKING sheet by its live index -- no new
//          Tauri command. That index is otherwise documented as "for event
//          filtering, never addressing" (floatingRangeStore.ts,
//          @api/floatingRanges), and this is the one deliberate exception, for
//          a READ that decides nothing but how far the view may scroll. It is
//          safe for the reason the rule exists: a stale index (a sheet
//          inserted or deleted before the store re-read its rows) can only
//          make the scroll range wrong for a moment -- every cell READ is
//          id-addressed (get_floating_range_cells) and every WRITE is
//          id-addressed and gated in the backend, so a wrong extent can never
//          show another sheet's cells or put a value anywhere.
//
//          FRESHNESS. The raw used extent is cached and invalidated on exactly
//          the triggers that stale the cell cache (frRenderer's invalidate /
//          remove / reset functions call in here), and re-read lazily by the
//          paint of an on-screen range. A stale value stays in force until the
//          re-read lands, like the cells, so the scroll range never collapses
//          to the window for a frame; the landing order is the ledger's
//          (frFetchLedger.ts). The WINDOW half of the max() is read live from
//          the entry, so a resize needs no round trip.

import { getUsedRange } from "@api/lib";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  FLOATING_RANGE_MAX_ROWS,
  FLOATING_RANGE_MAX_COLS,
} from "@api/floatingRanges";
import type { FloatingRangeEntry } from "./floatingRangeStore";
import { FrFetchLedger } from "./frFetchLedger";

/** Rows/cols of an extent (counts, not indexes). */
export interface FrExtent {
  rows: number;
  cols: number;
}

/** frId -> used-range end + 1 on the backing sheet (0,0 = the sheet is empty). */
const usedExtents = new Map<string, FrExtent>();
const ledger = new FrFetchLedger();

function clampCount(v: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(v)));
}

/**
 * The extent the cell area scrolls through: the window, grown to the used
 * range, capped. Until the used range is known this is the window itself --
 * the pre-M7 geometry, so an unfetched range behaves exactly as before.
 */
export function frContentExtent(entry: FloatingRangeEntry): FrExtent {
  const used = usedExtents.get(entry.id);
  const rows = Math.max(entry.rows, used?.rows ?? 0);
  const cols = Math.max(entry.cols, used?.cols ?? 0);
  return {
    rows: clampCount(rows, FLOATING_RANGE_MAX_ROWS),
    cols: clampCount(cols, FLOATING_RANGE_MAX_COLS),
  };
}

/** Whether the used range has been read at least once (stale still counts). */
export function isFrExtentKnown(frId: string): boolean {
  return usedExtents.has(frId);
}

function storeUsedExtent(frId: string, usedRows: number, usedCols: number): void {
  const rows = Math.max(0, Math.trunc(usedRows));
  const cols = Math.max(0, Math.trunc(usedCols));
  const prev = usedExtents.get(frId);
  usedExtents.set(frId, { rows, cols });
  if (!prev || prev.rows !== rows || prev.cols !== cols) requestOverlayRedraw();
}

/**
 * Record a used extent as a known, fresh answer -- the seam tests use to stand
 * a range up with an extent without a backend.
 */
export function recordFrUsedExtent(frId: string, usedRows: number, usedCols: number): void {
  storeUsedExtent(frId, usedRows, usedCols);
}

/**
 * Kick a used-range read when this range has none or a stale one and none is
 * in flight. Called from the paint of an ON-SCREEN range only.
 */
export function ensureFrExtent(entry: FloatingRangeEntry): void {
  const frId = entry.id;
  if (ledger.isPending(frId)) return;
  if (usedExtents.has(frId) && !ledger.isStale(frId)) return;
  void fetchFrExtent(entry);
}

async function fetchFrExtent(entry: FloatingRangeEntry): Promise<void> {
  const frId = entry.id;
  const n = ledger.begin(frId);
  try {
    const used = await getUsedRange(entry.backingSheetIndex);
    if (!ledger.mayApply(frId, n)) return;
    if (used.empty) storeUsedExtent(frId, 0, 0);
    else storeUsedExtent(frId, used.endRow + 1, used.endCol + 1);
    ledger.applied(frId, n);
  } catch (err) {
    if (!ledger.mayApply(frId, n)) return;
    // Degraded, not wrong: the range keeps whatever extent it had -- the
    // window when it never had one -- so it simply cannot scroll further. The
    // failure is recorded as an ANSWER so the next paint does not retry (and
    // warn) every frame; the next invalidation retries. Warn rather than
    // error: the likely cause is a backing index that went stale for a moment
    // (see the header), which the next store reload repairs.
    console.warn(`[FloatingRange] Could not read the content extent of ${frId}:`, err);
    if (!usedExtents.has(frId)) storeUsedExtent(frId, 0, 0);
    ledger.applied(frId, n);
  } finally {
    ledger.end(frId, n);
  }
}

/** Mark one range's extent stale (kept in force until the re-read lands). */
export function invalidateFrExtent(frId: string): void {
  ledger.invalidate(frId);
}

/** Mark every range's extent stale. */
export function invalidateAllFrExtents(): void {
  ledger.invalidateAll(usedExtents.keys());
}

/** Forget one range's extent (the object was deleted). */
export function removeFrExtent(frId: string): void {
  usedExtents.delete(frId);
  ledger.forget(frId);
}

/** Forget everything (document change, deactivate). */
export function resetFrExtents(): void {
  usedExtents.clear();
  ledger.reset();
}
