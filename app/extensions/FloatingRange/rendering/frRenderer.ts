//! FILENAME: app/extensions/FloatingRange/rendering/frRenderer.ts
// PURPOSE: Overlay render + hit-test for floating ranges: opaque frame (title
//          bar, local A1 headers, gridlines), backend display strings with
//          type-based alignment, FR-local selection paint, the yellow edge
//          balls (a grid layer, `paintFrEdgeBalls`), and the quantized-resize
//          ghost. The OBJECT-selection outline and the corner handles are
//          Core's (core/lib/gridRenderer/rendering/floatingObjectChrome.ts,
//          BUG-0258 design phase 3); the range publishes `handles: "corners"`.
// CONTEXT: Async-fetch/sync-render cache per Controls/Shape/shapeRenderer.ts
//          (stale data kept visible while a re-fetch is in flight — no
//          blink). Floating regions get NO gridline suppression from Core, so
//          the frame paints its own opaque background first.
//
//          M7 -- OVERFLOW SCROLL. The frame is the WINDOW; its cell area is a
//          viewport onto content that can be larger (lib/frExtent.ts), scrolled
//          by a session scroll (lib/frScroll.ts), read together as the live
//          view (lib/frView.ts). The paint follows the canvas pivot box
//          (Pivot/rendering/pivotVisualRenderer.ts):
//
//          - NO offscreen buffer. The grid context already carries the
//            dpr * zoom transform, so drawing straight into it under a clip
//            stays sharp; a blitted buffer would blur at fractional offsets.
//          - The cell area is CLIPPED to its viewport and only the rows and
//            columns that show through it -- and are on the canvas at all --
//            are painted, at their content offset minus the scroll.
//          - The local column letters and row numbers are STICKY: each strip
//            stays put and shows the scrolled labels, clipped to itself.
//          - Overlay scroll indicators (shared with the pivot box) mark an axis
//            that overflows.
//          - The cell FETCH is viewport-limited too: only the on-screen cells
//            plus a margin, never the whole window. That also retires a latent
//            failure: the whole-window read of a window over 100,000 cells was
//            refused by the backend every frame, so such a range never painted.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  getFloatingReferencePickPreview,
  getLiveGridRegions,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  topFloatingRegionAt,
} from "@api/gridOverlays";
import { columnToLetter, type GridLayerContext } from "@api";
import { withContainerContentClip } from "@api/visualContainerPaint";
import type { ResolvedVisualText } from "@api/visualContainer";
import type { TypedCellData } from "@api/lib";
import { paintScrollIndicators } from "../../_shared/lib/scrollIndicators";
import {
  INNER_SELECTION_BORDER,
  INNER_SELECTION_FILL,
  paintPickPreview,
} from "../../_shared/lib/innerSelectionPaint";
import {
  getFloatingRangeById,
  frRangeInSelection,
  FLOATING_RANGE_REGION_TYPE,
  type FloatingRangeEntry,
} from "../lib/floatingRangeStore";
import type { GridRegion } from "@api/gridOverlays";
import {
  FR_EDGE_HANDLE_R,
  frTitleH,
  frColHdrH,
  frRowHdrW,
  frInnerBox,
  frColWidth,
  frRowHeight,
  frameWidth,
  frameHeight,
  contentWidth,
  contentHeight,
  frColOffsets,
  frRowOffsets,
  frMaxScroll,
  frVisibleRange,
  frEdgeHandles,
  frEdgeHandleAt,
  type FrCellRange,
  type FrView,
} from "../lib/frDimensions";
import {
  getLocalSelection,
  localSelectionRect,
} from "../lib/frSelection";
import { readFrCells, type FrCellRect } from "../lib/frCellReads";
import { FrFetchLedger } from "../lib/frFetchLedger";
import {
  ensureFrExtent,
  invalidateFrExtent,
  invalidateAllFrExtents,
  removeFrExtent,
  resetFrExtents,
} from "../lib/frExtent";
import { getFrView, commitFrViewClamp } from "../lib/frView";
import { frContainerOf } from "../lib/frObjectFormat";
import { layoutFrEditorForFrame, getFrEditorCell } from "../editor/frEditor";

