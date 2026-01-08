// FILENAME: app/src/components/Spreadsheet/useSpreadsheet.ts
// PURPOSE: Main composer hook that aggregates functional sub-hooks.
// CONTEXT: Orchestrates initialization and combines logic from Styles, Selection, Editing, and Layout hooks.
// Updated: Added clipboard state for marching ants animation.

import { useRef, useCallback, useState, useEffect } from "react";
import { useGridState, useGridContext } from "../../state";
import type { GridCanvasHandle } from "../Grid";
import { useScrollbarMetrics } from "../../../core/components/Scrollbar";

import { useSpreadsheetStyles } from "./useSpreadsheetStyles";
import { useSpreadsheetSelection } from "./useSpreadsheetSelection";
import { useSpreadsheetEditing } from "./useSpreadsheetEditing";
import { useSpreadsheetLayout } from "./useSpreadsheetLayout";

export function useSpreadsheet() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<GridCanvasHandle>(null);

  const [isFocused, setIsFocused] = useState(false);

  const state = useGridState();
  const { dispatch } = useGridContext();
  
  const styleLogic = useSpreadsheetStyles(canvasRef);
  
  // Calculate Scrollbar Metrics (Excel-like dynamic scaling)
  // This hook abstracts the logic of "Used Range" vs "Viewport"
  const scrollbarMetrics = useScrollbarMetrics({
    config: state.config,
    viewport: state.viewport,
    // Fix: state.dimensions is DimensionOverrides; state.viewport contains the physical width/height
    viewportDimensions: state.viewport as any,
    refreshInterval: 3000, // Check for new data every 3s
  });

  const selectionLogic = useSpreadsheetSelection({
    canvasRef,
    containerRef,
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
      if (containerRef.current && !editingLogic.editingState.isEditing) {
        containerRef.current.focus();
        setIsFocused(true);
        // console.log("[Spreadsheet] Container focused on mount");
      }
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  const handleCellsUpdatedWithFocus = useCallback(async () => {
    await styleLogic.handleCellsUpdated();
    // Refresh scrollbar metrics as content might have expanded
    scrollbarMetrics.refresh();
    
    setTimeout(() => {
      if (containerRef.current && !editingLogic.editingState.isEditing) {
        containerRef.current.focus();
        setIsFocused(true);
      }
    }, 50);
  }, [styleLogic, editingLogic.editingState.isEditing, scrollbarMetrics]);

  return {
    refs: {
      containerRef,
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
      handleContainerKeyDown: editingLogic.handlers.handleContainerKeyDown,
      setStatusMessage: editingLogic.setStatusMessage,
      clearError: editingLogic.handlers.clearError,
      
      handleMouseDown: selectionLogic.mouseHandlers.handleMouseDown,
      handleMouseMove: selectionLogic.mouseHandlers.handleMouseMove,
      handleMouseUp: selectionLogic.mouseHandlers.handleMouseUp,
      handleDoubleClickEvent: selectionLogic.handleDoubleClickEvent,
      
      // Use layout logic for scrolling, but this likely needs to accept
      // values from our custom Scrollbar component
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