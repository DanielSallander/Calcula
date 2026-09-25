//! FILENAME: app/extensions/CanvasSheet/lib/pagePainter.ts
// PURPOSE: Paint a canvas sheet's PAGE: the area around it, the page itself
//          (its background colour), its border, and the transparent snap grid.
// CONTEXT: Registered as ONE grid layer at "under-cells", the bottom of the
//          stack: every floating object (charts, slicers, shapes, floating
//          grids) paints above it. The "under-selection" anchor would not do --
//          it runs AFTER the below-selection object renderers, so dots painted
//          there could land on top of an object.
//
//          Units: the renderer has already applied dpr * zoom to the context,
//          so everything here is LOGICAL px, the units of a floating object's
//          x/y. The page's top-left is the sheet origin, so on screen it sits
//          at (gutter - scrollX, gutter - scrollY); a canvas's gutters are 0.
//
//          The snap grid is painted only while the canvas is EDITABLE and
//          `showGrid` is on: a subscribed report page is for reading, and
//          painting the pitch the reader cannot use would be noise.

import type { GridLayerContext } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { canvasLayoutSurface } from "./layoutSurfaceProvider";
import { canvasAt } from "./canvasSheetStore";

/** Below this on-screen pitch the dots merge into a tint; skip them. */
export const MIN_DOT_PITCH_SCREEN_PX = 6;

/** Colours the painter needs, resolved from the skin's tokens. */
export interface PagePalette {
  outside: string;
  page: string;
  border: string;
  dot: string;
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The palette from the active skin. Read per paint: skins switch live. */
export function currentPagePalette(): PagePalette {
  return {
    outside: cssVar("--grid-area-bg", "#e9ebee"),
    page: cssVar("--grid-bg", "#ffffff"),
    border: cssVar("--grid-line", "#d0d4da"),
    dot: cssVar("--grid-line", "#c3c8cf"),
  };
}

/** The visible range of grid multiples along one axis, clipped to the page. */
export function gridLinesInView(
  pageExtent: number,
  scroll: number,
  viewExtent: number,
  pitch: number,
): number[] {
  if (!(pitch > 0)) return [];
  const from = Math.max(0, Math.ceil(scroll / pitch)) * pitch;
  const to = Math.min(pageExtent, scroll + viewExtent);
  const out: number[] = [];
  for (let v = from; v <= to; v += pitch) out.push(v);
  return out;
}

/**
 * Paint the page of the ACTIVE sheet when it is a canvas. A worksheet paints
 * nothing here -- and pays nothing: this layer runs on EVERY frame of every
 * sheet, so the surface is checked before the palette (four style lookups) is
 * read. `palette` and `zoom` are injectable for tests.
 */
export function paintCanvasPage(context: GridLayerContext, palette?: PagePalette, zoom?: number): void {
  const state = getGridStateSnapshot();
  if (!state || state.surface !== "canvas") return;
  const index = state.sheetContext.activeSheetIndex;
  const entry = canvasAt(index);
  const surface = canvasLayoutSurface(index);
  if (!entry || !surface || !surface.page) return;
  const pal = palette ?? currentPagePalette();
  const z = zoom ?? state.zoom ?? 1;

  const { ctx, viewport, canvasWidth, canvasHeight, config } = context;
  const gutterX = config.rowHeaderWidth ?? 0;
  const gutterY = config.colHeaderHeight ?? 0;
  const originX = gutterX - viewport.scrollX;
  const originY = gutterY - viewport.scrollY;
  const { width: pageW, height: pageH } = surface.page;

  // Around the page.
  ctx.fillStyle = pal.outside;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // The page.
  ctx.fillStyle = entry.layout.background || pal.page;
  ctx.fillRect(originX, originY, pageW, pageH);

  // The snap grid: one dot per intersection in view, only while it is usable.
  const pitch = surface.gridSize;
  if (surface.showGrid && surface.editable && pitch * z >= MIN_DOT_PITCH_SCREEN_PX) {
    const xs = gridLinesInView(pageW, viewport.scrollX, canvasWidth - gutterX, pitch);
    const ys = gridLinesInView(pageH, viewport.scrollY, canvasHeight - gutterY, pitch);
    const dot = Math.max(1, 1 / z);
    ctx.fillStyle = pal.dot;
    for (const y of ys) {
      for (const x of xs) {
        ctx.fillRect(originX + x - dot / 2, originY + y - dot / 2, dot, dot);
      }
    }
  }

  // The page edge, drawn last so the dots on it do not break it.
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = Math.max(1, 1 / z);
  ctx.strokeRect(originX, originY, pageW, pageH);
}
