//! FILENAME: app/extensions/ConditionalFormatting/lib/cfStore.ts
// PURPOSE: Module-level state management for conditional formatting.
// CONTEXT: Caches rules and evaluation results from the Rust backend.
//          Follows the validationStore.ts pattern from DataValidation.

import {
  getAllConditionalFormats,
  evaluateConditionalFormats,
  emitAppEvent,
  AppEvents,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
  markSheetDirty,
} from "@api";

import type {
  ConditionalFormatDefinition,
  CellConditionalFormat,
  GridRegion,
} from "@api";
import { getViewportCells, getStyle } from "@api/lib";

import type { CFState } from "../types";
import { CFEvents } from "./cfEvents";

// ============================================================================
// Module-Level State
// ============================================================================

let state: CFState = {
  rules: [],
  evaluationCache: new Map(),
  viewportRange: null,
  dirty: true,
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The horizontal alignment of each Show Icon Only cell in the evaluated range
 * that is centred or right-aligned, by "row,col" (BUG-0728): Excel places such
 * a cell's icon by its alignment, and the overlay that paints it has no style
 * to read. Filled after each evaluation by `refreshIconAlignments`.
 */
let iconAlign = new Map<string, "center" | "right">();
/** Bumped by each read: only the newest one may land (an older, slower answer
 *  must never overwrite a newer one). */
let iconAlignGeneration = 0;

// ============================================================================
// Getters
// ============================================================================

/**
 * A Show Icon Only cell's horizontal alignment when it is "center" or
 * "right", else undefined (the icon sits at the left).
 */
export function getIconAlignForCell(row: number, col: number): "center" | "right" | undefined {
  return iconAlign.get(`${row},${col}`);
}

/** Get all cached rules for the current sheet */
export function getRules(): ConditionalFormatDefinition[] {
  return state.rules;
}

/** Get evaluation results for a specific cell */
export function getEvaluationForCell(
  row: number,
  col: number
): CellConditionalFormat[] | null {
  return state.evaluationCache.get(`${row},${col}`) || null;
}

/** Check if there are any rules on the current sheet */
export function hasRules(): boolean {
  return state.rules.length > 0;
}

/** Check if a specific rule type exists among the rules */
export function hasRuleType(type: string): boolean {
  return state.rules.some((r) => r.rule.type === type);
}

// ============================================================================
// Data Loading
// ============================================================================

/** Refresh rules from the backend */
export async function refreshRules(): Promise<void> {
  try {
    state.rules = await getAllConditionalFormats();
    emitAppEvent(CFEvents.RULES_CHANGED);
  } catch (error) {
    console.error("[ConditionalFormatting] Failed to refresh rules:", error);
  }
}

/** Evaluate conditional formats for the given viewport range */
export async function evaluateViewport(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<void> {
  // Add buffer around viewport for smoother scrolling
  const bufferRows = 20;
  const bufferCols = 5;
  const evalStartRow = Math.max(0, startRow - bufferRows);
  const evalStartCol = Math.max(0, startCol - bufferCols);
  const evalEndRow = endRow + bufferRows;
  const evalEndCol = endCol + bufferCols;

  // Always track the viewport range so future invalidations can re-evaluate
  // (even when there are no rules yet — the first rule add needs this)
  state.viewportRange = {
    startRow: evalStartRow,
    startCol: evalStartCol,
    endRow: evalEndRow,
    endCol: evalEndCol,
  };

  if (state.rules.length === 0) {
    state.evaluationCache.clear();
    syncOverlayRegions();
    await refreshIconAlignments();
    return;
  }

  try {
    const result = await evaluateConditionalFormats(
      evalStartRow,
      evalStartCol,
      evalEndRow,
      evalEndCol
    );

    // Build evaluation cache grouped by cell
    state.evaluationCache.clear();
    for (const cf of result.cells) {
      const key = `${cf.row},${cf.col}`;
      const existing = state.evaluationCache.get(key);
      if (existing) {
        existing.push(cf);
      } else {
        state.evaluationCache.set(key, [cf]);
      }
    }

    state.dirty = false;

    syncOverlayRegions();
    emitAppEvent(CFEvents.EVALUATION_UPDATED);
  } catch (error) {
    console.error(
      "[ConditionalFormatting] Failed to evaluate viewport:",
      error
    );
    return;
  }
  await refreshIconAlignments();
}

/**
 * Read the horizontal alignment of every Show Icon Only cell the evaluation
 * found (results flagged `hideValue` with an icon), so the overlay can place
 * the icon as Excel does (rendering/iconSetRenderer.ts `iconPlacementFor`).
 * One styled read of the cells' bounding rectangle, one style read per
 * distinct style -- and nothing at all when no such cell is in view. A failed
 * read is logged and leaves the icons at the left, as before.
 */
async function refreshIconAlignments(): Promise<void> {
  const generation = ++iconAlignGeneration;
  const wanted: string[] = [];
  let r0 = Infinity;
  let c0 = Infinity;
  let r1 = -Infinity;
  let c1 = -Infinity;
  for (const [key, cfs] of state.evaluationCache) {
    if (!cfs.some((cf) => cf.iconIndex != null && cf.hideValue === true)) continue;
    const [row, col] = key.split(",").map(Number);
    wanted.push(key);
    r0 = Math.min(r0, row);
    c0 = Math.min(c0, col);
    r1 = Math.max(r1, row);
    c1 = Math.max(c1, col);
  }
  if (wanted.length === 0) {
    if (iconAlign.size > 0) {
      iconAlign = new Map();
      requestOverlayRedraw();
    }
    return;
  }
  try {
    const cells = await getViewportCells(r0, c0, r1, c1);
    const styleIndexAt = new Map<string, number>();
    for (const cell of cells) styleIndexAt.set(`${cell.row},${cell.col}`, cell.styleIndex ?? 0);
    const indexes = [...new Set(wanted.map((key) => styleIndexAt.get(key) ?? 0))];
    const styles = await Promise.all(indexes.map((index) => getStyle(index)));
    const alignOf = new Map(indexes.map((index, n) => [index, styles[n]?.textAlign]));
    if (generation !== iconAlignGeneration) return;
    const next = new Map<string, "center" | "right">();
    for (const key of wanted) {
      const align = alignOf.get(styleIndexAt.get(key) ?? 0);
      if (align === "center" || align === "right") next.set(key, align);
    }
    const changed = next.size !== iconAlign.size || [...next].some(([k, v]) => iconAlign.get(k) !== v);
    iconAlign = next;
    if (changed) requestOverlayRedraw();
  } catch (error) {
    console.warn("[ConditionalFormatting] reading the Show Icon Only cells' alignment failed:", error);
  }
}

// ============================================================================
// Invalidation
// ============================================================================

/** Mark the cache as dirty and schedule a re-evaluation (debounced) */
export function invalidateCache(): void {
  state.dirty = true;
  markSheetDirty();

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (state.dirty && state.viewportRange) {
      const vp = state.viewportRange;
      await evaluateViewport(vp.startRow, vp.startCol, vp.endRow, vp.endCol);
    }
    markSheetDirty();
    requestOverlayRedraw();
  }, 200);
}

