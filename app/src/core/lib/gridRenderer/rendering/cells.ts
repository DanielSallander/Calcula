// FILENAME: app/src/lib/gridRenderer/rendering/cells.ts
// PURPOSE: Cell text rendering with style support
// CONTEXT: Draws cell content with formatting, colors, and truncation
// UPDATED: Fixed property names to use camelCase matching TypeScript interfaces
// UPDATED: Added insertion animation support for smooth row/column insertion

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { getStyleFromCache, isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "../styles/styleUtils";
import { isNumericValue, isErrorValue } from "../styles/cellFormatting";
import { cellKey } from "../../../types";

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
 * Draw text content for all visible cells.
 * Applies cell styles from styleCache including colors, fonts, and formatting.
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
  
  // Calculate insertion animation offset
  const rowAnimOffset = insertionAnimation && insertionAnimation.type === "row"
    ? insertionAnimation.progress * insertionAnimation.targetSize * insertionAnimation.count
    : 0;
  const colAnimOffset = insertionAnimation && insertionAnimation.type === "column"
    ? insertionAnimation.progress * insertionAnimation.targetSize * insertionAnimation.count
    : 0;
  const rowAnimIndex = insertionAnimation?.type === "row" ? insertionAnimation.index : -1;
  const colAnimIndex = insertionAnimation?.type === "column" ? insertionAnimation.index : -1;
  
  // Debug: Log styleCache state once per render
  if (styleCache && styleCache.size > 1) {
    console.log(`[Render] Drawing cells with ${styleCache.size} styles in cache`);
  }
  
  // Iterate through visible cells
  let baseY = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);
    
    // Apply row insertion animation offset
    const y = row >= rowAnimIndex && rowAnimIndex >= 0 ? baseY + rowAnimOffset : baseY;
    
    let baseX = rowHeaderWidth + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);
      
      // Apply column insertion animation offset
      const x = col >= colAnimIndex && colAnimIndex >= 0 ? baseX + colAnimOffset : baseX;

      // Skip if this cell is being edited (the input field handles display)
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }

      // Look up cell data
      const key = cellKey(row, col);
      const cell = cells.get(key);

      // Skip empty cells
      if (!cell || cell.display === "") {
        baseX += colWidth;
        continue;
      }

      // Skip if cell is not visible
      if (x + colWidth < rowHeaderWidth || x > width || y + rowHeight < colHeaderHeight || y > height) {
        baseX += colWidth;
        continue;
      }

      // Calculate visible cell bounds
      const cellLeft = Math.max(x, rowHeaderWidth);
      const cellTop = Math.max(y, colHeaderHeight);
      const cellRight = Math.min(x + colWidth, width);
      const cellBottom = Math.min(y + rowHeight, height);

      // Available width for text
      const availableWidth = cellRight - cellLeft - paddingX * 2;

      if (availableWidth <= 0) {
        baseX += colWidth;
        continue;
      }

      // Get style data from the styleCache using the cell's styleIndex
      const styleIndex = cell.styleIndex ?? 0;
      const cellStyle = getStyleFromCache(styleCache, styleIndex);

      // Enhanced debug logging for cells with non-default styles
      if (styleIndex > 0) {
        console.log(`[Render] Cell (${row},${col}) styleIndex=${styleIndex}, display="${cell.display}":`, {
          bold: cellStyle.bold,
          italic: cellStyle.italic,
          underline: cellStyle.underline,
          textColor: cellStyle.textColor,
          backgroundColor: cellStyle.backgroundColor,
          numberFormat: cellStyle.numberFormat,
          isTextColorValid: isValidColor(cellStyle.textColor),
          isTextColorDefault: isDefaultTextColor(cellStyle.textColor),
          isBgColorValid: isValidColor(cellStyle.backgroundColor),
          isBgColorDefault: isDefaultBackgroundColor(cellStyle.backgroundColor),
        });
        
        // Debug trace for style application
        console.log(`[Render] >>> TRACE: About to apply style to cell (${row},${col})`);
        console.log(`[Render] >>> TRACE: Raw cellStyle object:`, cellStyle);
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

      // Apply all style properties from cellStyle
      // Font styling - boolean flags
      if (cellStyle.bold === true) {
        fontWeight = "bold";
      }
      if (cellStyle.italic === true) {
        fontStyle = "italic";
      }
      if (cellStyle.underline === true) {
        hasUnderline = true;
      }
      if (cellStyle.strikethrough === true) {
        hasStrikethrough = true;
      }
      
      // Font size - only apply if reasonable
      if (typeof cellStyle.fontSize === "number" && cellStyle.fontSize > 0 && cellStyle.fontSize < 200) {
        fontSize = cellStyle.fontSize;
      }
      
      // Font family - only apply if not empty
      if (typeof cellStyle.fontFamily === "string" && cellStyle.fontFamily.trim() !== "") {
        fontFamily = cellStyle.fontFamily;
      }
      
      // Text color - apply if valid and not default black
      const textColorValid = isValidColor(cellStyle.textColor);
      const textColorIsDefault = isDefaultTextColor(cellStyle.textColor);
      if (textColorValid && !textColorIsDefault) {
        textColor = cellStyle.textColor;
        if (styleIndex > 0) {
          console.log(`[Render] --> Applied text color to cell (${row},${col}): "${textColor}"`);
        }
      } else if (styleIndex > 0 && cellStyle.textColor) {
        console.log(`[Render] --> Text color NOT applied to cell (${row},${col}): valid=${textColorValid}, isDefault=${textColorIsDefault}, value="${cellStyle.textColor}"`);
      }
      
      // Background color - apply if valid and not default white/transparent
      const bgColorValid = isValidColor(cellStyle.backgroundColor);
      const bgColorIsDefault = isDefaultBackgroundColor(cellStyle.backgroundColor);
      if (bgColorValid && !bgColorIsDefault) {
        backgroundColor = cellStyle.backgroundColor;
        if (styleIndex > 0) {
          console.log(`[Render] --> Applied background color to cell (${row},${col}): "${backgroundColor}"`);
        }
      } else if (styleIndex > 0 && cellStyle.backgroundColor) {
        console.log(`[Render] --> Background color NOT applied to cell (${row},${col}): valid=${bgColorValid}, isDefault=${bgColorIsDefault}, value="${cellStyle.backgroundColor}"`);
      }
      
      // Text alignment from style
      if (cellStyle.textAlign === "left") {
        textAlign = "left";
      } else if (cellStyle.textAlign === "center") {
        textAlign = "center";
      } else if (cellStyle.textAlign === "right") {
        textAlign = "right";
      }
      // For "general" alignment, apply default based on value type below

      // Default alignment based on value type (only if alignment is "general" or not explicitly set)
      if (cellStyle.textAlign === "general" || cellStyle.textAlign === "") {
        if (isErrorValue(displayValue)) {
          // Errors override text color and use center alignment
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

      // Draw background color if set
      if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      }

      // Build font string
      const fontString = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.font = fontString;
      ctx.fillStyle = textColor;
      ctx.textAlign = "left"; // We handle alignment manually
      ctx.textBaseline = "middle";

      // Calculate text position
      const textX = cellLeft + paddingX;
      const textY = y + rowHeight / 2;

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