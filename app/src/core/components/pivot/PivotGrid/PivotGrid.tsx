//! FILENAME: app/src/core/components/pivot/PivotGrid/PivotGrid.tsx
// PURPOSE: Canvas-based pivot table grid component with frozen panes and expand/collapse
// CONTEXT: Renders PivotViewResponse data using the existing pivot rendering infrastructure

import React, {
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useState,
  useMemo,
} from "react";
import {
  renderPivotView,
  DEFAULT_PIVOT_THEME,
  type PivotView,
  type PivotViewCell,
  type PivotTheme,
  type PivotCellValue,
  type PivotBackgroundStyle,
} from "../../../lib/gridRenderer/rendering/pivot";
import type {
  PivotId,
  PivotViewResponse,
  PivotCellData,
  ToggleGroupRequest,
  BackgroundStyle,
} from "../../../lib/pivot-api";
import { Scrollbar, ScrollbarCorner } from "../../Scrollbar";
import { usePivotGridInteraction } from "./usePivotGridInteraction";
import * as S from "./PivotGrid.styles";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface PivotGridProps {
  /** Pivot table ID */
  pivotId: PivotId;
  /** The pivot view data from backend */
  pivotView: PivotViewResponse;
  /** Callback when a group is toggled (expand/collapse) */
  onToggleGroup?: (request: ToggleGroupRequest) => void;
  /** Callback when a cell is clicked */
  onCellClick?: (row: number, col: number, cell: PivotCellData) => void;
  /** Callback when a cell is right-clicked */
  onCellContextMenu?: (
    row: number,
    col: number,
    cell: PivotCellData,
    event: React.MouseEvent
  ) => void;
  /** Optional theme override */
  theme?: Partial<PivotTheme>;
  /** Default column width */
  defaultColumnWidth?: number;
  /** Default row height */
  defaultRowHeight?: number;
}

