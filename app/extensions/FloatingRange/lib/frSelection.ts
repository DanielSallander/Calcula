//! FILENAME: app/extensions/FloatingRange/lib/frSelection.ts
// PURPOSE: Module-global selection state: object selection (which FRs carry
//          chrome) + the FR-LOCAL cell selection (the private A1 space).
// CONTEXT: Precedent Controls/Button/floatingSelection.ts. The two selections
//          are deliberately separate: Delete clears CELLS while a local
//          selection exists and deletes the OBJECT only when none does.
//
//          The OBJECT selection's mutations are selection chokepoints: each
//          change is announced to the canvas-wide selection set
//          (@api/objectSelection `notifyObjectSelectionChanged`). The LOCAL
//          selection's are too, to this extension's own listeners
//          (`onLocalSelectionChanged`): the formula-bar publisher
//          (lib/frFormulaBar.ts) shows the active cell and ends an edit whose
//          cell the selection left.

import { notifyObjectSelectionChanged } from "@api/objectSelection";

// ============================================================================
// Object selection
// ============================================================================

const selectedFrIds = new Set<string>();

/** Replace the object selection with a single FR. */
export function selectFloatingRange(frId: string): void {
  if (selectedFrIds.size === 1 && selectedFrIds.has(frId)) return;
  selectedFrIds.clear();
  selectedFrIds.add(frId);
  notifyObjectSelectionChanged();
}

export function deselectAllFloatingRanges(): void {
  if (selectedFrIds.size === 0) return;
  selectedFrIds.clear();
  notifyObjectSelectionChanged();
}

export function isFloatingRangeSelected(frId: string): boolean {
  return selectedFrIds.has(frId);
}

/** The selected FR id, or null. (Single-select in v1.) */
export function getSelectedFloatingRange(): string | null {
  for (const id of selectedFrIds) return id;
  return null;
}

export function hasFloatingRangeSelection(): boolean {
  return selectedFrIds.size > 0;
}

// ============================================================================
// FR-local cell selection
// ============================================================================

export interface FrLocalSelection {
  frId: string;
  anchorRow: number;
  anchorCol: number;
  endRow: number;
  endCol: number;
}

/**
 * The local selection is IMMUTABLE once stored: every change replaces the
 * object and announces itself (`onLocalSelectionChanged`). It used to be
 * mutated in place (the move below, and the drag-extend in index.ts wrote
 * `sel.endRow = ...` straight into it), which no listener could see -- and the
 * formula bar and the Name Box show the active cell, so they have to.
 */
let localSelection: FrLocalSelection | null = null;

const localSelectionListeners = new Set<() => void>();

/**
 * Hear every change of the FR-local cell selection (set with a different
 * value, clear of a non-null selection, a move that moved, an extend, a reset
 * that dropped one). Identical re-sets are silent. Returns the unsubscribe.
 */
export function onLocalSelectionChanged(listener: () => void): () => void {
  localSelectionListeners.add(listener);
  return () => {
    localSelectionListeners.delete(listener);
  };
}

function notifyLocalSelectionChanged(): void {
  // A COPY: a listener may (un)subscribe, or change the selection again.
  for (const listener of [...localSelectionListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[FloatingRange] local-selection listener threw:", err);
    }
  }
}

function sameLocalSelection(a: FrLocalSelection | null, b: FrLocalSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.frId === b.frId &&
    a.anchorRow === b.anchorRow &&
    a.anchorCol === b.anchorCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol
  );
}

export function setLocalSelection(sel: FrLocalSelection | null): void {
  if (sameLocalSelection(localSelection, sel)) return;
  localSelection = sel ? { ...sel } : null;
  notifyLocalSelectionChanged();
}

export function getLocalSelection(): FrLocalSelection | null {
  return localSelection;
}

export function clearLocalSelection(): void {
  if (localSelection === null) return;
  localSelection = null;
  notifyLocalSelectionChanged();
}

/**
 * Drag-extend: set the moving END (the caller clamps it). Notifies when it
 * moved. No-op without a local selection.
 */
export function extendLocalSelection(endRow: number, endCol: number): void {
  if (!localSelection) return;
  if (localSelection.endRow === endRow && localSelection.endCol === endCol) return;
  localSelection = { ...localSelection, endRow, endCol };
  notifyLocalSelectionChanged();
}

/** Normalized [minRow, minCol, maxRow, maxCol] of the local selection. */
export function localSelectionRect(
  sel: FrLocalSelection,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
  return {
    minRow: Math.min(sel.anchorRow, sel.endRow),
    minCol: Math.min(sel.anchorCol, sel.endCol),
    maxRow: Math.max(sel.anchorRow, sel.endRow),
    maxCol: Math.max(sel.anchorCol, sel.endCol),
  };
}

/**
 * Move (or Shift-extend) the local selection by a delta, clamped to the FR
 * window. Plain moves collapse to the moved active cell.
 */
export function moveLocalSelection(
  dRow: number,
  dCol: number,
  extend: boolean,
  rows: number,
  cols: number,
): void {
  if (!localSelection) return;
  const clampRow = (r: number) => Math.max(0, Math.min(rows - 1, r));
  const clampCol = (c: number) => Math.max(0, Math.min(cols - 1, c));
  let next: FrLocalSelection;
  if (extend) {
    next = {
      ...localSelection,
      endRow: clampRow(localSelection.endRow + dRow),
      endCol: clampCol(localSelection.endCol + dCol),
    };
  } else {
    const row = clampRow(localSelection.anchorRow + dRow);
    const col = clampCol(localSelection.anchorCol + dCol);
    next = { ...localSelection, anchorRow: row, anchorCol: col, endRow: row, endCol: col };
  }
  // Only a move that MOVED announces itself (an arrow against the edge is silent).
  if (sameLocalSelection(localSelection, next)) return;
  localSelection = next;
  notifyLocalSelectionChanged();
}

/** Reset everything (document change, deactivate). */
export function resetFrSelection(): void {
  const had = selectedFrIds.size > 0;
  const hadLocal = localSelection !== null;
  selectedFrIds.clear();
  localSelection = null;
  if (had) notifyObjectSelectionChanged();
  if (hadLocal) notifyLocalSelectionChanged();
}
