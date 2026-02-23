//! FILENAME: app/extensions/Tablix/rendering/tablix.ts
// PURPOSE: Canvas rendering engine for the Tablix component.
// CONTEXT: Renders tablix views with cell spanning, detail rows, and group headers.

import type {
  TablixViewResponse,
  TablixCellData,
  TablixCellType,
  TablixBackgroundStyle,
} from '../lib/tablix-api';
import { getCellDisplayValue } from '../lib/tablix-api';
import {
  buildFreezePaneConfig,
  calculateColumnXWithFreeze,
  calculateRowYWithFreeze,
} from '../../../src/api/dimensions';

// =============================================================================
// TYPES
// =============================================================================

export interface TablixTheme {
  // Text colors
  headerText: string;
  labelText: string;
  valueText: string;
  detailText: string;
  totalText: string;
  grandTotalText: string;
  filterText: string;

  // Background colors
  headerBackground: string;
  labelBackground: string;
  valueBackground: string;
  detailBackground: string;
  detailAlternateBackground: string;
  totalBackground: string;
  grandTotalBackground: string;
  filterRowBackground: string;

  // Alternating row colors
  alternateRowBackground: string;

  // Borders
  borderColor: string;
  headerBorderColor: string;
  groupBorderColor: string;

  // Filter button
  filterButtonBackground: string;
  filterButtonBorder: string;
  filterButtonHoverBackground: string;
  filterDropdownArrow: string;

  // Expand/collapse icons
  iconColor: string;
  iconHoverColor: string;

  // Font
  fontFamily: string;
  fontSize: number;
  headerFontSize: number;
  headerFontWeight: string;
}

export const DEFAULT_TABLIX_THEME: TablixTheme = {
  // Text colors
  headerText: '#1f2937',
  labelText: '#374151',
  valueText: '#111827',
  detailText: '#4b5563',
  totalText: '#1f2937',
  grandTotalText: '#1f2937',
  filterText: '#374151',

  // Background colors
  headerBackground: '#f3f4f6',
  labelBackground: '#f9fafb',
  valueBackground: '#ffffff',
  detailBackground: '#fefefe',
  detailAlternateBackground: '#f8fafc',
  totalBackground: '#e5e7eb',
  grandTotalBackground: '#d1d5db',
  filterRowBackground: '#fef3c7',

  // Alternating
  alternateRowBackground: '#f9fafb',

  // Borders
  borderColor: '#e5e7eb',
  headerBorderColor: '#d1d5db',
  groupBorderColor: '#cbd5e1',

  // Filter button
  filterButtonBackground: '#ffffff',
  filterButtonBorder: '#d1d5db',
  filterButtonHoverBackground: '#f3f4f6',
  filterDropdownArrow: '#6b7280',

  // Icons
  iconColor: '#6b7280',
  iconHoverColor: '#374151',

  // Font
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  headerFontSize: 13,
  headerFontWeight: '600',
};

export interface TablixCellDrawResult {
  iconBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    col: number;
    isExpanded: boolean;
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
}

export interface TablixInteractiveBounds {
  expandCollapseIcons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    col: number;
    isExpanded: boolean;
  }>;
  filterButtons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    fieldIndex: number;
    row: number;
    col: number;
  }>;
}

export interface TablixRenderOptions {
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
}

