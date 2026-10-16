//! FILENAME: app/extensions/Controls/lib/controlObjectFormat.ts
// PURPOSE: The floating CONTROLS' half of the visual-container seams (WP-C
//          D-FORMAT): the `@api/objectFormat` provider the object pane's Format
//          tab reads and writes a shape's, a text box's, a button's, a
//          picture's and a page navigator's container through, and the table
//          of which container field binds at which WP-D catalog pointer.
// CONTEXT: ONE SPELLING PER FACT. A control's container lives in its FLAT
//          property keys (lib/controlContainerDefaults.ts): a painted kind's
//          background IS its `fill`, its border its `stroke` / `borderColor` +
//          `strokeWidth`, and the rest `container<Field>` keys; a navigator's
//          padding IS WP-B's `padding` key, which the Format pane never writes.
//
//          ONE UNDO STEP. A commit is ONE `set_control_appearance` call with
//          every key the patch changes -- Rust records ONE real "Format
//          control" undo entry that JOINS commitObjectFormat's transaction --
//          and never N `set_control_property` calls, which record no undo at
//          all for a non-executable key (review R1-1). The writes are computed
//          against the control's LITERAL keys, read from the backend at the
//          commit, so a bound key's overlaid value is never written back as a
//          literal.
//
//          READ = what the last properties read said (lib/controlContainer.ts:
//          the renderers' reads, in which Rust already overlaid every bound
//          `/properties/<key>`), and the RESOLVED container is the region's
//          published one -- `resolveContainerForObject` is never asked to
//          overlay a control (ruling R5). The binding REF (for the pane's fx
//          rows) is the control's `uid`, read from the backend by anchor.
//
//          NO STORE IMPORT. Everything the provider needs from the backend and
//          the paint caches is INJECTED by Controls' activate() (the
//          chartObjectFormat.ts pattern), so a test hands it doubles.

import type { GridRegion } from "@api/gridOverlays";
import type { ContainerCapabilities, ObjectFormatProvider } from "@api/objectFormat";
import type { ObjectBindingRef } from "@api/objectBindings";
import type { ContainerFieldId, VisualContainerFormat, VisualContainerPatch } from "@api/visualContainer";
import {
  controlContainerCapabilities,
  controlContainerDefaults,
  controlContainerKind,
  controlContainerWrites,
  controlFieldOffered,
  controlFieldRefusal,
  patchHasGradient,
  readControlContainer,
  touchedContainerFields,
  type ControlContainerKind,
} from "./controlContainerDefaults";
import { getControlContainerEntry, setControlContainerPreview } from "./controlContainer";
import type { ControlAppearanceChange } from "./types";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a control's container fields bind under. */
export const CONTAINER_BINDING_KIND = "control";

/**
 * Per control kind: container field -> the WP-D catalog pointer a binding of
 * that field lives at (an exact `/properties/<key>` Family row), or null =
 * never bindable. Null for every field the kind's capabilities hide, for
 * `lockAspect` (never bindable, all kinds), and for a painted kind's
 * `background.show` / `border.show` -- they are DERIVED from `fill` /
 * `strokeWidth` and have no key of their own: bind the fill or the width.
 * A navigator's padding rows are null too: its `padding` key is WP-B's, bound
 * from its Properties tab.
 */
