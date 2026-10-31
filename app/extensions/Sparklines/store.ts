//! FILENAME: app/extensions/Sparklines/store.ts
// PURPOSE: In-memory store for sparkline groups and per-cell lookup.
// CONTEXT: A SparklineGroup maps a Location Range to a Data Range.
//          Each cell in the location range gets its own slice of data.
//          The renderer looks up sparkline info per cell via getSparklineForCell().

import type {
  SparklineGroup,
  SparklineType,
  CellRange,
  DataOrientation,
  ValidationResult,
  EmptyCellHandling,
  AxisScaleType,
  PlotOrder,
} from "./types";
import { validateSparklineRanges, groupAreas, groupLocationOverlaps } from "./types";
import { sparklinesBackend } from "./lib/sparklinesBackend";
import { AppEvents, emitAppEvent } from "@api/events";

// ============================================================================
// State
// ============================================================================

let nextGroupId = 1;

/** All sparkline groups */
const groups: SparklineGroup[] = [];

/** Callback invoked after any mutation to schedule persistence */
let onMutationCallback: (() => void) | null = null;

/** Set a callback to be called after any mutation (used by index.ts for persistence) */
export function setOnMutationCallback(cb: (() => void) | null): void {
  onMutationCallback = cb;
}

function notifyMutation(): void {
  if (onMutationCallback) onMutationCallback();
}

/** Fast lookup: "row,col" -> { group, index within the group } */
interface CellEntry {
  group: SparklineGroup;
  /**
   * Index of this cell's sparkline within the GROUP (0-based): its place in
   * its area's location, after every sparkline of the group's earlier areas
   * (`moreAreas`, types.ts) -- the order fetchGroupData lists the data in.
   */
  index: number;
  /** Total number of sparklines in the group (every area) */
  count: number;
  /** Data orientation for the group's FIRST area (each later area's comes from its own ranges) */
  orientation: DataOrientation;
}
const cellIndex = new Map<string, CellEntry>();

/** Cached numeric data per group ID, keyed by group ID */
const dataCache = new Map<number, number[][]>();

/** Whether cache is dirty and needs refresh */
let cacheDirty = true;

// ============================================================================
// Key helpers
// ============================================================================

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Rebuild the cellIndex from the groups array. */
function rebuildCellIndex(): void {
  cellIndex.clear();
  for (const group of groups) {
    const first = validateSparklineRanges(group.location, group.dataRange);
    if (!first.valid) continue;
    const orientation = first.orientation!;

    // Every area in turn (a group of several areas: `moreAreas`, types.ts),
    // numbering the sparklines across them. An area whose ranges do not map
    // still takes its place in the numbering, so the later areas' indices
    // stay aligned with fetchGroupData's slices; its cells draw nothing.
    const areas = groupAreas(group);
    const cells: Array<[number, number]> = [];
    for (const area of areas) {
      const locRows = area.location.endRow - area.location.startRow + 1;
      const locCols = area.location.endCol - area.location.startCol + 1;
      const n = Math.max(locRows, locCols);
      const valid = validateSparklineRanges(area.location, area.dataRange).valid;
      for (let i = 0; i < n; i++) {
        cells.push(
          valid
            ? [area.location.startRow + (locCols === 1 ? i : 0), area.location.startCol + (locRows === 1 ? i : 0)]
            : [-1, -1],
        );
      }
    }
    const count = cells.length;
    cells.forEach(([row, col], index) => {
      if (row >= 0) cellIndex.set(cellKey(row, col), { group, index, count, orientation });
    });
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a sparkline group. Validates the ranges first.
 * Returns the validation result; if valid, the group is added.
 */
export function createSparklineGroup(
  location: CellRange,
  dataRange: CellRange,
  type: SparklineType,
  color: string = "#4472C4",
  negativeColor: string = "#D94735",
): ValidationResult & { group?: SparklineGroup } {
  const validation = validateSparklineRanges(location, dataRange);
  if (!validation.valid) {
    return validation;
  }

  // Remove any existing sparklines that overlap the new location
  removeSparklineGroupsOverlapping(location);

  const group: SparklineGroup = {
    id: nextGroupId++,
    location,
    dataRange,
    type,
    color,
    negativeColor,
    showMarkers: false,
    lineWidth: 1.5,
    showHighPoint: false,
    showLowPoint: false,
    showFirstPoint: false,
    showLastPoint: false,
    showNegativePoints: false,
    highPointColor: "#D94735",
    lowPointColor: "#D94735",
    firstPointColor: "#43A047",
    lastPointColor: "#43A047",
    negativePointColor: "#D94735",
    markerColor: color,
    showAxis: false,
    axisScaleType: "auto",
    axisMinValue: null,
    axisMaxValue: null,
    emptyCellHandling: "zero",
    plotOrder: "default",
  };

  groups.push(group);
  rebuildCellIndex();
  cacheDirty = true;
  notifyMutation();

  return { ...validation, group };
}

/** Remove all sparkline groups whose location overlaps the given range. */
function removeSparklineGroupsOverlapping(range: CellRange): void {
  for (let i = groups.length - 1; i >= 0; i--) {
    // Any AREA of the group (types.ts `moreAreas`).
    if (groupLocationOverlaps(groups[i], range)) {
      dataCache.delete(groups[i].id);
      groups.splice(i, 1);
    }
  }
}

/** Remove a sparkline group by ID. */
export function removeSparklineGroup(groupId: number): boolean {
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx === -1) return false;
  dataCache.delete(groupId);
  groups.splice(idx, 1);
  rebuildCellIndex();
  cacheDirty = true;
  notifyMutation();
  return true;
}

/** Get sparkline info for a specific cell, or undefined if none. */
export function getSparklineForCell(
  row: number,
  col: number,
): CellEntry | undefined {
  return cellIndex.get(cellKey(row, col));
}

/** Check if a cell has a sparkline. */
export function hasSparkline(row: number, col: number): boolean {
  return cellIndex.has(cellKey(row, col));
}

/** Get all sparkline groups. */
export function getAllGroups(): SparklineGroup[] {
  return [...groups];
}

/** Get a sparkline group by ID, or undefined if not found. */
export function getGroupById(groupId: number): SparklineGroup | undefined {
  return groups.find((g) => g.id === groupId);
}

/**
 * Get all sparkline groups whose location range overlaps the given range.
 * Used by the fill handler to find source sparklines.
 */
export function getGroupsForRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): SparklineGroup[] {
  const result: SparklineGroup[] = [];
  for (const group of groups) {
    // Any AREA of the group (types.ts `moreAreas`).
    if (groupLocationOverlaps(group, { startRow, startCol, endRow, endCol })) {
      result.push(group);
    }
  }
  return result;
}

