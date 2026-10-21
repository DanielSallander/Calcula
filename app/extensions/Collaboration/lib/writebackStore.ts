// FILENAME: app/extensions/Collaboration/lib/writebackStore.ts
// PURPOSE: The ONE frontend copy of the writeback region index and the
//          subscriber's writeback layer (drafts / submitted / approved /
//          rejected), shared by the guards, the grid outline and markers, the
//          Writeback pane and the contextual Writeback ribbon tab.
// CONTEXT: The guards and the painters run synchronously -- a keystroke, a
//          frame -- so they read this snapshot, never the backend. Everything
//          that can change it ends in `refreshWriteback()`, which re-reads,
//          notifies every subscriber and asks the grid to repaint, so a submit
//          or a discard can no longer leave the cells looking unsent.
//
//          KEYED BY SHEET ID, NEVER BY POSITION. Regions carry the LOCAL sheet
//          id (the backend maps the publisher's id through the subscription
//          ledger). The active sheet's id is resolved at CHECK time from the
//          grid's own `sheetContext.activeSheetIndex` (paint-time truth) and the
//          live sheet-id map in @api/reportPages, so inserting, moving or
//          reopening sheets cannot put the regions on the wrong tab. The
//          backend-computed `sheetIndex` is a fallback only for the moment
//          before the sheet list has been read.
//
//          A failed read keeps the previous snapshot and records the error, so
//          a transient IPC failure neither empties the grid's guards nor lets
//          the pane claim there are no regions.

import {
  getWritebackRegions,
  getWritebackLayer,
  reconcileWriteback,
  type WritebackRegionEntry,
  type WritebackSubmission,
} from "@api/collaboration";
import { getGridStateSnapshot } from "@api/grid";
import {
  startReportPages,
  getReportPagesSnapshot,
  onReportPagesChanged,
  reportPageById,
  sheetIdAt,
} from "@api/reportPages";
import { createCoalescedRefresh } from "@api/coalescedRefresh";
import { emitAppEvent, AppEvents } from "@api/events";
import { columnToLetter } from "@api/types";

/** Cell writeback status: not-yet-filled, local unsent edit, sent & awaiting
 * the publisher's decision, accepted, or rejected (needs revision). */
export type WritebackCellState =
  | "empty"
  | "draft"
  | "submitted"
  | "approved"
  | "rejected";

/** How a region's values leave the machine (mirrors the declaration). */
export type WritebackSubmissionPolicy = "immediate" | "on_submit" | "on_approval";

/** Who sees a subscriber's values (mirrors the declaration). */
export type WritebackVisibility = "own_only" | "own_plus_aggregate" | "transparent";

/** Everything the tab, the pane and the tooltips say about one region. */
export interface WritebackRegionSummary {
  regionId: string;
  /** The application the region belongs to ("" when the backend gave none). */
  applicationName: string;
  registryUrl?: string;
  /** LOCAL sheet id. */
  sheetId: string;
  /** The local sheet's current name, when the backend reports it. */
  sheetName?: string;
  /** The region's cells in A1 notation, e.g. "B3:B5". */
  rangeA1: string;
  /** Typed but not sent yet (a cleared cell is a pending retraction and counts). */
  draftCount: number;
  /** Sent, awaiting the publisher's decision. */
  submittedCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** Cells nothing has been entered into. */
  emptyCount: number;
  deadline?: string;
  visibility?: WritebackVisibility;
  submissionPolicy?: WritebackSubmissionPolicy;
  /** The raw index entry. */
  region: WritebackRegionEntry;
}

interface RegionCounts {
  draft: number;
  submitted: number;
  approved: number;
  rejected: number;
  touched: number;
}

// ---------------------------------------------------------------------------
// Internal state (replaced atomically by a successful read)
// ---------------------------------------------------------------------------

const EMPTY_REGIONS: readonly WritebackRegionEntry[] = Object.freeze([]);
const EMPTY_LAYER: readonly WritebackSubmission[] = Object.freeze([]);

let regions: readonly WritebackRegionEntry[] = EMPTY_REGIONS;
let regionsBySheetId = new Map<string, WritebackRegionEntry[]>();
let regionsBySheetIndex = new Map<number, WritebackRegionEntry[]>();
let layer: readonly WritebackSubmission[] = EMPTY_LAYER;
/** `regionId:row:col` -> the entry that decides the cell's state. */
let entryByCell = new Map<string, WritebackSubmission>();
let countsByRegion = new Map<string, RegionCounts>();
let loaded = false;
let lastError: string | null = null;
/** Why the last read could not reconcile with the workspace, or null. */
let lastReconcileError: string | null = null;
let version = 0;

const listeners = new Set<() => void>();

function cellKey(regionId: string, row: number, col: number): string {
  return `${regionId}:${row}:${col}`;
}