export const CONTAINER_BINDING_PATHS = {
  shape: {
    "padding.top": "/properties/containerPaddingTop",
    "padding.right": "/properties/containerPaddingRight",
    "padding.bottom": "/properties/containerPaddingBottom",
    "padding.left": "/properties/containerPaddingLeft",
    lockAspect: null,
    "title.show": "/properties/containerTitleShow",
    "title.text": "/properties/containerTitleText",
    "title.headingLevel": "/properties/containerTitleHeadingLevel",
    "title.fontFamily": "/properties/containerTitleFontFamily",
    "title.fontSize": "/properties/containerTitleFontSize",
    "title.bold": "/properties/containerTitleBold",
    "title.italic": "/properties/containerTitleItalic",
    "title.underline": "/properties/containerTitleUnderline",
    "title.color": "/properties/containerTitleColor",
    "title.background": "/properties/containerTitleBackground",
    "title.align": "/properties/containerTitleAlign",
    "title.wrap": "/properties/containerTitleWrap",
    "subtitle.show": "/properties/containerSubtitleShow",
    "subtitle.text": "/properties/containerSubtitleText",
    "subtitle.fontFamily": "/properties/containerSubtitleFontFamily",
    "subtitle.fontSize": "/properties/containerSubtitleFontSize",
    "subtitle.bold": "/properties/containerSubtitleBold",
    "subtitle.italic": "/properties/containerSubtitleItalic",
    "subtitle.underline": "/properties/containerSubtitleUnderline",
    "subtitle.color": "/properties/containerSubtitleColor",
    "subtitle.background": "/properties/containerSubtitleBackground",
    "subtitle.align": "/properties/containerSubtitleAlign",
    "subtitle.wrap": "/properties/containerSubtitleWrap",
    "divider.show": "/properties/containerDividerShow",
    "divider.color": "/properties/containerDividerColor",
    "divider.style": "/properties/containerDividerStyle",
    "divider.width": "/properties/containerDividerWidth",
    "divider.ignorePadding": "/properties/containerDividerIgnorePadding",
    "spacing.custom": "/properties/containerSpacingCustom",
    "spacing.belowTitle": "/properties/containerSpacingBelowTitle",
    "spacing.belowSubtitle": "/properties/containerSpacingBelowSubtitle",
    "spacing.belowDivider": "/properties/containerSpacingBelowDivider",
    "background.show": null,
    "background.color": "/properties/fill",
    "background.transparency": null,
    "border.show": null,
    "border.color": "/properties/stroke",
    "border.width": "/properties/strokeWidth",
    "border.radius": null,
    "shadow.show": "/properties/containerShadowShow",
    "shadow.color": "/properties/containerShadowColor",
    "shadow.transparency": "/properties/containerShadowTransparency",
    "shadow.offset": "/properties/containerShadowOffset",
    "shadow.position": "/properties/containerShadowPosition",
    "shadow.blur": "/properties/containerShadowBlur",
    "shadow.distance": "/properties/containerShadowDistance",
  },
  textBox: {
    "padding.top": "/properties/containerPaddingTop",
    "padding.right": "/properties/containerPaddingRight",
    "padding.bottom": "/properties/containerPaddingBottom",
    "padding.left": "/properties/containerPaddingLeft",
    lockAspect: null,
    "title.show": "/properties/containerTitleShow",
    "title.text": "/properties/containerTitleText",
    "title.headingLevel": "/properties/containerTitleHeadingLevel",
    "title.fontFamily": "/properties/containerTitleFontFamily",
    "title.fontSize": "/properties/containerTitleFontSize",
    "title.bold": "/properties/containerTitleBold",
    "title.italic": "/properties/containerTitleItalic",
    "title.underline": "/properties/containerTitleUnderline",
    "title.color": "/properties/containerTitleColor",
    "title.background": "/properties/containerTitleBackground",
    "title.align": "/properties/containerTitleAlign",
    "title.wrap": "/properties/containerTitleWrap",
    "subtitle.show": "/properties/containerSubtitleShow",
    "subtitle.text": "/properties/containerSubtitleText",
    "subtitle.fontFamily": "/properties/containerSubtitleFontFamily",
    "subtitle.fontSize": "/properties/containerSubtitleFontSize",
    "subtitle.bold": "/properties/containerSubtitleBold",
    "subtitle.italic": "/properties/containerSubtitleItalic",
    "subtitle.underline": "/properties/containerSubtitleUnderline",
    "subtitle.color": "/properties/containerSubtitleColor",
    "subtitle.background": "/properties/containerSubtitleBackground",
    "subtitle.align": "/properties/containerSubtitleAlign",
    "subtitle.wrap": "/properties/containerSubtitleWrap",
    "divider.show": "/properties/containerDividerShow",
    "divider.color": "/properties/containerDividerColor",
    "divider.style": "/properties/containerDividerStyle",
    "divider.width": "/properties/containerDividerWidth",
    "divider.ignorePadding": "/properties/containerDividerIgnorePadding",
    "spacing.custom": "/properties/containerSpacingCustom",
    "spacing.belowTitle": "/properties/containerSpacingBelowTitle",
    "spacing.belowSubtitle": "/properties/containerSpacingBelowSubtitle",
    "spacing.belowDivider": "/properties/containerSpacingBelowDivider",
    "background.show": null,
    "background.color": "/properties/fill",
    "background.transparency": null,
    "border.show": null,
    "border.color": "/properties/stroke",
    "border.width": "/properties/strokeWidth",
    "border.radius": null,
    "shadow.show": "/properties/containerShadowShow",
    "shadow.color": "/properties/containerShadowColor",
    "shadow.transparency": "/properties/containerShadowTransparency",
    "shadow.offset": "/properties/containerShadowOffset",
    "shadow.position": "/properties/containerShadowPosition",
    "shadow.blur": "/properties/containerShadowBlur",
    "shadow.distance": "/properties/containerShadowDistance",
  },
  button: {
    "padding.top": null,
    "padding.right": null,
    "padding.bottom": null,
    "padding.left": null,
    lockAspect: null,
    "title.show": null,
    "title.text": null,
    "title.headingLevel": null,
    "title.fontFamily": null,
    "title.fontSize": null,
    "title.bold": null,
    "title.italic": null,
    "title.underline": null,
    "title.color": null,
    "title.background": null,
    "title.align": null,
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
    "background.show": null,
    "background.color": "/properties/fill",
    "background.transparency": null,
    "border.show": null,
    "border.color": "/properties/borderColor",
    "border.width": "/properties/strokeWidth",
    "border.radius": "/properties/containerBorderRadius",
    "shadow.show": "/properties/containerShadowShow",
    "shadow.color": "/properties/containerShadowColor",
    "shadow.transparency": "/properties/containerShadowTransparency",
    "shadow.offset": "/properties/containerShadowOffset",
    "shadow.position": "/properties/containerShadowPosition",
    "shadow.blur": "/properties/containerShadowBlur",
    "shadow.distance": "/properties/containerShadowDistance",
  },
  image: {
    "padding.top": "/properties/containerPaddingTop",
    "padding.right": "/properties/containerPaddingRight",
    "padding.bottom": "/properties/containerPaddingBottom",
    "padding.left": "/properties/containerPaddingLeft",
    lockAspect: null,
    "title.show": "/properties/containerTitleShow",
    "title.text": "/properties/containerTitleText",
    "title.headingLevel": "/properties/containerTitleHeadingLevel",
    "title.fontFamily": "/properties/containerTitleFontFamily",
    "title.fontSize": "/properties/containerTitleFontSize",
    "title.bold": "/properties/containerTitleBold",
    "title.italic": "/properties/containerTitleItalic",
    "title.underline": "/properties/containerTitleUnderline",
    "title.color": "/properties/containerTitleColor",
    "title.background": "/properties/containerTitleBackground",
    "title.align": "/properties/containerTitleAlign",
    "title.wrap": "/properties/containerTitleWrap",
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
    "spacing.custom": "/properties/containerSpacingCustom",
    "spacing.belowTitle": "/properties/containerSpacingBelowTitle",
    "spacing.belowSubtitle": "/properties/containerSpacingBelowSubtitle",
    "spacing.belowDivider": "/properties/containerSpacingBelowDivider",
    "background.show": null,
    "background.color": "/properties/fill",
    "background.transparency": "/properties/containerBackgroundTransparency",
    "border.show": null,
    "border.color": "/properties/stroke",
    "border.width": "/properties/strokeWidth",
    "border.radius": "/properties/containerBorderRadius",
    "shadow.show": "/properties/containerShadowShow",
    "shadow.color": "/properties/containerShadowColor",
    "shadow.transparency": "/properties/containerShadowTransparency",
    "shadow.offset": "/properties/containerShadowOffset",
    "shadow.position": "/properties/containerShadowPosition",
    "shadow.blur": "/properties/containerShadowBlur",
    "shadow.distance": "/properties/containerShadowDistance",
  },
  pageNavigator: {
    "padding.top": null,
    "padding.right": null,
    "padding.bottom": null,
    "padding.left": null,
    lockAspect: null,
    "title.show": "/properties/containerTitleShow",
    "title.text": "/properties/containerTitleText",
    "title.headingLevel": "/properties/containerTitleHeadingLevel",
    "title.fontFamily": "/properties/containerTitleFontFamily",
    "title.fontSize": "/properties/containerTitleFontSize",
    "title.bold": "/properties/containerTitleBold",
    "title.italic": "/properties/containerTitleItalic",
    "title.underline": "/properties/containerTitleUnderline",
    "title.color": "/properties/containerTitleColor",
    "title.background": "/properties/containerTitleBackground",
    "title.align": "/properties/containerTitleAlign",
    "title.wrap": "/properties/containerTitleWrap",
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
    "spacing.custom": "/properties/containerSpacingCustom",
    "spacing.belowTitle": "/properties/containerSpacingBelowTitle",
    "spacing.belowSubtitle": "/properties/containerSpacingBelowSubtitle",
    "spacing.belowDivider": "/properties/containerSpacingBelowDivider",
    "background.show": "/properties/containerBackgroundShow",
    "background.color": "/properties/containerBackgroundColor",
    "background.transparency": "/properties/containerBackgroundTransparency",
    "border.show": "/properties/containerBorderShow",
    "border.color": "/properties/containerBorderColor",
    "border.width": "/properties/containerBorderWidth",
    "border.radius": "/properties/containerBorderRadius",
    "shadow.show": "/properties/containerShadowShow",
    "shadow.color": "/properties/containerShadowColor",
    "shadow.transparency": "/properties/containerShadowTransparency",
    "shadow.offset": "/properties/containerShadowOffset",
    "shadow.position": "/properties/containerShadowPosition",
    "shadow.blur": "/properties/containerShadowBlur",
    "shadow.distance": "/properties/containerShadowDistance",
  },
} as const satisfies Readonly<Record<ControlContainerKind, Readonly<Record<ContainerFieldId, string | null>>>>;

