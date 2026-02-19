//! FILENAME: app/extensions/Grouping/rendering/outlineBarRenderer.ts
// PURPOSE: Canvas renderer for row and column outline bars (level buttons,
//          brackets, +/- toggle buttons).
// CONTEXT: Registered as a post-header overlay so it paints on top of headers.
//          Called synchronously during each canvas frame; accesses pre-fetched
//          outline data.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../src/api";
import {
  getCurrentOutlineInfo,
  updateLastRenderedState,
  refreshOutlineState,
} from "../lib/groupingStore";

// ============================================================================
// Layout Constants
// ============================================================================

const PIXELS_PER_LEVEL = 16;
const LEVEL_BTN_SIZE = 14;    // size of the "1", "2", "3" buttons in the corner
const LEVEL_BTN_GAP = 2;      // gap between level buttons
const BUTTON_SIZE = 13;       // size of the +/- collapse/expand button
const LEFT_PAD = 4;           // margin so bracket lines are not clipped at the edge

const COLOR_BAR_BG = "#f0f0f0";
const COLOR_CORNER_BG = "#e8e8e8";
const COLOR_LEVEL_BTN_BG = "#e0e0e0";
const COLOR_LEVEL_BTN_BORDER = "#999999";
const COLOR_LEVEL_BTN_TEXT = "#222222";
const COLOR_BRACKET = "#555555";
const COLOR_BUTTON_BG = "#ffffff";
const COLOR_BUTTON_BORDER = "#777777";
const COLOR_BUTTON_SYMBOL = "#333333";
const COLOR_DIVIDER = "#bbbbbb";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the pixel offset of the collapse/expand button center for a given
 * outline level.  Used for both X (rows) and Y (columns).
 */
export function buttonPosForLevel(level: number): number {
  return LEFT_PAD + (level - 1) * PIXELS_PER_LEVEL + PIXELS_PER_LEVEL / 2;
}

/**
 * Returns the pixel offset of the bracket line for a given level.
 */
function bracketPosForLevel(level: number): number {
  return LEFT_PAD + (level - 1) * PIXELS_PER_LEVEL + 2;
}

/**
 * Draw a small square button with + or - symbol.
 */
function drawToggleButton(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  isCollapsed: boolean,
): void {
  const half = BUTTON_SIZE / 2;
  ctx.fillStyle = COLOR_BUTTON_BG;
  ctx.fillRect(cx - half, cy - half, BUTTON_SIZE, BUTTON_SIZE);
  ctx.strokeStyle = COLOR_BUTTON_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - half + 0.5, cy - half + 0.5, BUTTON_SIZE - 1, BUTTON_SIZE - 1);

  // Draw + or - symbol
  const symbolHalf = Math.floor(half) - 2;
  ctx.strokeStyle = COLOR_BUTTON_SYMBOL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Horizontal bar (both + and -)
  ctx.moveTo(cx - symbolHalf, cy);
  ctx.lineTo(cx + symbolHalf, cy);
  ctx.stroke();

  if (isCollapsed) {
    // Vertical bar for +
    ctx.beginPath();
    ctx.moveTo(cx, cy - symbolHalf);
    ctx.lineTo(cx, cy + symbolHalf);
    ctx.stroke();
  }
}

/**
 * Draw a level number button (1, 2, 3...) in the corner area.
 */
function drawLevelButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  level: number,
): void {
  ctx.fillStyle = COLOR_LEVEL_BTN_BG;
  ctx.fillRect(x, y, LEVEL_BTN_SIZE, LEVEL_BTN_SIZE);
  ctx.strokeStyle = COLOR_LEVEL_BTN_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, LEVEL_BTN_SIZE - 1, LEVEL_BTN_SIZE - 1);
  ctx.fillStyle = COLOR_LEVEL_BTN_TEXT;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(level), x + LEVEL_BTN_SIZE / 2, y + LEVEL_BTN_SIZE / 2);
}

// ============================================================================
// Main Renderer
// ============================================================================

/**
 * Renders the outline bars: row outline bar (left of row headers) and
 * column outline bar (above column headers).
 * Called after all headers are drawn (post-header overlay).
 */
