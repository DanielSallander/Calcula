//! FILENAME: app/extensions/pivot/rendering/pivot.ts

import type {
  PivotViewResponse,
  PivotCellData,
} from '../lib/pivot-api';
import { getCellDisplayValue } from '../lib/pivot-api';
import {
  buildFreezePaneConfig,
  calculateColumnXWithFreeze,
  calculateRowYWithFreeze,
} from '@api/dimensions';
import type { PivotInteractiveBounds } from '@api/pivotTypes';

// =============================================================================
// TYPES
// =============================================================================

export interface PivotTheme {
  // Text colors
  headerText: string;
  labelText: string;
  valueText: string;
  totalText: string;
  grandTotalText: string;
  filterText: string;

  // Background colors
  headerBackground: string;
  labelBackground: string;
  valueBackground: string;
  totalBackground: string;
  grandTotalBackground: string;
  filterRowBackground: string;

  // Alternating row colors
  alternateRowBackground: string;

  // Borders
  borderColor: string;
  headerBorderColor: string;

  // Filter button
  filterButtonBackground: string;
  filterButtonBorder: string;
  filterButtonHoverBackground: string;
  filterDropdownArrow: string;

  // Expand/collapse icons
  iconColor: string;
  iconHoverColor: string;

  // Selection
  selectionBackground: string;
  selectionBorder: string;

  // Font
  fontFamily: string;
  fontSize: number;
  headerFontSize: number;
  headerFontWeight: string;
}

export const DEFAULT_PIVOT_THEME: PivotTheme = {
  // Text colors — PivotStyleLight16 uses black text throughout
  headerText: '#000000',
  labelText: '#000000',
  valueText: '#000000',
  totalText: '#000000',
  grandTotalText: '#000000',
  filterText: '#000000',

  // Background colors — PivotStyleLight16: light blue header/total, gray banding
  headerBackground: '#C0E6F5',
  labelBackground: '#ffffff',
  valueBackground: '#ffffff',
  totalBackground: '#e8e8e8',
  grandTotalBackground: '#C0E6F5',
  filterRowBackground: '#C0E6F5',

  // Alternating rows — only used when banding is explicitly enabled
  alternateRowBackground: '#ffffff',

  // Borders
  borderColor: '#e8e8e8',
  headerBorderColor: '#C0E6F5',

  // Filter button
  filterButtonBackground: '#C0E6F5',
  filterButtonBorder: '#a0d0e8',
  filterButtonHoverBackground: '#d5eff9',
  filterDropdownArrow: '#000000',

  // Icons
  iconColor: '#6b7280',
  iconHoverColor: '#1f2937',

  // Selection
  selectionBackground: 'rgba(59, 130, 246, 0.1)',
  selectionBorder: '#3b82f6',

  // Font (Calibri is Excel's default; fall back to system fonts)
  fontFamily: 'Calibri, "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
  fontSize: 13,
  headerFontSize: 13,
  headerFontWeight: '700',
};

export interface PivotCellDrawResult {
  iconBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    col: number;
    isExpanded: boolean;
    isRow: boolean;
  } | null;
  filterButtonBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    fieldIndex: number;
    row: number;
    col: number;
  } | null;
  headerFilterBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    zone: 'row' | 'column';
    row: number;
    col: number;
  } | null;
}

// PivotInteractiveBounds is part of the pivot contract — defined once in
// @api/pivotTypes (imported above). Re-exported here for existing importers.
export type { PivotInteractiveBounds };

export interface PivotRenderOptions {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  rowHeights: number[];
  colWidths: number[];
  scrollLeft: number;
  scrollTop: number;
  frozenRowCount: number;
  frozenColCount: number;
  hoveredFilterFieldIndex?: number | null;
  hoveredIconKey?: string | null;
  hoveredHeaderFilterKey?: string | null;
}

