//! FILENAME: app/extensions/SelectVisibleCells/index.ts
// PURPOSE: Select Visible Cells extension.
// CONTEXT: Adjusts the current selection to exclude hidden rows and columns,
//          creating a multi-selection of only visible cells. Like Excel's
//          "Go To Special > Visible Cells Only" (Alt+;).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerMenuItem,
  dispatchGridAction,
  setSelection,
  showToast,
  IconSelectVisibleCells,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Select only visible cells within the current selection.
 *
 * Algorithm:
 * 1. Get the current selection bounds and hidden rows/cols.
 * 2. Build contiguous row-bands of visible rows within the selection.
 * 3. For each row-band, build contiguous column-spans of visible columns.
 * 4. Emit a multi-selection (primary + additionalRanges) covering only visible cells.
 *
 * This uses row/column bands rather than individual cells to keep the selection
 * compact (e.g. 3 visible row-bands x 2 visible col-spans = 6 ranges, not N*M cells).
 */
function selectVisibleCells(): void {
  const state = getGridStateSnapshot();
  if (!state?.selection) {
    showToast({ message: "No selection", type: "warning" });
    return;
  }

  const sel = state.selection;
  const hiddenRows = state.dimensions.hiddenRows ?? new Set<number>();
  const hiddenCols = state.dimensions.hiddenCols ?? new Set<number>();

  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);

  // Build contiguous bands of visible rows
  const rowBands: Array<{ start: number; end: number }> = [];
  let bandStart: number | null = null;
  for (let r = minRow; r <= maxRow; r++) {
    if (!hiddenRows.has(r)) {
      if (bandStart === null) bandStart = r;
    } else {
      if (bandStart !== null) {
        rowBands.push({ start: bandStart, end: r - 1 });
        bandStart = null;
      }
    }
  }
  if (bandStart !== null) {
    rowBands.push({ start: bandStart, end: maxRow });
  }

  // Build contiguous spans of visible columns
  const colSpans: Array<{ start: number; end: number }> = [];
  let spanStart: number | null = null;
  for (let c = minCol; c <= maxCol; c++) {
    if (!hiddenCols.has(c)) {
      if (spanStart === null) spanStart = c;
    } else {
      if (spanStart !== null) {
        colSpans.push({ start: spanStart, end: c - 1 });
        spanStart = null;
      }
    }
  }
  if (spanStart !== null) {
    colSpans.push({ start: spanStart, end: maxCol });
  }

  if (rowBands.length === 0 || colSpans.length === 0) {
    showToast({ message: "No visible cells in selection", type: "info" });
    return;
  }

  // Build all visible ranges (cross-product of row-bands x col-spans)
  const ranges: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> = [];
  for (const rb of rowBands) {
    for (const cs of colSpans) {
      ranges.push({
        startRow: rb.start,
        startCol: cs.start,
        endRow: rb.end,
        endCol: cs.end,
      });
    }
  }

  // First range becomes the primary selection; rest become additionalRanges
  const primary = ranges[0];
  const additional = ranges.length > 1 ? ranges.slice(1) : undefined;

  dispatchGridAction(
    setSelection({
      startRow: primary.startRow,
      startCol: primary.startCol,
      endRow: primary.endRow,
      endCol: primary.endCol,
      type: "cells",
      additionalRanges: additional,
    }),
  );

  const totalVisible = ranges.reduce(
    (sum, r) => sum + (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1),
    0,
  );
  const totalOriginal = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  if (totalVisible < totalOriginal) {
    showToast({
      message: `Selected ${totalVisible} visible cell(s) (${totalOriginal - totalVisible} hidden)`,
      type: "info",
    });
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[SelectVisibleCells] Activating...");

  // Register in the Edit menu
  registerMenuItem("edit", {
    id: "edit:selectVisibleCells",
    label: "Select Visible Cells",
    shortcut: "Alt+;",
    icon: IconSelectVisibleCells,
    action: selectVisibleCells,
  });

  // Register keyboard shortcut handler
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.altKey && e.key === ";") {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      e.preventDefault();
      selectVisibleCells();
    }
  };
  window.addEventListener("keydown", handleKeyDown);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown));

  console.log("[SelectVisibleCells] Activated successfully.");
}

const cleanupFns: (() => void)[] = [];

function deactivate(): void {
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error(err); }
  }
  cleanupFns.length = 0;
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.select-visible-cells",
    name: "Select Visible Cells",
    version: "1.0.0",
    description: "Select only visible cells, ignoring hidden rows and columns",
  },
  activate,
  deactivate,
};

export default extension;
