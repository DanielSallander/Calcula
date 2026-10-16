//! FILENAME: app/extensions/FloatingRange/lib/frObjectFormat.ts
// PURPOSE: The floating grid's half of the visual-container seams (WP-C
//          D-FORMAT): what its container IS, what it looks like by default, how
//          it resolves with WP-D's bindings laid over it (and with a Format-pane
//          preview), the container INSETS every piece of frame math reads, the
//          `@api/objectFormat` provider the object pane's Format tab writes
//          through, and the floatingRange kind's ONE bindable-properties
//          registration (WP-D registers none for floating ranges; WP-C does,
//          C-pane-format 2.7 item 4).
// CONTEXT: ONE SPELLING PER FACT. The title TEXT of a floating grid is its NAME
//          (its reference identity: formulas say `=Float2!A1`, and a reference
//          pick inserts that name), and the title's VISIBILITY is `showTitle`.
//          The provider synthesises both into the container it reads, and a
//          commit routes them back to their own doors: a new title text is a
//          RENAME (`renameFloatingRange`, validated against the shared sheet
//          namespace -- it repairs every referencing formula and ends the undo
//          history), the title toggle is `showTitle`, and every other leaf is
//          `update_floating_range { container }`. Neither identity leaf is ever
//          stored inside `container`, and neither is BINDABLE (ruling R10 / C
//          C1): a formula must not rename an object formulas name, and the title
//          bar is the grid's move handle (frMoveZones), which a formula toggling
//          it would make appear and vanish. Padding is not bindable either (2.7).
//
//          WHO PAINTS WHAT (`paint`). Core paints the shadow, the background and
//          the border around the grid; the grid paints its OWN title bar (title
//          "family": its colours, font and alignment come from the RESOLVED
//          title, so a bound title colour paints) and its frame inside the
//          content rect. The defaults keep today's look exactly: no container
//          background, no container border, the #f0f0f0 / #333333 title bar.
//
//          THE INSETS. A floating grid has no stored size: its frame DERIVES
//          from its rows, columns and chrome (frDimensions.ts). The container's
//          border (while shown) and its padding are part of that chrome, so the
//          frame GROWS by them, and every cell coordinate moves in by them.
//          `frInsets` answers them from `layoutVisualContainer` itself -- the
//          function Core's content rect comes from -- so Core's band and the
//          grid's own layout agree by construction.
//
//          NO STORE IMPORT. The store imports this module (its region publisher
//          resolves the container) and so does frDimensions, so everything the
//          provider needs from the store and the backend is INJECTED into
//          `createFrObjectFormatProvider` by the extension's activate() -- the
//          pivot / chart pattern -- and a test hands it doubles.

