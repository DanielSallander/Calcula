//! FILENAME: app/extensions/CanvasSheet/lib/insertOnCanvas.ts
// PURPOSE: What the Canvas tab's VISUALS and ELEMENTS groups insert: a chart
//          (optionally PRESET to a type -- "Stacked bar", "Card"), a pivot
//          table (optionally in the Table visual's form), a slicer, a timeline,
//          a floating grid, a text box, a shape (by catalog id, at the
//          catalog's size), a picture or a button (blank, or one of Power BI's
//          declarative action buttons) -- on the active canvas, at a sensible
//          place.
// CONTEXT: Every object is created by the extension that OWNS it, through its
//          feature-neutral @api seam (the Seam Rule): this module says WHAT and
//          WHERE, never how -- no recipe keys, no backend calls, no geometry
//          walk. Dialog-driven families (chart, pivot, slicer, timeline)
//          receive the placement through their dialog's data; the others
//          through their provider's request.
//
//          WHAT. A chart tile names a mark and its options; the Charts dialog
//          opens preset to them (`initialMark` / `initialMarkOptions`,
//          CONTRACT-CANVAS 4.1) and the user still picks the data. The Table
//          tile asks the Pivot dialog for its Table preset (@api/pivotPresets).
//          A shape is asked for by its catalog id and NOT sized here: the
//          provider's catalog default applies (CONTRACT 4.3), and the same
//          catalog size places it. A Back / Clear all slicers button is a
//          DECLARATIVE action (@api/buttonControlService), never code: it works
//          with Script Security off and on a subscribed page.
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
import { BUTTON_ACTION_LABELS, requireButtonControlProvider, type ButtonAction } from "@api/buttonControlService";
import type { PivotCreatePreset } from "@api/pivotPresets";
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
  button: { width: 112, height: 32 },
  // "Clear all slicers" is the longest caption a single-button insert writes.
  wideButton: { width: 144, height: 32 },
  floatingGrid: { width: 240, height: 120 },
  pictureMax: 400,
} as const;

/**
 * The chart marks that get a box of their OWN size instead of the chart's:
 * the tile visuals, which show one number (Card), a few (Multi-row card), a
 * number with its trend (KPI) or a dial (Gauge). Dropped at the full chart
 * size, a Card was one number in a box the size of a column chart (review
 * finding 2026-10-08). Every other mark is placed at INSERT_SIZES.chart.
 */
export const CHART_MARK_INSERT_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  card: { width: 240, height: 140 },
  multiRowCard: { width: 320, height: 240 },
  kpi: { width: 280, height: 180 },
  gauge: { width: 320, height: 220 },
};

/** The box a chart of `mark` is placed in (the chart size unless it has its own). */
function chartInsertSize(mark: string | undefined): { width: number; height: number } {
  return (mark !== undefined && Object.prototype.hasOwnProperty.call(CHART_MARK_INSERT_SIZES, mark)
    ? CHART_MARK_INSERT_SIZES[mark]
    : INSERT_SIZES.chart);
}

/** The shape a bare Shapes press (the split's face) inserts. */
export const DEFAULT_SHAPE_ID = "rectangle";

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

/**
 * Where an object of `size` goes on the active canvas (its sheet with the
 * default rect), or null before the grid exists. Exported for the inserts that
 * place several objects at once (lib/pageNavigator.ts), so a row of buttons is
 * placed by the same rule as one.
 */
export function placeFor(
  size: { width: number; height: number },
  options?: InsertRectOptions,
): (LayoutRect & { sheetIndex: number }) | null {
  const view = currentInsertView();
  if (!view) return null;
  return { sheetIndex: view.sheetIndex, ...defaultInsertRect(view, size, options) };
}

