//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheet.ts
// PURPOSE: Main composer hook that aggregates functional sub-hooks.
// CONTEXT: Orchestrates initialization and combines logic from Styles, Selection, Editing, and Layout hooks.

import { useRef, useCallback, useState, useEffect } from "react";
import { useGridState, useGridContext } from "../../state";
import { scrollToCell, setSelection } from "../../state/gridActions";
import { AppEvents, onAppEvent } from "../../lib/events";
import type { GridCanvasHandle } from "../Grid";
import { useScrollbarMetrics } from "../../../core/components/Scrollbar";

import { useSpreadsheetStyles } from "./useSpreadsheetStyles";
import { useSpreadsheetSelection } from "./useSpreadsheetSelection";
import { useSpreadsheetEditing } from "./useSpreadsheetEditing";
import { useSpreadsheetLayout } from "./useSpreadsheetLayout";

export function useSpreadsheet() {
  const containerRef = useRef<HTMLDivElement>(null);
  // FIX: Separate ref for the focusable outer container that receives keyboard events
  const focusContainerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<GridCanvasHandle>(null);

  const [isFocused, setIsFocused] = useState(false);

  const state = useGridState();
  const { dispatch } = useGridContext();
  
  const styleLogic = useSpreadsheetStyles(canvasRef);
  
  // Calculate Scrollbar Metrics (Excel-like dynamic scaling)
  // viewportDimensions is now tracked in Spreadsheet.tsx via ResizeObserver
  const scrollbarMetrics = useScrollbarMetrics({
    config: state.config,
    viewport: state.viewport,
    viewportDimensions: state.viewportDimensions,
    refreshInterval: 3000, // Check for new data every 3s
  });

  const selectionLogic = useSpreadsheetSelection({
    canvasRef,
    containerRef,
    focusContainerRef, // FIX: Pass focusContainerRef for keyboard events
    scrollRef,
    state,
    dispatch,
    isFocused,
    onCommitBeforeSelect: async () => {
      await editingLogic.handlers.handleCommitBeforeSelect();
    }
  });

  const editingLogic = useSpreadsheetEditing({
    containerRef,
    focusContainerRef, // FIX: Pass focusContainerRef for focus restoration
    formulaInputRef,
    state,
    selectedCellContent: selectionLogic.selectedCellContent,
    moveActiveCell: selectionLogic.moveActiveCell,
    scrollToSelection: selectionLogic.scrollToSelection,
    selectCell: selectionLogic.selectCell,
  });

  const layoutLogic = useSpreadsheetLayout({
    scrollRef,
    containerRef,
    canvasRef,
    state,
    isFocused,
    getSelectionReference: selectionLogic.getSelectionReference,
    mouseCursorStyle: selectionLogic.mouseHandlers.cursorStyle,
    isResizing: selectionLogic.mouseState.isResizing,
    isFormulaDragging: selectionLogic.mouseState.isFormulaDragging,
    isDragging: selectionLogic.mouseState.isDragging,
    isFillDragging: selectionLogic.mouseState.isFillDragging,
  });

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback((event: React.FocusEvent) => {
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    if (relatedTarget) {
      if (
        relatedTarget === formulaInputRef.current ||
        relatedTarget.closest(".spreadsheet-container")
      ) {
        return;
      }
    }
    setIsFocused(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      // FIX: Focus the focusContainerRef instead of containerRef
      if (focusContainerRef.current && !editingLogic.editingState.isEditing) {
        focusContainerRef.current.focus();
        setIsFocused(true);
      }
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  // Listen for NAVIGATE_TO_CELL events (e.g., from pivot table creation)
  // This handles scroll + selection + refresh in the correct sequence
  useEffect(() => {
    const cleanup = onAppEvent<{ row: number; col: number }>(
      AppEvents.NAVIGATE_TO_CELL,
      ({ row, col }) => {
        console.log('[useSpreadsheet] NAVIGATE_TO_CELL event received:', { row, col });

        // First set selection to the target cell - this will also trigger scroll in the reducer
        dispatch(setSelection(row, col, row, col, 'cells'));

        // Also explicitly dispatch scroll to ensure visibility
        dispatch(scrollToCell(row, col, false));

        // Wait for React to re-render with new viewport state, then refresh cells
        // Use requestAnimationFrame + setTimeout for more reliable timing
        requestAnimationFrame(() => {
          setTimeout(async () => {
            console.log('[useSpreadsheet] Refreshing cells after navigation');
            if (canvasRef.current) {
              await canvasRef.current.refreshCells();
            }
          }, 100);
        });
      }
    );

    return cleanup;
  }, [dispatch]);

  // Emit selection:changed event whenever selection changes
  // This allows other components (like pivot table sidebar) to react to selection changes
  useEffect(() => {
    if (state.selection) {
      window.dispatchEvent(new CustomEvent("selection:changed", {
        detail: { 
          row: state.selection.startRow, 
          col: state.selection.startCol,
          startRow: state.selection.startRow,
          startCol: state.selection.startCol,
          endRow: state.selection.endRow,
          endCol: state.selection.endCol,
          type: state.selection.type
        }
      }));
    }
  }, [state.selection]);

  const handleCellsUpdatedWithFocus = useCallback(async () => {
    await styleLogic.handleCellsUpdated();
    // Refresh scrollbar metrics as content might have expanded
    scrollbarMetrics.refresh();
    
    setTimeout(() => {
      // FIX: Focus the focusContainerRef instead of containerRef
      if (focusContainerRef.current && !editingLogic.editingState.isEditing) {
        focusContainerRef.current.focus();
        setIsFocused(true);
      }
    }, 50);
  }, [styleLogic, editingLogic.editingState.isEditing, scrollbarMetrics]);

  return {
    refs: {
      containerRef,
      focusContainerRef, // FIX: Expose focusContainerRef
      scrollRef,
      formulaInputRef,
      canvasRef,
    },
    state: {
      isFocused,
      statusMessage: editingLogic.statusMessage,
      styleCache: styleLogic.styleCache,
      selection: state.selection,
      viewport: state.viewport,
      config: state.config,
      editing: state.editing,
      dimensions: state.dimensions,
      formulaReferences: state.formulaReferences,
      isEditing: editingLogic.editingState.isEditing,
      isCommitting: editingLogic.editingState.isCommitting,
      isFormulaMode: editingLogic.editingState.isFormulaMode,
      fillState: selectionLogic.fillState,
      // Clipboard state for marching ants
      clipboardMode: selectionLogic.clipboardState.mode,
      clipboardSelection: selectionLogic.clipboardState.selection,
      // Selection drag preview for move operation
      selectionDragPreview: selectionLogic.selectionDragPreview,
    },
    handlers: {
      handleCellsUpdated: handleCellsUpdatedWithFocus,
      
      handleFormulaInputChange: editingLogic.handlers.handleFormulaInputChange,
      handleFormulaInputKeyDown: editingLogic.handlers.handleFormulaInputKeyDown,
      handleFormulaBarFocus: editingLogic.handlers.handleFormulaBarFocus,
      handleInlineValueChange: editingLogic.handlers.handleInlineValueChange,
      handleInlineCommit: editingLogic.handlers.handleInlineCommit,
      handleInlineCancel: editingLogic.handlers.handleInlineCancel,
      handleInlineTab: editingLogic.handlers.handleInlineTab,
      handleInlineEnter: editingLogic.handlers.handleInlineEnter,
      handleInlineCtrlEnter: editingLogic.handlers.handleInlineCtrlEnter,
      handleArrowKeyReference: editingLogic.handlers.handleArrowKeyReference,
      handleContainerKeyDown: editingLogic.handlers.handleContainerKeyDown,
      setStatusMessage: editingLogic.setStatusMessage,
      clearError: editingLogic.handlers.clearError,
      
      handleMouseDown: selectionLogic.mouseHandlers.handleMouseDown,
      handleMouseMove: selectionLogic.mouseHandlers.handleMouseMove,
      handleMouseUp: selectionLogic.mouseHandlers.handleMouseUp,
      handleDoubleClickEvent: selectionLogic.handleDoubleClickEvent,
      
      // Use layout logic for scrolling
      handleScrollEvent: layoutLogic.handleScrollEvent,
      
      handleFocus,
      handleBlur,

      // Clipboard handlers
      handleCut: selectionLogic.clipboardHandlers.cut,
      handleCopy: selectionLogic.clipboardHandlers.copy,
      handlePaste: selectionLogic.clipboardHandlers.paste,
    },
    ui: {
      getSelectionReference: selectionLogic.getSelectionReference,
      // We expose the dynamically calculated scrollbar metrics here
      scrollbarMetrics,
      // Fallback/Legacy content size if needed by other components
      contentSize: layoutLogic.contentSize, 
      statusText: layoutLogic.statusText,
      scrollInfo: layoutLogic.scrollInfo,
      boundsInfo: layoutLogic.boundsInfo,
      getModeStatus: layoutLogic.getModeStatus,
      getFormulaBarValue: editingLogic.ui.getFormulaBarValue,
      gridCursor: layoutLogic.gridCursor,
    },
  };
}