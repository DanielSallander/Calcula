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
import { emitAppEvent } from "@api/events";
import { getDesignMode } from "../lib/designMode";
import { resolveControlProperties } from "../lib/controlApi";
import { isFloatingControlSelected, getSelectedFloatingControls } from "../Button/floatingSelection";
import { getShapeDefinition, isConnectorShape, type ShapePathCommand } from "./shapeCatalog";

// ============================================================================
// Global postMessage listener (receives messages from shape iframes)
// ============================================================================

window.addEventListener("message", (e) => {
  if (e.data?.source === "shape-html") {
    const { instanceId, type, data } = e.data;
    emitAppEvent("shape:htmlMessage", { instanceId, type, data });
  }
});

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

/** Map of controlId -> iframe overlay element for interactive HTML shapes. */
const htmlOverlayElements = new Map<string, HTMLIFrameElement>();

/** Track content hash per controlId to avoid unnecessary iframe reloads. */
const overlayContentHash = new Map<string, string>();

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
  // Mark hash as stale so the iframe reloads on next render
  overlayContentHash.delete(instanceId);
}

/** Get HTML content for a shape. */
export function getShapeHtmlContent(instanceId: string): string | undefined {
  return customHtmlContent.get(instanceId);
}

/** Check if a shape has custom HTML content. */
export function hasShapeHtmlContent(instanceId: string): boolean {
  return customHtmlContent.has(instanceId);
}

/** Get the iframe overlay element for a shape (for sending messages). */
export function getShapeOverlayFrame(instanceId: string): HTMLIFrameElement | null {
  return htmlOverlayElements.get(instanceId) ?? null;
}

/** Remove the HTML overlay iframe element for a shape (cleanup on deletion). */
export function removeShapeHtmlOverlay(instanceId: string): void {
  const el = htmlOverlayElements.get(instanceId);
  if (el) {
    el.remove();
    htmlOverlayElements.delete(instanceId);
  }
  customHtmlContent.delete(instanceId);
  overlayContentHash.delete(instanceId);
}

/**
 * Build the full srcdoc HTML for the iframe, injecting the postMessage bridge.
 */
function buildIframeSrcDoc(controlId: string, userHtml: string): string {
  const escapedId = controlId.replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif; font-size: 12px; overflow: hidden; }
  * { box-sizing: border-box; }
</style>
<script>
  var SHAPE_ID = '${escapedId}';
  window.calcula = {
    sendMessage: function(type, data) {
      parent.postMessage({ source: 'shape-html', instanceId: SHAPE_ID, type: type, data: data }, '*');
    }
  };
  window.addEventListener('message', function(e) {
    if (e.data && e.data.target === 'shape-html' && e.data.instanceId === SHAPE_ID) {
      window.dispatchEvent(new CustomEvent('shape-message', { detail: e.data }));
    }
  });
</script>
</head><body>${userHtml}</body></html>`;
}

/**
 * Create or update the positioned iframe overlay element for a shape.
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

  // Create iframe if it doesn't exist
  if (!el) {
    el = document.createElement("iframe");
    el.dataset.shapeOverlay = controlId;
    el.sandbox.add("allow-scripts", "allow-same-origin");
    el.style.position = "absolute";
    el.style.overflow = "hidden";
    el.style.boxSizing = "border-box";
    el.style.border = "1px solid #d0d0d0";
    el.style.borderRadius = "4px";
    el.style.background = "#ffffff";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)";
    el.style.pointerEvents = "none";  // Always none; interactive only via design mode toggle
    el.style.zIndex = "5";
    el.srcdoc = buildIframeSrcDoc(controlId, html);
    overlayContentHash.set(controlId, html);
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

  // Update content only if changed (avoid iframe reload on every render)
  const prevHash = overlayContentHash.get(controlId);
  if (prevHash !== html) {
    el.srcdoc = buildIframeSrcDoc(controlId, html);
    overlayContentHash.set(controlId, html);
  }
}

// ============================================================================
// Script Status Tracking
// ============================================================================

/** Set of controlIds that have a script attached. */
const shapesWithScripts = new Set<string>();

/** Mark a shape as having a script attached. */
export function markShapeHasScript(instanceId: string): void {
  shapesWithScripts.add(instanceId);
}

/** Mark a shape as no longer having a script. */
export function unmarkShapeHasScript(instanceId: string): void {
  shapesWithScripts.delete(instanceId);
}

/** Check if a shape has a script attached. */
export function shapeHasScript(instanceId: string): boolean {
  return shapesWithScripts.has(instanceId);
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

  // If shape has HTML content, render via DOM overlay (run mode) or canvas preview (design mode)
  const htmlContent = customHtmlContent.get(controlId);
  if (htmlContent !== undefined) {
    const canvasParent = ctx.canvas.parentElement;

    // Always show the iframe overlay (pointer-events: none allows click-through)
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

    // Draw selection indicators on top of the iframe when selected
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

  // 6. Script badge indicator (design mode only)
  if (getDesignMode() && shapesWithScripts.has(controlId)) {
    drawScriptBadge(ctx, canvasX, canvasY, shapeWidth);
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

/**
 * Draw a small script badge icon in the top-right corner of a shape.
 * Shows a code bracket icon on a rounded pill to indicate a script is attached.
 */
function drawScriptBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
): void {
  const badgeSize = 16;
  const badgeX = x + w - badgeSize - 3;
  const badgeY = y + 3;
  const radius = 4;

  // Badge background (rounded rect)
  ctx.beginPath();
  ctx.moveTo(badgeX + radius, badgeY);
  ctx.lineTo(badgeX + badgeSize - radius, badgeY);
  ctx.arcTo(badgeX + badgeSize, badgeY, badgeX + badgeSize, badgeY + radius, radius);
  ctx.lineTo(badgeX + badgeSize, badgeY + badgeSize - radius);
  ctx.arcTo(badgeX + badgeSize, badgeY + badgeSize, badgeX + badgeSize - radius, badgeY + badgeSize, radius);
  ctx.lineTo(badgeX + radius, badgeY + badgeSize);
  ctx.arcTo(badgeX, badgeY + badgeSize, badgeX, badgeY + badgeSize - radius, radius);
  ctx.lineTo(badgeX, badgeY + radius);
  ctx.arcTo(badgeX, badgeY, badgeX + radius, badgeY, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 120, 212, 0.85)";
  ctx.fill();

  // Code brackets icon: < >
  const cx = badgeX + badgeSize / 2;
  const cy = badgeY + badgeSize / 2;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Left bracket <
  ctx.beginPath();
  ctx.moveTo(cx - 2, cy - 3);
  ctx.lineTo(cx - 5, cy);
  ctx.lineTo(cx - 2, cy + 3);
  ctx.stroke();

  // Right bracket >
  ctx.beginPath();
  ctx.moveTo(cx + 2, cy - 3);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx + 2, cy + 3);
  ctx.stroke();
}
