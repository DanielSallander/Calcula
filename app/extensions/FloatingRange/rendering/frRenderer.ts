//! FILENAME: app/extensions/FloatingRange/rendering/frRenderer.ts
// PURPOSE: Overlay render + hit-test for floating ranges: opaque frame (title
//          bar, local A1 headers, gridlines), backend display strings with
//          type-based alignment, FR-local selection paint, object-selection
//          chrome, and the quantized-resize ghost.
// CONTEXT: Async-fetch/sync-render cache per Controls/Shape/shapeRenderer.ts
//          (staleEntries kept visible while a re-fetch is in flight — no
//          blink). Floating regions get NO gridline suppression from Core, so
//          the frame paints its own opaque background first.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
} from "@api/gridOverlays";
import { columnToLetter } from "@api";
import { getFloatingRangeCells } from "@api/floatingRanges";
import type { TypedCellData } from "@api/lib";
import {
  getFloatingRangeById,
  type FloatingRangeEntry,
} from "../lib/floatingRangeStore";
import {
  FR_TITLE_H,
  frTitleH,
  frColHdrH,
  frRowHdrW,
  frCellsTop,
  frColWidth,
  frRowHeight,
  frameWidth,
  frameHeight,
  localCellOrigin,
} from "../lib/frDimensions";
import {
  isFloatingRangeSelected,
  getLocalSelection,
  localSelectionRect,
} from "../lib/frSelection";
import { layoutFrEditorForFrame } from "../editor/frEditor";

// ============================================================================
// Cell cache (async fetch, sync render)
// ============================================================================

interface CachedFrCell {
  display: string;
  align: CanvasTextAlign;
}

/** frId -> "row,col" -> cell. Whole-window fetches (counts are bounded). */
const cellCache = new Map<string, Map<string, CachedFrCell>>();
const pendingFetches = new Set<string>();

/** frIds whose cached data is stale — kept visible while a re-fetch runs. */
const staleEntries = new Set<string>();

function alignmentForType(cell: TypedCellData): CanvasTextAlign {
  switch (cell.type) {
    case "number":
      return "right";
    case "boolean":
    case "error":
      return "center";
    default:
      return "left";
  }
}

/** Exported for the unit tier: the failure verdict below must be pinned
 *  (silent on a lost delete race, loud on a persistent inconsistency). */
export async function fetchFrCells(entry: FloatingRangeEntry): Promise<void> {
  const frId = entry.id;
  pendingFetches.add(frId);
  try {
    const cells = await getFloatingRangeCells(
      frId,
      0,
      0,
      entry.rows - 1,
      entry.cols - 1,
    );
    const map = new Map<string, CachedFrCell>();
    for (const cell of cells) {
      if (cell.type === "empty") continue;
      map.set(`${cell.row},${cell.col}`, {
        display: cell.display ?? "",
        align: alignmentForType(cell),
      });
    }
    cellCache.set(frId, map);
    staleEntries.delete(frId);
    requestOverlayRedraw();
  } catch (err) {
    // A fetch can legitimately lose a race with DELETION. Backend-initiated
    // deletes (the @api wrapper, a script's api.deleteFloatingRange) announce
    // first and the store prunes in an ASYNC reload, so a redraw inside that
    // window renders — and fetches — a row the backend has already dropped
    // (BUG-0057, caught by the walker's fr.delete on its first day). That
    // transient must stay SILENT. But a row STILL in the store once the dust
    // settles is a real inconsistency and must stay LOUD — a session-wide
    // stale store is exactly what BUG-0056 was caught by, on this very line.
    // So the verdict is deferred, not softened.
    setTimeout(() => {
      if (getFloatingRangeById(frId)) {
        console.error(`[FloatingRange] Failed to fetch cells for ${frId}:`, err);
      } else {
        // The row is gone from the store too: the fetch lost the delete race.
        cellCache.delete(frId);
        staleEntries.delete(frId);
        requestOverlayRedraw();
      }
    }, FR_FETCH_FAILURE_VERDICT_MS);
  } finally {
    pendingFetches.delete(frId);
  }
}

