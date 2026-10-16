//! FILENAME: app/extensions/Pivot/lib/pivotObjectFormat.ts
// PURPOSE: The canvas pivot BOX's half of the visual-container seams (WP-C
//          D-FORMAT): what its container IS (the frame's `container`), what it
//          looks like by default, how it resolves with WP-D's bindings laid
//          over it, the `@api/objectFormat` provider the object pane's Format
//          tab writes through, and the pivot kind's ONE bindable-properties
//          registration (WP-D registers no pivot; WP-C does, 2.7 item 4).
// CONTEXT: ONE SPELLING PER FACT. Everything of the box's container lives in
//          `canvasFrame.container` (Rust `CanvasFrame.container`, persisted
//          with the definition); the pivot spells no title elsewhere, so the
//          title text is a FREE display string there too. The frame STORE
//          (pivotVisualRegions.ts) owns the frame -- and so the container: a
//          commit goes through its `commitFrameContainer`, which saves the
//          whole frame through `update_pivot_properties { canvasFrame }`
//          (formatting, not geometry: Lock Objects lets it through; the
//          backend records ONE "Format pivot" step, which commitObjectFormat's
//          transaction labels) and keeps the new container on every later
//          drag. An unchanged container is never sent (BUG-0477: that door
//          dirties the document even on a no-op).
//
//          WHO PAINTS WHAT. Core paints everything of the container around
//          the box -- shadow, background, the TITLE / subtitle / divider bands
//          and the border (`paint` all "core"); the box lays out, paints and
//          hit-tests its cells inside `visualContentRectFor(...)`, clipped by
//          `withContainerContentClip`. The cells keep their own fills, so the
//          container's background shows only around and past them (review
//          R1-8: one owner of the box background).
//
//          NO STORE IMPORT. The frame store imports this module (its region
//          publisher resolves the container), so everything the provider needs
//          from the store or the pivot API is INJECTED into
//          `createPivotObjectFormatProvider` by the extension's activate() --
//          the chartObjectFormat.ts pattern -- and a test hands it doubles.

