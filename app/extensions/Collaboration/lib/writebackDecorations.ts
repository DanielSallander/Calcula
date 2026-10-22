// FILENAME: app/extensions/Collaboration/lib/writebackDecorations.ts
// PURPOSE: The writeback STATE MARKER -- a small solid red right triangle in a
//          cell's TOP-LEFT corner that says "this value needs you": typed but
//          not sent (a draft; a cleared cell whose clear has not been sent is a
//          pending retraction and counts), or sent and REJECTED by the
//          publisher. A rejected value's TEXT is also drawn in the danger tone,
//          so an in-grid reader can tell "rejected" from "not sent" without
//          relying on the triangle alone.
// CONTEXT: The owner's design, 2026-10-22. Until then the marker was a ~3px
//          warn-tone disc (a danger-tone square when rejected) inset beside the
//          note triangle at the top-right; the owner asked for "a small red
//          triangle in the left upper corner" instead. Discreet on purpose:
//          empty, submitted and approved cells carry NOTHING -- "it was sent" is
//          said by the marker disappearing, the ribbon tab's Status line and the
//          submit toast.
//
//          THE TRIANGLE. Right angle in the corner, legs 7px -- one more than the
//          note/comment triangle (Review, top-right, 6px), for the reason below
//          -- filled in the theme's DANGER tone. An over-selection decoration,
//          so selecting the cell does not hide it.
//
//          Z-ORDER WITH ERROR CHECKING. Excel's error indicator is a green
//          triangle in the SAME corner (ErrorChecking: 5px legs, over-selection,
//          priority 10). The marker registers at priority 9, so where both apply
//          the green one paints ON TOP and the strip between the two hypotenuses
//          stays red. With 6px legs that strip was 0.71px wide: at 100% scaling
//          it rasterised as a brown 50/50 mix and a pink fringe with no pixel of
//          the marker's red left, so a cell flagged "number stored as text" lost
//          its "not sent" signal (2026-10-22 review). With 7px legs it is 1.41px:
//          one full diagonal of solid red pixels at 100%, two at 200%. Neither
//          indicator is lost. Decorations cannot see each other; the priorities
//          and the sizes are the contract, pinned by writebackPainters.test.ts
//          against ErrorChecking's registration and its triangle's size.
//
//          The region frame (writebackOutline.ts, a layer painted after the cell
//          pass) re-tints the gridline pixels it lies on, so in a region's top
//          row and left column the marker's outermost row / column of pixels
//          takes the frame's tint while the cell is NOT selected -- a selected
//          cell's over-selection decorations are replayed after the layers. One
//          pixel of a 7px triangle; it still reads red.
//
//          THE REJECTED TEXT is a style interceptor that overrides the TEXT
//          COLOUR only -- never a background fill (the full-cell tints this
//          replaced made dark-skin text unreadable and hid the publisher's own
//          formatting). It runs after conditional formatting (priority 100), so
//          the status wins over a rule's font colour, and it leaves a cell
//          alone whose text an earlier interceptor made invisible (a checkbox
//          or an embedded button paints its own content over a transparent
//          TRUE/FALSE): the red would bring that text back. ITS INK FOLLOWS THE
//          FILL the cell shows: the active skin's danger ink is made for the
//          skin's own cell background, so on an EXPLICIT fill (@api/cellPaint
//          isExplicitCellFill -- a conditional format's included) the first of
//          the active ink, the Light ground's and the Dark ground's
//          (@api/appearance getBaselineToneColors) that reaches 3:1 against the
//          fill is used, and when none does the text keeps its own colour (the
//          triangle still marks the cell). The Dark skin's #fda29b on Excel's
//          "Light Red Fill" #ffc7ce was 1.32:1, over the preset's own #9c0006 at
//          5.92:1. A NUMBER FORMAT's colour ([Red], [Blue]) is applied by Core
//          after every interceptor and wins: a rejected value in such a format
//          keeps the format's colour, and only the triangle marks it.
//
//          Both are registered only while the workbook holds SUBSCRIBED regions
//          (the only ones that hold values) -- createWritebackCellPainters -- so
//          a workbook without writeback pays nothing per cell.
//
//          Colours come from the theme's tone tokens (@api/appearance
//          getCanvasToneColors().dangerFg) -- never literals -- so the Dark skin,
//          user token overrides and high contrast all apply.

import type {
  CellDecorationAnchor,
  CellDecorationContext,
  CellDecorationFn,
} from "@api/cellDecorations";
import type { IStyleOverride, StyleInterceptorFn } from "@api/styleInterceptors";
import type { WritebackCellState } from "./writebackStore";
import { firstReadableInk, parseOpaqueColour } from "./inkContrast";

