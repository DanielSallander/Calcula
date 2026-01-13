// PURPOSE: Main spreadsheet component combining grid, editor, and ribbon
// CONTEXT: Core component that orchestrates the spreadsheet experience
// FIX: Added data-formula-bar attribute and onFocus handler to Formula Input
//      to correctly coordinate focus transfer with InlineEditor.

import React, { useCallback, useRef, useEffect } from "react";
import { useGridState, useGridContext } from "../../state";
import { setViewportDimensions } from "../../state/gridActions";
import { GridCanvas } from "../Grid";
import { InlineEditor } from "../InlineEditor";
import { Scrollbar, ScrollbarCorner } from "../Scrollbar/Scrollbar";
import { useScrollbarMetrics } from "../Scrollbar/useScrollbarMetrics";
import { useSpreadsheet } from "./useSpreadsheet";
import { useEditing } from "../../hooks/useEditing";
import { getFunctionTemplate } from "../../lib/tauri-api";
import type { SpreadsheetContentProps } from "./SpreadsheetTypes";

const SCROLLBAR_SIZE = 14;

function SpreadsheetContent({ className }: SpreadsheetContentProps): React.ReactElement {
  // 1. Destructure the grouped object returned by the refactored hook
  const { refs, state, handlers, ui } = useSpreadsheet();
  const { startEdit } = useEditing();
  const gridState = useGridState();
  const { dispatch } = useGridContext();

  // Ref for the grid area (the scrollable region containing the canvas)
  const gridAreaRef = useRef<HTMLDivElement>(null);

  // 2. Extract Refs
  const { 
    containerRef, 
    canvasRef 
  } = refs;

  // 3. Extract and Rename Handlers to match JSX requirements
  const {
    handleScrollEvent,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClickEvent,
    handleContainerKeyDown,
    handleFormulaInputChange,
    handleFormulaInputKeyDown,
    handleFormulaBarFocus, // FIX: Extracted this handler
    handleInlineValueChange,
    handleInlineCommit,
    handleInlineCancel,
    handleInlineTab,
    handleInlineEnter,
  } = handlers;

  // 4. Extract UI Helpers
  const {
    getFormulaBarValue,
    getSelectionReference,
  } = ui;

  // 5. Extract State
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
  } = state;

  // FIX: Track grid area dimensions and update state for scrollbar calculations
  useEffect(() => {
    const gridArea = gridAreaRef.current;
    if (!gridArea) return;

    const updateDimensions = () => {
      const width = gridArea.clientWidth;
      const height = gridArea.clientHeight;
      if (width > 0 && height > 0) {
        dispatch(setViewportDimensions(width, height));
      }
    };

    // Initial measurement
    updateDimensions();

    // Set up ResizeObserver for size changes
    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });

    resizeObserver.observe(gridArea);

    return () => {
      resizeObserver.disconnect();
    };
  }, [dispatch]);

  // 6. Scrollbar metrics based on used range
  const scrollbarMetrics = useScrollbarMetrics({
    config: gridState.config,
    viewport: gridState.viewport,
    viewportDimensions: gridState.viewportDimensions,
  });

  // 7. Scrollbar handlers
  const handleHorizontalScroll = useCallback(
    (scrollX: number) => {
      // Create a synthetic scroll event-like update
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

  // 8. Handle wheel events for scrolling
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      
      const deltaX = event.deltaX;
      const deltaY = event.deltaY;
      
      const newScrollX = Math.max(
        0,
        Math.min(scrollbarMetrics.maxScrollX, gridState.viewport.scrollX + deltaX)
      );
      const newScrollY = Math.max(
        0,
        Math.min(scrollbarMetrics.maxScrollY, gridState.viewport.scrollY + deltaY)
      );

      if (newScrollX !== gridState.viewport.scrollX || newScrollY !== gridState.viewport.scrollY) {
        const syntheticEvent = {
          currentTarget: {
            scrollLeft: newScrollX,
            scrollTop: newScrollY,
          },
        } as unknown as React.UIEvent<HTMLDivElement>;
        handleScrollEvent(syntheticEvent);
      }
    },
    [handleScrollEvent, gridState.viewport.scrollX, gridState.viewport.scrollY, scrollbarMetrics]
  );

  // Handle function insertion from ribbon (will be called by add-ins)
  const handleInsertFunction = useCallback(
    async (functionName: string, _syntax: string) => {
      if (!selection) return;

      try {
        const template = await getFunctionTemplate(functionName);
        startEdit(selection.startRow, selection.startCol, template);
      } catch (err) {
        console.error("Failed to get function template:", err);
      }
    },
    [selection, startEdit]
  );

  // Calculate viewport dimensions for scrollbars
  const viewportWidth = gridState.viewportDimensions.width - config.rowHeaderWidth - SCROLLBAR_SIZE;
  const viewportHeight = gridState.viewportDimensions.height - config.colHeaderHeight - SCROLLBAR_SIZE;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflow: "hidden",
        outline: "none",
      }}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Formula Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "28px",
          borderBottom: "1px solid #d0d0d0",
          backgroundColor: "#fff",
          padding: "0 4px",
          gap: "4px",
        }}
      >
        {/* Name Box */}
        <div
          style={{
            width: "80px",
            height: "22px",
            border: "1px solid #d0d0d0",
            backgroundColor: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontFamily: "Segoe UI, sans-serif",
          }}
        >
          {getSelectionReference()}
        </div>
        
        {/* Formula Input */}
        <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
          <span style={{ fontSize: "14px", color: "#666", fontStyle: "italic" }}>fx</span>
        </div>
        <input
          type="text"
          data-formula-bar="true" // FIX: Added identification for InlineEditor
          value={getFormulaBarValue()}
          onChange={handleFormulaInputChange}
          onKeyDown={handleFormulaInputKeyDown}
          onFocus={handleFormulaBarFocus} // FIX: Added focus handler to start editing
          style={{
            flex: 1,
            height: "22px",
            border: "1px solid #d0d0d0",
            padding: "0 4px",
            fontSize: "12px",
            fontFamily: "Segoe UI, sans-serif",
          }}
        />
      </div>

      {/* Grid Area with Scrollbars - FIX: Added ref for dimension tracking */}
      <div
        ref={gridAreaRef}
        style={{ 
          flex: 1, 
          position: "relative", 
          overflow: "hidden",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClickEvent}
        onWheel={handleWheel}
      >
        {/* Grid Canvas - adjusted for scrollbar space */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: SCROLLBAR_SIZE,
            bottom: SCROLLBAR_SIZE,
            overflow: "hidden",
          }}
        >
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
            />
          )}
        </div>

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
      </div>
    </div>
  );
}

// FIX: Removed GridProvider wrapper - now provided at Layout level
// This allows SheetTabs and Spreadsheet to share the same context
export function Spreadsheet({ className }: SpreadsheetContentProps): React.ReactElement {
  return <SpreadsheetContent className={className} />;
}

export default Spreadsheet;