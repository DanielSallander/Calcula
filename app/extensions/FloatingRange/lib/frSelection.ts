//! FILENAME: app/extensions/FloatingRange/lib/frSelection.ts
// PURPOSE: Module-global selection state: object selection (which FRs carry
//          chrome) + the FR-LOCAL cell selection (the private A1 space).
// CONTEXT: Precedent Controls/Button/floatingSelection.ts. The two selections
//          are deliberately separate: Delete clears CELLS while a local
//          selection exists and deletes the OBJECT only when none does.
//
//          The OBJECT selection's mutations are selection chokepoints: each
//          change is announced to the canvas-wide selection set
//          (@api/objectSelection `notifyObjectSelectionChanged`).

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

let localSelection: FrLocalSelection | null = null;

export function setLocalSelection(sel: FrLocalSelection | null): void {
  localSelection = sel;
}

export function getLocalSelection(): FrLocalSelection | null {
  return localSelection;
}

export function clearLocalSelection(): void {
  localSelection = null;
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
  if (extend) {
    localSelection.endRow = clampRow(localSelection.endRow + dRow);
    localSelection.endCol = clampCol(localSelection.endCol + dCol);
  } else {
    const row = clampRow(localSelection.anchorRow + dRow);
    const col = clampCol(localSelection.anchorCol + dCol);
    localSelection.anchorRow = row;
    localSelection.anchorCol = col;
    localSelection.endRow = row;
    localSelection.endCol = col;
  }
}

/** Reset everything (document change, deactivate). */
export function resetFrSelection(): void {
  const had = selectedFrIds.size > 0;
  selectedFrIds.clear();
  localSelection = null;
  if (had) notifyObjectSelectionChanged();
}