export type WritebackMarkerKind = "draft" | "rejected";

/** The triangle's legs: wide enough that a 1.41px red band survives under ErrorChecking's 5px green one. */
export const MARKER_TRIANGLE_SIZE = 7;
/** Under ErrorChecking's green triangle (priority 10, same anchor and corner). */
export const WRITEBACK_MARKER_PRIORITY = 9;
/** Indicator chrome: it must survive the active-cell highlight. */
export const WRITEBACK_MARKER_ANCHOR: CellDecorationAnchor = "over-selection";
export const WRITEBACK_MARKER_ID = "collaboration:writeback-marker";
/** After conditional formatting (100): the rejected tone wins over a rule's font colour. */
export const WRITEBACK_REJECTED_TEXT_PRIORITY = 150;
export const WRITEBACK_REJECTED_TEXT_ID = "collaboration:writeback-rejected-text";

/** Which marker a state carries; null = no marker (discreet states). */
export function markerKindFor(state: WritebackCellState | null): WritebackMarkerKind | null {
  if (state === "draft") return "draft";
  if (state === "rejected") return "rejected";
  return null;
}

/** The triangle's vertices: the corner, then along the top edge, then down the left edge. */
export function markerTriangle(
  cellLeft: number,
  cellTop: number,
): [[number, number], [number, number], [number, number]] {
  return [
    [cellLeft, cellTop],
    [cellLeft + MARKER_TRIANGLE_SIZE, cellTop],
    [cellLeft, cellTop + MARKER_TRIANGLE_SIZE],
  ];
}

export interface WritebackMarkerColors {
  /** The theme's danger tone. */
  danger: string;
}

/** Paint the marker in a cell's top-left corner. The caller has decided the cell needs one. */
export function paintWritebackMarker(
  ctx: CanvasRenderingContext2D,
  cell: { cellLeft: number; cellTop: number; cellRight: number; cellBottom: number },
  colors: WritebackMarkerColors,
): void {
  // A cell (or the visible part of one) smaller than the triangle: skip rather
  // than smear it over the neighbours.
  if (
    cell.cellRight - cell.cellLeft < MARKER_TRIANGLE_SIZE ||
    cell.cellBottom - cell.cellTop < MARKER_TRIANGLE_SIZE
  ) {
    return;
  }
  const [corner, alongTop, downLeft] = markerTriangle(cell.cellLeft, cell.cellTop);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(corner[0], corner[1]);
  ctx.lineTo(alongTop[0], alongTop[1]);
  ctx.lineTo(downLeft[0], downLeft[1]);
  ctx.closePath();
  ctx.fillStyle = colors.danger;
  ctx.fill();
  ctx.restore();
}

export interface WritebackDecorationDeps {
  /** The writeback state of a cell of the ACTIVE sheet; null outside regions. */
  cellState: (row: number, col: number) => WritebackCellState | null;
  /** Theme colours, read per painted cell (skin switches). */
  colors: () => WritebackMarkerColors;
}

/** The decoration function registered with context.grid.decorations. */
export function createWritebackDecoration(deps: WritebackDecorationDeps): CellDecorationFn {
  return (context: CellDecorationContext) => {
    if (!markerKindFor(deps.cellState(context.row, context.col))) return;
    paintWritebackMarker(context.ctx, context, deps.colors());
  };
}

/** A zero alpha: "0", "0.0", ".0", "0%". */
const ZERO_ALPHA = /^(?:0+(?:\.0*)?|\.0+)%?$/;

/**
 * True when a text colour paints nothing: `transparent`, a #rgba / #rrggbbaa
 * with alpha 0, or an rgb()/rgba()/hsl()/hsla() whose ALPHA component is 0
 * (comma or slash syntax; `rgb(0, 0, 0)` -- black -- is not). A cell type that
 * draws its own content hides the cell's text this way.
 */
export function isInvisibleTextColor(colour: string | undefined): boolean {
  if (!colour) return false;
  const c = colour.trim().toLowerCase();
  if (c === "transparent") return true;
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(c);
  if (hex) return /^0+$/.test(hex[1].length === 4 ? hex[1].slice(3) : hex[1].slice(6));
  const fn = /^(?:rgb|hsl)a?\((.*)\)$/.exec(c);
  if (!fn) return false;
  const body = fn[1];
  let alpha: string | undefined;
  if (body.includes("/")) alpha = body.slice(body.indexOf("/") + 1);
  else {
    const parts = body.split(",");
    if (parts.length === 4) alpha = parts[3];
  }
  return alpha !== undefined && ZERO_ALPHA.test(alpha.trim());
}

