//! FILENAME: app/extensions/pivot/components/PivotGrid/PivotGrid.tsx
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import type { PivotViewResponse } from '../../lib/pivot-api';
import { getPivotView, togglePivotGroup } from '../../lib/pivot-api';
import {
  renderPivotView,
  createPivotTheme,
  measurePivotColumnWidth,
} from '../../rendering/pivot';
import type {
  PivotTheme,
  PivotInteractiveBounds,
  PivotRenderOptions,
} from '../../rendering/pivot';
import { usePivotGridInteraction } from './usePivotGridInteraction';
import { FilterDropdown } from '../FilterDropdown';

// =============================================================================
// TYPES
// =============================================================================

export interface PivotGridProps {
  pivotId: number;
  theme?: Partial<PivotTheme>;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
  minColumnWidth?: number;
  maxColumnWidth?: number;
  onCellClick?: (row: number, col: number, cell: unknown) => void;
  onExpandCollapse?: (row: number, col: number, newExpandedState: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_ROW_HEIGHT = 28;
const MIN_COLUMN_WIDTH = 50;
const MAX_COLUMN_WIDTH = 400;

// =============================================================================
// COMPONENT
// =============================================================================

export const PivotGrid: React.FC<PivotGridProps> = ({
  pivotId,
  theme: themeOverrides,
  defaultRowHeight = DEFAULT_ROW_HEIGHT,
  minColumnWidth = MIN_COLUMN_WIDTH,
  maxColumnWidth = MAX_COLUMN_WIDTH,
  onExpandCollapse,
  className,
  style,
}) => {
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // State
  const [pivotView, setPivotView] = useState<PivotViewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 });
  const [interactiveBounds, setInteractiveBounds] = useState<PivotInteractiveBounds | null>(null);

  // Calculated dimensions
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const [colWidths, setColWidths] = useState<number[]>([]);

  // Theme
  const theme = useMemo(() => createPivotTheme(themeOverrides), [themeOverrides]);

  // ==========================================================================
  // DATA FETCHING
  // ==========================================================================

