//! FILENAME: app/extensions/Slicer/rendering/slicerRenderer.ts
// PURPOSE: Canvas rendering and hit testing for slicer overlay objects.
// CONTEXT: Renders floating slicer panels on the grid canvas with header bar,
//          item buttons, clear-filter control, and vertical scrolling.
//          Supports vertical, horizontal, and grid arrangements.

import {
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
  type OverlayCursorFn,
} from "@api/gridOverlays";
import { getSlicerById, getCachedItems } from "../lib/slicerStore";
import { isSlicerSelected } from "../handlers/selectionHandler";
import { SLICER_STYLES_BY_ID } from "../components/SlicerStylesGallery";
import type { Slicer, SlicerItem } from "../lib/slicerTypes";

// ============================================================================
// Style Constants
// ============================================================================

const HEADER_HEIGHT = 32;
const ITEM_HEIGHT = 26;
const CLEAR_BUTTON_SIZE = 20;
const BORDER_RADIUS = 3;
const FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
const SCROLLBAR_WIDTH = 8;
const SCROLLBAR_MIN_THUMB = 20;
const SELECT_ALL_LABEL = "Select all";

// Legacy style presets (for backward compatibility with old IDs)
const LEGACY_STYLE_COLORS: Record<string, StyleColors> = {
  SlicerStyleLight1: {
    bg: "#FFFFFF",
    headerBg: "#4472C4",
    headerFg: "#FFFFFF",
    selectedBg: "#4472C4",
    selectedFg: "#FFFFFF",
    itemBg: "#edf2f9",
    itemFg: "#333333",
    border: "#8faadc",
  },
  SlicerStyleLight2: {
    bg: "#FFFFFF",
    headerBg: "#ED7D31",
    headerFg: "#FFFFFF",
    selectedBg: "#ED7D31",
    selectedFg: "#FFFFFF",
    itemBg: "#fdf2eb",
    itemFg: "#333333",
    border: "#f4b183",
  },
  SlicerStyleDark1: {
    bg: "#333333",
    headerBg: "#4472C4",
    headerFg: "#FFFFFF",
    selectedBg: "#4472C4",
    selectedFg: "#FFFFFF",
    itemBg: "#444444",
    itemFg: "#EEEEEE",
    border: "#555555",
  },
};

interface StyleColors {
  bg: string;
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  itemBg: string;
  itemFg: string;
  border: string;
}

const DEFAULT_COLORS: StyleColors = LEGACY_STYLE_COLORS.SlicerStyleLight1;

function getStyleColors(preset: string): StyleColors {
  const galleryStyle = SLICER_STYLES_BY_ID.get(preset);
  if (galleryStyle) {
    return galleryStyle.thumb;
  }
  return LEGACY_STYLE_COLORS[preset] || DEFAULT_COLORS;
}

// ============================================================================
// Layout Helpers
// ============================================================================

interface LayoutInfo {
  cols: number;
  totalItems: number; // items.length + selectAll offset
  itemH: number;
  gap: number;
  cellW: number;
  cellH: number;
  contentHeight: number;
  contentWidth: number;
  needsScroll: boolean;
  isHorizontal: boolean;
  selectAllOffset: number; // 1 if showSelectAll, else 0
  padding: number; // internal padding around items
  buttonRadius: number; // corner radius for item buttons
}

