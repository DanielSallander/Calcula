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
  applyFormatting,
  getStyle,
  getAllStyles,
  getCellsInCols,
  getCellsInRows,
  updateCell,
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  type CellUpdateInput,
} from "../../lib/tauri-api";
import type { FormattingOptions } from "../../types";
import { DEFAULT_THEME, measureOptimalColumnWidth, measureOptimalRowHeight } from "../../lib/gridRenderer";
import { checkCellClickInterceptors } from "../../lib/cellClickInterceptors";
import { checkCellDoubleClickInterceptors } from "../../lib/cellDoubleClickInterceptors";
import { checkEditGuards } from "../../lib/editGuards";
import { setColumnWidth, setRowHeight, setManuallyHiddenCols, setManuallyHiddenRows } from "../../state/gridActions";
import { cellEvents } from "../../lib/cellEvents";
import { CommandRegistry } from "../../../api/commands";
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
  const { viewport, config, selection, dimensions, formulaReferences, sheetContext } = state;

  const { scrollToSelection, registerScrollContainer } = useViewport();

  const {
    selectCell,
    selectCellWithMergeExpansion,
    extendToWithMergeExpansion,  // FIX: Added for merge-aware drag selection
    moveActiveCell,
    getSelectionReference,
    selectColumn,
    selectRow,
    addCellToSelection,
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
    startRefResize,
    updateRefResize,
    completeRefResize,
    cancelRefResize,
  } = useEditing();

  // Clipboard hook
  const {
    cut,
    copy,
    paste,
    clipboardMode,
    clipboardSelection,
    clearClipboardState,
    moveCells,
    moveRows,
    moveColumns,
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
            const t0 = performance.now();
            await canvas.refreshCells();
            const t1 = performance.now();
            canvas.redraw();
            const t2 = performance.now();
            console.log(
              `[PERF][cellEvent] debounced refresh+redraw | ` +
              `refreshCells=${(t1 - t0).toFixed(1)}ms ` +
              `redraw=${(t2 - t1).toFixed(1)}ms ` +
              `TOTAL=${(t2 - t0).toFixed(1)}ms`
            );
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

  // -------------------------------------------------------------------------
  // Auto-Fit Column (double-click on resize handle)
  // -------------------------------------------------------------------------
  const handleAutoFitColumn = useCallback(
    async (col: number) => {
      // Determine which columns to auto-fit:
      // If selection is type "columns" and the clicked column is within it,
      // auto-fit ALL selected columns individually. Otherwise just the one.
      const columnsToFit: number[] = [];

      if (selection?.type === "columns") {
        const minCol = Math.min(selection.startCol, selection.endCol);
        const maxCol = Math.max(selection.startCol, selection.endCol);
        if (col >= minCol && col <= maxCol) {
          for (let c = minCol; c <= maxCol; c++) {
            columnsToFit.push(c);
          }
          if (selection.additionalRanges) {
            for (const range of selection.additionalRanges) {
              const rMin = Math.min(range.startCol, range.endCol);
              const rMax = Math.max(range.startCol, range.endCol);
              for (let c = rMin; c <= rMax; c++) {
                if (!columnsToFit.includes(c)) columnsToFit.push(c);
              }
            }
          }
        } else {
          columnsToFit.push(col);
        }
      } else {
        columnsToFit.push(col);
      }

      try {
        await beginUndoTransaction("Auto-fit columns");
        const styles = await getAllStyles();
        const theme = { cellFontFamily: DEFAULT_THEME.cellFontFamily, cellFontSize: DEFAULT_THEME.cellFontSize };

        for (const c of columnsToFit) {
          const cells = await getCellsInCols(c, c);
          const optimalWidth = measureOptimalColumnWidth(c, cells, styles, theme, config.minColumnWidth);
          dispatch(setColumnWidth(c, optimalWidth));
          await setColumnWidthApi(c, optimalWidth);
        }

        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to auto-fit columns:", err);
      }

      canvasRef.current?.redraw();
    },
    [selection, config.minColumnWidth, dispatch, canvasRef]
  );

  // -------------------------------------------------------------------------
  // Auto-Fit Row (double-click on resize handle)
  // -------------------------------------------------------------------------
  const handleAutoFitRow = useCallback(
    async (row: number) => {
      const rowsToFit: number[] = [];

      if (selection?.type === "rows") {
        const minRow = Math.min(selection.startRow, selection.endRow);
        const maxRow = Math.max(selection.startRow, selection.endRow);
        if (row >= minRow && row <= maxRow) {
          for (let r = minRow; r <= maxRow; r++) {
            rowsToFit.push(r);
          }
          if (selection.additionalRanges) {
            for (const range of selection.additionalRanges) {
              const rMin = Math.min(range.startRow, range.endRow);
              const rMax = Math.max(range.startRow, range.endRow);
              for (let r = rMin; r <= rMax; r++) {
                if (!rowsToFit.includes(r)) rowsToFit.push(r);
              }
            }
          }
        } else {
          rowsToFit.push(row);
        }
      } else {
        rowsToFit.push(row);
      }

      try {
        await beginUndoTransaction("Auto-fit rows");
        const styles = await getAllStyles();
        const theme = { cellFontFamily: DEFAULT_THEME.cellFontFamily, cellFontSize: DEFAULT_THEME.cellFontSize };

        for (const r of rowsToFit) {
          const cells = await getCellsInRows(r, r);
          const optimalHeight = measureOptimalRowHeight(
            cells,
            styles,
            dimensions?.columnWidths ?? new Map(),
            config.defaultCellWidth,
            theme,
            config.minRowHeight
          );
          dispatch(setRowHeight(r, optimalHeight));
          await setRowHeightApi(r, optimalHeight);
        }

        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to auto-fit rows:", err);
      }

      canvasRef.current?.redraw();
    },
    [selection, dimensions?.columnWidths, config.defaultCellWidth, config.minRowHeight, dispatch, canvasRef]
  );

  // -------------------------------------------------------------------------
  // Batch Column/Row Resize (uniform resize for multi-select + drag)
  // -------------------------------------------------------------------------
  const handleBatchColumnResize = useCallback(
    async (cols: number[], width: number) => {
      try {
        await beginUndoTransaction("Resize columns");
        for (const col of cols) {
          dispatch(setColumnWidth(col, width));
          await setColumnWidthApi(col, width);
        }
        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to batch resize columns:", err);
      }
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  const handleBatchRowResize = useCallback(
    async (rows: number[], height: number) => {
      try {
        await beginUndoTransaction("Resize rows");
        for (const row of rows) {
          dispatch(setRowHeight(row, height));
          await setRowHeightApi(row, height);
        }
        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to batch resize rows:", err);
      }
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  // -------------------------------------------------------------------------
  // Hide Columns/Rows (drag to zero width/height)
  // -------------------------------------------------------------------------
  const handleHideColumns = useCallback(
    (cols: number[]) => {
      const currentHidden = new Set(dimensions?.manuallyHiddenCols ?? []);
      for (const col of cols) {
        currentHidden.add(col);
      }
      dispatch(setManuallyHiddenCols(Array.from(currentHidden)));
      canvasRef.current?.redraw();
    },
    [dimensions?.manuallyHiddenCols, dispatch, canvasRef]
  );

  const handleHideRows = useCallback(
    (rows: number[]) => {
      const currentHidden = new Set(dimensions?.manuallyHiddenRows ?? []);
      for (const row of rows) {
        currentHidden.add(row);
      }
      dispatch(setManuallyHiddenRows(Array.from(currentHidden)));
      canvasRef.current?.redraw();
    },
    [dimensions?.manuallyHiddenRows, dispatch, canvasRef]
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

    // Check if any cell in the selection is edit-guarded (e.g., pivot region)
    const guardResult = await checkEditGuards(selection.endRow, selection.endCol);
    if (guardResult?.blocked) {
      console.log("[useSpreadsheetSelection] Delete blocked by edit guard");
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

      // Refresh style cache (undo may revert formatting changes)
      window.dispatchEvent(new CustomEvent("styles:refresh"));

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

      // Refresh style cache (redo may re-apply formatting changes)
      window.dispatchEvent(new CustomEvent("styles:refresh"));

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
    isRefResizing,
    isSelectionDragging,
    isOverlayResizing,
    selectionDragPreview,
    cursorStyle,
    handleMouseDown: baseHandleMouseDown,
    handleMouseMove: baseHandleMouseMove,
    handleMouseUp: baseHandleMouseUp,
    handleDoubleClick: getDoubleClickCell,
    isOverFloatingOverlay,
  } = useMouseSelection({
    containerRef,
    scrollRef,
    config,
    viewport,
    selection,
    dimensions,
    isFormulaMode,
    formulaReferences,
    currentSheetName: sheetContext.activeSheetName,
    formulaSourceSheetName: state.editing?.sourceSheetName,
    onSelectCell: selectCell,
    onAddToSelection: addCellToSelection,
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
    onAutoFitColumn: handleAutoFitColumn,
    onAutoFitRow: handleAutoFitRow,
    onBatchColumnResize: handleBatchColumnResize,
    onBatchRowResize: handleBatchRowResize,
    onHideColumns: handleHideColumns,
    onHideRows: handleHideRows,
    onSelectColumn: selectColumn,
    onSelectRow: selectRow,
    onFillHandleDoubleClick: handleFillHandleDoubleClick,
    onStartRefDrag: startRefDrag,
    onUpdateRefDrag: updateRefDrag,
    onCompleteRefDrag: completeRefDrag,
    onCancelRefDrag: cancelRefDrag,
    onStartRefResize: startRefResize,
    onUpdateRefResize: updateRefResize,
    onCompleteRefResize: completeRefResize,
    onCancelRefResize: cancelRefResize,
    onMoveCells: moveCells,
    onMoveRows: moveRows,
    onMoveColumns: moveColumns,
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

      // Check if clicking on a floating overlay (e.g., chart) - skip cell interceptor logic
      // and go directly to baseHandleMouseDown which handles overlay move/resize
      if (isOverFloatingOverlay(mouseX, mouseY)) {
        baseHandleMouseDown(event);
        return;
      }

      // Get cell from click position to check for extension click interceptors
      const { getCellFromPixel } = await import("../../lib/gridRenderer");
      const clickedCell = getCellFromPixel(mouseX, mouseY, state.config, state.viewport, state.dimensions);

      if (clickedCell && !isEditing) {
        // Let extensions intercept the click (e.g., pivot filter dropdowns)
        // Skip when editing so formula cell references work normally
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
    [baseHandleMouseDown, isOverFillHandle, startFillDrag, isOverFloatingOverlay, isEditing, state.config, state.viewport, state.dimensions]
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

  // -------------------------------------------------------------------------
  // Command handler for formatting, fill, and data entry shortcuts
  // -------------------------------------------------------------------------

  /**
   * Helper: Get rows and cols arrays from the current selection.
   */
  const getSelectionRowsCols = useCallback((): { rows: number[]; cols: number[] } | null => {
    if (!selection) return null;
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = minRow; r <= maxRow; r++) rows.push(r);
    for (let c = minCol; c <= maxCol; c++) cols.push(c);
    return { rows, cols };
  }, [selection]);

  /**
   * Helper: Apply formatting to the current selection and refresh canvas.
   */
  const applyFormattingToSelection = useCallback(async (formatting: FormattingOptions) => {
    const rc = getSelectionRowsCols();
    if (!rc) return;

    try {
      await applyFormatting(rc.rows, rc.cols, formatting);

      // Refresh canvas to show updated styles
      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] applyFormatting failed:", error);
    }
  }, [getSelectionRowsCols, canvasRef]);

  /**
   * Helper: Toggle a boolean formatting property (bold, italic, underline, strikethrough).
   * Reads the active cell's current style to determine the toggle direction.
   * If the active cell has the property ON, turns it OFF for the entire selection (and vice versa).
   */
  const toggleFormatProperty = useCallback(async (property: "bold" | "italic" | "underline" | "strikethrough") => {
    if (!selection) return;

    try {
      // Read the active cell's style to determine current state
      const activeCell = await getCell(selection.startRow, selection.startCol);
      const styleIndex = activeCell?.styleIndex ?? 0;
      const style = await getStyle(styleIndex);

      // Determine new value: toggle the current state
      const currentValue = style[property] as boolean;
      const newValue = !currentValue;

      const formatting: FormattingOptions = {};
      formatting[property] = newValue;

      await applyFormattingToSelection(formatting);
    } catch (error) {
      console.error(`[useSpreadsheetSelection] toggleFormatProperty(${property}) failed:`, error);
    }
  }, [selection, applyFormattingToSelection]);

  /**
   * Handle Ctrl+D - Fill Down.
   * Copies the contents and format of the topmost cell in the selection to cells below.
   */
  const handleFillDown = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Need at least 2 rows selected
    if (maxRow <= minRow) return;

    try {
      await beginUndoTransaction("Fill Down");

      const updates: CellUpdateInput[] = [];

      for (let col = minCol; col <= maxCol; col++) {
        // Read the top cell's content (formula or display value)
        const sourceCell = await getCell(minRow, col);
        const sourceValue = sourceCell?.formula || sourceCell?.display || "";

        // Fill down to all rows below
        for (let row = minRow + 1; row <= maxRow; row++) {
          updates.push({ row, col, value: sourceValue });
        }
      }

      if (updates.length > 0) {
        const updatedCells = await updateCellsBatch(updates);
        await commitUndoTransaction();

        // Also copy formatting from source row
        for (let col = minCol; col <= maxCol; col++) {
          const sourceCell = await getCell(minRow, col);
          if (sourceCell && sourceCell.styleIndex > 0) {
            const sourceStyle = await getStyle(sourceCell.styleIndex);
            const targetRows: number[] = [];
            for (let row = minRow + 1; row <= maxRow; row++) {
              targetRows.push(row);
            }
            // Apply the source cell's formatting to target cells
            await applyFormatting(targetRows, [col], {
              bold: sourceStyle.bold,
              italic: sourceStyle.italic,
              underline: sourceStyle.underline,
              strikethrough: sourceStyle.strikethrough,
              numberFormat: sourceStyle.numberFormat !== "General" ? sourceStyle.numberFormat : undefined,
            });
          }
        }

        // Emit event to trigger canvas refresh
        if (updatedCells.length > 0) {
          cellEvents.emit({
            row: updatedCells[0].row,
            col: updatedCells[0].col,
            oldValue: undefined,
            newValue: updatedCells[0].display,
            formula: updatedCells[0].formula ?? null,
          });
        }
      } else {
        await commitUndoTransaction();
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Fill Down failed:", error);
    }
  }, [selection]);

  /**
   * Handle inserting current date into the active cell.
   */
  const handleInsertDate = useCallback(async () => {
    if (!selection) return;

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    const dateStr = `${month}/${day}/${year}`;

    try {
      await updateCell(selection.startRow, selection.startCol, dateStr);

      cellEvents.emit({
        row: selection.startRow,
        col: selection.startCol,
        oldValue: undefined,
        newValue: dateStr,
        formula: null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Insert date failed:", error);
    }
  }, [selection]);

  /**
   * Handle inserting current time into the active cell.
   */
  const handleInsertTime = useCallback(async () => {
    if (!selection) return;

    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const timeStr = `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;

    try {
      await updateCell(selection.startRow, selection.startCol, timeStr);

      cellEvents.emit({
        row: selection.startRow,
        col: selection.startCol,
        oldValue: undefined,
        newValue: timeStr,
        formula: null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Insert time failed:", error);
    }
  }, [selection]);

  /**
   * Central command handler for keyboard shortcuts.
   * Dispatches formatting, fill, and data entry commands.
   */
  const handleCommand = useCallback(async (command: string) => {
    switch (command) {
      // Font style toggles
      case 'format.toggleBold':
        await toggleFormatProperty('bold');
        break;
      case 'format.toggleItalic':
        await toggleFormatProperty('italic');
        break;
      case 'format.toggleUnderline':
        await toggleFormatProperty('underline');
        break;
      case 'format.toggleStrikethrough':
        await toggleFormatProperty('strikethrough');
        break;

      // Number format shortcuts
      case 'format.numberGeneral':
        await applyFormattingToSelection({ numberFormat: 'general' });
        break;
      case 'format.numberCurrency':
        await applyFormattingToSelection({ numberFormat: 'currency_usd' });
        break;
      case 'format.numberPercentage':
        await applyFormattingToSelection({ numberFormat: 'percentage' });
        break;
      case 'format.numberScientific':
        await applyFormattingToSelection({ numberFormat: 'scientific' });
        break;
      case 'format.numberDate':
        await applyFormattingToSelection({ numberFormat: 'date_us' });
        break;
      case 'format.numberTime':
        await applyFormattingToSelection({ numberFormat: 'time_12h' });
        break;
      case 'format.numberNumber':
        await applyFormattingToSelection({ numberFormat: 'number_sep' });
        break;

      // Data entry
      case 'edit.insertDate':
        await handleInsertDate();
        break;
      case 'edit.insertTime':
        await handleInsertTime();
        break;

      // Fill
      case 'edit.fillDown':
        await handleFillDown();
        break;

      // Paste Special
      case 'clipboard.pasteSpecial':
        await CommandRegistry.execute('core.clipboard.pasteSpecial');
        break;

      default:
        console.warn(`[useSpreadsheetSelection] Unknown command: ${command}`);
    }
  }, [toggleFormatProperty, applyFormattingToSelection, handleInsertDate, handleInsertTime, handleFillDown]);

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
    onSelectColumn: selectColumn,
    onSelectRow: selectRow,
    onCommand: handleCommand,
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
        // Check if any extension intercepts the double-click (e.g., pivot expand/collapse)
        const intercepted = await checkCellDoubleClickInterceptors(
          cell.row,
          cell.col,
          { clientX: event.clientX, clientY: event.clientY }
        );
        if (intercepted) {
          return;
        }

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
      isRefResizing,
      isSelectionDragging,
      isOverlayResizing,
      isFillDragging: fillState.isDragging,
    },
    fillState,
    selectionDragPreview,
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