import type { GridRegion } from "@api/gridOverlays";
import type { ContainerCapabilities, ObjectFormatProvider } from "@api/objectFormat";
import {
  containerFieldLabel,
  OBJECT_FORMAT_BINDING_GROUP,
  onContainerBindingsChanged,
  resolveContainerForObject,
} from "@api/objectFormat";
import {
  BASE_CONTAINER_DEFAULTS,
  VISUAL_CONTAINER_FIELD_IDS,
  applyVisualContainerPatch,
  layoutVisualContainer,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import {
  registerBindableProperties,
  type BindablePropertyDescriptor,
  type ObjectBindingRef,
} from "@api/objectBindings";
import type { FloatingRangePatch } from "@api/floatingRanges";
import type { FloatingRangeEntry } from "./floatingRangeStore";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a floating grid's container fields bind under. */
export const CONTAINER_BINDING_KIND = "floatingRange";

/**
 * Field -> the WP-D catalog pointer a binding of that field lives at, or null
 * (never bindable). Null for: the identity leaves (`title.text` = the name,
 * `title.show` = the title bar, the move handle), `padding.*` and `lockAspect`
 * (2.7), and every field the grid's capabilities hide or its one-line title bar
 * cannot show (`title.wrap`, the subtitle, the divider, the spacing between
 * Core-painted title bands it has none of).
 */
export const CONTAINER_BINDING_PATHS: Readonly<Record<ContainerFieldId, string | null>> = {
  "padding.top": null,
  "padding.right": null,
  "padding.bottom": null,
  "padding.left": null,
  lockAspect: null,
  "title.show": null,
  "title.text": null,
  "title.headingLevel": "/container/title/headingLevel",
  "title.fontFamily": "/container/title/fontFamily",
  "title.fontSize": "/container/title/fontSize",
  "title.bold": "/container/title/bold",
  "title.italic": "/container/title/italic",
  "title.underline": "/container/title/underline",
  "title.color": "/container/title/color",
  "title.background": "/container/title/background",
  "title.align": "/container/title/align",
  "title.wrap": null,
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
  "spacing.custom": null,
  "spacing.belowTitle": null,
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

/** The catalog pointer of a container field of a floating grid, or null (answered FROM the table). */
export function frContainerBindingPath(field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[field] ?? null;
}

/** The WP-D binding ref of a floating grid (its EntityId, the id scripts name it by). */
export function frBindingRef(frId: string): ObjectBindingRef {
  return { kind: "floatingRange", id: frId };
}

/** The range id a `floating-range` region carries, or null (no store import here). */
export function frIdOfFormatRegion(region: GridRegion): string | null {
  const id = (region.data as { frId?: unknown } | undefined)?.frId;
  return typeof id === "string" && id !== "" ? id : null;
}

// ============================================================================
// Defaults / capabilities (pure)
// ============================================================================

/** The title bar's font stack (the cells' own; today's title look). */
export const FR_TITLE_FONT_FAMILY = "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
/** The title bar's fill and ink (were frRenderer's COLORS.titleBg / titleText). */
export const FR_TITLE_BACKGROUND = "#f0f0f0";
export const FR_TITLE_COLOR = "#333333";
/** The title bar's default text size, px (the cells' 11px). */
export const FR_TITLE_FONT_SIZE = 11;
/** The colour a turned-on container border starts at (the grid's own outline). */
export const FR_CONTAINER_BORDER_COLOR = "#8a8a8a";

/**
 * A floating grid's DEFAULTS: today's look. No container background and no
 * container border (the grid paints its own white frame and outline inside the
 * content rect, so a container background shows only in the padding band), the
 * #f0f0f0 / #333333 one-line title bar in the cells' font at 11px semibold, no
 * padding, no shadow. The title is the grid's own (`paint.title` "family").
 */
export function frContainerDefaults(name?: string | null): ResolvedVisualContainer {
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: {
      ...b.title,
      show: true,
      text: typeof name === "string" ? name : "",
      headingLevel: 0,
      fontFamily: FR_TITLE_FONT_FAMILY,
      fontSize: FR_TITLE_FONT_SIZE,
      bold: true,
      italic: false,
      underline: false,
      color: FR_TITLE_COLOR,
      background: FR_TITLE_BACKGROUND,
      align: "left",
      wrap: false,
    },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    spacing: { ...b.spacing },
    background: { show: false, color: "#ffffff", alpha: 1, gradient: null },
    border: { show: false, color: FR_CONTAINER_BORDER_COLOR, width: 1, radius: 0 },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "family", shadow: "core" },
  };
}

/**
 * What the Format pane offers for a floating grid: padding (the frame grows by
 * it), the title (its name is an IDENTITY: editable through a rename, never
 * bound), background, border and shadow. No lock aspect (its size is whole rows
 * and columns, `canResize` false), no subtitle or divider (the title bar is one
 * line), no data format (its cells carry their own).
 */
export function frContainerCapabilities(): ContainerCapabilities {
  return {
    padding: true,
    lockAspect: false,
    title: true,
    titleText: "identity",
    subtitle: false,
    divider: false,
    // The title bar is one line sitting on the cells: no wrap, no spacing.
    titleWrap: false,
    spacing: false,
    background: true,
    backgroundTransparency: true,
    gradient: true,
    border: true,
    borderRadius: true,
    shadow: true,
    dataFormat: false,
  };
}

// ============================================================================
// The stored container (one spelling per fact)
// ============================================================================

