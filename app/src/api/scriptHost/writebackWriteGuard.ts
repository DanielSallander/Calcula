//! FILENAME: app/src/api/scriptHost/writebackWriteGuard.ts
// PURPOSE: Close the DRAFT-CAPTURE BYPASS. A .calp writeback region is the
//          publisher's input form: a human typing into one never writes the grid
//          directly — the Distribution extension's commit guard intercepts the
//          keystroke, coerces the value to the region's DECLARED type, runs the
//          publisher's advisory validator, saves a schema-validated draft
//          through calp_save_writeback_draft, and only then returns
//          `action: "allow"` so the cell displays what was drafted.
//
//          A SCRIPT bypassed all of that. `api.setCellValue` -> `lib.updateCell`
//          is a different door: the commit guard is an editor-commit hook, so a
//          script write into a claimed cell produced NO draft, skipped the
//          schema, skipped the lifecycle deadline, skipped the one-shot/locked
//          rules — and left the grid showing a value the writeback layer had
//          never heard of and would never submit.
//
// THE FIX IS ROUTE, NOT REFUSE (option (a)). Refusing with "use
// caps.writeback.saveDraft" would have been simpler, but it weakens the
// product for no security gain: the authoritative draft gate is Rust-side, so
// routing the write THROUGH it gives a script exactly the human's path with
// exactly the human's constraints — and gives the script author the obvious
// thing (`setCellValue`) instead of a trap. What a script gains over a human is
// nothing; what it loses is the ability to write a writeback cell without the
// publisher's rules being applied.
//
// HOW IT WORKS
//   1. This module keeps a cached copy of the workbook's PUBLISHED writeback
//      region index (calp_get_writeback_regions — trusted host call, no
//      capability involved). The common workbook has none, so the whole guard
//      costs one already-cached array lookup per write.
//   2. A write that lands inside a region is handed to the Rust
//      `script_writeback` gateway, action `cellGuard`. That call coerces by the
//      region's declared type and calls the real calp_save_writeback_draft —
//      the same function the interactive guard calls. It ALSO re-checks the
//      `distribution.writeback` grant, so a script without consent gets a
//      PermissionDenied instead of a silent write.
//   3. A rejection (no grant, schema violation, expired lifecycle) propagates
//      verbatim and the grid write does NOT happen.
//   4. A success returns `draftSaved: true` and the caller writes the cell, so
//      the grid shows the drafted value — exactly what `action: "allow"` does.
//
// FAIL-CLOSED BY CONSTRUCTION: this cache is an OPTIMIZATION, never the gate.
// If it is stale in the dangerous direction (a region appeared since the last
// refresh) the host skips the cellGuard call and the write reaches Rust's
// `ensure_writeback_draft_before_write` backstop, which refuses any write into
// a claimed cell that has no draft behind it. Stale in the harmless direction
// (a region disappeared) costs one extra round trip that answers
// `inRegion: false`.

import { AppEvents, onAppEvent } from "../events";
import {
  getWritebackRegions,
  WRITEBACK_INDEX_CHANGED_EVENT,
  type WritebackRegionEntry,
} from "../distribution";

/** One grid write a script asked for, already resolved to a concrete sheet. */
export interface ScriptCellWrite {
  sheetIndex: number;
  row: number;
  col: number;
  value: string;
}

/** What the guard decided about a set of writes. */
export interface WritebackWriteSplit {
  /** Not claimed by any writeback region — write them the normal way. */
  plain: ScriptCellWrite[];
  /**
   * Captured as schema-validated writeback drafts. These must STILL be written
   * to the grid so the cell displays the drafted value — but ONE AT A TIME:
   * `update_cells_batch` drops writeback cells outright (partial-success
   * semantics in commands/data.rs), so putting them in a batch would save the
   * draft and then show the user nothing.
   */
  drafted: ScriptCellWrite[];
}

// ---------------------------------------------------------------------------
// Region index cache
// ---------------------------------------------------------------------------

let regions: WritebackRegionEntry[] = [];
let loaded = false;
let inflight: Promise<void> | null = null;
let listenersWired = false;

/** Bumped on every invalidation so a load that was already in flight when the
 *  index changed cannot land its now-stale answer on top of the new one. */
let generation = 0;

/** Forget the cached index; the next guarded write reloads it. */
export function invalidateWritebackIndex(): void {
  loaded = false;
  regions = [];
  generation++;
  inflight = null;
}

/** Test seam: install a known index without touching the backend. */
export function __setWritebackIndexForTests(entries: WritebackRegionEntry[] | null): void {
  if (entries === null) {
    invalidateWritebackIndex();
    return;
  }
  regions = entries;
  loaded = true;
  inflight = null;
}

