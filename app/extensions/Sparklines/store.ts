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
import { validateSparklineRanges } from "./types";

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

/** Fast lookup: "row,col" -> { group, index within location range } */
interface CellEntry {
  group: SparklineGroup;
  /** Index of this cell within the location range (0-based) */
  index: number;
  /** Total number of sparklines in the group */
  count: number;
  /** Data orientation for this group */
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
    const validation = validateSparklineRanges(group.location, group.dataRange);
    if (!validation.valid) continue;

    const locRows = group.location.endRow - group.location.startRow + 1;
    const locCols = group.location.endCol - group.location.startCol + 1;
    const count = Math.max(locRows, locCols);
    const orientation = validation.orientation!;

    // Iterate over each cell in the location range
    for (let i = 0; i < count; i++) {
      const row = group.location.startRow + (locCols === 1 ? i : 0);
      const col = group.location.startCol + (locRows === 1 ? i : 0);
      cellIndex.set(cellKey(row, col), { group, index: i, count, orientation });
    }
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
    const loc = groups[i].location;
    const overlaps =
      loc.startRow <= range.endRow &&
      loc.endRow >= range.startRow &&
      loc.startCol <= range.endCol &&
      loc.endCol >= range.startCol;
    if (overlaps) {
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
    const loc = group.location;
    const overlaps =
      loc.startRow <= endRow &&
      loc.endRow >= startRow &&
      loc.startCol <= endCol &&
      loc.endCol >= startCol;
    if (overlaps) {
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

  // Rebuild cell index if structural fields changed
  if (updates.location || updates.dataRange) {
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

  for (const g of overlapping) {
    locMinRow = Math.min(locMinRow, g.location.startRow);
    locMinCol = Math.min(locMinCol, g.location.startCol);
    locMaxRow = Math.max(locMaxRow, g.location.endRow);
    locMaxCol = Math.max(locMaxCol, g.location.endCol);
    dataMinRow = Math.min(dataMinRow, g.dataRange.startRow);
    dataMinCol = Math.min(dataMinCol, g.dataRange.startCol);
    dataMaxRow = Math.max(dataMaxRow, g.dataRange.endRow);
    dataMaxCol = Math.max(dataMaxCol, g.dataRange.endCol);
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

  const validation = validateSparklineRanges(group.location, group.dataRange);
  if (!validation.valid || !validation.count || validation.count <= 1) return 0;

  const locRows = group.location.endRow - group.location.startRow + 1;
  const locCols = group.location.endCol - group.location.startCol + 1;
  const count = validation.count;
  const orientation = validation.orientation!;
  const isLocColumn = locCols === 1;

  // Remove the original group
  const idx = groups.indexOf(group);
  if (idx !== -1) {
    dataCache.delete(group.id);
    groups.splice(idx, 1);
  }

  const dataRows = group.dataRange.endRow - group.dataRange.startRow + 1;
  const dataCols = group.dataRange.endCol - group.dataRange.startCol + 1;

  let created = 0;
  for (let i = 0; i < count; i++) {
    const locRow = group.location.startRow + (isLocColumn ? i : 0);
    const locCol = group.location.startCol + (!isLocColumn ? i : 0);

    // Compute per-cell data range slice
    let cellDataRange: CellRange;
    if (orientation === "byRow") {
      cellDataRange = {
        startRow: group.dataRange.startRow + i,
        startCol: group.dataRange.startCol,
        endRow: group.dataRange.startRow + i,
        endCol: group.dataRange.endCol,
      };
    } else {
      cellDataRange = {
        startRow: group.dataRange.startRow,
        startCol: group.dataRange.startCol + i,
        endRow: group.dataRange.endRow,
        endCol: group.dataRange.startCol + i,
      };
    }

    const newGroup: SparklineGroup = {
      ...group,
      id: nextGroupId++,
      location: { startRow: locRow, startCol: locCol, endRow: locRow, endCol: locCol },
      dataRange: cellDataRange,
    };
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
 * Save current sparkline groups to the backend for persistence.
 * Called after any mutation (create, update, delete, group, ungroup).
 */
export async function saveToBackend(sheetIndex: number): Promise<void> {
  try {
    const { invokeBackend } = await import("../../src/api/backend");
    const groupsJson = JSON.stringify(exportGroups());
    await invokeBackend("save_sparklines", {
      entry: { sheetIndex, groupsJson },
    });
  } catch (err) {
    console.error("[Sparklines] Failed to save to backend:", err);
  }
}

/**
 * Load sparkline groups from the backend for a specific sheet.
 */
export async function loadFromBackend(sheetIndex: number): Promise<void> {
  try {
    const { invokeBackend } = await import("../../src/api/backend");
    const entries = await invokeBackend<Array<{ sheetIndex: number; groupsJson: string }>>(
      "get_sparklines",
    );
    const entry = entries.find((e) => e.sheetIndex === sheetIndex);
    if (entry && entry.groupsJson) {
      const parsed = JSON.parse(entry.groupsJson) as SparklineGroup[];
      importGroups(parsed);
    } else {
      resetSparklineStore();
    }
  } catch (err) {
    console.error("[Sparklines] Failed to load from backend:", err);
  }
}

/** Reset all state. */
export function resetSparklineStore(): void {
  groups.length = 0;
  cellIndex.clear();
  dataCache.clear();
  cacheDirty = true;
  nextGroupId = 1;
}