/**
 * How long a failed cell fetch waits before deciding whether it lost a
 * benign delete race (row gone from the store — silent) or found a real
 * store/backend inconsistency (row still cached — console.error). The
 * announce-to-reload window measured well under 200 ms on the walks that
 * exposed it; 1 s is comfortably past it and still inside any watcher's
 * settle time.
 */
const FR_FETCH_FAILURE_VERDICT_MS = 1000;

/** Mark one FR's cell cache stale (kept visible until the re-fetch lands). */
export function invalidateFrCache(frId: string): void {
  staleEntries.add(frId);
  pendingFetches.delete(frId);
}

/** Mark every FR's cache stale (coarse CELLS_UPDATED safety net). */
export function invalidateAllFrCaches(): void {
  for (const key of cellCache.keys()) staleEntries.add(key);
  // An FR that has never fetched yet must also re-kick on next paint.
  pendingFetches.clear();
}

/** Drop an FR's cache entirely (object deleted). */
export function removeFrFromCache(frId: string): void {
  cellCache.delete(frId);
  staleEntries.delete(frId);
  pendingFetches.delete(frId);
}

/** Drop everything (document change / deactivate). */
export function resetFrRenderCaches(): void {
  cellCache.clear();
  staleEntries.clear();
  pendingFetches.clear();
  resizeGhost = null;
}

// ============================================================================
// Quantized-resize ghost
// ============================================================================

