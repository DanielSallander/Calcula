//! FILENAME: app/src/core/hooks/useClipboard.ts
// PURPOSE: Custom hook for clipboard operations (cut, copy, paste).
// CONTEXT: Handles reading/writing to system clipboard and cell data operations.
// Updated: Added clearClipboardState for ESC key handling.
// Updated: Selection now moves to pasted range after paste.
// Updated: Copy source remains active after paste (only cut clears clipboard).

import { useCallback, useRef } from "react";
import { useGridContext } from "../state/GridContext";
import {
  getCell,
  getViewportCells,
  updateCell,
  clearCell,
  clearRange,
  insertRows,
  deleteRows,
  insertColumns,
  deleteColumns,
} from "../lib/tauri-api";
import { cellEvents } from "../lib/cellEvents";
import { setClipboard, clearClipboard, setSelection } from "../state/gridActions";
import type { Selection, CellData, ClipboardMode } from "../types";

/**
 * Internal clipboard data structure.
 * We store both the raw text and structured cell data.
 */
interface ClipboardData {
  /** Source selection when copy/cut was performed */
  sourceSelection: Selection;
  /** Cell data matrix [row][col] relative to source selection */
  cells: (CellData | null)[][];
  /** Whether this was a cut operation (cells should be cleared on paste) */
  isCut: boolean;
  /** Plain text representation for system clipboard */
  text: string;
}

/**
 * Return type for the useClipboard hook.
 */
export interface UseClipboardReturn {
  /** Cut selected cells to clipboard */
  cut: () => Promise<void>;
  /** Copy selected cells to clipboard */
  copy: () => Promise<void>;
  /** Paste clipboard contents to current selection */
  paste: () => Promise<void>;
  /** Check if clipboard has content */
  hasClipboardData: () => boolean;
  /** Get current clipboard mode */
  clipboardMode: ClipboardMode;
  /** Get clipboard selection (for rendering) */
  clipboardSelection: Selection | null;
  /** Clear clipboard state (for ESC key) */
  clearClipboardState: () => void;
  /** Move cells from source selection to target position */
  moveCells: (source: Selection, targetRow: number, targetCol: number) => Promise<void>;
  /** Reorder rows (structural move) */
  moveRows: (sourceStartRow: number, sourceEndRow: number, targetRow: number) => Promise<void>;
  /** Reorder columns (structural move) */
  moveColumns: (sourceStartCol: number, sourceEndCol: number, targetCol: number) => Promise<void>;
}

// Module-level clipboard storage (persists across hook instances)
let internalClipboard: ClipboardData | null = null;

/**
 * Hook for clipboard operations.
 */
