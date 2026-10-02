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
  requestOverlayRedraw,
  type GridRegion,
} from "@api/gridOverlays";
import {
  listFloatingRanges,
  updateFloatingRange,
  type FloatingRangeInfo,
} from "@api/floatingRanges";
import { getDesignMode, onDesignModeChange } from "@api/designMode";
import {
  getLayoutSurface,
  objectGeometryEditable,
  onLayoutSurfaceChanged,
} from "@api/layoutSurface";
import { isObjectInSelection, onObjectSelectionChanged } from "@api/objectSelection";
import { showToast } from "@api/notifications";
import { frameWidth, frameHeight } from "./frDimensions";
import { clearFrScroll, resetFrScrolls } from "./frScroll";
import { isFloatingRangeSelected } from "./frSelection";
import { getFrEditingRange, onFrEditingRangeChanged } from "./frEditingRange";

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

/**
 * Move (store + debounced persist). The COMMIT of a position: a pointer drag
 * calls it once, at moveComplete (its preview frames go through
 * `previewFloatingRangePosition`, which writes nothing), and the object-
 * geometry seam's commit calls it once per range. Persisting preview frames
 * made a human drag that paused for longer than the debounce several
 * "Move floating range" undo steps.
 */
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

// ============================================================================
// Editability — THE one per-range answer every geometry door reads
// ============================================================================

/** The region a range publishes, WITHOUT its flags (the lock asks by region). */
function baseRegionOf(entry: FloatingRangeEntry): GridRegion {
  return {
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
    },
  };
}

/**
 * Whether the range's POSITION and SIZE may change (owner decision
 * 2026-09-27): on a layout surface the surface decides -- editable (not a
 * subscribed canvas) and the range not locked there -- and on a worksheet it
 * always may. Design Mode is never part of it.
 */
function geometryEditableFor(entry: FloatingRangeEntry, region: GridRegion): boolean {
  return objectGeometryEditable(entry.sheetIndex, region, true);
}

/**
 * THE one per-range geometry answer: the published `movable` flag, the menu's
 * Add/Delete Row/Column items, the Properties dialog's size and chrome
 * controls, the edge-handle cell scaling and the script provider's `resize`
 * all read it. False for an unknown id.
 */
export function frGeometryEditable(id: string): boolean {
  const entry = getFloatingRangeById(id);
  if (!entry) return false;
  return geometryEditableFor(entry, baseRegionOf(entry));
}

/**
 * Whether the range may be AUTHORED at all -- its object menu opens, it can
 * be renamed or deleted: its sheet is editable (a worksheet, or a canvas that
 * is not subscribed). A LOCK freezes geometry only, so a locked range still
 * answers true here and false from `frGeometryEditable`.
 */
export function frObjectEditable(id: string): boolean {
  const entry = getFloatingRangeById(id);
  if (!entry) return false;
  const surface = getLayoutSurface(entry.sheetIndex);
  return surface ? surface.editable : true;
}

// ============================================================================
// Grid overlay sync
// ============================================================================

/**
 * Publish overlay regions for the ACTIVE sheet's floating ranges (atomically —
 * replaceGridRegionsByType, one listener notification). Frame size is derived
 * here, never read from anywhere else.
 *
 * THE TITLE BAR IS A FRAME, THE CELLS ARE THE WORKING SURFACE (owner decision
 * 2026-09-27, replacing the 2026-08-13 "button rule"). Design Mode no longer
 * decides whether a range may move; it decides only what a press on its CELLS
 * means. Three flags, all from `frGeometryEditable`'s rule:
 *
 *   - `movable`: the title bar (or, with the title hidden, the 4px border
 *     band) moves the range in every mode, on every sheet kind -- unless the
 *     sheet is a subscribed canvas or the canvas locks the range. Core reads it
 *     before a move; the canvas's arrange, nudge and group drag read it too.
 *   - `resizable`: the same, AND the range is SELECTED (by this family or by
 *     the canvas selection set, `frRangeInSelection`), AND none of its cells
 *     is being edited -- the handles exist only on a selected object (Excel /
 *     Power BI), so an unselected range's corner boxes and edge balls never
 *     take a click meant for its cells, and never sit over the cell the user
 *     is typing in (owner, 2026-09-27). The editor announces itself through
 *     lib/frEditingRange.ts; Core's corner boxes read this flag, and the
 *     extension's own paint and edge gesture re-check the editor live
 *     (`frHandlesLive`).
 *   - `bodyGrab`: Design Mode on AND no title bar -- the whole body is then the
 *     move handle (the Charts/Controls convention). Never outside Design
 *     Mode: flipping `movable` alone must not turn every title-less range's
 *     cells into a move handle.
 *
 * Every input is re-published on its own signal: Design Mode, the layout
 * surface (subscribe / detach / lock / a late canvas store) and the object
 * selection each re-sync from index.ts.
 */
