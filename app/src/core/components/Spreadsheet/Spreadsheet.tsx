// FILENAME: app/src/core/components/Spreadsheet/Spreadsheet.tsx
// PURPOSE: Main spreadsheet component combining grid, editor, and ribbon
// CONTEXT: Core component that orchestrates the spreadsheet experience
// UPDATE: Made Name Box interactive with navigation support
// FIX: NameBox now participates in global editing state to prevent keyboard capture

import React, { useCallback, useEffect, useState, useRef } from "react";
import { useGridState, useGridContext } from "../../state";
import { setViewportDimensions, setSelection, scrollToCell } from "../../state/gridActions";
import { GridCanvas } from "../Grid";
import { InlineEditor } from "../InlineEditor";
import { Scrollbar, ScrollbarCorner } from "../Scrollbar/Scrollbar";
import { useScrollbarMetrics } from "../Scrollbar/useScrollbarMetrics";
import { useSpreadsheet } from "./useSpreadsheet";
import { clearRange, insertRows, insertColumns, deleteRows, deleteColumns } from "../../lib/tauri-api";
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
import { letterToColumn } from "../../types/types";
import type { SpreadsheetContentProps } from "./SpreadsheetTypes";
import { setGlobalIsEditing } from "../../hooks/useEditing"; // FIX: Import global editing state

const SCROLLBAR_SIZE = 14;

// Register core context menu items once
let coreGridMenuRegistered = false;

/**
 * Parse a cell reference string (e.g., "A1", "Z100", "AA25") into row and column indices.
 * Returns null if the reference is invalid.
 */
function parseCellReference(ref: string): { row: number; col: number } | null {
  const trimmed = ref.trim().toUpperCase();
  if (!trimmed) return null;

  // Match pattern: letters followed by numbers (e.g., "A1", "AA100", "XFD1048576")
  const match = trimmed.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;

  const colLetters = match[1];
  const rowNumber = parseInt(match[2], 10);

  // Row numbers are 1-based in display, convert to 0-based index
  if (rowNumber < 1) return null;
  const row = rowNumber - 1;

  // Convert column letters to 0-based index
  const col = letterToColumn(colLetters);

  // Validate within reasonable bounds (Excel limits: 1048576 rows, 16384 cols)
  if (row > 1048575 || col > 16383) return null;

  return { row, col };
}

