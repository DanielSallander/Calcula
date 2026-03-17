//! FILENAME: app/extensions/Controls/Image/imageRenderer.ts
// PURPOSE: Grid overlay render and hit-test functions for floating image controls.
// CONTEXT: Registered with registerGridOverlay() via dispatcher in index.ts.
//          Follows the exact same async-cache pattern as Shape/shapeRenderer.ts.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "../../../src/api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
} from "../../../src/api/gridOverlays";
import { resolveControlProperties } from "../lib/controlApi";
import { isFloatingControlSelected } from "../Button/floatingSelection";

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedImageData {
  src: string;
  opacity: number;
  rotation: number;
}

const imageDataCache = new Map<string, CachedImageData>();
const pendingFetches = new Set<string>();
const staleEntries = new Set<string>();

/** Cache of decoded HTMLImageElement objects keyed by data URL hash. */
const imageElementCache = new Map<string, HTMLImageElement>();
/** Track which data URL is loaded per control for invalidation. */
const controlSrcMap = new Map<string, string>();

/** Invalidate cached data for a specific image control. */
export function invalidateImageCache(controlId: string): void {
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
}

/** Invalidate all cached image data. */
export function invalidateAllImageCaches(): void {
  for (const key of imageDataCache.keys()) {
    staleEntries.add(key);
  }
  pendingFetches.clear();
}

// ============================================================================
// HTMLImageElement Loader
// ============================================================================

/**
 * Get or create an HTMLImageElement for a data URL.
 * Returns null if the image isn't loaded yet (triggers async load).
 */
function getImageElement(controlId: string, src: string): HTMLImageElement | null {
  // Check if we already have this exact src loaded
  const existing = controlSrcMap.get(controlId);
  if (existing === src) {
    const el = imageElementCache.get(src);
    if (el && el.complete && el.naturalWidth > 0) return el;
    // Still loading
    if (el) return null;
  }

  // New src for this control -- load it
  controlSrcMap.set(controlId, src);

  if (imageElementCache.has(src)) {
    const el = imageElementCache.get(src)!;
    if (el.complete && el.naturalWidth > 0) return el;
    return null; // still loading from another control
  }

  const img = new Image();
  img.onload = async () => {
    const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
    requestOverlayRedraw();
  };
  img.onerror = () => {
    console.warn(`[Controls] Failed to load image for ${controlId}`);
  };
  img.src = src;
  imageElementCache.set(src, img);

  return null; // not yet loaded
}

// ============================================================================
// Overlay Render Function
// ============================================================================

/**
 * Render function for floating image controls.
 * Called synchronously for each floating-control region with controlType "image".
 */