/** `c` without the two identity leaves (they live in `name` / `showTitle`, never in the container). */
export function withoutIdentityLeaves(c: VisualContainerFormat | undefined): VisualContainerFormat | undefined {
  if (!c) return undefined;
  const title = c.title;
  if (!title || (title.text === undefined && title.show === undefined)) return c;
  return applyVisualContainerPatch(c, { title: { text: null, show: null } });
}

/** The container the range carries (`entry.container`), without any identity leaf. */
function ownContainer(entry: FloatingRangeEntry): VisualContainerFormat | undefined {
  return withoutIdentityLeaves(entry.container);
}

/**
 * The STORED container the Format pane reads: the range's own container with
 * the identity facts spelled in -- `title.text` = its name, `title.show` = its
 * `showTitle`.
 */
export function frStoredContainer(entry: FloatingRangeEntry): VisualContainerFormat {
  const own = ownContainer(entry) ?? {};
  return { ...own, title: { ...(own.title ?? {}), text: entry.name, show: entry.showTitle } };
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

/** Whether two containers say the same thing (absent == empty, identity leaves ignored). */
export function sameFrContainer(a: VisualContainerFormat | undefined, b: VisualContainerFormat | undefined): boolean {
  const norm = (c: VisualContainerFormat | undefined) => withoutIdentityLeaves(applyVisualContainerPatch(c, {}));
  return stableJson(norm(a) ?? null) === stableJson(norm(b) ?? null);
}

// ============================================================================
// Resolution (bound > stored > defaults), the preview, the cache
// ============================================================================

/** Bumped whenever something the resolved container reads changes outside the entry (bindings, previews). */
let resolveEpoch = 0;

/** frId -> the STORED container a Format-pane preview is showing (transient: never written). */
const previews = new Map<string, VisualContainerFormat>();

interface ResolvedRecord {
  epoch: number;
  container: VisualContainerFormat | undefined;
  name: string;
  showTitle: boolean;
  resolved: ResolvedVisualContainer;
  insets: FrInsets;
}

/** entry object -> its last resolution (an entry is replaced on every upsert, so a stale one is dropped). */
let resolvedCache = new WeakMap<FloatingRangeEntry, ResolvedRecord>();

/** Something every range's resolution reads changed (a binding value, a reload): drop every cached answer. */
export function invalidateFrContainers(): void {
  resolveEpoch++;
}

/** Test hook / File > New: forget every preview and every cached resolution. */
export function resetFrContainers(): void {
  previews.clear();
  resolvedCache = new WeakMap();
  resolveEpoch++;
}

/** The container's insets around the grid's own frame, frame-relative px. */
export interface FrInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: FrInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }) as FrInsets;

/**
 * The band between the outer frame and the content rect: the border (while
 * shown) and then the padding, read off `layoutVisualContainer` -- the function
 * Core's content rect (`visualContentRect`) comes from -- so the grid lays out
 * exactly where Core's zone band says its content is. The title is the grid's
 * own ("family"), so no Core band takes space.
 */
export function insetsOf(c: ResolvedVisualContainer): FrInsets {
  const SIZE = 1_000_000;
  const l = layoutVisualContainer({ x: 0, y: 0, width: SIZE, height: SIZE }, c);
  const left = l.content.x;
  const top = l.content.y;
  const right = SIZE - l.content.x - l.content.width;
  const bottom = SIZE - l.content.y - l.content.height;
  if (left === 0 && top === 0 && right === 0 && bottom === 0) return ZERO_INSETS;
  return { top, right, bottom, left };
}

function resolveFor(entry: FloatingRangeEntry): ResolvedRecord {
  const cached = resolvedCache.get(entry);
  if (
    cached &&
    cached.epoch === resolveEpoch &&
    cached.container === entry.container &&
    cached.name === entry.name &&
    cached.showTitle === entry.showTitle
  ) {
    return cached;
  }
  const stored = previews.get(entry.id) ?? frStoredContainer(entry);
  const resolved = resolveContainerForObject(
    frBindingRef(entry.id),
    stored,
    frContainerDefaults(entry.name),
    frContainerBindingPath,
  );
  const record: ResolvedRecord = {
    epoch: resolveEpoch,
    container: entry.container,
    name: entry.name,
    showTitle: entry.showTitle,
    resolved,
    insets: insetsOf(resolved),
  };
  resolvedCache.set(entry, record);
  return record;
}

