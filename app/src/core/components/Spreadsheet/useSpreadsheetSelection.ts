//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetSelection.ts
// PURPOSE: Handles mouse/keyboard interaction and selection state.
// CONTEXT: Coordinates global selection hooks with local canvas events.
// Includes fill handle and clipboard support with marching ants.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  useSelection,
  useMouseSelection,
  useGridKeyboard,
  useCellEvents,
  useEditing,
  useViewport,
  useClipboard,
  useFillHandle,
} from "../../hooks";
import { useGridState, useGridContext } from "../../state";
import {
  getCell,
  setColumnWidth as setColumnWidthApi,
  setRowHeight as setRowHeightApi,
  clearRange,
  undo as undoApi,
  redo as redoApi,
} from "../../lib/tauri-api";
import { checkCellClickInterceptors } from "../../lib/cellClickInterceptors";
import { setColumnWidth, setRowHeight } from "../../state/gridActions";
import { cellEvents } from "../../lib/cellEvents";
import type { GridCanvasHandle } from "../Grid";

type GridState = ReturnType<typeof useGridState>;
type GridDispatch = ReturnType<typeof useGridContext>["dispatch"];

interface UseSpreadsheetSelectionProps {
  canvasRef: React.RefObject<GridCanvasHandle | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** FIX: Separate ref for keyboard focus container */
  focusContainerRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  state: GridState;
  dispatch: GridDispatch;
  isFocused: boolean;
  onCommitBeforeSelect: () => Promise<void>;
}

