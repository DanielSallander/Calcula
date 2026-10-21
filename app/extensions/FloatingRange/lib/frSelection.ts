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

/** An inclusive rectangle of local cells (start <= end on both axes). */
export interface FrCellArea {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface FrLocalSelection {
  frId: string;
  /** The ACTIVE cell (where F2 / typing edits). */
  anchorRow: number;
  anchorCol: number;
  /** The moving end of the main rectangle. */
  endRow: number;
  endCol: number;
  /**
   * FURTHER rectangles of a multi-area selection (a Go To Special result, a
   * Find All selection), besides the main anchor..end one. Absent or empty: a
   * single rectangle. The renderer paints all of them; a move or an extend
   * collapses back to the main one.
   */
  areas?: FrCellArea[];
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

function sameAreas(a: readonly FrCellArea[] | undefined, b: readonly FrCellArea[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (
      x[i].startRow !== y[i].startRow ||
      x[i].startCol !== y[i].startCol ||
      x[i].endRow !== y[i].endRow ||
      x[i].endCol !== y[i].endCol
    ) {
      return false;
    }
  }
  return true;
}

function sameLocalSelection(a: FrLocalSelection | null, b: FrLocalSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.frId === b.frId &&
    a.anchorRow === b.anchorRow &&
    a.anchorCol === b.anchorCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol &&
    sameAreas(a.areas, b.areas)
  );
}

/** A stored copy: the areas normalized (start <= end) and copied, absent when empty. */
function storedCopy(sel: FrLocalSelection): FrLocalSelection {
  const { areas, ...main } = sel;
  if (!areas || areas.length === 0) return { ...main };
  return {
    ...main,
    areas: areas.map((a) => ({
      startRow: Math.min(a.startRow, a.endRow),
      startCol: Math.min(a.startCol, a.endCol),
      endRow: Math.max(a.startRow, a.endRow),
      endCol: Math.max(a.startCol, a.endCol),
    })),
  };
}

export function setLocalSelection(sel: FrLocalSelection | null): void {
  const next = sel ? storedCopy(sel) : null;
  if (sameLocalSelection(localSelection, next)) return;
  localSelection = next;
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
  const hadAreas = (localSelection.areas?.length ?? 0) > 0;
  if (localSelection.endRow === endRow && localSelection.endCol === endCol && !hadAreas) return;
  // An extend works on the MAIN rectangle: further areas collapse away.
  const { areas: _dropped, ...main } = localSelection;
  localSelection = { ...main, endRow, endCol };
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
 * What a move must know about the object's lines (P3): which rows / columns
 * it hides (a move steps OVER them, as Excel's arrow skips hidden rows) and
 * which merged region a cell belongs to (a move lands on the merge as a
 * whole, and leaves it from its far edge). Absent: every line shown, no merges.
 */
export interface FrMoveLines {
  rowHidden?: (row: number) => boolean;
  colHidden?: (col: number) => boolean;
  mergeAt?: (row: number, col: number) => FrCellArea | null;
}

function stepOver(hidden: ((i: number) => boolean) | undefined, from: number, delta: number, count: number): number {
  if (delta === 0) return from;
  const isHidden = hidden ?? (() => false);
  const dir = delta > 0 ? 1 : -1;
  let at = from;
  for (let n = Math.abs(delta); n > 0; n--) {
    let next = at + dir;
    while (next >= 0 && next < count && isHidden(next)) next += dir;
    if (next < 0 || next >= count) break;
    at = next;
  }
  return at;
}

/**
 * Move (or Shift-extend) the local selection by a delta, clamped to the FR
 * window. Plain moves collapse to the moved active cell. With `lines`, a move
 * skips hidden lines and SNAPS to merges: it leaves a merge from its far edge
 * and, landing inside one, selects the whole merge with its top-left cell
 * active (Excel's rule).
 */
export function moveLocalSelection(
  dRow: number,
  dCol: number,
  extend: boolean,
  rows: number,
  cols: number,
  lines: FrMoveLines = {},
): void {
  if (!localSelection) return;
  const clampRow = (r: number) => Math.max(0, Math.min(rows - 1, r));
  const clampCol = (c: number) => Math.max(0, Math.min(cols - 1, c));
  const { areas: _dropped, ...current } = localSelection;
  let next: FrLocalSelection;
  if (extend) {
    next = {
      ...current,
      endRow: clampRow(stepOver(lines.rowHidden, current.endRow, dRow, rows)),
      endCol: clampCol(stepOver(lines.colHidden, current.endCol, dCol, cols)),
    };
  } else {
    // Leave a merge from the edge the move goes through.
    const from = lines.mergeAt?.(current.anchorRow, current.anchorCol) ?? null;
    const baseRow = from ? (dRow > 0 ? from.endRow : from.startRow) : current.anchorRow;
    const baseCol = from ? (dCol > 0 ? from.endCol : from.startCol) : current.anchorCol;
    let row = clampRow(stepOver(lines.rowHidden, baseRow, dRow, rows));
    let col = clampCol(stepOver(lines.colHidden, baseCol, dCol, cols));
    // A move that went nowhere stays on the merge it was on.
    if (from && row === baseRow && col === baseCol && (dRow !== 0 || dCol !== 0)) {
      row = current.anchorRow;
      col = current.anchorCol;
    }
    const into = lines.mergeAt?.(row, col) ?? null;
    next = into
      ? { ...current, anchorRow: into.startRow, anchorCol: into.startCol, endRow: into.endRow, endCol: into.endCol }
      : { ...current, anchorRow: row, anchorCol: col, endRow: row, endCol: col };
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
