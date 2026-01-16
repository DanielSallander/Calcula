// FILENAME: app/src/components/Spreadsheet/Spreadsheet.tsx
// PURPOSE: Main spreadsheet component combining grid, editor, and ribbon
// CONTEXT: Core component that orchestrates the spreadsheet experience
// FIX: Added data-formula-bar attribute and onFocus handler to Formula Input
//      to correctly coordinate focus transfer with InlineEditor.
// FIX: Corrected containerRef to point to grid area for proper mouse coordinate calculation.
// FIX: Use focusContainerRef from useSpreadsheet for keyboard event handling.
// UPDATE: Added extensible right-click context menu system.
// UPDATE: Register command handlers with gridCommands for context menu actions.

import React, { useCallback, useEffect, useState } from "react";
import { useGridState, useGridContext } from "../../state";
import { setViewportDimensions } from "../../state/gridActions";
import { GridCanvas } from "../Grid";
import { InlineEditor } from "../InlineEditor";
import { Scrollbar, ScrollbarCorner } from "../Scrollbar/Scrollbar";
import { useScrollbarMetrics } from "../Scrollbar/useScrollbarMetrics";
import { useSpreadsheet } from "./useSpreadsheet";
import { clearCell } from "../../lib/tauri-api";
import { cellEvents } from "../../lib/cellEvents";
import { ContextMenu } from "../ContextMenu";
import type { ContextMenuPosition, ContextMenuItem } from "../ContextMenu";
import {
  gridExtensions,
  gridCommands,
  registerCoreGridContextMenu,
  isClickWithinSelection,
  type GridMenuContext,
} from "../../extensions";
import { getCellFromPixel } from "../../lib/gridRenderer";
import type { SpreadsheetContentProps } from "./SpreadsheetTypes";

const SCROLLBAR_SIZE = 14;

// Register core context menu items once
let coreGridMenuRegistered = false;

function SpreadsheetContent({ className }: SpreadsheetContentProps): React.ReactElement {
  // 1. Destructure the grouped object returned by the refactored hook
  const { refs, state, handlers, ui } = useSpreadsheet();
  const gridState = useGridState();
  const { dispatch } = useGridContext();

  // 2. Extract Refs
  // FIX: Use focusContainerRef from useSpreadsheet for the focusable outer container
  // containerRef is used for the grid area (mouse coordinate calculations)
  const { 
    containerRef, 
    focusContainerRef,
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
    handleFormulaBarFocus,
    handleInlineValueChange,
    handleInlineCommit,
    handleInlineCancel,
    handleInlineTab,
    handleInlineEnter,
    handleCut,
    handleCopy,
    handlePaste,
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

  // -------------------------------------------------------------------------
  // Clear Contents Handler
  // -------------------------------------------------------------------------
  const handleClearContents = useCallback(async () => {
    if (!selection) {
      console.log("[Spreadsheet] No selection to clear");
      return;
    }

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    console.log(`[Spreadsheet] Clearing contents from (${minRow},${minCol}) to (${maxRow},${maxCol})`);

    try {
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          await clearCell(row, col);
          cellEvents.emit({
            row,
            col,
            oldValue: undefined,
            newValue: "",
            formula: null,
          });
        }
      }
      console.log("[Spreadsheet] Clear contents complete");
    } catch (error) {
      console.error("[Spreadsheet] Failed to clear contents:", error);
    }
  }, [selection]);

  // -------------------------------------------------------------------------
  // Register Command Handlers
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Register clipboard and edit command handlers
    gridCommands.register("cut", handleCut);
    gridCommands.register("copy", handleCopy);
    gridCommands.register("paste", handlePaste);
    gridCommands.register("clearContents", handleClearContents);

    // Cleanup on unmount
    return () => {
      gridCommands.unregister("cut");
      gridCommands.unregister("copy");
      gridCommands.unregister("paste");
      gridCommands.unregister("clearContents");
    };
  }, [handleCut, handleCopy, handlePaste, handleClearContents]);

  // -------------------------------------------------------------------------
  // Context Menu State
  // -------------------------------------------------------------------------
  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    context: GridMenuContext;
  } | null>(null);

  // Register core menu items on first render
  useEffect(() => {
    if (!coreGridMenuRegistered) {
      registerCoreGridContextMenu();
      coreGridMenuRegistered = true;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Context Menu Handler
  // -------------------------------------------------------------------------
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Shift+Right-click: show native browser menu (for DevTools access)
      if (event.shiftKey) {
        return; // Let browser handle it
      }

      // Prevent default browser context menu
      event.preventDefault();

      // Get mouse position relative to container
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Determine which cell was clicked
      const clickedCell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

      // Build context for menu items
      const menuContext: GridMenuContext = {
        selection,
        clickedCell,
        isWithinSelection: clickedCell
          ? isClickWithinSelection(clickedCell.row, clickedCell.col, selection)
          : false,
        sheetIndex: gridState.sheetContext.activeSheetIndex,
        sheetName: gridState.sheetContext.activeSheetName,
      };

      // Show context menu at mouse position
      setContextMenu({
        position: { x: event.clientX, y: event.clientY },
        context: menuContext,
      });
    },
    [containerRef, config, viewport, dimensions, selection, gridState.sheetContext]
  );

  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
    // Restore focus to the grid container for keyboard navigation
    // Use setTimeout to ensure focus happens after React re-render
    setTimeout(() => {
      focusContainerRef.current?.focus();
    }, 0);
  }, [focusContainerRef]);

  // Get menu items for current context
  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    if (!contextMenu) return [];

    const items = gridExtensions.getContextMenuItemsForContext(contextMenu.context);

    // Convert GridContextMenuItem to ContextMenuItem
    return items.map((item) => ({
      id: item.id,
      label: item.label,
      shortcut: item.shortcut,
      icon: item.icon,
      disabled: !!item.disabled,
      separatorAfter: item.separatorAfter,
      onClick: () => item.onClick(contextMenu.context),
    }));
  }, [contextMenu]);

  // FIX: Track grid area dimensions and update state for scrollbar calculations
  // Now uses containerRef which points to the grid area
  useEffect(() => {
    const gridArea = containerRef.current;
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
  }, [dispatch, containerRef]);

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

  // Calculate viewport dimensions for scrollbars
  const viewportWidth = gridState.viewportDimensions.width - config.rowHeaderWidth - SCROLLBAR_SIZE;
  const viewportHeight = gridState.viewportDimensions.height - config.colHeaderHeight - SCROLLBAR_SIZE;

  return (
    <div
      ref={focusContainerRef}
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
          data-formula-bar="true"
          value={getFormulaBarValue()}
          onChange={handleFormulaInputChange}
          onKeyDown={handleFormulaInputKeyDown}
          onFocus={handleFormulaBarFocus}
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

      {/* Grid Area with Scrollbars - uses containerRef for mouse coordinate consistency */}
      <div
        ref={containerRef}
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
        onContextMenu={handleContextMenu}
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
              onRestoreFocus={() => focusContainerRef.current?.focus()}
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

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          items={getContextMenuItems()}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
}

// FIX: Removed GridProvider wrapper - now provided at Layout level
// This allows SheetTabs and Spreadsheet to share the same context
export function Spreadsheet({ className }: SpreadsheetContentProps): React.ReactElement {
  return <SpreadsheetContent className={className} />;
}

export default Spreadsheet;