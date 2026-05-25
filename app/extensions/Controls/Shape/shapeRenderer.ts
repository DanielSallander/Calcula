//! FILENAME: app/extensions/Controls/Shape/shapeRenderer.ts
// PURPOSE: Grid overlay render and hit-test functions for floating shape controls.
// CONTEXT: Registered with registerGridOverlay() via dispatcher in index.ts.
//          Follows the exact same async-cache pattern as Button/floatingRenderer.ts.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
} from "@api/gridOverlays";
import { getDesignMode } from "../lib/designMode";
import { resolveControlProperties } from "../lib/controlApi";
import { isFloatingControlSelected, getSelectedFloatingControls } from "../Button/floatingSelection";
import { getShapeDefinition, isConnectorShape, type ShapePathCommand } from "./shapeCatalog";

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedShapeData {
  shapeType: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
  textColor: string;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
  textAlign: CanvasTextAlign;
  opacity: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

const shapeDataCache = new Map<string, CachedShapeData>();
const pendingFetches = new Set<string>();

/**
 * Set of control IDs whose cached data is stale.
 * Stale entries are kept visible during rendering while a re-fetch is
 * in progress, preventing a visible "blink" to default values.
 */
const staleEntries = new Set<string>();

// ============================================================================
// Custom Renderers (from shape scripts)
// ============================================================================

type CustomCanvasRenderer = (ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void;

/** Map of controlId -> custom canvas renderer provided by a shape script. */
const customCanvasRenderers = new Map<string, CustomCanvasRenderer>();

/** Map of controlId -> HTML content string provided by a shape script. */
const customHtmlContent = new Map<string, string>();

/** Map of controlId -> DOM overlay element for HTML-rendered shapes. */
const htmlOverlayElements = new Map<string, HTMLDivElement>();

/** Register a custom canvas renderer for a shape. */
export function setCustomCanvasRenderer(instanceId: string, renderer: CustomCanvasRenderer): void {
  customCanvasRenderers.set(instanceId, renderer);
}

/** Remove a custom canvas renderer for a shape. */
export function removeCustomCanvasRenderer(instanceId: string): void {
  customCanvasRenderers.delete(instanceId);
}

/** Set HTML content for a shape (will skip canvas rendering). */
export function setShapeHtmlContent(instanceId: string, html: string): void {
  customHtmlContent.set(instanceId, html);
  // Update existing overlay element if present
  const el = htmlOverlayElements.get(instanceId);
  if (el) {
    el.innerHTML = html;
  }
}

/** Get HTML content for a shape. */
export function getShapeHtmlContent(instanceId: string): string | undefined {
  return customHtmlContent.get(instanceId);
}

/** Check if a shape has custom HTML content. */
export function hasShapeHtmlContent(instanceId: string): boolean {
  return customHtmlContent.has(instanceId);
}

/** Remove the HTML overlay DOM element for a shape (cleanup on deletion). */
export function removeShapeHtmlOverlay(instanceId: string): void {
  const el = htmlOverlayElements.get(instanceId);
  if (el) {
    el.remove();
    htmlOverlayElements.delete(instanceId);
  }
  customHtmlContent.delete(instanceId);
}

/**
 * Create or update the positioned HTML overlay element for a shape.
 * Called from the render loop with current viewport info.
 */
function updateHtmlOverlay(
  controlId: string,
  html: string,
  canvasX: number,
  canvasY: number,
  width: number,
  height: number,
  rowHeaderWidth: number,
  colHeaderHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  canvasParent: HTMLElement,
): void {
  let el = htmlOverlayElements.get(controlId);

  // Create element if it doesn't exist
  if (!el) {
    el = document.createElement("div");
    el.dataset.shapeOverlay = controlId;
    el.style.position = "absolute";
    el.style.overflow = "hidden";
    el.style.boxSizing = "border-box";
    el.style.pointerEvents = "none";
    el.style.zIndex = "5";
    el.style.fontFamily = "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
    el.style.fontSize = "12px";
    el.innerHTML = html;
    canvasParent.appendChild(el);
    htmlOverlayElements.set(controlId, el);
  }

  // Check visibility: hide if off-screen or behind headers
  const endX = canvasX + width;
  const endY = canvasY + height;
  const isVisible = endX > rowHeaderWidth && endY > colHeaderHeight &&
                    canvasX < canvasWidth && canvasY < canvasHeight;

  if (!isVisible) {
    el.style.display = "none";
    return;
  }

  el.style.display = "block";

  // Clip to visible area (don't overlap headers)
  const clippedLeft = Math.max(canvasX, rowHeaderWidth);
  const clippedTop = Math.max(canvasY, colHeaderHeight);
  const clippedRight = Math.min(endX, canvasWidth);
  const clippedBottom = Math.min(endY, canvasHeight);

  el.style.left = `${clippedLeft}px`;
  el.style.top = `${clippedTop}px`;
  el.style.width = `${clippedRight - clippedLeft}px`;
  el.style.height = `${clippedBottom - clippedTop}px`;

  // Update content if changed
  if (el.innerHTML !== html) {
    el.innerHTML = html;
  }
}

/** Invalidate cached data for a specific shape control. */
export function invalidateShapeCache(controlId: string): void {
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
}

/** Invalidate all cached shape data. */
export function invalidateAllShapeCaches(): void {
  for (const key of shapeDataCache.keys()) {
    staleEntries.add(key);
  }
  pendingFetches.clear();
}

// ============================================================================
// Selection Indicator Helper
// ============================================================================

/**
 * Draw selection border and resize handles for a shape control.
 * Used by both default and custom renderers.
 */
function drawSelectionIndicators(
  ctx: CanvasRenderingContext2D,
  controlId: string,
  canvasX: number,
  canvasY: number,
  shapeWidth: number,
  shapeHeight: number,
  _overlayCtx: OverlayRenderContext,
): void {
  if (!getDesignMode()) return;
  const selected = isFloatingControlSelected(controlId);
  if (!selected) return;

  ctx.strokeStyle = "#0e639c";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(canvasX + 1, canvasY + 1, shapeWidth - 2, shapeHeight - 2);
  drawResizeHandles(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
}

// ============================================================================
// Path Rendering
// ============================================================================

/**
 * Build a Canvas 2D path from normalized shape path commands.
 * Coordinates are scaled from [0,1] to actual [width, height] with offset.
 */
function buildPath(
  ctx: CanvasRenderingContext2D,
  commands: ShapePathCommand[],
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): void {
  ctx.beginPath();
  for (const cmd of commands) {
    switch (cmd.op) {
      case "M":
        ctx.moveTo(offsetX + cmd.x * width, offsetY + cmd.y * height);
        break;
      case "L":
        ctx.lineTo(offsetX + cmd.x * width, offsetY + cmd.y * height);
        break;
      case "C":
        ctx.bezierCurveTo(
          offsetX + cmd.x1 * width,
          offsetY + cmd.y1 * height,
          offsetX + cmd.x2 * width,
          offsetY + cmd.y2 * height,
          offsetX + cmd.x * width,
          offsetY + cmd.y * height,
        );
        break;
      case "Q":
        ctx.quadraticCurveTo(
          offsetX + cmd.x1 * width,
          offsetY + cmd.y1 * height,
          offsetX + cmd.x * width,
          offsetY + cmd.y * height,
        );
        break;
      case "Z":
        ctx.closePath();
        break;
    }
  }
}

// ============================================================================
// Overlay Render Function
// ============================================================================

/**
 * Render function for floating shape controls.
 * Called synchronously for each floating-control region with controlType "shape".
 */
export function renderFloatingShape(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;
  if (region.data?.controlType !== "shape") return;

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
  const shapeWidth = region.floating.width;
  const shapeHeight = region.floating.height;

  const endX = canvasX + shapeWidth;
  const endY = canvasY + shapeHeight;

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

  // Get cached shape data or trigger async fetch
  const controlId = region.id;
  let data = shapeDataCache.get(controlId);
  const isStale = staleEntries.has(controlId);

  if ((!data || isStale) && !pendingFetches.has(controlId)) {
    fetchShapeData(controlId, sheetIndex, row, col);
  }
  if (!data) {
    data = {
      shapeType: "rectangle",
      fill: "#4472C4",
      stroke: "#2F528F",
      strokeWidth: 1,
      text: "",
      textColor: "#FFFFFF",
      fontSize: 11,
      fontBold: false,
      fontItalic: false,
      textAlign: "center",
      opacity: 1,
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  }

  // Check for custom canvas renderer from shape script
  const customRenderer = customCanvasRenderers.get(controlId);
  if (customRenderer) {
    try {
      customRenderer(ctx, { x: canvasX, y: canvasY, width: shapeWidth, height: shapeHeight });
    } catch (err) {
      console.error("[ShapeRenderer] Custom renderer error:", err);
    }
    // Still draw selection indicators if in design mode
    drawSelectionIndicators(ctx, controlId, canvasX, canvasY, shapeWidth, shapeHeight, overlayCtx);
    ctx.restore();
    return;
  }

  // If shape has HTML content, render via DOM overlay instead of canvas
  const htmlContent = customHtmlContent.get(controlId);
  if (htmlContent !== undefined) {
    const canvasParent = ctx.canvas.parentElement;
    if (canvasParent) {
      updateHtmlOverlay(
        controlId,
        htmlContent,
        canvasX,
        canvasY,
        shapeWidth,
        shapeHeight,
        rowHeaderWidth,
        colHeaderHeight,
        overlayCtx.canvasWidth,
        overlayCtx.canvasHeight,
        canvasParent,
      );
    }
    // Draw a subtle border on canvas so the shape is still visible in design mode
    if (getDesignMode()) {
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(canvasX, canvasY, shapeWidth, shapeHeight);
      ctx.setLineDash([]);
    }
    drawSelectionIndicators(ctx, controlId, canvasX, canvasY, shapeWidth, shapeHeight, overlayCtx);
    ctx.restore();
    return;
  } else {
    // No HTML content — remove any leftover overlay element
    const existingOverlay = htmlOverlayElements.get(controlId);
    if (existingOverlay) {
      existingOverlay.remove();
      htmlOverlayElements.delete(controlId);
    }
  }

  const shapeDef = getShapeDefinition(data.shapeType);
  if (!shapeDef) {
    ctx.restore();
    return;
  }

  // Apply opacity
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, data.opacity));

  // Apply rotation around center
  if (data.rotation !== 0) {
    const cx = canvasX + shapeWidth / 2;
    const cy = canvasY + shapeHeight / 2;
    ctx.translate(cx, cy);
    ctx.rotate((data.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // Apply flip transforms around center
  if (data.flipH || data.flipV) {
    const cx = canvasX + shapeWidth / 2;
    const cy = canvasY + shapeHeight / 2;
    ctx.translate(cx, cy);
    ctx.scale(data.flipH ? -1 : 1, data.flipV ? -1 : 1);
    ctx.translate(-cx, -cy);
  }

  // 1. Fill path (skip for line shapes)
  if (!shapeDef.isLine) {
    buildPath(ctx, shapeDef.path, shapeWidth, shapeHeight, canvasX, canvasY);
    ctx.fillStyle = data.fill;
    ctx.fill();
  }

  // 2. Stroke path
  if (data.strokeWidth > 0) {
    buildPath(ctx, shapeDef.path, shapeWidth, shapeHeight, canvasX, canvasY);
    ctx.lineWidth = data.strokeWidth;
    ctx.strokeStyle = data.stroke;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // 3. Text (if shape supports it and text is non-empty)
  if (shapeDef.supportsText !== false && data.text) {
    const fontWeight = data.fontBold ? "bold" : "normal";
    const fontStyle = data.fontItalic ? "italic" : "normal";
    ctx.font = `${fontStyle} ${fontWeight} ${data.fontSize}px system-ui`;
    ctx.fillStyle = data.textColor;
    ctx.textAlign = data.textAlign;
    ctx.textBaseline = "middle";

    // Clip text to shape bounds with padding
    ctx.save();
    ctx.beginPath();
    ctx.rect(canvasX + 4, canvasY + 4, shapeWidth - 8, shapeHeight - 8);
    ctx.clip();

    let textX = canvasX + shapeWidth / 2;
    if (data.textAlign === "left") textX = canvasX + 6;
    else if (data.textAlign === "right") textX = canvasX + shapeWidth - 6;

    ctx.fillText(data.text, textX, canvasY + shapeHeight / 2);
    ctx.restore();
  }

  // Restore opacity
  ctx.globalAlpha = prevAlpha;

  // 4. Selection indicators (shapes are always selectable)
  const selected = isFloatingControlSelected(controlId);
  if (selected) {
    // Selection border
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, shapeWidth - 2, shapeHeight - 2);

    // Resize handles at corners and midpoints
    drawResizeHandles(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
  }

  // 5. Connection point indicators
  // Show connection points (small circles at edge midpoints) on non-connector
  // shapes when a connector/line shape is currently selected. This gives
  // visual guidance about potential attachment points.
  if (!shapeDef.isLine) {
    const shouldShowConnectionPoints = isConnectorSelectedGlobal();
    if (shouldShowConnectionPoints) {
      drawConnectionPoints(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
    }
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for floating shape overlay regions.
 * Uses pixel-based bounds for floating overlays.
 */
export function hitTestFloatingShape(hitCtx: OverlayHitTestContext): boolean {
  if (hitCtx.region.data?.controlType !== "shape") return false;

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

async function fetchShapeData(
  controlId: string,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  pendingFetches.add(controlId);
  try {
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    if (!resolved || Object.keys(resolved).length === 0) return;

    shapeDataCache.set(controlId, {
      shapeType: resolved.shapeType ?? "rectangle",
      fill: resolved.fill ?? "#4472C4",
      stroke: resolved.stroke ?? "#2F528F",
      strokeWidth: parseFloat(resolved.strokeWidth ?? "1") || 1,
      text: resolved.text ?? "",
      textColor: resolved.textColor ?? "#FFFFFF",
      fontSize: parseInt(resolved.fontSize ?? "11", 10) || 11,
      fontBold: resolved.fontBold === "true",
      fontItalic: resolved.fontItalic === "true",
      textAlign: (resolved.textAlign as CanvasTextAlign) ?? "center",
      opacity: parseFloat(resolved.opacity ?? "1") || 1,
      rotation: parseFloat(resolved.rotation ?? "0") || 0,
      flipH: resolved.flipH === "true",
      flipV: resolved.flipV === "true",
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
    console.error(`[Controls] Failed to fetch shape data for ${controlId}:`, err);
  } finally {
    pendingFetches.delete(controlId);
  }
}

// ============================================================================
// Drawing Helpers
// ============================================================================

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

// ============================================================================
// Connection Point Indicators
// ============================================================================

/**
 * Check if any currently selected floating control is a connector/line shape.
 * Used to decide whether to show connection point indicators on other shapes.
 */
function isConnectorSelectedGlobal(): boolean {
  const selectedIds = getSelectedFloatingControls();
  for (const id of selectedIds) {
    const cached = shapeDataCache.get(id);
    if (cached && isConnectorShape(cached.shapeType)) {
      return true;
    }
  }
  return false;
}

/**
 * Draw connection point indicators at the four edge midpoints of a shape.
 * Each indicator is a small circle with a green fill and dark border,
 * providing visual guidance for where connectors can attach.
 */
function drawConnectionPoints(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const radius = 4;
  const points = [
    { cx: x + w / 2, cy: y },           // top center
    { cx: x + w,     cy: y + h / 2 },   // right center
    { cx: x + w / 2, cy: y + h },       // bottom center
    { cx: x,         cy: y + h / 2 },   // left center
  ];

  for (const pt of points) {
    // Outer circle (border)
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Inner filled circle
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, radius - 1, 0, Math.PI * 2);
    ctx.fillStyle = "#4CAF50";
    ctx.fill();
  }
}
