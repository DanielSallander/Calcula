//! FILENAME: app/extensions/TimelineSlicer/lib/timelineObjectFormat.ts
// PURPOSE: The timeline's half of the visual-container seams (WP-C D-FORMAT):
//          what a timeline's container IS (read from its one-spelling fields),
//          what it looks like by default (its style preset), how it resolves
//          with WP-D's bindings laid over it, WHERE its content sits (the ONE
//          content shape the painter, the zone table, the range drag and the
//          keyboard all lay out in), and the `@api/objectFormat` provider the
//          object pane's Format tab writes through.
// CONTEXT: The Slicer's twin (Slicer/lib/slicerObjectFormat.ts). ONE SPELLING
//          PER FACT: the title text is `headerText` (null = the timeline's
//          name) and the title's visibility `showHeader`; every other leaf
//          lives in `container` (Rust `TimelineSlicer.container`). The mapping
//          is the shared `_shared/lib/headerTitleContainer.ts`, and a commit is
//          ONE `update_timeline_slicer { headerText | showHeader | container }`.
//
//          WHO PAINTS WHAT. Core paints the shadow, the background and the
//          border; the timeline paints its header bar as the title
//          (`paint.title: "family"`) from the RESOLVED title, and its height
//          follows the title font (`timelineHeaderHeight`). Subtitle and
//          divider are not offered.
//
//          PAINT == HIT. `timelineContentShape` is the content box (Core's
//          layout cache, `visualContentRectFor`, keyed by the region id the
//          store publishes) as the zone table's `TimelineShape`, with the
//          offset of that box inside the object; lib/timelineView.ts builds the
//          zone input from it and the renderer paints from the same layout.
//
//          NO STORE IMPORT. The store imports this module (its region
//          publisher resolves the container); the provider takes what it needs
//          by injection.

import type { GridRegion } from "@api/gridOverlays";
import type { ContainerCapabilities, FormatCardContribution, ObjectFormatProvider } from "@api/objectFormat";
import { resolveContainerForObject } from "@api/objectFormat";
import {
  BASE_CONTAINER_DEFAULTS,
  lineHeightFor,
  type ContainerFieldId,
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
import { timelineBindingRef } from "./timelineBindings";
import { timelineStyleColors } from "./timelineStyles";
import { TIMELINE_HEADER_HEIGHT, type TimelineShape } from "./timelineZones";
import type { TimelineSlicer, UpdateTimelineParams } from "./timelineSlicerTypes";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a timeline's container fields bind under. */
export const CONTAINER_BINDING_KIND = "timelineSlicer";

/**
 * Field -> the WP-D catalog pointer a binding of that field lives at, or null
 * (never bindable). The title text and visibility bind at the timeline's own
 * Family rows (`/headerText`, `/showHeader`); every other leaf under
 * `/container`. Null: `lockAspect` (all kinds), and what a timeline does not
 * offer -- the subtitle, the divider and the spacing below them.
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

/** The catalog pointer of a container field of a timeline, or null (answered FROM the table). */
export function timelineContainerBindingPath(field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[field] ?? null;
}

// ============================================================================
// Identity
// ============================================================================

/** The `GridRegion.type` a timeline is published as. */
export const TIMELINE_FORMAT_REGION_TYPE = "timeline-slicer";

/** The region id the store publishes a timeline under (Core's layout cache is keyed by it). */
export function timelineRegionId(timelineId: string): string {
  return `timeline-slicer-${timelineId}`;
}

/** The timeline id a timeline region carries, or null. */
export function timelineIdOfFormatRegion(region: GridRegion): string | null {
  const id = (region.data as { timelineId?: unknown } | undefined)?.timelineId;
  return typeof id === "string" && id !== "" ? id : null;
}

// ============================================================================
// Read / defaults / resolve (pure)
// ============================================================================

/** The font a timeline's header has always been painted in. */
export const TIMELINE_HEADER_FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
/** The header text's default size. */
export const TIMELINE_HEADER_FONT_SIZE = 11;
/** The corner radius a timeline has always had. */
export const TIMELINE_DEFAULT_RADIUS = 3;

/** The timeline's STORED container as the Format tab shows it (title text / show from headerText / showHeader). */
export function readTimelineContainer(
  tl: Pick<TimelineSlicer, "headerText" | "showHeader" | "container">,
): VisualContainerFormat {
  return readHeaderedContainer(tl);
}

/**
 * The timeline's DEFAULTS: today's look from its style preset -- the preset's
 * background, a 1 px border in its border colour with 3 px corners, and the
 * header bar as the title (the preset's header colours, 11 pt bold,
 * left-aligned, the timeline's name).
 */
export function timelineContainerDefaults(tl: Pick<TimelineSlicer, "name" | "stylePreset">): ResolvedVisualContainer {
  const colors = timelineStyleColors(tl.stylePreset);
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: {
      ...b.title,
      show: true,
      text: tl.name ?? "",
      fontFamily: TIMELINE_HEADER_FONT_FAMILY,
      fontSize: TIMELINE_HEADER_FONT_SIZE,
      bold: true,
      color: colors.headerFg,
      background: colors.headerBg,
      align: "left",
      wrap: false,
    },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    spacing: { belowTitle: 0, belowSubtitle: 0, belowDivider: 0 },
    background: { show: true, color: colors.bg, alpha: 1, gradient: null },
    border: { show: true, color: colors.border, width: 1, radius: TIMELINE_DEFAULT_RADIUS },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "family", shadow: "core" },
  };
}