/**
 * Update properties of an existing sparkline group.
 * Returns true if the group was found and updated.
 */
export function updateSparklineGroup(
  groupId: number,
  updates: Partial<Omit<SparklineGroup, "id">>,
): boolean {
  const group = groups.find((g) => g.id === groupId);
  if (!group) return false;

  Object.assign(group, updates);

  // Rebuild cell index if structural fields changed. A new location or data
  // range (the Edit Data dialog) REPLACES the group's areas with the one
  // entered, as Excel's "Edit Group Location & Data" does -- unless the
  // update names its own `moreAreas`.
  if (updates.location || updates.dataRange) {
    if (!("moreAreas" in updates)) delete group.moreAreas;
    rebuildCellIndex();
  }

  cacheDirty = true;
  dataCache.delete(groupId);
  notifyMutation();
  return true;
}

// ============================================================================
// Data Cache
// ============================================================================

/** Mark the data cache as dirty (e.g., when cell values change). */
export function invalidateDataCache(): void {
  cacheDirty = true;
  dataCache.clear();
}

/**
 * Get cached data for a group.
 * Returns an array of number arrays (one per sparkline in the group), or null.
 */
export function getCachedGroupData(groupId: number): number[][] | null {
  return dataCache.get(groupId) ?? null;
}

/** Store cached data for a group. */
export function setCachedGroupData(groupId: number, data: number[][]): void {
  dataCache.set(groupId, data);
}

/** Check if data cache needs refresh. */
export function isDataCacheDirty(): boolean {
  return cacheDirty;
}

/** Mark data cache as clean. */
export function markDataCacheClean(): void {
  cacheDirty = false;
}

/**
 * Group selected sparkline groups into one group.
 * Merges all groups whose location overlaps the given range into a single group.
 * The first group's visual properties are used as the template.
 * Returns the merged group, or null if fewer than 2 groups overlap.
 */
