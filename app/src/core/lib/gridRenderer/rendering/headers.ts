//! FILENAME: app/src/core/lib/gridRenderer/rendering/headers.ts
//PURPOSE: Drawing functions for row and column headers
//CONTEXT: Renders header cells with highlighting and borders
//UPDATED: Added freeze pane support for proper header positioning

import type { RenderState } from "../types";
import { calculateVisibleRange, calculateFreezePaneLayout } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { columnToLetter } from "../../../types";

/**
 * Draw the corner cell (intersection of row and column headers).
 */
export function drawCorner(state: RenderState): void {
  const { ctx, config, theme } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // Background
  ctx.fillStyle = theme.cornerBackground;
  ctx.fillRect(0, 0, rowHeaderWidth, colHeaderHeight);

  // Border
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, rowHeaderWidth - 1, colHeaderHeight - 1);
}

/**
 * Draw the column headers (A, B, C, ...).
 * Supports freeze panes - frozen column headers are drawn at fixed positions.
 */
export function drawColumnHeaders(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, selection, dimensions, freezeConfig, insertionAnimation } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;

  // Calculate column insertion/deletion animation offset (same logic as cells.ts)
  let colAnimOffset = 0;
  let colAnimIndex = -1;
  if (insertionAnimation && insertionAnimation.type === "column") {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;
    colAnimIndex = insertionAnimation.index;
    colAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
  }

  // Draw header background
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(rowHeaderWidth, 0, width - rowHeaderWidth, colHeaderHeight);

  // Set up text rendering
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Normalize selection for highlighting
  let selMinCol = -1;
  let selMaxCol = -1;
  let isEntireColumnSelected = false;

  if (selection) {
    selMinCol = Math.min(selection.startCol, selection.endCol);
    selMaxCol = Math.max(selection.startCol, selection.endCol);
    isEntireColumnSelected = selection.type === "columns";
  }

  // Check for freeze panes
  const hasFrozenCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  const freezeCol = hasFrozenCols ? freezeConfig!.freezeCol! : 0;
  
  if (hasFrozenCols) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    
    // 1. Draw frozen column headers (no scroll, fixed position)
    let x = rowHeaderWidth;
    for (let col = 0; col < freezeCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);
      
      // Highlight if column is in selection
      const isSelected = col >= selMinCol && col <= selMaxCol;
      const isFullySelected = isSelected && isEntireColumnSelected;

      if (isFullySelected) {
        ctx.fillStyle = theme.headerHighlight;
        ctx.fillRect(x, 0, colWidth, colHeaderHeight);
      } else if (isSelected) {
        ctx.fillStyle = "#e3ecf7";
        ctx.fillRect(x, 0, colWidth, colHeaderHeight);
      }

      // Draw border
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + colWidth + 0.5, 0);
      ctx.lineTo(x + colWidth + 0.5, colHeaderHeight);
      ctx.stroke();

      // Draw column letter
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : theme.headerText;
      ctx.fillText(columnToLetter(col), x + colWidth / 2, colHeaderHeight / 2);

      x += colWidth;
    }

    // Draw freeze pane separator line on headers
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rowHeaderWidth + layout.frozenColsWidth, 0);
    ctx.lineTo(rowHeaderWidth + layout.frozenColsWidth, colHeaderHeight);
    ctx.stroke();
    
    // 2. Draw scrollable column headers (with scroll offset, clipped)
    const scrollableStartX = rowHeaderWidth + layout.frozenColsWidth;
    const scrollableWidth = width - scrollableStartX;
    
    if (scrollableWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(scrollableStartX, 0, scrollableWidth, colHeaderHeight);
      ctx.clip();
      
      // Calculate visible range for scrollable area
      const scrollX = viewport.scrollX || 0;
      
      // Find first visible scrollable column
      let accumulatedWidth = 0;
      let startCol = freezeCol;
      while (startCol < totalCols) {
        const colWidth = getColumnWidth(startCol, config, dimensions);
        if (colWidth <= 0) break;
        if (accumulatedWidth + colWidth > scrollX) {
          break;
        }
        accumulatedWidth += colWidth;
        startCol++;
      }
      const offsetX = -(scrollX - accumulatedWidth);
      
      // Find end column
      let endCol = startCol;
      let widthAccum = offsetX;
      while (endCol < totalCols && widthAccum < scrollableWidth) {
        widthAccum += getColumnWidth(endCol, config, dimensions);
        endCol++;
      }
      
      // Draw scrollable headers
      x = scrollableStartX + offsetX;
      for (let col = startCol; col <= endCol && col < totalCols; col++) {
        const colWidth = getColumnWidth(col, config, dimensions);
        
        // Skip if completely outside visible area
        if (x + colWidth < scrollableStartX || x > width) {
          x += colWidth;
          continue;
        }

        // Highlight if column is in selection
        const isSelected = col >= selMinCol && col <= selMaxCol;
        const isFullySelected = isSelected && isEntireColumnSelected;

        if (isFullySelected) {
          ctx.fillStyle = theme.headerHighlight;
          ctx.fillRect(x, 0, colWidth, colHeaderHeight);
        } else if (isSelected) {
          ctx.fillStyle = "#e3ecf7";
          ctx.fillRect(x, 0, colWidth, colHeaderHeight);
        }

        // Draw border
        ctx.strokeStyle = theme.headerBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + colWidth + 0.5, 0);
        ctx.lineTo(x + colWidth + 0.5, colHeaderHeight);
        ctx.stroke();

        // Draw column letter
        ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : theme.headerText;
        ctx.fillText(columnToLetter(col), x + colWidth / 2, colHeaderHeight / 2);

        x += colWidth;
      }

      ctx.restore();
    }
  } else {
    // Standard rendering without freeze panes
    const range = calculateVisibleRange(viewport, config, width, height, dimensions);

    // Clip column headers to the header area (prevents animation overflow into row headers)
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderWidth, 0, width - rowHeaderWidth, colHeaderHeight);
    ctx.clip();

    let baseX = rowHeaderWidth + range.offsetX;

    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);

      // Apply animation offset for columns at or after the change point
      const x = col >= colAnimIndex && colAnimIndex >= 0 ? baseX + colAnimOffset : baseX;

      // Skip if outside visible area
      if (x + colWidth < rowHeaderWidth || x > width) {
        baseX += colWidth;
        continue;
      }

      // Highlight if column is in selection
      const isSelected = col >= selMinCol && col <= selMaxCol;
      const isFullySelected = isSelected && isEntireColumnSelected;

      if (isFullySelected) {
        ctx.fillStyle = theme.headerHighlight;
        ctx.fillRect(x, 0, colWidth, colHeaderHeight);
      } else if (isSelected) {
        ctx.fillStyle = "#e3ecf7";
        ctx.fillRect(x, 0, colWidth, colHeaderHeight);
      }

      // Draw border
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + colWidth + 0.5, 0);
      ctx.lineTo(x + colWidth + 0.5, colHeaderHeight);
      ctx.stroke();

      // Draw column letter
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : theme.headerText;
      ctx.fillText(columnToLetter(col), x + colWidth / 2, colHeaderHeight / 2);

      baseX += colWidth;
    }

    ctx.restore();
  }

  // Draw bottom border of header row
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rowHeaderWidth, colHeaderHeight + 0.5);
  ctx.lineTo(width, colHeaderHeight + 0.5);
  ctx.stroke();
}

