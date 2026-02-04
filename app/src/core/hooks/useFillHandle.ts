//! FILENAME: app/src/core/hooks/useFillHandle.ts
// PURPOSE: Custom hook for fill handle (drag-to-fill) functionality.
// CONTEXT: Handles detection, patterns, and auto-fill logic for the fill handle.

import { useCallback, useRef, useState } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection } from "../state/gridActions";
import { getCell, updateCell } from "../lib/tauri-api";
import { cellEvents } from "../lib/cellEvents";
import type { Selection } from "../types";
import { getColumnWidth, getRowHeight, getColumnX, getRowY, calculateVisibleRange } from "../lib/gridRenderer";

/**
 * Fill direction enumeration.
 */
export type FillDirection = "down" | "up" | "right" | "left" | null;

/**
 * Fill handle state.
 */
export interface FillHandleState {
  /** Whether fill handle drag is active */
  isDragging: boolean;
  /** Fill direction */
  direction: FillDirection;
  /** Target row during drag */
  targetRow: number;
  /** Target column during drag */
  targetCol: number;
  /** Preview range for visual feedback */
  previewRange: Selection | null;
}

/**
 * Return type for the useFillHandle hook.
 */
export interface UseFillHandleReturn {
  /** Current fill handle state */
  fillState: FillHandleState;
  /** Check if mouse is over fill handle */
  isOverFillHandle: (mouseX: number, mouseY: number) => boolean;
  /** Start fill handle drag */
  startFillDrag: (mouseX: number, mouseY: number) => void;
  /** Update fill drag position */
  updateFillDrag: (mouseX: number, mouseY: number) => void;
  /** Complete fill operation */
  completeFill: () => Promise<void>;
  /** Cancel fill operation */
  cancelFill: () => void;
  /** Get fill handle position for rendering */
  getFillHandlePosition: () => { x: number; y: number; visible: boolean } | null;
  /** Auto-fill to edge (double-click behavior) */
  autoFillToEdge: () => Promise<void>;
}

/**
 * Detect pattern in values for auto-fill.
 */
interface PatternResult {
  type: "copy" | "increment" | "series" | "text-increment";
  baseValues: string[];
  step: number;
}

/**
 * Analyze source values to detect fill pattern.
 */
function detectPattern(values: string[]): PatternResult {
  if (values.length === 0) {
    return { type: "copy", baseValues: [""], step: 0 };
  }

  if (values.length === 1) {
    const val = values[0];
    
    // Check for text + number pattern (e.g., "Item 1")
    const textNumMatch = val.match(/^(.+?)(\d+)$/);
    if (textNumMatch) {
      return {
        type: "text-increment",
        baseValues: [textNumMatch[1]],
        step: 1,
      };
    }

    // Single number - copy by default
    if (!isNaN(parseFloat(val)) && val.trim() !== "") {
      return { type: "copy", baseValues: values, step: 0 };
    }

    // Text - copy
    return { type: "copy", baseValues: values, step: 0 };
  }

  // Multiple values - try to detect series
  const numbers = values.map((v) => parseFloat(v));
  const allNumbers = numbers.every((n) => !isNaN(n));

  if (allNumbers && values.length >= 2) {
    // Check for arithmetic sequence
    const diffs: number[] = [];
    for (let i = 1; i < numbers.length; i++) {
      diffs.push(numbers[i] - numbers[i - 1]);
    }
    
    // Check if all differences are the same
    const allSameDiff = diffs.every((d) => Math.abs(d - diffs[0]) < 0.0001);
    if (allSameDiff) {
      return {
        type: "series",
        baseValues: values,
        step: diffs[0],
      };
    }
  }

  // Check for text + number patterns in multiple values
  const textNumMatches = values.map((v) => v.match(/^(.+?)(\d+)$/));
  if (textNumMatches.every((m) => m !== null)) {
    const prefixes = textNumMatches.map((m) => m![1]);
    if (prefixes.every((p) => p === prefixes[0])) {
      const nums = textNumMatches.map((m) => parseInt(m![2], 10));
      if (nums.length >= 2) {
        const step = nums[1] - nums[0];
        const isSequential = nums.every((n, i) => i === 0 || n - nums[i - 1] === step);
        if (isSequential) {
          return {
            type: "text-increment",
            baseValues: [prefixes[0]],
            step,
          };
        }
      }
    }
  }

  // Default to repeating pattern
  return { type: "copy", baseValues: values, step: 0 };
}

