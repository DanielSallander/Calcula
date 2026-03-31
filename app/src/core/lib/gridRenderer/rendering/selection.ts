//! FILENAME: app/src/core/lib/gridRenderer/rendering/selection.ts
// PURPOSE: Selection and active cell rendering
// CONTEXT: Draws selection highlights, active cell borders, fill handles, fill preview,
//          and clipboard marching ants animation
// UPDATED: Added freeze pane support for proper selection positioning

import type { RenderState } from "../types";
import type { FreezeConfig, DimensionOverrides, GridConfig, Viewport } from "../../../types";
import { calculateFreezePaneLayout } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";

// ─── Split Zone Helpers ─────────────────────────────────────────────

interface SplitZoneInfo {
  originX: number;
  originY: number;
  clipRight: number;
  clipBottom: number;
  scrollX: number;
  scrollY: number;
}

/**
 * Compute the split zones for multi-zone selection drawing.
 * Returns null when not in split mode so callers fall through to normal rendering.
 */
function computeSplitZones(state: RenderState): SplitZoneInfo[] | null {
  const { config, viewport, freezeConfig, splitBarSize = 0, splitViewport, width, height, dimensions } = state;

  if (!splitBarSize || !splitViewport || !freezeConfig) return null;

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);

  const hasSplitCols = freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  const hasSplitRows = freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;

  const leftPaneWidth = layout.frozenColsWidth;
  const topPaneHeight = layout.frozenRowsHeight;
  const splitXPixel = rowHeaderWidth + leftPaneWidth;
  const splitYPixel = colHeaderHeight + topPaneHeight;
  const rightPaneLeft = splitXPixel + (hasSplitCols ? splitBarSize : 0);
  const bottomPaneTop = splitYPixel + (hasSplitRows ? splitBarSize : 0);

  const zones: SplitZoneInfo[] = [];

  // Bottom-right pane (always present)
  zones.push({
    originX: hasSplitCols ? rightPaneLeft : rowHeaderWidth,
    originY: hasSplitRows ? bottomPaneTop : colHeaderHeight,
    clipRight: width,
    clipBottom: height,
    scrollX: viewport.scrollX || 0,
    scrollY: viewport.scrollY || 0,
  });

  // Bottom-left pane (only if horizontal split)
  if (hasSplitCols) {
    zones.push({
      originX: rowHeaderWidth,
      originY: hasSplitRows ? bottomPaneTop : colHeaderHeight,
      clipRight: splitXPixel,
      clipBottom: height,
      scrollX: splitViewport.scrollX || 0,
      scrollY: viewport.scrollY || 0,
    });
  }

  // Top-right pane (only if vertical split)
  if (hasSplitRows) {
    zones.push({
      originX: hasSplitCols ? rightPaneLeft : rowHeaderWidth,
      originY: colHeaderHeight,
      clipRight: width,
      clipBottom: splitYPixel,
      scrollX: viewport.scrollX || 0,
      scrollY: splitViewport.scrollY || 0,
    });
  }

  // Top-left pane (only if both splits)
  if (hasSplitCols && hasSplitRows) {
    zones.push({
      originX: rowHeaderWidth,
      originY: colHeaderHeight,
      clipRight: splitXPixel,
      clipBottom: splitYPixel,
      scrollX: splitViewport.scrollX || 0,
      scrollY: splitViewport.scrollY || 0,
    });
  }

  return zones;
}

/** Cell X position within a split zone (no freeze logic, pure scroll) */
function getCellXInZone(
  col: number, config: GridConfig, dimensions: DimensionOverrides,
  scrollX: number, originX: number
): number {
  let x = originX;
  for (let c = 0; c < col; c++) {
    x += getColumnWidth(c, config, dimensions);
  }
  return x - scrollX;
}

/** Cell Y position within a split zone (no freeze logic, pure scroll) */
function getCellYInZone(
  row: number, config: GridConfig, dimensions: DimensionOverrides,
  scrollY: number, originY: number
): number {
  let y = originY;
  for (let r = 0; r < row; r++) {
    y += getRowHeight(r, config, dimensions);
  }
  return y - scrollY;
}

// ─── Freeze Pane Helpers ────────────────────────────────────────────

