//! FILENAME: app/src/core/lib/gridRenderer/rendering/headers.ts
//PURPOSE: Drawing functions for row and column headers
//CONTEXT: Renders header cells with highlighting and borders
//UPDATED: Added freeze pane support for proper header positioning

import type { RenderState } from "../types";
import type { DimensionOverrides } from "../../../types";
import { calculateVisibleRange, calculateFreezePaneLayout } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { columnToLetter } from "../../../types";
import { getColumnHeaderOverride, type ColumnHeaderOverride } from "../../../../api/columnHeaderOverrides";

/** Color for the double-line indicator drawn at hidden row/column boundaries. */
const HIDDEN_INDICATOR_COLOR = "#4a4a4a";
/** Line width for the hidden boundary indicator. */
const HIDDEN_INDICATOR_WIDTH = 2;

/** Size of the filter dropdown button drawn in column headers. */
const FILTER_BUTTON_SIZE = 10;
/** Margin from the right edge for the filter button. */
const FILTER_BUTTON_MARGIN = 3;

/**
 * Draw a small filter dropdown chevron in a column header cell.
 */
function drawHeaderFilterButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  colWidth: number,
  colHeaderHeight: number,
  override: ColumnHeaderOverride,
): void {
  const btnX = x + colWidth - FILTER_BUTTON_SIZE - FILTER_BUTTON_MARGIN;
  const btnY = (colHeaderHeight - FILTER_BUTTON_SIZE) / 2;
  const centerX = btnX + FILTER_BUTTON_SIZE / 2;
  const centerY = btnY + FILTER_BUTTON_SIZE / 2;

  // Draw chevron (downward arrow)
  ctx.beginPath();
  ctx.moveTo(centerX - 3, centerY - 1);
  ctx.lineTo(centerX, centerY + 2);
  ctx.lineTo(centerX + 3, centerY - 1);
  ctx.strokeStyle = override.hasActiveFilter ? "#1a73e8" : "#666666";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Check if the next column after `col` is hidden (for drawing double-line indicator).
 * Scans forward to see if at least one immediately following column is hidden.
 */
function hasHiddenColAfter(col: number, dims?: DimensionOverrides): boolean {
  if (!dims?.hiddenCols || dims.hiddenCols.size === 0) return false;
  return dims.hiddenCols.has(col + 1);
}

/**
 * Check if the next row after `row` is hidden (for drawing double-line indicator).
 */
function hasHiddenRowAfter(row: number, dims?: DimensionOverrides): boolean {
  if (!dims?.hiddenRows || dims.hiddenRows.size === 0) return false;
  return dims.hiddenRows.has(row + 1);
}

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
  const { ctx, width, height, config, viewport, theme, selection, dimensions, freezeConfig, insertionAnimation, splitBarSize = 0, splitViewport, referenceStyle } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  // In R1C1 mode, show column numbers (1-based) instead of letters
  const isR1C1 = referenceStyle === "R1C1";
  const getColLabel = (col: number): string => isR1C1 ? String(col + 1) : columnToLetter(col);
  const outlineBarH = config.outlineBarHeight ?? 0;
  const colLetterY = outlineBarH > 0
    ? outlineBarH + (colHeaderHeight - outlineBarH) / 2
    : colHeaderHeight / 2;
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

  // Calculate the first visible row for column header override detection.
  // Used by extensions (e.g., Table) to show field names when the header row
  // has scrolled above the viewport.
  const visRange = calculateVisibleRange(viewport, config, width, height, dimensions);
  const viewportStartRow = visRange.startRow;

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

  // When columns are hidden, show column letters in blue (like rows)
  const hasHiddenCols = dimensions && dimensions.hiddenCols && dimensions.hiddenCols.size > 0;
  const filteredColTextColor = "#0066cc";

  // Check for freeze panes
  const hasFrozenCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  const freezeCol = hasFrozenCols ? freezeConfig!.freezeCol! : 0;
  // Split mode: left section is independently scrollable
  const isSplitMode = splitBarSize > 0 && splitViewport;

  // Helper to draw a single column header
  const drawColHeader = (col: number, x: number, cw: number) => {
    const isSelected = col >= selMinCol && col <= selMaxCol;
    const isFullySelected = isSelected && isEntireColumnSelected;
    if (isFullySelected) {
      ctx.fillStyle = theme.headerHighlight;
      ctx.fillRect(x, 0, cw, colHeaderHeight);
    } else if (isSelected) {
      ctx.fillStyle = "#e3ecf7";
      ctx.fillRect(x, 0, cw, colHeaderHeight);
    }
    ctx.strokeStyle = theme.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + cw + 0.5, 0);
    ctx.lineTo(x + cw + 0.5, colHeaderHeight);
    ctx.stroke();
    if (hasHiddenColAfter(col, dimensions)) {
      ctx.strokeStyle = HIDDEN_INDICATOR_COLOR;
      ctx.lineWidth = HIDDEN_INDICATOR_WIDTH;
      ctx.beginPath();
      ctx.moveTo(x + cw + 0.5, 0);
      ctx.lineTo(x + cw + 0.5, colHeaderHeight);
      ctx.stroke();
    }
    const override = getColumnHeaderOverride(col, viewportStartRow);
    ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenCols ? filteredColTextColor : theme.headerText;
    if (override) {
      const maxTextW = override.showFilterButton ? cw - FILTER_BUTTON_SIZE - FILTER_BUTTON_MARGIN * 2 : cw - 4;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, cw, colHeaderHeight);
      ctx.clip();
      ctx.fillText(override.text, x + Math.min(cw, maxTextW) / 2, colLetterY);
      if (override.showFilterButton) {
        drawHeaderFilterButton(ctx, x, cw, colHeaderHeight, override);
      }
      ctx.restore();
    } else {
      ctx.fillText(getColLabel(col), x + cw / 2, colLetterY);
    }
  };

  // Helper to draw a scrollable section of column headers
  const drawScrollableColHeaders = (
    sectionStartX: number,
    sectionWidth: number,
    scrollX: number,
    startFromCol: number, // 0 for split mode, freezeCol for freeze mode
  ) => {
    if (sectionWidth <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(sectionStartX, 0, sectionWidth, colHeaderHeight);
    ctx.clip();

    let accumulatedWidth = 0;
    let startCol = startFromCol;
    while (startCol < totalCols) {
      const cw = getColumnWidth(startCol, config, dimensions);
      if (cw <= 0) { startCol++; continue; }
      if (accumulatedWidth + cw > scrollX) break;
      accumulatedWidth += cw;
      startCol++;
    }
    const offsetX = -(scrollX - accumulatedWidth);

    let endCol = startCol;
    let widthAccum = offsetX;
    while (endCol < totalCols && widthAccum < sectionWidth) {
      const cw = getColumnWidth(endCol, config, dimensions);
      if (cw <= 0) { endCol++; continue; }
      widthAccum += cw;
      endCol++;
    }

    let x = sectionStartX + offsetX;
    for (let col = startCol; col <= endCol && col < totalCols; col++) {
      const cw = getColumnWidth(col, config, dimensions);
      if (cw <= 0) continue;
      if (x + cw >= sectionStartX && x <= sectionStartX + sectionWidth) {
        drawColHeader(col, x, cw);
      }
      x += cw;
    }
    ctx.restore();
  };

  if (hasFrozenCols) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const leftPaneWidth = layout.frozenColsWidth;

    if (isSplitMode) {
      // SPLIT MODE: Left section independently scrollable from col 0
      drawScrollableColHeaders(rowHeaderWidth, leftPaneWidth, splitViewport!.scrollX || 0, 0);
    } else {
      // FREEZE MODE: Left section shows fixed cols 0..freezeCol-1 (no scroll)
      let x = rowHeaderWidth;
      for (let col = 0; col < freezeCol && col < totalCols; col++) {
        const cw = getColumnWidth(col, config, dimensions);
        if (cw <= 0) continue;
        drawColHeader(col, x, cw);
        x += cw;
      }
    }

    // Draw freeze/split separator line on headers
    if (splitBarSize > 0) {
      const barX = rowHeaderWidth + leftPaneWidth;
      ctx.fillStyle = "#c0c0c0";
      ctx.fillRect(barX, 0, splitBarSize, colHeaderHeight);
      ctx.strokeStyle = "#999999";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(barX + 0.5, 0);
      ctx.lineTo(barX + 0.5, colHeaderHeight);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(barX + splitBarSize - 0.5, 0);
      ctx.lineTo(barX + splitBarSize - 0.5, colHeaderHeight);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#666666";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth + leftPaneWidth, 0);
      ctx.lineTo(rowHeaderWidth + leftPaneWidth, colHeaderHeight);
      ctx.stroke();
    }

    // Right section: uses main viewport.scrollX
    const scrollableStartX = rowHeaderWidth + leftPaneWidth + splitBarSize;
    const scrollableWidth = width - scrollableStartX;
    // In split mode, right pane starts from col 0; in freeze mode, from freezeCol
    drawScrollableColHeaders(scrollableStartX, scrollableWidth, viewport.scrollX || 0, isSplitMode ? 0 : freezeCol);
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
      if (colWidth <= 0) continue; // Skip hidden columns

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

      // Draw hidden column indicator (double-line)
      if (hasHiddenColAfter(col, dimensions)) {
        ctx.strokeStyle = HIDDEN_INDICATOR_COLOR;
        ctx.lineWidth = HIDDEN_INDICATOR_WIDTH;
        ctx.beginPath();
        ctx.moveTo(x + colWidth + 0.5, 0);
        ctx.lineTo(x + colWidth + 0.5, colHeaderHeight);
        ctx.stroke();
      }

      // Draw column letter (or override text)
      const override3 = getColumnHeaderOverride(col, viewportStartRow);
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenCols ? filteredColTextColor : theme.headerText;
      if (override3) {
        const maxTextW = override3.showFilterButton ? colWidth - FILTER_BUTTON_SIZE - FILTER_BUTTON_MARGIN * 2 : colWidth - 4;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, colWidth, colHeaderHeight);
        ctx.clip();
        ctx.fillText(override3.text, x + Math.min(colWidth, maxTextW) / 2, colLetterY);
        if (override3.showFilterButton) {
          drawHeaderFilterButton(ctx, x, colWidth, colHeaderHeight, override3);
        }
        ctx.restore();
      } else {
        ctx.fillText(getColLabel(col), x + colWidth / 2, colLetterY);
      }

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
  const { ctx, width, height, config, viewport, theme, selection, dimensions, freezeConfig, insertionAnimation, splitBarSize = 0, splitViewport } = state;
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
  // Split mode: top section is independently scrollable (not fixed rows 0..N)
  const isSplitMode = splitBarSize > 0 && splitViewport;

  if (hasFrozenRows) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const topPaneHeight = layout.frozenRowsHeight;

    // Helper to draw a single row header
    const drawRowHeader = (row: number, y: number, rh: number) => {
      const isSelected = row >= selMinRow && row <= selMaxRow;
      const isFullySelected = isSelected && isEntireRowSelected;
      if (isFullySelected) {
        ctx.fillStyle = theme.headerHighlight;
        ctx.fillRect(0, y, rowHeaderWidth, rh);
      } else if (isSelected) {
        ctx.fillStyle = "#e3ecf7";
        ctx.fillRect(0, y, rowHeaderWidth, rh);
      }
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + rh + 0.5);
      ctx.lineTo(rowHeaderWidth, y + rh + 0.5);
      ctx.stroke();
      if (hasHiddenRowAfter(row, dimensions)) {
        ctx.strokeStyle = HIDDEN_INDICATOR_COLOR;
        ctx.lineWidth = HIDDEN_INDICATOR_WIDTH;
        ctx.beginPath();
        ctx.moveTo(0, y + rh + 0.5);
        ctx.lineTo(rowHeaderWidth, y + rh + 0.5);
        ctx.stroke();
      }
      const outlineBarW = config.outlineBarWidth ?? 0;
      const numberCenterX = outlineBarW + (rowHeaderWidth - outlineBarW) / 2;
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenRows ? filteredTextColor : theme.headerText;
      ctx.fillText(String(row + 1), numberCenterX, y + rh / 2);
    };

    // Helper to draw a scrollable section of row headers
    const drawScrollableRowHeaders = (
      sectionStartY: number,
      sectionHeight: number,
      scrollY: number,
      startFromRow: number, // 0 for split mode, freezeRow for freeze mode
    ) => {
      if (sectionHeight <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sectionStartY, rowHeaderWidth, sectionHeight);
      ctx.clip();

      let accumulatedHeight = 0;
      let startRow = startFromRow;
      while (startRow < totalRows) {
        const rh = getRowHeight(startRow, config, dimensions);
        if (rh <= 0) { startRow++; continue; }
        if (accumulatedHeight + rh > scrollY) break;
        accumulatedHeight += rh;
        startRow++;
      }
      const offsetY = -(scrollY - accumulatedHeight);

      let endRow = startRow;
      let heightAccum = offsetY;
      while (endRow < totalRows && heightAccum < sectionHeight) {
        const rh = getRowHeight(endRow, config, dimensions);
        if (rh <= 0) { endRow++; continue; }
        heightAccum += rh;
        endRow++;
      }

      let y = sectionStartY + offsetY;
      for (let row = startRow; row <= endRow && row < totalRows; row++) {
        const rh = getRowHeight(row, config, dimensions);
        if (rh <= 0) continue;
        if (y + rh >= sectionStartY && y <= sectionStartY + sectionHeight) {
          drawRowHeader(row, y, rh);
        }
        y += rh;
      }
      ctx.restore();
    };

    if (isSplitMode) {
      // SPLIT MODE: Both sections independently scrollable, each can show any rows
      // Top section: uses splitViewport.scrollY, starts from row 0
      drawScrollableRowHeaders(colHeaderHeight, topPaneHeight, splitViewport!.scrollY || 0, 0);
    } else {
      // FREEZE MODE: Top section shows fixed rows 0..freezeRow-1 (no scroll)
      let y = colHeaderHeight;
      for (let row = 0; row < freezeRow && row < totalRows; row++) {
        const rh = getRowHeight(row, config, dimensions);
        if (rh <= 0) continue;
        drawRowHeader(row, y, rh);
        y += rh;
      }
    }

    // Draw freeze/split separator line on headers
    if (splitBarSize > 0) {
      const barY = colHeaderHeight + topPaneHeight;
      ctx.fillStyle = "#c0c0c0";
      ctx.fillRect(0, barY, rowHeaderWidth, splitBarSize);
      ctx.strokeStyle = "#999999";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, barY + 0.5);
      ctx.lineTo(rowHeaderWidth, barY + 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, barY + splitBarSize - 0.5);
      ctx.lineTo(rowHeaderWidth, barY + splitBarSize - 0.5);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#666666";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, colHeaderHeight + topPaneHeight);
      ctx.lineTo(rowHeaderWidth, colHeaderHeight + topPaneHeight);
      ctx.stroke();
    }

    // Bottom section: uses main viewport.scrollY
    const scrollableStartY = colHeaderHeight + topPaneHeight + splitBarSize;
    const scrollableHeight = height - scrollableStartY;
    // In split mode, bottom pane starts from row 0; in freeze mode, from freezeRow
    drawScrollableRowHeaders(scrollableStartY, scrollableHeight, viewport.scrollY || 0, isSplitMode ? 0 : freezeRow);
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

      // Draw hidden row indicator (double-line)
      if (hasHiddenRowAfter(row, dimensions)) {
        ctx.strokeStyle = HIDDEN_INDICATOR_COLOR;
        ctx.lineWidth = HIDDEN_INDICATOR_WIDTH;
        ctx.beginPath();
        ctx.moveTo(0, y + rowHeight + 0.5);
        ctx.lineTo(rowHeaderWidth, y + rowHeight + 0.5);
        ctx.stroke();
      }

      // Draw row number (1-based)
      const outlineBarW3 = config.outlineBarWidth ?? 0;
      const numberCenterX3 = outlineBarW3 + (rowHeaderWidth - outlineBarW3) / 2;
      ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : hasHiddenRows ? filteredTextColor : theme.headerText;
      ctx.fillText(String(row + 1), numberCenterX3, y + rowHeight / 2);

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