//! FILENAME: app/src/core/lib/gridRenderer/rendering/pivot.ts
// PURPOSE: Pivot table cell rendering with hierarchy support
// CONTEXT: Renders PivotViewCell data with indentation, expand/collapse icons, and visual hierarchy

// ============================================================================
// TYPE DEFINITIONS - Mirrors view.rs structs
// ============================================================================

/**
 * The type of a cell in the pivot view.
 * Mirrors PivotCellType enum from view.rs
 */
export type PivotCellType =
  | "Corner"
  | "RowHeader"
  | "ColumnHeader"
  | "Data"
  | "RowSubtotal"
  | "ColumnSubtotal"
  | "GrandTotalRow"
  | "GrandTotalColumn"
  | "GrandTotal"
  | "Blank";

/**
 * Display value for a pivot cell.
 * Mirrors PivotCellValue enum from view.rs
 */
export type PivotCellValue =
  | { type: "Empty" }
  | { type: "Number"; value: number }
  | { type: "Text"; value: string }
  | { type: "Boolean"; value: boolean }
  | { type: "Error"; value: string };

/**
 * Background style hints for rendering.
 * Mirrors BackgroundStyle enum from view.rs
 */
export type PivotBackgroundStyle =
  | "Normal"
  | "Header"
  | "Subtotal"
  | "Total"
  | "GrandTotal"
  | "Alternate";

/**
 * A single cell in the pivot table view.
 * Mirrors PivotViewCell struct from view.rs
 */
export interface PivotViewCell {
  /** The display value */
  value: PivotCellValue;
  /** The type of this cell */
  cellType: PivotCellType;
  /** Indentation level (for compact layout row headers) */
  indentLevel: number;
  /** Whether this cell's group is collapsed */
  isCollapsed: boolean;
  /** Whether this cell can be expanded/collapsed */
  isExpandable: boolean;
  /** Number format string for display */
  numberFormat: string | null;
  /** Row span (for merged cells in tabular layout) */
  rowSpan: number;
  /** Column span (for merged cells) */
  colSpan: number;
  /** Whether this cell should be visually emphasized */
  isBold: boolean;
  /** Background style hint */
  backgroundStyle: PivotBackgroundStyle;
  /** Link back to source data: [fieldIndex, valueId] pairs */
  groupPath: Array<[number, number]>;
}

/**
 * Row descriptor from PivotView.
 * Mirrors PivotRowDescriptor from view.rs
 */
export interface PivotRowDescriptor {
  viewRow: number;
  rowType: "Data" | "Subtotal" | "GrandTotal" | "ColumnHeader";
  depth: number;
  visible: boolean;
  parentIndex: number | null;
  childrenIndices: number[];
  groupValues: number[];
}

/**
 * Column descriptor from PivotView.
 * Mirrors PivotColumnDescriptor from view.rs
 */
export interface PivotColumnDescriptor {
  viewCol: number;
  colType: "RowLabel" | "Data" | "Subtotal" | "GrandTotal";
  depth: number;
  widthHint: number;
  parentIndex: number | null;
  childrenIndices: number[];
  groupValues: number[];
}

/**
 * The complete rendered view of a pivot table.
 * Mirrors PivotView struct from view.rs
 */
export interface PivotView {
  pivotId: string;
  cells: PivotViewCell[][];
  rows: PivotRowDescriptor[];
  columns: PivotColumnDescriptor[];
  rowCount: number;
  colCount: number;
  rowLabelColCount: number;
  columnHeaderRowCount: number;
  isWindowed: boolean;
  totalRowCount: number | null;
  windowStartRow: number | null;
  version: number;
}

// ============================================================================
// THEME CONFIGURATION
// ============================================================================

/**
 * Theme colors for pivot table rendering.
 */
export interface PivotTheme {
  // Text colors
  headerText: string;
  dataText: string;
  totalText: string;
  errorText: string;

  // Background colors
  headerBackground: string;
  dataBackground: string;
  subtotalBackground: string;
  totalBackground: string;
  grandTotalBackground: string;
  alternateBackground: string;

  // Icon colors
  iconStroke: string;
  iconFill: string;
  iconHoverFill: string;

  // Grid
  gridLine: string;
  separatorLine: string;

  // Font
  fontFamily: string;
  fontSize: number;
  headerFontSize: number;
}

