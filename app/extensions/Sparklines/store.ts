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
} from "./types";
import { validateSparklineRanges } from "./types";

// ============================================================================
// State
// ============================================================================

let nextGroupId = 1;

/** All sparkline groups */
const groups: SparklineGroup[] = [];

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
  };

  groups.push(group);
  rebuildCellIndex();
  cacheDirty = true;

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

/** Reset all state. */
export function resetSparklineStore(): void {
  groups.length = 0;
  cellIndex.clear();
  dataCache.clear();
  cacheDirty = true;
  nextGroupId = 1;
}