/**
 * Calculate the X position of a column accounting for freeze panes.
 * Frozen columns are at fixed positions, scrollable columns account for scroll offset.
 */
function getColumnXWithFreeze(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig,
  splitBarSize: number = 0
): number {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const freezeCol = freezeConfig?.freezeCol ?? 0;

  if (freezeCol > 0 && col < freezeCol) {
    // Frozen column: fixed position
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x;
  } else if (freezeCol > 0) {
    // Scrollable column: account for frozen width, split bar, and scroll offset
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollX = viewport.scrollX || 0;

    // Start after frozen columns + split bar
    let x = rowHeaderWidth + layout.frozenColsWidth + splitBarSize;

    // Add width of scrollable columns before this one, minus scroll offset
    for (let c = freezeCol; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    x -= scrollX;

    return x;
  } else {
    // No freeze panes: standard calculation
    const scrollX = viewport.scrollX || 0;
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x - scrollX;
  }
}

/**
 * Calculate the Y position of a row accounting for freeze panes.
 * Frozen rows are at fixed positions, scrollable rows account for scroll offset.
 */
function getRowYWithFreeze(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig,
  splitBarSize: number = 0
): number {
  const colHeaderHeight = config.colHeaderHeight || 24;
  const freezeRow = freezeConfig?.freezeRow ?? 0;

  if (freezeRow > 0 && row < freezeRow) {
    // Frozen row: fixed position
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y;
  } else if (freezeRow > 0) {
    // Scrollable row: account for frozen height, split bar, and scroll offset
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollY = viewport.scrollY || 0;

    // Start after frozen rows + split bar
    let y = colHeaderHeight + layout.frozenRowsHeight + splitBarSize;

    // Add height of scrollable rows before this one, minus scroll offset
    for (let r = freezeRow; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    y -= scrollY;

    return y;
  } else {
    // No freeze panes: standard calculation
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y - scrollY;
  }
}

/**
 * Draw the selection highlight.
 * Supports freeze panes with proper positioning across zones.
 * FIX: Skips drawing when viewing a different sheet during formula editing.
 */
export function drawSelection(state: RenderState): void {
  const {
    ctx, width, height, config, viewport, selection, theme, dimensions, freezeConfig,
    editing, currentSheetName, formulaSourceSheetName, splitBarSize = 0
  } = state;

  if (!selection) {
    return;
  }

  // FIX: When editing a formula and viewing a different sheet, don't draw the source sheet's selection
  if (editing && formulaSourceSheetName && currentSheetName) {
    const isOnDifferentSheet = currentSheetName.toLowerCase() !== formulaSourceSheetName.toLowerCase();
    if (isOnDifferentSheet) {
      return;
    }
  }

  // ─── Split mode: draw selection in every zone where it's visible ───
  const zones = computeSplitZones(state);
  if (zones) {
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Check overlay regions once
    const { overlayRegionBounds } = state;
    let selectionInOverlay = false;
    if (overlayRegionBounds && overlayRegionBounds.length > 0) {
      for (const region of overlayRegionBounds) {
        if (minRow >= region.startRow && maxRow <= region.endRow &&
            minCol >= region.startCol && maxCol <= region.endCol) {
          selectionInOverlay = true;
          break;
        }
      }
    }

    // Collect all ranges (main + additional)
    const allRanges: Array<{ minR: number; maxR: number; minC: number; maxC: number; isMain: boolean }> = [
      { minR: minRow, maxR: maxRow, minC: minCol, maxC: maxCol, isMain: true }
    ];
    if (selection.additionalRanges) {
      for (const range of selection.additionalRanges) {
        allRanges.push({
          minR: Math.min(range.startRow, range.endRow),
          maxR: Math.max(range.startRow, range.endRow),
          minC: Math.min(range.startCol, range.endCol),
          maxC: Math.max(range.startCol, range.endCol),
          isMain: false,
        });
      }
    }

    for (const zone of zones) {
      for (const range of allRanges) {
        const x1 = getCellXInZone(range.minC, config, dimensions, zone.scrollX, zone.originX);
        const y1 = getCellYInZone(range.minR, config, dimensions, zone.scrollY, zone.originY);
        const x2 = getCellXInZone(range.maxC, config, dimensions, zone.scrollX, zone.originX) +
                   getColumnWidth(range.maxC, config, dimensions);
        const y2 = getCellYInZone(range.maxR, config, dimensions, zone.scrollY, zone.originY) +
                   getRowHeight(range.maxR, config, dimensions);

        // Clip to zone bounds
        const clipX1 = Math.max(x1, zone.originX);
        const clipY1 = Math.max(y1, zone.originY);
        const clipX2 = Math.min(x2, zone.clipRight);
        const clipY2 = Math.min(y2, zone.clipBottom);

        if (clipX1 >= clipX2 || clipY1 >= clipY2) continue;

        // Selection fill
        ctx.fillStyle = theme.selectionBackground;
        ctx.fillRect(clipX1, clipY1, clipX2 - clipX1, clipY2 - clipY1);

        // Selection border
        ctx.strokeStyle = theme.selectionBorder;
        ctx.lineWidth = 2;
        const bx1 = clipX1 + 1, by1 = clipY1 + 1;
        const bx2 = clipX2 - 1, by2 = clipY2 - 1;
        if (bx2 > bx1 && by2 > by1) {
          ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
        }

        // Fill handle only on main selection, first zone (bottomRight)
        if (range.isMain && zone === zones[0] && !selectionInOverlay) {
          const handleSize = 8;
          const handleX = bx2 - handleSize / 2;
          const handleY = by2 - handleSize / 2;
          if (handleX > zone.originX && handleY > zone.originY &&
              handleX < zone.clipRight && handleY < zone.clipBottom) {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
            ctx.strokeStyle = "#16a34a";
            ctx.lineWidth = 2;
            ctx.strokeRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
          }
        }
      }
    }
    return;
  }

  // ─── Non-split mode: existing freeze-pane-aware rendering ─────────
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig, splitBarSize);

  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getRowHeight(maxRow, config, dimensions);

  // Clip to visible area (accounting for headers)
  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  // Additional clipping for freeze panes
  const hasFrozenCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  const hasFrozenRows = freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;

  let clipX1 = visX1;
  let clipY1 = visY1;
  let clipX2 = visX2;
  let clipY2 = visY2;

  if (hasFrozenCols || hasFrozenRows) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const frozenColBoundary = rowHeaderWidth + layout.frozenColsWidth + splitBarSize;
    const frozenRowBoundary = colHeaderHeight + layout.frozenRowsHeight + splitBarSize;
    const freezeCol = freezeConfig!.freezeCol ?? 0;
    const freezeRow = freezeConfig!.freezeRow ?? 0;

    if (hasFrozenCols && minCol >= freezeCol) {
      clipX1 = Math.max(clipX1, frozenColBoundary);
    }
    if (hasFrozenRows && minRow >= freezeRow) {
      clipY1 = Math.max(clipY1, frozenRowBoundary);
    }
    if (hasFrozenCols && maxCol < freezeCol) {
      clipX2 = Math.min(clipX2, rowHeaderWidth + layout.frozenColsWidth);
    }
    if (hasFrozenRows && maxRow < freezeRow) {
      clipY2 = Math.min(clipY2, colHeaderHeight + layout.frozenRowsHeight);
    }
  }

  if (clipX1 >= clipX2 || clipY1 >= clipY2) {
    return;
  }

  // Draw selection fill
  ctx.fillStyle = theme.selectionBackground;
  ctx.fillRect(clipX1, clipY1, clipX2 - clipX1, clipY2 - clipY1);

  // Draw selection border
  ctx.strokeStyle = theme.selectionBorder;
  ctx.lineWidth = 2;

  const borderX1 = clipX1 + 1;
  const borderY1 = clipY1 + 1;
  const borderX2 = clipX2 - 1;
  const borderY2 = clipY2 - 1;

  if (borderX2 > borderX1 && borderY2 > borderY1) {
    ctx.strokeRect(borderX1, borderY1, borderX2 - borderX1, borderY2 - borderY1);
  }

  // Draw fill handle
  const { overlayRegionBounds } = state;
  let selectionInOverlay = false;
  if (overlayRegionBounds && overlayRegionBounds.length > 0) {
    for (const region of overlayRegionBounds) {
      if (
        minRow >= region.startRow && maxRow <= region.endRow &&
        minCol >= region.startCol && maxCol <= region.endCol
      ) {
        selectionInOverlay = true;
        break;
      }
    }
  }

  if (!selectionInOverlay) {
    const handleSize = 8;
    const handleX = borderX2 - handleSize / 2;
    const handleY = borderY2 - handleSize / 2;

    if (handleX > rowHeaderWidth && handleY > colHeaderHeight &&
        handleX < width && handleY < height) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 2;
      ctx.strokeRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
    }
  }

  // Draw additional selection ranges (from Ctrl+Click multi-select)
  if (selection.additionalRanges && selection.additionalRanges.length > 0) {
    for (const range of selection.additionalRanges) {
      const addMinRow = Math.min(range.startRow, range.endRow);
      const addMaxRow = Math.max(range.startRow, range.endRow);
      const addMinCol = Math.min(range.startCol, range.endCol);
      const addMaxCol = Math.max(range.startCol, range.endCol);

      const addX1 = getColumnXWithFreeze(addMinCol, config, dimensions, viewport, freezeConfig, splitBarSize);
      const addY1 = getRowYWithFreeze(addMinRow, config, dimensions, viewport, freezeConfig, splitBarSize);
      const addX2 = getColumnXWithFreeze(addMaxCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
                    getColumnWidth(addMaxCol, config, dimensions);
      const addY2 = getRowYWithFreeze(addMaxRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
                    getRowHeight(addMaxRow, config, dimensions);

      let addClipX1 = Math.max(addX1, rowHeaderWidth);
      let addClipY1 = Math.max(addY1, colHeaderHeight);
      let addClipX2 = Math.min(addX2, width);
      let addClipY2 = Math.min(addY2, height);

      if (hasFrozenCols || hasFrozenRows) {
        const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
        const frozenColBoundary = rowHeaderWidth + layout.frozenColsWidth + splitBarSize;
        const frozenRowBoundary = colHeaderHeight + layout.frozenRowsHeight + splitBarSize;
        const freezeCol = freezeConfig!.freezeCol ?? 0;
        const freezeRow = freezeConfig!.freezeRow ?? 0;

        if (hasFrozenCols && addMinCol >= freezeCol) {
          addClipX1 = Math.max(addClipX1, frozenColBoundary);
        }
        if (hasFrozenRows && addMinRow >= freezeRow) {
          addClipY1 = Math.max(addClipY1, frozenRowBoundary);
        }
        if (hasFrozenCols && addMaxCol < freezeCol) {
          addClipX2 = Math.min(addClipX2, rowHeaderWidth + layout.frozenColsWidth);
        }
        if (hasFrozenRows && addMaxRow < freezeRow) {
          addClipY2 = Math.min(addClipY2, colHeaderHeight + layout.frozenRowsHeight);
        }
      }

      if (addClipX1 >= addClipX2 || addClipY1 >= addClipY2) {
        continue;
      }

      ctx.fillStyle = theme.selectionBackground;
      ctx.fillRect(addClipX1, addClipY1, addClipX2 - addClipX1, addClipY2 - addClipY1);

      ctx.strokeStyle = theme.selectionBorder;
      ctx.lineWidth = 2;
      const addBorderX1 = addClipX1 + 1;
      const addBorderY1 = addClipY1 + 1;
      const addBorderX2 = addClipX2 - 1;
      const addBorderY2 = addClipY2 - 1;

      if (addBorderX2 > addBorderX1 && addBorderY2 > addBorderY1) {
        ctx.strokeRect(addBorderX1, addBorderY1, addBorderX2 - addBorderX1, addBorderY2 - addBorderY1);
      }
    }
  }
}

/**
 * Draw clipboard selection with marching ants animation.
 * The dotted border animates to show cells are on the clipboard.
 * Supports freeze panes with proper positioning.
 */
export function drawClipboardSelection(state: RenderState): void {
  const {
    ctx, width, height, config, viewport, dimensions, freezeConfig,
    clipboardSelection, clipboardMode, clipboardAnimationOffset = 0, splitBarSize = 0
  } = state;

  if (!clipboardSelection || clipboardMode === "none") {
    return;
  }

  const minRow = Math.min(clipboardSelection.startRow, clipboardSelection.endRow);
  const maxRow = Math.max(clipboardSelection.startRow, clipboardSelection.endRow);
  const minCol = Math.min(clipboardSelection.startCol, clipboardSelection.endCol);
  const maxCol = Math.max(clipboardSelection.startCol, clipboardSelection.endCol);

  const drawMarchingAnts = (bx: number, by: number, bw: number, bh: number) => {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.strokeStyle = clipboardMode === "cut" ? "#16a34a" : "#2563eb";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -clipboardAnimationOffset;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  };

  // ─── Split mode ───
  const zones = computeSplitZones(state);
  if (zones) {
    for (const zone of zones) {
      const x1 = getCellXInZone(minCol, config, dimensions, zone.scrollX, zone.originX);
      const y1 = getCellYInZone(minRow, config, dimensions, zone.scrollY, zone.originY);
      const x2 = getCellXInZone(maxCol, config, dimensions, zone.scrollX, zone.originX) +
                 getColumnWidth(maxCol, config, dimensions);
      const y2 = getCellYInZone(maxRow, config, dimensions, zone.scrollY, zone.originY) +
                 getRowHeight(maxRow, config, dimensions);

      const cx1 = Math.max(x1, zone.originX);
      const cy1 = Math.max(y1, zone.originY);
      const cx2 = Math.min(x2, zone.clipRight);
      const cy2 = Math.min(y2, zone.clipBottom);

      if (cx1 >= cx2 || cy1 >= cy2) continue;
      drawMarchingAnts(cx1 + 1, cy1 + 1, cx2 - cx1 - 2, cy2 - cy1 - 2);
    }
    return;
  }

  // ─── Non-split mode ───
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig, splitBarSize);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  drawMarchingAnts(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
}

/**
 * Draw the active cell indicator.
 * Supports freeze panes with proper positioning.
 */
export function drawActiveCell(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions, freezeConfig, splitBarSize = 0 } = state;

  if (!selection) {
    return;
  }

  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  const isEditingThisCell = editing && editing.row === activeRow && editing.col === activeCol;
  if (isEditingThisCell) return;

  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);

  // ─── Split mode: draw active cell border in every zone ───
  const zones = computeSplitZones(state);
  if (zones) {
    for (const zone of zones) {
      const x = getCellXInZone(activeCol, config, dimensions, zone.scrollX, zone.originX);
      const y = getCellYInZone(activeRow, config, dimensions, zone.scrollY, zone.originY);

      if (x + cellWidth < zone.originX || x > zone.clipRight ||
          y + cellHeight < zone.originY || y > zone.clipBottom) continue;

      const visX = Math.max(x, zone.originX);
      const visY = Math.max(y, zone.originY);
      const visW = Math.min(x + cellWidth, zone.clipRight) - visX;
      const visH = Math.min(y + cellHeight, zone.clipBottom) - visY;

      ctx.strokeStyle = theme.activeCellBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(visX + 1, visY + 1, Math.min(cellWidth - 2, visW - 2), Math.min(cellHeight - 2, visH - 2));
    }
    return;
  }

  // ─── Non-split mode ───
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const x = getColumnXWithFreeze(activeCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y = getRowYWithFreeze(activeRow, config, dimensions, viewport, freezeConfig, splitBarSize);

  if (x + cellWidth < rowHeaderWidth || x > width ||
      y + cellHeight < colHeaderHeight || y > height) {
    return;
  }

  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;

  ctx.strokeStyle = theme.activeCellBorder;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    Math.max(x, rowHeaderWidth) + 1,
    Math.max(y, colHeaderHeight) + 1,
    Math.min(cellWidth - 2, visWidth - 2),
    Math.min(cellHeight - 2, visHeight - 2)
  );
}