export function groupSparklines(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): SparklineGroup | null {
  const overlapping = getGroupsForRange(startRow, startCol, endRow, endCol);
  if (overlapping.length < 2) return null;

  // Use the first group as template for visual properties
  const template = overlapping[0];

  // Compute the bounding location range and merged data range
  let locMinRow = Infinity, locMinCol = Infinity, locMaxRow = -Infinity, locMaxCol = -Infinity;
  let dataMinRow = Infinity, dataMinCol = Infinity, dataMaxRow = -Infinity, dataMaxCol = -Infinity;

  // Every AREA of every group (types.ts `moreAreas`).
  for (const g of overlapping) {
    for (const area of groupAreas(g)) {
      locMinRow = Math.min(locMinRow, area.location.startRow);
      locMinCol = Math.min(locMinCol, area.location.startCol);
      locMaxRow = Math.max(locMaxRow, area.location.endRow);
      locMaxCol = Math.max(locMaxCol, area.location.endCol);
      dataMinRow = Math.min(dataMinRow, area.dataRange.startRow);
      dataMinCol = Math.min(dataMinCol, area.dataRange.startCol);
      dataMaxRow = Math.max(dataMaxRow, area.dataRange.endRow);
      dataMaxCol = Math.max(dataMaxCol, area.dataRange.endCol);
    }
  }

  // Remove all overlapping groups
  for (const g of overlapping) {
    const idx = groups.indexOf(g);
    if (idx !== -1) {
      dataCache.delete(g.id);
      groups.splice(idx, 1);
    }
  }

  // Create merged group with template's visual properties
  const merged: SparklineGroup = {
    ...template,
    id: nextGroupId++,
    location: { startRow: locMinRow, startCol: locMinCol, endRow: locMaxRow, endCol: locMaxCol },
    dataRange: { startRow: dataMinRow, startCol: dataMinCol, endRow: dataMaxRow, endCol: dataMaxCol },
  };
  // One bounding area: the template's own further areas are inside it.
  delete merged.moreAreas;

  groups.push(merged);
  rebuildCellIndex();
  cacheDirty = true;
  notifyMutation();

  return merged;
}

/**
 * Ungroup a sparkline group: split a multi-cell group into individual single-cell groups.
 * Each cell in the location range becomes its own group with the same visual properties.
 * Returns the number of new groups created.
 */
export function ungroupSparkline(groupId: number): number {
  const group = groups.find((g) => g.id === groupId);
  if (!group) return 0;

  // Every AREA (types.ts `moreAreas`), each cut into its single-cell
  // sparklines with its own data line.
  const singles: Array<{ location: CellRange; dataRange: CellRange }> = [];
  for (const area of groupAreas(group)) {
    const validation = validateSparklineRanges(area.location, area.dataRange);
    if (!validation.valid || !validation.count) continue;
    const locCols = area.location.endCol - area.location.startCol + 1;
    const isLocColumn = locCols === 1;
    if (validation.count === 1) {
      singles.push({ location: area.location, dataRange: area.dataRange });
      continue;
    }
    for (let i = 0; i < validation.count; i++) {
      const locRow = area.location.startRow + (isLocColumn ? i : 0);
      const locCol = area.location.startCol + (!isLocColumn ? i : 0);
      // Compute per-cell data range slice
      const cellDataRange: CellRange =
        validation.orientation === "byRow"
          ? {
              startRow: area.dataRange.startRow + i,
              startCol: area.dataRange.startCol,
              endRow: area.dataRange.startRow + i,
              endCol: area.dataRange.endCol,
            }
          : {
              startRow: area.dataRange.startRow,
              startCol: area.dataRange.startCol + i,
              endRow: area.dataRange.endRow,
              endCol: area.dataRange.startCol + i,
            };
      singles.push({
        location: { startRow: locRow, startCol: locCol, endRow: locRow, endCol: locCol },
        dataRange: cellDataRange,
      });
    }
  }
  if (singles.length <= 1) return 0;

  // Remove the original group
  const idx = groups.indexOf(group);
  if (idx !== -1) {
    dataCache.delete(group.id);
    groups.splice(idx, 1);
  }

  let created = 0;
  for (const single of singles) {
    const newGroup: SparklineGroup = {
      ...group,
      id: nextGroupId++,
      location: single.location,
      dataRange: single.dataRange,
    };
    delete newGroup.moreAreas;
    groups.push(newGroup);
    created++;
  }

  rebuildCellIndex();
  cacheDirty = true;
  notifyMutation();

  return created;
}

/**
 * Export all sparkline groups as serializable data.
 * Used for persistence (save to backend).
 */
export function exportGroups(): SparklineGroup[] {
  return groups.map((g) => ({ ...g }));
}

/**
 * Import sparkline groups from serialized data.
 * Replaces all existing groups.
 */
export function importGroups(imported: SparklineGroup[]): void {
  groups.length = 0;
  dataCache.clear();
  cellIndex.clear();

  let maxId = 0;
  for (const g of imported) {
    groups.push({ ...g });
    if (g.id >= maxId) maxId = g.id;
  }
  nextGroupId = maxId + 1;

  rebuildCellIndex();
  cacheDirty = true;
}

