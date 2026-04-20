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
  filterRowBackground: '#D9D9D9',

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
  const comboWidth = Math.max(FILTER_BUTTON_MIN_WIDTH, width);
  const arrowBtnWidth = 18; // compact dropdown arrow button

  ctx.save();

  // Draw combo box background (white, full width)
  ctx.fillStyle = isHovered ? '#f5f7fa' : theme.filterButtonBackground;
  ctx.fillRect(x, y, comboWidth, height);

  // Draw combo box border — blue tint when filter is active
  if (hasActiveFilter) {
    ctx.strokeStyle = isHovered ? '#1565c0' : '#1a73e8';
  } else {
    ctx.strokeStyle = isHovered ? theme.headerBorderColor : theme.filterButtonBorder;
  }
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, comboWidth - 1, height - 1);

  // Draw the value text on the left side
  const textX = x + FILTER_BUTTON_PADDING;
  const textMaxWidth = comboWidth - FILTER_BUTTON_PADDING * 2 - arrowBtnWidth;
  const textY = y + height / 2;

  ctx.fillStyle = hasActiveFilter ? '#1a73e8' : theme.filterText;
  ctx.font = `400 ${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const truncatedText = truncateText(ctx, displayValue, textMaxWidth);
  ctx.fillText(truncatedText, textX, textY);

  // Draw dropdown arrow button on the right edge (Excel-style)
  const btnX = x + comboWidth - arrowBtnWidth;
  const btnY = y;

  // Arrow button background
  if (hasActiveFilter) {
    ctx.fillStyle = isHovered ? '#d0e2f4' : '#e8f0fe';
  } else {
    ctx.fillStyle = isHovered ? '#e0e4ea' : '#f0f0f0';
  }
  ctx.fillRect(btnX, btnY, arrowBtnWidth, height);

  // Arrow button left border (separator from text area)
  if (hasActiveFilter) {
    ctx.strokeStyle = isHovered ? '#1565c0' : '#1a73e8';
  } else {
    ctx.strokeStyle = isHovered ? theme.headerBorderColor : theme.filterButtonBorder;
  }
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.floor(btnX) + 0.5, btnY);
  ctx.lineTo(Math.floor(btnX) + 0.5, btnY + height);
  ctx.stroke();

  // Draw icon centered in the arrow button
  const arrowCx = btnX + arrowBtnWidth / 2;
  const arrowCy = btnY + height / 2;

  if (hasActiveFilter) {
    // Funnel icon when filter is active (matches header filter style)
    ctx.fillStyle = '#1a73e8';
    ctx.beginPath();
    ctx.moveTo(arrowCx - 5, arrowCy - 4);  // Top-left
    ctx.lineTo(arrowCx + 5, arrowCy - 4);  // Top-right
    ctx.lineTo(arrowCx + 1, arrowCy);       // Narrow right
    ctx.lineTo(arrowCx + 1, arrowCy + 4);   // Stem right
    ctx.lineTo(arrowCx - 1, arrowCy + 4);   // Stem left
    ctx.lineTo(arrowCx - 1, arrowCy);       // Narrow left
    ctx.closePath();
    ctx.fill();
  } else {
    // Dropdown triangle
    const triSize = 5;
    ctx.fillStyle = theme.filterDropdownArrow;
    ctx.beginPath();
    ctx.moveTo(arrowCx - triSize, arrowCy - triSize / 2);
    ctx.lineTo(arrowCx + triSize, arrowCy - triSize / 2);
    ctx.lineTo(arrowCx, arrowCy + triSize / 2 + 1);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();

  // The clickable bounds covers the entire combo box (not just the arrow button)
  return {
    buttonBounds: { x, y, width: comboWidth, height },
  };
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

  // Cell backgrounds, borders, and text are now rendered by the grid renderer
  // via styled cells written by the backend. This function only draws
  // interactive chrome elements that can't be expressed as cell styles.

  // FilterLabel — no interactive chrome, grid renders the text
  if (cell.cellType === 'FilterLabel') {
    return result;
  }

  // FilterDropdown — interactive combo box drawn on top of the grid cell
  if (cell.cellType === 'FilterDropdown') {
    // Fill over the grid cell content since the dropdown has custom draw logic
    ctx.fillStyle = theme.filterButtonBackground || '#D9D9D9';
    ctx.fillRect(x, y, width, height);

    const margin = 2;
    const comboX = x + margin;
    const comboY = y + margin;
    const comboW = width - margin * 2;
    const comboH = height - margin * 2;
    const displayText = cell.formattedValue || getCellDisplayValue(cell.value) || '(All)';
    const buttonResult = drawFilterDropdownButton(
      ctx,
      comboX,
      comboY,
      comboW,
      comboH,
      displayText,
      theme,
      options.isHoveredFilterButton || false,
      options.hasActiveFilterDropdown || false
    );

    result.filterButtonBounds = {
      ...buttonResult.buttonBounds,
      x: comboX,
      y: comboY,
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

  // Fast path: if the backend provided a max content sample string for this
  // column, measure just that single string instead of scanning all rows.
  const column = pivotView.columns?.[colIndex];
  if (column?.maxContentSample) {
    const textWidth = ctx.measureText(column.maxContentSample).width;
    const totalWidth = textWidth + CELL_PADDING_X * 2;
    maxContentWidth = Math.max(maxContentWidth, totalWidth);
    return Math.min(maxContentWidth, maxWidth);
  }

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

        // Account for filter dropdown combo box (text + arrow button area)
        if (cell.cellType === 'FilterDropdown') {
          // Arrow button width equals cell height; add margin + padding
          const arrowBtnWidth = DEFAULT_PIVOT_CELL_HEIGHT;
          totalWidth = textWidth + FILTER_BUTTON_PADDING * 2 + arrowBtnWidth + 4;
          totalWidth = Math.max(totalWidth, FILTER_BUTTON_MIN_WIDTH);
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