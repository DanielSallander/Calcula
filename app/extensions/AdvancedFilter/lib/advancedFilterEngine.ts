//! FILENAME: app/extensions/AdvancedFilter/lib/advancedFilterEngine.ts
// PURPOSE: Orchestration for Excel-style Advanced Filter.
// CONTEXT: Criteria parsing + row matching now run SERVER-SIDE in Rust
//          (run_advanced_filter — "Rust owns computation"; the prior TS matcher
//          is retired). This module resolves A1 range refs, invokes the backend
//          matcher, and applies the result: for filterInPlace it reflects the
//          (server-stored) hidden-row set in the grid view; for copyToLocation it
//          copies headers + matched rows through the undoable batch path.

import {
  getViewportCells,
  updateCellsBatch,
  setHiddenRows,
  dispatchGridAction,
  emitAppEvent,
  AppEvents,
  indexToCol,
  colToIndex,
  clearAdvancedFilterHiddenRows,
  runAdvancedFilter,
} from "@api";
import type { AdvancedFilterParams, AdvancedFilterResult } from "../types";

// ============================================================================
// Range Reference Helpers (pure A1 helpers — used by index.ts + the dialog)
// ============================================================================

/**
 * Parse an A1-style range string like "A1:D10" into [startRow, startCol, endRow, endCol].
 * Row numbers are 1-based in the string but returned as 0-based.
 */
export function parseRangeRef(ref: string): [number, number, number, number] | null {
  const trimmed = ref.trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) {
    // Try single cell reference like "A1"
    const singleMatch = trimmed.match(/^([A-Z]+)(\d+)$/);
    if (singleMatch) {
      const col = colToIndex(singleMatch[1]);
      const row = parseInt(singleMatch[2], 10) - 1;
      return [row, col, row, col];
    }
    return null;
  }
  const startCol = colToIndex(match[1]);
  const startRow = parseInt(match[2], 10) - 1;
  const endCol = colToIndex(match[3]);
  const endRow = parseInt(match[4], 10) - 1;
  return [startRow, startCol, endRow, endCol];
}

/**
 * Format a range tuple as an A1-style reference string.
 */
export function formatRangeRef(startRow: number, startCol: number, endRow: number, endCol: number): string {
  return `${indexToCol(startCol)}${startRow + 1}:${indexToCol(endCol)}${endRow + 1}`;
}

/**
 * Format a single cell as an A1-style reference.
 */
export function formatCellRef(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

// ============================================================================
// Main Advanced Filter Execution
// ============================================================================

/**
 * Execute an Advanced Filter operation. Matching is performed server-side by the
 * Rust `run_advanced_filter` command (criteria parsing, comparison, wildcards);
 * this orchestrator only applies the result to the grid.
 */
export async function executeAdvancedFilter(params: AdvancedFilterParams): Promise<AdvancedFilterResult> {
  const { listRange, criteriaRange, action, copyTo, uniqueRecordsOnly } = params;

  const result = await runAdvancedFilter({
    listRange,
    criteriaRange,
    action,
    copyTo,
    uniqueRecordsOnly,
  });

  if (!result.success) {
    return { success: false, matchCount: 0, affectedRows: 0, error: result.error };
  }

  if (action === "filterInPlace") {
    // Rust already stored the hidden-row set server-side (so getHiddenRows is
    // correct); reflect it in the open grid view.
    dispatchGridAction(setHiddenRows(result.hiddenRows));
    emitAppEvent(AppEvents.GRID_REFRESH);
    return { success: true, matchCount: result.matchCount, affectedRows: result.affectedRows };
  }

  if (action === "copyToLocation" && copyTo) {
    // Copy headers + matched rows to the destination through the undoable batch
    // path. The cell VALUES are read here (data movement, not matching).
    const [lStartRow, lStartCol, lEndRow, lEndCol] = listRange;
    const [destRow, destCol] = copyTo;
    const colCount = lEndCol - lStartCol + 1;

    const listCells = await getViewportCells(lStartRow, lStartCol, lEndRow, lEndCol);
    const cellMap = new Map<string, string>();
    for (const cell of listCells) {
      cellMap.set(`${cell.row},${cell.col}`, cell.display);
    }

    const updates: Array<{ row: number; col: number; value: string }> = [];
    // Headers.
    for (let c = 0; c < colCount; c++) {
      updates.push({ row: destRow, col: destCol + c, value: cellMap.get(`${lStartRow},${lStartCol + c}`) ?? "" });
    }
    // Matched data rows (absolute source indices from the backend).
    result.matchedRows.forEach((srcRow, i) => {
      for (let c = 0; c < colCount; c++) {
        updates.push({ row: destRow + 1 + i, col: destCol + c, value: cellMap.get(`${srcRow},${lStartCol + c}`) ?? "" });
      }
    });

    await updateCellsBatch(updates);
    emitAppEvent(AppEvents.GRID_REFRESH);
    return { success: true, matchCount: result.matchCount, affectedRows: result.affectedRows };
  }

  return { success: false, matchCount: 0, affectedRows: 0, error: "Invalid action or missing copy-to location." };
}

/**
 * Clear Advanced Filter (unhide all rows).
 */
export function clearAdvancedFilter(): void {
  dispatchGridAction(setHiddenRows([]));
  // Clear backend state
  clearAdvancedFilterHiddenRows();
  emitAppEvent(AppEvents.GRID_REFRESH);
}