/**
 * Default pivot theme matching the existing grid style.
 */
export const DEFAULT_PIVOT_THEME: PivotTheme = {
  headerText: "#1a1a1a",
  dataText: "#333333",
  totalText: "#000000",
  errorText: "#cc0000",

  headerBackground: "#f5f5f5",
  dataBackground: "#ffffff",
  subtotalBackground: "#e8e8e8",
  totalBackground: "#d9d9d9",
  grandTotalBackground: "#c0c0c0",
  alternateBackground: "#fafafa",

  iconStroke: "#666666",
  iconFill: "#ffffff",
  iconHoverFill: "#e0e0e0",

  gridLine: "#e0e0e0",
  separatorLine: "#999999",

  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 13,
  headerFontSize: 13,
};

// ============================================================================
// CONSTANTS
// ============================================================================

/** Pixels per indentation level */
const INDENT_WIDTH = 20;

/** Padding inside cells */
const CELL_PADDING_X = 4;

/** Size of expand/collapse icon box */
const ICON_SIZE = 12;

/** Gap between icon and text */
const ICON_TEXT_GAP = 4;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract display string from PivotCellValue.
 */
export function getPivotCellDisplayValue(
  value: PivotCellValue,
  numberFormat: string | null
): string {
  switch (value.type) {
    case "Empty":
      return "";
    case "Number":
      return formatPivotNumber(value.value, numberFormat);
    case "Text":
      return value.value;
    case "Boolean":
      return value.value ? "TRUE" : "FALSE";
    case "Error":
      return value.value;
  }
}

/**
 * Format a number according to the specified format string.
 * Basic implementation - extend as needed for full number formatting.
 */
function formatPivotNumber(value: number, format: string | null): string {
  if (format === null) {
    // Default formatting: show up to 2 decimal places, use thousands separator
    if (Number.isInteger(value)) {
      return value.toLocaleString();
    }
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  // Handle common format patterns
  if (format === "0") {
    return Math.round(value).toLocaleString();
  }
  if (format === "0.00") {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (format === "0%") {
    return Math.round(value * 100) + "%";
  }
  if (format === "0.00%") {
    return (value * 100).toFixed(2) + "%";
  }
  if (format === "#,##0") {
    return Math.round(value).toLocaleString();
  }
  if (format === "#,##0.00") {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Fallback to default formatting
  return value.toLocaleString();
}

/**
 * Get background color for a pivot cell based on its style.
 */
export function getPivotBackgroundColor(
  style: PivotBackgroundStyle,
  theme: PivotTheme
): string {
  switch (style) {
    case "Normal":
      return theme.dataBackground;
    case "Header":
      return theme.headerBackground;
    case "Subtotal":
      return theme.subtotalBackground;
    case "Total":
      return theme.totalBackground;
    case "GrandTotal":
      return theme.grandTotalBackground;
    case "Alternate":
      return theme.alternateBackground;
  }
}

/**
 * Get text color for a pivot cell based on its type and value.
 */
export function getPivotTextColor(
  cell: PivotViewCell,
  theme: PivotTheme
): string {
  // Error values get error color
  if (cell.value.type === "Error") {
    return theme.errorText;
  }

  // Headers and totals get distinct colors
  switch (cell.cellType) {
    case "RowHeader":
    case "ColumnHeader":
    case "Corner":
      return theme.headerText;
    case "GrandTotal":
    case "GrandTotalRow":
    case "GrandTotalColumn":
    case "RowSubtotal":
    case "ColumnSubtotal":
      return theme.totalText;
    default:
      return theme.dataText;
  }
}

// ============================================================================
// ICON RENDERING
// ============================================================================

/**
 * Draw a crisp expand/collapse icon using vector paths.
 *
 * @param ctx - Canvas rendering context
 * @param x - Left edge of the icon box
 * @param y - Top edge of the icon box
 * @param size - Size of the icon box (width and height)
 * @param isExpanded - Whether to draw minus (expanded) or plus (collapsed)
 * @param theme - Theme colors for the icon
 * @param isHovered - Optional hover state for visual feedback
 */
export function drawPivotIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  isExpanded: boolean,
  theme: PivotTheme,
  isHovered: boolean = false
): void {
  // Snap to pixel grid for crispness
  const boxX = Math.floor(x) + 0.5;
  const boxY = Math.floor(y) + 0.5;
  const boxSize = Math.floor(size);

  // Draw the box background
  ctx.fillStyle = isHovered ? theme.iconHoverFill : theme.iconFill;
  ctx.fillRect(boxX, boxY, boxSize, boxSize);

  // Draw the box border
  ctx.strokeStyle = theme.iconStroke;
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX, boxY, boxSize, boxSize);

  // Calculate center and glyph dimensions
  const centerX = boxX + boxSize / 2;
  const centerY = boxY + boxSize / 2;
  const glyphLength = Math.floor(boxSize * 0.5);
  const halfGlyph = Math.floor(glyphLength / 2);

  // Draw the minus (horizontal line) - always present
  ctx.beginPath();
  ctx.moveTo(Math.floor(centerX - halfGlyph) + 0.5, Math.floor(centerY) + 0.5);
  ctx.lineTo(Math.floor(centerX + halfGlyph) + 0.5, Math.floor(centerY) + 0.5);
  ctx.stroke();

  // Draw the plus (vertical line) - only when collapsed
  if (!isExpanded) {
    ctx.beginPath();
    ctx.moveTo(Math.floor(centerX) + 0.5, Math.floor(centerY - halfGlyph) + 0.5);
    ctx.lineTo(Math.floor(centerX) + 0.5, Math.floor(centerY + halfGlyph) + 0.5);
    ctx.stroke();
  }
}

/**
 * Alternative chevron-style icon for expand/collapse.
 * Use this if you prefer a more modern look.
 */
export function drawPivotChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  isExpanded: boolean,
  theme: PivotTheme
): void {
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const chevronSize = size * 0.3;

  ctx.strokeStyle = theme.iconStroke;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  if (isExpanded) {
    // Down chevron (V shape)
    ctx.moveTo(centerX - chevronSize, centerY - chevronSize / 2);
    ctx.lineTo(centerX, centerY + chevronSize / 2);
    ctx.lineTo(centerX + chevronSize, centerY - chevronSize / 2);
  } else {
    // Right chevron (> shape)
    ctx.moveTo(centerX - chevronSize / 2, centerY - chevronSize);
    ctx.lineTo(centerX + chevronSize / 2, centerY);
    ctx.lineTo(centerX - chevronSize / 2, centerY + chevronSize);
  }
  ctx.stroke();
}