function computeLayout(slicer: Slicer, itemCount: number, viewportW: number, viewportH: number): LayoutInfo {
  const gap = slicer.itemGap ?? 4;
  const padding = slicer.itemPadding ?? 0;
  const buttonRadius = slicer.buttonRadius ?? 2;
  const itemH = ITEM_HEIGHT;
  const selectAllOffset = slicer.showSelectAll ? 1 : 0;
  const total = itemCount + selectAllOffset;
  const innerW = viewportW - padding * 2;
  const innerH = viewportH - padding * 2;

  if (slicer.arrangement === "horizontal") {
    const cols = slicer.columns > 1 ? Math.min(slicer.columns, total) : total;
    const cellW = cols > 0 ? (innerW + gap) / cols - gap : innerW;
    const cellH = itemH;
    const rows = Math.ceil(total / cols);
    const contentWidth = total * (cellW + gap) - gap;
    const contentHeight = rows * (cellH + gap) - gap;
    return {
      cols,
      totalItems: total,
      itemH,
      gap,
      cellW,
      cellH,
      contentHeight,
      contentWidth,
      needsScroll: contentWidth > innerW,
      isHorizontal: true,
      selectAllOffset,
      padding,
      buttonRadius,
    };
  }

  if (slicer.arrangement === "grid") {
    const cols = Math.max(1, slicer.columns);
    const cellW = cols > 0 ? (innerW + gap) / cols - gap : innerW;
    const cellH = itemH;
    const rows = Math.ceil(total / cols);
    const contentHeight = rows * (cellH + gap) - gap;
    return {
      cols,
      totalItems: total,
      itemH,
      gap,
      cellW,
      cellH,
      contentHeight,
      contentWidth: innerW,
      needsScroll: contentHeight > innerH,
      isHorizontal: false,
      selectAllOffset,
      padding,
      buttonRadius,
    };
  }

  // Vertical (default) — still respects slicer.columns so the ribbon
  // "Columns" dropdown works regardless of arrangement mode.
  const cols = Math.max(1, slicer.columns);
  const cellW = cols > 1 ? (innerW + gap) / cols - gap : innerW;
  const cellH = itemH;
  const rows = Math.ceil(total / cols);
  const contentHeight = rows * (cellH + gap) - (rows > 0 ? gap : 0);
  return {
    cols,
    totalItems: total,
    itemH,
    gap,
    cellW,
    cellH,
    contentHeight,
    contentWidth: innerW,
    needsScroll: contentHeight > innerH,
    isHorizontal: false,
    selectAllOffset,
    padding,
    buttonRadius,
  };
}

// ============================================================================
// Scroll State
// ============================================================================

const scrollOffsets = new Map<number, number>();

export function getScrollOffset(slicerId: number): number {
  return scrollOffsets.get(slicerId) ?? 0;
}

export function setScrollOffset(slicerId: number, offset: number): void {
  const max = getMaxScrollOffset(slicerId);
  scrollOffsets.set(slicerId, Math.max(0, Math.min(offset, max)));
}

export function getMaxScrollOffset(slicerId: number): number {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return 0;

  const items = getCachedItems(slicerId) ?? [];
  const headerH = slicer.showHeader ? HEADER_HEIGHT : 0;
  const viewportH = slicer.height - headerH;
  const viewportW = slicer.width;
  const preLayout = computeLayout(slicer, items.length, viewportW, viewportH);
  const scrollbarW = preLayout.needsScroll && !preLayout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  const layout = scrollbarW > 0 ? computeLayout(slicer, items.length, viewportW - scrollbarW, viewportH) : preLayout;

  if (layout.isHorizontal) {
    return Math.max(0, layout.contentWidth - viewportW);
  }
  return Math.max(0, layout.contentHeight - viewportH);
}

export function resetScrollOffsets(): void {
  scrollOffsets.clear();
}

// ============================================================================
// Renderer
// ============================================================================