export interface PivotGridHandle {
  /** Force a redraw of the canvas */
  redraw: () => void;
  /** Get the canvas element */
  getCanvas: () => HTMLCanvasElement | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_COLUMN_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 24;
const SCROLLBAR_SIZE = 14;
const CHAR_WIDTH_MULTIPLIER = 8; // Approximate pixels per character

// ============================================================================
// CONVERSION UTILITIES
// ============================================================================

/**
 * Convert BackgroundStyle from API to rendering format.
 */
function convertBackgroundStyle(style: BackgroundStyle): PivotBackgroundStyle {
  switch (style) {
    case "Normal":
      return "Normal";
    case "Alternate":
      return "Alternate";
    case "Subtotal":
      return "Subtotal";
    case "Total":
      return "Total";
    case "GrandTotal":
      return "GrandTotal";
    default:
      return "Normal";
  }
}

/**
 * Convert PivotCellValue from API format to rendering format.
 */
function convertCellValue(
  value: import("../../../lib/pivot-api").PivotCellValue
): PivotCellValue {
  switch (value.type) {
    case "Empty":
      return { type: "Empty" };
    case "Number":
      return { type: "Number", value: value.data };
    case "Text":
      return { type: "Text", value: value.data };
    case "Boolean":
      return { type: "Boolean", value: value.data };
    case "Error":
      return { type: "Error", value: value.data };
    default:
      return { type: "Empty" };
  }
}

/**
 * Convert PivotViewResponse from backend to PivotView format for rendering.
 */
function convertToPivotView(response: PivotViewResponse): PivotView {
  // Build 2D cells array
  const cells: PivotViewCell[][] = [];

  for (let rowIdx = 0; rowIdx < response.row_count; rowIdx++) {
    const rowData = response.rows.find((r) => r.view_row === rowIdx);
    const rowCells: PivotViewCell[] = [];

    for (let colIdx = 0; colIdx < response.col_count; colIdx++) {
      if (rowData && rowData.cells[colIdx]) {
        const apiCell = rowData.cells[colIdx];
        rowCells.push({
          value: convertCellValue(apiCell.value),
          cellType: apiCell.cell_type,
          indentLevel: apiCell.indent_level,
          isCollapsed: apiCell.is_collapsed,
          isExpandable: apiCell.is_expandable,
          numberFormat: apiCell.number_format || null,
          rowSpan: 1,
          colSpan: 1,
          isBold: apiCell.is_bold,
          backgroundStyle: convertBackgroundStyle(apiCell.background_style),
          groupPath: [],
        });
      } else {
        // Empty cell
        rowCells.push({
          value: { type: "Empty" },
          cellType: "Blank",
          indentLevel: 0,
          isCollapsed: false,
          isExpandable: false,
          numberFormat: null,
          rowSpan: 1,
          colSpan: 1,
          isBold: false,
          backgroundStyle: "Normal",
          groupPath: [],
        });
      }
    }
    cells.push(rowCells);
  }

  // Build row descriptors
  const rows = response.rows.map((r) => ({
    viewRow: r.view_row,
    rowType: r.row_type as "Data" | "Subtotal" | "GrandTotal" | "ColumnHeader",
    depth: r.depth,
    visible: r.visible,
    parentIndex: null,
    childrenIndices: [],
    groupValues: [],
  }));

  // Build column descriptors
  const columns = response.columns.map((c) => ({
    viewCol: c.view_col,
    colType: c.col_type as "RowLabel" | "Data" | "Subtotal" | "GrandTotal",
    depth: c.depth,
    widthHint: c.width_hint,
    parentIndex: null,
    childrenIndices: [],
    groupValues: [],
  }));

  return {
    pivotId: String(response.pivot_id),
    cells,
    rows,
    columns,
    rowCount: response.row_count,
    colCount: response.col_count,
    rowLabelColCount: response.row_label_col_count,
    columnHeaderRowCount: response.column_header_row_count,
    isWindowed: false,
    totalRowCount: null,
    windowStartRow: null,
    version: response.version,
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export const PivotGrid = forwardRef<PivotGridHandle, PivotGridProps>(
  function PivotGrid(props, ref) {
    const {
      pivotId,
      pivotView,
      onToggleGroup,
      onCellClick,
      onCellContextMenu,
      theme: themeOverride,
      defaultColumnWidth = DEFAULT_COLUMN_WIDTH,
      defaultRowHeight = DEFAULT_ROW_HEIGHT,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const [scrollX, setScrollX] = useState(0);
    const [scrollY, setScrollY] = useState(0);

    // Merge theme with defaults
    const theme = useMemo<PivotTheme>(
      () => ({ ...DEFAULT_PIVOT_THEME, ...themeOverride }),
      [themeOverride]
    );

    // Convert response to render format
    const renderPivotData = useMemo(
      () => convertToPivotView(pivotView),
      [pivotView]
    );

    // Calculate column widths from width hints
    const columnWidths = useMemo(() => {
      return pivotView.columns.map((col) => {
        if (col.width_hint > 0) {
          return Math.max(
            60,
            col.width_hint * CHAR_WIDTH_MULTIPLIER + 16 // padding
          );
        }
        return defaultColumnWidth;
      });
    }, [pivotView.columns, defaultColumnWidth]);

    // Calculate row heights (uniform for now)
    const rowHeights = useMemo(() => {
      return Array(pivotView.row_count).fill(defaultRowHeight);
    }, [pivotView.row_count, defaultRowHeight]);

    // Calculate total content size
    const totalWidth = useMemo(
      () => columnWidths.reduce((sum, w) => sum + w, 0),
      [columnWidths]
    );

    const totalHeight = useMemo(
      () => rowHeights.reduce((sum, h) => sum + h, 0),
      [rowHeights]
    );

    // Calculate frozen areas
    const rowHeaderWidth = useMemo(() => {
      let width = 0;
      for (let i = 0; i < pivotView.row_label_col_count; i++) {
        width += columnWidths[i] || defaultColumnWidth;
      }
      return width;
    }, [pivotView.row_label_col_count, columnWidths, defaultColumnWidth]);

    const columnHeaderHeight = useMemo(() => {
      let height = 0;
      for (let i = 0; i < pivotView.column_header_row_count; i++) {
        height += rowHeights[i] || defaultRowHeight;
      }
      return height;
    }, [pivotView.column_header_row_count, rowHeights, defaultRowHeight]);

    // Viewport size (excluding scrollbars)
    const viewportWidth = canvasSize.width - SCROLLBAR_SIZE;
    const viewportHeight = canvasSize.height - SCROLLBAR_SIZE;

    // Set up interaction handling
    const handleToggleGroup = useCallback(
      (row: number, col: number, cell: PivotCellData) => {
        if (!onToggleGroup) return;

        // Find the field index from the cell position
        // For row headers, field_index is the column index
        // For column headers, field_index is based on the row depth
        const isRowHeader = cell.cell_type === "RowHeader";

        onToggleGroup({
          pivot_id: pivotId,
          is_row: isRowHeader,
          field_index: isRowHeader ? col : row,
          value: cell.formatted_value || undefined,
        });
      },
      [pivotId, onToggleGroup]
    );

    const {
      state: interactionState,
      iconBoundsMapRef,
      handleMouseDown,
      handleMouseMove,
      handleMouseLeave,
      handleContextMenu,
    } = usePivotGridInteraction({
      pivotView,
      columnWidths,
      rowHeights,
      scrollX,
      scrollY,
      rowHeaderWidth,
      columnHeaderHeight,
      onToggleGroup: handleToggleGroup,
      onCellClick,
      onCellContextMenu,
    });

    // Drawing function
    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      const dpr = window.devicePixelRatio || 1;

      // Set canvas size with DPR
      canvas.width = viewportWidth * dpr;
      canvas.height = viewportHeight * dpr;
      canvas.style.width = `${viewportWidth}px`;
      canvas.style.height = `${viewportHeight}px`;

      // Scale for DPR
      ctx.scale(dpr, dpr);

      // Render the pivot view
      const iconBounds = renderPivotView({
        ctx,
        width: viewportWidth,
        height: viewportHeight,
        pivotView: renderPivotData,
        theme,
        scrollX,
        scrollY,
        rowHeaderWidth,
        columnHeaderHeight,
        columnWidths,
        rowHeights,
        hoveredCell: interactionState.hoveredCell,
      });

      // Store icon bounds for hit testing
      iconBoundsMapRef.current = iconBounds;
    }, [
      viewportWidth,
      viewportHeight,
      renderPivotData,
      theme,
      scrollX,
      scrollY,
      rowHeaderWidth,
      columnHeaderHeight,
      columnWidths,
      rowHeights,
      interactionState.hoveredCell,
      iconBoundsMapRef,
    ]);

    // Imperative handle
    useImperativeHandle(ref, () => ({
      redraw: draw,
      getCanvas: () => canvasRef.current,
    }));

    // Resize observer for container
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setCanvasSize({ width, height });
        }
      });