import type { GridRegion } from "@api/gridOverlays";
import type {
  ContainerCapabilities,
  DataFormatField,
  FormatCardContribution,
  ObjectFormatProvider,
} from "@api/objectFormat";
import { containerBindableDescriptors, onContainerBindingsChanged, resolveContainerForObject } from "@api/objectFormat";
import {
  BASE_CONTAINER_DEFAULTS,
  applyVisualContainerPatch,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import { registerBindableProperties, type ObjectBindingRef } from "@api/objectBindings";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a pivot's container fields bind under. */
export const CONTAINER_BINDING_KIND = "pivot";

/**
 * Field -> the WP-D catalog pointer a binding of that field lives at, or null
 * (never bindable). Every container field of a pivot box is bindable under
 * `/canvasFrame/container` except `lockAspect` (never bindable, all kinds).
 */
export const CONTAINER_BINDING_PATHS: Readonly<Record<ContainerFieldId, string | null>> = {
  "padding.top": "/canvasFrame/container/padding/top",
  "padding.right": "/canvasFrame/container/padding/right",
  "padding.bottom": "/canvasFrame/container/padding/bottom",
  "padding.left": "/canvasFrame/container/padding/left",
  lockAspect: null,
  "title.show": "/canvasFrame/container/title/show",
  "title.text": "/canvasFrame/container/title/text",
  "title.headingLevel": "/canvasFrame/container/title/headingLevel",
  "title.fontFamily": "/canvasFrame/container/title/fontFamily",
  "title.fontSize": "/canvasFrame/container/title/fontSize",
  "title.bold": "/canvasFrame/container/title/bold",
  "title.italic": "/canvasFrame/container/title/italic",
  "title.underline": "/canvasFrame/container/title/underline",
  "title.color": "/canvasFrame/container/title/color",
  "title.background": "/canvasFrame/container/title/background",
  "title.align": "/canvasFrame/container/title/align",
  "title.wrap": "/canvasFrame/container/title/wrap",
  "subtitle.show": "/canvasFrame/container/subtitle/show",
  "subtitle.text": "/canvasFrame/container/subtitle/text",
  "subtitle.fontFamily": "/canvasFrame/container/subtitle/fontFamily",
  "subtitle.fontSize": "/canvasFrame/container/subtitle/fontSize",
  "subtitle.bold": "/canvasFrame/container/subtitle/bold",
  "subtitle.italic": "/canvasFrame/container/subtitle/italic",
  "subtitle.underline": "/canvasFrame/container/subtitle/underline",
  "subtitle.color": "/canvasFrame/container/subtitle/color",
  "subtitle.background": "/canvasFrame/container/subtitle/background",
  "subtitle.align": "/canvasFrame/container/subtitle/align",
  "subtitle.wrap": "/canvasFrame/container/subtitle/wrap",
  "divider.show": "/canvasFrame/container/divider/show",
  "divider.color": "/canvasFrame/container/divider/color",
  "divider.style": "/canvasFrame/container/divider/style",
  "divider.width": "/canvasFrame/container/divider/width",
  "divider.ignorePadding": "/canvasFrame/container/divider/ignorePadding",
  "spacing.custom": "/canvasFrame/container/spacing/custom",
  "spacing.belowTitle": "/canvasFrame/container/spacing/belowTitle",
  "spacing.belowSubtitle": "/canvasFrame/container/spacing/belowSubtitle",
  "spacing.belowDivider": "/canvasFrame/container/spacing/belowDivider",
  "background.show": "/canvasFrame/container/background/show",
  "background.color": "/canvasFrame/container/background/color",
  "background.transparency": "/canvasFrame/container/background/transparency",
  "border.show": "/canvasFrame/container/border/show",
  "border.color": "/canvasFrame/container/border/color",
  "border.width": "/canvasFrame/container/border/width",
  "border.radius": "/canvasFrame/container/border/radius",
  "shadow.show": "/canvasFrame/container/shadow/show",
  "shadow.color": "/canvasFrame/container/shadow/color",
  "shadow.transparency": "/canvasFrame/container/shadow/transparency",
  "shadow.offset": "/canvasFrame/container/shadow/offset",
  "shadow.position": "/canvasFrame/container/shadow/position",
  "shadow.blur": "/canvasFrame/container/shadow/blur",
  "shadow.distance": "/canvasFrame/container/shadow/distance",
};

/** The catalog pointer of a container field of a pivot box, or null (answered FROM the table). */
export function pivotContainerBindingPath(field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[field] ?? null;
}

/** The WP-D binding ref of a pivot (its id, the same one scripts name it by). */
export function pivotBindingRef(pivotId: string): ObjectBindingRef {
  return { kind: "pivot", id: pivotId };
}

// ============================================================================
// Read / defaults / resolve (pure)
// ============================================================================

/** The box outline a canvas pivot has always had (was `BOX_BORDER`, pivotVisualRenderer.ts). */
export const PIVOT_BOX_BORDER_COLOR = "#c8c8c8";

/** The pivot id a `pivot-visual` region carries, or null (no import of the region store here). */
export function pivotIdOfFormatRegion(region: GridRegion): string | null {
  const id = (region.data as { pivotId?: unknown } | undefined)?.pivotId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The box's DEFAULTS: today's look (an opaque white box with a 1 px #c8c8c8
 * outline, square corners) on Power BI's base -- no title until the user
 * turns it on, and then the pivot's NAME unless they type their own text.
 * Core paints all of it (the box gets a Core-painted title band).
 */
export function pivotContainerDefaults(name?: string | null): ResolvedVisualContainer {
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: { ...b.title, text: typeof name === "string" ? name : "" },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    spacing: { ...b.spacing },
    background: { show: true, color: "#ffffff", alpha: 1, gradient: null },
    border: { show: true, color: PIVOT_BOX_BORDER_COLOR, width: 1, radius: 0 },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "core", shadow: "core" },
  };
}

/**
 * The box's RESOLVED container: bound > stored > defaults (WP-D's bindings
 * laid over the frame's stored container). What the region carries and Core
 * paints.
 */
export function resolvePivotContainer(
  pivotId: string,
  stored: VisualContainerFormat | undefined,
  name?: string | null,
): ResolvedVisualContainer {
  return resolveContainerForObject(
    pivotBindingRef(pivotId),
    stored,
    pivotContainerDefaults(name),
    pivotContainerBindingPath,
  );
}