export interface TablixRenderResult {
  interactiveBounds: TablixInteractiveBounds;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const FILTER_BUTTON_HEIGHT = 20;
const FILTER_BUTTON_MIN_WIDTH = 80;
const FILTER_BUTTON_MAX_WIDTH = 150;
const FILTER_ARROW_SIZE = 6;
const FILTER_BUTTON_PADDING = 6;

const EXPAND_ICON_SIZE = 12;
const EXPAND_ICON_PADDING = 4;

const CELL_PADDING_X = 6;

const DEFAULT_TABLIX_CELL_WIDTH = 100;
const DEFAULT_TABLIX_CELL_HEIGHT = 24;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getTablixBackgroundColor(
  backgroundStyle: TablixBackgroundStyle | undefined,
  theme: TablixTheme,
  rowIndex: number
): string {
  switch (backgroundStyle) {
    case 'header':
      return theme.headerBackground;
    case 'normal':
      return rowIndex % 2 === 0 ? theme.valueBackground : theme.alternateRowBackground;
    case 'alternate':
      return theme.alternateRowBackground;
    case 'subtotal':
    case 'total':
      return theme.totalBackground;
    case 'grandTotal':
      return theme.grandTotalBackground;
    case 'filterRow':
      return theme.filterRowBackground;
    case 'detailRow':
      return theme.detailBackground;
    case 'detailRowAlternate':
      return theme.detailAlternateBackground;
    default:
      return theme.valueBackground;
  }
}

function getTablixTextColor(
  cellType: TablixCellType | undefined,
  backgroundStyle: TablixBackgroundStyle | undefined,
  theme: TablixTheme
): string {
  if (cellType === 'filterLabel' || cellType === 'filterDropdown') {
    return theme.filterText;
  }

  if (cellType === 'detailData') {
    return theme.detailText;
  }

  switch (backgroundStyle) {
    case 'header':
      return theme.headerText;
    case 'subtotal':
    case 'total':
      return theme.totalText;
    case 'grandTotal':
      return theme.grandTotalText;
    default:
      return theme.valueText;
  }
}

function getTablixFontWeight(
  cellType: TablixCellType | undefined,
  backgroundStyle: TablixBackgroundStyle | undefined
): string {
  if (
    backgroundStyle === 'header' ||
    backgroundStyle === 'subtotal' ||
    backgroundStyle === 'total' ||
    backgroundStyle === 'grandTotal' ||
    cellType === 'filterLabel'
  ) {
    return '600';
  }
  return '400';
}

function getTablixTextAlign(
  cellType: TablixCellType | undefined
): CanvasTextAlign {
  if (
    cellType === 'aggregatedData' ||
    cellType === 'rowSubtotal' ||
    cellType === 'columnSubtotal' ||
    cellType === 'grandTotal' ||
    cellType === 'grandTotalRow' ||
    cellType === 'grandTotalColumn'
  ) {
    return 'right';
  }
  // Detail data is left-aligned
  return 'left';
}

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
// SPANNING HELPERS
// =============================================================================

/**
 * Calculate the combined height for a cell that spans multiple rows.
 */
function getSpannedHeight(
  rowIndex: number,
  rowSpan: number,
  rowHeights: number[]
): number {
  let totalHeight = 0;
  for (let i = 0; i < rowSpan && (rowIndex + i) < rowHeights.length; i++) {
    totalHeight += rowHeights[rowIndex + i] || DEFAULT_TABLIX_CELL_HEIGHT;
  }
  return totalHeight;
}

/**
 * Calculate the combined width for a cell that spans multiple columns.
 */
function getSpannedWidth(
  colIndex: number,
  colSpan: number,
  colWidths: number[]
): number {
  let totalWidth = 0;
  for (let i = 0; i < colSpan && (colIndex + i) < colWidths.length; i++) {
    totalWidth += colWidths[colIndex + i] || DEFAULT_TABLIX_CELL_WIDTH;
  }
  return totalWidth;
}

// =============================================================================
// DRAWING FUNCTIONS
// =============================================================================

function drawExpandCollapseIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  isCollapsed: boolean,
  theme: TablixTheme,
  isHovered: boolean
): void {
  const color = isHovered ? theme.iconHoverColor : theme.iconColor;
  const size = EXPAND_ICON_SIZE;
  const centerX = x + size / 2;
  const centerY = y + size / 2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  // Draw box
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);

  // Draw minus
  ctx.beginPath();
  ctx.moveTo(x + 3, centerY);
  ctx.lineTo(x + size - 3, centerY);
  ctx.stroke();

  // Draw vertical line for plus (collapsed)
  if (isCollapsed) {
    ctx.beginPath();
    ctx.moveTo(centerX, y + 3);
    ctx.lineTo(centerX, y + size - 3);
    ctx.stroke();
  }

  ctx.restore();
}

function drawFilterDropdownButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  displayValue: string,
  theme: TablixTheme,
  isHovered: boolean
): { buttonBounds: { x: number; y: number; width: number; height: number } } {
  const buttonWidth = Math.max(FILTER_BUTTON_MIN_WIDTH, Math.min(width, FILTER_BUTTON_MAX_WIDTH));

  ctx.save();

  ctx.fillStyle = isHovered ? theme.filterButtonHoverBackground : theme.filterButtonBackground;
  ctx.fillRect(x, y, buttonWidth, height);

  ctx.strokeStyle = theme.filterButtonBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, buttonWidth - 1, height - 1);

  const textX = x + FILTER_BUTTON_PADDING;
  const textMaxWidth = buttonWidth - FILTER_BUTTON_PADDING * 2 - FILTER_ARROW_SIZE - 4;
  const textY = y + height / 2;

  ctx.fillStyle = theme.filterText;
  ctx.font = `400 ${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const truncatedText = truncateText(ctx, displayValue, textMaxWidth);
  ctx.fillText(truncatedText, textX, textY);

  // Draw dropdown arrow
  const arrowX = x + buttonWidth - FILTER_BUTTON_PADDING - FILTER_ARROW_SIZE / 2;
  const arrowY = y + height / 2;

  ctx.fillStyle = theme.filterDropdownArrow;
  ctx.beginPath();
  ctx.moveTo(arrowX - FILTER_ARROW_SIZE / 2, arrowY - FILTER_ARROW_SIZE / 3);
  ctx.lineTo(arrowX + FILTER_ARROW_SIZE / 2, arrowY - FILTER_ARROW_SIZE / 3);
  ctx.lineTo(arrowX, arrowY + FILTER_ARROW_SIZE / 2);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  return {
    buttonBounds: { x, y, width: buttonWidth, height },
  };
}

interface DrawCellOptions {
  isHoveredFilterButton?: boolean;
  isHoveredIcon?: boolean;
}

function drawTablixCell(
  ctx: CanvasRenderingContext2D,
  cell: TablixCellData,
  x: number,
  y: number,
  width: number,
  height: number,
  rowIndex: number,
  colIndex: number,
  theme: TablixTheme,
  options: DrawCellOptions = {}
): TablixCellDrawResult {
  const result: TablixCellDrawResult = {
    iconBounds: null,
    filterButtonBounds: null,
  };

  // Skip spanned cells (covered by another cell's span)
  if (cell.isSpanned) {
    return result;
  }

  // Draw background
  const bgColor = getTablixBackgroundColor(cell.backgroundStyle, theme, rowIndex);
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, width, height);

  // Draw border - use group border color for group header boundaries
  const isGroupHeader = cell.cellType === 'rowGroupHeader' || cell.cellType === 'columnGroupHeader';
  ctx.strokeStyle = isGroupHeader ? theme.groupBorderColor : theme.borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  // Handle FilterLabel
  if (cell.cellType === 'filterLabel') {
    const displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '';
    if (displayText) {
      ctx.fillStyle = theme.filterText;
      ctx.font = `600 ${theme.fontSize}px ${theme.fontFamily}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const textX = x + width - CELL_PADDING_X;
      const textY = y + height / 2;
      const truncatedText = truncateText(ctx, displayText, width - CELL_PADDING_X * 2);
      ctx.fillText(truncatedText, textX, textY);
    }
    return result;
  }

  // Handle FilterDropdown
  if (cell.cellType === 'filterDropdown') {
    const buttonY = y + Math.floor((height - FILTER_BUTTON_HEIGHT) / 2);
    const displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '(All)';
    const buttonResult = drawFilterDropdownButton(
      ctx,
      x + CELL_PADDING_X,
      buttonY,
      width - CELL_PADDING_X * 2,
      FILTER_BUTTON_HEIGHT,
      displayText,
      theme,
      options.isHoveredFilterButton || false
    );

    result.filterButtonBounds = {
      ...buttonResult.buttonBounds,
      x: x + CELL_PADDING_X,
      y: buttonY,
      fieldIndex: cell.filterFieldIndex ?? -1,
      row: rowIndex,
      col: colIndex,
    };

    return result;
  }

  // Calculate text position
  let textX = x + CELL_PADDING_X;
  let textMaxWidth = width - CELL_PADDING_X * 2;

  // Handle expand/collapse icon for row group headers
  if (cell.cellType === 'rowGroupHeader' && cell.isExpandable) {
    const iconX = x + CELL_PADDING_X + (cell.indentLevel || 0) * 16;
    const iconY = y + (height - EXPAND_ICON_SIZE) / 2;

    drawExpandCollapseIcon(
      ctx,
      iconX,
      iconY,
      cell.isCollapsed,
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
    };

    textX = iconX + EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
    textMaxWidth = width - (textX - x) - CELL_PADDING_X;
  } else if (cell.indentLevel && cell.indentLevel > 0) {
    textX += cell.indentLevel * 16;
    textMaxWidth -= cell.indentLevel * 16;
  }

  // Draw text
  const displayText = cell.formattedValue || getCellDisplayValue(cell.value);
  if (displayText) {
    const textColor = getTablixTextColor(cell.cellType, cell.backgroundStyle, theme);
    const fontWeight = getTablixFontWeight(cell.cellType, cell.backgroundStyle);
    const textAlign = getTablixTextAlign(cell.cellType);

    ctx.fillStyle = textColor;
    ctx.font = `${fontWeight} ${theme.fontSize}px ${theme.fontFamily}`;
    ctx.textAlign = textAlign;
    ctx.textBaseline = 'middle';

    const textY = y + height / 2;

    if (textAlign === 'right') {
      const rightX = x + width - CELL_PADDING_X;
      const truncatedDisplayText = truncateText(ctx, displayText, textMaxWidth);
      ctx.fillText(truncatedDisplayText, rightX, textY);
    } else {
      const truncatedDisplayText = truncateText(ctx, displayText, textMaxWidth);
      ctx.fillText(truncatedDisplayText, textX, textY);
    }
  }

  return result;
}

