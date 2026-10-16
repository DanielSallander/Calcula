//! FILENAME: app/extensions/Slicer/lib/slicerObjectFormat.ts
// PURPOSE: The slicer's half of the visual-container seams (WP-C D-FORMAT):
//          what a slicer's container IS (read from its one-spelling fields),
//          what it looks like by default (its style preset), how it resolves
//          with WP-D's bindings laid over it, WHERE its content sits (the ONE
//          content box the painter, the hit test, the keyboard and the item
//          drag all lay out in), and the `@api/objectFormat` provider the
//          object pane's Format tab writes through.
// CONTEXT: ONE SPELLING PER FACT. The title text is `headerText` (null = the
//          slicer's name) and the title's visibility is `showHeader`; every
//          other leaf lives in `container` (Rust `Slicer.container`). The
//          mapping is the shared `_shared/lib/headerTitleContainer.ts` (the
//          timeline's too), and a commit is ONE `update_slicer { headerText |
//          showHeader | container }` -- one backend write, one undo entry that
//          joins commitObjectFormat's transaction.
//
//          WHO PAINTS WHAT. Core paints the shadow, the background and the
//          border around the slicer (`paint.background/border/shadow: "core"`);
//          the slicer paints its own HEADER bar as the title (`paint.title:
//          "family"`, rendering/slicerRenderer.ts) from the RESOLVED title --
//          font, size, bold / italic / underline, colour, background and
//          alignment -- and Core reserves no band for it. The header's height
//          follows the title font (`slicerHeaderHeight`). Subtitle and divider
//          are not offered: a slicer's header is one line (capabilities).
//
//          PAINT == HIT. `slicerContentBox` is the content rect (Core's layout
//          cache, `visualContentRectFor`, keyed by the region id the store
//          publishes) plus the header's height; the renderer's one layout
//          (`slicerFrameOf`) is built on it, so the painter and every hit test
//          read the same numbers, and Core answers the padding band as FRAME.
//
//          NO STORE IMPORT. The store imports this module (its region
//          publisher resolves the container), so the provider takes what it
//          needs from the store by injection (`createSlicerObjectFormatProvider`)
//          -- the chart and pivot pattern -- and a test can hand it doubles.