// ============================================================================
// CELL RENDERING
// ============================================================================

/**
 * Geometry information for rendering a pivot cell.
 */
export interface PivotCellGeometry {
  /** Left edge of the cell */
  x: number;
  /** Top edge of the cell */
  y: number;
  /** Width of the cell (including any col span) */
  width: number;
  /** Height of the cell (including any row span) */
  height: number;
}

/**
 * Options for pivot cell rendering.
 */
export interface PivotCellRenderOptions {
  /** Theme colors */
  theme: PivotTheme;
  /** Whether to draw the background */
  drawBackground?: boolean;
  /** Whether to draw grid borders */
  drawBorders?: boolean;
  /** Hover state for icon */
  iconHovered?: boolean;
  /** Use chevron style instead of +/- box */
  useChevronIcon?: boolean;
}

/**
 * Draw a single pivot cell with full styling support.
 *
 * @param ctx - Canvas rendering context
 * @param cell - The pivot cell data
 * @param geometry - Position and size information
 * @param options - Rendering options
 * @returns The bounding box of the expand/collapse icon (if drawn), for hit testing
 */
export function drawPivotCell(
  ctx: CanvasRenderingContext2D,
  cell: PivotViewCell,
  geometry: PivotCellGeometry,
  options: PivotCellRenderOptions
): { iconBounds: { x: number; y: number; width: number; height: number } | null } {
  const { x, y, width, height } = geometry;
  const {
    theme,
    drawBackground = true,
    drawBorders = false,
    iconHovered = false,
    useChevronIcon = false,
  } = options;

  // Skip blank cells
  if (cell.cellType === "Blank" && cell.value.type === "Empty") {
    return { iconBounds: null };
  }

  // Save context state
  ctx.save();

  // Set up clipping region
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  // 1. Draw background
  if (drawBackground) {
    ctx.fillStyle = getPivotBackgroundColor(cell.backgroundStyle, theme);
    ctx.fillRect(x, y, width, height);
  }

  // 2. Draw borders if requested
  if (drawBorders) {
    ctx.strokeStyle = theme.gridLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.floor(x) + 0.5, Math.floor(y) + 0.5, width - 1, height - 1);
  }

  // 3. Calculate content layout
  const indentOffset = cell.indentLevel * INDENT_WIDTH;
  let contentX = x + CELL_PADDING_X + indentOffset;
  let iconBounds: { x: number; y: number; width: number; height: number } | null = null;

  // 4. Draw expand/collapse icon if expandable
  if (cell.isExpandable) {
    const iconY = y + (height - ICON_SIZE) / 2;
    const iconX = contentX;

    if (useChevronIcon) {
      drawPivotChevron(ctx, iconX, iconY, ICON_SIZE, !cell.isCollapsed, theme);
    } else {
      drawPivotIcon(ctx, iconX, iconY, ICON_SIZE, !cell.isCollapsed, theme, iconHovered);
    }

    iconBounds = {
      x: iconX,
      y: iconY,
      width: ICON_SIZE,
      height: ICON_SIZE,
    };

    contentX += ICON_SIZE + ICON_TEXT_GAP;
  }

  // 5. Get display text
  const displayText = getPivotCellDisplayValue(cell.value, cell.numberFormat);

  if (displayText !== "") {
    // 6. Set up font
    const fontWeight = cell.isBold ? "bold" : "normal";
    const fontSize =
      cell.cellType === "RowHeader" || cell.cellType === "ColumnHeader"
        ? theme.headerFontSize
        : theme.fontSize;

    ctx.font = `${fontWeight} ${fontSize}px ${theme.fontFamily}`;
    ctx.fillStyle = getPivotTextColor(cell, theme);
    ctx.textBaseline = "middle";

    // 7. Calculate available width for text
    const availableWidth = x + width - contentX - CELL_PADDING_X;

    if (availableWidth > 0) {
      // 8. Determine text alignment based on cell type and value
      let textAlign: "left" | "right" | "center" = "left";

      // Data cells with numbers align right
      if (cell.cellType === "Data" && cell.value.type === "Number") {
        textAlign = "right";
      }
      // Subtotals and totals with numbers align right
      if (
        (cell.cellType === "RowSubtotal" ||
          cell.cellType === "ColumnSubtotal" ||
          cell.cellType === "GrandTotal" ||
          cell.cellType === "GrandTotalRow" ||
          cell.cellType === "GrandTotalColumn") &&
        cell.value.type === "Number"
      ) {
        textAlign = "right";
      }
      // Column headers center align
      if (cell.cellType === "ColumnHeader") {
        textAlign = "center";
      }

      // 9. Calculate text position
      const textY = y + height / 2;

      // 10. Draw text with truncation
      drawPivotTextWithTruncation(
        ctx,
        displayText,
        contentX,
        textY,
        availableWidth,
        textAlign
      );
    }
  }

  // Restore context state
  ctx.restore();

  return { iconBounds };
}