function SpreadsheetContent({ className }: SpreadsheetContentProps): React.ReactElement {
  // 1. Destructure the grouped object returned by the refactored hook
  const { refs, state, handlers, ui } = useSpreadsheet();
  const gridState = useGridState();
  const { dispatch } = useGridContext();

  // 2. Extract Refs
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
  // Name Box State and Handlers
  // -------------------------------------------------------------------------
  const nameBoxRef = useRef<HTMLInputElement>(null);
  const [nameBoxValue, setNameBoxValue] = useState("");
  const [isNameBoxEditing, setIsNameBoxEditing] = useState(false);

  // Update name box value when selection changes (and not editing)
  const displayAddress = getSelectionReference();
  useEffect(() => {
    if (!isNameBoxEditing) {
      setNameBoxValue(displayAddress);
    }
  }, [displayAddress, isNameBoxEditing]);

  // FIX: Exit edit mode when clicking outside the NameBox input
  useEffect(() => {
    if (!isNameBoxEditing) return;

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (nameBoxRef.current && !nameBoxRef.current.contains(e.target as Node)) {
        setIsNameBoxEditing(false);
        setGlobalIsEditing(false);
        setNameBoxValue(displayAddress);
      }
    };

    document.addEventListener("mousedown", handleDocumentMouseDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown, { capture: true });
    };
  }, [isNameBoxEditing, displayAddress]);

  const handleNameBoxFocus = useCallback(() => {
    setIsNameBoxEditing(true);
    setGlobalIsEditing(true); // FIX: Prevent grid keyboard handler from capturing keystrokes
    // Select all text on focus for easy replacement
    setTimeout(() => {
      nameBoxRef.current?.select();
    }, 0);
  }, []);

  const handleNameBoxBlur = useCallback(() => {
    setIsNameBoxEditing(false);
    setGlobalIsEditing(false); // FIX: Allow grid keyboard handler to work again
    // Reset to current selection address on blur without navigation
    setNameBoxValue(displayAddress);
  }, [displayAddress]);

  const handleNameBoxKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // FIX: Stop propagation for ALL keys to prevent grid keyboard handler from capturing
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        const parsed = parseCellReference(nameBoxValue);
        if (parsed) {
          // Navigate to the cell
          dispatch(setSelection(parsed.row, parsed.col, parsed.row, parsed.col, "cells"));
          dispatch(scrollToCell(parsed.row, parsed.col, false));
          setIsNameBoxEditing(false);
          setGlobalIsEditing(false); // FIX: Clear global editing state
          // Return focus to the grid
          nameBoxRef.current?.blur();
          focusContainerRef.current?.focus();
        } else {
          // Invalid reference - reset to current selection
          setNameBoxValue(displayAddress);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsNameBoxEditing(false);
        setGlobalIsEditing(false); // FIX: Clear global editing state
        setNameBoxValue(displayAddress);
        nameBoxRef.current?.blur();
        focusContainerRef.current?.focus();
      }
    },
    [nameBoxValue, displayAddress, dispatch, focusContainerRef]
  );

  const handleNameBoxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNameBoxValue(e.target.value);
  }, []);

  // FIX: Prevent mousedown from bubbling to grid handlers
  const handleNameBoxMouseDown = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
  }, []);

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
        const clearedCount = await clearRange(minRow, minCol, maxRow, maxCol);
        console.log(`[Spreadsheet] Clear contents complete - ${clearedCount} cells cleared`);
        
        // Emit a single event to trigger refresh
        cellEvents.emit({
          row: minRow,
          col: minCol,
          oldValue: undefined,
          newValue: "",
          formula: null,
        });
      } catch (error) {
        console.error("[Spreadsheet] Failed to clear contents:", error);
      }
    }, [selection]);

  // -------------------------------------------------------------------------
  // Insert Row Handler
  // -------------------------------------------------------------------------
  const handleInsertRow = useCallback(async () => {
    if (!selection || selection.type !== "rows") {
      console.log("[Spreadsheet] Insert row requires row selection");
      return;
    }

    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const count = endRow - startRow + 1;

    console.log(`[Spreadsheet] Inserting ${count} row(s) at row ${startRow}`);

    try {
      const updatedCells = await insertRows(startRow, count);
      console.log(`[Spreadsheet] Insert rows complete - ${updatedCells.length} cells updated`);

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateRowInsertion(startRow, count, 200);

      cellEvents.emit({
        row: startRow,
        col: 0,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to insert rows:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Insert Column Handler
  // -------------------------------------------------------------------------
  const handleInsertColumn = useCallback(async () => {
    if (!selection || selection.type !== "columns") {
      console.log("[Spreadsheet] Insert column requires column selection");
      return;
    }

    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);
    const count = endCol - startCol + 1;

    console.log(`[Spreadsheet] Inserting ${count} column(s) at column ${startCol}`);

    try {
      const updatedCells = await insertColumns(startCol, count);
      console.log(`[Spreadsheet] Insert columns complete - ${updatedCells.length} cells updated`);

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateColumnInsertion(startCol, count, 200);

      cellEvents.emit({
        row: 0,
        col: startCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to insert columns:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Delete Row Handler
  // -------------------------------------------------------------------------
  const handleDeleteRow = useCallback(async () => {
    if (!selection || selection.type !== "rows") {
      console.log("[Spreadsheet] Delete row requires row selection");
      return;
    }

    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const count = endRow - startRow + 1;

    console.log(`[Spreadsheet] Deleting ${count} row(s) starting at row ${startRow}`);

    try {
      const updatedCells = await deleteRows(startRow, count);
      console.log(`[Spreadsheet] Delete rows complete - ${updatedCells.length} cells updated`);

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateRowDeletion(startRow, count, 200);

      cellEvents.emit({
        row: startRow,
        col: 0,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to delete rows:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Delete Column Handler
  // -------------------------------------------------------------------------
  const handleDeleteColumn = useCallback(async () => {
    if (!selection || selection.type !== "columns") {
      console.log("[Spreadsheet] Delete column requires column selection");
      return;
    }

    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);
    const count = endCol - startCol + 1;

    console.log(`[Spreadsheet] Deleting ${count} column(s) starting at column ${startCol}`);

    try {
      const updatedCells = await deleteColumns(startCol, count);
      console.log(`[Spreadsheet] Delete columns complete - ${updatedCells.length} cells updated`);

      await canvasRef.current?.refreshCells();
      await canvasRef.current?.animateColumnDeletion(startCol, count, 200);

      cellEvents.emit({
        row: 0,
        col: startCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });

      canvasRef.current?.redraw();
    } catch (error) {
      console.error("[Spreadsheet] Failed to delete columns:", error);
    }
  }, [selection, canvasRef]);

  // -------------------------------------------------------------------------
  // Register Command Handlers
  // -------------------------------------------------------------------------
  useEffect(() => {
    gridCommands.register("cut", handleCut);
    gridCommands.register("copy", handleCopy);
    gridCommands.register("paste", handlePaste);
    gridCommands.register("clearContents", handleClearContents);
    gridCommands.register("insertRow", handleInsertRow);
    gridCommands.register("insertColumn", handleInsertColumn);
    gridCommands.register("deleteRow", handleDeleteRow);
    gridCommands.register("deleteColumn", handleDeleteColumn);

    return () => {
      gridCommands.unregister("cut");
      gridCommands.unregister("copy");
      gridCommands.unregister("paste");
      gridCommands.unregister("clearContents");
      gridCommands.unregister("insertRow");
      gridCommands.unregister("insertColumn");
      gridCommands.unregister("deleteRow");
      gridCommands.unregister("deleteColumn");
    };
  }, [handleCut, handleCopy, handlePaste, handleClearContents, handleInsertRow, handleInsertColumn, handleDeleteRow, handleDeleteColumn]);

  // -------------------------------------------------------------------------
  // Context Menu State
  // -------------------------------------------------------------------------
  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    context: GridMenuContext;
  } | null>(null);

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
      if (event.shiftKey) {
        return;
      }

      event.preventDefault();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const clickedCell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

      const menuContext: GridMenuContext = {
        selection,
        clickedCell,
        isWithinSelection: clickedCell
          ? isClickWithinSelection(clickedCell.row, clickedCell.col, selection)
          : false,
        sheetIndex: gridState.sheetContext.activeSheetIndex,
        sheetName: gridState.sheetContext.activeSheetName,
      };

      setContextMenu({
        position: { x: event.clientX, y: event.clientY },
        context: menuContext,
      });
    },
    [containerRef, config, viewport, dimensions, selection, gridState.sheetContext]
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
    setTimeout(() => {
      focusContainerRef.current?.focus();
    }, 0);
  }, [focusContainerRef]);

  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    if (!contextMenu) return [];

    const items = gridExtensions.getContextMenuItemsForContext(contextMenu.context);

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

    updateDimensions();

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });

    resizeObserver.observe(gridArea);

    return () => {
      resizeObserver.disconnect();
    };
  }, [dispatch, containerRef]);

  const scrollbarMetrics = useScrollbarMetrics({
    config: gridState.config,
    viewport: gridState.viewport,
    viewportDimensions: gridState.viewportDimensions,
  });

  const handleHorizontalScroll = useCallback(
    (scrollX: number) => {
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
        {/* Name Box - Interactive with navigation support */}
        <input
          ref={nameBoxRef}
          type="text"
          value={nameBoxValue}
          onChange={handleNameBoxChange}
          onFocus={handleNameBoxFocus}
          onBlur={handleNameBoxBlur}
          onKeyDown={handleNameBoxKeyDown}
          onMouseDown={handleNameBoxMouseDown}
          style={{
            width: "80px",
            height: "22px",
            border: "1px solid #d0d0d0",
            borderRadius: "0",
            padding: "0 4px",
            fontSize: "12px",
            fontFamily: "Segoe UI, system-ui, sans-serif",
            textAlign: "center",
            outline: "none",
            backgroundColor: isNameBoxEditing ? "#ffffff" : "#f9f9f9",
            color: "#000000",
            caretColor: "#000000",
          }}
          aria-label="Name Box"
        />
        
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

      {/* Grid Area with Scrollbars */}
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
        {/* Grid Canvas */}
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

export function Spreadsheet({ className }: SpreadsheetContentProps): React.ReactElement {
  return <SpreadsheetContent className={className} />;
}

export default Spreadsheet;