/**
 * Draw the active cell background (white).
 * Supports freeze panes with proper positioning.
 */
export function drawActiveCellBackground(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions, freezeConfig, splitBarSize = 0 } = state;

  if (!selection) {
    return;
  }

  const activeRow = selection.endRow;
  const activeCol = selection.endCol;

  if (editing && editing.row === activeRow && editing.col === activeCol) {
    return;
  }

  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);

  // ─── Split mode: draw active cell bg in every zone ───
  const zones = computeSplitZones(state);
  if (zones) {
    for (const zone of zones) {
      const x = getCellXInZone(activeCol, config, dimensions, zone.scrollX, zone.originX);
      const y = getCellYInZone(activeRow, config, dimensions, zone.scrollY, zone.originY);

      if (x + cellWidth < zone.originX || x > zone.clipRight ||
          y + cellHeight < zone.originY || y > zone.clipBottom) continue;

      const visX = Math.max(x, zone.originX);
      const visY = Math.max(y, zone.originY);
      const visW = Math.min(x + cellWidth, zone.clipRight) - visX;
      const visH = Math.min(y + cellHeight, zone.clipBottom) - visY;

      ctx.fillStyle = theme.cellBackground;
      ctx.fillRect(visX, visY, visW, visH);
    }
    return;
  }

  // ─── Non-split mode ───
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const x = getColumnXWithFreeze(activeCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y = getRowYWithFreeze(activeRow, config, dimensions, viewport, freezeConfig, splitBarSize);

  if (x + cellWidth < rowHeaderWidth || x > width ||
      y + cellHeight < colHeaderHeight || y > height) {
    return;
  }

  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;

  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(visX, visY, visWidth, visHeight);
}

