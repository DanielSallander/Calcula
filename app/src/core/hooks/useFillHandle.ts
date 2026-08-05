//! FILENAME: app/src/core/hooks/useFillHandle.ts
// PURPOSE: Custom hook for fill handle (drag-to-fill) functionality.
// CONTEXT: Handles the drag GESTURE (handle hit-testing, preview, auto-scroll)
//          and applies the fill. The pattern/series/formula-shift machinery
//          lives in core/lib/fillEngine.ts, SHARED verbatim with the script
//          surface (api.fillRange) so a script fill and a drag fill can never
//          disagree about what a series means.
// FIX: Formula values are now shifted via shiftFormulaForFill instead of being copied verbatim.
//      This ensures references inside functions (e.g., =SUM(B2)) update correctly when filling.
//      Absolute references ($) are respected -- $B$2 won't shift, B$2 shifts column only, etc.

import { useCallback, useRef, useState, useEffect } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection, scrollBy } from "../state/gridActions";
import { getCell, getViewportCells, updateCellsBatch, beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction } from "../lib/tauri-api";
import { cellEvents, cellToChange } from "../lib/cellEvents";
import type { Selection, GridConfig } from "../types";
import { getColumnWidth, getRowHeight, getColumnX, getRowY, calculateVisibleRange } from "../lib/gridRenderer";
import { calculateAutoScrollDelta } from "./useMouseSelection/utils/autoScrollUtils";
import { checkRangeGuards } from "../lib/editGuards";
import { DEFAULT_AUTO_SCROLL_CONFIG } from "./useMouseSelection/constants";
import { getGridRegions } from "../../api/gridOverlays";
import {
  detectPattern,
  processPendingFills,
  replicateMergeRegions,
  type FillDirection,
  type PendingFill,
} from "../lib/fillEngine";