/** The catalog pointer of a container field of a control of `kind`, or null (answered FROM the table). */
export function controlContainerBindingPath(kind: ControlContainerKind, field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[kind][field] ?? null;
}

// ============================================================================
// Region -> the control
// ============================================================================

/** A floating control's anchor and type, from the region's published data. */
export interface ControlRegionInfo {
  controlId: string;
  sheetIndex: number;
  row: number;
  col: number;
  controlType: string;
}

/** The control a `floating-control` region stands for, or null. */
export function controlOfRegion(region: GridRegion): ControlRegionInfo | null {
  const d = region.data as
    | { sheetIndex?: unknown; row?: unknown; col?: unknown; controlType?: unknown }
    | undefined;
  if (!d) return null;
  const { sheetIndex, row, col, controlType } = d;
  if (!Number.isSafeInteger(sheetIndex) || !Number.isSafeInteger(row) || !Number.isSafeInteger(col)) return null;
  return {
    controlId: region.id,
    sheetIndex: sheetIndex as number,
    row: row as number,
    col: col as number,
    controlType: typeof controlType === "string" ? controlType : "",
  };
}

/** The container kind of a region's control: the last read's (a text box is a shapeType), else its type's. */
export function controlKindOfRegion(region: GridRegion): ControlContainerKind | null {
  const info = controlOfRegion(region);
  if (!info) return null;
  return getControlContainerEntry(info.controlId)?.kind ?? controlContainerKind(info.controlType);
}

