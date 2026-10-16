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
import { getFloatingControl } from "../lib/floatingStore";
import { getGridStateSnapshot } from "@api/grid";
import { getReportPagesSnapshot, sheetIdAt } from "@api/reportPages";
import { actionGlyphMetrics, actionGlyphOf, drawActionGlyph, isCurrentPageButton } from "./actionGlyph";
import {
  invalidateAllPageNavigatorCaches,
  invalidatePageNavigatorCache,
} from "../PageNavigator/navigatorCache";
import { getControlPaintPreview, noteControlProperties } from "../lib/controlContainer";
import { BUTTON_PAINT_DEFAULTS } from "../lib/controlContainerDefaults";
import { BACKGROUND_TRANSPARENCY_KEY, backgroundAlphaOf, isNoPaint, parseStrokeWidth } from "../Shape/shapeRecipe";
import { visualContentRectFor, type ContainerRegion } from "@api/visualContainerPaint";

/** How dark a PRESSED run-mode button's face goes (a black wash, 0..1). */
export const BUTTON_PRESSED_SHADE = 0.12;

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedButtonData {
  text: string;
  fill: string;
  /** The face's alpha: Effects > Background > Transparency (1 = opaque). */
  fillAlpha: number;
  color: string;
  borderColor: string;
  /** The face's outline width; 0 = no outline (WP-C: the container's border width). */
  strokeWidth: number;
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

/**
 * Invalidate cached data for a specific control. THE one invalidation entry
 * point for every floating control painted from resolved properties: a Page
 * Navigator's settings (PageNavigator/navigatorCache.ts) go stale here too, so
 * every existing call site covers the navigator with no new one.
 */
export function invalidateFloatingButtonCache(controlId: string): void {
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
  invalidatePageNavigatorCache(controlId);
}

/** Invalidate all cached button data. */
export function invalidateAllFloatingButtonCaches(): void {
  // Mark all as stale but keep old data visible until re-fetched
  for (const key of buttonDataCache.keys()) {
    staleEntries.add(key);
  }
  pendingFetches.clear();
  invalidateAllPageNavigatorCaches();
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
    fetchButtonData(controlId, sheetIndex, row, col, String(region.data?.controlType ?? "button"));
  }
  if (!data) {
    // Truly new control with no cache at all — use hard-coded defaults
    data = {
      text: "Button",
      fill: BUTTON_PAINT_DEFAULTS.fill,
      fillAlpha: 1,
      color: "#000000",
      borderColor: BUTTON_PAINT_DEFAULTS.borderColor,
      strokeWidth: BUTTON_PAINT_DEFAULTS.strokeWidth,
      fontSize: 11,
    };
  }

  const isDesignMode = getDesignMode();
  // WP-C D-FORMAT: the button's face IS its container's background and border
  // (`paint` "family": painted here, over the region's box, with the
  // container's corner radius), and its caption lays out in the CONTENT RECT
  // -- the box less the border band Core answers as frame.
  const container = (region as ContainerRegion).container;
  const borderRadius = container ? container.border.radius : BUTTON_PAINT_DEFAULTS.radius;
  const content = visualContentRectFor(
    region.id,
    { x: canvasX, y: canvasY, width: btnWidth, height: btnHeight },
    container,
  );
  // The Format pane's PREVIEW of the face (lib/controlContainer.ts), in memory only.
  const paintPreview = getControlPaintPreview(controlId);
  const fill = paintPreview?.fill ?? data.fill;
  const fillAlpha =
    paintPreview?.[BACKGROUND_TRANSPARENCY_KEY] !== undefined
      ? backgroundAlphaOf(paintPreview[BACKGROUND_TRANSPARENCY_KEY])
      : data.fillAlpha;
  const borderColor = paintPreview?.borderColor ?? data.borderColor;
  const strokeWidth =
    paintPreview?.strokeWidth !== undefined ? parseStrokeWidth(paintPreview.strokeWidth) : data.strokeWidth;
  const filled = !isNoPaint(fill) && fillAlpha > 0;
  // A run-mode press held INSIDE the button (lib/buttonPress.ts, BUG-0258
  // phase 4c): it looks pushed in -- no raised highlight, a darker face, the
  // caption one pixel down and right -- until the release runs it or the
  // pointer slides off.
  const pressed = isFloatingButtonPressed(controlId);
  // A button's DECLARATIVE action (Canvas contract §4.4, Button/actionGlyph.ts):
  // a navigation button to the page on screen is drawn SELECTED -- the pressed
  // face, held -- as a Power BI page navigator marks the current page; Back
  // and Clear all slicers draw their picture before the caption.
  const buttonAction = getFloatingControl(controlId)?.buttonAction;
  // The active sheet BY ID (the grid's index -> the page list's id; any kind
  // of sheet), so a page renamed while on screen keeps its button's wash.
  const sheetContext = getGridStateSnapshot()?.sheetContext;
  const currentPage =
    !pressed &&
    isCurrentPageButton(buttonAction, {
      sheetId: sheetIdAt(getReportPagesSnapshot(), sheetContext?.activeSheetIndex),
      sheetName: sheetContext?.activeSheetName,
    });
  const glyph = actionGlyphOf(buttonAction);

  // 1. Draw button background ("none" = no face), faded by the background's
  //    transparency (the border and the caption are not).
  if (filled) {
    ctx.beginPath();
    ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight, borderRadius);
    ctx.fillStyle = fill;
    ctx.globalAlpha = fillAlpha;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  if (pressed || currentPage) {
    // 2'. Pressed (or the current page's navigator button): a 12% black wash
    //     over the face instead of the highlight.
    ctx.beginPath();
    ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight, borderRadius);
    ctx.fillStyle = "#000000";
    ctx.globalAlpha = BUTTON_PRESSED_SHADE;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  } else if (filled) {
    // 2. Top highlight for 3D effect
    ctx.beginPath();
    ctx.roundRect(canvasX, canvasY, btnWidth, btnHeight / 2, [borderRadius, borderRadius, 0, 0]);
    ctx.fillStyle = "#f0f0f0";
    ctx.globalAlpha = 0.4 * fillAlpha;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // 3. Border: `strokeWidth` wide, inside the box ("0" or a "none" colour = none).
  if (strokeWidth > 0 && !isNoPaint(borderColor)) {
    const half = strokeWidth / 2;
    ctx.beginPath();
    ctx.roundRect(
      canvasX + half,
      canvasY + half,
      Math.max(0, btnWidth - strokeWidth),
      Math.max(0, btnHeight - strokeWidth),
      borderRadius,
    );
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = borderColor;
    ctx.stroke();
  }

  // 4. Button text, centred in the content rect
  ctx.font = `${data.fontSize}px system-ui`;
  ctx.fillStyle = data.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textOffset = pressed ? 1 : 0;
  const centerX = content.x + content.width / 2 + textOffset;
  const centerY = content.y + content.height / 2 + textOffset;

  // Clip text to the content rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(content.x + 4, content.y, Math.max(0, content.width - 8), content.height);
  ctx.clip();
  if (glyph) {
    // The glyph and the caption are centred TOGETHER, glyph first.
    const { size, gap } = actionGlyphMetrics(data.fontSize);
    const textWidth = data.text ? ctx.measureText(data.text).width : 0;
    const total = size + (textWidth > 0 ? gap + textWidth : 0);
    const left = centerX - total / 2;
    drawActionGlyph(ctx, glyph, left, centerY - size / 2, size, data.color);
    if (textWidth > 0) {
      ctx.textAlign = "left";
      ctx.fillText(data.text, left + size + gap, centerY);
    }
  } else {
    ctx.fillText(data.text, centerX, centerY);
  }
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
  controlType: string,
): Promise<void> {
  pendingFetches.add(controlId);
  try {
    // Never read under a geometry write in flight, and remember what the
    // geometry was when the read started (lib/geometryWriteOrder.ts, BUG-0268).
    const anchor = { sheetIndex, row, col };
    const writes = controlGeometryWritesInFlight(anchor);
    if (writes) await writes;
    const readIsCurrent = beginControlGeometryRead(anchor);
    // The literals with every bound property overlaid (Rust, D-BIND).
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    if (!resolved || Object.keys(resolved).length === 0) return;

    buttonDataCache.set(controlId, {
      text: resolved.text ?? "Button",
      fill: resolved.fill ?? BUTTON_PAINT_DEFAULTS.fill,
      fillAlpha: backgroundAlphaOf(resolved[BACKGROUND_TRANSPARENCY_KEY]),
      color: resolved.color ?? "#000000",
      borderColor: resolved.borderColor ?? BUTTON_PAINT_DEFAULTS.borderColor,
      strokeWidth: parseStrokeWidth(resolved.strokeWidth, BUTTON_PAINT_DEFAULTS.strokeWidth),
      fontSize: parseInt(resolved.fontSize ?? "11", 10) || 11,
    });
    staleEntries.delete(controlId);
    // The same read is the button's visual container (WP-C D-FORMAT).
    noteControlProperties(controlId, controlType, resolved);

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