/**
 * Draw text with ellipsis truncation for pivot cells.
 * Optimized version that avoids binary search for common cases.
 */
function drawPivotTextWithTruncation(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: "left" | "right" | "center"
): void {
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  // Fast path: text fits without truncation
  if (textWidth <= maxWidth) {
    let drawX = x;
    if (align === "right") {
      drawX = x + maxWidth - textWidth;
    } else if (align === "center") {
      drawX = x + (maxWidth - textWidth) / 2;
    }
    ctx.fillText(text, drawX, y);
    return;
  }

  // Text needs truncation
  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const availableWidth = maxWidth - ellipsisWidth;

  if (availableWidth <= 0) {
    // Not enough room - just draw ellipsis
    ctx.fillText(ellipsis, x, y);
    return;
  }

  // Estimate truncation point based on average character width
  const avgCharWidth = textWidth / text.length;
  let estimatedChars = Math.floor(availableWidth / avgCharWidth);

  // Refine estimate
  while (estimatedChars > 0) {
    const truncated = text.substring(0, estimatedChars);
    const truncWidth = ctx.measureText(truncated).width;
    if (truncWidth <= availableWidth) {
      // Found a fit, try to get a bit more
      while (estimatedChars < text.length) {
        const nextTruncated = text.substring(0, estimatedChars + 1);
        const nextWidth = ctx.measureText(nextTruncated).width;
        if (nextWidth > availableWidth) break;
        estimatedChars++;
      }
      break;
    }
    estimatedChars--;
  }

  const truncatedText = text.substring(0, estimatedChars) + ellipsis;
  ctx.fillText(truncatedText, x, y);
}