/**
 * Draw fill preview range (dashed border during fill drag).
 * Supports freeze panes with proper positioning.
 */
export function drawFillPreview(state: RenderState): void {
  const { ctx, width, height, config, viewport, dimensions, freezeConfig, fillPreviewRange, splitBarSize = 0 } = state;

  if (!fillPreviewRange) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const maxRow = Math.max(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const minCol = Math.min(fillPreviewRange.startCol, fillPreviewRange.endCol);
  const maxCol = Math.max(fillPreviewRange.startCol, fillPreviewRange.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig, splitBarSize);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw semi-transparent fill
  ctx.fillStyle = "rgba(22, 163, 74, 0.1)";
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  // Draw dashed border
  ctx.strokeStyle = "#16a34a";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
  ctx.setLineDash([]);
}

/**
 * Draw selection drag preview (dashed border showing where cells will be moved).
 * Supports freeze panes with proper positioning.
 */
export function drawSelectionDragPreview(state: RenderState): void {
  const { ctx, width, height, config, viewport, dimensions, freezeConfig, selectionDragPreview, selectionDragMode = "move", splitBarSize = 0 } = state;

  if (!selectionDragPreview) {
    return;
  }

  const isCopy = selectionDragMode === "copy";
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(selectionDragPreview.startRow, selectionDragPreview.endRow);
  const maxRow = Math.max(selectionDragPreview.startRow, selectionDragPreview.endRow);
  const minCol = Math.min(selectionDragPreview.startCol, selectionDragPreview.endCol);
  const maxCol = Math.max(selectionDragPreview.startCol, selectionDragPreview.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig, splitBarSize);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Copy mode: green tint. Move mode: blue tint.
  ctx.fillStyle = isCopy ? "rgba(22, 163, 74, 0.12)" : "rgba(33, 115, 215, 0.15)";
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  ctx.strokeStyle = isCopy ? "#16a34a" : "#2563eb";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
  ctx.setLineDash([]);

  // Draw "+" badge in copy mode (top-right corner of preview)
  if (isCopy) {
    const badgeSize = 16;
    const badgeX = Math.min(visX2 - 2, width - badgeSize - 2);
    const badgeY = Math.max(visY1 + 2, colHeaderHeight + 2);

    // Badge background
    ctx.fillStyle = "#16a34a";
    ctx.beginPath();
    ctx.arc(badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize / 2, 0, Math.PI * 2);
    ctx.fill();

    // "+" symbol
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(badgeX + 4, badgeY + badgeSize / 2);
    ctx.lineTo(badgeX + badgeSize - 4, badgeY + badgeSize / 2);
    ctx.moveTo(badgeX + badgeSize / 2, badgeY + 4);
    ctx.lineTo(badgeX + badgeSize / 2, badgeY + badgeSize - 4);
    ctx.stroke();
  }
}