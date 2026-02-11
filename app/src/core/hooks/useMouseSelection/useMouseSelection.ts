//! FILENAME: app/src/core/hooks/useMouseSelection/useMouseSelection.ts
// PURPOSE: Main hook for handling mouse-based selection interactions.
// CONTEXT: Updated to use custom Excel-style cursor images for header selection.
// FIX: Now checks formula mode synchronously using isGlobalFormulaMode() to handle
//      cases where the user types "+" and clicks before React re-renders.

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
import { getCellFromPixel, getColumnFromHeader, getRowFromHeader } from "../../lib/gridRenderer";
import { calculateAutoScrollDelta } from "./utils/autoScrollUtils";
import { getCellFromMousePosition } from "./utils/cellUtils";
import { useAutoScroll } from "./selection/useAutoScroll";
import { createCellSelectionHandlers } from "./selection/cellSelectionHandlers";
import { createHeaderSelectionHandlers } from "./selection/headerSelectionHandlers";
import { createFormulaHandlers } from "./editing/formulaHandlers";
import { createFormulaHeaderHandlers } from "./editing/formulaHeaderHandlers";
import { createReferenceDragHandlers } from "./editing/referenceDragHandlers";
import { createResizeHandlers } from "./layout/resizeHandlers";
import { createFillHandleCursorChecker } from "./utils/fillHandleUtils";
import { isGlobalFormulaMode } from "../../hooks/useEditing";

// Custom cursor data URLs for Excel-style header selection arrows
const COLUMN_SELECT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M12 2 L12 18 M12 18 L8 14 M12 18 L16 14' stroke='black' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, pointer`;

