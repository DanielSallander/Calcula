//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/formatValues.ts
// PURPOSE: The pure half of the Format tab: which container fields a family's
//          capabilities show, what value a literal editor starts at, and the
//          one patch a row commits.
// CONTEXT: A row shows the STORED literal when the object has one (provider
//          `read`), else what resolves (`ObjectFormatSnapshot.resolved`: the
//          family's default, or a value the family published) -- so an
//          untouched field shows what paints, and committing it unchanged
//          writes nothing. Transparency is stored as a percentage and resolved
//          as an alpha; this file turns one into the other in one place.

import {
  VISUAL_CONTAINER_FIELD_TYPES,
  containerFieldPatch,
  containerFieldRange,
  readContainerField,
  solidBackgroundIsNoop,
  solidBackgroundPatch,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerPatch,
} from "@api/visualContainer";
import type { ContainerCapabilities, ObjectFormatSnapshot } from "@api/objectFormat";

/** A resolved leaf, spelled as the stored field would be (transparency in %, not alpha). */
export function resolvedFieldValue(resolved: ResolvedVisualContainer, id: ContainerFieldId): unknown {
  switch (id) {
    case "lockAspect":
      return resolved.lockAspect;
    case "background.transparency":
      return Math.round((1 - resolved.background.alpha) * 100);
    case "shadow.transparency":
      return Math.round((1 - resolved.shadow.alpha) * 100);
    case "spacing.custom":
      // Not a resolved leaf: the family's spacing shows unless the user chose custom.
      return false;
    default: {
      const dot = id.indexOf(".");
      const group = id.slice(0, dot) as keyof ResolvedVisualContainer;
      const leaf = id.slice(dot + 1);
      const g = resolved[group] as unknown as Record<string, unknown> | undefined;
      return g ? g[leaf] : undefined;
    }
  }
}

/** The value a literal editor shows: the stored literal, else what resolves. */
export function literalFieldValue(snapshot: ObjectFormatSnapshot, id: ContainerFieldId): unknown {
  const stored = readContainerField(snapshot.stored, id);
  if (stored !== undefined && stored !== null) return stored;
  return resolvedFieldValue(snapshot.resolved, id);
}

/** Whether a family's capabilities show this field at all. */
export function fieldOffered(c: ContainerCapabilities, id: ContainerFieldId): boolean {
  if (id === "lockAspect") return c.lockAspect;
  const group = id.slice(0, id.indexOf("."));
  switch (group) {
    case "padding":
      return c.padding;
    case "title":
      if (id === "title.wrap" && c.titleWrap === false) return false;
      return c.title && (id !== "title.text" || c.titleText !== "none");
    case "subtitle":
      if (id === "subtitle.wrap" && c.titleWrap === false) return false;
      return c.subtitle;
    case "divider":
      return c.divider;
    case "spacing":
      // A distance shows only beside the band it follows; none when the family
      // honours no spacing (a row that changes nothing is never offered).
      if (c.spacing === false) return false;
      if (id === "spacing.belowTitle") return c.title;
      if (id === "spacing.belowSubtitle") return c.subtitle;
      if (id === "spacing.belowDivider") return c.divider;
      return c.title || c.subtitle || c.divider;
    case "background":
      return c.background && (id !== "background.transparency" || c.backgroundTransparency);
    case "border":
      return c.border && (id !== "border.radius" || c.borderRadius);
    case "shadow":
      return c.shadow;
    default:
      return false;
  }
}

/**
 * Normalise what an editor produced for a field: numbers clamped into the
 * field's range (and rounded for an integer field), anything non-finite
 * refused (undefined = do not commit). Colours and text pass as they are
 * (the seam validates them and says why it refuses).
 */
export function normaliseFieldValue(id: ContainerFieldId, value: unknown): unknown {
  const type = VISUAL_CONTAINER_FIELD_TYPES[id];
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    let n = type === "integer" ? Math.round(value) : value;
    const range = containerFieldRange(id);
    if (range) n = Math.min(range[1], Math.max(range[0], n));
    return n;
  }
  return value;
}

/**
 * The patch a row commits for `value` (`null` = clear back to the family's
 * default), or null when it would change nothing (the same literal again) or
 * the value is not a value.
 *
 * A background COLOUR is a solid background commit (round 2, G1): it also
 * clears a stored or resolved gradient and switches a hidden background on, so
 * re-picking the colour that shows on a gradient-only container (the chart
 * Fill card writes only `background.gradient`) or on a floating grid (default
 * `show:false`) still paints it. It is decided BEFORE both no-op branches
 * below, which would otherwise swallow exactly those picks.
 */
export function rowPatch(
  snapshot: ObjectFormatSnapshot,
  id: ContainerFieldId,
  value: unknown,
): VisualContainerPatch | null {
  if (value === null) {
    const stored = readContainerField(snapshot.stored, id);
    return stored === undefined || stored === null ? null : containerFieldPatch(id, null);
  }
  const v = normaliseFieldValue(id, value);
  if (v === undefined) return null;
  if (id === "background.color" && typeof v === "string" && v !== "") {
    const base = { stored: snapshot.stored, resolved: snapshot.resolved };
    return solidBackgroundIsNoop(v, base) ? null : solidBackgroundPatch(v, base);
  }
  const stored = readContainerField(snapshot.stored, id);
  if (stored !== undefined && stored !== null) return Object.is(stored, v) ? null : containerFieldPatch(id, v);
  // An untouched field: committing what already shows stores nothing (a
  // tab-through or an unchanged blur is not a write).
  return Object.is(resolvedFieldValue(snapshot.resolved, id), v) ? null : containerFieldPatch(id, v);
}

/** Heading levels as the Title card names them. */
export const HEADING_LEVEL_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, "Normal"],
  [1, "Heading 1"],
  [2, "Heading 2"],
  [3, "Heading 3"],
  [4, "Heading 4"],
  [5, "Heading 5"],
  [6, "Heading 6"],
];

/** Font families the font row offers (every one passes `isSafeFontFamily`). */
export const FONT_FAMILY_OPTIONS: readonly string[] = [
  "Segoe UI",
  "Segoe UI Semibold",
  "Arial",
  "Calibri",
  "Cambria",
  "Consolas",
  "Courier New",
  "Georgia",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

/** The Excel format codes the Data format card offers before "Custom". */
export const DATA_FORMAT_PRESETS: readonly string[] = [
  "General",
  "#,##0",
  "#,##0.00",
  "0%",
  "0.0%",
  "$#,##0",
];

/** The sample the Data format card previews a code with. */
export const DATA_FORMAT_SAMPLE = 1234.5;

/** What the read-only geometry rows say when nothing provides the object's geometry. */
export const GEOMETRY_NOT_PROVIDED = "This object cannot be moved or sized from here.";

/** What the Title card says on an identity title (the floating grid's name). */
export const TITLE_IS_IDENTITY = "The title is this object's name; rename it";
