//! FILENAME: app/extensions/Slicer/rendering/slicerRenderer.ts
// PURPOSE: Canvas rendering and hit testing for slicer overlay objects.
// CONTEXT: Renders floating slicer panels on the grid canvas with header bar,
//          item buttons, and clear-filter control.

import {
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "../../../src/api/gridOverlays";
import { getSlicerById, getCachedItems } from "../lib/slicerStore";

// ============================================================================
// Style Constants
// ============================================================================

const HEADER_HEIGHT = 28;
const ITEM_HEIGHT = 24;
const ITEM_PADDING = 4;
const CLEAR_BUTTON_SIZE = 16;
const BORDER_RADIUS = 3;
const FONT_FAMILY = "Calibri, Segoe UI, sans-serif";

// Style presets (matching Excel slicer styles)
const STYLE_COLORS: Record<string, { bg: string; headerBg: string; headerFg: string; selectedBg: string; selectedFg: string; itemBg: string; itemFg: string; border: string }> = {
  SlicerStyleLight1: {
    bg: "#FFFFFF",
    headerBg: "#4472C4",
    headerFg: "#FFFFFF",
    selectedBg: "#4472C4",
    selectedFg: "#FFFFFF",
    itemBg: "#F2F2F2",
    itemFg: "#333333",
    border: "#D6D6D6",
  },
  SlicerStyleLight2: {
    bg: "#FFFFFF",
    headerBg: "#ED7D31",
    headerFg: "#FFFFFF",
    selectedBg: "#ED7D31",
    selectedFg: "#FFFFFF",
    itemBg: "#FFF2E6",
    itemFg: "#333333",
    border: "#D6D6D6",
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

function getStyleColors(preset: string) {
  return STYLE_COLORS[preset] || STYLE_COLORS.SlicerStyleLight1;
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

  // Convert floating sheet coordinates to canvas coordinates
  const { canvasX, canvasY } = overlaySheetToCanvas(ctx, slicer.x, slicer.y);
  const w = slicer.width;
  const h = slicer.height;

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

    // Header text
    c.fillStyle = colors.headerFg;
    c.font = `bold 12px ${FONT_FAMILY}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(
      slicer.name,
      canvasX + 8,
      canvasY + HEADER_HEIGHT / 2,
      w - CLEAR_BUTTON_SIZE - 20,
    );

    // Clear filter button (X) - show only when filter is active
    if (slicer.selectedItems !== null) {
      const btnX = canvasX + w - CLEAR_BUTTON_SIZE - 6;
      const btnY = canvasY + (HEADER_HEIGHT - CLEAR_BUTTON_SIZE) / 2;
      c.fillStyle = "rgba(255,255,255,0.3)";
      c.fillRect(btnX, btnY, CLEAR_BUTTON_SIZE, CLEAR_BUTTON_SIZE);
      c.strokeStyle = colors.headerFg;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(btnX + 4, btnY + 4);
      c.lineTo(btnX + CLEAR_BUTTON_SIZE - 4, btnY + CLEAR_BUTTON_SIZE - 4);
      c.moveTo(btnX + CLEAR_BUTTON_SIZE - 4, btnY + 4);
      c.lineTo(btnX + 4, btnY + CLEAR_BUTTON_SIZE - 4);
      c.stroke();
    }
  }

  // Item list
  const itemStartY = canvasY + (slicer.showHeader ? HEADER_HEIGHT : 0);
  const availableHeight = h - (slicer.showHeader ? HEADER_HEIGHT : 0);
  const cols = slicer.columns;
  const colWidth = w / cols;

  c.font = `11px ${FONT_FAMILY}`;
  c.textAlign = "left";
  c.textBaseline = "middle";

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const itemX = canvasX + col * colWidth + ITEM_PADDING;
    const itemY = itemStartY + row * ITEM_HEIGHT;

    // Stop if outside visible area
    if (itemY - canvasY > h) break;
    if (itemY + ITEM_HEIGHT < itemStartY) continue;

    const itemW = colWidth - ITEM_PADDING * 2;
    const itemH = ITEM_HEIGHT - 2;

    if (item.selected) {
      // Selected item - highlighted
      c.fillStyle = colors.selectedBg;
      c.beginPath();
      c.roundRect(itemX, itemY + 1, itemW, itemH, 2);
      c.fill();
      c.fillStyle = colors.selectedFg;
    } else {
      // Deselected item - muted
      c.fillStyle = colors.itemBg;
      c.beginPath();
      c.roundRect(itemX, itemY + 1, itemW, itemH, 2);
      c.fill();
      c.fillStyle = item.hasData ? colors.itemFg : "#AAAAAA";
    }

    c.fillText(item.value, itemX + 6, itemY + ITEM_HEIGHT / 2, itemW - 12);
  }

  // Border
  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.stroke();

  c.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

export interface SlicerHitResult {
  type: "header" | "clearButton" | "item" | "body";
  itemIndex?: number;
  itemValue?: string;
}

/**
 * Hit test a slicer. Returns true if the point is within the slicer bounds.
 */
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

/**
 * Determine what was clicked within a slicer.
 * Call this after hitTestSlicer returns true.
 */
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
    // Clear button
    if (
      slicer.selectedItems !== null &&
      relX > bounds.width - CLEAR_BUTTON_SIZE - 6
    ) {
      return { type: "clearButton" };
    }
    return { type: "header" };
  }

  // Item area
  const itemStartY = slicer.showHeader ? HEADER_HEIGHT : 0;
  const itemRelY = relY - itemStartY;

  if (itemRelY >= 0) {
    const cols = slicer.columns;
    const colWidth = bounds.width / cols;
    const col = Math.floor(relX / colWidth);
    const row = Math.floor(itemRelY / ITEM_HEIGHT);
    const itemIndex = row * cols + col;

    if (itemIndex >= 0 && itemIndex < items.length) {
      return {
        type: "item",
        itemIndex,
        itemValue: items[itemIndex].value,
      };
    }
  }

  return { type: "body" };
}