/**
 * Generate fill value based on pattern and index.
 */
function generateFillValue(
  pattern: PatternResult,
  sourceValues: string[],
  index: number
): string {
  switch (pattern.type) {
    case "copy":
      return sourceValues[index % sourceValues.length];
    
    case "increment": {
      const baseNum = parseFloat(sourceValues[0]);
      return String(baseNum + index + 1);
    }
    
    case "series": {
      const lastNum = parseFloat(sourceValues[sourceValues.length - 1]);
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        return String(lastNum + pattern.step * offset);
      }
      return sourceValues[index];
    }
    
    case "text-increment": {
      const prefix = pattern.baseValues[0];
      const baseMatch = sourceValues[sourceValues.length - 1].match(/(\d+)$/);
      const baseNum = baseMatch ? parseInt(baseMatch[1], 10) : 0;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        return `${prefix}${baseNum + pattern.step * offset}`;
      }
      return sourceValues[index];
    }
    
    default:
      return sourceValues[index % sourceValues.length];
  }
}

/**
 * Hook for fill handle functionality.
 */
export function useFillHandle(): UseFillHandleReturn {
  const { state, dispatch } = useGridContext();
  const { selection, config, viewport, dimensions } = state;

  const [fillState, setFillState] = useState<FillHandleState>({
    isDragging: false,
    direction: null,
    targetRow: 0,
    targetCol: 0,
    previewRange: null,
  });

  const dragStartRef = useRef<{ row: number; col: number } | null>(null);

  /**
   * Get the fill handle position in pixels.
   * The fill handle is at the bottom-right corner of the selection bounding box.
   */
  const getFillHandlePosition = useCallback((): { x: number; y: number; visible: boolean } | null => {
    if (!selection) return null;

    // Use bounding box (maxRow/maxCol), not endRow/endCol,
    // so the handle position matches the rendering regardless of selection direction
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const maxCol = Math.max(selection.startCol, selection.endCol);
    const minRow = Math.min(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);

    // Use large container dimensions to avoid clipping issues
    const containerWidth = 2000;
    const containerHeight = 2000;
    const range = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dimensions);

    // Check if bottom-right cell is visible
    if (
      maxRow < range.startRow ||
      maxRow > range.endRow ||
      maxCol < range.startCol ||
      maxCol > range.endCol
    ) {
      return { x: 0, y: 0, visible: false };
    }

    // Calculate x2, y2 of the selection bounding box (matches selection.ts rendering)
    const x1 = getColumnX(minCol, config, dimensions, range.startCol, range.offsetX);
    let x2 = x1;
    for (let c = minCol; c <= maxCol; c++) {
      x2 += getColumnWidth(c, config, dimensions);
    }

    const y1 = getRowY(minRow, config, dimensions, range.startRow, range.offsetY);
    let y2 = y1;
    for (let r = minRow; r <= maxRow; r++) {
      y2 += getRowHeight(r, config, dimensions);
    }

    return {
      x: x2,
      y: y2,
      visible: true,
    };
  }, [selection, viewport, config, dimensions]);

  /**
   * Check if mouse position is over the fill handle.
   * Uses handleSize=8 and hit padding=3 to match the rendering in selection.ts.
   */
  const isOverFillHandle = useCallback(
    (mouseX: number, mouseY: number): boolean => {
      const handlePos = getFillHandlePosition();
      if (!handlePos || !handlePos.visible) return false;

      // Match the rendering code in selection.ts:
      // borderX2 = x2 - 1, handleX = borderX2 - handleSize/2
      const handleSize = 8;
      const borderX = handlePos.x - 1;
      const borderY = handlePos.y - 1;
      const handleX = borderX - handleSize / 2;
      const handleY = borderY - handleSize / 2;

      const hitPadding = 3;
      return (
        mouseX >= handleX - handleSize / 2 - hitPadding &&
        mouseX <= handleX + handleSize / 2 + hitPadding &&
        mouseY >= handleY - handleSize / 2 - hitPadding &&
        mouseY <= handleY + handleSize / 2 + hitPadding
      );
    },
    [getFillHandlePosition]
  );

  /**
   * Start fill handle drag operation.
   */
  const startFillDrag = useCallback(
    (_mouseX: number, _mouseY: number) => {
      if (!selection) return;

      // Use bounding box max as the drag anchor (fill handle is at bottom-right)
      const maxRow = Math.max(selection.startRow, selection.endRow);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      dragStartRef.current = {
        row: maxRow,
        col: maxCol,
      };

      setFillState({
        isDragging: true,
        direction: null,
        targetRow: maxRow,
        targetCol: maxCol,
        previewRange: { ...selection },
      });

      console.log("[FillHandle] Started fill drag");
    },
    [selection]
  );

  /**
   * Update fill drag with current mouse position.
   */
  const updateFillDrag = useCallback(
    (mouseX: number, mouseY: number) => {
      if (!fillState.isDragging || !selection || !dragStartRef.current) return;

      // Use bounding box for direction calculation
      const selMaxRow = Math.max(selection.startRow, selection.endRow);
      const selMaxCol = Math.max(selection.startCol, selection.endCol);

      // Convert mouse position to cell
      const containerWidth = 2000;
      const containerHeight = 2000;
      const range = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dimensions);

      // Find cell under mouse
      let targetRow = dragStartRef.current.row;
      let targetCol = dragStartRef.current.col;
      let direction: FillDirection = null;

      // Calculate row
      let y = config.colHeaderHeight;
      for (let r = range.startRow; r <= range.endRow + 10; r++) {
        const rowHeight = getRowHeight(r, config, dimensions);
        if (mouseY >= y && mouseY < y + rowHeight) {
          targetRow = r;
          break;
        }
        y += rowHeight;
      }

      // Calculate column
      let x = config.rowHeaderWidth;
      for (let c = range.startCol; c <= range.endCol + 10; c++) {
        const colWidth = getColumnWidth(c, config, dimensions);
        if (mouseX >= x && mouseX < x + colWidth) {
          targetCol = c;
          break;
        }
        x += colWidth;
      }

      // Determine direction (constrain to single axis)
      // Use bounding box max for comparison since fill handle is at bottom-right
      const rowDiff = targetRow - selMaxRow;
      const colDiff = targetCol - selMaxCol;

      if (Math.abs(rowDiff) > Math.abs(colDiff)) {
        // Vertical fill - constrain column to selection max
        targetCol = selMaxCol;
        direction = rowDiff > 0 ? "down" : rowDiff < 0 ? "up" : null;
      } else if (colDiff !== 0) {
        // Horizontal fill - constrain row to selection max
        targetRow = selMaxRow;
        direction = colDiff > 0 ? "right" : "left";
      }

      // Build preview range
      const selMinRow = Math.min(selection.startRow, selection.endRow);
      const selMinCol = Math.min(selection.startCol, selection.endCol);

      let previewRange: Selection;
      
      switch (direction) {
        case "down":
          previewRange = {
            startRow: selMinRow,
            startCol: selMinCol,
            endRow: Math.max(selMaxRow, targetRow),
            endCol: selMaxCol,
            type: "cells",
          };
          break;
        case "up":
          previewRange = {
            startRow: Math.min(selMinRow, targetRow),
            startCol: selMinCol,
            endRow: selMaxRow,
            endCol: selMaxCol,
            type: "cells",
          };
          break;
        case "right":
          previewRange = {
            startRow: selMinRow,
            startCol: selMinCol,
            endRow: selMaxRow,
            endCol: Math.max(selMaxCol, targetCol),
            type: "cells",
          };
          break;
        case "left":
          previewRange = {
            startRow: selMinRow,
            startCol: Math.min(selMinCol, targetCol),
            endRow: selMaxRow,
            endCol: selMaxCol,
            type: "cells",
          };
          break;
        default:
          previewRange = { ...selection };
      }

      setFillState({
        isDragging: true,
        direction,
        targetRow,
        targetCol,
        previewRange,
      });
    },
    [fillState.isDragging, selection, viewport, config, dimensions]
  );

  /**
   * Complete the fill operation.
   */
  const completeFill = useCallback(async () => {
    if (!fillState.isDragging || !selection || !fillState.direction) {
      setFillState({
        isDragging: false,
        direction: null,
        targetRow: 0,
        targetCol: 0,
        previewRange: null,
      });
      dragStartRef.current = null;
      return;
    }

    console.log("[FillHandle] Completing fill:", fillState.direction);

    const selMinRow = Math.min(selection.startRow, selection.endRow);
    const selMaxRow = Math.max(selection.startRow, selection.endRow);
    const selMinCol = Math.min(selection.startCol, selection.endCol);
    const selMaxCol = Math.max(selection.startCol, selection.endCol);

    // Store the preview range before clearing state
    const finalRange = fillState.previewRange;

    try {
      // Get source values based on direction
      const sourceValues: string[][] = [];

      if (fillState.direction === "down" || fillState.direction === "up") {
        // Get values column by column
        for (let c = selMinCol; c <= selMaxCol; c++) {
          const colValues: string[] = [];
          for (let r = selMinRow; r <= selMaxRow; r++) {
            const cell = await getCell(r, c);
            colValues.push(cell?.formula || cell?.display || "");
          }
          sourceValues.push(colValues);
        }

        // Fill rows
        const startRow = fillState.direction === "down" ? selMaxRow + 1 : fillState.targetRow;
        const endRow = fillState.direction === "down" ? fillState.targetRow : selMinRow - 1;

        for (let c = selMinCol; c <= selMaxCol; c++) {
          const colIdx = c - selMinCol;
          const pattern = detectPattern(sourceValues[colIdx]);

          if (fillState.direction === "down") {
            for (let r = startRow; r <= endRow; r++) {
              const fillIndex = r - selMinRow;
              const value = generateFillValue(pattern, sourceValues[colIdx], fillIndex);
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                });
              }
            }
          } else {
            // Fill up (reverse order)
            for (let r = endRow; r >= startRow; r--) {
              const fillIndex = selMaxRow - r;
              const value = generateFillValue(pattern, sourceValues[colIdx].slice().reverse(), fillIndex);
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                });
              }
            }
          }
        }
      } else {
        // Horizontal fill (left/right)
        for (let r = selMinRow; r <= selMaxRow; r++) {
          const rowValues: string[] = [];
          for (let c = selMinCol; c <= selMaxCol; c++) {
            const cell = await getCell(r, c);
            rowValues.push(cell?.formula || cell?.display || "");
          }
          sourceValues.push(rowValues);
        }

        const startCol = fillState.direction === "right" ? selMaxCol + 1 : fillState.targetCol;
        const endCol = fillState.direction === "right" ? fillState.targetCol : selMinCol - 1;

        for (let r = selMinRow; r <= selMaxRow; r++) {
          const rowIdx = r - selMinRow;
          const pattern = detectPattern(sourceValues[rowIdx]);

          if (fillState.direction === "right") {
            for (let c = startCol; c <= endCol; c++) {
              const fillIndex = c - selMinCol;
              const value = generateFillValue(pattern, sourceValues[rowIdx], fillIndex);
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                });
              }
            }
          } else {
            // Fill left (reverse)
            for (let c = endCol; c >= startCol; c--) {
              const fillIndex = selMaxCol - c;
              const value = generateFillValue(pattern, sourceValues[rowIdx].slice().reverse(), fillIndex);
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                });
              }
            }
          }
        }
      }

      console.log("[FillHandle] Fill complete");

      // Update selection to include filled cells
      if (finalRange) {
        dispatch(setSelection({
          startRow: finalRange.startRow,
          startCol: finalRange.startCol,
          endRow: finalRange.endRow,
          endCol: finalRange.endCol,
          type: "cells",
        }));
      }
    } catch (error) {
      console.error("[FillHandle] Fill failed:", error);
    }

    setFillState({
      isDragging: false,
      direction: null,
      targetRow: 0,
      targetCol: 0,
      previewRange: null,
    });
    dragStartRef.current = null;
  }, [fillState, selection, dispatch]);

  /**
   * Cancel fill operation.
   */
  const cancelFill = useCallback(() => {
    setFillState({
      isDragging: false,
      direction: null,
      targetRow: 0,
      targetCol: 0,
      previewRange: null,
    });
    dragStartRef.current = null;
  }, []);

  /**
   * Auto-fill to edge (Excel double-click fill handle behavior).
   * Looks at adjacent columns to determine how far to fill down.
   */
  const autoFillToEdge = useCallback(async () => {
    if (!selection) {
      console.log("[FillHandle] autoFillToEdge: No selection");
      return;
    }

    const selMinRow = Math.min(selection.startRow, selection.endRow);
    const selMaxRow = Math.max(selection.startRow, selection.endRow);
    const selMinCol = Math.min(selection.startCol, selection.endCol);
    const selMaxCol = Math.max(selection.startCol, selection.endCol);

    console.log("[FillHandle] autoFillToEdge: Selection", { selMinRow, selMaxRow, selMinCol, selMaxCol });

    // Find the edge by looking at adjacent columns (left first, then right)
    let edgeRow = selMaxRow;
    const maxRowsToCheck = 10000; // Safety limit

    // Check column to the left of selection
    if (selMinCol > 0) {
      const checkCol = selMinCol - 1;
      // Start from the row after selection and find where data ends
      for (let r = selMaxRow + 1; r < selMaxRow + maxRowsToCheck; r++) {
        const cell = await getCell(r, checkCol);
        const hasData = cell && cell.display && cell.display.trim() !== "";
        if (hasData) {
          edgeRow = r;
        } else {
          // Found empty cell, stop here
          break;
        }
      }
    }

    // If no edge found from left, check column to the right
    if (edgeRow === selMaxRow && selMaxCol < 16383) {
      const checkCol = selMaxCol + 1;
      for (let r = selMaxRow + 1; r < selMaxRow + maxRowsToCheck; r++) {
        const cell = await getCell(r, checkCol);
        const hasData = cell && cell.display && cell.display.trim() !== "";
        if (hasData) {
          edgeRow = r;
        } else {
          break;
        }
      }
    }

    // If no adjacent data found, do nothing
    if (edgeRow === selMaxRow) {
      console.log("[FillHandle] autoFillToEdge: No adjacent data found, nothing to fill");
      return;
    }

    console.log("[FillHandle] autoFillToEdge: Filling down to row", edgeRow);

    try {
      // Get source values column by column
      const sourceValues: string[][] = [];
      for (let c = selMinCol; c <= selMaxCol; c++) {
        const colValues: string[] = [];
        for (let r = selMinRow; r <= selMaxRow; r++) {
          const cell = await getCell(r, c);
          colValues.push(cell?.formula || cell?.display || "");
        }
        sourceValues.push(colValues);
      }

      // Fill down for each column
      for (let c = selMinCol; c <= selMaxCol; c++) {
        const colIdx = c - selMinCol;
        const pattern = detectPattern(sourceValues[colIdx]);

        for (let r = selMaxRow + 1; r <= edgeRow; r++) {
          const fillIndex = r - selMinRow;
          const value = generateFillValue(pattern, sourceValues[colIdx], fillIndex);
          
          const updatedCells = await updateCell(r, c, value);
          for (const cell of updatedCells) {
            cellEvents.emit({
              row: cell.row,
              col: cell.col,
              oldValue: undefined,
              newValue: cell.display,
              formula: cell.formula ?? null,
            });
          }
        }
      }

      console.log("[FillHandle] autoFillToEdge complete");

      // Update selection to include filled cells
      dispatch(setSelection({
        startRow: selMinRow,
        startCol: selMinCol,
        endRow: edgeRow,
        endCol: selMaxCol,
        type: "cells",
      }));
    } catch (error) {
      console.error("[FillHandle] autoFillToEdge failed:", error);
    }
  }, [selection, dispatch]);

  return {
    fillState,
    isOverFillHandle,
    startFillDrag,
    updateFillDrag,
    completeFill,
    cancelFill,
    getFillHandlePosition,
    autoFillToEdge,
  };
}