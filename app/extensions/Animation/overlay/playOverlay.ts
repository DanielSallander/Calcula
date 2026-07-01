//! FILENAME: app/extensions/Animation/overlay/playOverlay.ts
// PURPOSE: An Animation-owned on-canvas play control — a floating pill (play/pause
//          glyph + progress + frame count) drawn on the grid via the generic grid-
//          overlay API. Clicking it toggles playback. Shown only while a driver is
//          loaded. NOT a Charts widget — Animation fully owns this overlay.
// MODEL: a floating region (data.movable=false so Core never starts a move) whose
//   click fires the Core "floatingObject:selected" event we listen for. Anchored at
//   a fixed sheet position near the origin (scrolls with content — viewport-pinning
//   is a future enhancement).
import {
  registerGridOverlay,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
  type GridRegion,
} from "@api/gridOverlays";
import { playbackEngine, type EngineState } from "../lib/animationEngine";

const TYPE = "animation-play";
const W = 172;
const H = 26;
const MARGIN = 8;

/** Pure hit predicate: is (x, y) within the pill's canvas bounds? */
export function hitPill(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  canvasX: number,
  canvasY: number,
): boolean {
  if (!bounds) return false;
  return (
    canvasX >= bounds.x &&
    canvasX <= bounds.x + bounds.width &&
    canvasY >= bounds.y &&
    canvasY <= bounds.y + bounds.height
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawPill(rc: OverlayRenderContext): void {
  const f = rc.region.floating;
  if (!f) return;
  const s = playbackEngine.getState();
  const { canvasX, canvasY } = overlaySheetToCanvas(rc, f.x, f.y);
  const ctx = rc.ctx;

  ctx.save();

  // Background pill.
  roundRect(ctx, canvasX, canvasY, W, H, 6);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#d0d0d0";
  ctx.stroke();

  // Play / pause glyph.
  const gx = canvasX + 13;
  const gy = canvasY + H / 2;
  ctx.fillStyle = "#217346";
  if (s.status === "playing") {
    ctx.fillRect(gx - 4, gy - 5, 3, 10);
    ctx.fillRect(gx + 1, gy - 5, 3, 10);
  } else {
    ctx.beginPath();
    ctx.moveTo(gx - 4, gy - 5);
    ctx.lineTo(gx - 4, gy + 5);
    ctx.lineTo(gx + 5, gy);
    ctx.closePath();
    ctx.fill();
  }

  // Progress track + fill.
  const px = canvasX + 30;
  const pw = W - 30 - 46;
  const py = canvasY + H / 2 - 2;
  ctx.fillStyle = "#e6e6e6";
  roundRect(ctx, px, py, pw, 4, 2);
  ctx.fill();
  const span = Math.max(1, s.rangeEnd - s.rangeStart);
  const prog = Math.max(0, Math.min(1, (s.frame - s.rangeStart) / span));
  if (prog > 0) {
    ctx.fillStyle = "#217346";
    roundRect(ctx, px, py, pw * prog, 4, 2);
    ctx.fill();
  }

  // Frame counter.
  ctx.fillStyle = "#555";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${s.frame + 1}/${s.frameCount}`, canvasX + W - 8, canvasY + H / 2);

  ctx.restore();
}

/**
 * Install the on-canvas play control. Returns a cleanup function that removes the
 * overlay, its region, the engine subscription, and the click listener.
 */
export function installPlayOverlay(): () => void {
  const region: GridRegion = {
    id: TYPE,
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: MARGIN, y: MARGIN, width: W, height: H },
    data: { movable: false },
  };

  const unregister = registerGridOverlay({
    type: TYPE,
    render: (rc: OverlayRenderContext) => drawPill(rc),
    hitTest: (hc: OverlayHitTestContext) => hitPill(hc.floatingCanvasBounds, hc.canvasX, hc.canvasY),
    priority: 40, // above charts (15) so the pill is on top
  });

  // Show the region only while a driver is loaded; repaint on every state change.
  let present = false;
  const sync = (s: EngineState): void => {
    const show = s.frameCount > 0;
    if (show && !present) {
      addGridRegions([region]);
      present = true;
    } else if (!show && present) {
      removeGridRegionsByType(TYPE);
      present = false;
    } else if (show) {
      requestOverlayRedraw();
    }
  };
  const unsubscribe = playbackEngine.subscribe(sync);

  // Clicking the pill toggles playback.
  const onSelected = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { regionType?: string } | undefined;
    if (detail?.regionType !== TYPE) return;
    const s = playbackEngine.getState();
    if (s.status === "playing") playbackEngine.pause();
    else playbackEngine.play();
  };
  window.addEventListener("floatingObject:selected", onSelected);

  return () => {
    window.removeEventListener("floatingObject:selected", onSelected);
    unsubscribe();
    if (present) {
      removeGridRegionsByType(TYPE);
      present = false;
    }
    unregister();
  };
}
