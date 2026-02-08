//! FILENAME: app/src/core/hooks/useFillHandle.ts
// PURPOSE: Custom hook for fill handle (drag-to-fill) functionality.
// CONTEXT: Handles detection, patterns, and auto-fill logic for the fill handle.
// FIX: Formula values are now shifted via shiftFormulaForFill instead of being copied verbatim.
//      This ensures references inside functions (e.g., =SUM(B2)) update correctly when filling.
//      Absolute references ($) are respected -- $B$2 won't shift, B$2 shifts column only, etc.

import { useCallback, useRef, useState, useEffect } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection, scrollBy } from "../state/gridActions";
import { getCell, updateCell, shiftFormulaForFill } from "../lib/tauri-api";
import { cellEvents } from "../lib/cellEvents";
import type { Selection, GridConfig } from "../types";
import { getColumnWidth, getRowHeight, getColumnX, getRowY, calculateVisibleRange } from "../lib/gridRenderer";
import { calculateAutoScrollDelta } from "./useMouseSelection/utils/autoScrollUtils";
import { DEFAULT_AUTO_SCROLL_CONFIG } from "./useMouseSelection/constants";

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
 * Props for the useFillHandle hook.
 */
export interface UseFillHandleProps {
  /** Reference to the container element for coordinate calculation */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Grid configuration for header dimensions */
  config: GridConfig;
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
 * Compute the fill value for a target cell.
 * If the source value is a formula, shifts references via the backend.
 * Otherwise, uses the pattern-based generation for non-formula values.
 *
 * FIX: Wrapped shiftFormulaForFill in try/catch so that a backend error
 * (e.g., unregistered command, parse failure) falls back to copying the
 * source formula as-is rather than aborting the entire fill operation.
 */
async function computeFillValue(
  sourceValue: string,
  sourceRow: number,
  sourceCol: number,
  targetRow: number,
  targetCol: number,
  pattern: PatternResult,
  allSourceValues: string[],
  fillIndex: number,
): Promise<string> {
  if (sourceValue.startsWith("=")) {
    // Formula: shift references based on position delta
    const rowDelta = targetRow - sourceRow;
    const colDelta = targetCol - sourceCol;
    try {
      return await shiftFormulaForFill(sourceValue, rowDelta, colDelta);
    } catch (error) {
      console.error("[FillHandle] shiftFormulaForFill failed, copying formula as-is:", error);
      // Fallback: return the source formula unchanged
      return sourceValue;
    }
  }
  // Non-formula: use pattern-based fill
  return generateFillValue(pattern, allSourceValues, fillIndex);
}

/**
 * Hook for fill handle functionality.
 */
export function useFillHandle(props: UseFillHandleProps): UseFillHandleReturn {
  const { containerRef, config: propsConfig } = props;
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
  const autoScrollRef = useRef<number | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * Stop auto-scroll loop.
   */
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      clearTimeout(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  /**
   * Internal function to update fill drag - will be called by auto-scroll loop.
   * Accepts optional scroll override to use current DOM scroll position instead of stale state.
   */
  const updateFillDragInternal = useCallback(
    (mouseX: number, mouseY: number, scrollOverride?: { scrollX: number; scrollY: number }) => {
      if (!selection || !dragStartRef.current) return;

      const selMaxRow = Math.max(selection.startRow, selection.endRow);
      const selMaxCol = Math.max(selection.startCol, selection.endCol);

      // Use scroll override if provided (for auto-scroll), otherwise use state viewport
      const effectiveViewport = scrollOverride
        ? { ...viewport, scrollX: scrollOverride.scrollX, scrollY: scrollOverride.scrollY }
        : viewport;

      const containerWidth = 2000;
      const containerHeight = 2000;
      const range = calculateVisibleRange(effectiveViewport, config, containerWidth, containerHeight, dimensions);

      let targetRow = dragStartRef.current.row;
      let targetCol = dragStartRef.current.col;
      let direction: FillDirection = null;

      let y = config.colHeaderHeight;
      for (let r = range.startRow; r <= range.endRow + 10; r++) {
        const rowHeight = getRowHeight(r, config, dimensions);
        if (mouseY >= y && mouseY < y + rowHeight) {
          targetRow = r;
          break;
        }
        y += rowHeight;
      }

      let x = config.rowHeaderWidth;
      for (let c = range.startCol; c <= range.endCol + 10; c++) {
        const colWidth = getColumnWidth(c, config, dimensions);
        if (mouseX >= x && mouseX < x + colWidth) {
          targetCol = c;
          break;
        }
        x += colWidth;
      }

      const rowDiff = targetRow - selMaxRow;
      const colDiff = targetCol - selMaxCol;

      if (Math.abs(rowDiff) > Math.abs(colDiff)) {
        targetCol = selMaxCol;
        direction = rowDiff > 0 ? "down" : rowDiff < 0 ? "up" : null;
      } else if (colDiff !== 0) {
        targetRow = selMaxRow;
        direction = colDiff > 0 ? "right" : "left";
      }

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
    [selection, viewport, config, dimensions]
  );

  /**
   * Auto-scroll loop that runs during fill handle drag.
   * Uses Redux dispatch to update viewport scroll state (virtualized canvas approach).
   */
  const runAutoScroll = useCallback(() => {
    if (!lastMousePosRef.current || !containerRef.current) {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const { x: mouseX, y: mouseY } = lastMousePosRef.current;

    // Calculate scroll delta based on edge proximity
    const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, propsConfig);

    if (deltaX !== 0 || deltaY !== 0) {
      // Dispatch scroll action to update viewport state
      dispatch(scrollBy(deltaX, deltaY));

      // Calculate new scroll position for fill drag update
      const newScrollX = Math.max(0, viewport.scrollX + deltaX);
      const newScrollY = Math.max(0, viewport.scrollY + deltaY);

      // Update fill drag with current mouse position and NEW scroll position
      // Pass scroll override since state viewport update is async
      updateFillDragInternal(mouseX, mouseY, { scrollX: newScrollX, scrollY: newScrollY });
    }

    // Schedule next frame
    autoScrollRef.current = window.setTimeout(runAutoScroll, DEFAULT_AUTO_SCROLL_CONFIG.intervalMs);
  }, [containerRef, propsConfig, updateFillDragInternal, dispatch, viewport.scrollX, viewport.scrollY]);

  /**
   * Start auto-scroll loop.
   */
  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current === null) {
      runAutoScroll();
    }
  }, [runAutoScroll]);