/**
 * Draw the row headers (1, 2, 3, ...).
 * Supports freeze panes - frozen row headers are drawn at fixed positions.
 */
export function drawRowHeaders(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, selection, dimensions, freezeConfig, insertionAnimation } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;

  // Calculate row insertion/deletion animation offset (same logic as cells.ts)
  let rowAnimOffset = 0;
  let rowAnimIndex = -1;
  if (insertionAnimation && insertionAnimation.type === "row") {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;
    rowAnimIndex = insertionAnimation.index;
    rowAnimOffset = insertionAnimation.direction === "insert" ? -remainingOffset : remainingOffset;
  }

  // Draw header background
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, colHeaderHeight, rowHeaderWidth, height - colHeaderHeight);

  // Set up text rendering
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Normalize selection for highlighting
  let selMinRow = -1;
  let selMaxRow = -1;
  let isEntireRowSelected = false;

  if (selection) {
    selMinRow = Math.min(selection.startRow, selection.endRow);
    selMaxRow = Math.max(selection.startRow, selection.endRow);
    isEntireRowSelected = selection.type === "rows";
  }

  // When rows are hidden (e.g. by AutoFilter), show row numbers in blue
  const hasHiddenRows = dimensions && dimensions.hiddenRows && dimensions.hiddenRows.size > 0;
  const filteredTextColor = "#0066cc";

  // Check for freeze panes
  const hasFrozenRows = freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;
  const freezeRow = hasFrozenRows ? freezeConfig!.freezeRow! : 0;
  
  if (hasFrozenRows) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    
    // 1. Draw frozen row headers (no scroll, fixed position)
    let y = colHeaderHeight;
    for (let row = 0; row < freezeRow && row < totalRows; row++) {
      const rowHeight = getRowHeight(row, config, dimensions);
      if (rowHeight <= 0) continue; // Skip hidden rows

      // Highlight if row is in selection
      const isSelected = row >= selMinRow && row <= selMaxRow;
      const isFullySelected = isSelected && isEntireRowSelected;

      if (isFullySelected) {
        ctx.fillStyle = theme.headerHighlight;
        ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
      } else if (isSelected) {
        ctx.fillStyle = "#e3ecf7";
        ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
      }

      // Draw border
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + rowHeight + 0.5);
      ctx.lineTo(rowHeaderWidth, y + rowHeight + 0.5);
      ctx.stroke();

      // Draw row number (1-based)
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenRows ? filteredTextColor : theme.headerText;
      ctx.fillText(String(row + 1), rowHeaderWidth / 2, y + rowHeight / 2);

      y += rowHeight;
    }
    
    // Draw freeze pane separator line on headers
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, colHeaderHeight + layout.frozenRowsHeight);
    ctx.lineTo(rowHeaderWidth, colHeaderHeight + layout.frozenRowsHeight);
    ctx.stroke();
    
    // 2. Draw scrollable row headers (with scroll offset, clipped)
    const scrollableStartY = colHeaderHeight + layout.frozenRowsHeight;
    const scrollableHeight = height - scrollableStartY;
    
    if (scrollableHeight > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, scrollableStartY, rowHeaderWidth, scrollableHeight);
      ctx.clip();
      
      // Calculate visible range for scrollable area
      const scrollY = viewport.scrollY || 0;
      
      // Find first visible scrollable row
      let accumulatedHeight = 0;
      let startRow = freezeRow;
      while (startRow < totalRows) {
        const rowHeight = getRowHeight(startRow, config, dimensions);
        if (rowHeight <= 0) { startRow++; continue; } // Skip hidden rows
        if (accumulatedHeight + rowHeight > scrollY) {
          break;
        }
        accumulatedHeight += rowHeight;
        startRow++;
      }
      const offsetY = -(scrollY - accumulatedHeight);

      // Find end row
      let endRow = startRow;
      let heightAccum = offsetY;
      while (endRow < totalRows && heightAccum < scrollableHeight) {
        const rowHeight = getRowHeight(endRow, config, dimensions);
        if (rowHeight <= 0) { endRow++; continue; } // Skip hidden rows
        heightAccum += rowHeight;
        endRow++;
      }
      
      // Draw scrollable headers
      y = scrollableStartY + offsetY;
      for (let row = startRow; row <= endRow && row < totalRows; row++) {
        const rowHeight = getRowHeight(row, config, dimensions);
        if (rowHeight <= 0) continue; // Skip hidden rows

        // Skip if completely outside visible area
        if (y + rowHeight < scrollableStartY || y > height) {
          y += rowHeight;
          continue;
        }

        // Highlight if row is in selection
        const isSelected = row >= selMinRow && row <= selMaxRow;
        const isFullySelected = isSelected && isEntireRowSelected;

        if (isFullySelected) {
          ctx.fillStyle = theme.headerHighlight;
          ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
        } else if (isSelected) {
          ctx.fillStyle = "#e3ecf7";
          ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
        }

        // Draw border
        ctx.strokeStyle = theme.headerBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + rowHeight + 0.5);
        ctx.lineTo(rowHeaderWidth, y + rowHeight + 0.5);
        ctx.stroke();

        // Draw row number (1-based)
        ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenRows ? filteredTextColor : theme.headerText;
        ctx.fillText(String(row + 1), rowHeaderWidth / 2, y + rowHeight / 2);

        y += rowHeight;
      }
      
      ctx.restore();
    }
  } else {
    // Standard rendering without freeze panes
    const range = calculateVisibleRange(viewport, config, width, height, dimensions);

    // Clip row headers to the header area (prevents animation overflow into column headers)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, colHeaderHeight, rowHeaderWidth, height - colHeaderHeight);
    ctx.clip();

    let baseY = colHeaderHeight + range.offsetY;

    for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
      const rowHeight = getRowHeight(row, config, dimensions);
      if (rowHeight <= 0) continue; // Skip hidden rows

      // Apply animation offset for rows at or after the change point
      const y = row >= rowAnimIndex && rowAnimIndex >= 0 ? baseY + rowAnimOffset : baseY;

      // Skip if outside visible area
      if (y + rowHeight < colHeaderHeight || y > height) {
        baseY += rowHeight;
        continue;
      }

      // Highlight if row is in selection
      const isSelected = row >= selMinRow && row <= selMaxRow;
      const isFullySelected = isSelected && isEntireRowSelected;

      if (isFullySelected) {
        ctx.fillStyle = theme.headerHighlight;
        ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
      } else if (isSelected) {
        ctx.fillStyle = "#e3ecf7";
        ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
      }

      // Draw border
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + rowHeight + 0.5);
      ctx.lineTo(rowHeaderWidth, y + rowHeight + 0.5);
      ctx.stroke();

      // Draw row number (1-based)
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenRows ? filteredTextColor : theme.headerText;
      ctx.fillText(String(row + 1), rowHeaderWidth / 2, y + rowHeight / 2);

      baseY += rowHeight;
    }

    ctx.restore();
  }
  
  // Draw right border of header column
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rowHeaderWidth + 0.5, colHeaderHeight);
  ctx.lineTo(rowHeaderWidth + 0.5, height);
  ctx.stroke();
}