      resizeObserver.observe(container);
      return () => resizeObserver.disconnect();
    }, []);

    // Draw on state changes
    useEffect(() => {
      draw();
    }, [draw]);

    // Scroll handlers
    const handleScrollX = useCallback((position: number) => {
      setScrollX(position);
    }, []);

    const handleScrollY = useCallback((position: number) => {
      setScrollY(position);
    }, []);

    // Handle wheel scroll
    const handleWheel = useCallback(
      (event: React.WheelEvent) => {
        event.preventDefault();

        const maxScrollX = Math.max(0, totalWidth - viewportWidth);
        const maxScrollY = Math.max(0, totalHeight - viewportHeight);

        if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          // Horizontal scroll
          setScrollX((prev) =>
            Math.max(0, Math.min(maxScrollX, prev + event.deltaX))
          );
        } else {
          // Vertical scroll
          setScrollY((prev) =>
            Math.max(0, Math.min(maxScrollY, prev + event.deltaY))
          );
        }
      },
      [totalWidth, totalHeight, viewportWidth, viewportHeight]
    );

    // Content sizes for scrollbars (adjusted for frozen areas)
    const scrollableWidth = totalWidth - rowHeaderWidth;
    const scrollableHeight = totalHeight - columnHeaderHeight;
    const scrollableViewportWidth = viewportWidth - rowHeaderWidth;
    const scrollableViewportHeight = viewportHeight - columnHeaderHeight;

    return (
      <S.PivotGridContainer ref={containerRef}>
        <S.GridArea>
          <S.StyledCanvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
            onWheel={handleWheel}
          />
        </S.GridArea>

        {/* Vertical scrollbar */}
        {scrollableHeight > scrollableViewportHeight && (
          <S.VerticalScrollbarContainer>
            <Scrollbar
              orientation="vertical"
              scrollPosition={scrollY}
              contentSize={scrollableHeight}
              viewportSize={scrollableViewportHeight}
              onScroll={handleScrollY}
            />
          </S.VerticalScrollbarContainer>
        )}

        {/* Horizontal scrollbar */}
        {scrollableWidth > scrollableViewportWidth && (
          <S.HorizontalScrollbarContainer>
            <Scrollbar
              orientation="horizontal"
              scrollPosition={scrollX}
              contentSize={scrollableWidth}
              viewportSize={scrollableViewportWidth}
              onScroll={handleScrollX}
            />
          </S.HorizontalScrollbarContainer>
        )}

        {/* Corner piece */}
        {(scrollableHeight > scrollableViewportHeight ||
          scrollableWidth > scrollableViewportWidth) && (
          <S.ScrollbarCornerContainer>
            <ScrollbarCorner size={SCROLLBAR_SIZE} />
          </S.ScrollbarCornerContainer>
        )}
      </S.PivotGridContainer>
    );
  }
);
