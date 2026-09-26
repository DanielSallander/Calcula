//! FILENAME: app/extensions/CanvasSheet/lib/insertOnCanvas.ts
// PURPOSE: The Canvas tab's INSERT group: put a chart, a pivot table, a slicer,
//          a timeline, a floating grid, a text box, a shape, a picture or a
//          button on the active canvas, at a sensible place.
// CONTEXT: Every object is created by the extension that OWNS it, through its
//          feature-neutral @api seam (the Seam Rule): this module says WHAT and
//          WHERE, never how -- no recipe keys, no backend calls, no geometry
//          walk. Dialog-driven families (chart, pivot, slicer, timeline)
//          receive the placement through their dialog's data; the others
//          through their provider's request.
//
//          WHERE. A new object lands centred in what the user is looking at,
//          on the snap grid when snap is on, kept on the page, and each further
//          insert steps one grid pitch down-right so a burst of inserts does
//          not stack every object on one spot. The step resets when the view
//          or the sheet changes.

import { showDialog } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { alertAsync } from "@api/dialogs";
import { importImageViaPicker } from "@api/filesystem";
import { requireFloatingRangeProvider } from "@api/floatingRangeService";
import { requireControlsProvider } from "@api/controlsService";
import { requirePictureControlProvider } from "@api/pictureControlService";
import { requireButtonControlProvider } from "@api/buttonControlService";
import { clampMoveToPage, snapValue, type LayoutRect } from "@api/layoutSurface";
import { canvasLayoutSurface } from "./layoutSurfaceProvider";

/** Default sizes, in logical px, for each kind of object. */
export const INSERT_SIZES = {
  chart: { width: 480, height: 300 },
  // The pivot's FRAME: the box its view is shown in. A pivot is usually
  // bigger than its box -- the overflow scrolls inside it.
  pivot: { width: 480, height: 320 },
  slicer: { width: 180, height: 240 },
  timeline: { width: 360, height: 120 },
  textBox: { width: 240, height: 64 },
  shape: { width: 160, height: 96 },
  button: { width: 112, height: 32 },
  pictureMax: 400,
} as const;

/** What the default-placement maths needs to know about the view. */
export interface InsertView {
  sheetIndex: number;
  scrollX: number;
  scrollY: number;
  /** Visible area in LOGICAL px (screen px / zoom). */
  viewWidth: number;
  viewHeight: number;
}

let cascade = { key: "", step: 0 };

/** Forget the cascade (tests, extension deactivate). */
export function resetInsertCascade(): void {
  cascade = { key: "", step: 0 };
}

/** How a default rect treats a page smaller than the object. */
export interface InsertRectOptions {
  /**
   * Shrink the object to the page when the page is smaller than it. For an
   * object whose content scrolls inside its box (a pivot), a smaller box loses
   * nothing; for the others a page-sized box would squash them, so they keep
   * their size and pin to the page's top-left corner.
   */
  fitPage?: boolean;
}

/**
 * The rect a new object of `size` gets on sheet `view.sheetIndex`: centred in
 * the view, stepped by the cascade, snapped when snap is on, kept on the page.
 * Pure over its inputs plus the layout surface; exported for tests.
 */
export function defaultInsertRect(
  view: InsertView,
  requested: { width: number; height: number },
  options: InsertRectOptions = {},
): LayoutRect {
  const surface = canvasLayoutSurface(view.sheetIndex);
  const page = surface?.page ?? null;
  const size =
    options.fitPage && page
      ? { width: Math.min(requested.width, page.width), height: Math.min(requested.height, page.height) }
      : requested;
  const pitch = surface?.gridSize && surface.gridSize > 0 ? surface.gridSize : 16;
  const key = `${view.sheetIndex}:${Math.round(view.scrollX)}:${Math.round(view.scrollY)}`;
  if (cascade.key !== key) cascade = { key, step: 0 };
  const offset = cascade.step * pitch;
  cascade.step = (cascade.step + 1) % 12;

  let x = view.scrollX + (view.viewWidth - size.width) / 2 + offset;
  let y = view.scrollY + (view.viewHeight - size.height) / 2 + offset;
  if (surface?.snapToGrid) {
    x = snapValue(x, pitch);
    y = snapValue(y, pitch);
  }
  const rect = { x: Math.max(0, x), y: Math.max(0, y), width: size.width, height: size.height };
  return clampMoveToPage(rect, page);
}

