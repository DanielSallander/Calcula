//! FILENAME: app/extensions/Pivot/lib/pivotVisualCellSelection.ts
// PURPOSE: The INNER cell selection of a canvas pivot box (D-CELLS, owner
//          finding F4): one rectangle of VIEW cells -- an anchor (the active
//          cell, where the press or the keyboard started) and an end (where a
//          drag or Shift+click/Shift+arrow reached) -- inside the ONE box that
//          holds it. A box's cells are content: click, Shift+click and drag
//          select them (pivotCellPress.ts), the box paints them
//          (pivotVisualOverlay.ts), the menu, the keys, the copy and the
//          formula bar read them.
// CONTEXT: No imports, on purpose: the box's object-selection provider, the
//          selection handler and the hit records import this module, and none
//          of them may pull the pivot IPC module (or each other) in through it.
//          Every change notifies `onPivotCellSelectionChanged` listeners; the
//          box's installation repaints from there.
//
//          WHICH SHEET. The rectangle is in view coordinates of one pivot, and
//          a pivot id names one pivot in the workbook, so the box is known --
//          but WP-B's hide/unhide of a non-active page and every "sheets"-domain
//          refresh fan out a DETAIL-LESS `SHEET_CHANGED` while the user stays
//          on the same canvas. So the store records the active sheet index the
//          selection was made on (`setPivotCellSheetSource`, injected by the
//          box's installation) and `clearPivotCellSelectionIfSheetChanged`
//          clears only on a real difference.

/** The selection, in VIEW coordinates of `pivotId`'s view (anchor = the active cell). */
export interface PivotCellSelection {
  pivotId: string;
  anchorRow: number;
  anchorCol: number;
  endRow: number;
  endCol: number;
}

/** A normalized rectangle (start <= end on both axes). */
export interface PivotCellRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

let selection: PivotCellSelection | null = null;
/** The active sheet index the selection was made on (null: not known). */
let selectionSheetIndex: number | null = null;
let sheetSource: () => number | undefined = () => undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (err) {
      console.error("[PivotCellSelection] a listener threw:", err);
    }
  }
}

function isCellIndex(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}

function same(a: PivotCellSelection | null, b: PivotCellSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.pivotId === b.pivotId &&
    a.anchorRow === b.anchorRow &&
    a.anchorCol === b.anchorCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol
  );
}

/** Replace the selection; notifies only when it changed. */
function commit(next: PivotCellSelection | null, recordSheet: boolean): void {
  if (recordSheet && next !== null) {
    const idx = sheetSource();
    selectionSheetIndex = typeof idx === "number" && Number.isInteger(idx) ? idx : null;
  }
  if (next === null) selectionSheetIndex = null;
  if (same(selection, next)) return;
  selection = next === null ? null : { ...next };
  notify();
}

/**
 * Where the store reads the ACTIVE sheet index from when a selection is made
 * (the box's installation passes the grid snapshot's). Returns the previous
 * source's restore.
 */
export function setPivotCellSheetSource(source: () => number | undefined): () => void {
  const previous = sheetSource;
  sheetSource = source;
  return () => {
    if (sheetSource === source) sheetSource = previous;
  };
}

/** The selection, or null. A copy: writing to it changes nothing. */
export function getPivotCellSelection(): PivotCellSelection | null {
  return selection === null ? null : { ...selection };
}

/** Whether any box has a cell selection. */
export function hasPivotCellSelection(): boolean {
  return selection !== null;
}

/** Start a selection at one cell of `pivotId` (a click, an arrow, a re-anchor). */
export function setPivotCellAnchor(pivotId: string, viewRow: number, viewCol: number): void {
  if (!pivotId || !isCellIndex(viewRow) || !isCellIndex(viewCol)) return;
  commit({ pivotId, anchorRow: viewRow, anchorCol: viewCol, endRow: viewRow, endCol: viewCol }, true);
}

