//! FILENAME: app/src/core/components/Spreadsheet/Spreadsheet.tsx
// PURPOSE: Main spreadsheet component combining grid, editor, and scrollbars
// CONTEXT: Core component that orchestrates the spreadsheet experience
// REFACTOR: Removed legacy Find/Replace event listeners (logic moved to Extensions)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useGridState, useGridContext } from "../../state";
// FIX: Removed openFind import to resolve SyntaxError
import { setViewportDimensions, setAllDimensions, setSelection, setManuallyHiddenRows, setManuallyHiddenCols, setZoom, setSplitConfig, setSplitViewport, updateConfig } from "../../state/gridActions";
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "../../types";
import type { Selection, Viewport, VirtualBounds } from "../../types";
import { GridCanvas } from "../Grid";
import { InlineEditor } from "../InlineEditor";
import { Scrollbar, ScrollbarCorner } from "../Scrollbar/Scrollbar";
import { useScrollbarMetrics } from "../Scrollbar/useScrollbarMetrics";
import { useSpreadsheet } from "./useSpreadsheet";
import {
  clearRange,
  clearRangeWithOptions,
  clearCommentsInRange,
  clearHyperlinksInRange,
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  getAllColumnWidths,
  getAllRowHeights,
  getDefaultDimensions,
  mergeCells,
  unmergeCells,
  setSplitWindow as backendSetSplitWindow,
} from "../../lib/tauri-api";
import { cellEvents } from "../../lib/cellEvents";
import { getCellFromPixel } from "../../lib/gridRenderer";
import { calculateFreezePaneLayout } from "../../lib/gridRenderer/layout/viewport";
import { getColumnWidth, getRowHeight } from "../../lib/gridRenderer/layout/dimensions";
import type { SpreadsheetContentProps } from "./SpreadsheetTypes";
import { AppEvents, emitAppEvent } from "../../lib/events";
import {
  gridCommands,
  isClickWithinSelection,
} from "../../lib/gridCommands";
import type { GridMenuContext } from "../../lib/gridCommands";

// Styles
import * as S from "./Spreadsheet.styles";

const SCROLLBAR_SIZE = 14;
const SPLIT_BAR_SIZE = 4;
const SPLIT_BAR_HIT_TOLERANCE = 4; // Extra pixels on each side for easier clicking

// Debounce delay for resize observer - prevents flickering during task pane animation
const RESIZE_DEBOUNCE_MS = 150;

/**
 * Per-sheet state storage for selection, viewport, and virtual bounds.
 * This persists across sheet switches so users can return to the same position.
 */
interface SheetState {
  selection: Selection | null;
  viewport: Viewport;
  virtualBounds: VirtualBounds;
}

/**
 * Module-level storage for per-sheet state.
 * Using module-level to persist across component re-renders.
 */
const sheetStatesMap = new Map<number, SheetState>();