// ============================================================================
// Backend Persistence
// ============================================================================

/**
 * The loaded sheet's groups as the backend last CONFIRMED them: what a load
 * read, or what a save it accepted sent. The base a pending change is merged
 * against when the backend rewrote the groups under it (`mergeSparklineGroups`).
 */
let persistedGroups: SparklineGroup[] = [];

/**
 * The same groups as the EXACT blob the backend holds (`""` for none): what a
 * load read, or what an accepted save sent. Every save names it as its `base`,
 * and the backend refuses a save made against a blob it no longer holds
 * (`SPARKLINE_GROUPS_CHANGED`, sparkline_commands.rs) -- a structural edit
 * moved the ranges, an undo put an older list back. Kept as the backend's own
 * text, never re-serialised: the backend rewrites the blob with its own key
 * order, and a re-serialised base would never match it.
 */
let persistedJson = "";

/** The prefix of the backend's refusal of a save whose base it no longer holds. */
const SPARKLINE_GROUPS_CHANGED = "SPARKLINE_GROUPS_CHANGED";

/** How many rewrites in a row one save merges with before it gives up. */
const MAX_SPARKLINE_REBASES = 3;

/** Did the backend refuse a save because the groups it was made against changed? */
function isGroupsChanged(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String((error as { message?: unknown } | null)?.message ?? error);
  return message.startsWith(SPARKLINE_GROUPS_CHANGED);
}

/** One sheet's stored blob, as `get_sparklines` returns it (`""` for none). */
function storedJsonOf(
  entries: ReadonlyArray<{ sheetIndex: number; groupsJson: string }>,
  sheetIndex: number,
): string {
  return entries.find((e) => e.sheetIndex === sheetIndex)?.groupsJson ?? "";
}

/** A stored blob's groups (none for an empty or unreadable blob). */
function groupsOfJson(json: string): SparklineGroup[] {
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as SparklineGroup[]) : [];
}

/**
 * Save current sparkline groups to the backend for persistence.
 * Called after any mutation (create, update, delete, group, ungroup).
 *
 * Made against `persistedJson`. When the backend refuses it because it
 * rewrote this sheet's groups in the meantime -- a change made WHILE a
 * structural command ran saves after it, and used to put the pre-edit ranges
 * back over the moved ones (revF#4) -- the store merges its change into what
 * is stored now (`mergeIntoStored`) and saves the merge, against that.
 */
export async function saveToBackend(sheetIndex: number): Promise<void> {
  for (let rebases = 0; ; rebases++) {
    const groupsJson = JSON.stringify(exportGroups());
    try {
      await sparklinesBackend.invoke("save_sparklines", {
        entry: { sheetIndex, groupsJson },
        base: persistedJson,
      });
      persistedGroups = JSON.parse(groupsJson) as SparklineGroup[];
      persistedJson = groupsJson;
      return;
    } catch (err) {
      if (!isGroupsChanged(err) || rebases >= MAX_SPARKLINE_REBASES) {
        console.error("[Sparklines] Failed to save to backend:", err);
        return;
      }
      // Nothing left to save when the merge IS what is stored, or when the
      // stored groups could not be read (that read reported itself).
      const owed = await mergeIntoStored(sheetIndex);
      // The merge moved the groups in memory (the rewrite's ranges): repaint.
      if (owed !== null) emitAppEvent(AppEvents.GRID_REFRESH);
      if (owed !== true) return;
    }
  }
}

/**
 * Load sparkline groups from the backend for a specific sheet.
 */
export async function loadFromBackend(sheetIndex: number): Promise<void> {
  try {
    const entries = await sparklinesBackend.invoke<Array<{ sheetIndex: number; groupsJson: string }>>(
      "get_sparklines",
    );
    const entry = entries.find((e) => e.sheetIndex === sheetIndex);
    if (entry && entry.groupsJson) {
      const parsed = JSON.parse(entry.groupsJson) as SparklineGroup[];
      importGroups(parsed);
      persistedGroups = exportGroups();
      persistedJson = entry.groupsJson;
    } else {
      resetSparklineStore();
    }
  } catch (err) {
    console.error("[Sparklines] Failed to load from backend:", err);
  }
}

