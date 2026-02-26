//! FILENAME: app/extensions/pivot/rendering/pivot.ts

import type {
  PivotViewResponse,
  PivotCellData,
  BackgroundStyle,
  PivotCellType,
} from '../lib/pivot-api';
import { getCellDisplayValue } from '../lib/pivot-api';
import {
  buildFreezePaneConfig,
  calculateColumnXWithFreeze,
  calculateRowYWithFreeze,
} from '../../../src/api/dimensions';

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
  // Text colors (Excel default: dark text everywhere except header)
  headerText: '#ffffff',
  labelText: '#333333',
  valueText: '#333333',
  totalText: '#333333',
  grandTotalText: '#333333',
  filterText: '#333333',

  // Background colors (Excel default "Medium Style 2 - Blue")
  headerBackground: '#5B9BD5',
  labelBackground: '#ffffff',
  valueBackground: '#ffffff',
  totalBackground: '#ffffff',
  grandTotalBackground: '#ffffff',
  filterRowBackground: '#fef3c7',

  // Alternating rows (Excel default: very subtle light blue-grey)
  alternateRowBackground: '#DDEBF7',

  // Borders (subtle, matching Excel's thin lines)
  borderColor: '#9BC2E6',
  headerBorderColor: '#5B9BD5',

  // Filter button
  filterButtonBackground: '#ffffff',
  filterButtonBorder: '#9BC2E6',
  filterButtonHoverBackground: '#DDEBF7',
  filterDropdownArrow: '#595959',

  // Icons
  iconColor: '#595959',
  iconHoverColor: '#333333',

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

export interface PivotInteractiveBounds {
  expandCollapseIcons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    col: number;
    isExpanded: boolean;
    isRow: boolean;
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
  headerFilterButtons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    zone: 'row' | 'column';
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
  hoveredHeaderFilterKey?: string | null;
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
const INDENT_SIZE = 20; // pixels per indent level
const HEADER_FILTER_ARROW_AREA = 20; // width of dropdown arrow area on header filter cells

// Default cell dimensions for pivot tables
const DEFAULT_PIVOT_CELL_WIDTH = 100;
const DEFAULT_PIVOT_CELL_HEIGHT = 24;

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