/** What the Format pane offers for a timeline. */
export function timelineContainerCapabilities(): ContainerCapabilities {
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

/** Patches shown WITHOUT being written (the Format tab's live preview), per timeline id. */
const previews = new Map<string, VisualContainerPatch>();

/** The timeline as a preview in progress shows it (the very record when there is none). */
export function previewedTimeline<T extends TimelineSlicer>(tl: T): T {
  const patch = previews.get(tl.id);
  return patch ? previewHeaderedRecord(tl, patch) : tl;
}

/** Test hook: forget every preview. */
export function resetTimelineFormatPreviews(): void {
  previews.clear();
  memo.clear();
}

/** The last resolved container per timeline (the zone answer asks on every pointer move). */
const memo = new ResolvedContainerMemo<ResolvedVisualContainer>();

/** The timeline's RESOLVED container: bound > stored > defaults (a preview over the stored literal). */
export function resolveTimelineContainer(tl: TimelineSlicer): ResolvedVisualContainer {
  const ref = timelineBindingRef(tl.id);
  const key = headeredResolveKey(tl, previews.get(tl.id), ref);
  return memo.get(tl.id, key, () => {
    const shown = previewedTimeline(tl);
    return resolveContainerForObject(ref, readTimelineContainer(shown), timelineContainerDefaults(shown), timelineContainerBindingPath);
  });
}

// ============================================================================
// The content shape (paint == hit)
// ============================================================================

/** The header bar's height for a resolved title: 0 when hidden, else the font's line plus 12 px, at least 28. */
export function timelineHeaderHeight(c: ResolvedVisualContainer): number {
  if (!c.title.show) return 0;
  return Math.max(TIMELINE_HEADER_HEIGHT, lineHeightFor(c.title.fontSize) + 12);
}

/** Where a timeline's content sits and the shape its zone table lays out. */
export interface TimelineContentShape {
  /** The content box's left / top, from the timeline's OUTER top-left. */
  offsetX: number;
  offsetY: number;
  /** The zone table's shape: the CONTENT size, the header as SHOWN (the resolved title). */
  shape: TimelineShape;
  /** The resolved container the shape was measured with. */
  container: ResolvedVisualContainer;
}

/**
 * THE content shape of a timeline at its size: Core's content rect for its
 * region (the border inset, then the padding) and the header as the resolved
 * title shows it. Everything the timeline paints and hit-tests is laid out in
 * it.
 */
export function timelineContentShape(tl: TimelineSlicer): TimelineContentShape {
  const container = resolveTimelineContainer(tl);
  const rect = visualContentRectFor(
    timelineRegionId(tl.id),
    { x: 0, y: 0, width: tl.width, height: tl.height },
    container,
  );
  const headerHeight = timelineHeaderHeight(container);
  return {
    offsetX: rect.x,
    offsetY: rect.y,
    container,
    shape: {
      width: rect.width,
      height: rect.height,
      showHeader: container.title.show,
      showLevelSelector: tl.showLevelSelector,
      showScrollbar: tl.showScrollbar,
      level: tl.level,
      headerHeight: headerHeight > 0 ? headerHeight : TIMELINE_HEADER_HEIGHT,
      headerGap: container.title.show ? container.spacing.belowTitle : 0,
    },
  };
}

// ============================================================================
// The provider
// ============================================================================

/** What the provider needs from the store (injected by the extension's activate()). */
export interface TimelineObjectFormatDeps {
  getTimeline(timelineId: string): TimelineSlicer | undefined;
  /** ONE `update_timeline_slicer`; rejects with the backend's sentence. */
  update(timelineId: string, params: UpdateTimelineParams): Promise<void>;
  /** Re-publish the timeline regions (the region carries the resolved container). */
  resync(): void;
  /** The timeline's own Format cards (Style). */
  visualCards?: readonly FormatCardContribution[];
}

/** The update a container patch makes to a timeline, or null when it changes nothing. */
export function timelineUpdateFor(tl: TimelineSlicer, patch: VisualContainerPatch): UpdateTimelineParams | null {
  return headeredUpdateFor(tl, patch) as UpdateTimelineParams | null;
}

/** Build the `@api/objectFormat` provider registered for the timeline region type. */
export function createTimelineObjectFormatProvider(deps: TimelineObjectFormatDeps): ObjectFormatProvider {
  const timelineOf = (region: GridRegion): TimelineSlicer | null => {
    const id = timelineIdOfFormatRegion(region);
    return id === null ? null : deps.getTimeline(id) ?? null;
  };

  const endPreview = (): void => {
    if (previews.size === 0) return;
    previews.clear();
    deps.resync();
  };

  return {
    types: [TIMELINE_FORMAT_REGION_TYPE],

    read(region) {
      const tl = timelineOf(region);
      return tl ? readTimelineContainer(tl) : {};
    },

    defaults(region) {
      const tl = timelineOf(region);
      return timelineContainerDefaults(tl ?? { name: "", stylePreset: "" });
    },

    capabilities() {
      return timelineContainerCapabilities();
    },

    preview(region, patch) {
      const tl = timelineOf(region);
      if (!tl) return;
      previews.clear();
      previews.set(tl.id, patch);
      deps.resync();
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const tl = timelineOf(region);
      if (!tl) throw new Error("The timeline no longer exists.");
      const params = timelineUpdateFor(tl, patch);
      if (!params) return;
      await deps.update(tl.id, params);
    },

    bindingPath(region, field) {
      return timelineIdOfFormatRegion(region) === null ? null : timelineContainerBindingPath(field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const tl = timelineOf(region);
      return tl ? timelineBindingRef(tl.id) : null;
    },

    visualCards() {
      return deps.visualCards ?? [];
    },
  };
}