export function renderOutlineBar(
  ctx: CanvasRenderingContext2D,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const outlineBarW = config.outlineBarWidth ?? 0;
  const outlineBarH = config.outlineBarHeight ?? 0;
  if (outlineBarW <= 0 && outlineBarH <= 0) return;

  // Fire-and-forget viewport refresh so the store keeps up with scrolling.
  refreshOutlineState(viewport).catch(() => {});

  const info = getCurrentOutlineInfo();
  if (!info) return;

  const colHeaderH = config.colHeaderHeight ?? 24;
  const rowHeaderW = config.rowHeaderWidth ?? 50;
  const defaultRowH = config.defaultCellHeight ?? 24;
  const defaultColW = config.defaultCellWidth ?? 100;

  const hiddenRows = dimensions.hiddenRows ?? new Set<number>();
  const hiddenCols = dimensions.hiddenCols ?? new Set<number>();

  // =========================================================================
  // Build row-Y map
  // =========================================================================
  const rowYMap = new Map<number, number>();
  if (outlineBarW > 0 && info.maxRowLevel > 0) {
    const scrollY = viewport.scrollY;
    let scrollAccum = 0;
    let currentRow = 0;
    while (currentRow < viewport.startRow) {
      const rh = hiddenRows.has(currentRow) ? 0 : (dimensions.rowHeights.get(currentRow) ?? defaultRowH);
      scrollAccum += rh;
      currentRow++;
    }
    let yCurrent = colHeaderH - (scrollY - scrollAccum);
    let r = viewport.startRow;
    while (r < viewport.startRow + viewport.rowCount + 10 && yCurrent < canvasHeight + 100) {
      if (!hiddenRows.has(r)) {
        rowYMap.set(r, yCurrent);
        yCurrent += dimensions.rowHeights.get(r) ?? defaultRowH;
      }
      r++;
    }
  }

  // =========================================================================
  // Build col-X map
  // =========================================================================
  const colXMap = new Map<number, number>();
  if (outlineBarH > 0 && info.maxColLevel > 0) {
    const scrollX = viewport.scrollX;
    let scrollAccum = 0;
    let currentCol = 0;
    while (currentCol < viewport.startCol) {
      const cw = hiddenCols.has(currentCol) ? 0 : (dimensions.columnWidths.get(currentCol) ?? defaultColW);
      scrollAccum += cw;
      currentCol++;
    }
    let xCurrent = rowHeaderW - (scrollX - scrollAccum);
    let c = viewport.startCol;
    while (c < viewport.startCol + viewport.colCount + 10 && xCurrent < canvasWidth + 200) {
      if (!hiddenCols.has(c)) {
        colXMap.set(c, xCurrent);
        xCurrent += dimensions.columnWidths.get(c) ?? defaultColW;
      }
      c++;
    }
  }

  // Store render state for click hit testing
  updateLastRenderedState(rowYMap, colXMap, outlineBarW, outlineBarH, colHeaderH, rowHeaderW);

  // =========================================================================
  // Draw corner area background (top-left intersection of both bars)
  // =========================================================================
  if (outlineBarW > 0 || outlineBarH > 0) {
    ctx.fillStyle = COLOR_CORNER_BG;
    // Corner extends to cover the intersection
    ctx.fillRect(0, 0, outlineBarW > 0 ? outlineBarW : rowHeaderW, outlineBarH > 0 ? outlineBarH : colHeaderH);
    if (outlineBarW > 0 && outlineBarH > 0) {
      // Full corner when both bars exist
      ctx.fillRect(0, 0, outlineBarW, colHeaderH);
      ctx.fillRect(0, 0, rowHeaderW, outlineBarH);
    }
  }

  // =========================================================================
  // ROW outline bar (left side)
  // =========================================================================
  if (outlineBarW > 0 && info.maxRowLevel > 0) {
    // Background
    ctx.fillStyle = COLOR_BAR_BG;
    ctx.fillRect(0, colHeaderH, outlineBarW, canvasHeight - colHeaderH);

    // Corner + level buttons for rows
    ctx.fillStyle = COLOR_CORNER_BG;
    ctx.fillRect(0, 0, outlineBarW, colHeaderH);

    // Row level buttons in top-left corner, positioned in the row-header
    // portion of the column header area
    const rowLevelBtnY = outlineBarH > 0 ? outlineBarH : 0;
    const rowLevelBtnAreaH = colHeaderH - rowLevelBtnY;
    for (let lvl = 1; lvl <= info.maxRowLevel; lvl++) {
      const btnX = (lvl - 1) * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP) + 2;
      const btnY = rowLevelBtnY + (rowLevelBtnAreaH - LEVEL_BTN_SIZE) / 2;
      drawLevelButton(ctx, btnX, btnY, lvl);
    }

    // Clip to row outline bar area
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, colHeaderH, outlineBarW, canvasHeight - colHeaderH);
    ctx.clip();

    const rowAboveLeft = info.settings.summaryRowPosition === "aboveLeft";

    if (rowAboveLeft) {
      // AboveLeft: button row is at the TOP of the group.
      // Bracket extends downward from button to last detail row.
      type PendingBracket = { buttonCenterY: number; endY: number; isCollapsed: boolean };
      const pendingBrackets: Map<number, PendingBracket> = new Map();

      for (const sym of info.rowSymbols) {
        const rowY = rowYMap.get(sym.row);
        if (rowY === undefined) continue;

        const rh = dimensions.rowHeights.get(sym.row) ?? defaultRowH;
        const rowCenterY = rowY + rh / 2;

        if (sym.isButtonRow && sym.level > 0) {
          // Close any existing pending bracket at this level
          const existing = pendingBrackets.get(sym.level);
          if (existing) {
            const bx = bracketPosForLevel(sym.level);
            ctx.strokeStyle = COLOR_BRACKET;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(bx + 0.5, existing.buttonCenterY);
            ctx.lineTo(bx + 0.5, existing.endY);
            ctx.stroke();
          }

          // Draw toggle button
          const btnCx = buttonPosForLevel(sym.level);
          drawToggleButton(ctx, btnCx, rowCenterY, sym.isCollapsed);

          // Horizontal tick from bracket line to button
          const bx = bracketPosForLevel(sym.level);
          ctx.strokeStyle = COLOR_BRACKET;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(bx + 0.5, rowCenterY);
          ctx.lineTo(bx + BUTTON_SIZE / 2 + 2, rowCenterY);
          ctx.stroke();

          // Open new pending bracket
          pendingBrackets.set(sym.level, {
            buttonCenterY: rowCenterY,
            endY: rowY + rh,
            isCollapsed: sym.isCollapsed,
          });
        } else if (sym.level > 0) {
          // Extend pending bracket to cover this detail row
          const pending = pendingBrackets.get(sym.level);
          if (pending) {
            pending.endY = rowY + rh;
          }
        }
      }

      // Draw remaining pending brackets
      for (const [level, pending] of pendingBrackets) {
        const bx = bracketPosForLevel(level);
        ctx.strokeStyle = COLOR_BRACKET;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, pending.buttonCenterY);
        ctx.lineTo(bx + 0.5, pending.endY);
        ctx.stroke();
      }
    } else {
      // BelowRight: button row is at the BOTTOM of the group.
      // Bracket extends upward from first detail row to button.
      type BracketState = { startY: number; level: number };
      const openBrackets: Map<number, BracketState> = new Map();

      for (const sym of info.rowSymbols) {
        const rowY = rowYMap.get(sym.row);
        if (rowY === undefined) continue;

        const rh = dimensions.rowHeights.get(sym.row) ?? defaultRowH;
        const rowCenterY = rowY + rh / 2;

        if (sym.level > 0 && !sym.isButtonRow) {
          if (!openBrackets.has(sym.level)) {
            openBrackets.set(sym.level, { startY: rowY, level: sym.level });
          }
        }

        if (sym.isButtonRow && sym.level > 0) {
          const bx = bracketPosForLevel(sym.level);
          const bracket = openBrackets.get(sym.level);
          const startY = bracket ? bracket.startY : rowY;

          ctx.strokeStyle = COLOR_BRACKET;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(bx + 0.5, Math.max(startY, colHeaderH));
          ctx.lineTo(bx + 0.5, rowCenterY);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(bx + 0.5, rowCenterY);
          ctx.lineTo(bx + BUTTON_SIZE / 2 + 2, rowCenterY);
          ctx.stroke();

          const btnCx = buttonPosForLevel(sym.level);
          drawToggleButton(ctx, btnCx, rowCenterY, sym.isCollapsed);

          openBrackets.delete(sym.level);
        }
      }

      for (const [level, bracket] of openBrackets) {
        const bx = bracketPosForLevel(level);
        ctx.strokeStyle = COLOR_BRACKET;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, Math.max(bracket.startY, colHeaderH));
        ctx.lineTo(bx + 0.5, canvasHeight);
        ctx.stroke();
      }
    }

    ctx.restore();

    // Divider on the right edge of the row outline bar
    ctx.strokeStyle = COLOR_DIVIDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(outlineBarW + 0.5, 0);
    ctx.lineTo(outlineBarW + 0.5, canvasHeight);
    ctx.stroke();
  }

  // =========================================================================
  // COLUMN outline bar (top side)
  // =========================================================================
  if (outlineBarH > 0 && info.maxColLevel > 0) {
    // Background
    ctx.fillStyle = COLOR_BAR_BG;
    ctx.fillRect(rowHeaderW, 0, canvasWidth - rowHeaderW, outlineBarH);

    // Corner + level buttons for columns
    ctx.fillStyle = COLOR_CORNER_BG;
    ctx.fillRect(0, 0, rowHeaderW, outlineBarH);

    // Column level buttons in top-left corner, positioned in the col-header
    // portion of the row header area
    const colLevelBtnX = outlineBarW > 0 ? outlineBarW : 0;
    const colLevelBtnAreaW = rowHeaderW - colLevelBtnX;
    for (let lvl = 1; lvl <= info.maxColLevel; lvl++) {
      const btnY = (lvl - 1) * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP) + 2;
      const btnX = colLevelBtnX + (colLevelBtnAreaW - LEVEL_BTN_SIZE) / 2;
      drawLevelButton(ctx, btnX, btnY, lvl);
    }

    // Clip to column outline bar area
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderW, 0, canvasWidth - rowHeaderW, outlineBarH);
    ctx.clip();

    const colAboveLeft = info.settings.summaryColPosition === "aboveLeft";

    if (colAboveLeft) {
      // AboveLeft: button column is at the LEFT of the group.
      // Bracket extends rightward from button to last detail column.
      type PendingBracket = { buttonCenterX: number; endX: number; isCollapsed: boolean };
      const pendingBrackets: Map<number, PendingBracket> = new Map();

      for (const sym of info.colSymbols) {
        const colX = colXMap.get(sym.col);
        if (colX === undefined) continue;

        const cw = dimensions.columnWidths.get(sym.col) ?? defaultColW;
        const colCenterX = colX + cw / 2;

        if (sym.isButtonCol && sym.level > 0) {
          // Close any existing pending bracket at this level
          const existing = pendingBrackets.get(sym.level);
          if (existing) {
            const by = bracketPosForLevel(sym.level);
            ctx.strokeStyle = COLOR_BRACKET;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(existing.buttonCenterX, by + 0.5);
            ctx.lineTo(existing.endX, by + 0.5);
            ctx.stroke();
          }

          // Draw toggle button
          const btnCy = buttonPosForLevel(sym.level);
          drawToggleButton(ctx, colCenterX, btnCy, sym.isCollapsed);

          // Vertical tick from bracket line to button
          const by = bracketPosForLevel(sym.level);
          ctx.strokeStyle = COLOR_BRACKET;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(colCenterX, by + 0.5);
          ctx.lineTo(colCenterX, by + BUTTON_SIZE / 2 + 2);
          ctx.stroke();

          // Open new pending bracket
          pendingBrackets.set(sym.level, {
            buttonCenterX: colCenterX,
            endX: colX + cw,
            isCollapsed: sym.isCollapsed,
          });
        } else if (sym.level > 0) {
          // Extend pending bracket to cover this detail column
          const pending = pendingBrackets.get(sym.level);
          if (pending) {
            pending.endX = colX + cw;
          }
        }
      }

      // Draw remaining pending brackets
      for (const [level, pending] of pendingBrackets) {
        const by = bracketPosForLevel(level);
        ctx.strokeStyle = COLOR_BRACKET;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pending.buttonCenterX, by + 0.5);
        ctx.lineTo(pending.endX, by + 0.5);
        ctx.stroke();
      }
    } else {
      // BelowRight: button column is at the RIGHT of the group.
      // Bracket extends leftward from first detail column to button.
      type BracketState = { startX: number; level: number };
      const openBrackets: Map<number, BracketState> = new Map();

      for (const sym of info.colSymbols) {
        const colX = colXMap.get(sym.col);
        if (colX === undefined) continue;

        const cw = dimensions.columnWidths.get(sym.col) ?? defaultColW;
        const colCenterX = colX + cw / 2;

        if (sym.level > 0 && !sym.isButtonCol) {
          if (!openBrackets.has(sym.level)) {
            openBrackets.set(sym.level, { startX: colX, level: sym.level });
          }
        }

        if (sym.isButtonCol && sym.level > 0) {
          const by = bracketPosForLevel(sym.level);
          const bracket = openBrackets.get(sym.level);
          const startX = bracket ? bracket.startX : colX;

          // Horizontal bracket line
          ctx.strokeStyle = COLOR_BRACKET;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(Math.max(startX, rowHeaderW), by + 0.5);
          ctx.lineTo(colCenterX, by + 0.5);
          ctx.stroke();

          // Vertical tick at right end
          ctx.beginPath();
          ctx.moveTo(colCenterX, by + 0.5);
          ctx.lineTo(colCenterX, by + BUTTON_SIZE / 2 + 2);
          ctx.stroke();

          // +/- toggle button
          const btnCy = buttonPosForLevel(sym.level);
          drawToggleButton(ctx, colCenterX, btnCy, sym.isCollapsed);

          openBrackets.delete(sym.level);
        }
      }

      // Close any brackets that extend beyond visible range
      for (const [level, bracket] of openBrackets) {
        const by = bracketPosForLevel(level);
        ctx.strokeStyle = COLOR_BRACKET;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.max(bracket.startX, rowHeaderW), by + 0.5);
        ctx.lineTo(canvasWidth, by + 0.5);
        ctx.stroke();
      }
    }

    ctx.restore();

    // Divider on the bottom edge of the column outline bar
    ctx.strokeStyle = COLOR_DIVIDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, outlineBarH + 0.5);
    ctx.lineTo(canvasWidth, outlineBarH + 0.5);
    ctx.stroke();
  }
}
