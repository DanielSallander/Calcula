// FILENAME: app/extensions/Collaboration/lib/writebackDecorations.ts
// PURPOSE: The writeback STATE MARKER near a cell's top-right corner: a small
//          DISC that says "you typed this and have not sent it" (warn tone),
//          or a small SQUARE that says "the publisher rejected this" (danger
//          tone). The two differ in SHAPE, not only in colour, so they read
//          apart at 100% scaling and for a colour-blind user.
// CONTEXT: Discreet on purpose. Empty, submitted and approved cells carry NO
//          marker; "it was sent" is said by the marker disappearing, the
//          ribbon tab's status line and the submit toast. A cleared cell whose
//          clear has not been sent is a pending retraction and is marked too.
//
//          PLACEMENT. The top-right corner belongs to the note/comment
//          triangle (Review, a 6px right triangle with its right angle in the
//          corner, priority 5). Decorations cannot see each other, so the disc
//          sits INSIDE-LEFT of that triangle: centre (right - 9, top + 5),
//          radius 3, so its right edge is exactly the triangle's left edge and
//          both stay visible. A 1px ring in the cell background colour keeps it
//          legible over any fill. On a high-DPI canvas a tiny glyph is drawn in
//          it ("!" in the disc, "x" in the square); at 100% a glyph would be a
//          smudge, so it is left out there -- the shape alone carries the kind.
//
//          Colours come from the theme's tone tokens (@api/appearance
//          getCanvasToneColors) -- never literals -- so the Dark skin, user
//          token overrides and high contrast all apply.

import type { CellDecorationContext } from "@api/cellDecorations";
import type { WritebackCellState } from "./writebackStore";

export type WritebackMarkerKind = "draft" | "rejected";

/** The note/comment triangle's size (Review's triangleRenderer). */
export const NOTE_TRIANGLE_SIZE = 6;
export const MARKER_RADIUS = 3;
/** Disc centre offset from the cell's right edge. */
export const MARKER_INSET_RIGHT = NOTE_TRIANGLE_SIZE + MARKER_RADIUS;
/** Disc centre offset from the cell's top edge. */
export const MARKER_INSET_TOP = 5;

/** Which marker a state carries; null = no marker (discreet states). */
export function markerKindFor(state: WritebackCellState | null): WritebackMarkerKind | null {
  if (state === "draft") return "draft";
  if (state === "rejected") return "rejected";
  return null;
}

/** The disc's geometry for a cell. */
export function markerGeometry(
  cellRight: number,
  cellTop: number,
): { cx: number; cy: number; r: number } {
  return {
    cx: cellRight - MARKER_INSET_RIGHT,
    cy: cellTop + MARKER_INSET_TOP,
    r: MARKER_RADIUS,
  };
}

export interface WritebackMarkerColors {
  /** Ink for a draft (theme warn tone). */
  warn: string;
  /** Ink for a rejected value (theme danger tone). */
  danger: string;
  /** The cell background, for the contrast ring and the "!" glyph. */
  background: string;
}

/** Paint one marker. The caller has decided the cell needs one. */
export function paintWritebackMarker(
  ctx: CanvasRenderingContext2D,
  cell: { cellLeft: number; cellTop: number; cellRight: number; cellBottom: number },
  kind: WritebackMarkerKind,
  colors: WritebackMarkerColors,
  pixelRatio: number,
): void {
  const width = cell.cellRight - cell.cellLeft;
  const height = cell.cellBottom - cell.cellTop;
  // Too small to hold the disc beside the note triangle (a narrow or a
  // half-scrolled cell): skip rather than smear it over the content.
  if (width < MARKER_INSET_RIGHT + MARKER_RADIUS + 1 || height < MARKER_INSET_TOP + MARKER_RADIUS) {
    return;
  }
  const { cx, cy, r } = markerGeometry(cell.cellRight, cell.cellTop);
  ctx.save();
  ctx.beginPath();
  if (kind === "rejected") {
    // A SQUARE in the disc's footprint (same centre, side 2r), so it sits in
    // the same place beside the note triangle.
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.lineTo(cx - r, cy + r);
    ctx.lineTo(cx - r, cy - r);
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = kind === "rejected" ? colors.danger : colors.warn;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.background;
  ctx.stroke();
  if (pixelRatio >= 1.5) {
    if (kind === "rejected") {
      // "x" -- two 0.8px diagonals, in the background colour.
      const d = r - 1.2;
      ctx.beginPath();
      ctx.lineWidth = 0.8;
      ctx.moveTo(cx - d, cy - d);
      ctx.lineTo(cx + d, cy + d);
      ctx.moveTo(cx + d, cy - d);
      ctx.lineTo(cx - d, cy + d);
      ctx.stroke();
    } else {
      // "!" -- a 0.8px stem and a dot, in the background colour.
      ctx.fillStyle = colors.background;
      ctx.fillRect(cx - 0.4, cy - 2, 0.8, 2.4);
      ctx.fillRect(cx - 0.4, cy + 1, 0.8, 0.8);
    }
  }
  ctx.restore();
}

export interface WritebackDecorationDeps {
  /** The writeback state of a cell of the ACTIVE sheet; null outside regions. */
  cellState: (row: number, col: number) => WritebackCellState | null;
  /** Theme colours, read per frame (skin switches). */
  colors: () => WritebackMarkerColors;
  /** The canvas pixel ratio (devicePixelRatio). */
  pixelRatio: () => number;
}

/** The decoration function registered with context.grid.decorations. */
export function createWritebackDecoration(
  deps: WritebackDecorationDeps,
): (context: CellDecorationContext) => void {
  return (context) => {
    const kind = markerKindFor(deps.cellState(context.row, context.col));
    if (!kind) return;
    paintWritebackMarker(context.ctx, context, kind, deps.colors(), deps.pixelRatio());
  };
}
