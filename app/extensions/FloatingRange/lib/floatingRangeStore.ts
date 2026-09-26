//! FILENAME: app/extensions/FloatingRange/lib/floatingRangeStore.ts
// PURPOSE: Frontend row store for floating ranges + overlay-region sync.
// CONTEXT: Modeled on Charts/lib/chartStore.ts (NOT the anchor-derived Controls
//          model): the store holds ALL sheets' entries; syncFloatingRangeRegions
//          filters by the active sheet (the sheet-blind-regions hazard), and
//          geometry drags persist through a 300 ms debounced update_floating_range.
//          toEntry/fromEntry normalization happens at the single backend
//          boundary — never an `as`-cast of a foreign blob.

import {
  replaceGridRegionsByType,
  removeGridRegionsByType,
  type GridRegion,
} from "@api/gridOverlays";
import {
  listFloatingRanges,
  updateFloatingRange,
  type FloatingRangeInfo,
} from "@api/floatingRanges";
import { getDesignMode } from "@api/designMode";
import { showToast } from "@api/notifications";
import { frameWidth, frameHeight } from "./frDimensions";
import { clearFrScroll, resetFrScrolls } from "./frScroll";

// ============================================================================
// Entry model
// ============================================================================

/** The store's normalized row. Frame width/height are DERIVED, never stored. */
export interface FloatingRangeEntry {
  /** EntityId uuid. */
  id: string;
  /** Host sheet's live index — the region filter key. */
  sheetIndex: number;
  /**
   * Backing sheet's live index — CELL_VALUES_CHANGED filtering, and ONE
   * read-only query: the used-range read that sizes the scrollable content
   * extent (frExtent.ts). Never for addressing a cell: every cell read and
   * write is id-addressed and resolved in the backend. That is also why the
   * extent read is safe with an index that went stale for a moment (a sheet
   * added or deleted before the next reload): the worst it can do is give the
   * scroll range a wrong size until the store re-reads its rows.
   */
  backingSheetIndex: number;
  /** SheetIds carried through so the provider can hand back full infos. */
  hostSheetId: string;
  backingSheetId: string;
  name: string;
  x: number;
  y: number;
  /** RESERVED — always 0 in v1, persisted, never rendered. */
  angle: number;
  /** RESERVED — always false in v1. */
  pinToGrid: boolean;
  rows: number;
  cols: number;
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  /** Frame chrome (see frDimensions: the frame size DERIVES from these). */
  showTitle: boolean;
  showColumnHeaders: boolean;
  showRowHeaders: boolean;
}

/** Overlay region type — matches the registerGridOverlay registration. */
export const FLOATING_RANGE_REGION_TYPE = "floating-range";

/** Region id prefix ("fr-" + EntityId). */
export const FR_REGION_ID_PREFIX = "fr-";

// ============================================================================
// Normalization at the backend boundary
// ============================================================================

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function normalizeSizeMap(value: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const idx = Number(k);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        typeof v === "number" &&
        isFinite(v) &&
        v > 0
      ) {
        out[idx] = v;
      }
    }
  }
  return out;
}

/**
 * THE ONLY PLACE a backend FloatingRangeInfo becomes a store entry, and
 * therefore the only place the entry type's promises can be made true (the
 * chartStore fromEntry rule). Counts clamp to >= 1, geometry to finite >= 0,
 * size maps to positive finite numbers keyed by non-negative integers.
 */
export function fromInfo(info: FloatingRangeInfo): FloatingRangeEntry {
  return {
    id: String(info.id),
    sheetIndex: Math.max(0, Math.trunc(finiteNumber(info.hostSheetIndex, 0))),
    backingSheetIndex: Math.max(
      0,
      Math.trunc(finiteNumber(info.backingSheetIndex, 0)),
    ),
    hostSheetId: String(info.hostSheetId ?? ""),
    backingSheetId: String(info.backingSheetId ?? ""),
    name: typeof info.name === "string" && info.name.length > 0 ? info.name : "Float",
    x: Math.max(0, finiteNumber(info.x, 0)),
    y: Math.max(0, finiteNumber(info.y, 0)),
    angle: finiteNumber(info.rotation, 0),
    pinToGrid: info.pinToGrid === true,
    rows: Math.max(1, Math.trunc(finiteNumber(info.rowCount, 1))),
    cols: Math.max(1, Math.trunc(finiteNumber(info.colCount, 1))),
    colWidths: normalizeSizeMap(info.colWidths),
    rowHeights: normalizeSizeMap(info.rowHeights),
    // `!== false`, not `=== true`: the backend defaults these to true, so an
    // info that predates the field (or a hand-built test double) must land on
    // SHOWN. `Boolean(undefined)` would silently strip every FR's chrome.
    showTitle: info.showTitle !== false,
    showColumnHeaders: info.showColumnHeaders !== false,
    showRowHeaders: info.showRowHeaders !== false,
  };
}