export interface PivotRenderResult {
  interactiveBounds: PivotInteractiveBounds;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const EXPAND_ICON_SIZE = 12;
const EXPAND_ICON_PADDING = 4;

const CELL_PADDING_X = 6;
const INDENT_SIZE = 20; // pixels per indent level

/** Margin around the in-cell dropdown arrow button (matches drawPivotCell). */
const ARROW_BUTTON_MARGIN = 3;

// Default cell dimensions for pivot tables
const DEFAULT_PIVOT_CELL_WIDTH = 100;
export const DEFAULT_PIVOT_CELL_HEIGHT = 24;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// NOTE: getPivotBackgroundColor, getPivotTextColor, getFontWeight, getTextAlign
// were removed — cell styling is now handled by the backend via CellStyle.

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  const ellipsis = '...';
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  let truncated = text;

  while (truncated.length > 0 && ctx.measureText(truncated).width + ellipsisWidth > maxWidth) {
    truncated = truncated.slice(0, -1);
  }

  return truncated + ellipsis;
}

// =============================================================================
// DRAWING FUNCTIONS
// =============================================================================

function drawExpandCollapseIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  isCollapsed: boolean,
  theme: PivotTheme,
  isHovered: boolean
): void {
  const color = isHovered ? theme.iconHoverColor : theme.iconColor;
  const size = EXPAND_ICON_SIZE;
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const radius = 2;

  ctx.save();

  // Rounded background
  ctx.fillStyle = isHovered ? '#e5e7eb' : '#f3f4f6';
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, radius);
  ctx.fill();

  // Rounded border
  ctx.strokeStyle = isHovered ? color : '#d1d5db';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, radius);
  ctx.stroke();

  // Draw minus (always present)
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 3, centerY);
  ctx.lineTo(x + size - 3, centerY);
  ctx.stroke();

  // Draw vertical line for plus (collapsed state)
  if (isCollapsed) {
    ctx.beginPath();
    ctx.moveTo(centerX, y + 3);
    ctx.lineTo(centerX, y + size - 3);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draw an Excel-style filter dropdown: a combo box spanning the cell width
 * with a text value on the left and a small dropdown arrow button on the right.
 */
function drawFilterDropdownButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  displayValue: string,
  theme: PivotTheme,
  isHovered: boolean,
  hasActiveFilter: boolean = false
): { buttonBounds: { x: number; y: number; width: number; height: number } } {
  // Arrow button dimensions (matches row/column header filter buttons)
  const btnMargin = 3;
  const btnSize = height - btnMargin * 2;
  const btnX = x + width - btnSize - btnMargin;
  const btnY = y + btnMargin;

  ctx.save();

  // Draw value text (left-aligned, same style as filter label)
  const textX = x + CELL_PADDING_X;
  const textMaxWidth = width - CELL_PADDING_X * 2 - btnSize - btnMargin;
  const textY = y + height / 2;

  ctx.fillStyle = hasActiveFilter ? '#1a73e8' : theme.filterText;
  ctx.font = `400 ${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const truncatedText = truncateText(ctx, displayValue, textMaxWidth);
  ctx.fillText(truncatedText, textX, textY);

  // Draw dropdown arrow button on the right (matches row/column header style)
  if (hasActiveFilter) {
    ctx.fillStyle = isHovered ? '#d0e2f4' : '#e8f0fe';
  } else if (isHovered) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  } else {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  }
  ctx.beginPath();
  ctx.roundRect(btnX, btnY, btnSize, btnSize, 2);
  ctx.fill();

  // Button border
  if (hasActiveFilter) {
    ctx.strokeStyle = isHovered ? '#1565c0' : '#1a73e8';
  } else {
    ctx.strokeStyle = isHovered ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.15)';
  }
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(btnX + 0.5, btnY + 0.5, btnSize - 1, btnSize - 1, 2);
  ctx.stroke();

  // Draw icon centered in the arrow button
  const arrowCx = btnX + btnSize / 2;
  const arrowCy = btnY + btnSize / 2;

  if (hasActiveFilter) {
    // Funnel icon when filter is active
    ctx.fillStyle = '#1a73e8';
    ctx.beginPath();
    ctx.moveTo(arrowCx - 5, arrowCy - 4);
    ctx.lineTo(arrowCx + 5, arrowCy - 4);
    ctx.lineTo(arrowCx + 1, arrowCy);
    ctx.lineTo(arrowCx + 1, arrowCy + 4);
    ctx.lineTo(arrowCx - 1, arrowCy + 4);
    ctx.lineTo(arrowCx - 1, arrowCy);
    ctx.closePath();
    ctx.fill();
  } else {
    // Dropdown triangle (same dimensions as header filter buttons)
    const triSize = 7;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(arrowCx - triSize / 2, arrowCy - triSize / 3);
    ctx.lineTo(arrowCx + triSize / 2, arrowCy - triSize / 3);
    ctx.lineTo(arrowCx, arrowCy + triSize / 2);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();

  // Clickable bounds covers only the arrow button, not the whole cell
  return {
    buttonBounds: { x: btnX, y: btnY, width: btnSize, height: btnSize },
  };
}

// =============================================================================
// THEME-AWARE CELL STYLING HELPERS
// =============================================================================

/** Returns the themed background color for a pivot cell based on its backgroundStyle. */
function getThemedBackground(cell: PivotCellData, theme: PivotTheme): string {
  switch (cell.backgroundStyle) {
    case 'Header':
      return theme.headerBackground;
    case 'Subtotal':
    case 'Total':
      return theme.totalBackground;
    case 'GrandTotal':
      return theme.grandTotalBackground;
    case 'FilterRow':
      return theme.filterRowBackground;
    case 'Alternate':
      return theme.alternateRowBackground;
    case 'Normal':
    default:
      // Use label background for row headers, value background for data cells
      if (cell.cellType === 'RowHeader' || cell.cellType === 'Corner'
        || cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader') {
        return theme.labelBackground;
      }
      return theme.valueBackground;
  }
}

/** Returns themed text color, font, and alignment for a pivot cell. */
function getThemedTextStyle(
  cell: PivotCellData,
  theme: PivotTheme
): { color: string; font: string; align: CanvasTextAlign } {
  // Text color by cell type / background style
  let color: string;
  switch (cell.backgroundStyle) {
    case 'Header':
      color = theme.headerText;
      break;
    case 'GrandTotal':
      color = theme.grandTotalText;
      break;
    case 'Subtotal':
    case 'Total':
      color = theme.totalText;
      break;
    case 'FilterRow':
      color = theme.filterText;
      break;
    default:
      if (cell.cellType === 'RowHeader' || cell.cellType === 'ColumnHeader'
        || cell.cellType === 'Corner' || cell.cellType === 'RowLabelHeader'
        || cell.cellType === 'ColumnLabelHeader') {
        color = theme.labelText;
      } else {
        color = theme.valueText;
      }
  }

  // Bold for headers, totals, expandable items, filter labels, label headers
  const isBold = cell.isBold
    || cell.isExpandable
    || cell.cellType === 'FilterLabel'
    || cell.cellType === 'RowLabelHeader'
    || cell.cellType === 'ColumnLabelHeader'
    || cell.backgroundStyle === 'Header'
    || cell.backgroundStyle === 'Subtotal'
    || cell.backgroundStyle === 'Total'
    || cell.backgroundStyle === 'GrandTotal';

  const weight = isBold ? theme.headerFontWeight : '400';
  const font = `${weight} ${theme.fontSize}px ${theme.fontFamily}`;

  // Alignment: right for data/totals/filter labels, left for everything else
  let align: CanvasTextAlign = 'left';
  switch (cell.cellType) {
    case 'Data':
    case 'RowSubtotal':
    case 'ColumnSubtotal':
    case 'GrandTotal':
    case 'GrandTotalRow':
    case 'GrandTotalColumn':
    case 'FilterLabel':
      align = 'right';
      break;
  }

  return { color, font, align };
}

interface DrawCellOptions {
  isHoveredFilterButton?: boolean;
  isHoveredIcon?: boolean;
  isHoveredHeaderFilter?: boolean;
  hasActiveFilter?: boolean;
  hasActiveFilterDropdown?: boolean;
}

export function drawPivotCell(
  ctx: CanvasRenderingContext2D,
  cell: PivotCellData,
  x: number,
  y: number,
  width: number,
  height: number,
  rowIndex: number,
  colIndex: number,
  theme: PivotTheme,
  options: DrawCellOptions = {}
): PivotCellDrawResult {
  const result: PivotCellDrawResult = {
    iconBounds: null,
    filterButtonBounds: null,
    headerFilterBounds: null,
  };

  // Paint themed background for all cells. The backend writes hardcoded default
  // colors; this overlay pass applies the user-selected pivot table style on top.
  const bgColor = getThemedBackground(cell, theme);
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(x, y, width, height);
  }

  // Paint themed text for cells whose text is rendered by the grid renderer.
  // The overlay redraws the text so it matches the theme colors.
  if (cell.cellType !== 'FilterDropdown' && cell.cellType !== 'Blank') {
    let displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '';

    // Strip bracket notation from BI measure names (e.g. "[TotalSales]" → "TotalSales")
    if (displayText.startsWith('[') && displayText.endsWith(']')) {
      displayText = displayText.substring(1, displayText.length - 1);
    }

    if (displayText) {
      const { color, font, align } = getThemedTextStyle(cell, theme);
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';

      // Reserve space for header filter arrow button
      const hasHeaderFilter = cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader';
      const btnMargin = 3;
      const btnSize = height - btnMargin * 2;
      const rightReserve = hasHeaderFilter ? btnSize + btnMargin + CELL_PADDING_X : 0;

      // Indented row headers: offset text for expand icon + indent
      let textX: number;
      if (align === 'right') {
        textX = x + width - CELL_PADDING_X;
      } else if (cell.cellType === 'RowHeader' && (cell.indentLevel || 0) > 0) {
        const indentPx = (cell.indentLevel || 0) * INDENT_SIZE;
        const iconSpace = cell.isExpandable ? EXPAND_ICON_SIZE + EXPAND_ICON_PADDING : 0;
        textX = x + CELL_PADDING_X + indentPx + iconSpace;
      } else if (cell.cellType === 'RowHeader' && cell.isExpandable) {
        textX = x + CELL_PADDING_X + EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
      } else {
        textX = x + CELL_PADDING_X;
      }

      // Truncate text to avoid collision with header filter arrow
      if (hasHeaderFilter) {
        const maxWidth = width - CELL_PADDING_X - rightReserve;
        displayText = truncateText(ctx, displayText, maxWidth);
      }

      ctx.fillText(displayText, textX, y + height / 2);
    }
  }

  // FilterLabel — background and text already drawn above, no interactive chrome
  if (cell.cellType === 'FilterLabel') {
    return result;
  }

  // FilterDropdown — draw text + arrow button on top of themed background
  if (cell.cellType === 'FilterDropdown') {

    const displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '(All)';
    const buttonResult = drawFilterDropdownButton(
      ctx,
      x,
      y,
      width,
      height,
      displayText,
      theme,
      options.isHoveredFilterButton || false,
      options.hasActiveFilterDropdown || false
    );

    result.filterButtonBounds = {
      ...buttonResult.buttonBounds,
      fieldIndex: cell.filterFieldIndex ?? -1,
      row: rowIndex,
      col: colIndex,
    };

    return result;
  }

  // RowLabelHeader / ColumnLabelHeader — draw only the dropdown button overlay
  if (cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader') {
    const zone: 'row' | 'column' = cell.cellType === 'RowLabelHeader' ? 'row' : 'column';

    // Draw dropdown button on the right side of the cell
    const isHovered = options.isHoveredHeaderFilter || false;
    const hasFilter = options.hasActiveFilter || false;
    const btnMargin = 3;
    const btnSize = height - btnMargin * 2;
    const btnX = x + width - btnSize - btnMargin;
    const btnY = y + btnMargin;

    // Button background - blue tint when filter is active
    if (hasFilter) {
      ctx.fillStyle = isHovered ? '#d0e2f4' : '#e8f0fe';
    } else if (isHovered) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    } else {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    }
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnSize, btnSize, 2);
    ctx.fill();

    // Button border - blue when filter is active
    if (hasFilter) {
      ctx.strokeStyle = isHovered ? '#1565c0' : '#1a73e8';
    } else {
      ctx.strokeStyle = isHovered ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.15)';
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(btnX + 0.5, btnY + 0.5, btnSize - 1, btnSize - 1, 2);
    ctx.stroke();

    // Draw icon: funnel when filter active, dropdown arrow otherwise
    const iconCx = btnX + btnSize / 2;
    const iconCy = btnY + btnSize / 2;

    if (hasFilter) {
      // Funnel icon (matching AutoFilter style)
      ctx.fillStyle = '#1a73e8';
      ctx.beginPath();
      ctx.moveTo(iconCx - 5, iconCy - 4);
      ctx.lineTo(iconCx + 5, iconCy - 4);
      ctx.lineTo(iconCx + 1, iconCy);
      ctx.lineTo(iconCx + 1, iconCy + 4);
      ctx.lineTo(iconCx - 1, iconCy + 4);
      ctx.lineTo(iconCx - 1, iconCy);
      ctx.closePath();
      ctx.fill();
    } else {
      // Dropdown triangle
      const triSize = 7;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(iconCx - triSize / 2, iconCy - triSize / 3);
      ctx.lineTo(iconCx + triSize / 2, iconCy - triSize / 3);
      ctx.lineTo(iconCx, iconCy + triSize / 2);
      ctx.closePath();
      ctx.fill();
    }

    result.headerFilterBounds = {
      x: btnX,
      y: btnY,
      width: btnSize,
      height: btnSize,
      zone,
      row: rowIndex,
      col: colIndex,
    };

    return result;
  }

  // Expand/collapse icons for row headers
  if (cell.cellType === 'RowHeader' && cell.isExpandable) {
    const iconX = x + CELL_PADDING_X + (cell.indentLevel || 0) * INDENT_SIZE;
    const iconY = y + (height - EXPAND_ICON_SIZE) / 2;

    drawExpandCollapseIcon(
      ctx,
      iconX,
      iconY,
      cell.isCollapsed ?? false,
      theme,
      options.isHoveredIcon || false
    );

    result.iconBounds = {
      x: iconX,
      y: iconY,
      width: EXPAND_ICON_SIZE,
      height: EXPAND_ICON_SIZE,
      row: rowIndex,
      col: colIndex,
      isExpanded: !cell.isCollapsed,
      isRow: true,
    };

    return result;
  }

  // Expand/collapse icons for column headers
  if (cell.cellType === 'ColumnHeader' && cell.isExpandable) {
    const iconX = x + CELL_PADDING_X;
    const iconY = y + (height - EXPAND_ICON_SIZE) / 2;

    drawExpandCollapseIcon(
      ctx,
      iconX,
      iconY,
      cell.isCollapsed ?? false,
      theme,
      options.isHoveredIcon || false
    );

    result.iconBounds = {
      x: iconX,
      y: iconY,
      width: EXPAND_ICON_SIZE,
      height: EXPAND_ICON_SIZE,
      row: rowIndex,
      col: colIndex,
      isExpanded: !cell.isCollapsed,
      isRow: false,
    };

    return result;
  }

  // All other cells (Data, Corner, Blank, etc.) — no interactive chrome needed
  return result;
}

// =============================================================================
// MAIN RENDER FUNCTION
// =============================================================================

export function renderPivotView(
  ctx: CanvasRenderingContext2D,
  pivotView: PivotViewResponse,
  canvasWidth: number,
  canvasHeight: number,
  options: PivotRenderOptions,
  theme: PivotTheme = DEFAULT_PIVOT_THEME
): PivotRenderResult {
  const interactiveBounds: PivotInteractiveBounds = {
    expandCollapseIcons: new Map(),
    filterButtons: new Map(),
    headerFilterButtons: new Map(),
  };

  const {
    startRow,
    endRow,
    startCol,
    endCol,
    rowHeights,
    colWidths,
    scrollLeft,
    scrollTop,
    frozenRowCount,
    frozenColCount,
    hoveredFilterFieldIndex,
    hoveredIconKey,
    hoveredHeaderFilterKey,
  } = options;

  // Clear canvas
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Build dimension configuration using shared utility
  const positionConfig = buildFreezePaneConfig({
    colWidths,
    rowHeights,
    defaultCellWidth: DEFAULT_PIVOT_CELL_WIDTH,
    defaultCellHeight: DEFAULT_PIVOT_CELL_HEIGHT,
    scrollX: scrollLeft,
    scrollY: scrollTop,
    frozenColCount,
    frozenRowCount,
  });

  // Extract pre-calculated frozen dimensions for clipping regions
  const { frozenWidth, frozenHeight } = positionConfig;

  // Helper to get Y position for a row using shared utility
  const getRowY = (rowIndex: number): number => {
    return calculateRowYWithFreeze(rowIndex, positionConfig);
  };

  // Helper to get X position for a column using shared utility
  const getColX = (colIndex: number): number => {
    return calculateColumnXWithFreeze(colIndex, positionConfig);
  };

  // Pre-compute whether each zone has active filters
  const rowHasActiveFilter = pivotView.rowFieldSummaries?.some(f => f.hasActiveFilter) ?? false;
  const colHasActiveFilter = pivotView.columnFieldSummaries?.some(f => f.hasActiveFilter) ?? false;

  // Render cells in four quadrants:
  // 1. Frozen corner (top-left)
  // 2. Frozen top (scrolls horizontally)
  // 3. Frozen left (scrolls vertically)
  // 4. Main area (scrolls both ways)

  const renderCell = (rowIndex: number, colIndex: number): void => {
    if (rowIndex >= pivotView.rows.length) return;
    const row = pivotView.rows[rowIndex];
    if (colIndex >= row.cells.length) return;
    const cell = row.cells[colIndex];

    const x = getColX(colIndex);
    const y = getRowY(rowIndex);
    // Support col_span: sum widths of spanned columns (e.g., FilterDropdown spanning row label cols)
    const span = cell.colSpan && cell.colSpan > 1 ? cell.colSpan : 1;
    let width = colWidths[colIndex] || DEFAULT_PIVOT_CELL_WIDTH;
    for (let s = 1; s < span && colIndex + s < colWidths.length; s++) {
      width += colWidths[colIndex + s] || DEFAULT_PIVOT_CELL_WIDTH;
    }
    const height = rowHeights[rowIndex] || DEFAULT_PIVOT_CELL_HEIGHT;

    // Skip cells outside visible area
    if (x + width < 0 || x > canvasWidth || y + height < 0 || y > canvasHeight) {
      return;
    }

    const cellKey = `${rowIndex}-${colIndex}`;
    const isHoveredFilter = cell.filterFieldIndex !== undefined &&
      cell.filterFieldIndex === hoveredFilterFieldIndex;
    const isHoveredIcon = hoveredIconKey === cellKey;
    const isHoveredHeaderFilter = hoveredHeaderFilterKey === cellKey;

    // Determine active filter state for header filter cells
    const cellHasActiveFilter =
      cell.cellType === 'RowLabelHeader' ? rowHasActiveFilter :
      cell.cellType === 'ColumnLabelHeader' ? colHasActiveFilter :
      false;

    // Determine active filter state for filter dropdown cells
    let cellHasActiveFilterDropdown = false;
    if (cell.cellType === 'FilterDropdown' && cell.filterFieldIndex !== undefined) {
      const filterRowMeta = pivotView.filterRows?.find(
        (fr) => fr.fieldIndex === cell.filterFieldIndex
      );
      cellHasActiveFilterDropdown = filterRowMeta
        ? filterRowMeta.selectedValues.length < filterRowMeta.uniqueValues.length
        : false;
    }

    const cellResult = drawPivotCell(
      ctx,
      cell,
      x,
      y,
      width,
      height,
      rowIndex,
      colIndex,
      theme,
      {
        isHoveredFilterButton: isHoveredFilter,
        isHoveredIcon,
        isHoveredHeaderFilter,
        hasActiveFilter: cellHasActiveFilter,
        hasActiveFilterDropdown: cellHasActiveFilterDropdown,
      }
    );

    // Store interactive bounds
    if (cellResult.iconBounds) {
      interactiveBounds.expandCollapseIcons.set(cellKey, cellResult.iconBounds);
    }

    if (cellResult.filterButtonBounds) {
      const filterKey = `filter-${cell.filterFieldIndex}`;
      interactiveBounds.filterButtons.set(filterKey, cellResult.filterButtonBounds);
    }

    if (cellResult.headerFilterBounds) {
      interactiveBounds.headerFilterButtons.set(cellKey, cellResult.headerFilterBounds);
    }
  };

  // Render main scrollable area first (bottom-right)
  ctx.save();
  ctx.beginPath();
  ctx.rect(frozenWidth, frozenHeight, canvasWidth - frozenWidth, canvasHeight - frozenHeight);
  ctx.clip();

  for (let r = Math.max(startRow, frozenRowCount); r <= endRow && r < pivotView.rows.length; r++) {
    for (let c = Math.max(startCol, frozenColCount); c <= endCol; c++) {
      renderCell(r, c);
    }
  }
  ctx.restore();

  // Render frozen left column (scrolls vertically)
  if (frozenColCount > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, frozenHeight, frozenWidth, canvasHeight - frozenHeight);
    ctx.clip();

    for (let r = Math.max(startRow, frozenRowCount); r <= endRow && r < pivotView.rows.length; r++) {
      for (let c = 0; c < frozenColCount; c++) {
        renderCell(r, c);
      }
    }
    ctx.restore();
  }

  // Render frozen top rows (scrolls horizontally)
  if (frozenRowCount > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(frozenWidth, 0, canvasWidth - frozenWidth, frozenHeight);
    ctx.clip();

    for (let r = 0; r < frozenRowCount && r < pivotView.rows.length; r++) {
      for (let c = Math.max(startCol, frozenColCount); c <= endCol; c++) {
        renderCell(r, c);
      }
    }
    ctx.restore();
  }

  // Render frozen corner (top-left, never scrolls)
  if (frozenRowCount > 0 && frozenColCount > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, frozenWidth, frozenHeight);
    ctx.clip();

    for (let r = 0; r < frozenRowCount && r < pivotView.rows.length; r++) {
      for (let c = 0; c < frozenColCount; c++) {
        renderCell(r, c);
      }
    }
    ctx.restore();
  }

  // Draw separator lines between frozen and scrollable areas
  // (drawn last so they overlay cell content at the boundaries)
  if (frozenColCount > 0 && frozenWidth > 0) {
    ctx.save();
    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.floor(frozenWidth) + 0.5, 0);
    ctx.lineTo(Math.floor(frozenWidth) + 0.5, canvasHeight);
    ctx.stroke();
    ctx.restore();
  }

  if (frozenRowCount > 0 && frozenHeight > 0) {
    ctx.save();
    ctx.strokeStyle = theme.headerBorderColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(frozenHeight) - 0.5);
    ctx.lineTo(canvasWidth, Math.floor(frozenHeight) - 0.5);
    ctx.stroke();
    ctx.restore();
  }

  return { interactiveBounds };
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

export function createPivotTheme(overrides: Partial<PivotTheme> = {}): PivotTheme {
  return { ...DEFAULT_PIVOT_THEME, ...overrides };
}

/**
 * Row access abstraction for column measurement. Non-windowed views expose
 * view.rows directly; windowed views answer from the cell-window cache (rows
 * not yet fetched return null and are covered by maxContentSample).
 */
export interface PivotColumnMeasureSource {
  /** Total number of view rows (windowed: totalRowCount). */
  rowCount: number;
  /** Row data for view row i, or null when not synchronously available. */
  getRow: (i: number) => PivotViewResponse['rows'][number] | null;
  /**
   * View row indices that have cells available synchronously. When provided,
   * only these are scanned (windowed pivots hold a few 200-row windows out
   * of potentially a million rows); omitted means 0..rowCount-1.
   */
  availableRowIndices?: () => Iterable<number>;
  /** Backend-computed widest display string for this column, if any. */
  maxContentSample?: string;
  /** Pixel height of view row i — sizes the in-cell arrow buttons. */
  getRowHeight?: (i: number) => number;
}

/**
 * Required pixel width to fully display one pivot cell, mirroring the exact
 * metrics drawPivotCell / drawFilterDropdownButton use: themed font (bold for
 * headers/totals), CELL_PADDING_X on both sides, indent + expand icon for row
 * headers, and the in-cell dropdown arrow button on label headers and filter
 * combos. Returns null for cells that must not drive the column width
 * (empty, or spanning multiple columns).
 */
export function measurePivotCellRequiredWidth(
  ctx: CanvasRenderingContext2D,
  cell: PivotCellData,
  theme: PivotTheme,
  rowHeight: number = DEFAULT_PIVOT_CELL_HEIGHT
): number | null {
  // Cells spanning multiple columns never drive a single column's width
  if (cell.colSpan !== undefined && cell.colSpan > 1) {
    return null;
  }

  const btnSize = Math.max(0, rowHeight - ARROW_BUTTON_MARGIN * 2);
  const rawText = cell.formattedValue || getCellDisplayValue(cell.value) || '';

  if (cell.cellType === 'FilterDropdown') {
    // drawFilterDropdownButton: raw text at weight 400 (no bracket
    // stripping), arrow button on the right; empty renders as "(All)"
    ctx.font = `400 ${theme.fontSize}px ${theme.fontFamily}`;
    const textWidth = ctx.measureText(rawText || '(All)').width;
    return textWidth + CELL_PADDING_X * 2 + btnSize + ARROW_BUTTON_MARGIN;
  }

  // Strip bracket notation from BI measure names (mirrors drawPivotCell)
  let displayText = rawText;
  if (displayText.startsWith('[') && displayText.endsWith(']')) {
    displayText = displayText.substring(1, displayText.length - 1);
  }

  if (!displayText) {
    return null;
  }

  const { font } = getThemedTextStyle(cell, theme);
  ctx.font = font;
  const textWidth = ctx.measureText(displayText).width;
  let totalWidth = textWidth + CELL_PADDING_X * 2;

  // Row headers: indent + expand/collapse icon shift the text right
  // (drawPivotCell offsets text only for RowHeader cells)
  if (cell.cellType === 'RowHeader') {
    totalWidth += (cell.indentLevel || 0) * INDENT_SIZE;
    if (cell.isExpandable) {
      totalWidth += EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
    }
  }

  // Label headers reserve the dropdown arrow button on the right
  if (cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader') {
    totalWidth += btnSize + ARROW_BUTTON_MARGIN;
  }

  return totalWidth;
}

/**
 * Required pixel width for a whole pivot column: the max cell requirement
 * over all synchronously available rows, combined with the backend's
 * maxContentSample (which covers rows a windowed view has not fetched).
 * Returns null when the column has no measurable content.
 */
export function measurePivotColumnRequiredWidth(
  ctx: CanvasRenderingContext2D,
  source: PivotColumnMeasureSource,
  colIndex: number,
  theme: PivotTheme
): number | null {
  let required: number | null = null;

  const indices =
    source.availableRowIndices?.() ??
    Array.from({ length: source.rowCount }, (_, i) => i);

  for (const i of indices) {
    if (i >= source.rowCount) continue;
    const row = source.getRow(i);
    if (!row || !row.cells || colIndex >= row.cells.length) continue;
    if (row.visible === false) continue;

    const rowHeight = source.getRowHeight?.(i) ?? DEFAULT_PIVOT_CELL_HEIGHT;
    const cellWidth = measurePivotCellRequiredWidth(ctx, row.cells[colIndex], theme, rowHeight);
    if (cellWidth !== null && (required === null || cellWidth > required)) {
      required = cellWidth;
    }
  }

  // The sample is the widest display string across ALL rows (indent
  // approximated as leading spaces) — measure bold since it can come from a
  // header/total row; chrome-bearing cells are covered by the scan above.
  if (source.maxContentSample) {
    ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;
    const sampleWidth =
      ctx.measureText(source.maxContentSample).width + CELL_PADDING_X * 2;
    if (required === null || sampleWidth > required) {
      required = sampleWidth;
    }
  }

  return required;
}

export function measurePivotColumnWidth(
  ctx: CanvasRenderingContext2D,
  pivotView: PivotViewResponse,
  colIndex: number,
  theme: PivotTheme = DEFAULT_PIVOT_THEME,
  minWidth: number = 60,
  maxWidth: number = 300,
  rowHeight: number = DEFAULT_PIVOT_CELL_HEIGHT
): number {
  const source: PivotColumnMeasureSource = {
    rowCount: pivotView.rows.length,
    getRow: (i) => pivotView.rows[i] ?? null,
    maxContentSample: pivotView.columns?.[colIndex]?.maxContentSample,
    getRowHeight: () => rowHeight,
  };

  const required = measurePivotColumnRequiredWidth(ctx, source, colIndex, theme);
  return Math.min(Math.max(minWidth, Math.ceil(required ?? minWidth)), maxWidth);
}