/** Move the END of the current selection (Shift+click, a drag); no-op without one. */
export function extendPivotCellSelection(viewRow: number, viewCol: number): void {
  if (selection === null || !isCellIndex(viewRow) || !isCellIndex(viewCol)) return;
  commit({ ...selection, endRow: viewRow, endCol: viewCol }, false);
}

/** Set the whole selection (Ctrl+A, a restore); null clears. */
export function setPivotCellSelection(sel: PivotCellSelection | null): void {
  if (sel === null) {
    commit(null, false);
    return;
  }
  if (
    !sel.pivotId ||
    !isCellIndex(sel.anchorRow) ||
    !isCellIndex(sel.anchorCol) ||
    !isCellIndex(sel.endRow) ||
    !isCellIndex(sel.endCol)
  ) {
    return;
  }
  commit(sel, true);
}

/** Clear the selection (no-op when there is none). */
export function clearPivotCellSelection(): void {
  commit(null, false);
}

/** The selection as a normalized rectangle (either drag direction). */
export function pivotCellRect(sel: PivotCellSelection): PivotCellRect {
  return {
    startRow: Math.min(sel.anchorRow, sel.endRow),
    startCol: Math.min(sel.anchorCol, sel.endCol),
    endRow: Math.max(sel.anchorRow, sel.endRow),
    endCol: Math.max(sel.anchorCol, sel.endCol),
  };
}

/** Whether a view cell lies in the current selection's rectangle. */
export function isViewCellSelected(viewRow: number, viewCol: number): boolean {
  if (selection === null) return false;
  const r = pivotCellRect(selection);
  return viewRow >= r.startRow && viewRow <= r.endRow && viewCol >= r.startCol && viewCol <= r.endCol;
}

/**
 * A new view of `pivotId` arrived (a refilter, a collapse, a field change):
 * clamp the END into its size, and clear when the ANCHOR fell outside it (the
 * active cell no longer exists). Other pivots' views change nothing.
 */
export function clampPivotCellSelection(pivotId: string, rowCount: number, colCount: number): void {
  if (selection === null || selection.pivotId !== pivotId) return;
  if (
    !(rowCount > 0) ||
    !(colCount > 0) ||
    selection.anchorRow >= rowCount ||
    selection.anchorCol >= colCount
  ) {
    commit(null, false);
    return;
  }
  commit(
    {
      ...selection,
      endRow: Math.min(selection.endRow, rowCount - 1),
      endCol: Math.min(selection.endCol, colCount - 1),
    },
    false,
  );
}

/**
 * The selection's rectangle in the canvas's HIDDEN GRID: the view rectangle
 * offset by the pivot's anchor cell (`startRow`, `startCol` of its region).
 */
export function pivotCellGridRange(sel: PivotCellSelection, startRow: number, startCol: number): PivotCellRect {
  const r = pivotCellRect(sel);
  return {
    startRow: startRow + r.startRow,
    startCol: startCol + r.startCol,
    endRow: startRow + r.endRow,
    endCol: startCol + r.endCol,
  };
}

/**
 * The ACTIVE sheet changed -- or a `SHEET_CHANGED` announced something else
 * (a detail-less one: hide/unhide of another page, a "sheets" refresh).
 * Clears the selection only when `activeSheetIndex` differs from the sheet it
 * was made on; an index that cannot be told (none passed and none from the
 * source, or none recorded) clears, since a selection on a page the user left
 * must never outlive it. Returns whether it cleared.
 */
export function clearPivotCellSelectionIfSheetChanged(activeSheetIndex?: number): boolean {
  if (selection === null) return false;
  const now = typeof activeSheetIndex === "number" ? activeSheetIndex : sheetSource();
  if (typeof now === "number" && selectionSheetIndex !== null && now === selectionSheetIndex) return false;
  commit(null, false);
  return true;
}

/** Subscribe to every change of the selection; returns the unsubscribe. */
export function onPivotCellSelectionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the selection (deactivate, a new document). Listeners hear it; they stay subscribed. */
export function resetPivotCellSelection(): void {
  selectionSheetIndex = null;
  if (selection === null) return;
  selection = null;
  notify();
}