export type { FillDirection } from "../lib/fillEngine";

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
   * Returns false when the selection is inside a grid region (e.g., pivot table).
   */
  const isOverFillHandle = useCallback(
    (mouseX: number, mouseY: number): boolean => {
      // Block fill handle when selection is inside a grid region (e.g., pivot table)
      if (selection) {
        const regions = getGridRegions();
        const selMinRow = Math.min(selection.startRow, selection.endRow);
        const selMaxRow = Math.max(selection.startRow, selection.endRow);
        const selMinCol = Math.min(selection.startCol, selection.endCol);
        const selMaxCol = Math.max(selection.startCol, selection.endCol);
        for (const region of regions) {
          if (region.floating) continue;
          if (
            selMinRow >= region.startRow && selMaxRow <= region.endRow &&
            selMinCol >= region.startCol && selMaxCol <= region.endCol
          ) {
            return false;
          }
        }
      }

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
   * OPTIMIZED: Uses batch APIs to minimize IPC calls.
   * - getViewportCells: fetches all source cells in one call
   * - shiftFormulasBatch: shifts all formulas in one call
   * - updateCellsBatch: applies all updates in one call
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

    // Check if fill target overlaps a protected range (e.g., pivot table)
    if (finalRange) {
      const rangeGuard = checkRangeGuards(
        Math.min(finalRange.startRow, finalRange.endRow),
        Math.min(finalRange.startCol, finalRange.endCol),
        Math.max(finalRange.startRow, finalRange.endRow),
        Math.max(finalRange.startCol, finalRange.endCol)
      );
      if (rangeGuard?.blocked) {
        if (rangeGuard.message) alert(rangeGuard.message);
        setFillState({ isDragging: false, direction: null, targetRow: 0, targetCol: 0, previewRange: null });
        dragStartRef.current = null;
        return;
      }
    }

    await beginUndoTransaction("Fill series");
    try {
      // OPTIMIZATION: Fetch all source cells in a single IPC call
      const sourceCells = await getViewportCells(selMinRow, selMinCol, selMaxRow, selMaxCol);

      // Build maps for quick lookup: (row, col) -> value and (row, col) -> styleIndex
      const cellMap = new Map<string, string>();
      const styleMap = new Map<string, number>();
      for (const cell of sourceCells) {
        const key = `${cell.row},${cell.col}`;
        cellMap.set(key, cell.formula || cell.display || "");
        styleMap.set(key, cell.styleIndex ?? 0);
      }

      // Helper to get source value from map
      const getSourceValue = (row: number, col: number): string => {
        return cellMap.get(`${row},${col}`) || "";
      };
      const getSourceStyle = (row: number, col: number): number => {
        return styleMap.get(`${row},${col}`) || 0;
      };

      // Build source values arrays and collect pending fills
      const sourceValues: string[][] = [];
      const pendingFills: PendingFill[] = [];

      if (fillState.direction === "down" || fillState.direction === "up") {
        // Get values column by column from the map
        for (let c = selMinCol; c <= selMaxCol; c++) {
          const colValues: string[] = [];
          for (let r = selMinRow; r <= selMaxRow; r++) {
            colValues.push(getSourceValue(r, c));
          }
          sourceValues.push(colValues);
        }

        const startRow = fillState.direction === "down" ? selMaxRow + 1 : fillState.targetRow;
        const endRow = fillState.direction === "down" ? fillState.targetRow : selMinRow - 1;
        const sourceCount = selMaxRow - selMinRow + 1;

        for (let c = selMinCol; c <= selMaxCol; c++) {
          const colIdx = c - selMinCol;
          const nonFormulaValues = sourceValues[colIdx].filter(v => !v.startsWith("="));
          const pattern = detectPattern(nonFormulaValues.length > 0 ? nonFormulaValues : sourceValues[colIdx]);

          if (fillState.direction === "down") {
            for (let r = startRow; r <= endRow; r++) {
              const fillIndex = r - selMinRow;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[colIdx][sourceIndex];
              const sourceRow = selMinRow + sourceIndex;

              pendingFills.push({
                row: r,
                col: c,
                sourceValue,
                sourceRow,
                sourceCol: c,
                pattern,
                allSourceValues: sourceValues[colIdx],
                fillIndex,
                sourceStyleIndex: getSourceStyle(sourceRow, c),
              });
            }
          } else {
            // Fill up - mirror from bottom of selection upward
            for (let r = endRow; r >= startRow; r--) {
              const fillIndex = selMaxRow - r;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[colIdx][sourceCount - 1 - sourceIndex];
              const sourceRow = selMaxRow - sourceIndex;

              pendingFills.push({
                row: r,
                col: c,
                sourceValue,
                sourceRow,
                sourceCol: c,
                pattern,
                allSourceValues: sourceValues[colIdx].slice().reverse(),
                fillIndex,
                sourceStyleIndex: getSourceStyle(sourceRow, c),
              });
            }
          }
        }
      } else {
        // Horizontal fill (left/right)
        for (let r = selMinRow; r <= selMaxRow; r++) {
          const rowValues: string[] = [];
          for (let c = selMinCol; c <= selMaxCol; c++) {
            rowValues.push(getSourceValue(r, c));
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

              pendingFills.push({
                row: r,
                col: c,
                sourceValue,
                sourceRow: r,
                sourceCol,
                pattern,
                allSourceValues: sourceValues[rowIdx],
                fillIndex,
                sourceStyleIndex: getSourceStyle(r, sourceCol),
              });
            }
          } else {
            // Fill left - mirror from right of selection leftward
            for (let c = endCol; c >= startCol; c--) {
              const fillIndex = selMaxCol - c;
              const sourceIndex = fillIndex % sourceCount;
              const sourceValue = sourceValues[rowIdx][sourceCount - 1 - sourceIndex];
              const sourceCol = selMaxCol - sourceIndex;

              pendingFills.push({
                row: r,
                col: c,
                sourceValue,
                sourceRow: r,
                sourceCol,
                pattern,
                allSourceValues: sourceValues[rowIdx].slice().reverse(),
                fillIndex,
                sourceStyleIndex: getSourceStyle(r, sourceCol),
              });
            }
          }
        }
      }

      // OPTIMIZATION: Process all fills using batch formula shifting
      const perfFillT0 = performance.now();
      const batchUpdates = await processPendingFills(pendingFills);
      const perfFillT1 = performance.now();

      // Execute all updates in a single batch call
      if (batchUpdates.length > 0) {
        let updatedCells;
        try {
          updatedCells = await updateCellsBatch(batchUpdates);
        } catch (err) {
          const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
          // Close the transaction opened before this try. Returning without
          // cancelling leaves it OPEN, and every later edit then joins the
          // orphaned transaction instead of forming its own undo step — so the
          // user's next Ctrl+Z reverts an unbounded amount of unrelated work.
          // Sheet protection can now refuse this batch, making that routine.
          await cancelUndoTransaction().catch(() => {});
          alert(msg);
          setFillState({ isDragging: false, direction: null, targetRow: 0, targetCol: 0, previewRange: null });
          dragStartRef.current = null;
          return;
        }
        const perfFillT2 = performance.now();

        // Emit batch event for all updated cells (single notification instead of N).
        // cellToChange carries each cell's sheetIndex through (undefined = active
        // sheet) so a fill that spills onto another sheet stays correctly tagged.
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
        const perfFillT3 = performance.now();

        console.log(
          `[PERF][fill] ${batchUpdates.length} cells => ${updatedCells.length} updated | ` +
          `processFills=${(perfFillT1 - perfFillT0).toFixed(1)}ms ` +
          `batchIpc=${(perfFillT2 - perfFillT1).toFixed(1)}ms ` +
          `emitEvents=${(perfFillT3 - perfFillT2).toFixed(1)}ms ` +
          `TOTAL=${(perfFillT3 - perfFillT0).toFixed(1)}ms`
        );
      }

      // Replicate merge patterns from source to filled range
      if (finalRange && fillState.direction) {
        await replicateMergeRegions(
          { startRow: selMinRow, startCol: selMinCol, endRow: selMaxRow, endCol: selMaxCol },
          { startRow: finalRange.startRow, startCol: finalRange.startCol, endRow: finalRange.endRow, endCol: finalRange.endCol },
          fillState.direction,
        );
      }

      await commitUndoTransaction();
      console.log("[FillHandle] Fill complete");

      // Emit FILL_COMPLETED event for extensions (e.g., sparklines)
      if (finalRange && fillState.direction) {
        import("../../api/events").then(({ emitAppEvent, AppEvents }) => {
          emitAppEvent(AppEvents.FILL_COMPLETED, {
            sourceRange: {
              startRow: selMinRow,
              startCol: selMinCol,
              endRow: selMaxRow,
              endCol: selMaxCol,
            },
            targetRange: {
              startRow: finalRange.startRow,
              startCol: finalRange.startCol,
              endRow: finalRange.endRow,
              endCol: finalRange.endCol,
            },
            direction: fillState.direction,
          });
        });
      }

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
      await commitUndoTransaction();
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
   * OPTIMIZED: Uses batch APIs to minimize IPC calls.
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

    // Edge detection still uses individual getCell calls since we need to stop at first empty
    // This is typically a small number of calls (just until we hit the edge)
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

    await beginUndoTransaction("Auto-fill to edge");
    try {
      // OPTIMIZATION: Fetch all source cells in a single IPC call
      const sourceCells = await getViewportCells(selMinRow, selMinCol, selMaxRow, selMaxCol);

      // Build maps for quick lookup
      const cellMap = new Map<string, string>();
      const styleMap = new Map<string, number>();
      for (const cell of sourceCells) {
        const key = `${cell.row},${cell.col}`;
        cellMap.set(key, cell.formula || cell.display || "");
        styleMap.set(key, cell.styleIndex ?? 0);
      }

      const getSourceValue = (row: number, col: number): string => {
        return cellMap.get(`${row},${col}`) || "";
      };
      const getSourceStyle = (row: number, col: number): number => {
        return styleMap.get(`${row},${col}`) || 0;
      };

      const sourceValues: string[][] = [];
      const pendingFills: PendingFill[] = [];

      // Build source values from map
      for (let c = selMinCol; c <= selMaxCol; c++) {
        const colValues: string[] = [];
        for (let r = selMinRow; r <= selMaxRow; r++) {
          colValues.push(getSourceValue(r, c));
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

          pendingFills.push({
            row: r,
            col: c,
            sourceValue,
            sourceRow,
            sourceCol: c,
            pattern,
            allSourceValues: sourceValues[colIdx],
            fillIndex,
            sourceStyleIndex: getSourceStyle(sourceRow, c),
          });
        }
      }

      // OPTIMIZATION: Process all fills using batch formula shifting
      const perfAutoT0 = performance.now();
      const batchUpdates = await processPendingFills(pendingFills);
      const perfAutoT1 = performance.now();

      // Execute all updates in a single batch call
      if (batchUpdates.length > 0) {
        let updatedCells;
        try {
          updatedCells = await updateCellsBatch(batchUpdates);
        } catch (err) {
          const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
          // Same leak as completeFill above: without this the transaction
          // opened at "Auto-fill to edge" stays open and swallows later edits.
          await cancelUndoTransaction().catch(() => {});
          alert(msg);
          return;
        }
        const perfAutoT2 = performance.now();

        // Emit batch event for all updated cells (single notification instead of N).
        // cellToChange carries each cell's sheetIndex through (undefined = active
        // sheet) so a fill that spills onto another sheet stays correctly tagged.
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
        const perfAutoT3 = performance.now();

        console.log(
          `[PERF][autoFill] ${batchUpdates.length} cells => ${updatedCells.length} updated | ` +
          `processFills=${(perfAutoT1 - perfAutoT0).toFixed(1)}ms ` +
          `batchIpc=${(perfAutoT2 - perfAutoT1).toFixed(1)}ms ` +
          `emitEvents=${(perfAutoT3 - perfAutoT2).toFixed(1)}ms ` +
          `TOTAL=${(perfAutoT3 - perfAutoT0).toFixed(1)}ms`
        );
      }

      // Replicate merge patterns from source to filled range
      await replicateMergeRegions(
        { startRow: selMinRow, startCol: selMinCol, endRow: selMaxRow, endCol: selMaxCol },
        { startRow: selMinRow, startCol: selMinCol, endRow: edgeRow, endCol: selMaxCol },
        "down",
      );

      await commitUndoTransaction();
      console.log("[FillHandle] autoFillToEdge complete");

      // Emit FILL_COMPLETED event for extensions (e.g., sparklines)
      import("../../api/events").then(({ emitAppEvent, AppEvents }) => {
        emitAppEvent(AppEvents.FILL_COMPLETED, {
          sourceRange: {
            startRow: selMinRow,
            startCol: selMinCol,
            endRow: selMaxRow,
            endCol: selMaxCol,
          },
          targetRange: {
            startRow: selMinRow,
            startCol: selMinCol,
            endRow: edgeRow,
            endCol: selMaxCol,
          },
          direction: "down" as const,
        });
      });

      dispatch(setSelection({
        startRow: selMinRow,
        startCol: selMinCol,
        endRow: edgeRow,
        endCol: selMaxCol,
        type: "cells",
      }));
    } catch (error) {
      console.error("[FillHandle] autoFillToEdge failed:", error);
      await commitUndoTransaction();
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