/** The live view of the active sheet, or null when there is no grid yet. */
export function currentInsertView(): InsertView | null {
  const s = getGridStateSnapshot();
  if (!s) return null;
  const zoom = s.zoom > 0 ? s.zoom : 1;
  return {
    sheetIndex: s.sheetContext.activeSheetIndex,
    scrollX: s.viewport.scrollX,
    scrollY: s.viewport.scrollY,
    viewWidth: Math.max(1, s.viewportDimensions.width / zoom),
    viewHeight: Math.max(1, s.viewportDimensions.height / zoom),
  };
}

function placeFor(
  size: { width: number; height: number },
  options?: InsertRectOptions,
): (LayoutRect & { sheetIndex: number }) | null {
  const view = currentInsertView();
  if (!view) return null;
  return { sheetIndex: view.sheetIndex, ...defaultInsertRect(view, size, options) };
}

async function refusal(what: string, err: unknown): Promise<void> {
  await alertAsync(`Could not insert ${what}: ${err instanceof Error ? err.message : String(err)}`, {
    title: "Canvas",
  });
}

export type CanvasInsertKind =
  | "chart"
  | "pivot"
  | "slicer"
  | "timeline"
  | "floatingGrid"
  | "textBox"
  | "shape"
  | "picture"
  | "button";

/** Insert one object on the active canvas. Resolves when it is placed (or refused). */
export async function insertOnCanvas(kind: CanvasInsertKind): Promise<void> {
  switch (kind) {
    case "chart": {
      const place = placeFor(INSERT_SIZES.chart);
      if (!place) return;
      // The chart dialog takes its data range WITH its sheet (a canvas has no
      // cells), and must not guess a range from the canvas's empty selection.
      showDialog("chart:createDialog", { placement: place, suppressAutoRange: true });
      return;
    }
    case "pivot": {
      // A canvas pivot is a REAL pivot, written into the canvas's hidden grid
      // and shown inside this box (its frame); the Pivot extension's create
      // dialog owns everything else -- the source (a range with its sheet, a
      // table or a data model), the anchor, and what happens after.
      const place = placeFor(INSERT_SIZES.pivot, { fitPage: true });
      if (!place) return;
      showDialog("pivot:createDialog", { placement: place });
      return;
    }
    case "slicer": {
      const place = placeFor(INSERT_SIZES.slicer);
      if (!place) return;
      showDialog("slicer:insertDialog", { placement: { x: place.x, y: place.y } });
      return;
    }
    case "timeline": {
      const place = placeFor(INSERT_SIZES.timeline);
      if (!place) return;
      showDialog("timelineSlicer:insertDialog", { placement: { x: place.x, y: place.y } });
      return;
    }
    case "floatingGrid": {
      const place = placeFor({ width: 240, height: 120 });
      if (!place) return;
      try {
        await requireFloatingRangeProvider().create({ x: place.x, y: place.y, rows: 5, cols: 3 });
      } catch (err) {
        await refusal("a floating grid", err);
      }
      return;
    }
    case "textBox":
    case "shape": {
      const size = kind === "textBox" ? INSERT_SIZES.textBox : INSERT_SIZES.shape;
      const place = placeFor(size);
      if (!place) return;
      try {
        await requireControlsProvider().createShape({
          sheetIndex: place.sheetIndex,
          shapeType: kind === "textBox" ? "textBox" : "rectangle",
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
          text: "",
        });
      } catch (err) {
        await refusal(kind === "textBox" ? "a text box" : "a shape", err);
      }
      return;
    }
    case "button": {
      const place = placeFor(INSERT_SIZES.button);
      if (!place) return;
      try {
        await requireButtonControlProvider().createButton({
          sheetIndex: place.sheetIndex,
          label: "Button",
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
        });
      } catch (err) {
        await refusal("a button", err);
      }
      return;
    }
    case "picture": {
      let media;
      try {
        media = await importImageViaPicker({ title: "Insert Picture" });
      } catch (err) {
        await refusal("the picture", err);
        return;
      }
      if (!media) return; // cancelled
      const scale = Math.min(1, INSERT_SIZES.pictureMax / Math.max(media.width, media.height, 1));
      const size = {
        width: Math.max(16, Math.round(media.width * scale)),
        height: Math.max(16, Math.round(media.height * scale)),
      };
      const place = placeFor(size);
      if (!place) return;
      try {
        await requirePictureControlProvider().createPicture({
          sheetIndex: place.sheetIndex,
          mediaRef: media.ref,
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
        });
      } catch (err) {
        await refusal("the picture", err);
      }
      return;
    }
  }
}
