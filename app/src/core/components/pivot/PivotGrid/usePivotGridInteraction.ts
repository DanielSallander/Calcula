//! FILENAME: app/src/core/components/pivot/PivotGrid/usePivotGridInteraction.ts
// PURPOSE: Hook for handling mouse/keyboard interactions on the PivotGrid canvas
// CONTEXT: Manages expand/collapse icon clicks, cell selection, and context menu

import { useCallback, useRef, useState } from "react";
import type { PivotCellData, PivotViewResponse } from "../../../lib/pivot-api";
import { findClickedPivotIcon } from "../../../lib/gridRenderer/rendering/pivot";

export interface PivotGridInteractionState {
  /** Currently hovered cell [row, col] or null */
  hoveredCell: [number, number] | null;
  /** Whether an icon is being hovered */
  iconHovered: boolean;
}

export interface UsePivotGridInteractionProps {
  /** The pivot view data */
  pivotView: PivotViewResponse;
  /** Column widths array */
  columnWidths: number[];
  /** Row heights array */
  rowHeights: number[];
  /** Current scroll X position */
  scrollX: number;
  /** Current scroll Y position */
  scrollY: number;
  /** Width of the frozen row label area */
  rowHeaderWidth: number;
  /** Height of the frozen column header area */
  columnHeaderHeight: number;
  /** Callback when expand/collapse icon is clicked */
  onToggleGroup?: (row: number, col: number, cell: PivotCellData) => void;
  /** Callback when a cell is clicked */
  onCellClick?: (row: number, col: number, cell: PivotCellData) => void;
  /** Callback when a cell is right-clicked */
  onCellContextMenu?: (
    row: number,
    col: number,
    cell: PivotCellData,
    event: React.MouseEvent
  ) => void;
}

export interface UsePivotGridInteractionResult {
  /** Current interaction state */
  state: PivotGridInteractionState;
  /** Icon bounds map for hit testing (from last render) */
  iconBoundsMapRef: React.MutableRefObject<
    Map<string, { x: number; y: number; width: number; height: number }>
  >;
  /** Handle mouse down on canvas */
  handleMouseDown: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Handle mouse move on canvas */
  handleMouseMove: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Handle mouse leave on canvas */
  handleMouseLeave: () => void;
  /** Handle context menu on canvas */
  handleContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void;
}

/**
 * Convert mouse event coordinates to canvas-relative coordinates.
 */
function getCanvasCoordinates(
  event: React.MouseEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (event.clientX - rect.left) * dpr,
    y: (event.clientY - rect.top) * dpr,
  };
}

/**
 * Find which cell is at the given canvas coordinates.
 */
function findCellAtPosition(
  canvasX: number,
  canvasY: number,
  pivotView: PivotViewResponse,
  columnWidths: number[],
  rowHeights: number[],
  scrollX: number,
  scrollY: number,
  rowHeaderWidth: number,
  columnHeaderHeight: number
): { row: number; col: number } | null {
  const frozenCols = pivotView.row_label_col_count;
  const frozenRows = pivotView.column_header_row_count;
  const dpr = window.devicePixelRatio || 1;

  // Adjust for DPR
  const x = canvasX / dpr;
  const y = canvasY / dpr;

  // Determine which zone we're in
  const inFrozenCols = x < rowHeaderWidth;
  const inFrozenRows = y < columnHeaderHeight;

  // Find column
  let col = -1;
  let currentX = 0;

  if (inFrozenCols) {
    // In frozen columns area
    for (let c = 0; c < frozenCols; c++) {
      const width = columnWidths[c] || 100;
      if (x >= currentX && x < currentX + width) {
        col = c;
        break;
      }
      currentX += width;
    }
  } else {
    // In scrollable columns area
    currentX = rowHeaderWidth - scrollX;
    for (let c = frozenCols; c < pivotView.col_count; c++) {
      const width = columnWidths[c] || 100;
      if (x >= currentX && x < currentX + width) {
        col = c;
        break;
      }
      currentX += width;
    }
  }

  // Find row
  let row = -1;
  let currentY = 0;

  if (inFrozenRows) {
    // In frozen rows area
    for (let r = 0; r < frozenRows; r++) {
      const height = rowHeights[r] || 24;
      if (y >= currentY && y < currentY + height) {
        row = r;
        break;
      }
      currentY += height;
    }
  } else {
    // In scrollable rows area
    currentY = columnHeaderHeight - scrollY;
    for (let r = frozenRows; r < pivotView.row_count; r++) {
      const height = rowHeights[r] || 24;
      if (y >= currentY && y < currentY + height) {
        row = r;
        break;
      }
      currentY += height;
    }
  }

  if (row >= 0 && col >= 0) {
    return { row, col };
  }
  return null;
}