/**
 * The range's RESOLVED container: bound > stored > defaults (WP-D's bindings
 * laid over its own container, the identity leaves spelled in), or the preview
 * the Format pane is showing. What the region carries, Core paints and the
 * grid's title bar paints from. Cached per entry object.
 */
export function frContainerOf(entry: FloatingRangeEntry): ResolvedVisualContainer {
  return resolveFor(entry).resolved;
}

/** The container insets around the grid's own frame (zero for an untouched range). */
export function frInsets(entry: FloatingRangeEntry): FrInsets {
  return resolveFor(entry).insets;
}

/**
 * Whether the range shows its title bar: the RESOLVED `title.show` (its
 * `showTitle`, or what a Format-pane preview shows). The one reader every
 * piece of frame math and every published flag asks.
 */
export function frShowsTitle(entry: FloatingRangeEntry): boolean {
  return frContainerOf(entry).title.show;
}

// ============================================================================
// The floatingRange kind's bindable properties (WP-D registry) + re-publish
// ============================================================================

/** Every bindable container field of a floating grid, as WP-D registry descriptors. */
export function frBindableDescriptors(): BindablePropertyDescriptor[] {
  const out: BindablePropertyDescriptor[] = [];
  for (const field of VISUAL_CONTAINER_FIELD_IDS) {
    const pointer = frContainerBindingPath(field);
    if (!pointer) continue;
    out.push({ pointer, label: containerFieldLabel(field), group: OBJECT_FORMAT_BINDING_GROUP });
  }
  return out;
}

/**
 * Register the floatingRange kind with WP-D's registry: ONE registration (WP-D
 * registers none). A grid's region -> its EntityId; a script's floating-range
 * instance id IS that id. Its properties are its container fields -- the same
 * set with or without a region, because nothing about a floating grid's
 * bindable set depends on where it is drawn. Returns the unregister.
 */
export function registerFrBindableProperties(
  regionType: string,
  exists: (frId: string) => boolean,
): () => void {
  return registerBindableProperties({
    kind: "floatingRange",
    regionTypes: [regionType],
    instanceTypes: ["floatingRange"],
    refOf: (region) => {
      const id = frIdOfFormatRegion(region);
      return id === null ? null : frBindingRef(id);
    },
    refForInstance: (instanceId) =>
      typeof instanceId === "string" && instanceId !== "" && exists(instanceId) ? frBindingRef(instanceId) : null,
    properties: () => frBindableDescriptors(),
  });
}

/**
 * Re-publish the grids when a binding of a floating grid's container changed:
 * a bound border width or title size changes the DERIVED frame, so the cached
 * resolutions are dropped first, then the store re-publishes (`republish`) and
 * one overlay redraw follows -- never GRID_REFRESH (WP-D's feedback-loop rule).
 * Returns the unsubscribe.
 */
export function installFrContainerResync(republish: () => void, redraw: () => void): () => void {
  return onContainerBindingsChanged("floatingRange", () => {
    invalidateFrContainers();
    republish();
    redraw();
  });
}

// ============================================================================
// The provider
// ============================================================================

/** The sentence a commit refuses with when the range is gone. */
export const FR_FORMAT_GONE = "The floating range no longer exists.";
/** The sentence a commit refuses an empty name with. */
export const FR_FORMAT_EMPTY_NAME = "A floating range needs a name.";

/** What the provider needs from the store and the backend (injected by activate()). */
export interface FrObjectFormatDeps {
  /** The region type the grid publishes (`floating-range`). */
  regionType: string;
  getEntry(frId: string): FloatingRangeEntry | null;
  /** Persist one `update_floating_range` patch and bring the store and regions up to date; rejects with the backend's sentence. */
  update(frId: string, patch: FloatingRangePatch): Promise<void>;
  /** Rename through the validated door; rejects with the backend's sentence. */
  rename(frId: string, name: string): Promise<void>;
  /** Re-publish the regions (a preview changed what the frame derives from). */
  republish(): void;
}