/** What the Format pane offers for a pivot box: everything. */
export function pivotContainerCapabilities(): ContainerCapabilities {
  return {
    padding: true,
    lockAspect: true,
    title: true,
    titleText: "free",
    subtitle: true,
    divider: true,
    background: true,
    backgroundTransparency: true,
    gradient: true,
    border: true,
    borderRadius: true,
    shadow: true,
    dataFormat: true,
  };
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether two stored containers say the same thing (absent == empty). */
export function samePivotContainer(a: VisualContainerFormat | undefined, b: VisualContainerFormat | undefined): boolean {
  const norm = (c: VisualContainerFormat | undefined) => applyVisualContainerPatch(c, {});
  return stableJson(norm(a) ?? null) === stableJson(norm(b) ?? null);
}

// ============================================================================
// The pivot kind's bindable properties (WP-D registry) + the re-publish
// ============================================================================

/**
 * Register the pivot kind with WP-D's registry: ONE registration (WP-D
 * registers none for pivots). A box's region -> its pivot; a script's pivot
 * instance id IS the pivot id. Its properties are the box's container fields
 * (`containerBindableDescriptors`, from the provider's `bindingPath`); a pivot
 * named without its box (a script instance) offers none here -- the catalog
 * still accepts the rows on a direct write. Returns the unregister.
 */
export function registerPivotBindableProperties(regionType: string): () => void {
  return registerBindableProperties({
    kind: "pivot",
    regionTypes: [regionType],
    instanceTypes: ["pivot"],
    refOf: (region) => {
      const id = pivotIdOfFormatRegion(region);
      return id === null ? null : pivotBindingRef(id);
    },
    refForInstance: (instanceId) =>
      typeof instanceId === "string" && /^\d+$/.test(instanceId) ? pivotBindingRef(instanceId) : null,
    properties: (_ref, region) => (region ? containerBindableDescriptors(region) : []),
  });
}

/**
 * Re-publish the boxes when a binding of a pivot's container changed: the
 * region carries the RESOLVED container, so the frame store re-publishes
 * (`republish`) and one overlay redraw follows -- never GRID_REFRESH (WP-D's
 * feedback-loop rule). Returns the unsubscribe.
 */
export function installPivotContainerResync(republish: () => void, redraw: () => void): () => void {
  return onContainerBindingsChanged("pivot", () => {
    republish();
    redraw();
  });
}

// ============================================================================
// The provider
// ============================================================================

/** What the provider needs from the frame store and the pivot API (injected by activate()). */
export interface PivotObjectFormatDeps {
  /** The region type the box publishes (`pivot-visual`). */
  regionType: string;
  /** The STORED container of the box's current frame; null when the pivot has no frame (not a box). */
  getStoredContainer(pivotId: string): VisualContainerFormat | undefined | null;
  /** Persist the frame with this container (undefined = none); rejects with the backend's sentence. */
  commitContainer(pivotId: string, container: VisualContainerFormat | undefined): Promise<void>;
  /** Show a container WITHOUT persisting it; `null` ends the preview. */
  previewContainer(pivotId: string, container: VisualContainerFormat | undefined | null): void;
  /** The pivot's value fields as Data format rows. */
  dataFormats?(pivotId: string): Promise<DataFormatField[]>;
  /** Set (null: clear) one value field's number format override, as ONE undo step. */
  setDataFormat?(pivotId: string, valueFieldIndex: number, format: string | null): Promise<void>;
  /** The pivot's own Format cards (Style, Layout). */
  visualCards?: readonly FormatCardContribution[];
}

/** Build the `@api/objectFormat` provider registered for the box's region type. */
export function createPivotObjectFormatProvider(deps: PivotObjectFormatDeps): ObjectFormatProvider {
  /** The box a preview of THIS provider is showing. */
  let previewing: string | null = null;

  const endPreview = (): void => {
    if (previewing === null) return;
    const id = previewing;
    previewing = null;
    deps.previewContainer(id, null);
  };

  const storedOf = (region: GridRegion): { id: string; stored: VisualContainerFormat | undefined } | null => {
    const id = pivotIdOfFormatRegion(region);
    if (id === null) return null;
    const stored = deps.getStoredContainer(id);
    return stored === null ? null : { id, stored };
  };

  return {
    types: [deps.regionType],

    read(region) {
      const s = storedOf(region);
      return s?.stored ? (JSON.parse(JSON.stringify(s.stored)) as VisualContainerFormat) : {};
    },

    defaults(region) {
      const name = (region.data as { name?: unknown } | undefined)?.name;
      return pivotContainerDefaults(typeof name === "string" ? name : "");
    },

    capabilities() {
      return pivotContainerCapabilities();
    },

    preview(region, patch: VisualContainerPatch) {
      const s = storedOf(region);
      if (!s) return;
      if (previewing !== null && previewing !== s.id) endPreview();
      previewing = s.id;
      deps.previewContainer(s.id, applyVisualContainerPatch(s.stored, patch));
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const s = storedOf(region);
      if (!s) throw new Error("The PivotTable box no longer exists.");
      const next = applyVisualContainerPatch(s.stored, patch);
      if (samePivotContainer(s.stored, next)) return;
      await deps.commitContainer(s.id, next);
    },

    bindingPath(region, field) {
      // Every capability is on for a box, so the table answers alone.
      return pivotIdOfFormatRegion(region) === null ? null : pivotContainerBindingPath(field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const s = storedOf(region);
      return s ? pivotBindingRef(s.id) : null;
    },

    async dataFormats(region) {
      const id = pivotIdOfFormatRegion(region);
      if (id === null || !deps.dataFormats) return [];
      return deps.dataFormats(id);
    },

    async setDataFormat(region, key, format) {
      const id = pivotIdOfFormatRegion(region);
      if (id === null) throw new Error("The PivotTable no longer exists.");
      if (!deps.setDataFormat) throw new Error("This PivotTable's number formats cannot be set from here.");
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) throw new Error(`"${key}" names no value field.`);
      await deps.setDataFormat(id, index, format);
    },

    visualCards() {
      return deps.visualCards ?? [];
    },
  };
}