  const fetchPivotData = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await getPivotView(pivotId);
      setPivotView(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pivot data');
    } finally {
      setIsLoading(false);
    }
  }, [pivotId]);

  useEffect(() => {
    fetchPivotData();
  }, [fetchPivotData]);

  // ==========================================================================
  // DIMENSION CALCULATIONS
  // ==========================================================================

  useEffect(() => {
    if (!pivotView) return;

    // Calculate row heights (uniform for now)
    const heights = pivotView.rows.map(() => defaultRowHeight);
    setRowHeights(heights);

    // Calculate column widths (auto-size based on content)
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const colCount = pivotView.rows[0]?.cells.length || 0;
        const widths: number[] = [];

        for (let c = 0; c < colCount; c++) {
          const measuredWidth = measurePivotColumnWidth(
            ctx,
            pivotView,
            c,
            theme,
            minColumnWidth,
            maxColumnWidth
          );
          widths.push(measuredWidth);
        }

        setColWidths(widths);
      }
    }
  }, [pivotView, defaultRowHeight, theme, minColumnWidth, maxColumnWidth]);

  // ==========================================================================
  // CANVAS RESIZE
  // ==========================================================================

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setCanvasSize({
          width: Math.floor(width),
          height: Math.floor(height),
        });
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // ==========================================================================
  // INTERACTION HOOK
  // ==========================================================================

  const handleExpandCollapse = useCallback(
    async (row: number, col: number, isExpanded: boolean) => {
      if (!pivotView) return;

      // Look up the cell data to find the item label
      const rowData = pivotView.rows[row];
      if (!rowData) return;
      const cell = rowData.cells[col];
      if (!cell) return;

      // The formatted value is the item label for this row header
      const itemLabel = cell.formattedValue;

      // Determine field index: col position maps to a row field (for row headers)
      // In compact layout, all fields are in col 0 with indent levels
      // In outline/tabular, each field has its own column
      // Use indentLevel when > 0 (compact layout), otherwise fall back to col
      const fieldIndex = cell.indentLevel || col;

      const newExpandedState = !isExpanded;
      onExpandCollapse?.(row, col, newExpandedState);

      try {
        // Call API with per-item toggle (value = item label)
        await togglePivotGroup({
          pivotId,
          isRow: true,
          fieldIndex,
          value: itemLabel,
        });
        await fetchPivotData();
      } catch (error) {
        console.error('Failed to toggle expand/collapse:', error);
        await fetchPivotData();
      }
    },
    [pivotId, pivotView, onExpandCollapse, fetchPivotData]
  );

  const {
    activeFilterDropdown,
    handleCloseFilterDropdown,
    handleApplyFilter,
    hoveredFilterFieldIndex,
    hoveredIconKey,
    handleCanvasClick,
    handleCanvasMouseMove,
    handleCanvasMouseLeave,
    handleKeyDown,
  } = usePivotGridInteraction({
    pivotId,
    pivotView,
    canvasRef,
    interactiveBounds,
    onExpandCollapse: handleExpandCollapse,
    onRefresh: fetchPivotData,
  });

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pivotView) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas resolution for sharp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    ctx.scale(dpr, dpr);

    // Calculate visible range
    const frozenRowCount = pivotView.columnHeaderRowCount || 0;
    const frozenColCount = pivotView.rowLabelColCount || 0;

    // Calculate visible rows
    let frozenHeight = 0;
    for (let r = 0; r < frozenRowCount && r < rowHeights.length; r++) {
      frozenHeight += rowHeights[r];
    }

    let startRow = frozenRowCount;
    let accumulatedHeight = 0;
    for (let r = frozenRowCount; r < rowHeights.length; r++) {
      if (accumulatedHeight + rowHeights[r] >= scrollPosition.top) {
        startRow = r;
        break;
      }
      accumulatedHeight += rowHeights[r];
    }

    let endRow = startRow;
    accumulatedHeight = 0;
    for (let r = startRow; r < rowHeights.length; r++) {
      endRow = r;
      accumulatedHeight += rowHeights[r];
      if (accumulatedHeight >= canvasSize.height - frozenHeight) {
        break;
      }
    }

    // Calculate visible columns
    let frozenWidth = 0;
    for (let c = 0; c < frozenColCount && c < colWidths.length; c++) {
      frozenWidth += colWidths[c];
    }

    let startCol = frozenColCount;
    let accumulatedWidth = 0;
    for (let c = frozenColCount; c < colWidths.length; c++) {
      if (accumulatedWidth + colWidths[c] >= scrollPosition.left) {
        startCol = c;
        break;
      }
      accumulatedWidth += colWidths[c];
    }

    let endCol = startCol;
    accumulatedWidth = 0;
    for (let c = startCol; c < colWidths.length; c++) {
      endCol = c;
      accumulatedWidth += colWidths[c];
      if (accumulatedWidth >= canvasSize.width - frozenWidth) {
        break;
      }
    }

    // Render
    const renderOptions: PivotRenderOptions = {
      startRow,
      endRow,
      startCol,
      endCol,
      rowHeights,
      colWidths,
      scrollLeft: scrollPosition.left,
      scrollTop: scrollPosition.top,
      frozenRowCount,
      frozenColCount,
      hoveredFilterFieldIndex,
      hoveredIconKey,
    };

    const result = renderPivotView(
      ctx,
      pivotView,
      canvasSize.width,
      canvasSize.height,
      renderOptions,
      theme
    );

    setInteractiveBounds(result.interactiveBounds);
  }, [
    pivotView,
    canvasSize,
    scrollPosition,
    rowHeights,
    colWidths,
    hoveredFilterFieldIndex,
    hoveredIconKey,
    theme,
  ]);

  // ==========================================================================
  // SCROLL HANDLING
  // ==========================================================================

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollPosition({
      left: target.scrollLeft,
      top: target.scrollTop,
    });
  }, []);

  // Calculate total content size for scroll container
  const totalContentSize = useMemo(() => {
    let width = 0;
    let height = 0;

    for (const w of colWidths) {
      width += w;
    }
    for (const h of rowHeights) {
      height += h;
    }

    return { width, height };
  }, [colWidths, rowHeights]);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (isLoading) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#6b7280',
          fontSize: 14,
        }}
      >
        Loading pivot table...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#dc2626',
          fontSize: 14,
        }}
      >
        Error: {error}
      </div>
    );
  }

  if (!pivotView) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#6b7280',
          fontSize: 14,
        }}
      >
        No pivot data available
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...style,
      }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Scroll container */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'auto',
        }}
        onScroll={handleScroll}
      >
        {/* Scroll spacer */}
        <div
          style={{
            width: totalContentSize.width,
            height: totalContentSize.height,
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Canvas layer */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: canvasSize.width,
          height: canvasSize.height,
          pointerEvents: 'auto',
        }}
        onClick={handleCanvasClick}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={handleCanvasMouseLeave}
      />

      {/* Filter Dropdown Overlay */}
      {activeFilterDropdown && (
        <FilterDropdown
          fieldName={activeFilterDropdown.filterRow.fieldName}
          fieldIndex={activeFilterDropdown.fieldIndex}
          uniqueValues={activeFilterDropdown.filterRow.uniqueValues}
          selectedValues={activeFilterDropdown.filterRow.selectedValues}
          anchorRect={activeFilterDropdown.anchorRect}
          onApply={handleApplyFilter}
          onClose={handleCloseFilterDropdown}
        />
      )}
    </div>
  );
};

export default PivotGrid;