// ============================================================================
// Whether the resize handles are live
// ============================================================================

/**
 * Whether range `frId`'s resize handles (Core's corner boxes AND this
 * extension's edge balls) are armed on `region`: the store published
 * `resizable` -- geometry editable, the range SELECTED and none of its cells
 * being edited -- and the range's own cell editor is not open. The store
 * re-publishes `resizable` when the editor opens or closes (that is what Core's
 * corner boxes read), and the editor half is ALSO read live here, because the
 * region a press hands `frZoneAt` (index.ts) is the one Core captured before
 * the press: a handle painted or grabbable over the cell the user is typing in
 * is the one thing the owner ruled out (2026-09-27).
 *
 * The ONE gate for the paint, the extended hit area and the edge-ball zone
 * (`frZoneAt`, whose answer is also the pointer), so a ball is never grabbable
 * where it is not painted, nor painted where it is not grabbable.
 */
export function frHandlesLive(region: GridRegion, frId: string): boolean {
  if (region.data?.resizable !== true) return false;
  return getFrEditorCell()?.frId !== frId;
}

// ============================================================================
// Cell cache (async fetch, sync render)
// ============================================================================

interface CachedFrCell {
  display: string;
  align: CanvasTextAlign;
}

/** One range's cached cells: the rectangle that was READ, and what it held. */
interface FrCellCacheEntry {
  /** Inclusive rectangle of local cells the map answers for. */
  rect: FrCellRect;
  /** "row,col" -> cell, for the non-empty cells inside `rect`. */
  cells: Map<string, CachedFrCell>;
}

/** frId -> the last read that landed (kept visible while a newer one is in flight). */
const cellCache = new Map<string, FrCellCacheEntry>();
/** Stale / in-flight / landing order for the cell reads. */
const cellLedger = new FrFetchLedger();

/**
 * Rows / columns read beyond the on-screen rectangle, so a few wheel notches
 * scroll into cells that are already cached instead of painting empty cells
 * for a round trip.
 */
const FR_FETCH_MARGIN_ROWS = 20;
const FR_FETCH_MARGIN_COLS = 4;

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

function rectCovers(outer: FrCellRect, inner: FrCellRange): boolean {
  return (
    inner.startRow >= outer.startRow &&
    inner.endRow <= outer.endRow &&
    inner.startCol >= outer.startCol &&
    inner.endCol <= outer.endCol
  );
}

/** The rectangle to read for an on-screen range: it, plus a margin, inside the extent. */
export function frFetchRectFor(range: FrCellRange, view: FrView): FrCellRect {
  return {
    startRow: Math.max(0, range.startRow - FR_FETCH_MARGIN_ROWS),
    endRow: Math.min(view.rows - 1, range.endRow + FR_FETCH_MARGIN_ROWS),
    startCol: Math.max(0, range.startCol - FR_FETCH_MARGIN_COLS),
    endCol: Math.min(view.cols - 1, range.endCol + FR_FETCH_MARGIN_COLS),
  };
}

/**
 * Read one rectangle of an FR's cells into the cache. `rect` defaults to the
 * whole window (the pre-M7 read); the paint passes the on-screen rectangle.
 *
 * Exported for the unit tier: the failure verdict below must be pinned
 * (silent on a lost delete race, loud on a persistent inconsistency).
 */