function inRegion(r: WritebackRegionEntry, row: number, col: number): boolean {
  return row >= r.rowStart && row <= r.rowEnd && col >= r.colStart && col <= r.colEnd;
}

/** Which of two entries for the same cell decides its state: an unsent draft
 *  first (it is what the user typed last), then the most recently updated. */
function decides(a: WritebackSubmission, b: WritebackSubmission): WritebackSubmission {
  if (a.state === "draft" && b.state !== "draft") return a;
  if (b.state === "draft" && a.state !== "draft") return b;
  return (b.updatedAt ?? "") > (a.updatedAt ?? "") ? b : a;
}

function apply(nextRegions: WritebackRegionEntry[], nextLayer: WritebackSubmission[]): void {
  const bySheet = new Map<string, WritebackRegionEntry[]>();
  const byIndex = new Map<number, WritebackRegionEntry[]>();
  for (const r of nextRegions) {
    if (r.sheetId) {
      const list = bySheet.get(r.sheetId);
      if (list) list.push(r);
      else bySheet.set(r.sheetId, [r]);
    }
    if (typeof r.sheetIndex === "number") {
      const list = byIndex.get(r.sheetIndex);
      if (list) list.push(r);
      else byIndex.set(r.sheetIndex, [r]);
    }
  }
  const byCell = new Map<string, WritebackSubmission>();
  for (const d of nextLayer) {
    const key = cellKey(d.regionId, d.cellRow, d.cellCol);
    const prev = byCell.get(key);
    byCell.set(key, prev ? decides(prev, d) : d);
  }
  const counts = new Map<string, RegionCounts>();
  const regionById = new Map(nextRegions.map((r) => [r.regionId, r] as const));
  for (const d of byCell.values()) {
    const r = regionById.get(d.regionId);
    if (!r || !inRegion(r, d.cellRow, d.cellCol)) continue;
    let c = counts.get(d.regionId);
    if (!c) {
      c = { draft: 0, submitted: 0, approved: 0, rejected: 0, touched: 0 };
      counts.set(d.regionId, c);
    }
    c.touched++;
    if (d.state === "draft") c.draft++;
    else if (d.state === "submitted") c.submitted++;
    else if (d.state === "approved") c.approved++;
    else if (d.state === "rejected") c.rejected++;
  }
  regions = Object.freeze([...nextRegions]);
  regionsBySheetId = bySheet;
  regionsBySheetIndex = byIndex;
  layer = Object.freeze([...nextLayer]);
  entryByCell = byCell;
  countsByRegion = counts;
}

function notify(): void {
  version++;
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (err) {
      console.error("[writebackStore] a snapshot listener threw:", err);
    }
  }
}