import type { GridRegion } from "@api/gridOverlays";
import type { ContainerCapabilities, FormatCardContribution, ObjectFormatProvider } from "@api/objectFormat";
import { resolveContainerForObject } from "@api/objectFormat";
import {
  BASE_CONTAINER_DEFAULTS,
  lineHeightFor,
  type ContainerFieldId,
  type ContainerRect,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import { visualContentRectFor } from "@api/visualContainerPaint";
import type { ObjectBindingRef } from "@api/objectBindings";
import {
  ResolvedContainerMemo,
  headeredResolveKey,
  headeredUpdateFor,
  previewHeaderedRecord,
  readHeaderedContainer,
} from "../../_shared/lib/headerTitleContainer";
import { slicerBindingRef } from "./slicerBindings";
import { slicerStyleColors } from "./slicerStyles";
import type { Slicer, UpdateSlicerParams } from "./slicerTypes";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a slicer's container fields bind under. */
export const CONTAINER_BINDING_KIND = "slicer";

/**
 * Field -> the WP-D catalog pointer a binding of that field lives at, or null
 * (never bindable). The title text and visibility bind at the slicer's own
 * Family rows (`/headerText`, `/showHeader`); every other leaf under
 * `/container`. Null: `lockAspect` (all kinds), and what a slicer does not
 * offer -- the subtitle, the divider and the spacing below them (a slicer's
 * header is one line).
 */
export const CONTAINER_BINDING_PATHS: Readonly<Record<ContainerFieldId, string | null>> = {
  "padding.top": "/container/padding/top",
  "padding.right": "/container/padding/right",
  "padding.bottom": "/container/padding/bottom",
  "padding.left": "/container/padding/left",
  lockAspect: null,
  "title.show": "/showHeader",
  "title.text": "/headerText",
  "title.headingLevel": "/container/title/headingLevel",
  "title.fontFamily": "/container/title/fontFamily",
  "title.fontSize": "/container/title/fontSize",
  "title.bold": "/container/title/bold",
  "title.italic": "/container/title/italic",
  "title.underline": "/container/title/underline",
  "title.color": "/container/title/color",
  "title.background": "/container/title/background",
  "title.align": "/container/title/align",
  "title.wrap": null, // one-line header: wrap is not offered (titleWrap false)
  "subtitle.show": null,
  "subtitle.text": null,
  "subtitle.fontFamily": null,
  "subtitle.fontSize": null,
  "subtitle.bold": null,
  "subtitle.italic": null,
  "subtitle.underline": null,
  "subtitle.color": null,
  "subtitle.background": null,
  "subtitle.align": null,
  "subtitle.wrap": null,
  "divider.show": null,
  "divider.color": null,
  "divider.style": null,
  "divider.width": null,
  "divider.ignorePadding": null,
  "spacing.custom": "/container/spacing/custom",
  "spacing.belowTitle": "/container/spacing/belowTitle",
  "spacing.belowSubtitle": null,
  "spacing.belowDivider": null,
  "background.show": "/container/background/show",
  "background.color": "/container/background/color",
  "background.transparency": "/container/background/transparency",
  "border.show": "/container/border/show",
  "border.color": "/container/border/color",
  "border.width": "/container/border/width",
  "border.radius": "/container/border/radius",
  "shadow.show": "/container/shadow/show",
  "shadow.color": "/container/shadow/color",
  "shadow.transparency": "/container/shadow/transparency",
  "shadow.offset": "/container/shadow/offset",
  "shadow.position": "/container/shadow/position",
  "shadow.blur": "/container/shadow/blur",
  "shadow.distance": "/container/shadow/distance",
};

/** The catalog pointer of a container field of a slicer, or null (answered FROM the table). */
export function slicerContainerBindingPath(field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[field] ?? null;
}

// ============================================================================
// Identity
// ============================================================================

/** The `GridRegion.type` a slicer is published as. */
export const SLICER_FORMAT_REGION_TYPE = "slicer";

/** The region id the store publishes a slicer under (Core's layout cache is keyed by it). */
export function slicerRegionId(slicerId: string): string {
  return `slicer-${slicerId}`;
}

/** The slicer id a slicer region carries, or null. */
export function slicerIdOfFormatRegion(region: GridRegion): string | null {
  const id = (region.data as { slicerId?: unknown } | undefined)?.slicerId;
  return typeof id === "string" && id !== "" ? id : null;
}

// ============================================================================
// Read / defaults / resolve (pure)
// ============================================================================

/** The font a slicer's header has always been painted in. */
export const SLICER_HEADER_FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
/** The header bar's height at the default 12 pt title (and its minimum). */
export const SLICER_MIN_HEADER_HEIGHT = 32;
/** The header text's default size (pt -> logical px, the grid's convention for overlays). */
export const SLICER_HEADER_FONT_SIZE = 12;
/** The corner radius a slicer has always had. */
export const SLICER_DEFAULT_RADIUS = 3;

/** The slicer's STORED container as the Format tab shows it (title text / show from headerText / showHeader). */
export function readSlicerContainer(slicer: Pick<Slicer, "headerText" | "showHeader" | "container">): VisualContainerFormat {
  return readHeaderedContainer(slicer);
}

/**
 * The slicer's DEFAULTS: today's look from its style preset -- the preset's
 * background, a 1 px border in the preset's border colour with 3 px corners,
 * and the header bar as the title (the preset's header colours, 12 pt bold,
 * left-aligned, the slicer's name). Core paints background, border and
 * shadow; the slicer paints its header.
 */
export function slicerContainerDefaults(slicer: Pick<Slicer, "name" | "stylePreset">): ResolvedVisualContainer {
  const colors = slicerStyleColors(slicer.stylePreset);
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: {
      ...b.title,
      show: true,
      text: slicer.name ?? "",
      fontFamily: SLICER_HEADER_FONT_FAMILY,
      fontSize: SLICER_HEADER_FONT_SIZE,
      bold: true,
      color: colors.headerFg,
      background: colors.headerBg,
      align: "left",
      wrap: false,
    },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    // The items sit flush under the header unless the user chooses custom spacing.
    spacing: { belowTitle: 0, belowSubtitle: 0, belowDivider: 0 },
    background: { show: true, color: colors.bg, alpha: 1, gradient: null },
    border: { show: true, color: colors.border, width: 1, radius: SLICER_DEFAULT_RADIUS },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "family", shadow: "core" },
  };
}

/** What the Format pane offers for a slicer. */
export function slicerContainerCapabilities(): ContainerCapabilities {
  return {
    padding: true,
    lockAspect: true,
    title: true,
    titleText: "free",
    subtitle: false,
    divider: false,
    // The header is one line: wrap changes nothing. spacing.belowTitle is the
    // gap between the header and the content, so spacing stays offered.
    titleWrap: false,
    background: true,
    backgroundTransparency: true,
    gradient: false,
    border: true,
    borderRadius: true,
    shadow: true,
    dataFormat: false,
  };
}

/** Patches shown WITHOUT being written (the Format tab's live preview), per slicer id. */
const previews = new Map<string, VisualContainerPatch>();

/** The slicer as a preview in progress shows it (the very record when there is none). */
export function previewedSlicer<T extends Slicer>(slicer: T): T {
  const patch = previews.get(slicer.id);
  return patch ? previewHeaderedRecord(slicer, patch) : slicer;
}

/** Test hook: forget every preview. */
export function resetSlicerFormatPreviews(): void {
  previews.clear();
  memo.clear();
}