  // Clean up auto-scroll on unmount
  useEffect(() => {
    return () => {
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  /**
   * Get the fill handle position in pixels.
   * The fill handle is at the bottom-right corner of the selection bounding box.
   */
  const getFillHandlePosition = useCallback((): { x: number; y: number; visible: boolean } | null => {
    if (!selection) return null;

    const maxRow = Math.max(selection.startRow, selection.endRow);
    const maxCol = Math.max(selection.startCol, selection.endCol);
    const minRow = Math.min(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);

    const containerWidth = 2000;
    const containerHeight = 2000;
    const range = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dimensions);

    if (
      maxRow < range.startRow ||
      maxRow > range.endRow ||
      maxCol < range.startCol ||
      maxCol > range.endCol
    ) {
      return { x: 0, y: 0, visible: false };
    }

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
   */
  const isOverFillHandle = useCallback(
    (mouseX: number, mouseY: number): boolean => {
      const handlePos = getFillHandlePosition();
      if (!handlePos || !handlePos.visible) return false;

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
   * Integrates with auto-scroll when mouse is near viewport edges.
   */
  const updateFillDrag = useCallback(
    (mouseX: number, mouseY: number) => {
      if (!fillState.isDragging || !selection || !dragStartRef.current) return;

      // Store mouse position for auto-scroll loop
      lastMousePosRef.current = { x: mouseX, y: mouseY };

      // Update the fill drag state
      updateFillDragInternal(mouseX, mouseY);

      // Check if we need to auto-scroll
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, propsConfig);
        if (deltaX !== 0 || deltaY !== 0) {
          startAutoScroll();
        } else {
          stopAutoScroll();
        }
      }
    },
    [fillState.isDragging, selection, updateFillDragInternal, containerRef, propsConfig, startAutoScroll, stopAutoScroll]
  );

  /**
   * Complete the fill operation.
   * FIX: Formula values are now shifted via shiftFormulaForFill.
   */
  const completeFill = useCallback(async () => {
    // Stop auto-scroll and clear mouse position
    stopAutoScroll();
    lastMousePosRef.current = null;

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

    const finalRange = fillState.previewRange;

    try {
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

        const startRow = fillState.direction === "down" ? selMaxRow + 1 : fillState.targetRow;
        const endRow = fillState.direction === "down" ? fillState.targetRow : selMinRow - 1;
        const sourceCount = selMaxRow - selMinRow + 1;

        for (let c = selMinCol; c <= selMaxCol; c++) {
          const colIdx = c - selMinCol;
          // FIX: Filter out formulas for pattern detection (formulas are handled separately)
          const nonFormulaValues = sourceValues[colIdx].filter(v => !v.startsWith("="));
          const pattern = detectPattern(nonFormulaValues.length > 0 ? nonFormulaValues : sourceValues[colIdx]);

          if (fillState.direction === "down") {
            for (let r = startRow; r <= endRow; r++) {
              const fillIndex = r - selMinRow;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[colIdx][sourceIndex];
              const sourceRow = selMinRow + sourceIndex;

              // FIX: Use computeFillValue which handles formulas via shiftFormulaForFill
              const value = await computeFillValue(
                sourceValue, sourceRow, c, r, c,
                pattern, sourceValues[colIdx], fillIndex,
              );
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue; // Skip cross-sheet cells
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
            // Fill up - mirror from bottom of selection upward
            for (let r = endRow; r >= startRow; r--) {
              const fillIndex = selMaxRow - r;
              const sourceIndex = fillIndex % sourceCount;
              // Reversed: source from bottom of selection
              const sourceValue = sourceValues[colIdx][sourceCount - 1 - sourceIndex];
              const sourceRow = selMaxRow - sourceIndex;

              const value = await computeFillValue(
                sourceValue, sourceRow, c, r, c,
                pattern, sourceValues[colIdx].slice().reverse(), fillIndex,
              );
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue; // Skip cross-sheet cells
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
        const sourceCount = selMaxCol - selMinCol + 1;

        for (let r = selMinRow; r <= selMaxRow; r++) {
          const rowIdx = r - selMinRow;
          const nonFormulaValues = sourceValues[rowIdx].filter(v => !v.startsWith("="));
          const pattern = detectPattern(nonFormulaValues.length > 0 ? nonFormulaValues : sourceValues[rowIdx]);

          if (fillState.direction === "right") {
            for (let c = startCol; c <= endCol; c++) {
              const fillIndex = c - selMinCol;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[rowIdx][sourceIndex];
              const sourceCol = selMinCol + sourceIndex;

              const value = await computeFillValue(
                sourceValue, r, sourceCol, r, c,
                pattern, sourceValues[rowIdx], fillIndex,
              );
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue; // Skip cross-sheet cells
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
            // Fill left - mirror from right of selection leftward
            for (let c = endCol; c >= startCol; c--) {
              const fillIndex = selMaxCol - c;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[rowIdx][sourceCount - 1 - sourceIndex];
              const sourceCol = selMaxCol - sourceIndex;

              const value = await computeFillValue(
                sourceValue, r, sourceCol, r, c,
                pattern, sourceValues[rowIdx].slice().reverse(), fillIndex,
              );
              
              const updatedCells = await updateCell(r, c, value);
              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue; // Skip cross-sheet cells
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
  }, [fillState, selection, dispatch, stopAutoScroll]);

  /**
   * Cancel fill operation.
   */
  const cancelFill = useCallback(() => {
    // Stop auto-scroll and clear mouse position
    stopAutoScroll();
    lastMousePosRef.current = null;

    setFillState({
      isDragging: false,
      direction: null,
      targetRow: 0,
      targetCol: 0,
      previewRange: null,
    });
    dragStartRef.current = null;
  }, [stopAutoScroll]);

  /**
   * Auto-fill to edge (Excel double-click fill handle behavior).
   * Looks at adjacent columns to determine how far to fill down.
   * FIX: Formula values are now shifted via shiftFormulaForFill.
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

    let edgeRow = selMaxRow;
    const maxRowsToCheck = 10000;

    if (selMinCol > 0) {
      const checkCol = selMinCol - 1;
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

    if (edgeRow === selMaxRow) {
      console.log("[FillHandle] autoFillToEdge: No adjacent data found, nothing to fill");
      return;
    }

    console.log("[FillHandle] autoFillToEdge: Filling down to row", edgeRow);

    try {
      const sourceValues: string[][] = [];
      for (let c = selMinCol; c <= selMaxCol; c++) {
        const colValues: string[] = [];
        for (let r = selMinRow; r <= selMaxRow; r++) {
          const cell = await getCell(r, c);
          colValues.push(cell?.formula || cell?.display || "");
        }
        sourceValues.push(colValues);
      }

      const sourceCount = selMaxRow - selMinRow + 1;

      for (let c = selMinCol; c <= selMaxCol; c++) {
        const colIdx = c - selMinCol;
        const nonFormulaValues = sourceValues[colIdx].filter(v => !v.startsWith("="));
        const pattern = detectPattern(nonFormulaValues.length > 0 ? nonFormulaValues : sourceValues[colIdx]);

        for (let r = selMaxRow + 1; r <= edgeRow; r++) {
          const fillIndex = r - selMinRow;
          const sourceIndex = fillIndex % sourceCount;
          const sourceValue = sourceValues[colIdx][sourceIndex];
          const sourceRow = selMinRow + sourceIndex;

          // FIX: Use computeFillValue which handles formulas via shiftFormulaForFill
          const value = await computeFillValue(
            sourceValue, sourceRow, c, r, c,
            pattern, sourceValues[colIdx], fillIndex,
          );
          
          const updatedCells = await updateCell(r, c, value);
          for (const cell of updatedCells) {
            if (cell.sheetIndex !== undefined) continue; // Skip cross-sheet cells
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