const ROW_SELECT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M2 12 L18 12 M18 12 L14 8 M18 12 L14 16' stroke='black' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, pointer`;

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
    formulaReferences = [],
    currentSheetName,
    formulaSourceSheetName,
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
    onFillHandleDoubleClick,
    onStartRefDrag,
    onUpdateRefDrag,
    onCompleteRefDrag,
    onCancelRefDrag,
  } = props;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [isDragging, setIsDragging] = useState(false);
  const [isFormulaDragging, setIsFormulaDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRefDragging, setIsRefDragging] = useState(false);
  
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
  const refDragStartRef = useRef<CellPosition | null>(null);

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
  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
  const referenceDragHandlers = createReferenceDragHandlers({
    config,
    viewport,
    dimensions,
    containerRef,
    formulaReferences,
    currentSheetName,
    formulaSourceSheetName,
    onStartRefDrag,
    onUpdateRefDrag,
    onCompleteRefDrag,
    onCancelRefDrag,
    setIsRefDragging,
    setCursorStyle,
    refDragStartRef,
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
   * 
   * IMPORTANT: We use containerRef.current for coordinate calculation to ensure
   * consistency with handleGlobalMouseMove, which also uses containerRef.current.
   * Using event.currentTarget would cause coordinate discrepancies if the event
   * target differs from containerRef.
   * 
   * FIX: Now checks formula mode synchronously using isGlobalFormulaMode() in addition
   * to the isFormulaMode prop. This handles cases where the user types "+" and clicks
   * before React has re-rendered with the updated state.
   */
  const handleMouseDown = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      // Use containerRef for consistent coordinates with global mouse move handler
      // This prevents coordinate discrepancies between mouse down and mouse move
      if (!containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Priority 1: Check for resize handle
      if (resizeHandlers.handleResizeMouseDown(mouseX, mouseY, event)) {
        return;
      }

      // FIX: Check formula mode synchronously at event time, not just from props
      // The isFormulaMode prop might be stale if the user just typed "+" and
      // React hasn't re-rendered yet. isGlobalFormulaMode() checks the actual
      // current editing value synchronously.
      const isCurrentlyFormulaMode = isFormulaMode || isGlobalFormulaMode();

      // Priority 2: Check for column header click
      if (isCurrentlyFormulaMode) {
        // Formula mode: insert column reference
        if (formulaHeaderHandlers.handleFormulaColumnHeaderMouseDown(mouseX, mouseY, event)) {
          return;
        }
        // Formula mode: insert row reference
        if (formulaHeaderHandlers.handleFormulaRowHeaderMouseDown(mouseX, mouseY, event)) {
          return;
        }
        // Formula mode: try to drag an existing reference first
        // This allows users to click on a highlighted reference and move it
        if (referenceDragHandlers.handleReferenceDragMouseDown(mouseX, mouseY, event)) {
          formulaHeaderDragStartRef.current = null;
          formulaDragStartRef.current = null;
          return;
        }
        // Formula mode: insert cell reference (if not dragging existing reference)
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
      containerRef,
      isFormulaMode,
      resizeHandlers,
      cellSelectionHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
      referenceDragHandlers,
    ]
  );

  /**
   * Handle mouse move - extend selection, handle resize, or update cursor.
   */
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // Use containerRef for consistent coordinates
      if (!containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Update last mouse position for auto-scroll
      lastMousePosRef.current = { x: mouseX, y: mouseY };

      // Handle resize operation - skip here, global handler will handle it
      // This prevents double-handling with different coordinate calculations
      if (isResizing) {
        return;
      }

      // Handle formula header drag (column/row reference selection)
      if (isFormulaDragging && formulaHeaderDragStartRef.current) {
        formulaHeaderHandlers.handleFormulaHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Handle reference drag (moving existing reference)
      if (isRefDragging && refDragStartRef.current) {
        referenceDragHandlers.handleReferenceDragMove(mouseX, mouseY, rect);
        return;
      }

      // Handle header drag for column/row selection
      if (isDragging && headerDragRef.current) {
        headerSelectionHandlers.handleHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Update cursor based on position (when not dragging)
      if (!isDragging && !isFormulaDragging && !isResizing && !isRefDragging) {
        // Check fill handle first (highest priority for crosshair)
        if (isOverFillHandle(mouseX, mouseY)) {
          setCursorStyle("crosshair");
        } else if (isFormulaMode && referenceDragHandlers.isOverReferenceBorder(mouseX, mouseY)) {
          // Check if over a formula reference border (for dragging)
          setCursorStyle("move");
        } else {
          // Check for resize handles
          const colResize = resizeHandlers.checkResizeHandle(mouseX, mouseY);
          if (colResize) {
            resizeHandlers.updateCursorForPosition(mouseX, mouseY);
          } else {
            // Check if over column header (not resize handle) - show down arrow
            const headerCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
            if (headerCol !== null) {
              setCursorStyle(COLUMN_SELECT_CURSOR);
            } else {
              // Check if over row header (not resize handle) - show right arrow
              const headerRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
              if (headerRow !== null) {
                setCursorStyle(ROW_SELECT_CURSOR);
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
      if (isDragging || isFormulaDragging || isRefDragging) {
        const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, config);
        if (deltaX !== 0 || deltaY !== 0) {
          startAutoScroll();
        } else {
          stopAutoScroll();
        }
      }
    },
    [
      containerRef,
      config,
      viewport,
      dimensions,
      isDragging,
      isFormulaDragging,
      isResizing,
      isRefDragging,
      isOverFillHandle,
      resizeHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
      referenceDragHandlers,
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

    // End reference drag (moving existing reference)
    if (isRefDragging) {
      if (refDragStartRef.current) {
        referenceDragHandlers.handleReferenceDragMouseUp(stopAutoScroll);
        return;
      }
    }

    // End formula drag (adding new reference)
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
    isRefDragging,
    resizeHandlers,
    formulaHandlers,
    formulaHeaderHandlers,
    referenceDragHandlers,
    stopAutoScroll,
    onDragEnd,
  ]);

  /**
   * Handle double-click - returns cell coordinates for editing,
   * or triggers fill handle auto-fill if double-clicking on fill handle.
   */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): { row: number; col: number } | null => {
      // Use containerRef for consistent coordinates
      if (!containerRef.current) {
        return null;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Check if double-click is on fill handle
      if (isOverFillHandle(mouseX, mouseY)) {
        console.log("[useMouseSelection] Double-click on fill handle detected");
        // Trigger auto-fill to edge
        if (onFillHandleDoubleClick) {
          onFillHandleDoubleClick();
        }
        // Return null to prevent entering edit mode
        return null;
      }

      return getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
    },
    [containerRef, config, viewport, dimensions, isOverFillHandle, onFillHandleDoubleClick]
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
      } else if (isRefDragging) {
        handleMouseUp();
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
  }, [isDragging, isFormulaDragging, isResizing, isRefDragging, handleMouseUp, resizeHandlers, stopAutoScroll, onDragEnd]);

  /**
   * Global mouse move handler for tracking mouse during drag outside component.
   */
  useEffect(() => {
    const handleGlobalMouseMove = (event: MouseEvent) => {
      if (!isDragging && !isFormulaDragging && !isResizing && !isRefDragging) {
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

      // Handle reference drag during global mouse move (moving existing reference)
      if (isRefDragging && refDragStartRef.current) {
        referenceDragHandlers.handleReferenceDragMove(mouseX, mouseY, rect);
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

    if (isDragging || isFormulaDragging || isResizing || isRefDragging) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
    }

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, [
    isDragging,
    isFormulaDragging,
    isResizing,
    isRefDragging,
    config,
    viewport,
    dimensions,
    containerRef,
    resizeHandlers,
    formulaHeaderHandlers,
    referenceDragHandlers,
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
    isRefDragging,
    cursorStyle,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
  };
}