export function syncFloatingRangeRegions(): void {
  const visible = entries.filter((e) => e.sheetIndex === activeSheetIndex);
  const designing = getDesignMode();

  const regions: GridRegion[] = visible.map((entry) => {
    const region = baseRegionOf(entry);
    const geometry = geometryEditableFor(entry, region);
    region.data = {
      ...region.data,
      movable: geometry,
      resizable:
        geometry && frRangeInSelection(entry.id, region) && getFrEditingRange() !== entry.id,
      bodyGrab: geometry && designing && !entry.showTitle,
      // On a canvas the frame's POSITION snaps to the layout grid like every
      // object's, but its SIZE is whole rows and columns (quantised by this
      // extension on resize): a second, pixel-grid snap on top would make most
      // row/column counts unreachable. Core honours this for resize only.
      snapResize: false,
      // Core's selection handles: the four CORNERS only (they change the
      // row/column COUNTS). The edge midpoints carry this extension's yellow
      // balls, which scale the CELLS through its own content zone (frZoneAt);
      // Core scans its handles BEFORE the body press, so a Core midpoint there
      // would take every press meant for a ball.
      handles: "corners",
      // A grid WITHOUT a title has only its 4px border band (frZoneAt
      // 'border') to be moved by: Core shows its six-dot grip while it is
      // hovered or selected (@api/gridOverlays, BUG-0258 design phase 5). The
      // band stays.
      ...(entry.showTitle ? {} : { grip: "hover" }),
    };
    return region;
  });

  replaceGridRegionsByType(FLOATING_RANGE_REGION_TYPE, regions);
}

/**
 * Whether range `frId` (published as `region`) is SELECTED for its handles:
 * held by this family's own selection, or by the canvas selection SET
 * (@api/objectSelection). The family holds one range at a time (its provider
 * has no addToSelection), so the second and later grids of a canvas
 * multi-selection are set-held -- Core outlines them, and they get their
 * corners and edge balls like every family's set-held member. The ONE answer
 * for `resizable` and for the edge-ball painter (frRenderer.ts).
 */
export function frRangeInSelection(frId: string, region: GridRegion): boolean {
  return isFloatingRangeSelected(frId) || isObjectInSelection(region);
}

/**
 * Re-publish the regions whenever an input of their flags changes, so no
 * change waits for the next unrelated sync:
 *
 *   - Design Mode (`bodyGrab`);
 *   - the layout surface: subscribe, detach, lock, and a canvas store that
 *     loads AFTER the ranges did (without this a range synced before its
 *     sheet was known to be a canvas kept the worksheet answer until some
 *     other sync -- green in unit tests, intermittent live);
 *   - the object selection (`resizable` needs the range SELECTED; selecting
 *     and deselecting both announce through `notifyObjectSelectionChanged`);
 *   - the cell editor opening or closing (`resizable` stands down while one
 *     of the range's cells is edited; lib/frEditingRange.ts).
 *
 * No feedback loop: publishing regions notifies region listeners (the grid
 * repaint, the canvas's object label, the formula-bar publisher), none of
 * which writes any of the four.
 * Returns the cleanup.
 */
export function installFrRegionResyncs(): () => void {
  const resync = () => {
    syncFloatingRangeRegions();
    requestOverlayRedraw();
  };
  const cleanups = [
    onDesignModeChange(resync),
    onLayoutSurfaceChanged(resync),
    onObjectSelectionChanged(resync),
    onFrEditingRangeChanged(resync),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