// ============================================================================
// The provider
// ============================================================================

/** What the provider needs from the backend and the paint caches (injected by activate()). */
export interface ControlObjectFormatDeps {
  /** The region type every floating control publishes (`floating-control`). */
  regionType: string;
  /**
   * The control's LITERAL properties (flat key -> value) and its type, read
   * from the backend; null = no control there.
   */
  readLiteral(
    sheetIndex: number,
    row: number,
    col: number,
  ): Promise<{ controlType: string; props: Record<string, string> } | null>;
  /** THE batch door: one `set_control_appearance` call; resolves to how many controls changed. */
  setAppearance(changes: ControlAppearanceChange[]): Promise<number>;
  /** After a write: drop the control's paint caches (the next paint reads it again), tell an open Properties tab. */
  afterWrite(info: ControlRegionInfo): void;
  /** The control's WP-D binding ref (its `uid`, read from the backend by anchor). */
  bindingRefAt(sheetIndex: number, row: number, col: number): Promise<ObjectBindingRef | null>;
}

/** The refusal when the control is gone by the time a commit reaches it. */
export const CONTROL_FORMAT_GONE = "The control no longer exists.";

/** The refusal for a background gradient on a control (a structured value no flat key holds). */
export const CONTROL_FORMAT_NO_GRADIENT = "A control's background cannot be a gradient.";