/**
 * Get cell data from the pivot view.
 */
function getCellData(
  pivotView: PivotViewResponse,
  row: number,
  col: number
): PivotCellData | null {
  const rowData = pivotView.rows.find((r) => r.view_row === row);
  if (rowData && rowData.cells[col]) {
    return rowData.cells[col];
  }
  return null;
}

export function usePivotGridInteraction(
  props: UsePivotGridInteractionProps
): UsePivotGridInteractionResult {
  const {
    pivotView,
    columnWidths,
    rowHeights,
    scrollX,
    scrollY,
    rowHeaderWidth,
    columnHeaderHeight,
    onToggleGroup,
    onCellClick,
    onCellContextMenu,
  } = props;

  const [state, setState] = useState<PivotGridInteractionState>({
    hoveredCell: null,
    iconHovered: false,
  });

  const iconBoundsMapRef = useRef<
    Map<string, { x: number; y: number; width: number; height: number }>
  >(new Map());

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const { x, y } = getCanvasCoordinates(event, canvas);
      const dpr = window.devicePixelRatio || 1;

      // Check if an icon was clicked
      const clickedIcon = findClickedPivotIcon(
        x / dpr,
        y / dpr,
        iconBoundsMapRef.current
      );

      if (clickedIcon && onToggleGroup) {
        const cell = getCellData(pivotView, clickedIcon.row, clickedIcon.col);
        if (cell) {
          onToggleGroup(clickedIcon.row, clickedIcon.col, cell);
          return;
        }
      }

      // Check if a cell was clicked
      const cellPos = findCellAtPosition(
        x,
        y,
        pivotView,
        columnWidths,
        rowHeights,
        scrollX,
        scrollY,
        rowHeaderWidth,
        columnHeaderHeight
      );

      if (cellPos && onCellClick) {
        const cell = getCellData(pivotView, cellPos.row, cellPos.col);
        if (cell) {
          onCellClick(cellPos.row, cellPos.col, cell);
        }
      }
    },
    [
      pivotView,
      columnWidths,
      rowHeights,
      scrollX,
      scrollY,
      rowHeaderWidth,
      columnHeaderHeight,
      onToggleGroup,
      onCellClick,
    ]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const { x, y } = getCanvasCoordinates(event, canvas);
      const dpr = window.devicePixelRatio || 1;

      // Check if hovering over an icon
      const hoveredIcon = findClickedPivotIcon(
        x / dpr,
        y / dpr,
        iconBoundsMapRef.current
      );

      // Find hovered cell
      const cellPos = findCellAtPosition(
        x,
        y,
        pivotView,
        columnWidths,
        rowHeights,
        scrollX,
        scrollY,
        rowHeaderWidth,
        columnHeaderHeight
      );

      setState((prev) => {
        const newHoveredCell = cellPos
          ? ([cellPos.row, cellPos.col] as [number, number])
          : null;
        const newIconHovered = hoveredIcon !== null;

        // Only update if something changed
        if (
          prev.hoveredCell?.[0] === newHoveredCell?.[0] &&
          prev.hoveredCell?.[1] === newHoveredCell?.[1] &&
          prev.iconHovered === newIconHovered
        ) {
          return prev;
        }

        return {
          hoveredCell: newHoveredCell,
          iconHovered: newIconHovered,
        };
      });

      // Update cursor
      canvas.style.cursor = hoveredIcon ? "pointer" : "default";
    },
    [
      pivotView,
      columnWidths,
      rowHeights,
      scrollX,
      scrollY,
      rowHeaderWidth,
      columnHeaderHeight,
    ]
  );

  const handleMouseLeave = useCallback(() => {
    setState({
      hoveredCell: null,
      iconHovered: false,
    });
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();

      if (!onCellContextMenu) return;

      const canvas = event.currentTarget;
      const { x, y } = getCanvasCoordinates(event, canvas);

      const cellPos = findCellAtPosition(
        x,
        y,
        pivotView,
        columnWidths,
        rowHeights,
        scrollX,
        scrollY,
        rowHeaderWidth,
        columnHeaderHeight
      );

      if (cellPos) {
        const cell = getCellData(pivotView, cellPos.row, cellPos.col);
        if (cell) {
          onCellContextMenu(cellPos.row, cellPos.col, cell, event);
        }
      }
    },
    [
      pivotView,
      columnWidths,
      rowHeights,
      scrollX,
      scrollY,
      rowHeaderWidth,
      columnHeaderHeight,
      onCellContextMenu,
    ]
  );

  return {
    state,
    iconBoundsMapRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseLeave,
    handleContextMenu,
  };
}
