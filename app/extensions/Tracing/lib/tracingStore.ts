//! FILENAME: app/extensions/Tracing/lib/tracingStore.ts
// PURPOSE: State management for the Tracing extension.
// CONTEXT: Maintains the list of active trace arrows, trace levels,
//          and frontier cells for multi-level expansion.

import {
  tracePrecedents,
  traceDependents,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
} from "../../../src/api";
import type { TraceResult } from "../../../src/api";
import type { TraceArrow, TraceDirection } from "../types";

// ============================================================================
// Constants
// ============================================================================

const REGION_TYPE = "tracing";

// ============================================================================
// Module State
// ============================================================================

/** All currently displayed arrows. */
let arrows: TraceArrow[] = [];

/** Current trace level for precedents (0 = none, 1 = direct, 2 = inputs of inputs...) */
let precedentLevel = 0;

/** Current trace level for dependents */
let dependentLevel = 0;

/** The cell we are tracing (or null if no trace active). */
let tracedCell: { row: number; col: number } | null = null;

/**
 * Frontier cells at each level: the set of cell keys (e.g. "3,5") that were
 * discovered at that level and need to be expanded at the next level.
 */
const precedentFrontier: Map<number, Set<string>> = new Map();
const dependentFrontier: Map<number, Set<string>> = new Map();

/** All cells already visited (prevents cycles from causing infinite expansion). */
const visitedPrecedents = new Set<string>();
const visitedDependents = new Set<string>();

/** Current selection tracked from the extension entry point. */
let currentSelection: { row: number; col: number } | null = null;

/** Next arrow ID counter. */
let nextArrowId = 0;

// ============================================================================
// Public API - State Access
// ============================================================================

/** Get all currently active trace arrows (for the renderer). */
export function getArrows(): TraceArrow[] {
  return arrows;
}

