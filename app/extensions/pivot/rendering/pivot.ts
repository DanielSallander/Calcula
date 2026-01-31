// FILENAME: app/extensions/Pivot/rendering/pivot.ts

import type {
  PivotViewResponse,
  PivotCellData,
  BackgroundStyle,
  PivotCellType,
} from '../lib/pivot-api';
import { getCellDisplayValue } from '../lib/pivot-api';

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
  // Text colors
  headerText: '#1f2937',
  labelText: '#374151',
  valueText: '#111827',
  totalText: '#1f2937',
  grandTotalText: '#1f2937',
  filterText: '#374151',

  // Background colors
  headerBackground: '#f3f4f6',
  labelBackground: '#f9fafb',
  valueBackground: '#ffffff',
  totalBackground: '#e5e7eb',
  grandTotalBackground: '#d1d5db',
  filterRowBackground: '#fef3c7',

  // Alternating
  alternateRowBackground: '#f9fafb',

  // Borders
  borderColor: '#e5e7eb',
  headerBorderColor: '#d1d5db',

  // Filter button
  filterButtonBackground: '#ffffff',
  filterButtonBorder: '#d1d5db',
  filterButtonHoverBackground: '#f3f4f6',
  filterDropdownArrow: '#6b7280',

  // Icons
  iconColor: '#6b7280',
  iconHoverColor: '#374151',

  // Selection
  selectionBackground: 'rgba(59, 130, 246, 0.1)',
  selectionBorder: '#3b82f6',

  // Font
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  headerFontSize: 13,
  headerFontWeight: '600',
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

export interface PivotInteractiveBounds {
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
}

export interface PivotRenderResult {
  interactiveBounds: PivotInteractiveBounds;
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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getPivotBackgroundColor(
  backgroundStyle: BackgroundStyle | undefined,
  theme: PivotTheme,
  rowIndex: number
): string {
  switch (backgroundStyle) {
    case 'Header':
      return theme.headerBackground;
    case 'Normal':
      return rowIndex % 2 === 0 ? theme.valueBackground : theme.alternateRowBackground;
    case 'Alternate':
      return theme.alternateRowBackground;
    case 'Subtotal':
    case 'Total':
      return theme.totalBackground;
    case 'GrandTotal':
      return theme.grandTotalBackground;
    case 'FilterRow':
      return theme.filterRowBackground;
    default:
      return theme.valueBackground;
  }
}

function getPivotTextColor(
  cellType: PivotCellType | undefined,
  backgroundStyle: BackgroundStyle | undefined,
  theme: PivotTheme
): string {
  // Filter cells
  if (cellType === 'FilterLabel' || cellType === 'FilterDropdown') {
    return theme.filterText;
  }

  switch (backgroundStyle) {
    case 'Header':
      return theme.headerText;
    case 'Subtotal':
    case 'Total':
      return theme.totalText;
    case 'GrandTotal':
      return theme.grandTotalText;
    default:
      return theme.valueText;
  }
}

function getFontWeight(
  cellType: PivotCellType | undefined,
  backgroundStyle: BackgroundStyle | undefined
): string {
  if (
    backgroundStyle === 'Header' ||
    backgroundStyle === 'Subtotal' ||
    backgroundStyle === 'Total' ||
    backgroundStyle === 'GrandTotal' ||
    cellType === 'FilterLabel'
  ) {
    return '600';
  }
  return '400';
}

function getTextAlign(
  cellType: PivotCellType | undefined
): CanvasTextAlign {
  if (
    cellType === 'Data' ||
    cellType === 'RowSubtotal' ||
    cellType === 'ColumnSubtotal' ||
    cellType === 'GrandTotal' ||
    cellType === 'GrandTotalRow' ||
    cellType === 'GrandTotalColumn'
  ) {
    return 'right';
  }
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

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  // Draw box
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);

  // Draw minus (always present)
  const lineY = centerY;
  const lineStartX = x + 3;
  const lineEndX = x + size - 3;