/** Entry -> wire shape (for the provider seam's list()). */
export function toInfo(entry: FloatingRangeEntry): FloatingRangeInfo {
  return {
    id: entry.id,
    backingSheetId: entry.backingSheetId,
    hostSheetId: entry.hostSheetId,
    x: entry.x,
    y: entry.y,
    rotation: entry.angle,
    pinToGrid: entry.pinToGrid,
    rowCount: entry.rows,
    colCount: entry.cols,
    colWidths: { ...entry.colWidths },
    rowHeights: { ...entry.rowHeights },
    showTitle: entry.showTitle,
    showColumnHeaders: entry.showColumnHeaders,
    showRowHeaders: entry.showRowHeaders,
    name: entry.name,
    backingSheetIndex: entry.backingSheetIndex,
    hostSheetIndex: entry.sheetIndex,
  };
}

// ============================================================================
// Store state
// ============================================================================

let entries: FloatingRangeEntry[] = [];

/** Active sheet index used for filtering which FRs publish overlay regions. */
let activeSheetIndex = 0;

export function setFrActiveSheetIndex(sheetIndex: number): void {
  activeSheetIndex = sheetIndex;
}

export function getFrActiveSheetIndex(): number {
  return activeSheetIndex;
}

export function getAllFloatingRanges(): FloatingRangeEntry[] {
  return [...entries];
}

export function getFloatingRangeById(id: string): FloatingRangeEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

/** Region id ("fr-<uuid>") -> entry. */
export function getFloatingRangeByRegionId(
  regionId: string,
): FloatingRangeEntry | null {
  if (!regionId.startsWith(FR_REGION_ID_PREFIX)) return null;
  return getFloatingRangeById(regionId.slice(FR_REGION_ID_PREFIX.length));
}

/** Insert or replace the entry for a backend info (create / resize / rename). */
export function upsertFromInfo(info: FloatingRangeInfo): FloatingRangeEntry {
  const entry = fromInfo(info);
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  return entry;
}

export function removeFloatingRange(id: string): void {
  entries = entries.filter((e) => e.id !== id);
  dirtyIds.delete(id);
  // The session scroll is side state keyed by this id (frScroll.ts): it goes
  // with the row, or a later range reusing nothing but the id would inherit it.
  clearFrScroll(id);
}

// ============================================================================
// Debounced geometry persistence (drag fires many times per second)
// ============================================================================

const dirtyIds = new Set<string>();
let saveTimer: number | null = null;
/**
 * The flush that is running (or resolved). Flushes are SERIALISED through it,
 * so a manual flush that finds nothing dirty still waits for a timer-driven
 * one whose write is in flight: "flushed" means "landed" -- the canvas's one-
 * undo-step group drag and arrange commit their transaction only after it.
 */
let flushInFlight: Promise<unknown> = Promise.resolve();

function scheduleSave(id: string): void {
  dirtyIds.add(id);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void runFlush(true);
  }, 300);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Put the refused ranges back where the backend has them. Only their
 * positions, and only from a successful re-read: a failed read must not wipe
 * the store (a transient IPC error is not "no floating ranges").
 */
async function revertPositions(ids: readonly string[]): Promise<void> {
  try {
    const infos = await listFloatingRanges();
    const refused = new Set(ids);
    for (const info of infos) {
      const stored = fromInfo(info);
      if (!refused.has(stored.id)) continue;
      const entry = getFloatingRangeById(stored.id);
      if (!entry) continue;
      entry.x = stored.x;
      entry.y = stored.y;
    }
  } catch (err) {
    console.error("[FloatingRange] Could not re-read the refused ranges' positions:", err);
  }
  syncFloatingRangeRegions();
}

/**
 * Write every dirty position. A refused write (a protected sheet) is not left
 * standing: the range goes back to where the backend has it. Resolves the
 * refusal reasons; with `report` the user is told once, otherwise the caller
 * reports them (the object-geometry seam: one toast for a whole arrange).
 */
async function flushDirty(report: boolean): Promise<string[]> {
  const ids = Array.from(dirtyIds);
  dirtyIds.clear();
  const reasons: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const entry = getFloatingRangeById(id);
    if (!entry) continue;
    try {
      await updateFloatingRange(id, { x: entry.x, y: entry.y });
    } catch (err) {
      console.error(`[FloatingRange] The backend refused the position of range ${id}:`, err);
      refused.push(id);
      reasons.push(describeError(err));
    }
  }
  if (refused.length > 0) {
    await revertPositions(refused);
    if (report) {
      const unique = Array.from(new Set(reasons.filter((r) => r !== "")));
      showToast(`The floating range could not be moved. ${unique.join(" ")}`.trim(), {
        type: "error",
        duration: 8000,
      });
    }
  }
  return reasons;
}