/** Set the current selection (called from the extension entry point). */
export function setCurrentSelection(
  sel: { row: number; col: number } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Public API - Trace Operations
// ============================================================================

/**
 * Add one level of precedent tracing.
 * - First call: traces the selected cell's direct precedents (level 1).
 * - Subsequent calls: traces precedents of the previous frontier (level N).
 */
export async function addPrecedentLevel(): Promise<void> {
  const sel = currentSelection;
  if (!sel) return;

  // If the traced cell changed, clear everything first
  if (tracedCell && (tracedCell.row !== sel.row || tracedCell.col !== sel.col)) {
    clearTraces();
  }

  tracedCell = { row: sel.row, col: sel.col };

  if (precedentLevel === 0) {
    // Level 1: trace the selected cell directly
    const cellKey = `${sel.row},${sel.col}`;
    visitedPrecedents.add(cellKey);

    const result = await tracePrecedents(sel.row, sel.col);
    const newArrows = buildArrowsFromResult(result, "precedents", 1);
    arrows = [...arrows, ...newArrows];

    // Build the frontier for the next level
    const frontier = new Set<string>();
    for (const arrow of newArrows) {
      if (!arrow.isCrossSheet) {
        if (arrow.targetRange) {
          // For ranges, add all cells in the range to the frontier
          for (let r = arrow.targetRange.startRow; r <= arrow.targetRange.endRow; r++) {
            for (let c = arrow.targetRange.startCol; c <= arrow.targetRange.endCol; c++) {
              const key = `${r},${c}`;
              if (!visitedPrecedents.has(key)) {
                frontier.add(key);
                visitedPrecedents.add(key);
              }
            }
          }
        } else {
          const key = `${arrow.targetRow},${arrow.targetCol}`;
          if (!visitedPrecedents.has(key)) {
            frontier.add(key);
            visitedPrecedents.add(key);
          }
        }
      }
    }
    precedentFrontier.set(1, frontier);
  } else {
    // Level N+1: trace all frontier cells from level N
    const currentFrontier = precedentFrontier.get(precedentLevel);
    if (!currentFrontier || currentFrontier.size === 0) return;

    const newLevel = precedentLevel + 1;
    const nextFrontier = new Set<string>();
    const newArrows: TraceArrow[] = [];

    for (const cellKey of currentFrontier) {
      const [r, c] = cellKey.split(",").map(Number);
      const result = await tracePrecedents(r, c);
      const levelArrows = buildArrowsFromResult(result, "precedents", newLevel);
      newArrows.push(...levelArrows);

      for (const arrow of levelArrows) {
        if (!arrow.isCrossSheet) {
          if (arrow.targetRange) {
            for (let rr = arrow.targetRange.startRow; rr <= arrow.targetRange.endRow; rr++) {
              for (let cc = arrow.targetRange.startCol; cc <= arrow.targetRange.endCol; cc++) {
                const key = `${rr},${cc}`;
                if (!visitedPrecedents.has(key)) {
                  nextFrontier.add(key);
                  visitedPrecedents.add(key);
                }
              }
            }
          } else {
            const key = `${arrow.targetRow},${arrow.targetCol}`;
            if (!visitedPrecedents.has(key)) {
              nextFrontier.add(key);
              visitedPrecedents.add(key);
            }
          }
        }
      }
    }

    if (newArrows.length > 0) {
      arrows = [...arrows, ...newArrows];
      precedentFrontier.set(newLevel, nextFrontier);
    }
  }

  precedentLevel++;
  ensureOverlayRegion();
  requestOverlayRedraw();
}

/**
 * Add one level of dependent tracing.
 * - First call: traces the selected cell's direct dependents (level 1).
 * - Subsequent calls: traces dependents of the previous frontier (level N).
 */
export async function addDependentLevel(): Promise<void> {
  const sel = currentSelection;
  if (!sel) return;

  // If the traced cell changed, clear everything first
  if (tracedCell && (tracedCell.row !== sel.row || tracedCell.col !== sel.col)) {
    clearTraces();
  }

  tracedCell = { row: sel.row, col: sel.col };

  if (dependentLevel === 0) {
    const cellKey = `${sel.row},${sel.col}`;
    visitedDependents.add(cellKey);

    const result = await traceDependents(sel.row, sel.col);
    const newArrows = buildArrowsFromResult(result, "dependents", 1);
    arrows = [...arrows, ...newArrows];

    const frontier = new Set<string>();
    for (const arrow of newArrows) {
      if (!arrow.isCrossSheet) {
        if (arrow.targetRange) {
          for (let r = arrow.targetRange.startRow; r <= arrow.targetRange.endRow; r++) {
            for (let c = arrow.targetRange.startCol; c <= arrow.targetRange.endCol; c++) {
              const key = `${r},${c}`;
              if (!visitedDependents.has(key)) {
                frontier.add(key);
                visitedDependents.add(key);
              }
            }
          }
        } else {
          const key = `${arrow.targetRow},${arrow.targetCol}`;
          if (!visitedDependents.has(key)) {
            frontier.add(key);
            visitedDependents.add(key);
          }
        }
      }
    }
    dependentFrontier.set(1, frontier);
  } else {
    const currentFrontier = dependentFrontier.get(dependentLevel);
    if (!currentFrontier || currentFrontier.size === 0) return;

    const newLevel = dependentLevel + 1;
    const nextFrontier = new Set<string>();
    const newArrows: TraceArrow[] = [];

    for (const cellKey of currentFrontier) {
      const [r, c] = cellKey.split(",").map(Number);
      const result = await traceDependents(r, c);
      const levelArrows = buildArrowsFromResult(result, "dependents", newLevel);
      newArrows.push(...levelArrows);

      for (const arrow of levelArrows) {
        if (!arrow.isCrossSheet) {
          if (arrow.targetRange) {
            for (let rr = arrow.targetRange.startRow; rr <= arrow.targetRange.endRow; rr++) {
              for (let cc = arrow.targetRange.startCol; cc <= arrow.targetRange.endCol; cc++) {
                const key = `${rr},${cc}`;
                if (!visitedDependents.has(key)) {
                  nextFrontier.add(key);
                  visitedDependents.add(key);
                }
              }
            }
          } else {
            const key = `${arrow.targetRow},${arrow.targetCol}`;
            if (!visitedDependents.has(key)) {
              nextFrontier.add(key);
              visitedDependents.add(key);
            }
          }
        }
      }
    }

    if (newArrows.length > 0) {
      arrows = [...arrows, ...newArrows];
      dependentFrontier.set(newLevel, nextFrontier);
    }
  }

  dependentLevel++;
  ensureOverlayRegion();
  requestOverlayRedraw();
}

/** Remove all trace arrows and reset state. */
export function removeAllArrows(): void {
  clearTraces();
}

/** Clear all tracing state (called on sheet change, cell edits, etc.). */
export function clearTraces(): void {
  arrows = [];
  precedentLevel = 0;
  dependentLevel = 0;
  tracedCell = null;
  precedentFrontier.clear();
  dependentFrontier.clear();
  visitedPrecedents.clear();
  visitedDependents.clear();
  nextArrowId = 0;
  removeGridRegionsByType(REGION_TYPE);
  requestOverlayRedraw();
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Ensure a single "tracing" grid region exists so the overlay renderer is called. */
function ensureOverlayRegion(): void {
  if (arrows.length > 0) {
    // Remove old and add a fresh region to trigger the renderer
    removeGridRegionsByType(REGION_TYPE);
    addGridRegions([
      {
        id: "tracing-overlay",
        type: REGION_TYPE,
        startRow: 0,
        startCol: 0,
        endRow: 999999,
        endCol: 999999,
      },
    ]);
  } else {
    removeGridRegionsByType(REGION_TYPE);
  }
}

/**
 * Build TraceArrow objects from a backend TraceResult.
 *
 * For "precedents" direction, arrows point FROM the referenced cell/range TO the source.
 * For "dependents" direction, arrows point FROM the source TO the dependent cell/range.
 */
function buildArrowsFromResult(
  result: TraceResult,
  direction: TraceDirection,
  level: number,
): TraceArrow[] {
  const built: TraceArrow[] = [];
  const sourceRow = result.sourceRow;
  const sourceCol = result.sourceCol;

  // Individual cell references
  for (const cell of result.cells) {
    const isError = cell.isError || result.sourceIsError;
    built.push({
      id: `trace-${nextArrowId++}`,
      direction,
      sourceRow,
      sourceCol,
      targetRow: cell.row,
      targetCol: cell.col,
      isCrossSheet: false,
      style: isError ? "solid-red" : "solid-blue",
      level,
    });
  }

  // Range references
  for (const range of result.ranges) {
    const isError = range.hasError || result.sourceIsError;
    // Arrow target: center cell of the range
    const centerRow = Math.floor((range.startRow + range.endRow) / 2);
    const centerCol = Math.floor((range.startCol + range.endCol) / 2);
    built.push({
      id: `trace-${nextArrowId++}`,
      direction,
      sourceRow,
      sourceCol,
      targetRow: centerRow,
      targetCol: centerCol,
      targetRange: {
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
      },
      isCrossSheet: false,
      style: isError ? "solid-red" : "solid-blue",
      level,
    });
  }

  // Cross-sheet references
  for (const csRef of result.crossSheetRefs) {
    const isError = csRef.isError || result.sourceIsError;
    built.push({
      id: `trace-${nextArrowId++}`,
      direction,
      sourceRow,
      sourceCol,
      // Target is a virtual position near the source (the icon will be drawn there)
      targetRow: sourceRow,
      targetCol: sourceCol,
      isCrossSheet: true,
      crossSheetInfo: {
        sheetName: csRef.sheetName,
        sheetIndex: csRef.sheetIndex,
        row: csRef.row,
        col: csRef.col,
      },
      style: isError ? "solid-red" : "dashed-black",
      level,
    });
  }

  return built;
}