/** Immediately invalidate and re-evaluate (used after rule changes) */
export async function invalidateAndRefresh(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  await refreshRules();

  // Use tracked viewport or a sensible default for the first evaluation
  const vp = state.viewportRange ?? { startRow: 0, startCol: 0, endRow: 100, endCol: 30 };
  await evaluateViewport(vp.startRow, vp.startCol, vp.endRow, vp.endCol);

  markSheetDirty();
  requestOverlayRedraw();
}

// ============================================================================
// Grid Region Sync (for Data Bars and Icon Sets)
// ============================================================================

/** Sync grid overlay regions from evaluation cache */
function syncOverlayRegions(): void {
  syncDataBarRegions();
  syncIconSetRegions();
}

/** Create grid regions for cells with data bar results */
function syncDataBarRegions(): void {
  removeGridRegionsByType("cf-data-bar");

  const regions: GridRegion[] = [];
  for (const [key, cfs] of state.evaluationCache) {
    for (const cf of cfs) {
      if (cf.dataBarPercent != null) {
        const [row, col] = key.split(",").map(Number);
        regions.push({
          id: `cf-data-bar-${row}-${col}`,
          type: "cf-data-bar",
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
          data: {
            percent: cf.dataBarPercent,
            ruleId: findMatchingRuleId(row, col, "dataBar"),
          },
        });
      }
    }
  }

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}

/** Create grid regions for cells with icon set results */
function syncIconSetRegions(): void {
  removeGridRegionsByType("cf-icon-set");

  const regions: GridRegion[] = [];
  for (const [key, cfs] of state.evaluationCache) {
    for (const cf of cfs) {
      if (cf.iconIndex != null) {
        const [row, col] = key.split(",").map(Number);
        regions.push({
          id: `cf-icon-set-${row}-${col}`,
          type: "cf-icon-set",
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
          data: {
            iconIndex: cf.iconIndex,
            // No `ruleId` for icon sets: the renderer reads `cf.iconSet` from the
            // backend's resolved result now (BUG-0107). `findMatchingRuleId` is
            // enabled-blind and priority-blind, so using it to pick a glyph family
            // drew icons from rules the user had switched off. The dataBar use
            // above is untouched — that one is a different question.
          },
        });
      }
    }
  }

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}

/** Find the matching rule ID for a cell and rule type */
function findMatchingRuleId(
  row: number,
  col: number,
  ruleType: string
): number | null {
  for (const rule of state.rules) {
    if (
      rule.rule.type === ruleType &&
      rule.ranges.some(
        (r) =>
          row >= r.startRow &&
          row <= r.endRow &&
          col >= r.startCol &&
          col <= r.endCol
      )
    ) {
      return rule.id;
    }
  }
  return null;
}

// ============================================================================
// State Reset
// ============================================================================

/** Reset all state (used on sheet change or unregister) */
export function resetState(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  state = {
    rules: [],
    evaluationCache: new Map(),
    viewportRange: null,
    dirty: true,
  };
  // A read in flight belongs to the old sheet: it must not land.
  iconAlignGeneration++;
  iconAlign = new Map();

  removeGridRegionsByType("cf-data-bar");
  removeGridRegionsByType("cf-icon-set");
}
