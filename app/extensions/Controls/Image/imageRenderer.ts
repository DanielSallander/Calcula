//! FILENAME: app/extensions/Controls/Image/imageRenderer.ts
// PURPOSE: Grid overlay render and hit-test functions for floating image controls.
// CONTEXT: Registered with registerGridOverlay() via dispatcher in index.ts.
//          Follows the exact same async-cache pattern as Shape/shapeRenderer.ts.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
} from "@api/gridOverlays";
import { resolveControlProperties } from "../lib/controlApi";
import { isFloatingControlSelected } from "../Button/floatingSelection";
import { dataUrlToBlob, mediaHashOf } from "./mediaRefs";

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedImageData {
  /** The stored property value: a `media:{sha256}` handle, or — for the legacy
   *  corpus this build refuses to re-admit — an inline `data:` URL. */
  src: string;
  opacity: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

const imageDataCache = new Map<string, CachedImageData>();
const pendingFetches = new Set<string>();
const staleEntries = new Set<string>();

/** Decoded HTMLImageElement objects, keyed by the URL actually painted (an
 *  object URL for media handles; the raw string for legacy inline payloads). */
const imageElementCache = new Map<string, HTMLImageElement>();

// ---------------------------------------------------------------------------
// Media handle -> ONE blob -> ONE object URL, keyed by CONTENT HASH
// ---------------------------------------------------------------------------
//
// The property no longer holds pixels, it holds a ~70-byte handle, so the cache
// key is now a hash instead of a multi-megabyte base64 string. Two consequences
// worth naming, because both were bugs in the shape this replaces:
//
//   * Ten controls showing the same logo make ONE `resolve_media_ref` call and
//     share ONE decoded bitmap — content addressing gives that for free, where
//     string-keyed caching of per-control data URLs only got it by accident.
//   * `invalidateAllImageCaches()` (theme changes, structural edits, ...) marks
//     the METADATA stale and nothing else. It deliberately does not revoke
//     object URLs: bytes are immutable under their hash, so re-resolving them
//     would be pure cost. Before this, one theme change re-pulled every image's
//     entire base64 across IPC.

/** media hash -> object URL for the blob holding that picture. */
const mediaObjectUrls = new Map<string, string>();
/** In-flight resolutions, so N controls sharing a picture make one IPC call. */
const mediaResolutions = new Map<string, Promise<string | null>>();
/** Hashes the host could not resolve, with the reason, so the paint can say so
 *  once instead of retrying every frame. */
const mediaFailures = new Map<string, string>();

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

/**
 * Forget a control that no longer exists, and release any picture that was only
 * being held for it.
 *
 * Distinct from `invalidateImageCache`, which means "re-read this control" and
 * must keep the old data to paint with until the re-read lands. This one means
 * "this control is gone" — the deletion path calls it, and it is what stops an
 * object URL outliving the last thing that referenced it.
 */
export function forgetImageControl(controlId: string): void {
  imageDataCache.delete(controlId);
  staleEntries.delete(controlId);
  pendingFetches.delete(controlId);
  releaseUnreferencedMedia();
}

/** Revoke every object URL and drop every cache. For extension teardown. */
export function releaseAllImageMedia(): void {
  for (const url of mediaObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  mediaObjectUrls.clear();
  mediaResolutions.clear();
  mediaFailures.clear();
  imageElementCache.clear();
  imageDataCache.clear();
  staleEntries.clear();
  pendingFetches.clear();
}

/** Revoke object URLs no cached control points at any more. */
function releaseUnreferencedMedia(): void {
  const live = new Set<string>();
  for (const data of imageDataCache.values()) {
    const hash = mediaHashOf(data.src);
    if (hash) live.add(hash);
  }
  for (const [hash, url] of mediaObjectUrls) {
    if (live.has(hash)) continue;
    // A resolution in flight has no cache entry yet; revoking here would hand
    // the paint a dead URL a moment later.
    if (mediaResolutions.has(hash)) continue;
    URL.revokeObjectURL(url);
    mediaObjectUrls.delete(hash);
    imageElementCache.delete(url);
  }
  for (const hash of mediaFailures.keys()) {
    if (!live.has(hash)) mediaFailures.delete(hash);
  }
}

/**
 * Ask the host for a handle's bytes, wrap them in one Blob, and keep the object
 * URL under the content hash. Idempotent and single-flight; resolves to the
 * object URL, or null when this document cannot produce those bytes.
 */
function resolveMediaHash(hash: string): Promise<string | null> {
  const cached = mediaObjectUrls.get(hash);
  if (cached) return Promise.resolve(cached);
  if (mediaFailures.has(hash)) return Promise.resolve(null);
  const inFlight = mediaResolutions.get(hash);
  if (inFlight) return inFlight;
  const work = (async (): Promise<string | null> => {
    try {
      const { resolveMediaRef } = await import("@api/filesystem");
      const dataUrl = await resolveMediaRef(`media:${hash}`);
      const blob = dataUrlToBlob(dataUrl);
      if (!blob) {
        mediaFailures.set(hash, "the host returned something that was not an image");
        return null;
      }
      const url = URL.createObjectURL(blob);
      mediaObjectUrls.set(hash, url);
      return url;
    } catch (err) {
      mediaFailures.set(hash, err instanceof Error ? err.message : String(err));
      console.warn(`[Controls] media ${hash} could not be resolved:`, err);
      return null;
    } finally {
      mediaResolutions.delete(hash);
      const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
      requestOverlayRedraw();
    }
  })();
  mediaResolutions.set(hash, work);
  return work;
}

/**
 * Whether this document can actually produce the bytes behind a handle, and how
 * big the picture is.
 *
 * For the PLACEMENT path (`@api/pictureControlService`): a picture created for a
 * handle the document does not hold would be a control that can never paint, so
 * the placement asks first and refuses rather than creating one. Resolution goes
 * through the same single-flight cache the paint uses, so asking costs the pull
 * that was about to happen anyway — not a second one.
 *
 * Returns null when the handle does not resolve. Returns zeroes when the bytes
 * resolved but the WebView could not decode them (the host proved the header, so
 * the caller may still place the picture at a default size — it exists, and the
 * grid will paint it or say "Image Unavailable" honestly).
 */
export async function getMediaNaturalSize(
  ref: string,
): Promise<{ width: number; height: number } | null> {
  const hash = mediaHashOf(ref);
  if (!hash) return null;
  const url = await resolveMediaHash(hash);
  if (!url) return null;

  const cached = imageElementCache.get(url);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return { width: cached.naturalWidth, height: cached.naturalHeight };
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Keep the decode: the paint that follows this placement reuses it.
      imageElementCache.set(url, img);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

/**
 * The URL to actually paint for a stored `src`, or null when there isn't one yet.
 *
 * A media handle resolves through the blob cache (kicking off a resolution the
 * first time). Anything else — i.e. a legacy inline `data:` payload — is painted
 * as-is, which is the whole reason `img-src ... data:` stays in the CSP.
 */
function paintableUrl(src: string): { url: string | null; failed: boolean } {
  const hash = mediaHashOf(src);
  if (!hash) return { url: src, failed: false };
  const url = mediaObjectUrls.get(hash);
  if (url) return { url, failed: false };
  if (mediaFailures.has(hash)) return { url: null, failed: true };
  void resolveMediaHash(hash);
  return { url: null, failed: false };
}

// ============================================================================
// HTMLImageElement Loader
// ============================================================================

/**
 * Get or create an HTMLImageElement for an already-paintable URL.
 * Returns null if the image isn't decoded yet (triggers async decode).
 */
function getImageElement(controlId: string, url: string): HTMLImageElement | null {
  const existing = imageElementCache.get(url);
  if (existing) {
    return existing.complete && existing.naturalWidth > 0 ? existing : null;
  }

  const img = new Image();
  img.onload = async () => {
    const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
    requestOverlayRedraw();
  };
  img.onerror = () => {
    console.warn(`[Controls] Failed to load image for ${controlId}`);
  };
  img.src = url;
  imageElementCache.set(url, img);

  return null; // not yet decoded
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
      flipH: false,
      flipV: false,
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

  // Apply flip transforms around center
  if (data.flipH || data.flipV) {
    const cx = canvasX + imgWidth / 2;
    const cy = canvasY + imgHeight / 2;
    ctx.translate(cx, cy);
    ctx.scale(data.flipH ? -1 : 1, data.flipV ? -1 : 1);
    ctx.translate(-cx, -cy);
  }

  // Draw the image
  if (data.src) {
    const { url, failed } = paintableUrl(data.src);
    const imgEl = url ? getImageElement(controlId, url) : null;
    if (imgEl) {
      ctx.drawImage(imgEl, canvasX, canvasY, imgWidth, imgHeight);
    } else {
      // "Image Unavailable" is not the same statement as "Loading...": the
      // first means this document points at media it does not carry, which the
      // user needs to see rather than watch a spinner forever.
      drawPlaceholder(
        ctx,
        canvasX,
        canvasY,
        imgWidth,
        imgHeight,
        failed ? "Image Unavailable" : "Loading...",
      );
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
      flipH: resolved.flipH === "true",
      flipV: resolved.flipV === "true",
    });
    staleEntries.delete(controlId);
    // The src may have moved to a different picture (property edit, undo, a
    // package refresh). Whatever the old one was, nothing points at it now.
    releaseUnreferencedMedia();

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