function wireInvalidation(): void {
  if (listenersWired) return;
  listenersWired = true;
  // A different workbook has a different (usually empty) set of regions.
  onAppEvent(AppEvents.AFTER_OPEN, invalidateWritebackIndex);
  onAppEvent(AppEvents.AFTER_NEW, invalidateWritebackIndex);
  onAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, invalidateWritebackIndex);
}

async function ensureIndex(): Promise<void> {
  wireInvalidation();
  if (loaded) return;
  if (inflight) return inflight;
  const gen = generation;
  inflight = (async () => {
    try {
      const fetched = await getWritebackRegions();
      if (gen !== generation) return; // invalidated mid-flight — drop the answer
      regions = fetched;
      loaded = true;
    } catch {
      // No .calp subscription loaded, or the command is unavailable. Treat it
      // as "no regions" — the Rust backstop still refuses a claimed write.
      if (gen !== generation) return;
      regions = [];
      loaded = true;
    } finally {
      if (gen === generation) inflight = null;
    }
  })();
  return inflight;
}

/**
 * Whether this workbook has ANY published writeback region. Callers use it to
 * skip work that only matters when one exists (resolving the active sheet for
 * a sheet-less write); it is never a substitute for the guard itself.
 */
export async function workbookHasWritebackRegions(): Promise<boolean> {
  await ensureIndex();
  return regions.length > 0;
}

function regionAt(sheetIndex: number, row: number, col: number): WritebackRegionEntry | null {
  for (const r of regions) {
    if (
      r.sheetIndex === sheetIndex &&
      row >= r.rowStart && row <= r.rowEnd &&
      col >= r.colStart && col <= r.colEnd
    ) {
      return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** The gateway's answer for one cell (mirrors WritebackCellGuard in Rust). */
interface CellGuardResult {
  inRegion: boolean;
  regionId?: string;
  valueType?: string;
  draftSaved: boolean;
}

/**
 * Route every write that lands in a writeback region through the authoritative
 * draft gate, and report which writes were captured.
 *
 * Throws (with the backend's verbatim message) when a claimed cell cannot be
 * drafted: no `distribution.writeback` grant, a schema violation, a closed
 * lifecycle, a locked one-shot region. The caller must NOT write those cells.
 *
 * @param scriptId  the AUTHORITATIVE script identity from the mount handle —
 *                  never anything the worker supplied.
 */
export async function captureWritebackWrites(
  scriptId: string,
  writes: readonly ScriptCellWrite[],
): Promise<WritebackWriteSplit> {
  if (writes.length === 0) return { plain: [], drafted: [] };
  await ensureIndex();
  if (regions.length === 0) return { plain: [...writes], drafted: [] };

  const plain: ScriptCellWrite[] = [];
  const drafted: ScriptCellWrite[] = [];
  const { invokeBackend } = await import("../backend");

  for (const w of writes) {
    const region = regionAt(w.sheetIndex, w.row, w.col);
    if (!region) {
      plain.push(w);
      continue;
    }
    // `sheetId` is passed EXPLICITLY (the region's own stable SheetId) rather
    // than omitted: omitting it asks about the ACTIVE sheet, which is the wrong
    // question for an off-sheet write like updateCellOnSheets.
    const result = await invokeBackend<CellGuardResult>("script_writeback", {
      scriptId,
      action: "cellGuard",
      payload: { row: w.row, col: w.col, value: w.value, sheetId: region.sheetId },
    });
    if (result?.draftSaved) {
      drafted.push(w);
    } else if (result?.inRegion) {
      // Claimed but not drafted: the gateway declined without raising. Never
      // fall through to a raw grid write — that is the exact bypass this
      // module exists to close.
      throw new Error(
        `Cell (${w.row}, ${w.col}) belongs to writeback region ${result.regionId ?? region.regionId}` +
          " and could not be saved as a draft; use context.caps.writeback.saveDraft() to fill it in.",
      );
    } else {
      // The index was stale in the harmless direction — the region is gone.
      plain.push(w);
    }
  }
  return { plain, drafted };
}

/**
 * Single-cell convenience: returns true when the value was captured as a
 * writeback draft (the caller still writes the grid so the cell displays it),
 * false when the cell is not a writeback cell at all.
 */
export async function captureWritebackWrite(
  scriptId: string,
  write: ScriptCellWrite,
): Promise<boolean> {
  const { drafted } = await captureWritebackWrites(scriptId, [write]);
  return drafted.length > 0;
}