export function useClipboard(): UseClipboardReturn {
  const { state, dispatch } = useGridContext();
  const { selection, config, clipboard } = state;
  
  // Ref to track cut source for clearing after paste
  const cutSourceRef = useRef<Selection | null>(null);

  /**
   * Get cell data for a range.
   */
  const getCellRange = useCallback(
    async (sel: Selection): Promise<(CellData | null)[][]> => {
      const minRow = Math.min(sel.startRow, sel.endRow);
      const maxRow = Math.max(sel.startRow, sel.endRow);
      const minCol = Math.min(sel.startCol, sel.endCol);
      const maxCol = Math.max(sel.startCol, sel.endCol);

      const cells: (CellData | null)[][] = [];
      
      for (let r = minRow; r <= maxRow; r++) {
        const row: (CellData | null)[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          try {
            const cellData = await getCell(r, c);
            row.push(cellData || null);
          } catch {
            row.push(null);
          }
        }
        cells.push(row);
      }

      return cells;
    },
    []
  );

  /**
   * Convert cell matrix to plain text (tab-separated values).
   */
  const cellsToText = useCallback((cells: (CellData | null)[][]): string => {
    return cells
      .map((row) =>
        row
          .map((cell) => {
            if (!cell) return "";
            // Use formula if present, otherwise display value
            return cell.formula || cell.display || "";
          })
          .join("\t")
      )
      .join("\n");
  }, []);

  /**
   * Copy selected cells to clipboard.
   */
  const copy = useCallback(async () => {
    if (!selection) {
      console.log("[Clipboard] No selection to copy");
      return;
    }

    console.log("[Clipboard] Copying selection:", selection);

    try {
      const cells = await getCellRange(selection);
      const text = cellsToText(cells);

      // Store in internal clipboard
      internalClipboard = {
        sourceSelection: { ...selection },
        cells,
        isCut: false,
        text,
      };

      // Update state for visual feedback (marching ants border)
      dispatch(setClipboard("copy", { ...selection }));

      // Also write to system clipboard
      try {
        await navigator.clipboard.writeText(text);
        console.log("[Clipboard] Copied to system clipboard");
      } catch (err) {
        console.warn("[Clipboard] Could not write to system clipboard:", err);
      }

      // Clear any previous cut source
      cutSourceRef.current = null;
    } catch (error) {
      console.error("[Clipboard] Copy failed:", error);
    }
  }, [selection, getCellRange, cellsToText, dispatch]);

  /**
   * Cut selected cells to clipboard.
   */
  const cut = useCallback(async () => {
    if (!selection) {
      console.log("[Clipboard] No selection to cut");
      return;
    }

    console.log("[Clipboard] Cutting selection:", selection);

    try {
      const cells = await getCellRange(selection);
      const text = cellsToText(cells);

      // Store in internal clipboard with cut flag
      internalClipboard = {
        sourceSelection: { ...selection },
        cells,
        isCut: true,
        text,
      };

      // Remember cut source for clearing after paste
      cutSourceRef.current = { ...selection };

      // Update state for visual feedback (marching ants border)
      dispatch(setClipboard("cut", { ...selection }));

      // Also write to system clipboard
      try {
        await navigator.clipboard.writeText(text);
        console.log("[Clipboard] Cut to system clipboard");
      } catch (err) {
        console.warn("[Clipboard] Could not write to system clipboard:", err);
      }
    } catch (error) {
      console.error("[Clipboard] Cut failed:", error);
    }
  }, [selection, getCellRange, cellsToText, dispatch]);

  /**
   * Paste clipboard contents to current selection.
   */
  const paste = useCallback(async () => {
    if (!selection) {
      console.log("[Clipboard] No selection for paste target");
      return;
    }

    console.log("[Clipboard] Pasting to selection:", selection);

    // Try to read from system clipboard first
    let textToPaste: string | null = null;
    try {
      textToPaste = await navigator.clipboard.readText();
    } catch (err) {
      console.warn("[Clipboard] Could not read from system clipboard:", err);
    }

    // Determine what to paste
    let cellsToPaste: (CellData | null)[][] | null = null;
    let pasteWidth = 1;
    let pasteHeight = 1;
    // Track if we're using internal clipboard (for deciding whether to clear after paste)
    let usingInternalClipboard = false;

    if (
      internalClipboard &&
      (!textToPaste || textToPaste === internalClipboard.text)
    ) {
      // Use internal clipboard (preserves formulas, formatting, etc.)
      cellsToPaste = internalClipboard.cells;
      pasteHeight = cellsToPaste.length;
      pasteWidth = cellsToPaste[0]?.length || 1;
      usingInternalClipboard = true;
      console.log("[Clipboard] Using internal clipboard data");
    } else if (textToPaste) {
      // Parse text from system clipboard (tab/newline separated)
      const rows = textToPaste.split("\n");
      cellsToPaste = rows.map((row) =>
        row.split("\t").map((value) => ({
          row: 0,
          col: 0,
          display: value,
          formula: null,
          styleIndex: 0,
        }))
      );
      pasteHeight = cellsToPaste.length;
      pasteWidth = Math.max(...cellsToPaste.map((r) => r.length));
      console.log("[Clipboard] Parsed system clipboard text");
    }

    if (!cellsToPaste || cellsToPaste.length === 0) {
      console.log("[Clipboard] Nothing to paste");
      return;
    }

    // Determine target range
    const targetRow = Math.min(selection.startRow, selection.endRow);
    const targetCol = Math.min(selection.startCol, selection.endCol);

    // Calculate actual paste bounds (clamped to grid bounds)
    const actualPasteHeight = Math.min(pasteHeight, config.totalRows - targetRow);
    const actualPasteWidth = Math.min(pasteWidth, config.totalCols - targetCol);

    // Track if this was a cut operation (need to check before we potentially modify internalClipboard)
    const wasCutOperation = usingInternalClipboard && internalClipboard?.isCut;

    try {
      // Paste cells
      for (let r = 0; r < pasteHeight; r++) {
        for (let c = 0; c < pasteWidth; c++) {
          const destRow = targetRow + r;
          const destCol = targetCol + c;

          // Check bounds
          if (destRow >= config.totalRows || destCol >= config.totalCols) {
            continue;
          }

          const sourceCell = cellsToPaste[r]?.[c];
          const value = sourceCell?.formula || sourceCell?.display || "";

          try {
            const updatedCells = await updateCell(destRow, destCol, value);

            // Emit events for same-sheet cells only (skip cross-sheet dependents)
            for (const cell of updatedCells) {
              if (cell.sheetIndex !== undefined) {
                continue; // Skip cross-sheet cells
              }
              cellEvents.emit({
                row: cell.row,
                col: cell.col,
                oldValue: undefined,
                newValue: cell.display,
                formula: cell.formula ?? null,
              });
            }
          } catch (err) {
            console.error(`[Clipboard] Failed to paste cell (${destRow}, ${destCol}):`, err);
          }
        }
      }

      // If this was a cut operation, clear the source cells
      if (wasCutOperation && cutSourceRef.current) {
        const src = cutSourceRef.current;
        const srcMinRow = Math.min(src.startRow, src.endRow);
        const srcMaxRow = Math.max(src.startRow, src.endRow);
        const srcMinCol = Math.min(src.startCol, src.endCol);
        const srcMaxCol = Math.max(src.startCol, src.endCol);

        for (let r = srcMinRow; r <= srcMaxRow; r++) {
          for (let c = srcMinCol; c <= srcMaxCol; c++) {
            // Don't clear if it overlaps with paste destination
            const overlaps =
              r >= targetRow &&
              r < targetRow + pasteHeight &&
              c >= targetCol &&
              c < targetCol + pasteWidth;
            
            if (!overlaps) {
              try {
                await clearCell(r, c);
                cellEvents.emit({
                  row: r,
                  col: c,
                  oldValue: undefined,
                  newValue: "",
                  formula: null,
                });
              } catch (err) {
                console.error(`[Clipboard] Failed to clear cut source (${r}, ${c}):`, err);
              }
            }
          }
        }

        // Clear cut source reference
        cutSourceRef.current = null;
        if (internalClipboard) {
          internalClipboard.isCut = false;
        }

        // Clear clipboard visual state only after cut+paste (cut is one-time operation)
        dispatch(clearClipboard());
        console.log("[Clipboard] Cut+paste complete, clipboard cleared");
      } else {
        // Copy+paste: keep clipboard active for multiple pastes
        console.log("[Clipboard] Copy+paste complete, clipboard remains active");
      }

      // Update selection to cover the pasted range
      const pastedEndRow = targetRow + actualPasteHeight - 1;
      const pastedEndCol = targetCol + actualPasteWidth - 1;
      
      dispatch(setSelection({
        startRow: targetRow,
        startCol: targetCol,
        endRow: pastedEndRow,
        endCol: pastedEndCol,
      }));
      
      console.log("[Clipboard] Selection moved to pasted range:", {
        startRow: targetRow,
        startCol: targetCol,
        endRow: pastedEndRow,
        endCol: pastedEndCol,
      });
    } catch (error) {
      console.error("[Clipboard] Paste failed:", error);
    }
  }, [selection, config.totalRows, config.totalCols, dispatch]);

  /**
   * Check if there's clipboard data available.
   */
  const hasClipboardData = useCallback((): boolean => {
    return internalClipboard !== null;
  }, []);

  /**
   * Clear clipboard state (removes marching ants visual).
   * Called when user presses ESC.
   */
  const clearClipboardState = useCallback(() => {
    console.log("[Clipboard] Clearing clipboard state (ESC pressed)");
    dispatch(clearClipboard());
    // Note: We don't clear internalClipboard here, only the visual state
    // This matches Excel behavior where ESC stops marching ants but
    // you can still paste until you copy/cut something else
  }, [dispatch]);

  /**
   * Move cells from source selection to a new position.
   * This moves the cell data (not a structural reorder).
   */
  const moveCells = useCallback(
    async (source: Selection, targetRow: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Moving cells from", source, "to", targetRow, targetCol);

      // Normalize source bounds
      const srcMinRow = Math.min(source.startRow, source.endRow);
      const srcMaxRow = Math.max(source.startRow, source.endRow);
      const srcMinCol = Math.min(source.startCol, source.endCol);
      const srcMaxCol = Math.max(source.startCol, source.endCol);

      const height = srcMaxRow - srcMinRow + 1;
      const width = srcMaxCol - srcMinCol + 1;

      try {
        // 1. Read source cells
        const sourceCells = await getViewportCells(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol);
        console.log("[Clipboard] Read", sourceCells.length, "source cells");

        // 2. Build a map of source cells for quick lookup
        const cellMap = new Map<string, CellData>();
        for (const cell of sourceCells) {
          cellMap.set(`${cell.row},${cell.col}`, cell);
        }

        // 3. Write to destination cells
        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            const srcRow = srcMinRow + r;
            const srcCol = srcMinCol + c;
            const destRow = targetRow + r;
            const destCol = targetCol + c;

            // Check bounds
            if (destRow >= config.totalRows || destCol >= config.totalCols) {
              continue;
            }

            const sourceCell = cellMap.get(`${srcRow},${srcCol}`);
            const value = sourceCell?.formula || sourceCell?.display || "";

            try {
              const updatedCells = await updateCell(destRow, destCol, value);
              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue;
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                });
              }
            } catch (err) {
              console.error(`[Clipboard] Failed to write cell (${destRow}, ${destCol}):`, err);
            }
          }
        }

        // 4. Clear source cells (excluding overlap with destination)
        const destMinRow = targetRow;
        const destMaxRow = targetRow + height - 1;
        const destMinCol = targetCol;
        const destMaxCol = targetCol + width - 1;

        for (let r = srcMinRow; r <= srcMaxRow; r++) {
          for (let c = srcMinCol; c <= srcMaxCol; c++) {
            // Check if this source cell overlaps with destination
            const overlaps =
              r >= destMinRow && r <= destMaxRow &&
              c >= destMinCol && c <= destMaxCol;

            if (!overlaps) {
              try {
                await clearCell(r, c);
                cellEvents.emit({
                  row: r,
                  col: c,
                  oldValue: undefined,
                  newValue: "",
                  formula: null,
                });
              } catch (err) {
                console.error(`[Clipboard] Failed to clear source (${r}, ${c}):`, err);
              }
            }
          }
        }

        // 5. Update selection to new position
        dispatch(setSelection({
          startRow: targetRow,
          startCol: targetCol,
          endRow: targetRow + height - 1,
          endCol: targetCol + width - 1,
          type: source.type,
        }));

        console.log("[Clipboard] Move cells complete");
      } catch (error) {
        console.error("[Clipboard] Move cells failed:", error);
      }
    },
    [config.totalRows, config.totalCols, dispatch]
  );

  /**
   * Reorder rows (structural move).
   * Moves rows from source position to target position by deleting and inserting.
   */
  const moveRows = useCallback(
    async (sourceStartRow: number, sourceEndRow: number, targetRow: number): Promise<void> => {
      console.log("[Clipboard] Moving rows", sourceStartRow, "-", sourceEndRow, "to", targetRow);

      const minRow = Math.min(sourceStartRow, sourceEndRow);
      const maxRow = Math.max(sourceStartRow, sourceEndRow);
      const count = maxRow - minRow + 1;

      // Don't move if target is within source range
      if (targetRow >= minRow && targetRow <= maxRow + 1) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      try {
        // 1. Read all cell data from source rows
        const sourceCells = await getViewportCells(minRow, 0, maxRow, config.totalCols - 1);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source rows");

        // Adjust target if moving down (account for deletion shift)
        let adjustedTarget = targetRow;
        if (targetRow > minRow) {
          adjustedTarget = targetRow - count;
        }

        // 2. Delete source rows (shifts everything up)
        await deleteRows(minRow, count);
        console.log("[Clipboard] Deleted source rows");

        // 3. Insert new rows at target position
        await insertRows(adjustedTarget, count);
        console.log("[Clipboard] Inserted rows at target");

        // 4. Write cell data to new rows
        for (const cell of sourceCells) {
          const newRow = adjustedTarget + (cell.row - minRow);
          const value = cell.formula || cell.display || "";

          if (value) {
            try {
              await updateCell(newRow, cell.col, value);
            } catch (err) {
              console.error(`[Clipboard] Failed to write cell (${newRow}, ${cell.col}):`, err);
            }
          }
        }

        // 5. Emit a generic change event to trigger grid refresh
        // Row/column structure changes require full refresh
        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        });

        // 6. Update selection to new position
        dispatch(setSelection({
          startRow: adjustedTarget,
          startCol: 0,
          endRow: adjustedTarget + count - 1,
          endCol: config.totalCols - 1,
          type: "rows",
        }));

        console.log("[Clipboard] Move rows complete");
      } catch (error) {
        console.error("[Clipboard] Move rows failed:", error);
      }
    },
    [config.totalCols, dispatch]
  );

  /**
   * Reorder columns (structural move).
   * Moves columns from source position to target position by deleting and inserting.
   */
  const moveColumns = useCallback(
    async (sourceStartCol: number, sourceEndCol: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Moving columns", sourceStartCol, "-", sourceEndCol, "to", targetCol);

      const minCol = Math.min(sourceStartCol, sourceEndCol);
      const maxCol = Math.max(sourceStartCol, sourceEndCol);
      const count = maxCol - minCol + 1;

      // Don't move if target is within source range
      if (targetCol >= minCol && targetCol <= maxCol + 1) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      try {
        // 1. Read all cell data from source columns
        const sourceCells = await getViewportCells(0, minCol, config.totalRows - 1, maxCol);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source columns");

        // Adjust target if moving right (account for deletion shift)
        let adjustedTarget = targetCol;
        if (targetCol > minCol) {
          adjustedTarget = targetCol - count;
        }

        // 2. Delete source columns (shifts everything left)
        await deleteColumns(minCol, count);
        console.log("[Clipboard] Deleted source columns");

        // 3. Insert new columns at target position
        await insertColumns(adjustedTarget, count);
        console.log("[Clipboard] Inserted columns at target");

        // 4. Write cell data to new columns
        for (const cell of sourceCells) {
          const newCol = adjustedTarget + (cell.col - minCol);
          const value = cell.formula || cell.display || "";

          if (value) {
            try {
              await updateCell(cell.row, newCol, value);
            } catch (err) {
              console.error(`[Clipboard] Failed to write cell (${cell.row}, ${newCol}):`, err);
            }
          }
        }

        // 5. Emit a generic change event to trigger grid refresh
        // Row/column structure changes require full refresh
        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        });

        // 6. Update selection to new position
        dispatch(setSelection({
          startRow: 0,
          startCol: adjustedTarget,
          endRow: config.totalRows - 1,
          endCol: adjustedTarget + count - 1,
          type: "columns",
        }));

        console.log("[Clipboard] Move columns complete");
      } catch (error) {
        console.error("[Clipboard] Move columns failed:", error);
      }
    },
    [config.totalRows, dispatch]
  );

  return {
    cut,
    copy,
    paste,
    hasClipboardData,
    clipboardMode: clipboard?.mode || "none",
    clipboardSelection: clipboard?.selection || null,
    clearClipboardState,
    moveCells,
    moveRows,
    moveColumns,
  };
}