  ctx.beginPath();
  ctx.moveTo(lineStartX, lineY);
  ctx.lineTo(lineEndX, lineY);
  ctx.stroke();

  // Draw vertical line for plus (collapsed state)
  if (isCollapsed) {
    const lineX = centerX;
    const lineStartY = y + 3;
    const lineEndY = y + size - 3;

    ctx.beginPath();
    ctx.moveTo(lineX, lineStartY);
    ctx.lineTo(lineX, lineEndY);
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
  theme: PivotTheme,
  isHovered: boolean
): { buttonBounds: { x: number; y: number; width: number; height: number } } {
  const buttonWidth = Math.max(FILTER_BUTTON_MIN_WIDTH, Math.min(width, FILTER_BUTTON_MAX_WIDTH));

  ctx.save();

  // Draw button background
  ctx.fillStyle = isHovered ? theme.filterButtonHoverBackground : theme.filterButtonBackground;
  ctx.fillRect(x, y, buttonWidth, height);

  // Draw button border
  ctx.strokeStyle = theme.filterButtonBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, buttonWidth - 1, height - 1);

  // Draw text
  const textX = x + FILTER_BUTTON_PADDING;
  const textMaxWidth = buttonWidth - FILTER_BUTTON_PADDING * 2 - FILTER_ARROW_SIZE - 4;
  const textY = y + height / 2;

