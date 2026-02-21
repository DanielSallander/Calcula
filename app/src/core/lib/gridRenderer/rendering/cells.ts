//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.ts
// PURPOSE: Cell text rendering with style support
// CONTEXT: Draws cell content with formatting, colors, and truncation
// UPDATED: Added style interceptor support for conditional formatting
// UPDATED: Added vertical alignment, text wrapping, text rotation, and empty cell background rendering

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
import {
  hasCellDecorations,
  applyCellDecorations,
} from "../../../../api/cellDecorations";

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
 * Break text into lines that fit within maxWidth.
 * Uses word-boundary wrapping with fallback to character wrapping for long words.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/(\s+)/); // Split keeping whitespace
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine + word;
    const testWidth = ctx.measureText(testLine).width;

    if (testWidth <= maxWidth || currentLine === "") {
      currentLine = testLine;
    } else {
      // Current line is full, push it and start new line
      if (currentLine.trim() !== "") {
        lines.push(currentLine);
      }
      // Check if the word itself is wider than maxWidth (needs character wrapping)
      if (ctx.measureText(word).width > maxWidth) {
        let remaining = word;
        while (remaining.length > 0) {
          let charCount = 1;
          while (charCount < remaining.length && ctx.measureText(remaining.substring(0, charCount + 1)).width <= maxWidth) {
            charCount++;
          }
          if (charCount < remaining.length) {
            lines.push(remaining.substring(0, charCount));
            remaining = remaining.substring(charCount);
          } else {
            currentLine = remaining;
            remaining = "";
          }
        }
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine.trim() !== "") {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Draw a single border line between two points with the given border style.
 */
function drawBorderLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  border: { style: string; color: string; width: number }
): void {
  ctx.save();
  ctx.strokeStyle = border.color;

  // Map style name to line width
  let lineWidth = 1;
  if (border.style === "medium") {
    lineWidth = 2;
  } else if (border.style === "thick") {
    lineWidth = 3;
  }
  ctx.lineWidth = lineWidth;

  // Set dash pattern
  if (border.style === "dashed") {
    ctx.setLineDash([4, 2]);
  } else if (border.style === "dotted") {
    ctx.setLineDash([1, 2]);
  } else {
    ctx.setLineDash([]);
  }

  if (border.style === "double") {
    // Double border: draw two lines with a gap
    const offset = 1.5;
    const isHorizontal = y1 === y2;

    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(x1, y1 - offset);
      ctx.lineTo(x2, y2 - offset);
    } else {
      ctx.moveTo(x1 - offset, y1);
      ctx.lineTo(x2 - offset, y2);
    }
    ctx.stroke();

    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(x1, y1 + offset);
      ctx.lineTo(x2, y2 + offset);
    } else {
      ctx.moveTo(x1 + offset, y1);
      ctx.lineTo(x2 + offset, y2);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.restore();
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
  const paddingY = 2;

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

      // No cell data at all - skip
      if (!cell) {
        baseX += colWidth;
        continue;
      }

      const displayValue = cell.display ?? "";
      const isEmpty = displayValue === "";

      // For empty cells with default style, skip entirely
      if (isEmpty) {
        const si = cell.styleIndex ?? 0;
        if (si === 0) {
          baseX += colWidth;
          continue;
        }
        // Cell has a non-default style - check if it has a visible background or borders
        const emptyStyle = getStyleFromCache(styleCache, si);
        const hasBg = isValidColor(emptyStyle.backgroundColor) && !isDefaultBackgroundColor(emptyStyle.backgroundColor);
        const hasBorder = (emptyStyle.borderTop && emptyStyle.borderTop.style !== "none" && emptyStyle.borderTop.width > 0) ||
          (emptyStyle.borderRight && emptyStyle.borderRight.style !== "none" && emptyStyle.borderRight.width > 0) ||
          (emptyStyle.borderBottom && emptyStyle.borderBottom.style !== "none" && emptyStyle.borderBottom.width > 0) ||
          (emptyStyle.borderLeft && emptyStyle.borderLeft.style !== "none" && emptyStyle.borderLeft.width > 0);
        if (!hasBg && !hasBorder) {
          baseX += colWidth;
          continue;
        }
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
          displayValue,
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

      // Draw cell borders
      const bTop = baseCellStyle.borderTop;
      const bRight = baseCellStyle.borderRight;
      const bBottom = baseCellStyle.borderBottom;
      const bLeft = baseCellStyle.borderLeft;

      if (bTop && bTop.style !== "none" && bTop.width > 0) {
        drawBorderLine(ctx, cellLeft, cellTop, cellRight, cellTop, bTop);
      }
      if (bBottom && bBottom.style !== "none" && bBottom.width > 0) {
        drawBorderLine(ctx, cellLeft, cellBottom, cellRight, cellBottom, bBottom);
      }
      if (bLeft && bLeft.style !== "none" && bLeft.width > 0) {
        drawBorderLine(ctx, cellLeft, cellTop, cellLeft, cellBottom, bLeft);
      }
      if (bRight && bRight.style !== "none" && bRight.width > 0) {
        drawBorderLine(ctx, cellRight, cellTop, cellRight, cellBottom, bRight);
      }

      // Draw cell decorations (e.g., sparklines) between background/borders and text
      if (hasCellDecorations()) {
        applyCellDecorations({ ctx, row, col, cellLeft, cellTop, cellRight, cellBottom, config, viewport, dimensions });
      }

      // If cell has no text to display, restore and skip text rendering
      if (isEmpty) {
        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // Build font string
      const fontString = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.font = fontString;
      ctx.fillStyle = textColor;
      ctx.textAlign = "left";

      // Get vertical alignment and text rotation from style
      const vAlign = baseCellStyle.verticalAlign || "middle";
      const textRotation = baseCellStyle.textRotation || "none";

      // -----------------------------------------------------------------------
      // Text Rotation
      // -----------------------------------------------------------------------
      if (textRotation !== "none" && textRotation !== "0") {
        let angleDeg = 0;
        if (textRotation === "rotate90" || textRotation === "90") {
          angleDeg = -90;
        } else if (textRotation === "rotate270" || textRotation === "270" || textRotation === "-90") {
          angleDeg = 90;
        } else if (textRotation.startsWith("custom:")) {
          angleDeg = -(parseInt(textRotation.substring(7), 10) || 0);
        }

        if (angleDeg !== 0) {
          const angleRad = (angleDeg * Math.PI) / 180;
          const centerX = (cellLeft + cellRight) / 2;
          const centerY = (cellTop + cellBottom) / 2;

          ctx.translate(centerX, centerY);
          ctx.rotate(angleRad);

          // For rotated text, use available height as the "width" for truncation
          const rotatedMaxWidth = cellBottom - cellTop - paddingY * 2;
          ctx.textBaseline = "middle";
          drawTextWithTruncation(ctx, displayValue, -rotatedMaxWidth / 2, 0, rotatedMaxWidth, textAlign);

          // Reset transform (restore handles this)
          ctx.restore();
          baseX += colWidth;
          continue;
        }
      }

      // -----------------------------------------------------------------------
      // Text Wrapping
      // -----------------------------------------------------------------------
      const shouldWrap = baseCellStyle.wrapText === true;

      if (shouldWrap) {
        const lines = wrapText(ctx, displayValue, availableWidth);
        const lineHeight = fontSize * 1.2;
        const totalTextHeight = lines.length * lineHeight;
        const cellHeight = cellBottom - cellTop;

        // Calculate starting Y based on vertical alignment
        let startY: number;
        if (vAlign === "top") {
          startY = cellTop + paddingY + lineHeight / 2;
        } else if (vAlign === "bottom") {
          startY = cellBottom - paddingY - totalTextHeight + lineHeight / 2;
        } else {
          // middle
          startY = cellTop + (cellHeight - totalTextHeight) / 2 + lineHeight / 2;
        }

        ctx.textBaseline = "middle";

        for (let i = 0; i < lines.length; i++) {
          const lineY = startY + i * lineHeight;
          // Stop drawing lines that are below the cell
          if (lineY - lineHeight / 2 > cellBottom) break;
          // Skip lines above the cell
          if (lineY + lineHeight / 2 < cellTop) continue;

          const textX = cellLeft + paddingX;
          drawTextWithTruncation(ctx, lines[i], textX, lineY, availableWidth, textAlign);
        }

        ctx.restore();
        baseX += colWidth;
        continue;
      }

      // -----------------------------------------------------------------------
      // Standard (single-line) rendering with vertical alignment
      // -----------------------------------------------------------------------
      const textX = cellLeft + paddingX;
      let textY: number;

      if (vAlign === "top") {
        ctx.textBaseline = "top";
        textY = cellTop + paddingY;
      } else if (vAlign === "bottom") {
        ctx.textBaseline = "bottom";
        textY = cellBottom - paddingY;
      } else {
        // "middle" (default)
        ctx.textBaseline = "middle";
        textY = y + actualHeight / 2;
      }

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
        // Position underline relative to baseline
        let underlineY: number;
        if (vAlign === "top") {
          underlineY = cellTop + paddingY + fontSize + 1;
        } else if (vAlign === "bottom") {
          underlineY = cellBottom - paddingY + 1;
        } else {
          underlineY = textY + fontSize / 2 + 1;
        }
        ctx.beginPath();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.moveTo(underlineX, underlineY);
        ctx.lineTo(underlineX + textWidth, underlineY);
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
        // Position strikethrough at vertical center of text
        let strikeY: number;
        if (vAlign === "top") {
          strikeY = cellTop + paddingY + fontSize / 2;
        } else if (vAlign === "bottom") {
          strikeY = cellBottom - paddingY - fontSize / 2;
        } else {
          strikeY = textY;
        }
        ctx.beginPath();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.moveTo(strikeX, strikeY);
        ctx.lineTo(strikeX + textWidth, strikeY);
        ctx.stroke();
      }

      ctx.restore();

      baseX += colWidth;
    }

    baseY += rowHeight;
  }
}