  // Header filter cells (Row Labels / Column Labels)
  if (cellType === 'RowLabelHeader' || cellType === 'ColumnLabelHeader') {
    return theme.headerText;
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
  backgroundStyle: BackgroundStyle | undefined,
  isBold?: boolean,
  isExpandable?: boolean
): string {
  if (
    isBold ||
    isExpandable || // Parent group headers are bold (like Excel)
    backgroundStyle === 'Header' ||
    backgroundStyle === 'Subtotal' ||
    backgroundStyle === 'Total' ||
    backgroundStyle === 'GrandTotal' ||
    cellType === 'FilterLabel' ||
    cellType === 'RowLabelHeader' ||
    cellType === 'ColumnLabelHeader'
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

  // White fill for icon background (makes it stand out)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 0.5, y + 0.5, size - 1, size - 1);

  // Draw box border
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  // Draw minus (always present)
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
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
  isHoveredHeaderFilter?: boolean;
  hasActiveFilter?: boolean;
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

  // Draw background
  const bgColor = getPivotBackgroundColor(cell.backgroundStyle, theme, rowIndex);
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, width, height);

  // Draw contextual borders (Excel-like: no full grid lines)
  if (cell.backgroundStyle === 'Header') {
    // Header cells: thin bottom border in theme color
    ctx.strokeStyle = theme.headerBorderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Math.floor(y + height) - 0.5);
    ctx.lineTo(x + width, Math.floor(y + height) - 0.5);
    ctx.stroke();
  } else if (
    cell.backgroundStyle === 'Subtotal' ||
    cell.backgroundStyle === 'Total'
  ) {
    // Subtotal/Total: thin top border only (Excel-like minimal separator)
    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Math.floor(y) + 0.5);
    ctx.lineTo(x + width, Math.floor(y) + 0.5);
    ctx.stroke();
  } else if (cell.backgroundStyle === 'GrandTotal') {
    // Grand total: thin top border (same as subtotal, just bold text distinguishes it)
    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Math.floor(y) + 0.5);
    ctx.lineTo(x + width, Math.floor(y) + 0.5);
    ctx.stroke();
  } else if (cell.backgroundStyle === 'FilterRow') {
    // Filter rows: keep full border
    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }
  // Normal/Alternate data cells: no borders (clean Excel-like look)

  // Handle FilterLabel - bold, right-aligned text
  if (cell.cellType === 'FilterLabel') {
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

  // Handle FilterDropdown specially
  if (cell.cellType === 'FilterDropdown') {
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

  // Handle RowLabelHeader / ColumnLabelHeader (header cells with dropdown arrow)
  if (cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader') {
    const zone: 'row' | 'column' = cell.cellType === 'RowLabelHeader' ? 'row' : 'column';
    const displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '';
    const arrowAreaWidth = HEADER_FILTER_ARROW_AREA;
    const textMaxWidth = width - CELL_PADDING_X * 2 - arrowAreaWidth;

    // Draw text
    ctx.fillStyle = theme.headerText;
    ctx.font = `${theme.headerFontWeight} ${theme.headerFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textY = y + height / 2;
    const truncatedText = truncateText(ctx, displayText, textMaxWidth);
    ctx.fillText(truncatedText, x + CELL_PADDING_X, textY);

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
      ctx.moveTo(iconCx - 5, iconCy - 4);  // Top-left
      ctx.lineTo(iconCx + 5, iconCy - 4);  // Top-right
      ctx.lineTo(iconCx + 1, iconCy);       // Narrow right
      ctx.lineTo(iconCx + 1, iconCy + 4);   // Stem right
      ctx.lineTo(iconCx - 1, iconCy + 4);   // Stem left
      ctx.lineTo(iconCx - 1, iconCy);       // Narrow left
      ctx.closePath();
      ctx.fill();
    } else {
      // Dropdown triangle
      const triSize = 7;
      ctx.fillStyle = theme.headerText;
      ctx.beginPath();
      ctx.moveTo(iconCx - triSize / 2, iconCy - triSize / 3);
      ctx.lineTo(iconCx + triSize / 2, iconCy - triSize / 3);
      ctx.lineTo(iconCx, iconCy + triSize / 2);
      ctx.closePath();
      ctx.fill();
    }

    // Store interactive bounds for the entire cell (clickable like Excel)
    result.headerFilterBounds = {
      x,
      y,
      width,
      height,
      zone,
      row: rowIndex,
      col: colIndex,
    };

    return result;
  }

  // Calculate text position
  let textX = x + CELL_PADDING_X;
  let textMaxWidth = width - CELL_PADDING_X * 2;

  // Handle expand/collapse icon for row headers
  if (cell.cellType === 'RowHeader' && cell.isExpandable) {
    const iconX = x + CELL_PADDING_X + (cell.indentLevel || 0) * INDENT_SIZE;
    const iconY = y + (height - EXPAND_ICON_SIZE) / 2;

    // isCollapsed means currently collapsed (show + icon)
    // !isCollapsed means currently expanded (show - icon)
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
      isRow: true,
    };

    textX = iconX + EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
    textMaxWidth = width - (textX - x) - CELL_PADDING_X;
  } else if (cell.cellType === 'ColumnHeader' && cell.isExpandable) {
    // Handle expand/collapse icon for column headers
    const iconX = x + CELL_PADDING_X;
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
      isRow: false,
    };

    textX = iconX + EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
    textMaxWidth = width - (textX - x) - CELL_PADDING_X;
  } else if (cell.indentLevel && cell.indentLevel > 0) {
    // Apply indentation without icon
    textX += cell.indentLevel * INDENT_SIZE;
    textMaxWidth -= cell.indentLevel * INDENT_SIZE;
  }

  // Draw text
  const displayText = cell.formattedValue || getCellDisplayValue(cell.value);
  if (displayText) {
    const textColor = getPivotTextColor(cell.cellType, cell.backgroundStyle, theme);
    const fontWeight = getFontWeight(cell.cellType, cell.backgroundStyle, cell.isBold, cell.isExpandable);
    const textAlign = getTextAlign(cell.cellType);

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
    const width = colWidths[colIndex] || DEFAULT_PIVOT_CELL_WIDTH;
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
      const displayText = cell.formattedValue || getCellDisplayValue(cell.value);
      if (displayText) {
        const textWidth = ctx.measureText(displayText).width;
        let totalWidth = textWidth + CELL_PADDING_X * 2;

        // Account for indentation
        if (cell.indentLevel) {
          totalWidth += cell.indentLevel * INDENT_SIZE;
        }

        // Account for expand/collapse icon
        if (cell.isExpandable) {
          totalWidth += EXPAND_ICON_SIZE + EXPAND_ICON_PADDING;
        }

        // Account for filter label - ensure bold font is measured correctly
        if (cell.cellType === 'FilterLabel') {
          ctx.font = `600 ${theme.fontSize}px ${theme.fontFamily}`;
          const filterTextWidth = ctx.measureText(displayText).width;
          totalWidth = filterTextWidth + CELL_PADDING_X * 2;
          ctx.font = `${theme.headerFontWeight} ${theme.fontSize}px ${theme.fontFamily}`;
        }

        // Account for filter dropdown button width
        if (cell.cellType === 'FilterDropdown') {
          totalWidth = Math.max(totalWidth, FILTER_BUTTON_MIN_WIDTH + CELL_PADDING_X * 2);
        }

        // Account for header filter dropdown arrow area
        if (cell.cellType === 'RowLabelHeader' || cell.cellType === 'ColumnLabelHeader') {
          totalWidth += HEADER_FILTER_ARROW_AREA;
        }

        maxContentWidth = Math.max(maxContentWidth, totalWidth);
      }
    }
  }

  return Math.min(maxContentWidth, maxWidth);
}