  ctx.fillStyle = theme.filterText;
  ctx.font = `400 ${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const truncatedText = truncateText(ctx, displayValue, textMaxWidth);
  ctx.fillText(truncatedText, textX, textY);

  // Draw dropdown arrow (triangle)
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

function drawPivotCell(
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
  };

  // Draw background
  const bgColor = getPivotBackgroundColor(cell.background_style, theme, rowIndex);
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, width, height);

  // Draw border
  ctx.strokeStyle = theme.borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  // Handle FilterLabel - bold, right-aligned text
  if (cell.cell_type === 'FilterLabel') {
    const displayText = cell.formatted_value || getCellDisplayValue(cell.value) || '';
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

  // Handle FilterDropdown specially
  if (cell.cell_type === 'FilterDropdown') {
    const buttonY = y + Math.floor((height - FILTER_BUTTON_HEIGHT) / 2);
    const displayText = cell.formatted_value || getCellDisplayValue(cell.value) || '(All)';
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
      fieldIndex: cell.filter_field_index ?? -1,
      row: rowIndex,
      col: colIndex,
    };

    return result;
  }

  // Calculate text position
  let textX = x + CELL_PADDING_X;
  let textMaxWidth = width - CELL_PADDING_X * 2;

  // Handle expand/collapse icon for row headers
  if (cell.cell_type === 'RowHeader' && cell.is_expandable) {
    const iconX = x + CELL_PADDING_X + (cell.indent_level || 0) * 16;
    const iconY = y + (height - EXPAND_ICON_SIZE) / 2;

    // is_collapsed means currently collapsed (show + icon)
    // !is_collapsed means currently expanded (show - icon)
    drawExpandCollapseIcon(
      ctx,
      iconX,
      iconY,
      cell.is_collapsed,
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
      isExpanded: !cell.is_collapsed,
    };

    textX = iconX + EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
    textMaxWidth = width - (textX - x) - CELL_PADDING_X;
  } else if (cell.indent_level && cell.indent_level > 0) {
    // Apply indentation without icon
    textX += cell.indent_level * 16;
    textMaxWidth -= cell.indent_level * 16;
  }

  // Draw text
  const displayText = cell.formatted_value || getCellDisplayValue(cell.value);
  if (displayText) {
    const textColor = getPivotTextColor(cell.cell_type, cell.background_style, theme);
    const fontWeight = getFontWeight(cell.cell_type, cell.background_style);
    const textAlign = getTextAlign(cell.cell_type);

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

  // Calculate frozen dimensions
  let frozenWidth = 0;
  for (let c = 0; c < frozenColCount && c < colWidths.length; c++) {
    frozenWidth += colWidths[c];
  }

  let frozenHeight = 0;
  for (let r = 0; r < frozenRowCount && r < rowHeights.length; r++) {
    frozenHeight += rowHeights[r];
  }

  // Helper to get Y position for a row
  const getRowY = (rowIndex: number): number => {
    let y = 0;
    if (rowIndex < frozenRowCount) {
      for (let r = 0; r < rowIndex; r++) {
        y += rowHeights[r] || 24;
      }
    } else {
      y = frozenHeight;
      for (let r = frozenRowCount; r < rowIndex; r++) {
        y += rowHeights[r] || 24;
      }
      y -= scrollTop;
    }
    return y;
  };

  // Helper to get X position for a column
  const getColX = (colIndex: number): number => {
    let x = 0;
    if (colIndex < frozenColCount) {
      for (let c = 0; c < colIndex; c++) {
        x += colWidths[c] || 100;
      }
    } else {
      x = frozenWidth;
      for (let c = frozenColCount; c < colIndex; c++) {
        x += colWidths[c] || 100;
      }
      x -= scrollLeft;
    }
    return x;
  };

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
    const width = colWidths[colIndex] || 100;
    const height = rowHeights[rowIndex] || 24;

    // Skip cells outside visible area
    if (x + width < 0 || x > canvasWidth || y + height < 0 || y > canvasHeight) {
      return;
    }

    const cellKey = `${rowIndex}-${colIndex}`;
    const isHoveredFilter = cell.filter_field_index !== undefined &&
      cell.filter_field_index === hoveredFilterFieldIndex;
    const isHoveredIcon = hoveredIconKey === cellKey;

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
      }
    );

    // Store interactive bounds
    if (cellResult.iconBounds) {
      interactiveBounds.expandCollapseIcons.set(cellKey, cellResult.iconBounds);
    }

    if (cellResult.filterButtonBounds) {
      const filterKey = `filter-${cell.filter_field_index}`;
      interactiveBounds.filterButtons.set(filterKey, cellResult.filterButtonBounds);
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

  return { interactiveBounds };
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

export function createPivotTheme(overrides: Partial<PivotTheme> = {}): PivotTheme {
  return { ...DEFAULT_PIVOT_THEME, ...overrides };
}

export function measurePivotColumnWidth(
  ctx: CanvasRenderingContext2D,
  pivotView: PivotViewResponse,
  colIndex: number,
  theme: PivotTheme = DEFAULT_PIVOT_THEME,
  minWidth: number = 60,
  maxWidth: number = 300
): number {
  let maxContentWidth = minWidth;

  ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;

  for (const row of pivotView.rows) {
    if (colIndex < row.cells.length) {
      const cell = row.cells[colIndex];
      const displayText = cell.formatted_value || getCellDisplayValue(cell.value);
      if (displayText) {
        const textWidth = ctx.measureText(displayText).width;
        let totalWidth = textWidth + CELL_PADDING_X * 2;

        // Account for indentation
        if (cell.indent_level) {
          totalWidth += cell.indent_level * 16;
        }

        // Account for expand/collapse icon
        if (cell.is_expandable) {
          totalWidth += EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
        }

        // Account for filter label - ensure bold font is measured correctly
        if (cell.cell_type === 'FilterLabel') {
          ctx.font = `600 ${theme.fontSize}px ${theme.fontFamily}`;
          const filterTextWidth = ctx.measureText(displayText).width;
          totalWidth = filterTextWidth + CELL_PADDING_X * 2;
          ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;
        }

        // Account for filter dropdown button width
        if (cell.cell_type === 'FilterDropdown') {
          totalWidth = Math.max(totalWidth, FILTER_BUTTON_MIN_WIDTH + CELL_PADDING_X * 2);
        }

        maxContentWidth = Math.max(maxContentWidth, totalWidth);
      }
    }
  }

  return Math.min(maxContentWidth, maxWidth);
}