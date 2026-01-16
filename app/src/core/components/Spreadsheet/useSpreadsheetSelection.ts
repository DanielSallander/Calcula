// FILENAME: app/src/components/Spreadsheet/useSpreadsheetSelection.ts
// PURPOSE: Handles mouse/keyboard interaction and selection state.
// CONTEXT: Coordinates global selection hooks with local canvas events.
// Includes fill handle and clipboard support with marching ants.
// FIX: Added focusContainerRef parameter for keyboard event handling.
// FIX: Added onDelete handler to useGridKeyboard to clear selection on DELETE key.

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
} from "../../lib/tauri-api";
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
    extendTo, 
    moveActiveCell, 
    getSelectionReference, 
    selectColumn, 
    selectRow 
  } = useSelection();

  const {
    isEditing,
    isFormulaMode,
    startEditing,
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
  } = useEditing();

  // Clipboard hook
  const { 
    cut, 
    copy, 
    paste, 
    clipboardMode, 
    clipboardSelection,
    clearClipboardState,
    hasClipboardData,
  } = useClipboard();

  // Fill handle hook
  const {
    fillState,
    isOverFillHandle,
    startFillDrag,
    updateFillDrag,
    completeFill,
    cancelFill,
    autoFillToEdge,
  } = useFillHandle();

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
    (scrollX: number, scrollY: number) => {
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

  const {
    isDragging,
    isFormulaDragging,
    isResizing,
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
    onExtendTo: extendTo,
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
  });

  // Wrap mouse handlers to include fill handle logic
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Check if clicking on fill handle
      if (isOverFillHandle(mouseX, mouseY)) {
        event.preventDefault();
        startFillDrag(mouseX, mouseY);
        return;
      }

      baseHandleMouseDown(event);
    },
    [baseHandleMouseDown, isOverFillHandle, startFillDrag]
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

  // Keyboard handling with clipboard shortcuts, ESC to clear clipboard, and DELETE to clear contents
  // FIX: Use focusContainerRef instead of containerRef for keyboard events
  // The focusContainerRef points to the focusable outer container that receives keyboard events
  useGridKeyboard({
    containerRef: focusContainerRef,
    enabled: isFocused && !isEditing,
    onCut: cut,
    onCopy: copy,
    onPaste: paste,
    onUndo: async () => {
      console.log("[Keyboard] Undo - not yet implemented");
    },
    onRedo: async () => {
      console.log("[Keyboard] Redo - not yet implemented");
    },
    onClearClipboard: clearClipboardState,
    hasClipboardContent: clipboardMode !== "none",
    onDelete: handleDeleteContents,
  });

  const handleDoubleClickEvent = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const cell = getDoubleClickCell(event);
      if (cell) {
        selectCell(cell.row, cell.col);
        startEditing();
      }
    },
    [getDoubleClickCell, selectCell, startEditing]
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