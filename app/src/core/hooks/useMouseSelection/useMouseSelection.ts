// FILENAME: app/src/hooks/useMouseSelection/useMouseSelection.ts
// PURPOSE: Main hook for handling mouse-based selection interactions.
// CONTEXT: Updated to pass drag start position for direction-aware 50% threshold.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  UseMouseSelectionProps,
  UseMouseSelectionReturn,
  CellPosition,
  MousePosition,
  ResizeState,
  HeaderDragState,
  FormulaHeaderDragState,
} from "./types";
import { getCellFromPixel } from "../../lib/gridRenderer";
import { calculateAutoScrollDelta } from "./utils/autoScrollUtils";
import { getCellFromMousePosition } from "./utils/cellUtils";
import { useAutoScroll } from "./selection/useAutoScroll";
import { createCellSelectionHandlers } from "./selection/cellSelectionHandlers";
import { createHeaderSelectionHandlers } from "./selection/headerSelectionHandlers";
import { createFormulaHandlers } from "./editing/formulaHandlers";
import { createFormulaHeaderHandlers } from "./editing/formulaHeaderHandlers";
import { createResizeHandlers } from "./layout/resizeHandlers";
import { createFillHandleCursorChecker } from "./utils/fillHandleUtils";

/**
 * Hook for managing mouse-based cell selection with drag support.
 * Implements click, shift-click, drag selection, auto-scrolling,
 * formula reference mode, header selection, and column/row resizing.
 */