// ============================================================================
// BATCH RENDERING
// ============================================================================

/**
 * Render a complete PivotView to the canvas.
 * Handles the full grid of cells with proper clipping and scrolling.
 */
export interface PivotRenderConfig {
  /** Canvas rendering context */
  ctx: CanvasRenderingContext2D;
  /** Canvas width */
  width: number;
  /** Canvas height */
  height: number;
  /** The pivot view data */
  pivotView: PivotView;
  /** Theme colors */
  theme: PivotTheme;
  /** Scroll offset X */
  scrollX: number;
  /** Scroll offset Y */
  scrollY: number;
  /** Row header width (left frozen area) */
  rowHeaderWidth: number;
  /** Column header height (top frozen area) */
  columnHeaderHeight: number;
  /** Column widths array */
  columnWidths: number[];
  /** Row heights array */
  rowHeights: number[];
  /** Currently hovered cell for icon hover effect [row, col] or null */
  hoveredCell: [number, number] | null;
}

/**
 * Render the entire pivot table view.
 * Returns a map of icon bounds for hit testing.
 */
export function renderPivotView(
  config: PivotRenderConfig
): Map<string, { x: number; y: number; width: number; height: number }> {
  const {
    ctx,
    width,
    height,
    pivotView,
    theme,
    scrollX,
    scrollY,
    rowHeaderWidth,
    columnHeaderHeight,
    columnWidths,
    rowHeights,
    hoveredCell,
  } = config;

  const iconBoundsMap = new Map<string, { x: number; y: number; width: number; height: number }>();

  // Clear canvas
  ctx.fillStyle = theme.dataBackground;
  ctx.fillRect(0, 0, width, height);

  // Calculate visible range
  const visibleRows = pivotView.rows.filter((r) => r.visible);
  const frozenCols = pivotView.rowLabelColCount;
  const frozenRows = pivotView.columnHeaderRowCount;

  // Draw cells in layers: scrollable, then frozen

  // 1. Draw scrollable area (bottom-right)
  ctx.save();
  ctx.beginPath();
  ctx.rect(rowHeaderWidth, columnHeaderHeight, width - rowHeaderWidth, height - columnHeaderHeight);
  ctx.clip();

  let currentY = columnHeaderHeight - scrollY;
  for (let viewRow = frozenRows; viewRow < visibleRows.length; viewRow++) {
    const rowIdx = visibleRows[viewRow].viewRow;
    const rowHeight = rowHeights[rowIdx] || 24;

    // Skip rows above viewport
    if (currentY + rowHeight < columnHeaderHeight) {
      currentY += rowHeight;
      continue;
    }
    // Stop if below viewport
    if (currentY > height) break;

    let currentX = rowHeaderWidth - scrollX;
    for (let col = frozenCols; col < pivotView.colCount; col++) {
      const colWidth = columnWidths[col] || 100;

      // Skip columns left of viewport
      if (currentX + colWidth < rowHeaderWidth) {
        currentX += colWidth;
        continue;
      }
      // Stop if right of viewport
      if (currentX > width) break;

      const cell = pivotView.cells[rowIdx]?.[col];
      if (cell) {
        const isHovered =
          hoveredCell !== null &&
          hoveredCell[0] === rowIdx &&
          hoveredCell[1] === col;

        const result = drawPivotCell(
          ctx,
          cell,
          { x: currentX, y: currentY, width: colWidth, height: rowHeight },
          { theme, iconHovered: isHovered }
        );

        if (result.iconBounds) {
          iconBoundsMap.set(`${rowIdx},${col}`, result.iconBounds);
        }
      }

      currentX += colWidth;
    }
    currentY += rowHeight;
  }
  ctx.restore();

  // 2. Draw frozen left column (row labels)
  if (frozenCols > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, columnHeaderHeight, rowHeaderWidth, height - columnHeaderHeight);
    ctx.clip();

    currentY = columnHeaderHeight - scrollY;
    for (let viewRow = frozenRows; viewRow < visibleRows.length; viewRow++) {
      const rowIdx = visibleRows[viewRow].viewRow;
      const rowHeight = rowHeights[rowIdx] || 24;

      if (currentY + rowHeight < columnHeaderHeight) {
        currentY += rowHeight;
        continue;
      }
      if (currentY > height) break;

      let currentX = 0;
      for (let col = 0; col < frozenCols; col++) {
        const colWidth = columnWidths[col] || 100;
        const cell = pivotView.cells[rowIdx]?.[col];

        if (cell) {
          const isHovered =
            hoveredCell !== null &&
            hoveredCell[0] === rowIdx &&
            hoveredCell[1] === col;

          const result = drawPivotCell(
            ctx,
            cell,
            { x: currentX, y: currentY, width: colWidth, height: rowHeight },
            { theme, iconHovered: isHovered }
          );

          if (result.iconBounds) {
            iconBoundsMap.set(`${rowIdx},${col}`, result.iconBounds);
          }
        }

        currentX += colWidth;
      }
      currentY += rowHeight;
    }
    ctx.restore();
  }

  // 3. Draw frozen top rows (column headers)
  if (frozenRows > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderWidth, 0, width - rowHeaderWidth, columnHeaderHeight);
    ctx.clip();

    currentY = 0;
    for (let rowIdx = 0; rowIdx < frozenRows && rowIdx < pivotView.rowCount; rowIdx++) {
      const rowHeight = rowHeights[rowIdx] || 24;

      let currentX = rowHeaderWidth - scrollX;
      for (let col = frozenCols; col < pivotView.colCount; col++) {
        const colWidth = columnWidths[col] || 100;

        if (currentX + colWidth < rowHeaderWidth) {
          currentX += colWidth;
          continue;
        }
        if (currentX > width) break;

        const cell = pivotView.cells[rowIdx]?.[col];
        if (cell) {
          drawPivotCell(
            ctx,
            cell,
            { x: currentX, y: currentY, width: colWidth, height: rowHeight },
            { theme }
          );
        }

        currentX += colWidth;
      }
      currentY += rowHeight;
    }
    ctx.restore();
  }

  // 4. Draw frozen corner (top-left)
  if (frozenCols > 0 && frozenRows > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, rowHeaderWidth, columnHeaderHeight);
    ctx.clip();

    currentY = 0;
    for (let rowIdx = 0; rowIdx < frozenRows && rowIdx < pivotView.rowCount; rowIdx++) {
      const rowHeight = rowHeights[rowIdx] || 24;

      let currentX = 0;
      for (let col = 0; col < frozenCols; col++) {
        const colWidth = columnWidths[col] || 100;
        const cell = pivotView.cells[rowIdx]?.[col];

        if (cell) {
          drawPivotCell(
            ctx,
            cell,
            { x: currentX, y: currentY, width: colWidth, height: rowHeight },
            { theme }
          );
        }

        currentX += colWidth;
      }
      currentY += rowHeight;
    }
    ctx.restore();
  }

  // 5. Draw separator lines for frozen panes
  ctx.strokeStyle = theme.separatorLine;
  ctx.lineWidth = 2;

  if (frozenCols > 0) {
    ctx.beginPath();
    ctx.moveTo(rowHeaderWidth, 0);
    ctx.lineTo(rowHeaderWidth, height);
    ctx.stroke();
  }

  if (frozenRows > 0) {
    ctx.beginPath();
    ctx.moveTo(0, columnHeaderHeight);
    ctx.lineTo(width, columnHeaderHeight);
    ctx.stroke();
  }

  return iconBoundsMap;
}

// ============================================================================
// HIT TESTING
// ============================================================================

/**
 * Check if a point is within an icon's bounds.
 */
export function hitTestPivotIcon(
  x: number,
  y: number,
  iconBounds: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    x >= iconBounds.x &&
    x <= iconBounds.x + iconBounds.width &&
    y >= iconBounds.y &&
    y <= iconBounds.y + iconBounds.height
  );
}

/**
 * Find which icon (if any) was clicked.
 */
export function findClickedPivotIcon(
  x: number,
  y: number,
  iconBoundsMap: Map<string, { x: number; y: number; width: number; height: number }>
): { row: number; col: number } | null {
  for (const [key, bounds] of iconBoundsMap.entries()) {
    if (hitTestPivotIcon(x, y, bounds)) {
      const [row, col] = key.split(",").map(Number);
      return { row, col };
    }
  }
  return null;
}