export interface FrResizeGhost {
  frId: string;
  /** Sheet-pixel bounds of the SNAPPED frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number;
  cols: number;
}

let resizeGhost: FrResizeGhost | null = null;

export function setFrResizeGhost(ghost: FrResizeGhost | null): void {
  resizeGhost = ghost;
}

// ============================================================================
// Colors (deliberately plain; FR cells carry no formatting in v1)
// ============================================================================

const COLORS = {
  frameBg: "#ffffff",
  frameBorder: "#8a8a8a",
  titleBg: "#f0f0f0",
  titleText: "#333333",
  headerBg: "#f7f7f7",
  headerText: "#666666",
  gridline: "#d8d8d8",
  cellText: "#1a1a1a",
  selectionFill: "rgba(33, 115, 70, 0.14)",
  selectionBorder: "#217346",
  objectChrome: "#0e639c",
  ghost: "#0e639c",
};

const CELL_FONT = "11px 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
const CELL_PAD_X = 3;

// ============================================================================
// Render
// ============================================================================

export function renderFloatingRange(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;
  const frId = region.data?.frId as string | undefined;
  if (!frId) return;
  const entry = getFloatingRangeById(frId);
  if (!entry) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const { canvasX, canvasY } = overlaySheetToCanvas(
    overlayCtx,
    region.floating.x,
    region.floating.y,
  );
  const w = frameWidth(entry);
  const h = frameHeight(entry);

  // The editor is repositioned every render frame (DOM-over-canvas contract) —
  // including when the frame is clipped/off-screen, which HIDES it.
  layoutFrEditorForFrame(entry, canvasX, canvasY, overlayCtx);

  // Skip paint if fully invisible.
  if (canvasX + w < rowHeaderWidth || canvasY + h < colHeaderHeight) return;
  if (canvasX > overlayCtx.canvasWidth || canvasY > overlayCtx.canvasHeight) return;

  // Kick the async fetch when needed; paint from whatever the cache holds.
  const cached = cellCache.get(frId);
  if ((!cached || staleEntries.has(frId)) && !pendingFetches.has(frId)) {
    void fetchFrCells(entry);
  }

  ctx.save();
  // Clip to the grid cell area — never paint over the grid's own headers.
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // ---- 1. Opaque frame background + border ----
  ctx.fillStyle = COLORS.frameBg;
  ctx.fillRect(canvasX, canvasY, w, h);
  ctx.strokeStyle = COLORS.frameBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(canvasX + 0.5, canvasY + 0.5, w - 1, h - 1);

  // Chrome extents: 0 for whatever the object hides, which is what makes the
  // three blocks below skippable WITHOUT leaving a gap — every coordinate here
  // is derived from these, never from the raw constants.
  const titleH = frTitleH(entry);
  const colHdrH = frColHdrH(entry);
  const rowHdrW = frRowHdrW(entry);

  // ---- 2. Title bar (the Core-move grab zone; optional) ----
  if (titleH > 0) {
    ctx.fillStyle = COLORS.titleBg;
    ctx.fillRect(canvasX, canvasY, w, titleH);
    ctx.strokeStyle = COLORS.frameBorder;
    ctx.beginPath();
    ctx.moveTo(canvasX, canvasY + titleH + 0.5);
    ctx.lineTo(canvasX + w, canvasY + titleH + 0.5);
    ctx.stroke();
    ctx.font = `600 ${CELL_FONT}`;
    ctx.fillStyle = COLORS.titleText;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(canvasX + 2, canvasY, w - 4, titleH);
    ctx.clip();
    ctx.fillText(entry.name, canvasX + 6, canvasY + titleH / 2 + 0.5);
    ctx.restore();
  }

  // ---- 3. Local headers (optional — they advertise the private A1 space) ----
  const hdrTop = canvasY + titleH;
  const cellsTop = canvasY + frCellsTop(entry);
  const cellsLeft = canvasX + rowHdrW;

  ctx.fillStyle = COLORS.headerBg;
  if (colHdrH > 0) {
    ctx.fillRect(canvasX, hdrTop, w, colHdrH); // col header strip (incl. corner)
  }
  if (rowHdrW > 0) {
    ctx.fillRect(canvasX, cellsTop, rowHdrW, h - frCellsTop(entry));
  }

  ctx.font = `10px 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`;
  ctx.fillStyle = COLORS.headerText;
  ctx.textBaseline = "middle";

  // Column letters.
  ctx.textAlign = "center";
  if (colHdrH > 0) {
    let x = cellsLeft;
    for (let c = 0; c < entry.cols; c++) {
      const cw = frColWidth(entry, c);
      ctx.fillText(columnToLetter(c), x + cw / 2, hdrTop + colHdrH / 2 + 0.5);
      x += cw;
    }
  }
  // Row numbers.
  if (rowHdrW > 0) {
    let y = cellsTop;
    for (let r = 0; r < entry.rows; r++) {
      const rh = frRowHeight(entry, r);
      ctx.fillText(String(r + 1), canvasX + rowHdrW / 2, y + rh / 2 + 0.5);
      y += rh;
    }
  }

  // Header separators — one per strip that is actually there.
  ctx.strokeStyle = COLORS.gridline;
  ctx.beginPath();
  if (colHdrH > 0) {
    ctx.moveTo(canvasX, cellsTop + 0.5 - 1);
    ctx.lineTo(canvasX + w, cellsTop + 0.5 - 1);
  }
  if (rowHdrW > 0) {
    ctx.moveTo(cellsLeft + 0.5 - 1, hdrTop);
    ctx.lineTo(cellsLeft + 0.5 - 1, canvasY + h);
  }
  ctx.stroke();

  // ---- 4. Gridlines ----
  ctx.strokeStyle = COLORS.gridline;
  ctx.beginPath();
  {
    let x = cellsLeft;
    for (let c = 0; c < entry.cols; c++) {
      x += frColWidth(entry, c);
      ctx.moveTo(x + 0.5 - 1, cellsTop);
      ctx.lineTo(x + 0.5 - 1, canvasY + h);
    }
    let y = cellsTop;
    for (let r = 0; r < entry.rows; r++) {
      y += frRowHeight(entry, r);
      ctx.moveTo(cellsLeft, y + 0.5 - 1);
      ctx.lineTo(canvasX + w, y + 0.5 - 1);
    }
  }
  ctx.stroke();

  // ---- 5. FR-local selection (under the values' ink is fine — it is a fill) ----
  const localSel = getLocalSelection();
  if (localSel && localSel.frId === frId) {
    const rect = localSelectionRect(localSel);
    const minRow = Math.min(rect.minRow, entry.rows - 1);
    const minCol = Math.min(rect.minCol, entry.cols - 1);
    const maxRow = Math.min(rect.maxRow, entry.rows - 1);
    const maxCol = Math.min(rect.maxCol, entry.cols - 1);
    const origin = localCellOrigin(entry, minRow, minCol);
    let selW = 0;
    for (let c = minCol; c <= maxCol; c++) selW += frColWidth(entry, c);
    let selH = 0;
    for (let r = minRow; r <= maxRow; r++) selH += frRowHeight(entry, r);
    const sx = canvasX + origin.x;
    const sy = canvasY + origin.y;
    ctx.fillStyle = COLORS.selectionFill;
    ctx.fillRect(sx, sy, selW, selH);
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, sy + 1, selW - 2, selH - 2);
    ctx.lineWidth = 1;
  }

  // ---- 6. Cell values (single line, clipped per cell, type alignment) ----
  ctx.font = CELL_FONT;
  ctx.textBaseline = "middle";
  if (cached) {
    let y = cellsTop;
    for (let r = 0; r < entry.rows; r++) {
      const rh = frRowHeight(entry, r);
      let x = cellsLeft;
      for (let c = 0; c < entry.cols; c++) {
        const cw = frColWidth(entry, c);
        const cell = cached.get(`${r},${c}`);
        if (cell && cell.display !== "") {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cw, rh);
          ctx.clip();
          ctx.fillStyle = COLORS.cellText;
          ctx.textAlign = cell.align;
          const tx =
            cell.align === "right"
              ? x + cw - CELL_PAD_X
              : cell.align === "center"
                ? x + cw / 2
                : x + CELL_PAD_X;
          ctx.fillText(cell.display, tx, y + rh / 2 + 0.5);
          ctx.restore();
        }
        x += cw;
      }
      y += rh;
    }
  }

  // ---- 7. Object-selection chrome (FR paints its own — Core paints none) ----
  if (isFloatingRangeSelected(frId)) {
    ctx.strokeStyle = COLORS.objectChrome;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, w - 2, h - 2);
    // 4 corner handles at Core's getFloatingCornerPixels positions.
    const handle = 6;
    ctx.fillStyle = COLORS.objectChrome;
    for (const [hx, hy] of [
      [canvasX, canvasY],
      [canvasX + w, canvasY],
      [canvasX, canvasY + h],
      [canvasX + w, canvasY + h],
    ] as const) {
      ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
    ctx.lineWidth = 1;
  }

  // ---- 8. Quantized-resize ghost (snapped to whole rows/cols) ----
  if (resizeGhost && resizeGhost.frId === frId) {
    const g = overlaySheetToCanvas(overlayCtx, resizeGhost.x, resizeGhost.y);
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(g.canvasX, g.canvasY, resizeGhost.width, resizeGhost.height);
    ctx.setLineDash([]);
    const label = `${resizeGhost.rows} × ${resizeGhost.cols}`;
    ctx.font = `600 ${CELL_FONT}`;
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = "rgba(14, 99, 156, 0.9)";
    ctx.fillRect(g.canvasX + 2, g.canvasY + 2, tw, 16);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(label, g.canvasX + 7, g.canvasY + 10.5);
    ctx.lineWidth = 1;
  }

  ctx.restore();
}

// ============================================================================
// Hit-testing + cursor
// ============================================================================

export function hitTestFloatingRange(hitCtx: OverlayHitTestContext): boolean {
  if (!hitCtx.floatingCanvasBounds) return false;
  const b = hitCtx.floatingCanvasBounds;
  return (
    hitCtx.canvasX >= b.x &&
    hitCtx.canvasX <= b.x + b.width &&
    hitCtx.canvasY >= b.y &&
    hitCtx.canvasY <= b.y + b.height
  );
}

/**
 * "move" wherever a drag would MOVE the object, "cell" wherever it would
 * select. Must stay in lockstep with `claimsBodyDrag` (index.ts): with a title
 * bar that is the title band; with the title bar hidden the whole body is the
 * grab zone, but only in design mode, because that is the only mode in which
 * Core will start a move at all.
 */
export function getFrCursor(hitCtx: OverlayHitTestContext): string | null {
  const b = hitCtx.floatingCanvasBounds;
  if (!b) return null;
  const frId = hitCtx.region.data?.frId as string | undefined;
  const entry = frId ? getFloatingRangeById(frId) : null;
  if (!entry) return null;
  if (entry.showTitle) {
    const dy = hitCtx.canvasY - b.y;
    return dy >= 0 && dy < FR_TITLE_H ? "move" : "cell";
  }
  // `movable` is the flag Core actually consults, and the store publishes it
  // from the design-mode state — reading it here keeps the cursor honest
  // instead of promising a move that Core will refuse.
  return hitCtx.region.data?.movable === true ? "move" : "cell";
}