/** Tell the user an insert was refused, with the owner's reason (one dialog). */
export async function insertRefusal(what: string, err: unknown): Promise<void> {
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

/**
 * The button kinds Buttons v inserts one at a time: a blank button (a script
 * button, the old Insert > Button) and Power BI's Back and Clear all slicers.
 * The Page Navigator is a ROW of buttons (lib/pageNavigator.ts).
 */
export type CanvasButtonKind = "blank" | "back" | "clearSlicers";

/** What an insert may say beyond its kind; each field belongs to one kind. */
export interface CanvasInsertOptions {
  /** chart: the type the dialog opens with (a ChartMark id: "bar", "card"...). */
  mark?: string;
  /** chart: that type's options (`{ stackMode: "stacked" }`...). */
  markOptions?: Record<string, unknown>;
  /** pivot: a create preset (the Table visual's, @api/pivotPresets). */
  preset?: PivotCreatePreset;
  /** shape: the catalog id (default {@link DEFAULT_SHAPE_ID}). */
  shapeId?: string;
  /** button: which button (default "blank"). */
  button?: CanvasButtonKind;
}

/** The caption, action and size of each single-button kind. */
const BUTTON_KINDS: Readonly<
  Record<CanvasButtonKind, { label: string; action?: ButtonAction; size: { width: number; height: number } }>
> = {
  blank: { label: "Button", size: INSERT_SIZES.button },
  back: { label: BUTTON_ACTION_LABELS.back, action: { kind: "back" }, size: INSERT_SIZES.button },
  clearSlicers: {
    label: BUTTON_ACTION_LABELS.clearSlicers,
    action: { kind: "clearSlicers" },
    size: INSERT_SIZES.wideButton,
  },
};

/** Insert one object on the active canvas. Resolves when it is placed (or refused). */
export async function insertOnCanvas(kind: CanvasInsertKind, options: CanvasInsertOptions = {}): Promise<void> {
  switch (kind) {
    case "chart": {
      const place = placeFor(chartInsertSize(options.mark));
      if (!place) return;
      // The chart dialog takes its data range WITH its sheet (a canvas has no
      // cells), and must not guess a range from the canvas's empty selection.
      // A tile's preset rides along -- a copy, so the dialog can never edit
      // the catalogue's own object.
      showDialog("chart:createDialog", {
        placement: place,
        suppressAutoRange: true,
        ...(options.mark ? { initialMark: options.mark } : {}),
        ...(options.markOptions ? { initialMarkOptions: { ...options.markOptions } } : {}),
      });
      return;
    }
    case "pivot": {
      // A canvas pivot is a REAL pivot, written into the canvas's hidden grid
      // and shown inside this box (its frame); the Pivot extension's create
      // dialog owns everything else -- the source (a range with its sheet, a
      // table or a data model), the anchor, the preset's layout, and what
      // happens after.
      const place = placeFor(INSERT_SIZES.pivot, { fitPage: true });
      if (!place) return;
      showDialog("pivot:createDialog", { placement: place, ...(options.preset ? { preset: options.preset } : {}) });
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
      const place = placeFor(INSERT_SIZES.floatingGrid);
      if (!place) return;
      try {
        await requireFloatingRangeProvider().create({ x: place.x, y: place.y, rows: 5, cols: 3 });
      } catch (err) {
        await insertRefusal("a floating grid", err);
      }
      return;
    }
    case "textBox": {
      // A text box is sized for words, not by the shape catalog.
      const place = placeFor(INSERT_SIZES.textBox);
      if (!place) return;
      try {
        await requireControlsProvider().createShape({
          sheetIndex: place.sheetIndex,
          shapeType: "textBox",
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
          text: "",
        });
      } catch (err) {
        await insertRefusal("a text box", err);
      }
      return;
    }
    case "shape": {
      const shapeId = options.shapeId ?? DEFAULT_SHAPE_ID;
      try {
        const provider = requireControlsProvider();
        // The catalog's own size places it, and the request names NO size, so
        // the provider applies that same default (CONTRACT 4.3): one number,
        // one owner.
        const entry = provider.listShapeCatalog().find((e) => e.id === shapeId);
        if (!entry) throw new Error(`there is no shape "${shapeId}" in the shape catalog`);
        const place = placeFor({ width: entry.defaultWidth, height: entry.defaultHeight });
        if (!place) return;
        await provider.createShape({
          sheetIndex: place.sheetIndex,
          shapeType: shapeId,
          x: place.x,
          y: place.y,
          text: "",
        });
      } catch (err) {
        await insertRefusal("a shape", err);
      }
      return;
    }
    case "button": {
      const spec = BUTTON_KINDS[options.button ?? "blank"];
      const place = placeFor(spec.size);
      if (!place) return;
      try {
        await requireButtonControlProvider().createButton({
          sheetIndex: place.sheetIndex,
          label: spec.label,
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
          ...(spec.action ? { action: spec.action } : {}),
        });
      } catch (err) {
        await insertRefusal("a button", err);
      }
      return;
    }
    case "picture": {
      let media;
      try {
        media = await importImageViaPicker({ title: "Insert Picture" });
      } catch (err) {
        await insertRefusal("the picture", err);
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
        await insertRefusal("the picture", err);
      }
      return;
    }
  }
}