function SpreadsheetContent({
  className,
}: SpreadsheetContentProps): React.ReactElement {
  // 1. Destructure the grouped object returned by the refactored hook
  const { refs, state, handlers } = useSpreadsheet();
  const gridState = useGridState();
  const { dispatch } = useGridContext();

  // 2. Extract Refs
  const { containerRef, focusContainerRef, canvasRef } = refs;

  // 3. Extract and Rename Handlers to match JSX requirements
  const {
    handleScrollEvent,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClickEvent,
    handleContainerKeyDown,
    handleInlineValueChange,
    handleInlineCommit,
    handleInlineCancel,
    handleInlineTab,
    handleInlineEnter,
    handleInlineCtrlEnter,
    handleArrowKeyReference,
    handleCut,
    handleCopy,
    handlePaste,
  } = handlers;

  // 4. Extract State
  const {
    config,
    styleCache,
    viewport,
    selection,
    editing,
    isEditing,
    formulaReferences,
    dimensions,
    clipboardSelection,
    clipboardMode,
    fillState,
    selectionDragPreview,
    selectionDragMode,
  } = state;

  // 5. Extract freezeConfig, splitConfig, viewMode from gridState
  const { freezeConfig, splitConfig, splitViewport, viewMode, showFormulas, displayZeros, displayGridlines, displayHeadings } = gridState;

  // -------------------------------------------------------------------------
  // Split bar drag state
  // -------------------------------------------------------------------------
  const [splitDrag, setSplitDrag] = useState<{
    axis: "row" | "col";
    startPixel: number;
    startValue: number;
  } | null>(null);
  const [splitBarCursor, setSplitBarCursor] = useState<string | null>(null);

  /**
   * Calculate split bar pixel positions for hit testing.
   */
  const getSplitBarPositions = useCallback(() => {
    const hasSplitRows = splitConfig.splitRow !== null && splitConfig.splitRow > 0;
    const hasSplitCols = splitConfig.splitCol !== null && splitConfig.splitCol > 0;
    if (!hasSplitRows && !hasSplitCols) return null;

    const splitFreezeConfig = {
      freezeRow: splitConfig.splitRow ?? null,
      freezeCol: splitConfig.splitCol ?? null,
    };
    const layout = calculateFreezePaneLayout(splitFreezeConfig, config, dimensions);
    const rowHeaderWidth = config.rowHeaderWidth || 50;
    const colHeaderHeight = config.colHeaderHeight || 24;

    return {
      horizontalBarY: hasSplitRows ? colHeaderHeight + layout.frozenRowsHeight : null,
      verticalBarX: hasSplitCols ? rowHeaderWidth + layout.frozenColsWidth : null,
      rowHeaderWidth,
      colHeaderHeight,
    };
  }, [splitConfig, config, dimensions]);

  /**
   * Check if a pixel position is over a split bar.
   */
  const hitTestSplitBar = useCallback((mouseX: number, mouseY: number): "row" | "col" | null => {
    const positions = getSplitBarPositions();
    if (!positions) return null;

    const { horizontalBarY, verticalBarX, rowHeaderWidth, colHeaderHeight } = positions;

    // Check vertical split bar (col-resize cursor)
    if (verticalBarX !== null && mouseX >= verticalBarX - SPLIT_BAR_HIT_TOLERANCE &&
        mouseX <= verticalBarX + SPLIT_BAR_SIZE + SPLIT_BAR_HIT_TOLERANCE &&
        mouseY > colHeaderHeight) {
      return "col";
    }

    // Check horizontal split bar (row-resize cursor)
    if (horizontalBarY !== null && mouseY >= horizontalBarY - SPLIT_BAR_HIT_TOLERANCE &&
        mouseY <= horizontalBarY + SPLIT_BAR_SIZE + SPLIT_BAR_HIT_TOLERANCE &&
        mouseX > rowHeaderWidth) {
      return "row";
    }

    return null;
  }, [getSplitBarPositions]);

  /**
   * Convert a pixel Y position to the nearest row index for split repositioning.
   */
  const pixelYToSplitRow = useCallback((pixelY: number): number => {
    const colHeaderHeight = config.colHeaderHeight || 24;
    let accHeight = 0;
    let row = 0;
    const targetY = pixelY - colHeaderHeight;
    while (row < (config.totalRows || 1000)) {
      const rh = getRowHeight(row, config, dimensions);
      if (rh <= 0) { row++; continue; }
      if (accHeight + rh / 2 > targetY) break;
      accHeight += rh;
      row++;
    }
    return Math.max(1, row);
  }, [config, dimensions]);

  /**
   * Convert a pixel X position to the nearest col index for split repositioning.
   */
  const pixelXToSplitCol = useCallback((pixelX: number): number => {
    const rowHeaderWidth = config.rowHeaderWidth || 50;
    let accWidth = 0;
    let col = 0;
    const targetX = pixelX - rowHeaderWidth;
    while (col < (config.totalCols || 100)) {
      const cw = getColumnWidth(col, config, dimensions);
      if (cw <= 0) { col++; continue; }
      if (accWidth + cw / 2 > targetX) break;
      accWidth += cw;
      col++;
    }
    return Math.max(1, col);
  }, [config, dimensions]);

  // -------------------------------------------------------------------------
  // Helper: Refresh dimensions from backend
  // -------------------------------------------------------------------------
  const refreshDimensions = useCallback(async () => {
    try {
      const [colWidths, rowHeights, defaults] = await Promise.all([
        getAllColumnWidths(),
        getAllRowHeights(),
        getDefaultDimensions(),
      ]);

      const columnWidthsMap = new Map<number, number>();
      for (const item of colWidths) {
        columnWidthsMap.set(item.index, item.size);
      }

      const rowHeightsMap = new Map<number, number>();
      for (const item of rowHeights) {
        rowHeightsMap.set(item.index, item.size);
      }

      dispatch(setAllDimensions(columnWidthsMap, rowHeightsMap));
      dispatch(updateConfig({
        defaultCellWidth: defaults.defaultColumnWidth,
        defaultCellHeight: defaults.defaultRowHeight,
      }));
      console.log("[Spreadsheet] Dimensions refreshed from backend");
    } catch (error) {
      console.error("[Spreadsheet] Failed to refresh dimensions:", error);
    }
  }, [dispatch]);

  // -------------------------------------------------------------------------
  // Menu Event Listeners for Cut/Copy/Paste
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleMenuCut = () => {
      handleCut();
    };
    const handleMenuCopy = () => {
      handleCopy();
    };
    const handleMenuPaste = () => {
      handlePaste();
    };
    // FIX: Removed legacy Find/Replace handlers.
    // These events are now handled by the FindReplaceDialog extension.

    window.addEventListener(AppEvents.CUT, handleMenuCut);
    window.addEventListener(AppEvents.COPY, handleMenuCopy);
    window.addEventListener(AppEvents.PASTE, handleMenuPaste);

    return () => {
      window.removeEventListener(AppEvents.CUT, handleMenuCut);
      window.removeEventListener(AppEvents.COPY, handleMenuCopy);
      window.removeEventListener(AppEvents.PASTE, handleMenuPaste);
    };
  }, [handleCut, handleCopy, handlePaste, dispatch]);

  // -------------------------------------------------------------------------
  // Dimensions Refresh Listener (from context menu column width / row height)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleDimensionsRefresh = () => {
      refreshDimensions();
    };

    window.addEventListener("dimensions:refresh", handleDimensionsRefresh);

    return () => {
      window.removeEventListener("dimensions:refresh", handleDimensionsRefresh);
    };
  }, [refreshDimensions]);

  // -------------------------------------------------------------------------
  // Hide/Unhide Row/Column Listeners (from context menu)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleHideRows = (event: Event) => {
      const { rows } = (event as CustomEvent<{ rows: number[] }>).detail;
      dispatch(setManuallyHiddenRows(rows));
    };
    const handleHideCols = (event: Event) => {
      const { cols } = (event as CustomEvent<{ cols: number[] }>).detail;
      dispatch(setManuallyHiddenCols(cols));
    };

    window.addEventListener("grid:set-manually-hidden-rows", handleHideRows);
    window.addEventListener("grid:set-manually-hidden-cols", handleHideCols);

    return () => {
      window.removeEventListener("grid:set-manually-hidden-rows", handleHideRows);
      window.removeEventListener("grid:set-manually-hidden-cols", handleHideCols);
    };
  }, [dispatch]);

  // -------------------------------------------------------------------------
  // Sheet Switch Listener (for normal sheet switching without page reload)
  // Saves current sheet's selection/viewport state and restores the new sheet's state.
  // -------------------------------------------------------------------------
  // Track the previous sheet index for saving state before switch
  const previousSheetIndexRef = useRef<number>(gridState.sheetContext.activeSheetIndex);

  useEffect(() => {
    const handleSheetSwitchStart = (_event: Event) => {
      // Save the current sheet's state BEFORE the switch happens
      const currentSheetIndex = previousSheetIndexRef.current;
      const currentState: SheetState = {
        selection: selection,
        viewport: { ...viewport },
        virtualBounds: { ...gridState.virtualBounds },
      };
      sheetStatesMap.set(currentSheetIndex, currentState);
      console.log(`[Spreadsheet] Saved state for sheet ${currentSheetIndex}:`, {
        selection: currentState.selection,
        scrollX: currentState.viewport.scrollX,
        scrollY: currentState.viewport.scrollY,
      });
    };

    const handleSheetSwitch = (event: Event) => {
      const customEvent = event as CustomEvent<{
        newSheetIndex: number;
        newSheetName: string;
      }>;
      const newSheetIndex = customEvent.detail.newSheetIndex;

      console.log("[Spreadsheet] Sheet switch - refreshing dimensions");
      refreshDimensions();

      // Restore the new sheet's saved state if available
      const savedState = sheetStatesMap.get(newSheetIndex);
      if (savedState) {
        console.log(`[Spreadsheet] Restoring state for sheet ${newSheetIndex}:`, {
          selection: savedState.selection,
          scrollX: savedState.viewport.scrollX,
          scrollY: savedState.viewport.scrollY,
        });

        // Restore selection
        if (savedState.selection) {
          dispatch(setSelection(savedState.selection));
        }
      } else {
        // No saved state - set default selection to A1
        console.log(`[Spreadsheet] No saved state for sheet ${newSheetIndex}, using default A1`);
        dispatch(setSelection({
          startRow: 0,
          startCol: 0,
          endRow: 0,
          endCol: 0,
          type: "cells",
        }));
      }

      // Update the previous sheet index for the next switch
      previousSheetIndexRef.current = newSheetIndex;

      // Restore focus to the grid container so keyboard input works immediately
      // Use setTimeout to ensure DOM has settled after state updates
      setTimeout(() => {
        focusContainerRef.current?.focus();
      }, 0);
    };

    // Reorder cached sheet states when sheets are moved
    const handleSheetReorder = (event: Event) => {
      const { fromIndex, toIndex } = (event as CustomEvent).detail;
      // Collect all entries, remap keys to match the rotation, then replace
      const entries = Array.from(sheetStatesMap.entries());
      const newMap = new Map<number, SheetState>();
      for (const [key, value] of entries) {
        let newKey = key;
        if (key === fromIndex) {
          newKey = toIndex;
        } else if (fromIndex < toIndex) {
          // Moved right: indices in (from, to] shift left by 1
          if (key > fromIndex && key <= toIndex) newKey = key - 1;
        } else {
          // Moved left: indices in [to, from) shift right by 1
          if (key >= toIndex && key < fromIndex) newKey = key + 1;
        }
        newMap.set(newKey, value);
      }
      sheetStatesMap.clear();
      for (const [k, v] of newMap) sheetStatesMap.set(k, v);
    };

    // Listen for the event that fires BEFORE the sheet switch (to save state)
    window.addEventListener("sheet:beforeSwitch", handleSheetSwitchStart);
    window.addEventListener("sheet:normalSwitch", handleSheetSwitch);
    window.addEventListener("sheet:reorder", handleSheetReorder);

    return () => {
      window.removeEventListener("sheet:beforeSwitch", handleSheetSwitchStart);
      window.removeEventListener("sheet:normalSwitch", handleSheetSwitch);
      window.removeEventListener("sheet:reorder", handleSheetReorder);
    };
  }, [refreshDimensions, selection, viewport, gridState.virtualBounds, dispatch]);

  // -------------------------------------------------------------------------
  // Clear Contents Handler
  // -------------------------------------------------------------------------
  const handleClearContents = useCallback(async () => {
    if (!selection) {
      return;
    }

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    try {
      await clearRange(minRow, minCol, maxRow, maxCol);

      // Emit a single event to trigger refresh
      cellEvents.emit({
        row: minRow,
        col: minCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      }, "clear");
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear contents:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Clear Formatting Handler
  // -------------------------------------------------------------------------
  const handleClearFormatting = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    try {
      await clearRangeWithOptions(minRow, minCol, maxRow, maxCol, "formats");
      cellEvents.emit({ row: minRow, col: minCol, oldValue: undefined, newValue: "", formula: null });
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear formatting:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Clear Comments Handler
  // -------------------------------------------------------------------------
  const handleClearComments = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    try {
      await clearCommentsInRange(minRow, minCol, maxRow, maxCol);
      cellEvents.emit({ row: minRow, col: minCol, oldValue: undefined, newValue: "", formula: null });
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear comments:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Clear Hyperlinks Handler
  // -------------------------------------------------------------------------
  const handleClearHyperlinks = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    try {
      await clearHyperlinksInRange(minRow, minCol, maxRow, maxCol);
      cellEvents.emit({ row: minRow, col: minCol, oldValue: undefined, newValue: "", formula: null });
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear hyperlinks:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Clear All Handler (formatting + contents + comments + hyperlinks)
  // -------------------------------------------------------------------------
  const handleClearAll = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    try {
      await clearRangeWithOptions(minRow, minCol, maxRow, maxCol, "all");
      await clearCommentsInRange(minRow, minCol, maxRow, maxCol);
      await clearHyperlinksInRange(minRow, minCol, maxRow, maxCol);
      cellEvents.emit({ row: minRow, col: minCol, oldValue: undefined, newValue: "", formula: null }, "clear");
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear all:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Insert Row Handler
  // -------------------------------------------------------------------------
  const handleInsertRow = useCallback(async () => {
    if (!selection || selection.type !== "rows") {
      return;
    }

    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const count = endRow - startRow + 1;

    try {
      await insertRows(startRow, count);

      // Notify extensions about the structural change BEFORE refreshing cells,
      // so overlays (e.g., pivot tables) can shift their regions synchronously
      // before the grid redraws.
      emitAppEvent(AppEvents.ROWS_INSERTED, { row: startRow, count });

      // Refresh dimensions from backend (row heights shifted)
      await refreshDimensions();

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateRowInsertion(startRow, count, 200);

      cellEvents.emit({
        row: startRow,
        col: 0,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to insert rows:", error);
    }
  }, [selection, canvasRef, refreshDimensions]);

  // -------------------------------------------------------------------------
  // Insert Column Handler
  // -------------------------------------------------------------------------
  const handleInsertColumn = useCallback(async () => {
    if (!selection || selection.type !== "columns") {
      return;
    }

    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);
    const count = endCol - startCol + 1;

    try {
      await insertColumns(startCol, count);

      // Notify extensions about the structural change BEFORE refreshing cells,
      // so overlays (e.g., pivot tables) can shift their regions synchronously
      // before the grid redraws.
      emitAppEvent(AppEvents.COLUMNS_INSERTED, { col: startCol, count });

      // Refresh dimensions from backend (column widths shifted)
      await refreshDimensions();

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateColumnInsertion(startCol, count, 200);

      cellEvents.emit({
        row: 0,
        col: startCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to insert columns:", error);
    }
  }, [selection, canvasRef, refreshDimensions]);

  // -------------------------------------------------------------------------
  // Delete Row Handler
  // -------------------------------------------------------------------------
  const handleDeleteRow = useCallback(async () => {
    if (!selection || selection.type !== "rows") {
      return;
    }

    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const count = endRow - startRow + 1;

    try {
      await deleteRows(startRow, count);

      // Notify extensions about the structural change BEFORE refreshing cells,
      // so overlays (e.g., pivot tables) can shift their regions synchronously
      // before the grid redraws.
      emitAppEvent(AppEvents.ROWS_DELETED, { row: startRow, count });

      // Refresh dimensions from backend (row heights shifted)
      await refreshDimensions();

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateRowDeletion(startRow, count, 200);

      cellEvents.emit({
        row: startRow,
        col: 0,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to delete rows:", error);
    }
  }, [selection, canvasRef, refreshDimensions]);

  // -------------------------------------------------------------------------
  // Delete Column Handler
  // -------------------------------------------------------------------------
  const handleDeleteColumn = useCallback(async () => {
    if (!selection || selection.type !== "columns") {
      return;
    }

    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);
    const count = endCol - startCol + 1;

    try {
      await deleteColumns(startCol, count);

      // Notify extensions about the structural change BEFORE refreshing cells,
      // so overlays (e.g., pivot tables) can shift their regions synchronously
      // before the grid redraws.
      emitAppEvent(AppEvents.COLUMNS_DELETED, { col: startCol, count });

      // Refresh dimensions from backend (column widths shifted)
      await refreshDimensions();

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateColumnDeletion(startCol, count, 200);

      cellEvents.emit({
        row: 0,
        col: startCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to delete columns:", error);
    }
  }, [selection, canvasRef, refreshDimensions]);

  // -------------------------------------------------------------------------
  // Merge Cells Handler
  // -------------------------------------------------------------------------
  const handleMergeCells = useCallback(async () => {
    if (!selection) return;

    const startRow = Math.min(selection.startRow, selection.endRow);
    const startCol = Math.min(selection.startCol, selection.endCol);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const endCol = Math.max(selection.startCol, selection.endCol);

    // Need at least a 2-cell range to merge
    if (startRow === endRow && startCol === endCol) return;

    try {
      await mergeCells(startRow, startCol, endRow, endCol);
      await canvasRef.current?.refreshCells();
      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to merge cells:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Unmerge Cells Handler
  // -------------------------------------------------------------------------
  const handleUnmergeCells = useCallback(async () => {
    if (!selection) return;

    const row = Math.min(selection.startRow, selection.endRow);
    const col = Math.min(selection.startCol, selection.endCol);

    try {
      await unmergeCells(row, col);
      await canvasRef.current?.refreshCells();
      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to unmerge cells:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Register Command Handlers
  // -------------------------------------------------------------------------
  useEffect(() => {
    gridCommands.register("cut", handleCut);
    gridCommands.register("copy", handleCopy);
    gridCommands.register("paste", handlePaste);
    gridCommands.register("clearContents", handleClearContents);
    gridCommands.register("clearFormatting", handleClearFormatting);
    gridCommands.register("clearComments", handleClearComments);
    gridCommands.register("clearHyperlinks", handleClearHyperlinks);
    gridCommands.register("clearAll", handleClearAll);
    gridCommands.register("insertRow", handleInsertRow);
    gridCommands.register("insertColumn", handleInsertColumn);
    gridCommands.register("deleteRow", handleDeleteRow);
    gridCommands.register("deleteColumn", handleDeleteColumn);
    gridCommands.register("mergeCells", handleMergeCells);
    gridCommands.register("unmergeCells", handleUnmergeCells);

    return () => {
      gridCommands.unregister("cut");
      gridCommands.unregister("copy");
      gridCommands.unregister("paste");
      gridCommands.unregister("clearContents");
      gridCommands.unregister("clearFormatting");
      gridCommands.unregister("clearComments");
      gridCommands.unregister("clearHyperlinks");
      gridCommands.unregister("clearAll");
      gridCommands.unregister("insertRow");
      gridCommands.unregister("insertColumn");
      gridCommands.unregister("deleteRow");
      gridCommands.unregister("deleteColumn");
      gridCommands.unregister("mergeCells");
      gridCommands.unregister("unmergeCells");
    };
  }, [
    handleCut,
    handleCopy,
    handlePaste,
    handleClearContents,
    handleClearFormatting,
    handleClearComments,
    handleClearHyperlinks,
    handleClearAll,
    handleInsertRow,
    handleInsertColumn,
    handleDeleteRow,
    handleDeleteColumn,
    handleMergeCells,
    handleUnmergeCells,
  ]);

  // Keep gridCommands aware of the current selection for guard checks
  useEffect(() => {
    gridCommands.setSelection(selection);
  }, [selection]);

  // -------------------------------------------------------------------------
  // Context Menu Handler - Now emits event instead of rendering
  // -------------------------------------------------------------------------
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.shiftKey) {
        // Allow browser context menu with Shift+right-click
        return;
      }

      // If an overlay (e.g. slicer) already handled the native contextmenu
      // event via a capture-phase listener, skip the grid context menu.
      if (event.nativeEvent.defaultPrevented) {
        return;
      }

      event.preventDefault();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const z = gridState.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;

      // Check if right-click is on the corner (select-all area)
      const isCornerClick = mouseX < (config.rowHeaderWidth || 50) && mouseY < (config.colHeaderHeight || 24);

      if (isCornerClick) {
        // Build context with all-cells selection directly to avoid stale state
        const allSelection: Selection = {
          startRow: 0,
          startCol: 0,
          endRow: config.totalRows - 1,
          endCol: config.totalCols - 1,
          type: "cells",
        };

        emitAppEvent(AppEvents.CONTEXT_MENU_REQUEST, {
          position: { x: event.clientX, y: event.clientY },
          context: {
            selection: allSelection,
            clickedCell: null,
            isWithinSelection: true,
            sheetIndex: gridState.sheetContext.activeSheetIndex,
            sheetName: gridState.sheetContext.activeSheetName,
            dimensions,
          } as GridMenuContext,
        });
        return;
      }

      const clickedCell = getCellFromPixel(
        mouseX,
        mouseY,
        config,
        viewport,
        dimensions
      );

      const menuContext: GridMenuContext = {
        selection,
        clickedCell,
        isWithinSelection: clickedCell
          ? isClickWithinSelection(clickedCell.row, clickedCell.col, selection)
          : false,
        sheetIndex: gridState.sheetContext.activeSheetIndex,
        sheetName: gridState.sheetContext.activeSheetName,
        dimensions,
      };

      // Emit event for Shell to handle rendering
      emitAppEvent(AppEvents.CONTEXT_MENU_REQUEST, {
        position: { x: event.clientX, y: event.clientY },
        context: menuContext,
      });
    },
    [containerRef, config, viewport, dimensions, selection, gridState.sheetContext]
  );

  // -------------------------------------------------------------------------
  // Debounced Resize Observer
  // -------------------------------------------------------------------------
  const resizeTimeoutRef = useRef<number | null>(null);
  const lastDimensionsRef = useRef<{ width: number; height: number } | null>(
    null
  );

  useEffect(() => {
    const gridArea = containerRef.current;
    if (!gridArea) return;

    const updateDimensions = () => {
      const width = gridArea.clientWidth;
      const height = gridArea.clientHeight;

      // Only dispatch if dimensions actually changed significantly
      if (
        width > 0 &&
        height > 0 &&
        (!lastDimensionsRef.current ||
          Math.abs(lastDimensionsRef.current.width - width) > 1 ||
          Math.abs(lastDimensionsRef.current.height - height) > 1)
      ) {
        lastDimensionsRef.current = { width, height };
        dispatch(setViewportDimensions(width, height));
      }
    };

    // Initial update (no debounce)
    updateDimensions();

    const resizeObserver = new ResizeObserver(() => {
      // Clear any pending timeout
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      // Debounce the dimension update to avoid flickering during animations
      resizeTimeoutRef.current = window.setTimeout(() => {
        updateDimensions();
        resizeTimeoutRef.current = null;
      }, RESIZE_DEBOUNCE_MS);
    });

    resizeObserver.observe(gridArea);

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [dispatch, containerRef]);

  const scrollbarMetrics = useScrollbarMetrics({
    config: gridState.config,
    viewport: gridState.viewport,
    viewportDimensions: gridState.viewportDimensions,
    zoom: gridState.zoom,
  });

  const handleHorizontalScroll = useCallback(
    (scrollX: number) => {
      const event = {
        currentTarget: {
          scrollLeft: scrollX,
          scrollTop: gridState.viewport.scrollY,
        },
      } as unknown as React.UIEvent<HTMLDivElement>;
      handleScrollEvent(event);
    },
    [handleScrollEvent, gridState.viewport.scrollY]
  );

  const handleVerticalScroll = useCallback(
    (scrollY: number) => {
      const event = {
        currentTarget: {
          scrollLeft: gridState.viewport.scrollX,
          scrollTop: scrollY,
        },
      } as unknown as React.UIEvent<HTMLDivElement>;
      handleScrollEvent(event);
    },
    [handleScrollEvent, gridState.viewport.scrollX]
  );

  // Split pane scrollbar handlers
  const handleSplitVerticalScroll = useCallback(
    (scrollY: number) => {
      dispatch(setSplitViewport({ ...splitViewport, scrollY }));
    },
    [dispatch, splitViewport]
  );

  const handleSplitHorizontalScroll = useCallback(
    (scrollX: number) => {
      dispatch(setSplitViewport({ ...splitViewport, scrollX }));
    },
    [dispatch, splitViewport]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();

      // Ctrl+Wheel: zoom in/out
      if (event.ctrlKey || event.metaKey) {
        const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const currentZoom = gridState.zoom;
        const newZoom = Math.round((currentZoom + delta) * 100) / 100;
        dispatch(setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom))));
        return;
      }

      const deltaX = event.deltaX;
      const deltaY = event.deltaY;

      // Detect which split pane the mouse is over
      const hasSplitRows = splitConfig.splitRow !== null && splitConfig.splitRow > 0;
      const hasSplitCols = splitConfig.splitCol !== null && splitConfig.splitCol > 0;

      if (hasSplitRows || hasSplitCols) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const z = gridState.zoom;
          const mouseX = (event.clientX - rect.left) / z;
          const mouseY = (event.clientY - rect.top) / z;
          const positions = getSplitBarPositions();

          const isInTopPane = hasSplitRows && positions?.horizontalBarY != null && mouseY < positions.horizontalBarY;
          const isInLeftPane = hasSplitCols && positions?.verticalBarX != null && mouseX < positions.verticalBarX;

          // For horizontal split: top pane scrolls splitViewport.scrollY, bottom scrolls main viewport.scrollY
          // Both panes share horizontal scroll from their respective viewports
          if (isInTopPane || isInLeftPane) {
            // Mouse is in a split pane - update splitViewport
            const newSvpScrollX = isInLeftPane
              ? Math.max(0, Math.min(scrollbarMetrics.maxScrollX, splitViewport.scrollX + deltaX))
              : splitViewport.scrollX;
            const newSvpScrollY = isInTopPane
              ? Math.max(0, Math.min(scrollbarMetrics.maxScrollY, splitViewport.scrollY + deltaY))
              : splitViewport.scrollY;

            if (newSvpScrollX !== splitViewport.scrollX || newSvpScrollY !== splitViewport.scrollY) {
              dispatch(setSplitViewport({ ...splitViewport, scrollX: newSvpScrollX, scrollY: newSvpScrollY }));
            }

            // If in top pane but NOT in left pane, also scroll main viewport horizontally
            if (isInTopPane && !isInLeftPane) {
              const newMainScrollX = Math.max(0, Math.min(scrollbarMetrics.maxScrollX, gridState.viewport.scrollX + deltaX));
              if (newMainScrollX !== gridState.viewport.scrollX) {
                const syntheticEvent = {
                  currentTarget: { scrollLeft: newMainScrollX, scrollTop: gridState.viewport.scrollY },
                } as unknown as React.UIEvent<HTMLDivElement>;
                handleScrollEvent(syntheticEvent);
              }
            }

            // If in left pane but NOT in top pane, also scroll main viewport vertically
            if (isInLeftPane && !isInTopPane) {
              const newMainScrollY = Math.max(0, Math.min(scrollbarMetrics.maxScrollY, gridState.viewport.scrollY + deltaY));
              if (newMainScrollY !== gridState.viewport.scrollY) {
                const syntheticEvent = {
                  currentTarget: { scrollLeft: gridState.viewport.scrollX, scrollTop: newMainScrollY },
                } as unknown as React.UIEvent<HTMLDivElement>;
                handleScrollEvent(syntheticEvent);
              }
            }
            return;
          }
        }
      }

      // Default: scroll main viewport (bottom-right pane or no split)
      const newScrollX = Math.max(
        0,
        Math.min(
          scrollbarMetrics.maxScrollX,
          gridState.viewport.scrollX + deltaX
        )
      );
      const newScrollY = Math.max(
        0,
        Math.min(
          scrollbarMetrics.maxScrollY,
          gridState.viewport.scrollY + deltaY
        )
      );

      if (
        newScrollX !== gridState.viewport.scrollX ||
        newScrollY !== gridState.viewport.scrollY
      ) {
        const syntheticEvent = {
          currentTarget: {
            scrollLeft: newScrollX,
            scrollTop: newScrollY,
          },
        } as unknown as React.UIEvent<HTMLDivElement>;
        handleScrollEvent(syntheticEvent);
      }
    },
    [
      handleScrollEvent,
      gridState.viewport.scrollX,
      gridState.viewport.scrollY,
      gridState.zoom,
      scrollbarMetrics,
      dispatch,
      splitConfig,
      splitViewport,
      getSplitBarPositions,
      containerRef,
    ]
  );

  const viewportWidth =
    (gridState.viewportDimensions.width - SCROLLBAR_SIZE) / gridState.zoom - config.rowHeaderWidth;
  const viewportHeight =
    (gridState.viewportDimensions.height - SCROLLBAR_SIZE) / gridState.zoom -
    config.colHeaderHeight;

  // -------------------------------------------------------------------------
  // Split bar drag wrappers
  // -------------------------------------------------------------------------
  const wrappedMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) { handleMouseDown(event); return; }
      const z = gridState.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;

      const hitBar = hitTestSplitBar(mouseX, mouseY);
      if (hitBar) {
        event.preventDefault();
        event.stopPropagation();
        setSplitDrag({
          axis: hitBar,
          startPixel: hitBar === "row" ? mouseY : mouseX,
          startValue: hitBar === "row" ? (splitConfig.splitRow ?? 0) : (splitConfig.splitCol ?? 0),
        });
        return;
      }
      handleMouseDown(event);
    },
    [handleMouseDown, hitTestSplitBar, splitConfig, containerRef, gridState.zoom]
  );

  const wrappedMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) { handleMouseMove(event); return; }
      const z = gridState.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;

      // During split drag, update the split position
      if (splitDrag) {
        event.preventDefault();
        if (splitDrag.axis === "row") {
          const newRow = pixelYToSplitRow(mouseY);
          if (newRow !== splitConfig.splitRow) {
            dispatch(setSplitConfig(newRow, splitConfig.splitCol));
          }
        } else {
          const newCol = pixelXToSplitCol(mouseX);
          if (newCol !== splitConfig.splitCol) {
            dispatch(setSplitConfig(splitConfig.splitRow, newCol));
          }
        }
        return;
      }

      // Check hover over split bar for cursor
      const hitBar = hitTestSplitBar(mouseX, mouseY);
      if (hitBar === "col") {
        setSplitBarCursor("col-resize");
      } else if (hitBar === "row") {
        setSplitBarCursor("row-resize");
      } else if (splitBarCursor) {
        setSplitBarCursor(null);
      }

      handleMouseMove(event);
    },
    [handleMouseMove, splitDrag, hitTestSplitBar, splitConfig, splitBarCursor,
     pixelYToSplitRow, pixelXToSplitCol, containerRef, gridState.zoom, dispatch]
  );

  const wrappedMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (splitDrag) {
        // Persist the new split position to backend and emit events for sync
        backendSetSplitWindow(splitConfig.splitRow, splitConfig.splitCol).then(() => {
          emitAppEvent(AppEvents.SPLIT_CHANGED, {
            splitRow: splitConfig.splitRow,
            splitCol: splitConfig.splitCol,
          });
          emitAppEvent(AppEvents.GRID_REFRESH);
        });
        setSplitDrag(null);
        return;
      }
      handleMouseUp(event);
    },
    [handleMouseUp, splitDrag, splitConfig]
  );

  // Determine effective cursor: split bar takes priority
  const effectiveCursor = splitDrag
    ? (splitDrag.axis === "row" ? "row-resize" : "col-resize")
    : splitBarCursor;

  return (
    <S.SpreadsheetContainer
      ref={focusContainerRef}
      className={className}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
      data-focus-container="spreadsheet"
    >
      {/* Grid Area with Scrollbars */}
      <S.GridArea
        ref={containerRef}
        data-grid-area
        onMouseDown={wrappedMouseDown}
        onMouseMove={wrappedMouseMove}
        onMouseUp={wrappedMouseUp}
        onDoubleClick={handleDoubleClickEvent}
        style={effectiveCursor ? { cursor: effectiveCursor } : undefined}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      >
        {/* Grid Canvas */}
        <S.CanvasLayer $scrollbarSize={SCROLLBAR_SIZE}>
          <GridCanvas
            ref={canvasRef}
            config={config}
            viewport={viewport}
            selection={selection}
            editing={editing}
            formulaReferences={formulaReferences}
            styleCache={styleCache}
            dimensions={dimensions}
            clipboardSelection={clipboardSelection}
            clipboardMode={clipboardMode}
            fillPreviewRange={fillState.previewRange}
            selectionDragPreview={selectionDragPreview}
            selectionDragMode={selectionDragMode}
            freezeConfig={freezeConfig}
            splitConfig={splitConfig}
            splitViewport={splitViewport}
            viewMode={viewMode}
            showFormulas={showFormulas}
            displayZeros={displayZeros}
            displayGridlines={displayGridlines}
            displayHeadings={displayHeadings}
            currentSheetName={gridState.sheetContext.activeSheetName}
            zoom={gridState.zoom}
          />

          {editing && isEditing && (
            <InlineEditor
              config={config}
              viewport={viewport}
              editing={editing}
              dimensions={dimensions}
              zoom={gridState.zoom}
              onValueChange={handleInlineValueChange}
              onCommit={handleInlineCommit}
              onCancel={handleInlineCancel}
              onTab={handleInlineTab}
              onEnter={handleInlineEnter}
              onCtrlEnter={handleInlineCtrlEnter}
              onRestoreFocus={() => focusContainerRef.current?.focus()}
              onArrowKeyReference={handleArrowKeyReference}
            />
          )}
        </S.CanvasLayer>

        {/* Scrollbars — split mode renders pairs, normal mode renders singles */}
        {(() => {
          const hasSplitRows = splitConfig.splitRow !== null && splitConfig.splitRow > 0;
          const hasSplitCols = splitConfig.splitCol !== null && splitConfig.splitCol > 0;
          const hasSplit = hasSplitRows || hasSplitCols;

          if (hasSplit) {
            const positions = getSplitBarPositions();
            const z = gridState.zoom;
            const splitYDom = positions?.horizontalBarY != null ? positions.horizontalBarY * z : 0;
            const splitXDom = positions?.verticalBarX != null ? positions.verticalBarX * z : 0;
            const splitBarDom = SPLIT_BAR_SIZE * z;

            // Compute per-pane viewport sizes (virtual pixels)
            const splitFreezeConfig = {
              freezeRow: splitConfig.splitRow ?? null,
              freezeCol: splitConfig.splitCol ?? null,
            };
            const splitLayout = calculateFreezePaneLayout(splitFreezeConfig, config, dimensions);
            const topPaneVpH = splitLayout.frozenRowsHeight;
            const bottomPaneVpH = Math.max(1, viewportHeight - topPaneVpH - SPLIT_BAR_SIZE);
            const leftPaneVpW = splitLayout.frozenColsWidth;
            const rightPaneVpW = Math.max(1, viewportWidth - leftPaneVpW - SPLIT_BAR_SIZE);

            return (
              <>
                {/* Vertical scrollbars */}
                {scrollbarMetrics.showVertical && hasSplitRows && (
                  <>
                    {/* Top pane vertical scrollbar (splitViewport.scrollY) */}
                    <Scrollbar
                      orientation="vertical"
                      scrollPosition={splitViewport.scrollY}
                      contentSize={scrollbarMetrics.contentHeight}
                      viewportSize={topPaneVpH > 0 ? topPaneVpH : 1}
                      onScroll={handleSplitVerticalScroll}
                      thickness={SCROLLBAR_SIZE}
                      style={{
                        top: 0,
                        right: 0,
                        bottom: "auto",
                        height: splitYDom,
                        width: SCROLLBAR_SIZE,
                      }}
                    />
                    {/* Bottom pane vertical scrollbar (viewport.scrollY) */}
                    <Scrollbar
                      orientation="vertical"
                      scrollPosition={gridState.viewport.scrollY}
                      contentSize={scrollbarMetrics.contentHeight}
                      viewportSize={bottomPaneVpH > 0 ? bottomPaneVpH : 1}
                      onScroll={handleVerticalScroll}
                      thickness={SCROLLBAR_SIZE}
                      style={{
                        top: splitYDom + splitBarDom,
                        right: 0,
                        bottom: SCROLLBAR_SIZE,
                        height: "auto",
                        width: SCROLLBAR_SIZE,
                      }}
                    />
                  </>
                )}
                {scrollbarMetrics.showVertical && !hasSplitRows && (
                  <Scrollbar
                    orientation="vertical"
                    scrollPosition={gridState.viewport.scrollY}
                    contentSize={scrollbarMetrics.contentHeight}
                    viewportSize={viewportHeight > 0 ? viewportHeight : 1}
                    onScroll={handleVerticalScroll}
                    thickness={SCROLLBAR_SIZE}
                  />
                )}

                {/* Horizontal scrollbars */}
                {scrollbarMetrics.showHorizontal && hasSplitCols && (
                  <>
                    {/* Left pane horizontal scrollbar (splitViewport.scrollX) */}
                    <Scrollbar
                      orientation="horizontal"
                      scrollPosition={splitViewport.scrollX}
                      contentSize={scrollbarMetrics.contentWidth}
                      viewportSize={leftPaneVpW > 0 ? leftPaneVpW : 1}
                      onScroll={handleSplitHorizontalScroll}
                      thickness={SCROLLBAR_SIZE}
                      style={{
                        bottom: 0,
                        left: 0,
                        right: "auto",
                        width: splitXDom,
                        height: SCROLLBAR_SIZE,
                      }}
                    />
                    {/* Right pane horizontal scrollbar (viewport.scrollX) */}
                    <Scrollbar
                      orientation="horizontal"
                      scrollPosition={gridState.viewport.scrollX}
                      contentSize={scrollbarMetrics.contentWidth}
                      viewportSize={rightPaneVpW > 0 ? rightPaneVpW : 1}
                      onScroll={handleHorizontalScroll}
                      thickness={SCROLLBAR_SIZE}
                      style={{
                        bottom: 0,
                        left: splitXDom + splitBarDom,
                        right: SCROLLBAR_SIZE,
                        width: "auto",
                        height: SCROLLBAR_SIZE,
                      }}
                    />
                  </>
                )}
                {scrollbarMetrics.showHorizontal && !hasSplitCols && (
                  <Scrollbar
                    orientation="horizontal"
                    scrollPosition={gridState.viewport.scrollX}
                    contentSize={scrollbarMetrics.contentWidth}
                    viewportSize={viewportWidth > 0 ? viewportWidth : 1}
                    onScroll={handleHorizontalScroll}
                    thickness={SCROLLBAR_SIZE}
                  />
                )}

                <ScrollbarCorner size={SCROLLBAR_SIZE} />
              </>
            );
          }

          // Non-split mode: standard single scrollbars
          return (
            <>
              {scrollbarMetrics.showVertical && (
                <Scrollbar
                  orientation="vertical"
                  scrollPosition={gridState.viewport.scrollY}
                  contentSize={scrollbarMetrics.contentHeight}
                  viewportSize={viewportHeight > 0 ? viewportHeight : 1}
                  onScroll={handleVerticalScroll}
                  thickness={SCROLLBAR_SIZE}
                />
              )}
              {scrollbarMetrics.showHorizontal && (
                <Scrollbar
                  orientation="horizontal"
                  scrollPosition={gridState.viewport.scrollX}
                  contentSize={scrollbarMetrics.contentWidth}
                  viewportSize={viewportWidth > 0 ? viewportWidth : 1}
                  onScroll={handleHorizontalScroll}
                  thickness={SCROLLBAR_SIZE}
                />
              )}
              <ScrollbarCorner size={SCROLLBAR_SIZE} />
            </>
          );
        })()}
      </S.GridArea>

      {/* Context Menu is now rendered by Shell via GridContextMenuHost */}
    </S.SpreadsheetContainer>
  );
}

export function Spreadsheet({
  className,
}: SpreadsheetContentProps): React.ReactElement {
  return <SpreadsheetContent className={className} />;
}

export default Spreadsheet;