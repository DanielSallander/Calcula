//! FILENAME: app/extensions/Controls/Button/floatingRenderer.ts
// PURPOSE: Grid overlay render and hit-test functions for floating button controls.
// CONTEXT: Registered with registerGridOverlay(). Called synchronously every frame
//          by the core canvas renderer. Follows the Charts extension pattern.

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
import { beginControlGeometryRead, controlGeometryWritesInFlight } from "../lib/geometryWriteOrder";
import { isFloatingControlSelected } from "./floatingSelection";
import { isFloatingButtonPressed } from "../lib/buttonPress";

/** How dark a PRESSED run-mode button's face goes (a black wash, 0..1). */
export const BUTTON_PRESSED_SHADE = 0.12;

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedButtonData {
  text: string;
  fill: string;
  color: string;
  borderColor: string;
  fontSize: number;
}

const buttonDataCache = new Map<string, CachedButtonData>();
const pendingFetches = new Set<string>();

/**
 * Set of control IDs whose cached data is stale.
 * Stale entries are kept visible during rendering while a re-fetch is
 * in progress, preventing a visible "blink" to default values.
 */
const staleEntries = new Set<string>();

/** Invalidate cached data for a specific control. */
export function invalidateFloatingButtonCache(controlId: string): void {
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
}

/** Invalidate all cached button data. */
export function invalidateAllFloatingButtonCaches(): void {
  // Mark all as stale but keep old data visible until re-fetched
  for (const key of buttonDataCache.keys()) {
    staleEntries.add(key);
  }
  pendingFetches.clear();
}

// ============================================================================
// Viewport Cache (for coordinate conversion outside render loop)
// ============================================================================

let cachedScrollX = 0;
let cachedScrollY = 0;
let cachedRowHeaderWidth = 50;
let cachedColHeaderHeight = 24;

export function getCachedViewportParams(): {
  scrollX: number;
  scrollY: number;
  rowHeaderWidth: number;
  colHeaderHeight: number;
} {
  return {
    scrollX: cachedScrollX,
    scrollY: cachedScrollY,
    rowHeaderWidth: cachedRowHeaderWidth,
    colHeaderHeight: cachedColHeaderHeight,
  };
}

// ============================================================================
// Overlay Render Function
// ============================================================================

/**
 * Render function registered with registerGridOverlay().
 * Called synchronously for each floating-control region visible in the viewport.
 */