export async function fetchFrCells(
  entry: FloatingRangeEntry,
  rect: FrCellRect = {
    startRow: 0,
    startCol: 0,
    endRow: entry.rows - 1,
    endCol: entry.cols - 1,
  },
): Promise<void> {
  const frId = entry.id;
  const n = cellLedger.begin(frId);
  try {
    const cells = await readFrCells(frId, rect);
    // An answer older than the one on screen (IPC reads can land out of
    // order), or for a range that was forgotten meanwhile, is dropped.
    if (!cellLedger.mayApply(frId, n)) return;
    const map = new Map<string, CachedFrCell>();
    for (const cell of cells) {
      if (cell.type === "empty") continue;
      map.set(`${cell.row},${cell.col}`, {
        display: cell.display ?? "",
        align: alignmentForType(cell),
      });
    }
    cellCache.set(frId, { rect: { ...rect }, cells: map });
    cellLedger.applied(frId, n);
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
        cellLedger.forget(frId);
        requestOverlayRedraw();
      }
    }, FR_FETCH_FAILURE_VERDICT_MS);
  } finally {
    cellLedger.end(frId, n);
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

/**
 * Mark one FR's cell cache stale (kept visible until the re-fetch lands). The
 * content extent goes stale with it: whatever changed the cells can have
 * changed how far they reach (a spill, a cleared last row).
 */
export function invalidateFrCache(frId: string): void {
  cellLedger.invalidate(frId);
  invalidateFrExtent(frId);
}

/** Mark every FR's cache stale (coarse CELLS_UPDATED safety net). An FR that
 *  has never fetched yet re-kicks on its next paint too. */
export function invalidateAllFrCaches(): void {
  cellLedger.invalidateAll(cellCache.keys());
  invalidateAllFrExtents();
}

/** Drop an FR's cache entirely (object deleted). */
export function removeFrFromCache(frId: string): void {
  cellCache.delete(frId);
  cellLedger.forget(frId);
  removeFrExtent(frId);
}

/** Drop everything (document change / deactivate). */
export function resetFrRenderCaches(): void {
  cellCache.clear();
  cellLedger.reset();
  resetFrExtents();
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
// A reference pick's drag preview (D-PICK)
// ============================================================================

/**
 * The local cells a reference pick's drag covers on THIS range right now, or
 * null: Core publishes the preview (@api/gridOverlays,
 * `getFloatingReferencePickPreview`) and the range paints it when the preview
 * is its region's, in the object space, under its own name. Normalized and
 * clamped to the content extent the paint can reach (a range shrunk under a
 * live drag never indexes past its offsets). Exported for the unit tier.
 */
export function frPickPreviewCells(
  regionId: string,
  entry: FloatingRangeEntry,
  view: FrView,
): FrCellRange | null {
  const preview = getFloatingReferencePickPreview();
  if (!preview || preview.regionId !== regionId) return null;
  const r = preview.range;
  if (r.space !== "object" || r.name !== entry.name) return null;
  if (view.rows <= 0 || view.cols <= 0) return null;
  const startRow = Math.min(r.startRow, r.endRow);
  const startCol = Math.min(r.startCol, r.endCol);
  if (startRow > view.rows - 1 || startCol > view.cols - 1) return null;
  return {
    startRow: Math.max(0, startRow),
    startCol: Math.max(0, startCol),
    endRow: Math.min(Math.max(r.startRow, r.endRow), view.rows - 1),
    endCol: Math.min(Math.max(r.startCol, r.endCol), view.cols - 1),
  };
}

// ============================================================================
// Colors (deliberately plain; FR cells carry no formatting in v1)
// ============================================================================

const COLORS = {
  frameBg: "#ffffff",
  frameBorder: "#8a8a8a",
  // The title bar's fill and ink are the RESOLVED container title's
  // (lib/frObjectFormat.ts: #f0f0f0 / #333333 by default), never constants.
  headerBg: "#f7f7f7",
  headerText: "#666666",
  gridline: "#d8d8d8",
  cellText: "#1a1a1a",
  /** The shared inner-selection ink (_shared/lib/innerSelectionPaint.ts):
   *  a canvas pivot's cell selection looks exactly like this range's. */
  selectionFill: INNER_SELECTION_FILL,
  selectionBorder: INNER_SELECTION_BORDER,
  objectChrome: "#0e639c",
  ghost: "#0e639c",
  /** Edge (cell-scale) handles. Deliberately NOT the object-chrome blue: the
   *  corner handles change the COUNTS and these change the SIZES, and a user
   *  who cannot tell them apart has to discover the difference by undoing. */
  edgeHandleFill: "#f2c744",
  edgeHandleBorder: "#8a6d1a",
};

const CELL_FONT = "11px 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
const CELL_PAD_X = 3;
/** The title text's inset from the bar's left / right end. */
const TITLE_PAD_X = 6;

/**
 * The title bar's font from the resolved title style. Bold is the bar's own
 * semibold (600) -- today's look -- not the browser's 700. Exported for the
 * unit tier.
 */
export function frTitleFont(t: Pick<ResolvedVisualText, "italic" | "bold" | "fontSize" | "fontFamily">): string {
  return `${t.italic ? "italic " : ""}${t.bold ? 600 : 400} ${t.fontSize}px ${t.fontFamily}`;
}

/**
 * Paint the title bar (the range's NAME) at canvas (x, y), `w` x `h`, in the
 * RESOLVED title style: its background, ink, font, alignment and underline.
 * The text is clipped to the bar. Exported for the unit tier.
 */
export function paintFrTitleBar(
  ctx: CanvasRenderingContext2D,
  title: ResolvedVisualText,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (title.background !== "") {
    ctx.fillStyle = title.background;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = COLORS.frameBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + h + 0.5);
  ctx.lineTo(x + w, y + h + 0.5);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 2, y, Math.max(0, w - 4), h);
  ctx.clip();
  ctx.font = frTitleFont(title);
  ctx.fillStyle = title.color;
  ctx.textAlign = title.align;
  ctx.textBaseline = "middle";
  const tx =
    title.align === "right" ? x + w - TITLE_PAD_X : title.align === "center" ? x + w / 2 : x + TITLE_PAD_X;
  const ty = y + h / 2 + 0.5;
  ctx.fillText(name, tx, ty);
  if (title.underline && name !== "") {
    const tw = ctx.measureText(name).width;
    const x0 = title.align === "right" ? tx - tw : title.align === "center" ? tx - tw / 2 : tx;
    const uy = Math.round(ty + title.fontSize * 0.5) + 0.5;
    ctx.strokeStyle = title.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, uy);
    ctx.lineTo(x0 + tw, uy);
    ctx.stroke();
  }
  ctx.restore();
}

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

  // The OUTER frame (what Core moves, selects and paints the container around)
  // and, inside the container's border and padding, the grid's OWN frame --
  // the content rect, where the title bar, the strips and the cells live.
  const outer = overlaySheetToCanvas(overlayCtx, region.floating.x, region.floating.y);
  const outerW = frameWidth(entry);
  const outerH = frameHeight(entry);
  const inner = frInnerBox(entry);
  const canvasX = outer.canvasX + inner.x;
  const canvasY = outer.canvasY + inner.y;
  const w = inner.width;
  const h = inner.height;

  // The live view (content extent + session scroll, clamped) — the SAME read
  // the hit router and the editor layout make, so paint and click agree.
  const view = getFrView(entry);

  // The editor is repositioned every render frame (DOM-over-canvas contract) —
  // including when the frame is clipped/off-screen, which HIDES it. Its cell
  // origins are frame-relative (they include the container inset).
  layoutFrEditorForFrame(entry, outer.canvasX, outer.canvasY, overlayCtx, view);

  // Skip paint if fully invisible.
  if (outer.canvasX + outerW < rowHeaderWidth || outer.canvasY + outerH < colHeaderHeight) return;
  if (outer.canvasX > overlayCtx.canvasWidth || outer.canvasY > overlayCtx.canvasHeight) return;

  // The content extent is read lazily, for on-screen ranges only; once it is
  // known, a scroll left past a shrunken end is clamped for good.
  ensureFrExtent(entry);
  commitFrViewClamp(entry, view);

  // Chrome extents: 0 for whatever the object hides, which is what makes the
  // blocks below skippable WITHOUT leaving a gap — every coordinate here is
  // derived from these, never from the raw constants.
  const titleH = frTitleH(entry);
  const colHdrH = frColHdrH(entry);
  const rowHdrW = frRowHdrW(entry);

  const hdrTop = canvasY + titleH;
  const cellsTop = canvasY + titleH + colHdrH;
  const cellsLeft = canvasX + rowHdrW;
  // The cell VIEWPORT: the window's cells, whatever the content behind it.
  const vpW = contentWidth(entry);
  const vpH = contentHeight(entry);

  // Content offsets over the extent, and the rows/cols that show through the
  // viewport AND lie on the canvas (the grid's own cell area).
  const colOff = frColOffsets(entry, view.cols);
  const rowOff = frRowOffsets(entry, view.rows);
  const range = frVisibleRange(entry, view, {
    x0: rowHeaderWidth - cellsLeft,
    y0: colHeaderHeight - cellsTop,
    x1: overlayCtx.canvasWidth - cellsLeft,
    y1: overlayCtx.canvasHeight - cellsTop,
  });
  const colsShown = range.endCol >= range.startCol;
  const rowsShown = range.endRow >= range.startRow;
  /** Canvas x of column c's left edge / y of row r's top edge, scrolled. */
  const colLeft = (c: number) => cellsLeft + colOff[c] - view.scrollLeft;
  const rowTopY = (r: number) => cellsTop + rowOff[r] - view.scrollTop;

  // Kick the async fetch when the cache is missing, stale, or does not cover
  // what is on screen; paint from whatever the cache holds meanwhile.
  const cached = cellCache.get(frId);
  if (colsShown && rowsShown && !cellLedger.isPending(frId)) {
    if (!cached || cellLedger.isStale(frId) || !rectCovers(cached.rect, range)) {
      void fetchFrCells(entry, frFetchRectFor(range, view));
    }
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

  // ---- 1-6. The grid's own frame, clipped to the container's CONTENT rect
  // (and its rounded corners): Core painted the container's shadow and
  // background under this and paints its border over it.
  withContainerContentClip(
    ctx,
    region,
    { x: outer.canvasX, y: outer.canvasY, width: outerW, height: outerH },
    { x: canvasX, y: canvasY, width: w, height: h },
    () => {
      // ---- 1. Opaque frame background + border ----
      ctx.fillStyle = COLORS.frameBg;
      ctx.fillRect(canvasX, canvasY, w, h);
      ctx.strokeStyle = COLORS.frameBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(canvasX + 0.5, canvasY + 0.5, w - 1, h - 1);

      // ---- 2. Title bar (the Core-move grab zone; optional; never scrolls) ----
      // Painted by the grid itself (`paint.title` "family") from the RESOLVED
      // title: a formatted or bound colour, size or alignment paints here.
      if (titleH > 0) {
        paintFrTitleBar(ctx, frContainerOf(entry).title, entry.name, canvasX, canvasY, w, titleH);
      }

      // ---- 3. Local headers (optional — they advertise the private A1 space) ----
      // STICKY: the strips stay put and carry the SCROLLED labels, each clipped to
      // its own strip so a label never slides over the corner or out of the frame.
      ctx.fillStyle = COLORS.headerBg;
      if (colHdrH > 0) {
        ctx.fillRect(canvasX, hdrTop, w, colHdrH); // col header strip (incl. corner)
      }
      if (rowHdrW > 0) {
        ctx.fillRect(canvasX, cellsTop, rowHdrW, h - titleH - colHdrH);
      }

      ctx.font = `10px 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLORS.headerText;
      ctx.textBaseline = "middle";

      // Column letters.
      ctx.textAlign = "center";
      if (colHdrH > 0 && colsShown) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cellsLeft, hdrTop, vpW, colHdrH);
        ctx.clip();
        for (let c = range.startCol; c <= range.endCol; c++) {
          const cw = frColWidth(entry, c);
          ctx.fillText(columnToLetter(c), colLeft(c) + cw / 2, hdrTop + colHdrH / 2 + 0.5);
        }
        ctx.restore();
      }
      // Row numbers.
      if (rowHdrW > 0 && rowsShown) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(canvasX, cellsTop, rowHdrW, vpH);
        ctx.clip();
        for (let r = range.startRow; r <= range.endRow; r++) {
          const rh = frRowHeight(entry, r);
          ctx.fillText(String(r + 1), canvasX + rowHdrW / 2, rowTopY(r) + rh / 2 + 0.5);
        }
        ctx.restore();
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

      // ---- 4-6. The cell viewport: clipped, scrolled, visible cells only ----
      ctx.save();
      ctx.beginPath();
      ctx.rect(cellsLeft, cellsTop, vpW, vpH);
      ctx.clip();

      // ---- 4. Gridlines (each shown cell's right / bottom edge) ----
      ctx.strokeStyle = COLORS.gridline;
      ctx.beginPath();
      if (colsShown) {
        for (let c = range.startCol; c <= range.endCol; c++) {
          const x = colLeft(c + 1);
          ctx.moveTo(x + 0.5 - 1, cellsTop);
          ctx.lineTo(x + 0.5 - 1, cellsTop + vpH);
        }
      }
      if (rowsShown) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          const y = rowTopY(r + 1);
          ctx.moveTo(cellsLeft, y + 0.5 - 1);
          ctx.lineTo(cellsLeft + vpW, y + 0.5 - 1);
        }
      }
      ctx.stroke();

      // ---- 5. FR-local selection (under the values' ink is fine — it is a fill) ----
      // Clamped to the EXTENT, not the window: a selection may reach cells that
      // only scrolling shows. The viewport clip trims what is scrolled away.
      const localSel = getLocalSelection();
      if (localSel && localSel.frId === frId) {
        const rect = localSelectionRect(localSel);
        const minRow = Math.min(rect.minRow, view.rows - 1);
        const minCol = Math.min(rect.minCol, view.cols - 1);
        const maxRow = Math.min(rect.maxRow, view.rows - 1);
        const maxCol = Math.min(rect.maxCol, view.cols - 1);
        const sx = colLeft(minCol);
        const sy = rowTopY(minRow);
        const selW = colOff[maxCol + 1] - colOff[minCol];
        const selH = rowOff[maxRow + 1] - rowOff[minRow];
        ctx.fillStyle = COLORS.selectionFill;
        ctx.fillRect(sx, sy, selW, selH);
        ctx.strokeStyle = COLORS.selectionBorder;
        ctx.lineWidth = 2;
        ctx.strokeRect(sx + 1, sy + 1, selW - 2, selH - 2);
        ctx.lineWidth = 1;
      }

      // ---- 5b. A reference pick's drag over THIS range (D-PICK) ----
      // Core runs the pick and inserts "<name>!A1:B3" itself; the range only shows
      // what the drag covers, dashed, in the same scrolled cell space as the
      // selection above (the viewport clip trims what is scrolled away).
      const pick = frPickPreviewCells(region.id, entry, view);
      if (pick) {
        paintPickPreview(ctx, [
          {
            x: colLeft(pick.startCol),
            y: rowTopY(pick.startRow),
            width: colOff[pick.endCol + 1] - colOff[pick.startCol],
            height: rowOff[pick.endRow + 1] - rowOff[pick.startRow],
          },
        ]);
      }

      // ---- 6. Cell values (single line, clipped per cell, type alignment) ----
      ctx.font = CELL_FONT;
      ctx.textBaseline = "middle";
      if (cached && colsShown && rowsShown) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          const rh = frRowHeight(entry, r);
          const y = rowTopY(r);
          for (let c = range.startCol; c <= range.endCol; c++) {
            const cell = cached.cells.get(`${r},${c}`);
            if (!cell || cell.display === "") continue;
            const cw = frColWidth(entry, c);
            const x = colLeft(c);
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
        }
      }

      // Overlay scroll indicators on each axis whose content overflows the window.
      const { maxLeft, maxTop } = frMaxScroll(entry, view.rows, view.cols);
      if (maxLeft > 0 || maxTop > 0) {
        paintScrollIndicators(ctx, {
          box: { x: cellsLeft, y: cellsTop, width: vpW, height: vpH },
          scroll: { left: view.scrollLeft, top: view.scrollTop },
          maxScroll: { maxLeft, maxTop },
          content: { width: colOff[view.cols], height: rowOff[view.rows] },
        });
      }
      ctx.restore(); // the cell viewport clip
    },
  ); // the container's content clip

  // ---- 7. Object-selection chrome: NONE here. ----
  // The selection outline and the four corner handles (they change the
  // row/column COUNTS) are Core's, painted after every object from the one
  // geometry Core's resize hit test reads (BUG-0258 design phase 3). The
  // yellow edge balls (they scale the CELLS) are this extension's own, and
  // are painted ABOVE Core's outline by the `paintFrEdgeBalls` grid layer.

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
// The yellow edge balls (a grid layer above Core's selection chrome)
// ============================================================================

/** The id of the grid layer that paints the edge balls. */
export const FR_EDGE_BALL_LAYER_ID = "floating-range-edge-balls";

/**
 * Paint the yellow EDGE BALLS (they scale the CELLS) of every published range
 * that is SELECTED -- by this family or by the canvas selection set
 * (`frRangeInSelection`, the store's one answer) -- and whose handles are live
 * (`frHandlesLive`: geometry editable, selected, its cell editor closed) -- registered as a grid layer at
 * "over-selection", which runs AFTER Core's selection chrome. Core paints the
 * outline of a selected object after every object; a ball painted in the
 * range's own overlay pass would have that 2px outline drawn across it.
 *
 * A ball is painted only where it can be GRABBED: where the range itself is
 * the topmost object at the ball's centre. The ball is the range's own content
 * zone (`frZoneAt` part 'edgeHandle'), reached only when Core's press finds
 * the range on top at the point, so a ball whose centre lies under an object
 * stacked above the range is neither painted nor grabbable (the overlay-pass
 * paint had the same property: the object on top painted over it).
 *
 * Round and yellow precisely so they do not read as more of Core's square
 * handles -- two different resizes should not look alike. An edge too short
 * to carry one is simply not offered (frEdgeHandles). `regions` defaults to
 * the live published list (the regions a press can reach).
 */
export function paintFrEdgeBalls(
  context: GridLayerContext,
  regions: readonly GridRegion[] = getLiveGridRegions(),
): void {
  const { ctx, config, viewport } = context;
  // The overlay pass's own placement (overlaySheetToCanvas), so a ball sits
  // exactly where the range was painted.
  const rhw = config.rowHeaderWidth ?? 50;
  const chh = config.colHeaderHeight ?? 24;
  const geo = { rowHeaderWidth: rhw, colHeaderHeight: chh, scrollX: viewport.scrollX, scrollY: viewport.scrollY };
  let opened = false;
  for (const region of regions) {
    if (region.type !== FLOATING_RANGE_REGION_TYPE || !region.floating) continue;
    const frId = region.data?.frId as string | undefined;
    if (!frId || !frRangeInSelection(frId, region) || !frHandlesLive(region, frId)) continue;
    const entry = getFloatingRangeById(frId);
    if (!entry) continue;
    const originX = rhw + region.floating.x - viewport.scrollX;
    const originY = chh + region.floating.y - viewport.scrollY;
    for (const eh of frEdgeHandles(entry)) {
      const hx = originX + eh.x;
      const hy = originY + eh.y;
      if (topFloatingRegionAt(hx, hy, geo, regions)?.id !== region.id) continue;
      if (!opened) {
        ctx.save();
        ctx.setLineDash([]);
        opened = true;
      }
      ctx.beginPath();
      ctx.arc(hx, hy, FR_EDGE_HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.edgeHandleFill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.edgeHandleBorder;
      ctx.stroke();
    }
  }
  if (opened) ctx.restore();
}

// ============================================================================
// Hit-testing (the pointer is the zone's: frZoneAt in index.ts)
// ============================================================================

export function hitTestFloatingRange(hitCtx: OverlayHitTestContext): boolean {
  if (!hitCtx.floatingCanvasBounds) return false;
  const b = hitCtx.floatingCanvasBounds;
  if (
    hitCtx.canvasX >= b.x &&
    hitCtx.canvasX <= b.x + b.width &&
    hitCtx.canvasY >= b.y &&
    hitCtx.canvasY <= b.y + b.height
  ) {
    return true;
  }
  // EXTENDED AREA (the documented purpose of this hook): an edge handle is
  // centred ON the border, so its outer half lies outside the frame. Without
  // this, Core's inclusive bounds test would stop half of every yellow ball
  // from being grabbable and the handle would feel like it had a dead side.
  // Only while the handles are LIVE: an unselected range's invisible balls
  // must not reach past its frame and take a click meant for the grid.
  const frId = hitCtx.region.data?.frId as string | undefined;
  if (!frId || !frHandlesLive(hitCtx.region, frId)) return false;
  const entry = getFloatingRangeById(frId);
  if (!entry) return false;
  return frEdgeHandleAt(entry, hitCtx.canvasX - b.x, hitCtx.canvasY - b.y) !== null;
}