/** Run a flush after any flush already in flight. */
function runFlush(report: boolean): Promise<string[]> {
  const run = flushInFlight.then(() => flushDirty(report));
  flushInFlight = run.catch(() => undefined);
  return run;
}

/**
 * Flush any pending debounced geometry saves immediately. Called on
 * BEFORE_SAVE so a drag finished 100 ms before Ctrl+S is in the file. Also
 * waits for a flush already in flight.
 */
export async function flushPendingFloatingRangeSaves(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyIds.size === 0) {
    await flushInFlight;
    return;
  }
  await runFlush(true);
}

/**
 * Flush pending saves WITHOUT telling the user about a refusal (the refused
 * range is still put back); resolves the refusal reasons for the caller to
 * report -- the object-geometry provider's commit.
 */
export async function flushPendingFloatingRangeSavesQuietly(): Promise<string[]> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyIds.size === 0) {
    await flushInFlight;
    return [];
  }
  return runFlush(false);
}

/**
 * Show a range at a new position WITHOUT persisting it (no save scheduled):
 * the canvas nudge previews every keystroke of a burst this way and commits
 * once. Returns false when no range has that id.
 */
export function previewFloatingRangePosition(id: string, x: number, y: number): boolean {
  const entry = getFloatingRangeById(id);
  if (!entry) return false;
  entry.x = Math.max(0, x);
  entry.y = Math.max(0, y);
  return true;
}

/** Move (store + debounced persist). Used by movePreview AND moveComplete —
 *  the debounce coalesces the stream into one backend write. */
export function moveFloatingRange(id: string, x: number, y: number): void {
  const entry = getFloatingRangeById(id);
  if (!entry) return;
  entry.x = Math.max(0, x);
  entry.y = Math.max(0, y);
  scheduleSave(id);
}

// ============================================================================
// Load / reset
// ============================================================================

/** Load all floating ranges from the backend into the store. */
export async function loadFloatingRangesFromBackend(): Promise<void> {
  try {
    const infos = await listFloatingRanges();
    entries = infos.map(fromInfo);
  } catch {
    // Fresh app / backend not ready: start empty.
    entries = [];
  }
}

/**
 * Reset the store (File > New/Open, deactivation). The session scroll side map
 * goes with it: a new document starts every range unscrolled. A plain reload
 * (`loadFloatingRangesFromBackend`) deliberately does NOT touch it.
 */
export function resetFloatingRangeStore(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirtyIds.clear();
  flushInFlight = Promise.resolve();
  entries = [];
  activeSheetIndex = 0;
  resetFrScrolls();
  removeGridRegionsByType(FLOATING_RANGE_REGION_TYPE);
}

// ============================================================================
// Grid overlay sync
// ============================================================================

/**
 * Publish overlay regions for the ACTIVE sheet's floating ranges (atomically —
 * replaceGridRegionsByType, one listener notification). Frame size is derived
 * here, never read from anywhere else.
 *
 * MOVE/RESIZE ARE DESIGN-MODE ACTS, the BUTTON rule rather than the shape
 * rule (owner decision 2026-08-13): in run mode a floating range is a working
 * surface — its cells select and edit — and a drag that relocates it is
 * layout work. Core consults `data.movable`/`data.resizable` before starting
 * either gesture, so gating the flags here gates the whole interaction; the
 * DESIGN_MODE_CHANGED_EVENT listener in index.ts re-syncs so a toggle takes
 * effect on the spot. Cell interaction (claimsBodyDrag over the cell area)
 * stays live in both modes, exactly as a button still CLICKS in run mode.
 */
export function syncFloatingRangeRegions(): void {
  const visible = entries.filter((e) => e.sheetIndex === activeSheetIndex);
  const designing = getDesignMode();

  const regions: GridRegion[] = visible.map((entry) => ({
    id: `${FR_REGION_ID_PREFIX}${entry.id}`,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: {
      x: entry.x,
      y: entry.y,
      width: frameWidth(entry),
      height: frameHeight(entry),
    },
    data: {
      frId: entry.id,
      name: entry.name,
      rows: entry.rows,
      cols: entry.cols,
      movable: designing,
      resizable: designing,
      // On a canvas the frame's POSITION snaps to the layout grid like every
      // object's, but its SIZE is whole rows and columns (quantised by this
      // extension on resize): a second, pixel-grid snap on top would make most
      // row/column counts unreachable. Core honours this for resize only.
      snapResize: false,
    },
  }));

  replaceGridRegionsByType(FLOATING_RANGE_REGION_TYPE, regions);
}