/** The last resolved container per slicer (the zone answer asks on every pointer move). */
const memo = new ResolvedContainerMemo<ResolvedVisualContainer>();

/**
 * The slicer's RESOLVED container: bound > stored > defaults (WP-D's bindings
 * laid over the record, a preview in progress over the stored literal). What
 * the region carries, Core paints, and the slicer lays out and paints its
 * header from.
 */
export function resolveSlicerContainer(slicer: Slicer): ResolvedVisualContainer {
  const ref = slicerBindingRef(slicer.id);
  const key = headeredResolveKey(slicer, previews.get(slicer.id), ref);
  return memo.get(slicer.id, key, () => {
    const shown = previewedSlicer(slicer);
    return resolveContainerForObject(ref, readSlicerContainer(shown), slicerContainerDefaults(shown), slicerContainerBindingPath);
  });
}

// ============================================================================
// The content box (paint == hit)
// ============================================================================

/** The header bar's height for a resolved title: 0 when hidden, else the font's line plus 12 px, at least 32. */
export function slicerHeaderHeight(c: ResolvedVisualContainer): number {
  if (!c.title.show) return 0;
  return Math.max(SLICER_MIN_HEADER_HEIGHT, lineHeightFor(c.title.fontSize) + 12);
}

/** Where a slicer's content sits, measured from its OUTER top-left corner. */
export interface SlicerContentBox extends ContainerRect {
  /** The resolved container the box was measured with. */
  container: ResolvedVisualContainer;
  /** The header bar's height (0 when the header is hidden). */
  headerH: number;
  /** Where the items start below the content's top: the header plus the custom spacing below it. */
  itemsTop: number;
}

/**
 * THE content box of a slicer of size `width` x `height`: Core's content rect
 * for its region (`visualContentRectFor`: the painted layout when it matches,
 * else the pure one -- the border inset, then the padding) relative to the
 * slicer's top-left, plus the header band. Everything the slicer paints and
 * hit-tests is laid out in it.
 */
export function slicerContentBox(slicer: Slicer, width: number, height: number): SlicerContentBox {
  const container = resolveSlicerContainer(slicer);
  const rect = visualContentRectFor(slicerRegionId(slicer.id), { x: 0, y: 0, width, height }, container);
  const headerH = Math.min(slicerHeaderHeight(container), rect.height);
  const gap = headerH > 0 ? container.spacing.belowTitle : 0;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    container,
    headerH,
    itemsTop: Math.min(rect.height, headerH + gap),
  };
}

// ============================================================================
// The provider
// ============================================================================

/** What the provider needs from the store (injected by the extension's activate()). */
export interface SlicerObjectFormatDeps {
  getSlicer(slicerId: string): Slicer | undefined;
  /** ONE `update_slicer`; rejects with the backend's sentence. */
  update(slicerId: string, params: UpdateSlicerParams): Promise<void>;
  /** Re-publish the slicer regions (the region carries the resolved container). */
  resync(): void;
  /** The slicer's own Format cards (Buttons, Styles). */
  visualCards?: readonly FormatCardContribution[];
}

/** The update a container patch makes to a slicer, or null when it changes nothing. */
export function slicerUpdateFor(slicer: Slicer, patch: VisualContainerPatch): UpdateSlicerParams | null {
  return headeredUpdateFor(slicer, patch) as UpdateSlicerParams | null;
}

/** Build the `@api/objectFormat` provider registered for the slicer region type. */
export function createSlicerObjectFormatProvider(deps: SlicerObjectFormatDeps): ObjectFormatProvider {
  const slicerOf = (region: GridRegion): Slicer | null => {
    const id = slicerIdOfFormatRegion(region);
    return id === null ? null : deps.getSlicer(id) ?? null;
  };

  const endPreview = (): void => {
    if (previews.size === 0) return;
    previews.clear();
    deps.resync();
  };

  return {
    types: [SLICER_FORMAT_REGION_TYPE],

    read(region) {
      const s = slicerOf(region);
      return s ? readSlicerContainer(s) : {};
    },

    defaults(region) {
      const s = slicerOf(region);
      return slicerContainerDefaults(s ?? { name: "", stylePreset: "" });
    },

    capabilities() {
      return slicerContainerCapabilities();
    },

    preview(region, patch) {
      const s = slicerOf(region);
      if (!s) return;
      previews.clear();
      previews.set(s.id, patch);
      deps.resync();
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const s = slicerOf(region);
      if (!s) throw new Error("The slicer no longer exists.");
      const params = slicerUpdateFor(s, patch);
      if (!params) return;
      await deps.update(s.id, params);
    },

    bindingPath(region, field) {
      return slicerIdOfFormatRegion(region) === null ? null : slicerContainerBindingPath(field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const s = slicerOf(region);
      return s ? slicerBindingRef(s.id) : null;
    },

    visualCards() {
      return deps.visualCards ?? [];
    },
  };
}