/** Ask the grid to repaint so outlines and markers follow the snapshot. */
function requestRepaint(): void {
  try {
    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.warn("[writebackStore] repaint request failed:", err);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function read(stillCurrent: () => boolean): Promise<void> {
  let nextRegions: WritebackRegionEntry[];
  try {
    nextRegions = await getWritebackRegions();
  } catch (err) {
    if (!stillCurrent()) return;
    lastError = `Could not read the writeback regions: ${errorText(err)}`;
    console.warn("[writebackStore]", lastError);
    notify();
    requestRepaint();
    return;
  }
  let nextLayer: WritebackSubmission[] | null = null;
  let layerError: string | null = null;
  let reconcileError: string | null = null;
  try {
    // Reconcile first so cell states reflect the publisher's approve/reject
    // decisions (the return leg). An offline workspace is normal, so a failed
    // reconcile falls back to the local layer without a READ error -- but the
    // reason is kept, so Check Status can say it could not reach the
    // workspace without asking it a second time.
    nextLayer = (await reconcileWriteback()).drafts;
  } catch (err) {
    reconcileError = errorText(err);
    try {
      nextLayer = (await getWritebackLayer()).drafts;
    } catch (err) {
      layerError = `Could not read your writeback values: ${errorText(err)}`;
    }
  }
  if (!stillCurrent()) return;
  apply(nextRegions, nextLayer ?? [...layer]);
  loaded = true;
  lastError = layerError;
  lastReconcileError = reconcileError;
  if (layerError) console.warn("[writebackStore]", layerError);
  notify();
  requestRepaint();
}

const refresher = createCoalescedRefresh(read);

/**
 * Re-read the region index and the writeback layer, then notify every
 * subscriber and request a grid repaint. Never rejects: a failure is kept in
 * {@link getWritebackRefreshError} and the previous snapshot stays in force.
 * Requests made while one is pending share it. Call it after ANY submit,
 * discard, reconcile, subscribe, refresh, detach or reset.
 */
export function refreshWriteback(): Promise<void> {
  return refresher.request();
}

/** Await the refresh already answering for a change the caller just made, or
 *  start one. Same guarantees as {@link refreshWriteback}. */
export function joinWritebackRefresh(): Promise<void> {
  return refresher.join();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start following the sheet-id map the active-sheet lookup needs. A change in
 * it (a sheet added, moved, renamed, a pull) re-derives every consumer and
 * repaints. Returns the stop function.
 */
export function startWritebackStore(): () => void {
  const stopPages = startReportPages();
  const offPages = onReportPagesChanged(() => {
    if (regions.length === 0) return;
    notify();
    requestRepaint();
  });
  return () => {
    offPages();
    stopPages();
  };
}

/** Clear the snapshot (deactivation). Abandons any read in flight. */
export function resetWritebackSnapshot(): void {
  refresher.invalidate();
  regions = EMPTY_REGIONS;
  regionsBySheetId = new Map();
  regionsBySheetIndex = new Map();
  layer = EMPTY_LAYER;
  entryByCell = new Map();
  countsByRegion = new Map();
  loaded = false;
  lastError = null;
  lastReconcileError = null;
  notify();
}

// ---------------------------------------------------------------------------
// Subscription (useSyncExternalStore-shaped)
// ---------------------------------------------------------------------------

/** Called after every refresh, reset and sheet-map change. Returns unsubscribe. */
export function subscribeWritebackSnapshot(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Bumped on every notification: a snapshot comparison is one number. */
export function getWritebackSnapshotVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every region in the index (all sheets). */
export function getWritebackRegionList(): readonly WritebackRegionEntry[] {
  return regions;
}

/** The subscriber's writeback layer as last read (every state). */
export function getWritebackLayerEntries(): readonly WritebackSubmission[] {
  return layer;
}

/** Whether the index has any region. */
export function hasWritebackRegions(): boolean {
  return regions.length > 0;
}

/** True once a read has succeeded since activation/reset. */
export function isWritebackSnapshotLoaded(): boolean {
  return loaded;
}

/** The last read's failure, in user words, or null. */
export function getWritebackRefreshError(): string | null {
  return lastError;
}

/**
 * Why the last read could not reconcile with the workspace (the local layer
 * was shown instead), or null when it reconciled. Every read reconciles, so a
 * caller that wants fresh review decisions calls {@link refreshWriteback} and
 * reads this -- it never needs a reconcile of its own.
 */
export function getWritebackReconcileError(): string | null {
  return lastReconcileError;
}

/** Regions on the sheet with this LOCAL id. */
export function getRegionsOnSheet(sheetId: string): readonly WritebackRegionEntry[] {
  return regionsBySheetId.get(sheetId) ?? EMPTY_REGIONS;
}

/** The region covering a cell of the sheet with this LOCAL id, or null. */
export function getRegionAt(
  sheetId: string,
  row: number,
  col: number,
): WritebackRegionEntry | null {
  const list = regionsBySheetId.get(sheetId);
  if (!list) return null;
  for (const r of list) {
    if (inRegion(r, row, col)) return r;
  }
  return null;
}

/**
 * The ACTIVE sheet's local id, resolved now: the grid's active index (its
 * paint-time truth) through the live sheet-id map. Null when the sheet list
 * has not been read yet or the grid is not mounted.
 */
export function getActiveSheetId(): string | null {
  const index = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  return sheetIdAt(getReportPagesSnapshot(), index);
}

/**
 * The regions on the ACTIVE sheet. Empty on a canvas page (layers and
 * decorations run there too). Before the sheet list has been read, falls back
 * to the backend's index computed at the last refresh.
 */
export function getActiveSheetRegions(): readonly WritebackRegionEntry[] {
  if (regions.length === 0) return EMPTY_REGIONS;
  const state = getGridStateSnapshot();
  if (!state) return EMPTY_REGIONS;
  if (state.surface === "canvas") return EMPTY_REGIONS;
  const index = state.sheetContext?.activeSheetIndex;
  const id = sheetIdAt(getReportPagesSnapshot(), index);
  if (id) return regionsBySheetId.get(id) ?? EMPTY_REGIONS;
  if (typeof index !== "number") return EMPTY_REGIONS;
  return regionsBySheetIndex.get(index) ?? EMPTY_REGIONS;
}

/** The region covering a cell of the ACTIVE sheet, or null. */
export function getActiveRegionAt(row: number, col: number): WritebackRegionEntry | null {
  for (const r of getActiveSheetRegions()) {
    if (inRegion(r, row, col)) return r;
  }
  return null;
}

/** The cell state of a cell inside a known region (O(1)). */
export function getCellStateInRegion(
  region: WritebackRegionEntry,
  row: number,
  col: number,
): WritebackCellState {
  const entry = entryByCell.get(cellKey(region.regionId, row, col));
  return entry ? entry.state : "empty";
}

/** The layer entry deciding a cell's state, or null when nothing was entered. */
export function getCellEntry(
  regionId: string,
  row: number,
  col: number,
): WritebackSubmission | null {
  return entryByCell.get(cellKey(regionId, row, col)) ?? null;
}

/** The writeback state of a cell of the sheet with this LOCAL id; null when the
 *  cell is in no region. */
export function getWritebackCellStateAt(
  sheetId: string,
  row: number,
  col: number,
): WritebackCellState | null {
  const region = getRegionAt(sheetId, row, col);
  return region ? getCellStateInRegion(region, row, col) : null;
}

/** The writeback state of a cell of the ACTIVE sheet; null outside regions. */
export function getActiveCellState(row: number, col: number): WritebackCellState | null {
  const region = getActiveRegionAt(row, col);
  return region ? getCellStateInRegion(region, row, col) : null;
}

/** Whether a range of the ACTIVE sheet overlaps any region. */
export function activeRangeOverlapsWriteback(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): WritebackRegionEntry | null {
  for (const r of getActiveSheetRegions()) {
    if (startRow <= r.rowEnd && endRow >= r.rowStart && startCol <= r.colEnd && endCol >= r.colStart) {
      return r;
    }
  }
  return null;
}

/** A region's cells in A1 notation ("B3:B5", or "B3" for one cell). */
export function regionRangeA1(r: {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}): string {
  const tl = `${columnToLetter(r.colStart)}${r.rowStart + 1}`;
  const br = `${columnToLetter(r.colEnd)}${r.rowEnd + 1}`;
  return tl === br ? tl : `${tl}:${br}`;
}

/** The name a user knows the region's application by. */
export function regionApplicationName(r: WritebackRegionEntry): string {
  return r.packageName ?? "";
}

function summarize(r: WritebackRegionEntry): WritebackRegionSummary {
  const c = countsByRegion.get(r.regionId);
  const cells = (r.rowEnd - r.rowStart + 1) * (r.colEnd - r.colStart + 1);
  return {
    regionId: r.regionId,
    applicationName: regionApplicationName(r),
    registryUrl: r.registryUrl,
    sheetId: r.sheetId,
    // The LIVE name: a rename does not re-read the snapshot, but it does
    // change the sheet-id map (which re-notifies), so this follows it.
    sheetName: reportPageById(getReportPagesSnapshot(), r.sheetId)?.name || r.sheetName || undefined,
    rangeA1: regionRangeA1(r),
    draftCount: c?.draft ?? 0,
    submittedCount: c?.submitted ?? 0,
    approvedCount: c?.approved ?? 0,
    rejectedCount: c?.rejected ?? 0,
    emptyCount: Math.max(0, cells - (c?.touched ?? 0)),
    deadline: r.deadline,
    visibility: (r.visibility ?? undefined) as WritebackVisibility | undefined,
    submissionPolicy: (r.submissionPolicy ?? undefined) as WritebackSubmissionPolicy | undefined,
    region: r,
  };
}

/** One region's summary, or null when it is not in the index. */
export function getRegionSummary(regionId: string): WritebackRegionSummary | null {
  const r = regions.find((x) => x.regionId === regionId);
  return r ? summarize(r) : null;
}

/** Every region's summary, in index order. */
export function listRegionSummaries(): WritebackRegionSummary[] {
  return regions.map(summarize);
}

/** Unsent drafts across every region in the index (orphans excluded). */
export function totalUnsentDrafts(): number {
  let n = 0;
  for (const c of countsByRegion.values()) n += c.draft;
  return n;
}

/** Unsent drafts in the regions on the sheet with this LOCAL id (what a
 *  detach of that sheet would throw away). */
export function unsentDraftsOnSheet(sheetId: string): number {
  let n = 0;
  for (const r of regionsBySheetId.get(sheetId) ?? EMPTY_REGIONS) {
    n += countsByRegion.get(r.regionId)?.draft ?? 0;
  }
  return n;
}

/**
 * A CONTENT key for a region list: equal keys mean the same regions in the
 * same places with the same checks. Every read installs a new array, so
 * identity says nothing; consumers that do real work per region list (the
 * validator realms, the script host's index copy) compare this instead.
 */
export function writebackRegionListKey(list: readonly WritebackRegionEntry[]): string {
  return list
    .map((r) =>
      JSON.stringify([
        r.regionId,
        r.sheetId,
        r.sheetIndex,
        r.rowStart,
        r.rowEnd,
        r.colStart,
        r.colEnd,
        r.valueType ?? null,
        r.customValidator ?? null,
        r.packageName ?? null,
      ]),
    )
    .join("\n");
}