/** Structural JSON equality of two group fields (key order is the writer's, so it is not ignored). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * THREE-WAY MERGE, by group ID, of a pending change (`current`: the store as
 * it stands) with groups the backend rewrote on its own (`stored`: a
 * structural edit moved them, gave them more areas (`moreAreas`) or removed
 * them -- chart_range_shift.rs -- or an undo put them back), against what it
 * last confirmed (`base`).
 *
 * - A group both still have: each field the change touched keeps the
 *   change, each one it did not takes the backend's value (a recolour keeps
 *   its colour AND takes the moved location and data range). A location or
 *   data range is one value: the change's, if it made one.
 * - A group the change REMOVED stays removed; one the backend removed (its
 *   cells or data deleted) stays removed.
 * - A group only the backend has (a group an undo put back) is taken; a group only the change has (created in the
 *   change) is kept, under a fresh id if the backend's took its id.
 *
 * Pure. Returns new objects; the inputs are left as they are.
 */
export function mergeSparklineGroups(
  current: readonly SparklineGroup[],
  base: readonly SparklineGroup[],
  stored: readonly SparklineGroup[],
): SparklineGroup[] {
  const baseById = new Map(base.map((g) => [g.id, g] as const));
  const currentById = new Map(current.map((g) => [g.id, g] as const));
  const out: SparklineGroup[] = [];
  for (const s of stored) {
    const b = baseById.get(s.id);
    const c = currentById.get(s.id);
    if (b === undefined) {
      // The backend's own: a group put back.
      out.push({ ...s });
      continue;
    }
    if (c === undefined) continue; // the change removed it
    const merged: Record<string, unknown> = { ...s };
    const keys = new Set([...Object.keys(s), ...Object.keys(b), ...Object.keys(c)]);
    for (const key of keys) {
      const was = (b as unknown as Record<string, unknown>)[key];
      const now = (c as unknown as Record<string, unknown>)[key];
      if (!sameValue(now, was)) merged[key] = now;
    }
    out.push(merged as unknown as SparklineGroup);
  }
  const taken = new Set(out.map((g) => g.id));
  // A loop, never `Math.max(...ids)`: a spread passes one call argument per
  // group, and a sheet a fill gave one group per cell has enough of them to
  // throw RangeError (BUG-0346) -- inside a refused save's merge, where nobody
  // would hear it and the change would never be saved.
  let highestId = 0;
  for (const g of out) if (g.id > highestId) highestId = g.id;
  for (const g of current) if (g.id > highestId) highestId = g.id;
  let nextId = highestId + 1;
  for (const c of current) {
    if (baseById.has(c.id)) continue; // merged above, or removed by the backend
    // Created by the change: the backend never saw it, so it has nothing to move.
    const id = taken.has(c.id) ? nextId++ : c.id;
    taken.add(id);
    out.push({ ...c, id });
  }
  return out;
}

/**
 * A change is PENDING while the backend rewrote this sheet's groups (the
 * reload after a structural edit found a save not yet sent): merge it into
 * what the backend holds now (`mergeSparklineGroups`), show the merge, and
 * save it -- never the stale in-memory groups over the moved ones, and never
 * the change thrown away.
 */
export async function mergePendingWithBackend(sheetIndex: number): Promise<void> {
  if ((await mergeIntoStored(sheetIndex)) === true) await saveToBackend(sheetIndex);
}

/**
 * Read this sheet's groups as the backend holds them NOW, merge the store's
 * change into them (`mergeSparklineGroups`, against what the backend last
 * confirmed), show the merge, and take what was read as the new confirmed
 * state -- so the next save is made against it. Answers whether a save is
 * still owed (the merge differs from what is stored), or `null` when the
 * backend could not be read (nothing is changed then).
 */
async function mergeIntoStored(sheetIndex: number): Promise<boolean | null> {
  let storedJson: string;
  let stored: SparklineGroup[];
  try {
    const entries = await sparklinesBackend.invoke<Array<{ sheetIndex: number; groupsJson: string }>>(
      "get_sparklines",
    );
    storedJson = storedJsonOf(entries, sheetIndex);
    stored = groupsOfJson(storedJson);
  } catch (err) {
    console.error("[Sparklines] Failed to read the backend to merge a pending change:", err);
    return null;
  }
  const merged = mergeSparklineGroups(exportGroups(), persistedGroups, stored);
  importGroups(merged);
  persistedGroups = stored.map((g) => ({ ...g }));
  persistedJson = storedJson;
  return JSON.stringify(merged) !== JSON.stringify(stored);
}

/** Reset all state. */
export function resetSparklineStore(): void {
  groups.length = 0;
  cellIndex.clear();
  dataCache.clear();
  cacheDirty = true;
  nextGroupId = 1;
  persistedGroups = [];
  persistedJson = "";
}