/** The refusal for a control kind that has no container (a checkbox). */
export const CONTROL_FORMAT_NO_CONTAINER = "This control has no format settings.";

/** Build the `@api/objectFormat` provider registered for the floating-control region type. */
export function createControlObjectFormatProvider(deps: ControlObjectFormatDeps): ObjectFormatProvider {
  /** The control a preview of THIS provider is showing. */
  let previewing: string | null = null;

  const endPreview = (): void => {
    if (previewing === null) return;
    const id = previewing;
    previewing = null;
    setControlContainerPreview(id, null);
  };

  const kindOf = (region: GridRegion): ControlContainerKind => controlKindOfRegion(region) ?? "shape";

  const capabilitiesOf = (region: GridRegion): ContainerCapabilities =>
    controlContainerCapabilities(kindOf(region));

  /** The first sentence a patch is refused with on a control of `kind`, or null. */
  const refusalOf = (kind: ControlContainerKind, patch: VisualContainerPatch): string | null => {
    if (patchHasGradient(patch)) return CONTROL_FORMAT_NO_GRADIENT;
    const caps = controlContainerCapabilities(kind);
    for (const field of touchedContainerFields(patch)) {
      if (!controlFieldOffered(caps, field)) return controlFieldRefusal(kind, field);
    }
    return null;
  };

  return {
    types: [deps.regionType],

    read(region): VisualContainerFormat {
      const info = controlOfRegion(region);
      const entry = info ? getControlContainerEntry(info.controlId) : undefined;
      if (!entry) return {};
      return JSON.parse(JSON.stringify(entry.stored)) as VisualContainerFormat;
    },

    defaults(region) {
      return controlContainerDefaults(kindOf(region));
    },

    capabilities(region) {
      return capabilitiesOf(region);
    },

    preview(region, patch) {
      const info = controlOfRegion(region);
      if (!info) return;
      const entry = getControlContainerEntry(info.controlId);
      if (!entry || refusalOf(entry.kind, patch) !== null) return;
      if (previewing !== null && previewing !== info.controlId) endPreview();
      const writes: Record<string, string> = {};
      for (const w of controlContainerWrites(entry.kind, entry.props, patch)) writes[w.key] = w.value;
      previewing = info.controlId;
      setControlContainerPreview(info.controlId, writes);
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const info = controlOfRegion(region);
      if (!info) throw new Error(CONTROL_FORMAT_GONE);
      const literal = await deps.readLiteral(info.sheetIndex, info.row, info.col);
      if (!literal) throw new Error(CONTROL_FORMAT_GONE);
      const kind = controlContainerKind(literal.controlType, literal.props.shapeType);
      if (!kind) throw new Error(CONTROL_FORMAT_NO_CONTAINER);
      const refusal = refusalOf(kind, patch);
      if (refusal) throw new Error(refusal);
      const writes = controlContainerWrites(kind, literal.props, patch);
      if (writes.length === 0) return;
      await deps.setAppearance([
        { sheetIndex: info.sheetIndex, row: info.row, col: info.col, properties: writes },
      ]);
      deps.afterWrite(info);
    },

    bindingPath(region, field) {
      if (!controlOfRegion(region)) return null;
      // The table already holds null for every field the kind's capabilities hide.
      return controlContainerBindingPath(kindOf(region), field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const info = controlOfRegion(region);
      return info ? deps.bindingRefAt(info.sheetIndex, info.row, info.col) : null;
    },
  };
}

/**
 * A control's STORED container straight from a properties map (no cache): what
 * `read` answers once the renderers' read of these keys has landed.
 */
export function controlStoredContainer(
  controlType: string,
  props: Readonly<Record<string, string>>,
): VisualContainerFormat {
  const kind = controlContainerKind(controlType, props.shapeType);
  return kind ? readControlContainer(kind, props) : {};
}
