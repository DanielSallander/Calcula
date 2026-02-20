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
} from "../../../src/api";

import type {
  ConditionalFormatDefinition,
  CellConditionalFormat,
  GridRegion,
} from "../../../src/api";

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

// ============================================================================
// Getters
// ============================================================================

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
  if (state.rules.length === 0) {
    state.evaluationCache.clear();
    syncOverlayRegions();
    return;
  }

  // Add buffer around viewport for smoother scrolling
  const bufferRows = 20;
  const bufferCols = 5;
  const evalStartRow = Math.max(0, startRow - bufferRows);
  const evalStartCol = Math.max(0, startCol - bufferCols);
  const evalEndRow = endRow + bufferRows;
  const evalEndCol = endCol + bufferCols;

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

    state.viewportRange = {
      startRow: evalStartRow,
      startCol: evalStartCol,
      endRow: evalEndRow,
      endCol: evalEndCol,
    };
    state.dirty = false;

    syncOverlayRegions();
    emitAppEvent(CFEvents.EVALUATION_UPDATED);
  } catch (error) {
    console.error(
      "[ConditionalFormatting] Failed to evaluate viewport:",
      error
    );
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

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (state.dirty && state.viewportRange) {
      const vp = state.viewportRange;
      evaluateViewport(vp.startRow, vp.startCol, vp.endRow, vp.endCol);
    }
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

  if (state.viewportRange) {
    const vp = state.viewportRange;
    await evaluateViewport(vp.startRow, vp.startCol, vp.endRow, vp.endCol);
  }

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
            ruleId: findMatchingRuleId(row, col, "iconSet"),
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

  removeGridRegionsByType("cf-data-bar");
  removeGridRegionsByType("cf-icon-set");
}