export function useMouseSelection(props: UseMouseSelectionProps): UseMouseSelectionReturn {
  const {
    containerRef,
    scrollRef,
    config,
    viewport,
    selection,
    dimensions,
    isFormulaMode = false,
    onSelectCell,
    onExtendTo,
    onScroll,
    onDragEnd,
    onInsertReference,
    onInsertRangeReference,
    onInsertColumnReference,
    onInsertColumnRangeReference,
    onInsertRowReference,
    onInsertRowRangeReference,
    onUpdatePendingReference,
    onUpdatePendingColumnReference,
    onUpdatePendingRowReference,
    onClearPendingReference,
    onCommitBeforeSelect,
    onColumnResize,
    onRowResize,
    onSelectColumn,
    onSelectRow,
  } = props;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [isDragging, setIsDragging] = useState(false);
  const [isFormulaDragging, setIsFormulaDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  
  // Default to "default" to ensure we have a valid starting state
  const [cursorStyle, setCursorStyle] = useState("default");

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------
  const lastMousePosRef = useRef<MousePosition | null>(null);
  const dragStartRef = useRef<CellPosition | null>(null);
  const formulaDragStartRef = useRef<CellPosition | null>(null);
  const formulaHeaderDragStartRef = useRef<FormulaHeaderDragState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const headerDragRef = useRef<HeaderDragState | null>(null);

  // -------------------------------------------------------------------------
  // Side Effects
  // -------------------------------------------------------------------------

  // Apply cursor style directly to the container element
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.cursor = cursorStyle;
    }
  }, [cursorStyle, containerRef]);

  // -------------------------------------------------------------------------
  // Auto-scroll Hook
  // -------------------------------------------------------------------------
  const { startAutoScroll, stopAutoScroll } = useAutoScroll({
    containerRef,
    scrollRef,
    config,
    viewport,
    dimensions,
    lastMousePosRef,
    isDragging,
    isFormulaDragging,
    formulaDragStartRef,
    dragStartRef,
    onScroll,
    onExtendTo,
    onUpdatePendingReference,
  });

  // -------------------------------------------------------------------------
  // Handler Factories
  // -------------------------------------------------------------------------
  const resizeHandlers = createResizeHandlers({
    config,
    viewport,
    dimensions,
    onColumnResize,
    onRowResize,
    setIsResizing,
    setCursorStyle,
    resizeStateRef,
  });

  const cellSelectionHandlers = createCellSelectionHandlers({
    config,
    viewport,
    dimensions,
    selection,
    onSelectCell,
    onExtendTo,
    onCommitBeforeSelect,
    setIsDragging,
    dragStartRef,
    headerDragRef,
    lastMousePosRef,
  });

  const headerSelectionHandlers = createHeaderSelectionHandlers({
    config,
    viewport,
    dimensions,
    selection,
    onSelectCell,
    onExtendTo,
    onSelectColumn,
    onSelectRow,
    onCommitBeforeSelect,
    setIsDragging,
    headerDragRef,
    lastMousePosRef,
  });

  const formulaHandlers = createFormulaHandlers({
    config,
    viewport,
    dimensions,
    containerRef,
    onInsertReference,
    onInsertRangeReference,
    onUpdatePendingReference,
    onClearPendingReference,
    setIsFormulaDragging,
    formulaDragStartRef,
    lastMousePosRef,
  });

  const formulaHeaderHandlers = createFormulaHeaderHandlers({
    config,
    viewport,
    dimensions,
    onInsertColumnReference,
    onInsertColumnRangeReference,
    onInsertRowReference,
    onInsertRowRangeReference,
    onUpdatePendingColumnReference,
    onUpdatePendingRowReference,
    onClearPendingReference,
    setIsFormulaDragging,
    formulaHeaderDragStartRef,
    lastMousePosRef,
  });

  // Create fill handle cursor checker
  const isOverFillHandle = createFillHandleCursorChecker({
    config,
    viewport,
    dimensions,
    selection,
  });

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  /**
   * Handle mouse down - start selection, extend with shift, handle resize,
   * or handle formula reference.
   */
  const handleMouseDown = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Priority 1: Check for resize handle
      if (resizeHandlers.handleResizeMouseDown(mouseX, mouseY, event)) {
        return;
      }

      // Priority 2: Check for column header click
      if (isFormulaMode) {
        // Formula mode: insert column reference
        if (formulaHeaderHandlers.handleFormulaColumnHeaderMouseDown(mouseX, mouseY, event)) {
          return;
        }
        // Formula mode: insert row reference
        if (formulaHeaderHandlers.handleFormulaRowHeaderMouseDown(mouseX, mouseY, event)) {
          return;
        }
        // Formula mode: insert cell reference
        if (formulaHandlers.handleFormulaCellMouseDown(mouseX, mouseY, event)) {
          formulaHeaderDragStartRef.current = null;
          return;
        }
      } else {
        // Normal mode: select column
        if (await headerSelectionHandlers.handleColumnHeaderMouseDown(mouseX, mouseY, event.shiftKey, event)) {
          return;
        }
        // Normal mode: select row
        if (await headerSelectionHandlers.handleRowHeaderMouseDown(mouseX, mouseY, event.shiftKey, event)) {
          return;
        }
        // Normal mode: select cell
        await cellSelectionHandlers.handleCellMouseDown(mouseX, mouseY, event.shiftKey, event);
      }
    },
    [
      isFormulaMode,
      resizeHandlers,
      cellSelectionHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
    ]
  );

  /**
   * Handle mouse move - extend selection, handle resize, or update cursor.
   */
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Update last mouse position for auto-scroll
      lastMousePosRef.current = { x: mouseX, y: mouseY };

      // Handle resize operation
      if (isResizing) {
        resizeHandlers.handleResizeMouseMove(mouseX, mouseY);
        return;
      }

      // Handle formula header drag (column/row reference selection)
      if (isFormulaDragging && formulaHeaderDragStartRef.current) {
        formulaHeaderHandlers.handleFormulaHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Handle header drag for column/row selection
      if (isDragging && headerDragRef.current) {
        headerSelectionHandlers.handleHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Update cursor based on position (when not dragging)
      if (!isDragging && !isFormulaDragging && !isResizing) {
        // Check fill handle first (highest priority for crosshair)
        if (isOverFillHandle(mouseX, mouseY)) {
          setCursorStyle("crosshair");
        } else {
          // Check for resize handles
          const colResize = resizeHandlers.checkResizeHandle(mouseX, mouseY);
          if (colResize) {
            resizeHandlers.updateCursorForPosition(mouseX, mouseY);
          } else {
            // Check if over a cell (standard cell cursor)
            const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
            if (cell) {
              setCursorStyle("cell");
            } else {
              setCursorStyle("default");
            }
          }
        }
      }

      // Handle formula cell drag
      if (isFormulaDragging && formulaDragStartRef.current) {
        formulaHandlers.handleFormulaCellDragMove(mouseX, mouseY, rect);
      }
      // Handle regular cell selection drag
      else if (isDragging && !headerDragRef.current && dragStartRef.current) {
        // Use midpoint threshold with drag start for direction-aware 50% threshold
        const cell = getCellFromMousePosition(
          mouseX, 
          mouseY, 
          rect, 
          config, 
          viewport, 
          dimensions,
          { 
            dragStartRow: dragStartRef.current.row,
            dragStartCol: dragStartRef.current.col,
          }
        );
        if (cell) {
          onExtendTo(cell.row, cell.col);
        }
      }

      // Check if we need to start/stop auto-scroll
      if (isDragging || isFormulaDragging) {
        const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, config);
        if (deltaX !== 0 || deltaY !== 0) {
          startAutoScroll();
        } else {
          stopAutoScroll();
        }
      }
    },
    [
      config,
      viewport,
      dimensions,
      isDragging,
      isFormulaDragging,
      isResizing,
      isOverFillHandle,
      resizeHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
      onExtendTo,
      startAutoScroll,
      stopAutoScroll,
    ]
  );

  /**
   * Handle mouse up - end drag selection, resize, or insert formula reference.
   */
  const handleMouseUp = useCallback(() => {
    // End resize operation
    if (isResizing) {
      resizeHandlers.handleResizeMouseUp();
      return;
    }

    // End formula drag
    if (isFormulaDragging) {
      // Handle formula header drag completion
      if (formulaHeaderDragStartRef.current) {
        formulaHeaderHandlers.handleFormulaHeaderMouseUp(stopAutoScroll);
        return;
      }

      // Handle formula cell drag completion
      if (formulaDragStartRef.current) {
        formulaHandlers.handleFormulaCellMouseUp(stopAutoScroll);
        return;
      }
    }

    // End regular drag
    if (isDragging) {
      setIsDragging(false);
      stopAutoScroll();
      dragStartRef.current = null;
      headerDragRef.current = null;
      lastMousePosRef.current = null;
      onDragEnd?.();
    }
  }, [
    isDragging,
    isFormulaDragging,
    isResizing,
    resizeHandlers,
    formulaHandlers,
    formulaHeaderHandlers,
    stopAutoScroll,
    onDragEnd,
  ]);

  /**
   * Handle double-click - returns cell coordinates for editing.
   */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): { row: number; col: number } | null => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      return getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
    },
    [config, viewport, dimensions]
  );

  // -------------------------------------------------------------------------
  // Global Event Listeners
  // -------------------------------------------------------------------------

  /**
   * Global mouse up handler to catch mouse releases outside the component.
   */
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isResizing) {
        resizeHandlers.handleResizeMouseUp();
      } else if (isFormulaDragging) {
        handleMouseUp();
      } else if (isDragging) {
        setIsDragging(false);
        stopAutoScroll();
        dragStartRef.current = null;
        headerDragRef.current = null;
        lastMousePosRef.current = null;
        onDragEnd?.();
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [isDragging, isFormulaDragging, isResizing, handleMouseUp, resizeHandlers, stopAutoScroll, onDragEnd]);

  /**
   * Global mouse move handler for tracking mouse during drag outside component.
   */
  useEffect(() => {
    const handleGlobalMouseMove = (event: MouseEvent) => {
      if (!isDragging && !isFormulaDragging && !isResizing) {
        return;
      }

      if (!containerRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      lastMousePosRef.current = { x: mouseX, y: mouseY };

      // Handle resize during global mouse move
      if (isResizing && resizeStateRef.current) {
        resizeHandlers.handleResizeMouseMove(mouseX, mouseY);
        return;
      }

      // Handle formula header drag during global mouse move
      if (isFormulaDragging && formulaHeaderDragStartRef.current) {
        formulaHeaderHandlers.handleFormulaHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Extend selection/reference even when mouse is outside
      // Use midpoint threshold with drag start for direction-aware behavior
      if (isDragging && !headerDragRef.current && dragStartRef.current) {
        const cell = getCellFromMousePosition(
          mouseX, 
          mouseY, 
          rect, 
          config, 
          viewport, 
          dimensions,
          { 
            dragStartRow: dragStartRef.current.row,
            dragStartCol: dragStartRef.current.col,
          }
        );
        if (cell) {
          onExtendTo(cell.row, cell.col);
        }
      } else if (isFormulaDragging && formulaDragStartRef.current && onUpdatePendingReference) {
        const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
        if (cell) {
          onUpdatePendingReference(
            formulaDragStartRef.current.row,
            formulaDragStartRef.current.col,
            cell.row,
            cell.col
          );
        }
      }

      // Handle auto-scroll when mouse is outside bounds
      const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, config);
      if (deltaX !== 0 || deltaY !== 0) {
        startAutoScroll();
      }
    };

    if (isDragging || isFormulaDragging || isResizing) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
    }

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, [
    isDragging,
    isFormulaDragging,
    isResizing,
    config,
    viewport,
    dimensions,
    containerRef,
    resizeHandlers,
    formulaHeaderHandlers,
    onExtendTo,
    onUpdatePendingReference,
    startAutoScroll,
  ]);

  /**
   * Cleanup on unmount.
   */
  useEffect(() => {
    return () => {
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    isDragging,
    isFormulaDragging,
    isResizing,
    cursorStyle,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
  };
}