export function renderFloatingButton(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;

  const sheetIndex = region.data?.sheetIndex as number;
  const row = region.data?.row as number;
  const col = region.data?.col as number;
  if (sheetIndex == null || row == null || col == null) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Cache viewport params for external use
  cachedScrollX = overlayCtx.viewport.scrollX;
  cachedScrollY = overlayCtx.viewport.scrollY;
  cachedRowHeaderWidth = rowHeaderWidth;
  cachedColHeaderHeight = colHeaderHeight;

  // Convert sheet pixel position to canvas pixel position
  const { canvasX, canvasY } = overlaySheetToCanvas(
    overlayCtx,
    region.floating.x,
    region.floating.y,
  );
  const btnWidth = region.floating.width;
  const btnHeight = region.floating.height;

  const endX = canvasX + btnWidth;
  const endY = canvasY + btnHeight;

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

  // Get cached button data or trigger async fetch.
  // Stale entries are re-fetched but the old data stays visible to avoid blink.
  const controlId = region.id;
  let data = buttonDataCache.get(controlId);
  const isStale = staleEntries.has(controlId);

  if ((!data || isStale) && !pendingFetches.has(controlId)) {
    fetchButtonData(controlId, sheetIndex, row, col);
  }
  if (!data) {
    // Truly new control with no cache at all — use hard-coded defaults
    data = { text: "Button", fill: "#e0e0e0", color: "#000000", borderColor: "#999999", fontSize: 11 };
  }

  const isDesignMode = getDesignMode();
  const borderRadius = 3;
  // A run-mode press held INSIDE the button (lib/buttonPress.ts, BUG-0258
  // phase 4c): it looks pushed in -- no raised highlight, a darker face, the
  // caption one pixel down and right -- until the release runs it or the
  // pointer slides off.
  const pressed = isFloatingButtonPressed(controlId);

  // 1. Draw button background
  ctx.beginPath();
  ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight, borderRadius);
  ctx.fillStyle = data.fill;
  ctx.fill();

  if (pressed) {
    // 2'. Pressed: a 12% black wash over the face instead of the highlight.
    ctx.beginPath();
    ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight, borderRadius);
    ctx.fillStyle = "#000000";
    ctx.globalAlpha = BUTTON_PRESSED_SHADE;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  } else {
    // 2. Top highlight for 3D effect
    ctx.beginPath();
    ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight / 2, [borderRadius, borderRadius, 0, 0]);
    ctx.fillStyle = "#f0f0f0";
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // 3. Border
  ctx.beginPath();
  ctx.roundRect(canvasX + 0.5, canvasY + 0.5, btnWidth - 1, btnHeight - 1, borderRadius);
  ctx.lineWidth = 1;
  ctx.strokeStyle = data.borderColor;
  ctx.stroke();

  // 4. Button text
  ctx.font = `${data.fontSize}px system-ui`;
  ctx.fillStyle = data.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textOffset = pressed ? 1 : 0;
  const centerX = canvasX + btnWidth / 2 + textOffset;
  const centerY = canvasY + btnHeight / 2 + textOffset;

  // Clip text to button bounds
  ctx.save();
  ctx.beginPath();
  ctx.rect(canvasX + 4, canvasY, btnWidth - 8, btnHeight);
  ctx.clip();
  ctx.fillText(data.text, centerX, centerY);
  ctx.restore();

  // 5. Design Mode: an UNSELECTED button shows a dotted border (it can be
  //    selected and moved now). A SELECTED button's outline and resize handles
  //    are Core's (core/lib/gridRenderer/rendering/floatingObjectChrome.ts,
  //    BUG-0258 design phase 3).
  if (isDesignMode && !isFloatingControlSelected(controlId)) {
    ctx.beginPath();
    ctx.roundRect(canvasX - 1, canvasY - 1, btnWidth + 2, btnHeight + 2, borderRadius + 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#0078d4";
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for floating button overlay regions.
 * Uses pixel-based bounds for floating overlays.
 */
export function hitTestFloatingButton(hitCtx: OverlayHitTestContext): boolean {
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

async function fetchButtonData(
  controlId: string,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  pendingFetches.add(controlId);
  try {
    // Never read under a geometry write in flight, and remember what the
    // geometry was when the read started (lib/geometryWriteOrder.ts, BUG-0268).
    const anchor = { sheetIndex, row, col };
    const writes = controlGeometryWritesInFlight(anchor);
    if (writes) await writes;
    const readIsCurrent = beginControlGeometryRead(anchor);
    // Use resolveControlProperties to evaluate formula-type properties
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    if (!resolved || Object.keys(resolved).length === 0) return;

    buttonDataCache.set(controlId, {
      text: resolved.text ?? "Button",
      fill: resolved.fill ?? "#e0e0e0",
      color: resolved.color ?? "#000000",
      borderColor: resolved.borderColor ?? "#999999",
      fontSize: parseInt(resolved.fontSize ?? "11", 10) || 11,
    });
    staleEntries.delete(controlId);

    // The resolved width/height (a formula-driven size) goes back into the
    // store -- unless the geometry changed while this read was on its way: then
    // it describes the OLD rectangle (BUG-0268) and the size is read again at
    // the next paint, after the write has landed.
    if (resolved.width || resolved.height) {
      const { applyResolvedControlSize } = await import("../lib/floatingStore");
      if (applyResolvedControlSize(controlId, resolved, readIsCurrent) === "superseded") {
        staleEntries.add(controlId);
      }
    }

    // Request redraw to show fetched data
    const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
    requestOverlayRedraw();
  } catch (err) {
    console.error(`[Controls] Failed to fetch button data for ${controlId}:`, err);
  } finally {
    pendingFetches.delete(controlId);
  }
}