export function renderFloatingImage(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;
  if (region.data?.controlType !== "image") return;

  const sheetIndex = region.data?.sheetIndex as number;
  const row = region.data?.row as number;
  const col = region.data?.col as number;
  if (sheetIndex == null || row == null || col == null) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Convert sheet pixel position to canvas pixel position
  const { canvasX, canvasY } = overlaySheetToCanvas(
    overlayCtx,
    region.floating.x,
    region.floating.y,
  );
  const imgWidth = region.floating.width;
  const imgHeight = region.floating.height;

  const endX = canvasX + imgWidth;
  const endY = canvasY + imgHeight;

  // Skip if not visible
  if (endX < rowHeaderWidth || endY < colHeaderHeight) return;
  if (canvasX > overlayCtx.canvasWidth || canvasY > overlayCtx.canvasHeight) return;

  // Clip to cell area (not over headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // Get cached image data or trigger async fetch
  const controlId = region.id;
  let data = imageDataCache.get(controlId);
  const isStale = staleEntries.has(controlId);

  if ((!data || isStale) && !pendingFetches.has(controlId)) {
    fetchImageData(controlId, sheetIndex, row, col);
  }
  if (!data) {
    data = {
      src: "",
      opacity: 1,
      rotation: 0,
    };
  }

  // Apply opacity
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, data.opacity));

  // Apply rotation around center
  if (data.rotation !== 0) {
    const cx = canvasX + imgWidth / 2;
    const cy = canvasY + imgHeight / 2;
    ctx.translate(cx, cy);
    ctx.rotate((data.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // Draw the image
  if (data.src) {
    const imgEl = getImageElement(controlId, data.src);
    if (imgEl) {
      ctx.drawImage(imgEl, canvasX, canvasY, imgWidth, imgHeight);
    } else {
      // Placeholder while loading
      drawPlaceholder(ctx, canvasX, canvasY, imgWidth, imgHeight, "Loading...");
    }
  } else {
    // No source set
    drawPlaceholder(ctx, canvasX, canvasY, imgWidth, imgHeight, "No Image");
  }

  // Restore opacity
  ctx.globalAlpha = prevAlpha;

  // Selection indicators (images are always selectable, like shapes)
  const selected = isFloatingControlSelected(controlId);
  if (selected) {
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, imgWidth - 2, imgHeight - 2);
    drawResizeHandles(ctx, canvasX, canvasY, imgWidth, imgHeight);
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for floating image overlay regions.
 */
export function hitTestFloatingImage(hitCtx: OverlayHitTestContext): boolean {
  if (hitCtx.region.data?.controlType !== "image") return false;

  if (hitCtx.floatingCanvasBounds) {
    const b = hitCtx.floatingCanvasBounds;
    return (
      hitCtx.canvasX >= b.x &&
      hitCtx.canvasX <= b.x + b.width &&
      hitCtx.canvasY >= b.y &&
      hitCtx.canvasY <= b.y + b.height
    );
  }
  return false;
}

// ============================================================================
// Async Data Fetch
// ============================================================================

async function fetchImageData(
  controlId: string,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  pendingFetches.add(controlId);
  try {
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    if (!resolved || Object.keys(resolved).length === 0) return;

    imageDataCache.set(controlId, {
      src: resolved.src ?? "",
      opacity: parseFloat(resolved.opacity ?? "1") || 1,
      rotation: parseFloat(resolved.rotation ?? "0") || 0,
    });
    staleEntries.delete(controlId);

    // Update floating control dimensions if width/height resolved from formula
    const resolvedWidth = resolved.width ? parseFloat(resolved.width) : NaN;
    const resolvedHeight = resolved.height ? parseFloat(resolved.height) : NaN;
    if (!isNaN(resolvedWidth) || !isNaN(resolvedHeight)) {
      const {
        getFloatingControl,
        resizeFloatingControl,
        syncFloatingControlRegions,
      } = await import("../lib/floatingStore");
      const ctrl = getFloatingControl(controlId);
      if (ctrl) {
        const w = !isNaN(resolvedWidth) && resolvedWidth > 0 ? resolvedWidth : ctrl.width;
        const h = !isNaN(resolvedHeight) && resolvedHeight > 0 ? resolvedHeight : ctrl.height;
        if (w !== ctrl.width || h !== ctrl.height) {
          resizeFloatingControl(controlId, ctrl.x, ctrl.y, w, h);
          syncFloatingControlRegions();
        }
      }
    }

    // Request redraw to show fetched data
    const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
    requestOverlayRedraw();
  } catch (err) {
    console.error(`[Controls] Failed to fetch image data for ${controlId}:`, err);
  } finally {
    pendingFetches.delete(controlId);
  }
}

// ============================================================================
// Drawing Helpers
// ============================================================================

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
): void {
  // Light gray background
  ctx.fillStyle = "#F0F0F0";
  ctx.fillRect(x, y, w, h);

  // Border
  ctx.strokeStyle = "#CCCCCC";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([]);

  // Icon (simple image icon)
  const iconSize = Math.min(w, h, 40) * 0.5;
  const cx = x + w / 2;
  const cy = y + h / 2 - 6;
  ctx.fillStyle = "#BBBBBB";
  ctx.fillRect(cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);

  // Mountain/landscape in the icon
  ctx.fillStyle = "#F0F0F0";
  ctx.beginPath();
  ctx.moveTo(cx - iconSize / 2, cy + iconSize / 2);
  ctx.lineTo(cx - iconSize / 4, cy);
  ctx.lineTo(cx, cy + iconSize / 4);
  ctx.lineTo(cx + iconSize / 4, cy - iconSize / 6);
  ctx.lineTo(cx + iconSize / 2, cy + iconSize / 2);
  ctx.closePath();
  ctx.fill();

  // Label text
  ctx.fillStyle = "#999999";
  ctx.font = "11px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(label, cx, cy + iconSize / 2 + 4);
}

function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const handleSize = 6;
  ctx.fillStyle = "#0e639c";

  // Four corners
  ctx.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);

  // Four midpoints
  ctx.fillRect(x + w / 2 - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w / 2 - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2, y + h / 2 - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y + h / 2 - handleSize / 2, handleSize, handleSize);
}
