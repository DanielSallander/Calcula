//! FILENAME: app/src/core/components/Spreadsheet/Spreadsheet.tsx
// PURPOSE: Main spreadsheet component combining grid, editor, and scrollbars
// CONTEXT: Core component that orchestrates the spreadsheet experience
// REFACTOR: Removed legacy Find/Replace event listeners (logic moved to Extensions)

import React, { useCallback, useEffect, useRef } from "react";
import { useGridState, useGridContext } from "../../state";
// FIX: Removed openFind import to resolve SyntaxError
import { setViewportDimensions, setAllDimensions, setSelection } from "../../state/gridActions";
import type { Selection, Viewport, VirtualBounds } from "../../types";
import { GridCanvas } from "../Grid";
import { InlineEditor } from "../InlineEditor";
import { Scrollbar, ScrollbarCorner } from "../Scrollbar/Scrollbar";
import { useScrollbarMetrics } from "../Scrollbar/useScrollbarMetrics";
import { useSpreadsheet } from "./useSpreadsheet";
import {
  clearRange,
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  getAllColumnWidths,
  getAllRowHeights,
} from "../../lib/tauri-api";
import { cellEvents } from "../../lib/cellEvents";
import { getCellFromPixel } from "../../lib/gridRenderer";
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
  } = state;

  // 5. Extract freezeConfig from gridState
  const { freezeConfig } = gridState;

  // -------------------------------------------------------------------------
  // Helper: Refresh dimensions from backend
  // -------------------------------------------------------------------------
  const refreshDimensions = useCallback(async () => {
    try {
      const [colWidths, rowHeights] = await Promise.all([
        getAllColumnWidths(),
        getAllRowHeights(),
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

    // Listen for the event that fires BEFORE the sheet switch (to save state)
    window.addEventListener("sheet:beforeSwitch", handleSheetSwitchStart);
    window.addEventListener("sheet:normalSwitch", handleSheetSwitch);

    return () => {
      window.removeEventListener("sheet:beforeSwitch", handleSheetSwitchStart);
      window.removeEventListener("sheet:normalSwitch", handleSheetSwitch);
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
      });
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear contents:", error);
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
  // Register Command Handlers
  // -------------------------------------------------------------------------
  useEffect(() => {
    gridCommands.register("cut", handleCut);
    gridCommands.register("copy", handleCopy);
    gridCommands.register("paste", handlePaste);
    gridCommands.register("clearContents", handleClearContents);
    gridCommands.register("insertRow", handleInsertRow);
    gridCommands.register("insertColumn", handleInsertColumn);
    gridCommands.register("deleteRow", handleDeleteRow);
    gridCommands.register("deleteColumn", handleDeleteColumn);

    return () => {
      gridCommands.unregister("cut");
      gridCommands.unregister("copy");
      gridCommands.unregister("paste");
      gridCommands.unregister("clearContents");
      gridCommands.unregister("insertRow");
      gridCommands.unregister("insertColumn");
      gridCommands.unregister("deleteRow");
      gridCommands.unregister("deleteColumn");
    };
  }, [
    handleCut,
    handleCopy,
    handlePaste,
    handleClearContents,
    handleInsertRow,
    handleInsertColumn,
    handleDeleteRow,
    handleDeleteColumn,
  ]);

  // -------------------------------------------------------------------------
  // Context Menu Handler - Now emits event instead of rendering
  // -------------------------------------------------------------------------
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.shiftKey) {
        // Allow browser context menu with Shift+right-click
        return;
      }

      event.preventDefault();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

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

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();

      const deltaX = event.deltaX;
      const deltaY = event.deltaY;

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
      scrollbarMetrics,
    ]
  );

  const viewportWidth =
    gridState.viewportDimensions.width - config.rowHeaderWidth - SCROLLBAR_SIZE;
  const viewportHeight =
    gridState.viewportDimensions.height -
    config.colHeaderHeight -
    SCROLLBAR_SIZE;

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
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClickEvent}
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
            freezeConfig={freezeConfig}
            currentSheetName={gridState.sheetContext.activeSheetName}
          />

          {editing && isEditing && (
            <InlineEditor
              config={config}
              viewport={viewport}
              editing={editing}
              dimensions={dimensions}
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

        {/* Vertical Scrollbar */}
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

        {/* Horizontal Scrollbar */}
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

        {/* Corner piece */}
        <ScrollbarCorner size={SCROLLBAR_SIZE} />
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