export function renderSlicer(ctx: OverlayRenderContext): void {
  const slicerId = ctx.region.data?.slicerId as number | undefined;
  if (slicerId == null) return;

  const slicer = getSlicerById(slicerId);
  if (slicer == null) return;

  const items = getCachedItems(slicerId) ?? [];
  const c = ctx.ctx;
  const colors = getStyleColors(slicer.stylePreset);

  const { canvasX, canvasY } = overlaySheetToCanvas(ctx, slicer.x, slicer.y);
  const w = slicer.width;
  const h = slicer.height;

  const headerH = slicer.showHeader ? HEADER_HEIGHT : 0;
  const viewportH = h - headerH;
  // First pass: compute layout with full width to determine if scrollbar is needed
  const preLayout = computeLayout(slicer, items.length, w, viewportH);
  const scrollbarW = preLayout.needsScroll && !preLayout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  // Second pass: use adjusted width (minus scrollbar) for accurate item sizing
  const layout = scrollbarW > 0 ? computeLayout(slicer, items.length, w - scrollbarW, viewportH) : preLayout;
  // Clamp scroll offset to valid range (handles mode switches where old offset is too large)
  const maxScroll = layout.isHorizontal
    ? Math.max(0, layout.contentWidth - (w - scrollbarW))
    : Math.max(0, layout.contentHeight - viewportH);
  const scrollVal = Math.min(getScrollOffset(slicerId), maxScroll);

  // Clip to slicer bounds
  c.save();
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.clip();

  // Background
  c.fillStyle = colors.bg;
  c.fillRect(canvasX, canvasY, w, h);

  // Header bar
  if (slicer.showHeader) {
    c.fillStyle = colors.headerBg;
    c.fillRect(canvasX, canvasY, w, HEADER_HEIGHT);

    c.fillStyle = colors.headerFg;
    c.font = `bold 12px ${FONT_FAMILY}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(
      slicer.headerText ?? slicer.name,
      canvasX + 10,
      canvasY + HEADER_HEIGHT / 2,
      w - CLEAR_BUTTON_SIZE - 24,
    );

    const isFiltered = slicer.selectedItems !== null;
    const btnX = canvasX + w - CLEAR_BUTTON_SIZE - 4;
    const btnY = canvasY + (HEADER_HEIGHT - CLEAR_BUTTON_SIZE) / 2;
    drawClearFilterButton(c, btnX, btnY, CLEAR_BUTTON_SIZE, isFiltered, colors.headerFg);
  }

  // Item list — clip to item viewport
  const itemAreaTop = canvasY + headerH;
  const itemAreaLeft = canvasX;
  const scrollbarH = layout.needsScroll && layout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  const itemAreaW = w - scrollbarW;
  const itemAreaH = viewportH - scrollbarH;
  const pad = layout.padding;
  const btnR = layout.buttonRadius;

  c.save();
  c.beginPath();
  c.rect(itemAreaLeft, itemAreaTop, itemAreaW, viewportH);
  c.clip();

  c.font = `11px ${FONT_FAMILY}`;
  c.textAlign = "left";
  c.textBaseline = "middle";

  const { cols, gap, cellW, cellH, selectAllOffset } = layout;

  // Render each item (including "Select all" at index 0 if enabled)
  for (let vi = 0; vi < layout.totalItems; vi++) {
    const isSelectAll = vi < selectAllOffset;
    const item: SlicerItem | null = isSelectAll
      ? null
      : items[vi - selectAllOffset];

    let ix: number;
    let iy: number;

    if (layout.isHorizontal) {
      // Horizontal: single row, scroll horizontally
      ix = itemAreaLeft + pad + vi * (cellW + gap) - scrollVal;
      iy = itemAreaTop + pad;
    } else {
      // Vertical or Grid
      const col = vi % cols;
      const row = Math.floor(vi / cols);
      ix = itemAreaLeft + pad + col * (cellW + gap);
      iy = itemAreaTop + pad + row * (cellH + gap) - scrollVal;
    }

    // Skip items outside visible area
    if (layout.isHorizontal) {
      if (ix + cellW < itemAreaLeft) continue;
      if (ix > itemAreaLeft + itemAreaW) break;
    } else {
      if (iy + cellH < itemAreaTop) continue;
      if (iy > itemAreaTop + itemAreaH) break;
    }

    if (isSelectAll) {
      // "Select all" row
      const allSelected = slicer.selectedItems === null;
      c.fillStyle = allSelected ? colors.selectedBg : colors.itemBg;
      c.beginPath();
      c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
      c.fill();
      c.fillStyle = allSelected ? colors.selectedFg : colors.itemFg;
      c.fillText(SELECT_ALL_LABEL, ix + 8, iy + cellH / 2, cellW - 16);
    } else if (item) {
      const showAsNoData = !item.hasData && slicer.indicateNoData;

      if (item.selected && !showAsNoData) {
        c.fillStyle = colors.selectedBg;
        c.beginPath();
        c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
        c.fill();
        c.fillStyle = colors.selectedFg;
      } else {
        c.fillStyle = showAsNoData ? "#E8E8E8" : colors.itemBg;
        c.beginPath();
        c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
        c.fill();
        c.fillStyle = showAsNoData
          ? "#BBBBBB"
          : item.selected
            ? colors.selectedFg
            : colors.itemFg;
      }

      c.fillText(item.value, ix + 8, iy + cellH / 2, cellW - 16);
    }
  }

  c.restore(); // restore item-area clip

  // Scrollbar
  if (layout.needsScroll) {
    if (layout.isHorizontal) {
      drawHScrollbar(
        c,
        itemAreaLeft,
        itemAreaTop + viewportH - SCROLLBAR_WIDTH,
        itemAreaW,
        SCROLLBAR_WIDTH,
        scrollVal,
        layout.contentWidth,
      );
    } else {
      drawScrollbar(
        c,
        canvasX + w - SCROLLBAR_WIDTH,
        itemAreaTop,
        SCROLLBAR_WIDTH,
        viewportH,
        scrollVal,
        layout.contentHeight,
      );
    }
  }

  // Border
  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.stroke();

  // Selection highlight border
  if (isSlicerSelected(slicerId!)) {
    c.strokeStyle = "#0078D4";
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(canvasX - 0.5, canvasY - 0.5, w + 1, h + 1, BORDER_RADIUS + 1);
    c.stroke();
  }

  c.restore(); // restore slicer clip
}

// ============================================================================
// Scrollbar Drawing
// ============================================================================

function drawScrollbar(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  trackHeight: number,
  scrollOffset: number,
  contentHeight: number,
): void {
  c.fillStyle = "rgba(0, 0, 0, 0.05)";
  c.fillRect(x, y, width, trackHeight);

  const thumbRatio = trackHeight / contentHeight;
  const thumbHeight = Math.max(SCROLLBAR_MIN_THUMB, trackHeight * thumbRatio);
  const scrollRange = contentHeight - trackHeight;
  const thumbRange = trackHeight - thumbHeight;
  const thumbY = scrollRange > 0 ? y + (scrollOffset / scrollRange) * thumbRange : y;

  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.beginPath();
  c.roundRect(x + 1, thumbY, width - 2, thumbHeight, (width - 2) / 2);
  c.fill();
}

function drawHScrollbar(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  trackWidth: number,
  height: number,
  scrollOffset: number,
  contentWidth: number,
): void {
  c.fillStyle = "rgba(0, 0, 0, 0.05)";
  c.fillRect(x, y, trackWidth, height);

  const thumbRatio = trackWidth / contentWidth;
  const thumbWidth = Math.max(SCROLLBAR_MIN_THUMB, trackWidth * thumbRatio);
  const scrollRange = contentWidth - trackWidth;
  const thumbRange = trackWidth - thumbWidth;
  const thumbX = scrollRange > 0 ? x + (scrollOffset / scrollRange) * thumbRange : x;

  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.beginPath();
  c.roundRect(thumbX, y + 1, thumbWidth, height - 2, (height - 2) / 2);
  c.fill();
}

// ============================================================================
// Clear Filter Button
// ============================================================================

function drawClearFilterButton(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  isActive: boolean,
  headerFg: string,
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const sc = size * 0.4;

  if (isActive) {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 1.0;
  } else {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 0.3;
  }

  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(cx - sc, cy - sc * 0.8);
  c.lineTo(cx + sc, cy - sc * 0.8);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.1);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.1);
  c.closePath();
  c.fill();

  if (isActive) {
    c.globalAlpha = 1.0;
    c.strokeStyle = "#FF4444";
    c.lineWidth = 2;
    const xOff = sc * 0.6;
    c.beginPath();
    c.moveTo(cx - xOff, cy - xOff);
    c.lineTo(cx + xOff, cy + xOff);
    c.moveTo(cx + xOff, cy - xOff);
    c.lineTo(cx - xOff, cy + xOff);
    c.stroke();
  }

  c.globalAlpha = 1.0;
}

// ============================================================================
// Hit Testing
// ============================================================================

export interface SlicerHitResult {
  type: "header" | "clearButton" | "item" | "selectAll" | "body" | "scrollbar";
  itemIndex?: number;
  itemValue?: string;
}

export function hitTestSlicer(ctx: OverlayHitTestContext): boolean {
  if (!ctx.floatingCanvasBounds) return false;

  const { x, y, width, height } = ctx.floatingCanvasBounds;
  return (
    ctx.canvasX >= x &&
    ctx.canvasX <= x + width &&
    ctx.canvasY >= y &&
    ctx.canvasY <= y + height
  );
}

export function getSlicerHitDetail(
  canvasX: number,
  canvasY: number,
  bounds: { x: number; y: number; width: number; height: number },
  slicerId: number,
): SlicerHitResult | null {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return null;

  const items = getCachedItems(slicerId) ?? [];
  const relX = canvasX - bounds.x;
  const relY = canvasY - bounds.y;

  // Header area
  if (slicer.showHeader && relY < HEADER_HEIGHT) {
    if (relX > bounds.width - CLEAR_BUTTON_SIZE - 4) {
      return { type: "clearButton" };
    }
    return { type: "header" };
  }

  // Item area
  const headerH = slicer.showHeader ? HEADER_HEIGHT : 0;
  const viewportH = bounds.height - headerH;
  // Two-pass layout (same as renderer): check if scrollbar needed, then recompute with adjusted width
  const preLayout = computeLayout(slicer, items.length, bounds.width, viewportH);
  const scrollbarW = preLayout.needsScroll && !preLayout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  const layout = scrollbarW > 0 ? computeLayout(slicer, items.length, bounds.width - scrollbarW, viewportH) : preLayout;
  const itemAreaW = bounds.width - scrollbarW;
  const itemRelX = relX;
  const itemRelY = relY - headerH;

  // Scrollbar area
  if (layout.needsScroll && !layout.isHorizontal && relX > bounds.width - SCROLLBAR_WIDTH && itemRelY >= 0) {
    return { type: "scrollbar" };
  }
  if (layout.needsScroll && layout.isHorizontal && itemRelY > viewportH - SCROLLBAR_WIDTH) {
    return { type: "scrollbar" };
  }

  if (itemRelY >= 0) {
    const scrollVal = getScrollOffset(slicerId);
    const { cols, gap, cellW, cellH, selectAllOffset, padding: pad } = layout;
    // Subtract padding from hit coordinates
    const padRelX = itemRelX - pad;
    const padRelY = itemRelY - pad;

    let vi: number;
    if (layout.isHorizontal) {
      vi = Math.floor((padRelX + scrollVal) / (cellW + gap));
    } else {
      const col = Math.floor(padRelX / (cellW + gap));
      const row = Math.floor((padRelY + scrollVal) / (cellH + gap));
      vi = row * cols + col;
      if (col < 0 || col >= cols) return { type: "body" };
    }

    if (vi >= 0 && vi < layout.totalItems) {
      if (vi < selectAllOffset) {
        return { type: "selectAll" };
      }
      const itemIndex = vi - selectAllOffset;
      if (itemIndex >= 0 && itemIndex < items.length) {
        return {
          type: "item",
          itemIndex,
          itemValue: items[itemIndex].value,
        };
      }
    }
  }

  return { type: "body" };
}

export const getSlicerCursor: OverlayCursorFn = (ctx) => {
  if (!ctx.floatingCanvasBounds) return null;

  const slicerId = ctx.region.data?.slicerId as number | undefined;
  if (slicerId == null) return null;

  const hit = getSlicerHitDetail(
    ctx.canvasX,
    ctx.canvasY,
    ctx.floatingCanvasBounds,
    slicerId,
  );
  if (!hit) return null;

  switch (hit.type) {
    case "item":
    case "selectAll":
    case "clearButton":
      return "pointer";
    default:
      return null;
  }
};