export interface WritebackRejectedTextDeps {
  /** The writeback state of a cell of the ACTIVE sheet; null outside regions. */
  cellState: (row: number, col: number) => WritebackCellState | null;
  /** The theme's danger tone, read per call (skin switches). */
  danger: () => string;
  /** Danger inks to try, in order, when the active one does not read on a
   *  cell's explicit fill: the Light and the Dark ground's (@api/appearance
   *  getBaselineToneColors). Read only for such a cell. */
  alternativeInks: () => readonly string[];
  /** Whether the grid paints this background as given (@api/cellPaint
   *  isExplicitCellFill); otherwise it paints the skin's own cell background. */
  isExplicitFill: (backgroundColor: string | undefined) => boolean;
}

/**
 * The ink a REJECTED value's text is drawn in over `fill` (the background the
 * cell's style shows, after conditional formatting): the active danger ink on
 * the skin's own cell background or a fill that cannot be read as an opaque
 * colour; on an explicit fill, the first of the active ink and the
 * alternatives that reaches 3:1 against it; null when none does -- the text
 * keeps its own colour and the triangle alone marks the cell.
 */
export function rejectedTextInk(fill: string | undefined, deps: WritebackRejectedTextDeps): string | null {
  const active = deps.danger();
  if (!deps.isExplicitFill(fill) || !parseOpaqueColour(fill)) return active;
  return firstReadableInk(fill as string, [active, ...deps.alternativeInks()]);
}

/**
 * The style interceptor that draws a REJECTED value's text in the danger tone.
 * Text colour only, never a fill; nothing for any other state; nothing where an
 * earlier interceptor made the text invisible; nothing where no danger ink
 * reads on the cell's fill ({@link rejectedTextInk}).
 */
export function createWritebackRejectedTextInterceptor(
  deps: WritebackRejectedTextDeps,
): StyleInterceptorFn {
  return (_value, baseStyle, coords): IStyleOverride | null => {
    if (deps.cellState(coords.row, coords.col) !== "rejected") return null;
    if (isInvisibleTextColor(baseStyle.textColor)) return null;
    const ink = rejectedTextInk(baseStyle.backgroundColor, deps);
    return ink === null ? null : { textColor: ink };
  };
}

export interface WritebackCellPainterDeps extends WritebackRejectedTextDeps {
  /** context.grid.decorations.register */
  registerDecoration: (
    id: string,
    fn: CellDecorationFn,
    priority: number,
    anchor: CellDecorationAnchor,
  ) => () => void;
  /** context.grid.styleInterceptors.register */
  registerInterceptor: (id: string, fn: StyleInterceptorFn, priority: number) => () => void;
}

export interface WritebackCellPainters {
  /** Register both painters while `hasSubscribedRegions`, drop both when not. Idempotent. */
  sync(hasSubscribedRegions: boolean): void;
  /** Drop both (deactivation). */
  dispose(): void;
}

/**
 * The marker decoration and the rejected-text interceptor, kept registered
 * exactly while the workbook holds subscribed writeback regions.
 */
export function createWritebackCellPainters(deps: WritebackCellPainterDeps): WritebackCellPainters {
  const decoration = createWritebackDecoration({
    cellState: deps.cellState,
    colors: () => ({ danger: deps.danger() }),
  });
  const interceptor = createWritebackRejectedTextInterceptor(deps);
  let unregDecoration: (() => void) | null = null;
  let unregInterceptor: (() => void) | null = null;

  const dispose = (): void => {
    if (unregDecoration) {
      unregDecoration();
      unregDecoration = null;
    }
    if (unregInterceptor) {
      unregInterceptor();
      unregInterceptor = null;
    }
  };

  return {
    sync(hasSubscribedRegions) {
      if (!hasSubscribedRegions) {
        dispose();
        return;
      }
      if (!unregDecoration) {
        unregDecoration = deps.registerDecoration(
          WRITEBACK_MARKER_ID,
          decoration,
          WRITEBACK_MARKER_PRIORITY,
          WRITEBACK_MARKER_ANCHOR,
        );
      }
      if (!unregInterceptor) {
        unregInterceptor = deps.registerInterceptor(
          WRITEBACK_REJECTED_TEXT_ID,
          interceptor,
          WRITEBACK_REJECTED_TEXT_PRIORITY,
        );
      }
    },
    dispose,
  };
}