/** The split of one container patch onto the grid's three doors. */
export interface FrFormatPlan {
  /** The new name, or null (unchanged). */
  rename: string | null;
  /** `update_floating_range` patch: `showTitle` and/or `container`; null = nothing to write. */
  update: FloatingRangePatch | null;
}

/**
 * Split a container patch onto the grid's doors (pure; exported for the unit
 * tier): a `title.text` is a rename (trimmed; "" refused; `null` -- "clear the
 * name" -- is not a thing and is ignored), a `title.show` is `showTitle`
 * (`null` = the default, shown), and every other leaf lands in the range's
 * container. Unchanged values plan nothing.
 */
export function planFrFormatCommit(entry: FloatingRangeEntry, patch: VisualContainerPatch): FrFormatPlan {
  const title = patch?.title ?? undefined;
  let rename: string | null = null;
  if (title && typeof title.text === "string") {
    const name = title.text.trim();
    if (name === "") throw new Error(FR_FORMAT_EMPTY_NAME);
    if (name !== entry.name) rename = name;
  }
  const update: FloatingRangePatch = {};
  if (title && title.show !== undefined) {
    const show = title.show === null ? true : title.show;
    if (show !== entry.showTitle) update.showTitle = show;
  }
  // The identity leaves go to their doors, never into the container.
  const rest: VisualContainerPatch = { ...(patch ?? {}) };
  if (title) {
    const otherTitle: Record<string, unknown> = { ...title };
    delete otherTitle.text;
    delete otherTitle.show;
    if (Object.keys(otherTitle).length > 0) rest.title = otherTitle as VisualContainerPatch["title"];
    else delete rest.title;
  }
  const own = ownContainer(entry);
  const next = withoutIdentityLeaves(applyVisualContainerPatch(own, rest));
  if (!sameFrContainer(own, next)) update.container = next ?? null;
  return { rename, update: Object.keys(update).length > 0 ? update : null };
}

/** Build the `@api/objectFormat` provider registered for the grid's region type. */
export function createFrObjectFormatProvider(deps: FrObjectFormatDeps): ObjectFormatProvider {
  /** The range a preview of THIS provider is showing. */
  let previewing: string | null = null;

  const endPreview = (): void => {
    if (previewing === null) return;
    previews.delete(previewing);
    previewing = null;
    invalidateFrContainers();
    deps.republish();
  };

  const entryOf = (region: GridRegion): FloatingRangeEntry | null => {
    const id = frIdOfFormatRegion(region);
    return id === null ? null : deps.getEntry(id);
  };

  return {
    types: [deps.regionType],

    read(region) {
      const entry = entryOf(region);
      return entry ? (JSON.parse(JSON.stringify(frStoredContainer(entry))) as VisualContainerFormat) : {};
    },

    defaults(region) {
      return frContainerDefaults(entryOf(region)?.name ?? "");
    },

    capabilities() {
      return frContainerCapabilities();
    },

    preview(region, patch: VisualContainerPatch) {
      const entry = entryOf(region);
      if (!entry) return;
      if (previewing !== null && previewing !== entry.id) previews.delete(previewing);
      previewing = entry.id;
      // A name is never previewed: the title shows the name the range HAS.
      const shown = applyVisualContainerPatch(frStoredContainer(entry), patch) ?? {};
      previews.set(entry.id, { ...shown, title: { ...(shown.title ?? {}), text: entry.name } });
      invalidateFrContainers();
      deps.republish();
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const entry = entryOf(region);
      if (!entry) throw new Error(FR_FORMAT_GONE);
      const plan = planFrFormatCommit(entry, patch);
      // The rename first: it ENDS the undo history (sheet-rename machinery),
      // so a format change committed after it is still its own undo step.
      if (plan.rename !== null) await deps.rename(entry.id, plan.rename);
      if (plan.update) await deps.update(entry.id, plan.update);
    },

    bindingPath(region, field) {
      return frIdOfFormatRegion(region) === null ? null : frContainerBindingPath(field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const entry = entryOf(region);
      return entry ? frBindingRef(entry.id) : null;
    },
  };
}
