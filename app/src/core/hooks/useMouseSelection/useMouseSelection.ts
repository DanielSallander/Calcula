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
  SelectionDragState,
} from "./types";
import type { Selection } from "../../types";
import { getCellFromPixel, getColumnFromHeader, getRowFromHeader } from "../../lib/gridRenderer";
import { calculateAutoScrollDelta } from "./utils/autoScrollUtils";
import { getCellFromMousePosition } from "./utils/cellUtils";
import { useAutoScroll } from "./selection/useAutoScroll";
import { createCellSelectionHandlers } from "./selection/cellSelectionHandlers";
import { createHeaderSelectionHandlers } from "./selection/headerSelectionHandlers";
import { createFormulaHandlers } from "./editing/formulaHandlers";
import { createFormulaHeaderHandlers } from "./editing/formulaHeaderHandlers";
import { createReferenceDragHandlers } from "./editing/referenceDragHandlers";
import { createReferenceResizeHandlers } from "./editing/referenceResizeHandlers";
import { createResizeHandlers } from "./layout/resizeHandlers";
import { createOverlayResizeHandlers, type OverlayResizeHandlers } from "./layout/overlayResizeHandlers";
import { createOverlayMoveHandlers, type OverlayMoveHandlers, type OverlayMoveState } from "./layout/overlayMoveHandlers";
import { createFillHandleCursorChecker } from "./utils/fillHandleUtils";
import { createSelectionDragHandlers } from "./selection/selectionDragHandlers";
import { isGlobalFormulaMode, isEditingFormula, setHoveringOverReferenceBorder } from "../../hooks/useEditing";

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
    onStartRefResize,
    onUpdateRefResize,
    onCompleteRefResize,
    onCancelRefResize,
    onMoveCells,
    onMoveRows,
    onMoveColumns,
  } = props;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [isDragging, setIsDragging] = useState(false);
  const [isFormulaDragging, setIsFormulaDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRefDragging, setIsRefDragging] = useState(false);
  const [isRefResizing, setIsRefResizing] = useState(false);
  const [isSelectionDragging, setIsSelectionDragging] = useState(false);
  const [isOverlayResizing, setIsOverlayResizing] = useState(false);
  const [isOverlayMoving, setIsOverlayMoving] = useState(false);
  const [selectionDragPreview, setSelectionDragPreview] = useState<Selection | null>(null);

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
  const refResizeStartRef = useRef<CellPosition | null>(null);
  const selectionDragRef = useRef<SelectionDragState | null>(null);
  const overlayResizeStateRef = useRef<{ region: import("../../../../api/gridOverlays").GridRegion; currentEndRow: number; currentEndCol: number } | null>(null);
  const overlayMoveStateRef = useRef<OverlayMoveState | null>(null);

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
  const overlayResizeHandlers = createOverlayResizeHandlers({
    config,
    viewport,
    dimensions,
    containerRef,
    setIsOverlayResizing,
    setCursorStyle,
    overlayResizeStateRef,
  });

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
  const overlayMoveHandlers = createOverlayMoveHandlers({
    config,
    viewport,
    containerRef,
    setIsOverlayMoving,
    setCursorStyle,
    overlayMoveStateRef,
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

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
  const referenceResizeHandlers = createReferenceResizeHandlers({
    config,
    viewport,
    dimensions,
    containerRef,
    formulaReferences,
    currentSheetName,
    formulaSourceSheetName,
    onStartRefResize,
    onUpdateRefResize,
    onCompleteRefResize,
    onCancelRefResize,
    setIsRefResizing,
    setCursorStyle,
    refResizeStartRef,
    lastMousePosRef,
  });

  // eslint-disable-next-line react-hooks/refs -- Refs are captured in closures for event-time access, not read during render
  const selectionDragHandlers = createSelectionDragHandlers({
    config,
    viewport,
    dimensions,
    containerRef,
    selection,
    onMoveCells,
    onMoveRows,
    onMoveColumns,
    setIsSelectionDragging,
    setCursorStyle,
    selectionDragRef,
    lastMousePosRef,
    setSelectionDragPreview,
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

      // Priority 1.5: Check for overlay (table/chart) resize handle
      if (overlayResizeHandlers.handleOverlayResizeMouseDown(mouseX, mouseY, event)) {
        return;
      }

      // Priority 1.7: Check for floating overlay move (e.g., chart body drag)
      if (overlayMoveHandlers.handleOverlayMoveMouseDown(mouseX, mouseY, event)) {
        return;
      }

      // FIX: Check formula mode synchronously at event time, not just from props
      // The isFormulaMode prop might be stale if the user just typed "+" and
      // React hasn't re-rendered yet. isGlobalFormulaMode() checks the actual
      // current editing value synchronously.
      const isCurrentlyFormulaMode = isFormulaMode || isGlobalFormulaMode();

      // FIX: Check if we're editing ANY formula (for reference dragging)
      // This is separate from isCurrentlyFormulaMode which checks if expecting a reference
      const isCurrentlyEditingFormula = isEditingFormula();

      // Priority 2: Check for reference corner resize when editing any formula
      // Corner resize has higher priority than border drag (corners overlap with borders)
      if (isCurrentlyEditingFormula) {
        if (referenceResizeHandlers.handleReferenceResizeMouseDown(mouseX, mouseY, event)) {
          formulaHeaderDragStartRef.current = null;
          formulaDragStartRef.current = null;
          return;
        }
      }

      // Priority 3: Check for reference dragging when editing any formula
      // FIX: Allow dragging existing references even when formula doesn't end with an operator
      if (isCurrentlyEditingFormula) {
        if (referenceDragHandlers.handleReferenceDragMouseDown(mouseX, mouseY, event)) {
          formulaHeaderDragStartRef.current = null;
          formulaDragStartRef.current = null;
          return;
        }
      }

      // Priority 3: Check for formula mode (expecting reference) operations
      if (isCurrentlyFormulaMode) {
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
        // Normal mode (or editing complete formula - click not on reference border)
        // onCommitBeforeSelect will commit any pending edit before selecting

        // Priority: Check for selection dragging when NOT editing
        if (selection && selectionDragHandlers.handleSelectionDragMouseDown(mouseX, mouseY, event)) {
          return;
        }

        // Normal mode: select all (corner click)
        if (mouseX < (config.rowHeaderWidth || 50) && mouseY < (config.colHeaderHeight || 24)) {
          event.preventDefault();
          if (onCommitBeforeSelect) {
            await onCommitBeforeSelect();
          }
          // Use single dispatch with endRow/endCol to avoid scroll-to-end behavior
          onSelectCell(0, 0, "cells", config.totalRows - 1, config.totalCols - 1);
          return;
        }

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
      selection,
      resizeHandlers,
      overlayResizeHandlers,
      overlayMoveHandlers,
      cellSelectionHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
      referenceDragHandlers,
      referenceResizeHandlers,
      selectionDragHandlers,
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

      // Handle overlay resize operation (table/chart resize drag)
      if (isOverlayResizing && overlayResizeStateRef.current) {
        overlayResizeHandlers.handleOverlayResizeMouseMove(mouseX, mouseY);
        return;
      }

      // Handle overlay move operation (floating chart drag)
      if (isOverlayMoving && overlayMoveStateRef.current) {
        overlayMoveHandlers.handleOverlayMoveMouseMove(mouseX, mouseY);
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

      // Handle reference resize (resizing existing reference via corner handle)
      if (isRefResizing && refResizeStartRef.current) {
        referenceResizeHandlers.handleReferenceResizeMove(mouseX, mouseY, rect);
        return;
      }

      // Handle selection drag (moving cells/rows/columns)
      if (isSelectionDragging && selectionDragRef.current) {
        selectionDragHandlers.handleSelectionDragMove(mouseX, mouseY, rect);
        return;
      }

      // Handle header drag for column/row selection
      if (isDragging && headerDragRef.current) {
        headerSelectionHandlers.handleHeaderDragMove(mouseX, mouseY);
        return;
      }

      // Update cursor based on position (when not dragging)
      if (!isDragging && !isFormulaDragging && !isResizing && !isRefDragging && !isRefResizing && !isSelectionDragging && !isOverlayResizing && !isOverlayMoving) {
        // Check fill handle first (highest priority for crosshair)
        if (isOverFillHandle(mouseX, mouseY)) {
          setCursorStyle("crosshair");
          setHoveringOverReferenceBorder(false);
        } else if (isEditingFormula() && referenceResizeHandlers.getCornerAtPosition(mouseX, mouseY)) {
          // Check corner handles first (higher priority than border)
          const cornerHit = referenceResizeHandlers.getCornerAtPosition(mouseX, mouseY)!;
          const resizeCursor = cornerHit.corner === "topLeft" || cornerHit.corner === "bottomRight"
            ? "nwse-resize" : "nesw-resize";
          setCursorStyle(resizeCursor);
          setHoveringOverReferenceBorder(true);
        } else if (isEditingFormula() && referenceDragHandlers.isOverReferenceBorder(mouseX, mouseY)) {
          // Check if over a formula reference border (for dragging)
          // FIX: Use isEditingFormula() instead of isFormulaMode to allow dragging
          // existing references even when the formula doesn't end with an operator
          setCursorStyle("move");
          // FIX: Track that we're hovering over a reference border so blur handler
          // can prevent commit when clicking to start a drag
          setHoveringOverReferenceBorder(true);
        } else if (!isEditingFormula() && selectionDragHandlers.isOverSelectionBorder(mouseX, mouseY)) {
          // Check if over a selection border (for moving cells/rows/columns)
          // Only when NOT editing a formula
          setCursorStyle("move");
          setHoveringOverReferenceBorder(false);
        } else if (overlayResizeHandlers.checkOverlayResizeHandle(mouseX, mouseY)) {
          // Check if over an overlay (table/chart) resize handle
          setCursorStyle("nwse-resize");
          setHoveringOverReferenceBorder(false);
        } else if (overlayMoveHandlers.checkOverlayBody(mouseX, mouseY)) {
          // Check if over a floating overlay body (for moving)
          setCursorStyle("move");
          setHoveringOverReferenceBorder(false);
        } else {
          setHoveringOverReferenceBorder(false);
          // Check for resize handles
          const colResize = resizeHandlers.checkResizeHandle(mouseX, mouseY);
          if (colResize) {
            resizeHandlers.updateCursorForPosition(mouseX, mouseY);
          } else {
            // Check if over corner (select-all button) - show pointer
            if (mouseX < (config.rowHeaderWidth || 50) && mouseY < (config.colHeaderHeight || 24)) {
              setCursorStyle("pointer");
            }
            // Check if over column header (not resize handle) - show down arrow
            else {
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
      if (isDragging || isFormulaDragging || isRefDragging || isRefResizing || isSelectionDragging || isOverlayResizing || isOverlayMoving) {
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
      selection,
      isDragging,
      isFormulaDragging,
      isResizing,
      isRefDragging,
      isRefResizing,
      isSelectionDragging,
      isOverlayResizing,
      isOverlayMoving,
      isOverFillHandle,
      resizeHandlers,
      overlayResizeHandlers,
      overlayMoveHandlers,
      headerSelectionHandlers,
      formulaHandlers,
      formulaHeaderHandlers,
      referenceDragHandlers,
      referenceResizeHandlers,
      selectionDragHandlers,
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

    // End overlay resize operation (table/chart resize)
    if (isOverlayResizing) {
      overlayResizeHandlers.handleOverlayResizeMouseUp();
      stopAutoScroll();
      return;
    }

    // End overlay move operation (floating chart move)
    if (isOverlayMoving) {
      overlayMoveHandlers.handleOverlayMoveMouseUp();
      stopAutoScroll();
      return;
    }

    // End reference drag (moving existing reference)
    if (isRefDragging) {
      if (refDragStartRef.current) {
        referenceDragHandlers.handleReferenceDragMouseUp(stopAutoScroll);
        return;
      }
    }

    // End reference resize (resizing existing reference via corner handle)
    if (isRefResizing) {
      if (refResizeStartRef.current) {
        referenceResizeHandlers.handleReferenceResizeMouseUp(stopAutoScroll);
        return;
      }
    }

    // End selection drag (moving cells/rows/columns)
    if (isSelectionDragging) {
      if (selectionDragRef.current) {
        selectionDragHandlers.handleSelectionDragMouseUp(stopAutoScroll);
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
    isRefResizing,
    isSelectionDragging,
    isOverlayResizing,
    isOverlayMoving,
    resizeHandlers,
    overlayResizeHandlers,
    overlayMoveHandlers,
    formulaHandlers,
    formulaHeaderHandlers,
    referenceDragHandlers,
    referenceResizeHandlers,
    selectionDragHandlers,
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

      // Check if double-click is on a floating overlay (e.g., chart) - block editing
      if (overlayMoveHandlers.checkOverlayBody(mouseX, mouseY)) {
        return null;
      }

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
    [containerRef, config, viewport, dimensions, overlayMoveHandlers, isOverFillHandle, onFillHandleDoubleClick]
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
      } else if (isOverlayResizing) {
        overlayResizeHandlers.handleOverlayResizeMouseUp();
        stopAutoScroll();
      } else if (isOverlayMoving) {
        overlayMoveHandlers.handleOverlayMoveMouseUp();
        stopAutoScroll();
      } else if (isRefDragging) {
        handleMouseUp();
      } else if (isRefResizing) {
        handleMouseUp();
      } else if (isSelectionDragging) {
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
  }, [isDragging, isFormulaDragging, isResizing, isRefDragging, isRefResizing, isSelectionDragging, isOverlayResizing, isOverlayMoving, handleMouseUp, resizeHandlers, overlayResizeHandlers, overlayMoveHandlers, stopAutoScroll, onDragEnd]);

  /**
   * Global mouse move handler for tracking mouse during drag outside component.
   */
  useEffect(() => {
    const handleGlobalMouseMove = (event: MouseEvent) => {
      if (!isDragging && !isFormulaDragging && !isResizing && !isRefDragging && !isRefResizing && !isSelectionDragging && !isOverlayResizing && !isOverlayMoving) {
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

      // Handle overlay resize during global mouse move (table/chart resize)
      if (isOverlayResizing && overlayResizeStateRef.current) {
        overlayResizeHandlers.handleOverlayResizeMouseMove(mouseX, mouseY);
        return;
      }

      // Handle overlay move during global mouse move (floating chart move)
      if (isOverlayMoving && overlayMoveStateRef.current) {
        overlayMoveHandlers.handleOverlayMoveMouseMove(mouseX, mouseY);
        return;
      }

      // Handle reference drag during global mouse move (moving existing reference)
      if (isRefDragging && refDragStartRef.current) {
        referenceDragHandlers.handleReferenceDragMove(mouseX, mouseY, rect);
        return;
      }

      // Handle reference resize during global mouse move (resizing existing reference)
      if (isRefResizing && refResizeStartRef.current) {
        referenceResizeHandlers.handleReferenceResizeMove(mouseX, mouseY, rect);
        return;
      }

      // Handle selection drag during global mouse move (moving cells/rows/columns)
      if (isSelectionDragging && selectionDragRef.current) {
        selectionDragHandlers.handleSelectionDragMove(mouseX, mouseY, rect);
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

    if (isDragging || isFormulaDragging || isResizing || isRefDragging || isRefResizing || isSelectionDragging || isOverlayResizing || isOverlayMoving) {
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
    isRefResizing,
    isSelectionDragging,
    isOverlayResizing,
    isOverlayMoving,
    config,
    viewport,
    dimensions,
    containerRef,
    resizeHandlers,
    overlayResizeHandlers,
    overlayMoveHandlers,
    formulaHeaderHandlers,
    referenceDragHandlers,
    referenceResizeHandlers,
    selectionDragHandlers,
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
  // Expose floating overlay check for use by wrapper hooks
  const isOverFloatingOverlay = useCallback(
    (mouseX: number, mouseY: number): boolean => {
      return overlayMoveHandlers.checkOverlayBody(mouseX, mouseY) !== null;
    },
    [overlayMoveHandlers],
  );

  return {
    isDragging,
    isFormulaDragging,
    isResizing,
    isRefDragging,
    isRefResizing,
    isSelectionDragging,
    isOverlayResizing,
    isOverlayMoving,
    selectionDragPreview,
    cursorStyle,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
    isOverFloatingOverlay,
  };
}