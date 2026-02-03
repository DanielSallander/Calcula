//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.ts
// PURPOSE: Cell text rendering with style support
// CONTEXT: Draws cell content with formatting, colors, and truncation
// UPDATED: Added style interceptor support for conditional formatting

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { getStyleFromCache, isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "../styles/styleUtils";
import { isNumericValue, isErrorValue } from "../styles/cellFormatting";
import { cellKey } from "../../../types";
import { 
  hasStyleInterceptors, 
  applyStyleInterceptors,
  type BaseStyleInfo 
} from "../../../../api/styleInterceptors";

/**
 * Draw text with ellipsis truncation if it exceeds the available width.
 * Returns the measured width of the full text.
 */
export function drawTextWithTruncation(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: "left" | "right" | "center" = "left"
): number {
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  // If text fits, draw it directly
  if (textWidth <= maxWidth) {
    let drawX = x;
    if (align === "right") {
      drawX = x + maxWidth - textWidth;
    } else if (align === "center") {
      drawX = x + (maxWidth - textWidth) / 2;
    }
    ctx.fillText(text, drawX, y);
    return textWidth;
  }
  // Text needs truncation - use ellipsis
  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const availableWidth = maxWidth - ellipsisWidth;
  if (availableWidth <= 0) {
    // Not enough room even for ellipsis, just draw ellipsis
    ctx.fillText(ellipsis, x, y);
    return ellipsisWidth;
  }
  // Binary search for the right truncation point
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const truncated = text.substring(0, mid);
    const truncWidth = ctx.measureText(truncated).width;
    if (truncWidth <= availableWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const truncatedText = text.substring(0, low) + ellipsis;
  ctx.fillText(truncatedText, x, y);
  return textWidth; // Return original width for potential overflow indication
}

/**
 * Calculate the total width of a merged cell spanning multiple columns.
 */
function getMergedCellWidth(
  startCol: number,
  colSpan: number,
  config: RenderState["config"],
  dimensions: RenderState["dimensions"]
): number {
  let totalWidth = 0;
  for (let c = startCol; c < startCol + colSpan; c++) {
    totalWidth += getColumnWidth(c, config, dimensions);
  }
  return totalWidth;
}

/**
 * Calculate the total height of a merged cell spanning multiple rows.
 */
function getMergedCellHeight(
  startRow: number,
  rowSpan: number,
  config: RenderState["config"],
  dimensions: RenderState["dimensions"]
): number {
  let totalHeight = 0;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    totalHeight += getRowHeight(r, config, dimensions);
  }
  return totalHeight;
}

/**
 * Check if a cell is a "slave" cell (part of a merge but not the master).
 * Returns the master cell's key if it is, null otherwise.
 */
function getMasterCellKey(
  row: number,
  col: number,
  cells: Map<string, { rowSpan?: number; colSpan?: number }>
): string | null {
  // Check all cells to see if any merge region covers this cell
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    
    if (rowSpan > 1 || colSpan > 1) {
      // This is a master cell - parse its position
      const parts = key.split(",");
      const masterRow = parseInt(parts[0], 10);
      const masterCol = parseInt(parts[1], 10);
      
      // Check if the target cell is within this merge region (but not the master itself)
      if (
        row >= masterRow &&
        row < masterRow + rowSpan &&
        col >= masterCol &&
        col < masterCol + colSpan &&
        !(row === masterRow && col === masterCol)
      ) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Draw text content for all visible cells.
 * Applies cell styles from styleCache including colors, fonts, and formatting.
 * Handles merged cells by drawing master cells with expanded dimensions.
 * Applies style interceptors for features like conditional formatting.
 */
export function drawCellText(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, cells, editing, dimensions, styleCache, insertionAnimation } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  
  // Padding inside cells
  const paddingX = 4;
  
  // Check if we need to run style interceptors
  const useInterceptors = hasStyleInterceptors();
  
  // Calculate insertion/deletion animation offset
  let rowAnimOffset = 0;
  let colAnimOffset = 0;
  let rowAnimIndex = -1;
  let colAnimIndex = -1;
  
  if (insertionAnimation) {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;
    
    if (insertionAnimation.type === "row") {
      rowAnimIndex = insertionAnimation.index;
      rowAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
    } else {
      colAnimIndex = insertionAnimation.index;
      colAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
    }
  }
  
  // Track which cells we've already drawn (to avoid drawing slave cells)
  const drawnCells = new Set<string>();
  
  // Iterate through visible cells
  let baseY = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);
    
    // Apply row animation offset for rows at or after the change point
    const y = row >= rowAnimIndex && rowAnimIndex >= 0 ? baseY + rowAnimOffset : baseY;
    
    let baseX = rowHeaderWidth + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);
      
      // Apply column animation offset for columns at or after the change point
      const x = col >= colAnimIndex && colAnimIndex >= 0 ? baseX + colAnimOffset : baseX;

      const key = cellKey(row, col);
      
      // Skip if already drawn (slave cells)
      if (drawnCells.has(key)) {
        baseX += colWidth;
        continue;
      }

      // Check if this cell is a slave (part of another cell's merge)
      const masterKey = getMasterCellKey(row, col, cells as Map<string, { rowSpan?: number; colSpan?: number }>);
      if (masterKey) {
        // This is a slave cell - skip rendering
        drawnCells.add(key);
        baseX += colWidth;
        continue;
      }

      // Skip if this cell is being edited (the input field handles display)
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }

      // Look up cell data
      const cell = cells.get(key);

      // Skip empty cells
      if (!cell || cell.display === "") {
        baseX += colWidth;
        continue;
      }

      // Get merge spans
      const rowSpan = (cell as { rowSpan?: number }).rowSpan ?? 1;
      const colSpan = (cell as { colSpan?: number }).colSpan ?? 1;
      
      // Calculate actual cell dimensions (may span multiple cells)
      const actualWidth = colSpan > 1 
        ? getMergedCellWidth(col, colSpan, config, dimensions)
        : colWidth;
      const actualHeight = rowSpan > 1
        ? getMergedCellHeight(row, rowSpan, config, dimensions)
        : rowHeight;

      // Mark all cells in the merge region as drawn
      if (rowSpan > 1 || colSpan > 1) {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            drawnCells.add(cellKey(r, c));
          }
        }
      }

      // Skip if cell is not visible (considering animation offset)
      if (x + actualWidth < rowHeaderWidth || x > width || y + actualHeight < colHeaderHeight || y > height) {
        baseX += colWidth;
        continue;
      }

      // Calculate visible cell bounds
      const cellLeft = Math.max(x, rowHeaderWidth);
      const cellTop = Math.max(y, colHeaderHeight);
      const cellRight = Math.min(x + actualWidth, width);
      const cellBottom = Math.min(y + actualHeight, height);

      // Available width for text
      const availableWidth = cellRight - cellLeft - paddingX * 2;

      if (availableWidth <= 0) {
        baseX += colWidth;
        continue;
      }

      // Get style data from the styleCache using the cell's styleIndex
      const styleIndex = cell.styleIndex ?? 0;
      const baseCellStyle = getStyleFromCache(styleCache, styleIndex);

      // Build base style info for interceptors
      let effectiveStyle: BaseStyleInfo = {
        styleIndex,
        backgroundColor: baseCellStyle.backgroundColor,
        textColor: baseCellStyle.textColor,
        bold: baseCellStyle.bold,
        italic: baseCellStyle.italic,
        underline: baseCellStyle.underline,
        strikethrough: baseCellStyle.strikethrough,
        fontSize: baseCellStyle.fontSize,
        fontFamily: baseCellStyle.fontFamily,
      };

      // Apply style interceptors (e.g., conditional formatting)
      if (useInterceptors) {
        effectiveStyle = applyStyleInterceptors(
          cell.display,
          effectiveStyle,
          { row, col }
        );
      }

      // Initialize style variables with theme defaults
      let textColor = theme.cellText;
      let backgroundColor: string | null = null;
      let textAlign: "left" | "right" | "center" = "left";
      let fontWeight = "normal";
      let fontStyle = "normal";
      let fontSize = theme.cellFontSize;
      let fontFamily = theme.cellFontFamily;
      let hasUnderline = false;
      let hasStrikethrough = false;

      const displayValue = cell.display;

      // Apply all style properties from effectiveStyle (includes interceptor overrides)
      if (effectiveStyle.bold === true) {
        fontWeight = "bold";
      }
      if (effectiveStyle.italic === true) {
        fontStyle = "italic";
      }
      if (effectiveStyle.underline === true) {
        hasUnderline = true;
      }
      if (effectiveStyle.strikethrough === true) {
        hasStrikethrough = true;
      }
      
      if (typeof effectiveStyle.fontSize === "number" && effectiveStyle.fontSize > 0 && effectiveStyle.fontSize < 200) {
        fontSize = effectiveStyle.fontSize;
      }
      
      if (typeof effectiveStyle.fontFamily === "string" && effectiveStyle.fontFamily.trim() !== "") {
        fontFamily = effectiveStyle.fontFamily;
      }
      
      const textColorValid = isValidColor(effectiveStyle.textColor);
      const textColorIsDefault = isDefaultTextColor(effectiveStyle.textColor);
      if (textColorValid && !textColorIsDefault) {
        textColor = effectiveStyle.textColor!;
      }
      
      const bgColorValid = isValidColor(effectiveStyle.backgroundColor);
      const bgColorIsDefault = isDefaultBackgroundColor(effectiveStyle.backgroundColor);
      if (bgColorValid && !bgColorIsDefault) {
        backgroundColor = effectiveStyle.backgroundColor!;
      }
      
      // Get textAlign from base style (interceptors don't modify alignment)
      if (baseCellStyle.textAlign === "left") {
        textAlign = "left";
      } else if (baseCellStyle.textAlign === "center") {
        textAlign = "center";
      } else if (baseCellStyle.textAlign === "right") {
        textAlign = "right";
      }

      if (baseCellStyle.textAlign === "general" || baseCellStyle.textAlign === "") {
        if (isErrorValue(displayValue)) {
          textColor = theme.cellTextError;
          textAlign = "center";
        } else if (isNumericValue(displayValue)) {
          textAlign = "right";
        }
      }

      // Set up clipping region to prevent text overflow
      ctx.save();
      ctx.beginPath();
      ctx.rect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      ctx.clip();

      // Draw background color if set (covers entire merged area)
      if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      }

      // Build font string
      const fontString = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.font = fontString;
      ctx.fillStyle = textColor;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      // Calculate text position (center vertically in merged cell)
      const textX = cellLeft + paddingX;
      const textY = y + actualHeight / 2;

      // Draw the text with truncation
      drawTextWithTruncation(ctx, displayValue, textX, textY, availableWidth, textAlign);

      // Draw underline if needed
      if (hasUnderline) {
        const metrics = ctx.measureText(displayValue);
        const textWidth = Math.min(metrics.width, availableWidth);
        let underlineX = textX;
        if (textAlign === "right") {
          underlineX = textX + availableWidth - textWidth;
        } else if (textAlign === "center") {
          underlineX = textX + (availableWidth - textWidth) / 2;
        }
        ctx.beginPath();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.moveTo(underlineX, textY + fontSize / 2 + 1);
        ctx.lineTo(underlineX + textWidth, textY + fontSize / 2 + 1);
        ctx.stroke();
      }

      // Draw strikethrough if needed
      if (hasStrikethrough) {
        const metrics = ctx.measureText(displayValue);
        const textWidth = Math.min(metrics.width, availableWidth);
        let strikeX = textX;
        if (textAlign === "right") {
          strikeX = textX + availableWidth - textWidth;
        } else if (textAlign === "center") {
          strikeX = textX + (availableWidth - textWidth) / 2;
        }
        ctx.beginPath();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.moveTo(strikeX, textY);
        ctx.lineTo(strikeX + textWidth, textY);
        ctx.stroke();
      }

      ctx.restore();

      baseX += colWidth;
    }

    baseY += rowHeight;
  }
}