export function useSpreadsheetSelection({
  canvasRef,
  containerRef,
  focusContainerRef,
  scrollRef,
  state,
  dispatch,
  isFocused,
  onCommitBeforeSelect
}: UseSpreadsheetSelectionProps) {
  const [selectedCellContent, setSelectedCellContent] = useState<string>("");
  const { viewport, config, selection, dimensions } = state;

  const { scrollToSelection, registerScrollContainer } = useViewport();

  const {
    selectCell,
    selectCellWithMergeExpansion,
    extendToWithMergeExpansion,  // FIX: Added for merge-aware drag selection
    moveActiveCell,
    getSelectionReference,
    selectColumn,
    selectRow
  } = useSelection();

  const {
    isEditing,
    isFormulaMode,
    startEdit,  // FIX: Added startEdit to avoid stale state issues
    insertReference,
    insertRangeReference,
    insertColumnReference,
    insertColumnRangeReference,
    insertRowReference,
    insertRowRangeReference,
    updatePendingReference,
    updatePendingColumnReference,
    updatePendingRowReference,
    clearPendingReference,
    startRefDrag,
    updateRefDrag,
    completeRefDrag,
    cancelRefDrag,
  } = useEditing();

  // Clipboard hook
  const { 
    cut, 
    copy, 
    paste, 
    clipboardMode, 
    clipboardSelection,
    clearClipboardState,
  } = useClipboard();

  // Fill handle hook with auto-scroll support
  const {
    fillState,
    isOverFillHandle,
    startFillDrag,
    updateFillDrag,
    completeFill,
    autoFillToEdge,
  } = useFillHandle({
    containerRef,
    config: state.config,
  });

  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Register the scroll container so useViewport can sync DOM scroll position
  useEffect(() => {
    if (scrollRef.current) {
      registerScrollContainer(scrollRef.current);
    }
  }, [scrollRef, registerScrollContainer]);

  useEffect(() => {
    if (!selection || isEditing) {
      return;
    }

    const fetchCellContent = async () => {
      try {
        const cellData = await getCell(selection.endRow, selection.endCol);
        const content = cellData?.formula || cellData?.display || "";
        setSelectedCellContent(content);
      } catch (error) {
        console.error("Failed to fetch cell content:", error);
        setSelectedCellContent("");
      }
    };

    fetchCellContent();
  }, [selection?.endRow, selection?.endCol, isEditing]);

  useCellEvents(
    useCallback(
      (event) => {
        if (pendingRefreshRef.current) {
          clearTimeout(pendingRefreshRef.current);
        }

        pendingRefreshRef.current = setTimeout(async () => {
          pendingRefreshRef.current = null;
          
          const canvas = canvasRef.current;
          if (canvas) {
            await canvas.refreshCells();
            canvas.redraw();
          }
        }, 10);

        if (
          selection &&
          event.row === selection.endRow &&
          event.col === selection.endCol &&
          !isEditing
        ) {
          setSelectedCellContent(event.formula || event.newValue);
        }
      },
      [selection, isEditing, canvasRef]
    )
  );

  useEffect(() => {
    return () => {
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current);
      }
    };
  }, []);

  const handleScrollUpdate = useCallback(
    (_scrollX: number, _scrollY: number) => {
      if (scrollRef.current) {
        canvasRef.current?.redraw();
      }
    },
    [canvasRef, scrollRef]
  );

  const handleDragEnd = useCallback(() => {
    canvasRef.current?.redraw();
  }, [canvasRef]);

  const handleColumnResize = useCallback(
    (col: number, width: number) => {
      dispatch(setColumnWidth(col, width));
      setColumnWidthApi(col, width).catch((err) => {
        console.error("Failed to persist column width:", err);
      });
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  const handleRowResize = useCallback(
    (row: number, height: number) => {
      dispatch(setRowHeight(row, height));
      setRowHeightApi(row, height).catch((err) => {
        console.error("Failed to persist row height:", err);
      });
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  // Handle fill handle double-click (auto-fill to edge)
  const handleFillHandleDoubleClick = useCallback(() => {
    autoFillToEdge();
  }, [autoFillToEdge]);

  // Handle DELETE key - clear contents of selection
  const handleDeleteContents = useCallback(async () => {
    if (!selection) {
      console.log("[useSpreadsheetSelection] No selection to clear");
      return;
    }

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    console.log(`[useSpreadsheetSelection] Clearing contents from (${minRow},${minCol}) to (${maxRow},${maxCol})`);

    try {
      const clearedCount = await clearRange(minRow, minCol, maxRow, maxCol);
      console.log(`[useSpreadsheetSelection] Clear contents complete - ${clearedCount} cells cleared`);
      
      // Emit a single event to trigger refresh
      cellEvents.emit({
        row: minRow,
        col: minCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Failed to clear contents:", error);
    }
  }, [selection]);

  // Handle Undo (Ctrl+Z)
  const handleUndo = useCallback(async () => {
    console.log("[useSpreadsheetSelection] Undo requested");
    try {
      const result = await undoApi();
      console.log(`[useSpreadsheetSelection] Undo complete - ${result.updatedCells.length} cells updated`);
      
      // Trigger canvas refresh
      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }
      
      // Emit event to update any listeners (e.g., formula bar)
      if (result.updatedCells.length > 0) {
        const firstCell = result.updatedCells[0];
        cellEvents.emit({
          row: firstCell.row,
          col: firstCell.col,
          oldValue: undefined,
          newValue: firstCell.display,
          formula: firstCell.formula || null,
        });
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Undo failed:", error);
    }
  }, [canvasRef]);

  // Handle Redo (Ctrl+Y or Ctrl+Shift+Z)
  const handleRedo = useCallback(async () => {
    console.log("[useSpreadsheetSelection] Redo requested");
    try {
      const result = await redoApi();
      console.log(`[useSpreadsheetSelection] Redo complete - ${result.updatedCells.length} cells updated`);
      
      // Trigger canvas refresh
      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }
      
      // Emit event to update any listeners (e.g., formula bar)
      if (result.updatedCells.length > 0) {
        const firstCell = result.updatedCells[0];
        cellEvents.emit({
          row: firstCell.row,
          col: firstCell.col,
          oldValue: undefined,
          newValue: firstCell.display,
          formula: firstCell.formula || null,
        });
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Redo failed:", error);
    }
  }, [canvasRef]);

  // FIX: Wrapper for extendTo that uses merge expansion during drag
  // This is passed to useMouseSelection for drag operations
  const handleExtendTo = useCallback(
    (row: number, col: number) => {
      // Use merge-aware extension for drag selection
      // The async nature is fine - selection will update when promise resolves
      extendToWithMergeExpansion(row, col);
    },
    [extendToWithMergeExpansion]
  );

  const {
    isDragging,
    isFormulaDragging,
    isResizing,
    isRefDragging,
    cursorStyle,
    handleMouseDown: baseHandleMouseDown,
    handleMouseMove: baseHandleMouseMove,
    handleMouseUp: baseHandleMouseUp,
    handleDoubleClick: getDoubleClickCell,
  } = useMouseSelection({
    containerRef,
    scrollRef,
    config,
    viewport,
    selection,
    dimensions,
    isFormulaMode,
    onSelectCell: selectCell,
    onExtendTo: handleExtendTo,  // FIX: Use merge-aware extension for drag selection
    onScroll: handleScrollUpdate,
    onDragEnd: handleDragEnd,
    onInsertReference: insertReference,
    onInsertRangeReference: insertRangeReference,
    onInsertColumnReference: insertColumnReference,
    onInsertColumnRangeReference: insertColumnRangeReference,
    onInsertRowReference: insertRowReference,
    onInsertRowRangeReference: insertRowRangeReference,
    onUpdatePendingReference: updatePendingReference,
    onUpdatePendingColumnReference: updatePendingColumnReference,
    onUpdatePendingRowReference: updatePendingRowReference,
    onClearPendingReference: clearPendingReference,
    onCommitBeforeSelect: onCommitBeforeSelect,
    onColumnResize: handleColumnResize,
    onRowResize: handleRowResize,
    onSelectColumn: selectColumn,
    onSelectRow: selectRow,
    onFillHandleDoubleClick: handleFillHandleDoubleClick,
    onStartRefDrag: startRefDrag,
    onUpdateRefDrag: updateRefDrag,
    onCompleteRefDrag: completeRefDrag,
    onCancelRefDrag: cancelRefDrag,
  });

  // Wrap mouse handlers to include fill handle logic and extension click interception
  const handleMouseDown = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Check if clicking on fill handle
      if (isOverFillHandle(mouseX, mouseY)) {
        event.preventDefault();
        startFillDrag(mouseX, mouseY);
        return;
      }

      // Get cell from click position to check for extension click interceptors
      const { getCellFromPixel } = await import("../../lib/gridRenderer");
      const clickedCell = getCellFromPixel(mouseX, mouseY, state.config, state.viewport, state.dimensions);

      if (clickedCell) {
        // Let extensions intercept the click (e.g., pivot filter dropdowns)
        const intercepted = await checkCellClickInterceptors(
          clickedCell.row,
          clickedCell.col,
          { clientX: event.clientX, clientY: event.clientY }
        );
        if (intercepted) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      baseHandleMouseDown(event);
    },
    [baseHandleMouseDown, isOverFillHandle, startFillDrag, state.config, state.viewport, state.dimensions]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Handle fill drag
      if (fillState.isDragging) {
        updateFillDrag(mouseX, mouseY);
        return;
      }

      baseHandleMouseMove(event);
    },
    [baseHandleMouseMove, fillState.isDragging, updateFillDrag]
  );

  const handleMouseUp = useCallback(() => {
    // Complete fill if dragging
    if (fillState.isDragging) {
      completeFill();
      return;
    }

    baseHandleMouseUp();
  }, [baseHandleMouseUp, fillState.isDragging, completeFill]);

  // Get cursor style including fill handle
  const getCursorStyle = useCallback((): string => {
    if (fillState.isDragging) {
      return "crosshair";
    }
    return cursorStyle;
  }, [fillState.isDragging, cursorStyle]);

  // Global mouse handlers for fill handle dragging
  // This allows fill drag to continue even when mouse leaves the canvas
  useEffect(() => {
    if (!fillState.isDragging) return;

    const handleGlobalMouseMove = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      updateFillDrag(mouseX, mouseY);
    };

    const handleGlobalMouseUp = () => {
      completeFill();
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [fillState.isDragging, containerRef, updateFillDrag, completeFill]);

  // Keyboard handling with clipboard shortcuts, ESC to clear clipboard, DELETE to clear contents, and undo/redo
  // FIX: Use focusContainerRef instead of containerRef for keyboard events
  // The focusContainerRef points to the focusable outer container that receives keyboard events
  // FIX: Don't use isEditing in enabled prop - it's stale React state after commit.
  // useGridKeyboard internally checks getGlobalIsEditing() synchronously in handleKeyDown,
  // which correctly reflects the current editing state.
  useGridKeyboard({
    containerRef: focusContainerRef,
    enabled: isFocused,
    onCut: cut,
    onCopy: copy,
    onPaste: paste,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onClearClipboard: clearClipboardState,
    hasClipboardContent: clipboardMode !== "none",
    onDelete: handleDeleteContents,
  });

  /**
   * Handle double-click to start editing.
   * FIX: Call startEdit directly with the clicked cell coordinates.
   * This avoids the stale state issue where startEditing reads from
   * state.selection before React has updated it from the prior
   * selectCellWithMergeExpansion call.
   * startEdit will internally resolve to the master cell if this
   * cell is part of a merged region.
   */
  const handleDoubleClickEvent = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      const cell = getDoubleClickCell(event);
      if (cell) {
        // First expand selection to cover merged region (for visual feedback)
        await selectCellWithMergeExpansion(cell.row, cell.col);
        // FIX: Call startEdit directly with the clicked coordinates
        // startEdit will resolve to master cell and fetch content correctly
        // This avoids the stale closure issue where startEditing reads old state
        await startEdit(cell.row, cell.col);
      }
    },
    [getDoubleClickCell, selectCellWithMergeExpansion, startEdit]
  );

  return {
    selectedCellContent,
    setSelectedCellContent,
    mouseHandlers: {
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      cursorStyle: getCursorStyle(),
    },
    mouseState: {
      isDragging,
      isFormulaDragging,
      isResizing,
      isRefDragging,
      isFillDragging: fillState.isDragging,
    },
    fillState,
    clipboardHandlers: {
      cut,
      copy,
      paste,
    },
    clipboardState: {
      mode: clipboardMode,
      selection: clipboardSelection,
    },
    handleDoubleClickEvent,
    getSelectionReference,
    selectCell,
    moveActiveCell,
    scrollToSelection,
  };
}