// =============================================================================
// MAIN RENDER FUNCTION
// =============================================================================

export function renderTablixView(
  ctx: CanvasRenderingContext2D,
  tablixView: TablixViewResponse,
  canvasWidth: number,
  canvasHeight: number,
  options: TablixRenderOptions,
  theme: TablixTheme = DEFAULT_TABLIX_THEME
): TablixRenderResult {
  const interactiveBounds: TablixInteractiveBounds = {
    expandCollapseIcons: new Map(),
    filterButtons: new Map(),
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
  } = options;

  // Clear canvas
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Build dimension configuration using shared utility
  const positionConfig = buildFreezePaneConfig({
    colWidths,
    rowHeights,
    defaultCellWidth: DEFAULT_TABLIX_CELL_WIDTH,
    defaultCellHeight: DEFAULT_TABLIX_CELL_HEIGHT,
    scrollX: scrollLeft,
    scrollY: scrollTop,
    frozenColCount,
    frozenRowCount,
  });

  const { frozenWidth, frozenHeight } = positionConfig;

  const getRowY = (rowIndex: number): number => {
    return calculateRowYWithFreeze(rowIndex, positionConfig);
  };

  const getColX = (colIndex: number): number => {
    return calculateColumnXWithFreeze(colIndex, positionConfig);
  };

  // Render a single cell, handling spanning
  const renderCell = (rowIndex: number, colIndex: number): void => {
    if (rowIndex >= tablixView.rows.length) return;
    const row = tablixView.rows[rowIndex];
    if (colIndex >= row.cells.length) return;
    const cell = row.cells[colIndex];

    // Skip spanned cells early
    if (cell.isSpanned) return;

    const x = getColX(colIndex);
    const y = getRowY(rowIndex);

    // Calculate dimensions accounting for spanning
    const cellRowSpan = cell.rowSpan || 1;
    const cellColSpan = cell.colSpan || 1;
    const width = cellColSpan > 1
      ? getSpannedWidth(colIndex, cellColSpan, colWidths)
      : (colWidths[colIndex] || DEFAULT_TABLIX_CELL_WIDTH);
    const height = cellRowSpan > 1
      ? getSpannedHeight(rowIndex, cellRowSpan, rowHeights)
      : (rowHeights[rowIndex] || DEFAULT_TABLIX_CELL_HEIGHT);

    // Skip cells outside visible area
    if (x + width < 0 || x > canvasWidth || y + height < 0 || y > canvasHeight) {
      return;
    }

    const cellKey = `${rowIndex}-${colIndex}`;
    const isHoveredFilter = cell.filterFieldIndex !== undefined &&
      cell.filterFieldIndex === hoveredFilterFieldIndex;
    const isHoveredIcon = hoveredIconKey === cellKey;

    const cellResult = drawTablixCell(
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
      }
    );

    if (cellResult.iconBounds) {
      interactiveBounds.expandCollapseIcons.set(cellKey, cellResult.iconBounds);
    }

    if (cellResult.filterButtonBounds) {
      const filterKey = `filter-${cell.filterFieldIndex}`;
      interactiveBounds.filterButtons.set(filterKey, cellResult.filterButtonBounds);
    }
  };

  // Render main scrollable area (bottom-right)
  ctx.save();
  ctx.beginPath();
  ctx.rect(frozenWidth, frozenHeight, canvasWidth - frozenWidth, canvasHeight - frozenHeight);
  ctx.clip();

  for (let r = Math.max(startRow, frozenRowCount); r <= endRow && r < tablixView.rows.length; r++) {
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

    for (let r = Math.max(startRow, frozenRowCount); r <= endRow && r < tablixView.rows.length; r++) {
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

    for (let r = 0; r < frozenRowCount && r < tablixView.rows.length; r++) {
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

    for (let r = 0; r < frozenRowCount && r < tablixView.rows.length; r++) {
      for (let c = 0; c < frozenColCount; c++) {
        renderCell(r, c);
      }
    }
    ctx.restore();
  }

  return { interactiveBounds };
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

export function createTablixTheme(overrides: Partial<TablixTheme> = {}): TablixTheme {
  return { ...DEFAULT_TABLIX_THEME, ...overrides };
}

export function measureTablixColumnWidth(
  ctx: CanvasRenderingContext2D,
  tablixView: TablixViewResponse,
  colIndex: number,
  theme: TablixTheme = DEFAULT_TABLIX_THEME,
  minWidth: number = 60,
  maxWidth: number = 300
): number {
  let maxContentWidth = minWidth;

  ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;

  for (const row of tablixView.rows) {
    if (colIndex < row.cells.length) {
      const cell = row.cells[colIndex];
      // Skip spanned cells
      if (cell.isSpanned) continue;

      const displayText = cell.formattedValue || getCellDisplayValue(cell.value);
      if (displayText) {
        const textWidth = ctx.measureText(displayText).width;
        let totalWidth = textWidth + CELL_PADDING_X * 2;

        // Account for indentation
        if (cell.indentLevel) {
          totalWidth += cell.indentLevel * 16;
        }

        // Account for expand/collapse icon
        if (cell.isExpandable) {
          totalWidth += EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
        }

        // Account for filter label
        if (cell.cellType === 'filterLabel') {
          ctx.font = `600 ${theme.fontSize}px ${theme.fontFamily}`;
          const filterTextWidth = ctx.measureText(displayText).width;
          totalWidth = filterTextWidth + CELL_PADDING_X * 2;
          ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;
        }

        // Account for filter dropdown button width
        if (cell.cellType === 'filterDropdown') {
          totalWidth = Math.max(totalWidth, FILTER_BUTTON_MIN_WIDTH + CELL_PADDING_X * 2);
        }

        // For spanning cells, divide width proportionally
        if (cell.colSpan && cell.colSpan > 1) {
          totalWidth = totalWidth / cell.colSpan;
        }

        maxContentWidth = Math.max(maxContentWidth, totalWidth);
      }
    }
  }

  return Math.min(maxContentWidth, maxWidth);
}
