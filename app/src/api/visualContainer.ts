//! FILENAME: app/src/api/visualContainer.ts
// PURPOSE: THE VISUAL CONTAINER (D-FORMAT) -- the padding, title, subtitle,
//          divider, spacing, background, border and shadow every floating
//          object (chart, pivot box, slicer, timeline, floating grid, control)
//          carries around its content, as ONE schema shared by every family:
//          types, defaults, limits, validation, patching, resolution, layout,
//          the JSON-Schema fragment and the controls' flat-key map.
// CONTEXT: Pure: no DOM, no Canvas, no extension import (seams point one way).
//          The painters live in ./visualContainerPaint.ts.
//
//          The Rust mirror is the leaf crate `core/visual-format`
//          (`core/visual-format/src/lib.rs`). The JSON is identical on both
//          sides (camelCase, sparse: an absent leaf means "the family
//          default"), and `__tests__/visualContainerLimitsDrift.test.ts` reads
//          that Rust file as TEXT and diffs, both directions:
//            - VISUAL_CONTAINER_LIMITS against every `pub const` limit;
//            - VISUAL_CONTAINER_FIELD_IDS / VISUAL_CONTAINER_FIELD_TYPES against
//              `FIELD_POINTERS`, and the numeric ranges against `field_range`;
//            - CONTROL_CONTAINER_PROPERTY_KEYS against its Rust twin.
//          The refusal SENTENCES are the Rust ones word for word (pinned by
//          `validate_sentences_are_pinned` there and by visualContainer.test.ts
//          here), so a refusal reads the same however a write arrives.
//
//          One deliberate difference: Rust's serde silently IGNORES an unknown
//          key when it reads a container; the TS edit path REFUSES it
//          ("title.nope is not a visual container field."), so a typo in a
//          pane / script patch is an error rather than a silent no-op.
//
//          Import-cycle note: scriptHost/validators.ts imports this module (the
//          control container keys) and objectBindings/catalog.ts imports
//          validators. This module must therefore never import objectBindings.

import { PAGE_NAVIGATOR_CONTROL_TYPE } from "./buttonControlService";

// ============================================================================
// Limits (mirrored 1:1 by core/visual-format/src/lib.rs; drift-tested)
// ============================================================================

export const VISUAL_CONTAINER_LIMITS = {
  /** px per side. */
  paddingMax: 200,
  fontSizeMin: 6,
  fontSizeMax: 96,
  borderWidthMax: 20,
  radiusMax: 100,
  dividerWidthMax: 20,
  spacingMax: 200,
  shadowBlurMax: 50,
  shadowDistanceMax: 50,
  /** percent */
  transparencyMax: 100,
  textMaxChars: 1024,
  fontFamilyMaxChars: 64,
  gradientStopsMin: 2,
  gradientStopsMax: 8,
} as const;

/** The highest heading level. Not a limit of its own (the type is the union 0..6). */
const HEADING_LEVEL_MAX = 6;

// ============================================================================
// Types (the STORED shape is sparse: an absent leaf = the family default)
// ============================================================================

/** "" = the family default; otherwise #rgb | #rrggbb | #rrggbbaa (either case). Nothing else. */
export type VisualColor = string;
export type VisualTextAlign = "left" | "center" | "right";
export type VisualHeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type VisualLineStyle = "solid" | "dashed" | "dotted";
export type VisualShadowPosition =
  | "bottomRight" | "bottom" | "bottomLeft" | "right" | "center" | "left" | "topRight" | "top" | "topLeft";
export type VisualGradientDirection =
  | "topToBottom" | "bottomToTop" | "leftToRight" | "rightToLeft"
  | "topLeftToBottomRight" | "bottomRightToTopLeft" | "topRightToBottomLeft" | "bottomLeftToTopRight";

export interface VisualPadding { top?: number; right?: number; bottom?: number; left?: number }
export interface VisualTextStyle {
  fontFamily?: string; fontSize?: number; bold?: boolean; italic?: boolean; underline?: boolean;
  color?: VisualColor; background?: VisualColor; align?: VisualTextAlign; wrap?: boolean;
}
export interface VisualTitle extends VisualTextStyle { show?: boolean; text?: string; headingLevel?: VisualHeadingLevel }
export interface VisualSubtitle extends VisualTextStyle { show?: boolean; text?: string }
export interface VisualDivider { show?: boolean; color?: VisualColor; style?: VisualLineStyle; width?: number; ignorePadding?: boolean }
export interface VisualSpacing { custom?: boolean; belowTitle?: number; belowSubtitle?: number; belowDivider?: number }
/** Shape-identical to the chart's GradientFill (Charts/types.ts), so a chart painter paints it unchanged. */
export interface VisualGradient {
  type: "linear" | "radial";
  direction?: VisualGradientDirection;
  stops: Array<{ offset: number; color: VisualColor }>;
}
export interface VisualBackground { show?: boolean; color?: VisualColor; transparency?: number; gradient?: VisualGradient }
export interface VisualBorder { show?: boolean; color?: VisualColor; width?: number; radius?: number }
export interface VisualShadow {
  show?: boolean; color?: VisualColor; transparency?: number;
  offset?: "outside" | "inside"; position?: VisualShadowPosition; blur?: number; distance?: number;
}
/** The STORED shape (sparse: an absent leaf = the family default). Identical JSON in TS and Rust. */
export interface VisualContainerFormat {
  padding?: VisualPadding;
  lockAspect?: boolean;
  title?: VisualTitle;
  subtitle?: VisualSubtitle;
  divider?: VisualDivider;
  spacing?: VisualSpacing;
  background?: VisualBackground;
  border?: VisualBorder;
  shadow?: VisualShadow;
}

/** A sparse patch: a leaf `null` CLEARS that leaf (back to the family default); a group `null` clears the group. */
export type VisualContainerPatch = {
  [K in keyof VisualContainerFormat]?: VisualContainerFormat[K] extends infer V
    ? V extends object ? { [L in keyof V]?: V[L] | null } | null : V | null
    : never;
};

/** Every leaf, dotted. The ONE vocabulary for cards, bindings, controls' flat keys and tests. */
export const VISUAL_CONTAINER_FIELD_IDS = [
  "padding.top", "padding.right", "padding.bottom", "padding.left", "lockAspect",
  "title.show", "title.text", "title.headingLevel", "title.fontFamily", "title.fontSize", "title.bold",
  "title.italic", "title.underline", "title.color", "title.background", "title.align", "title.wrap",
  "subtitle.show", "subtitle.text", "subtitle.fontFamily", "subtitle.fontSize", "subtitle.bold",
  "subtitle.italic", "subtitle.underline", "subtitle.color", "subtitle.background", "subtitle.align", "subtitle.wrap",
  "divider.show", "divider.color", "divider.style", "divider.width", "divider.ignorePadding",
  "spacing.custom", "spacing.belowTitle", "spacing.belowSubtitle", "spacing.belowDivider",
  "background.show", "background.color", "background.transparency",
  "border.show", "border.color", "border.width", "border.radius",
  "shadow.show", "shadow.color", "shadow.transparency", "shadow.offset", "shadow.position",
  "shadow.blur", "shadow.distance",
] as const;
export type ContainerFieldId = (typeof VISUAL_CONTAINER_FIELD_IDS)[number];
// `background.gradient` is deliberately NOT a field id: it is a structured value written whole
// (chart.setGradientFill and the chart Fill card), never bound and never a flat control key.

export type ContainerFieldType = "number" | "integer" | "boolean" | "color" | "text" | { enum: readonly string[] };

const ALIGN_VALUES = ["left", "center", "right"] as const;
const LINE_STYLE_VALUES = ["solid", "dashed", "dotted"] as const;
const SHADOW_OFFSET_VALUES = ["outside", "inside"] as const;
const SHADOW_POSITION_VALUES = [
  "bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft",
] as const;
const GRADIENT_TYPE_VALUES = ["linear", "radial"] as const;
const GRADIENT_DIRECTION_VALUES = [
  "topToBottom", "bottomToTop", "leftToRight", "rightToLeft",
  "topLeftToBottomRight", "bottomRightToTopLeft", "topRightToBottomLeft", "bottomLeftToTopRight",
] as const;

/** The value type of each field, for WP-D catalog rows and BindableField. Mirrors Rust `FIELD_POINTERS`. */
export const VISUAL_CONTAINER_FIELD_TYPES: Readonly<Record<ContainerFieldId, ContainerFieldType>> = Object.freeze({
  "padding.top": "number",
  "padding.right": "number",
  "padding.bottom": "number",
  "padding.left": "number",
  lockAspect: "boolean",
  "title.show": "boolean",
  "title.text": "text",
  "title.headingLevel": "integer",
  "title.fontFamily": "text",
  "title.fontSize": "number",
  "title.bold": "boolean",
  "title.italic": "boolean",
  "title.underline": "boolean",
  "title.color": "color",
  "title.background": "color",
  "title.align": { enum: ALIGN_VALUES },
  "title.wrap": "boolean",
  "subtitle.show": "boolean",
  "subtitle.text": "text",
  "subtitle.fontFamily": "text",
  "subtitle.fontSize": "number",
  "subtitle.bold": "boolean",
  "subtitle.italic": "boolean",
  "subtitle.underline": "boolean",
  "subtitle.color": "color",
  "subtitle.background": "color",
  "subtitle.align": { enum: ALIGN_VALUES },
  "subtitle.wrap": "boolean",
  "divider.show": "boolean",
  "divider.color": "color",
  "divider.style": { enum: LINE_STYLE_VALUES },
  "divider.width": "number",
  "divider.ignorePadding": "boolean",
  "spacing.custom": "boolean",
  "spacing.belowTitle": "number",
  "spacing.belowSubtitle": "number",
  "spacing.belowDivider": "number",
  "background.show": "boolean",
  "background.color": "color",
  "background.transparency": "number",
  "border.show": "boolean",
  "border.color": "color",
  "border.width": "number",
  "border.radius": "number",
  "shadow.show": "boolean",
  "shadow.color": "color",
  "shadow.transparency": "number",
  "shadow.offset": { enum: SHADOW_OFFSET_VALUES },
  "shadow.position": { enum: SHADOW_POSITION_VALUES },
  "shadow.blur": "number",
  "shadow.distance": "number",
});

const L = VISUAL_CONTAINER_LIMITS;

/** The inclusive range of every number / integer field. Mirrors Rust `field_range` (drift-tested). */
export const VISUAL_CONTAINER_FIELD_RANGES: Readonly<Partial<Record<ContainerFieldId, readonly [number, number]>>> =
  Object.freeze({
    "padding.top": [0, L.paddingMax],
    "padding.right": [0, L.paddingMax],
    "padding.bottom": [0, L.paddingMax],
    "padding.left": [0, L.paddingMax],
    "title.headingLevel": [0, HEADING_LEVEL_MAX],
    "title.fontSize": [L.fontSizeMin, L.fontSizeMax],
    "subtitle.fontSize": [L.fontSizeMin, L.fontSizeMax],
    "divider.width": [0, L.dividerWidthMax],
    "spacing.belowTitle": [0, L.spacingMax],
    "spacing.belowSubtitle": [0, L.spacingMax],
    "spacing.belowDivider": [0, L.spacingMax],
    "background.transparency": [0, L.transparencyMax],
    "shadow.transparency": [0, L.transparencyMax],
    "border.width": [0, L.borderWidthMax],
    "border.radius": [0, L.radiusMax],
    "shadow.blur": [0, L.shadowBlurMax],
    "shadow.distance": [0, L.shadowDistanceMax],
  } as const);

/** The inclusive [min, max] of a number / integer field; null for any other field. */
export function containerFieldRange(id: ContainerFieldId): readonly [number, number] | null {
  return VISUAL_CONTAINER_FIELD_RANGES[id] ?? null;
}

// ============================================================================
// Resolved shape (what painters and layout read: every leaf present)
// ============================================================================

/** Who paints which part of the container for a family (the family's provider decides, once). */
export interface ContainerPaintSplit {
  /** "family": the family paints it from the RESOLVED value (shape path, button). */
  background: "core" | "family";
  border: "core" | "family";
  /**
   * "family": chart raster / slicer header / timeline header / FR title bar -- the family paints the title,
   * the subtitle and the divider itself and the layout reserves no band for them. "none": no title at all.
   */
  title: "core" | "family" | "none";
  shadow: "core" | "none";
}
export interface ResolvedVisualText {
  show: boolean; text: string; fontFamily: string; fontSize: number; bold: boolean; italic: boolean;
  underline: boolean; color: string; background: string /* "" = none */; align: VisualTextAlign; wrap: boolean;
}
export interface ResolvedVisualContainer {
  padding: { top: number; right: number; bottom: number; left: number };
  lockAspect: boolean;
  title: ResolvedVisualText & { headingLevel: VisualHeadingLevel };
  subtitle: ResolvedVisualText;
  divider: { show: boolean; color: string; style: VisualLineStyle; width: number; ignorePadding: boolean };
  spacing: { belowTitle: number; belowSubtitle: number; belowDivider: number };
  /** `alpha` = 1 - transparency / 100. */
  background: { show: boolean; color: string; alpha: number; gradient: VisualGradient | null };
  border: { show: boolean; color: string; width: number; radius: number };
  shadow: {
    show: boolean; color: string; alpha: number; offset: "outside" | "inside"; position: VisualShadowPosition;
    blur: number; distance: number;
  };
  paint: ContainerPaintSplit;
}

/** Heading level -> default title font size: 0->14, 1->24, 2->20, 3->16, 4->14, 5->12, 6->11. */
export function headingFontSize(level: VisualHeadingLevel): number {
  switch (level) {
    case 1: return 24;
    case 2: return 20;
    case 3: return 16;
    case 4: return 14;
    case 5: return 12;
    case 6: return 11;
    default: return 14;
  }
}

/** The font stack a container title / subtitle uses unless the family or the user says otherwise. */
export const VISUAL_CONTAINER_DEFAULT_FONT_FAMILY = "'Segoe UI', system-ui, sans-serif";

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/**
 * Power BI-like base the families spread their own defaults over: padding 0, no title / subtitle / divider,
 * an opaque white background, no border, no shadow, everything painted by Core. Deep-frozen -- spread it.
 */
export const BASE_CONTAINER_DEFAULTS: ResolvedVisualContainer = deepFreeze({
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  lockAspect: false,
  title: {
    show: false, text: "", headingLevel: 0, fontFamily: VISUAL_CONTAINER_DEFAULT_FONT_FAMILY,
    fontSize: headingFontSize(0), bold: true, italic: false, underline: false, color: "#252423",
    background: "", align: "left", wrap: true,
  },
  subtitle: {
    show: false, text: "", fontFamily: VISUAL_CONTAINER_DEFAULT_FONT_FAMILY, fontSize: 10, bold: false,
    italic: false, underline: false, color: "#605e5c", background: "", align: "left", wrap: true,
  },
  divider: { show: false, color: "#c8c6c4", style: "solid", width: 1, ignorePadding: false },
  spacing: { belowTitle: 4, belowSubtitle: 4, belowDivider: 8 },
  background: { show: true, color: "#ffffff", alpha: 1, gradient: null },
  border: { show: false, color: "#c8c6c4", width: 1, radius: 0 },
  shadow: {
    show: false, color: "#000000", alpha: 0.3, offset: "outside", position: "bottomRight", blur: 10, distance: 4,
  },
  paint: { background: "core", border: "core", title: "core", shadow: "core" },
} satisfies ResolvedVisualContainer);

// ============================================================================
// Leaf checks (the Rust `check_leaf`, sentence for sentence)
// ============================================================================

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_FAMILY_RE = /^[A-Za-z0-9 ,'-]*$/;

/** "" (the family default) | #rgb | #rrggbb | #rrggbbaa, hex in either case. No names, no url(), no rgb(). */
export function isSafeVisualColor(s: unknown): s is VisualColor {
  return typeof s === "string" && (s === "" || COLOR_RE.test(s));
}

/** At most 64 of [A-Za-z0-9 ,'-] -- so never ";", "(", "url(" or a quote that closes a CSS string. "" ok. */
export function isSafeFontFamily(s: unknown): boolean {
  return typeof s === "string" && s.length <= L.fontFamilyMaxChars && FONT_FAMILY_RE.test(s);
}

const COLOUR_RULE = "must be empty or a #rgb, #rrggbb or #rrggbbaa colour.";

function isFontFamilyField(id: ContainerFieldId): boolean {
  return id.endsWith(".fontFamily");
}

/** The refusal sentence for a field's value (`label` = the dotted id, or a control's flat key). */
function leafRefusal(label: string, id: ContainerFieldId): string {
  const ty = VISUAL_CONTAINER_FIELD_TYPES[id];
  if (ty === "number" || ty === "integer") {
    const [min, max] = containerFieldRange(id) ?? [-Number.MAX_VALUE, Number.MAX_VALUE];
    const kind = ty === "integer" ? "a whole number" : "a number";
    return `${label} must be ${kind} from ${String(min)} to ${String(max)}.`;
  }
  if (ty === "boolean") return `${label} must be true or false.`;
  if (ty === "color") return `${label} ${COLOUR_RULE}`;
  if (ty === "text") {
    return isFontFamilyField(id)
      ? `${label} must be at most ${L.fontFamilyMaxChars} letters, digits, spaces, commas, apostrophes or hyphens.`
      : `${label} must be text of at most ${L.textMaxChars} characters.`;
  }
  return `${label} must be one of: ${ty.enum.join(", ")}.`;
}

function leafOk(id: ContainerFieldId, v: unknown): boolean {
  const ty = VISUAL_CONTAINER_FIELD_TYPES[id];
  if (ty === "number" || ty === "integer") {
    const range = containerFieldRange(id);
    return (
      typeof v === "number" && Number.isFinite(v) && range !== null && v >= range[0] && v <= range[1] &&
      (ty !== "integer" || Number.isInteger(v))
    );
  }
  if (ty === "boolean") return typeof v === "boolean";
  if (ty === "color") return isSafeVisualColor(v);
  if (ty === "text") {
    return isFontFamilyField(id) ? isSafeFontFamily(v) : typeof v === "string" && v.length <= L.textMaxChars;
  }
  return typeof v === "string" && ty.enum.includes(v);
}

/** THE leaf rule: null when `value` is a valid value of field `id`, else the refusal sentence. */
export function checkContainerFieldValue(id: ContainerFieldId, value: unknown, label: string = id): string | null {
  return leafOk(id, value) ? null : leafRefusal(label, id);
}

/** Stops / offsets / colours of a gradient, the Rust `validate_gradient` sentences (stop n counts from 1). */
export function validateVisualGradient(g: unknown): string | null {
  if (!isPlainObject(g)) return "background.gradient must be an object with a type and stops.";
  for (const key of Object.keys(g)) {
    if (key !== "type" && key !== "direction" && key !== "stops") {
      return `background.gradient.${key} is not a visual container field.`;
    }
  }
  if (!(GRADIENT_TYPE_VALUES as readonly unknown[]).includes(g.type)) {
    return `background.gradient type must be one of: ${GRADIENT_TYPE_VALUES.join(", ")}.`;
  }
  if (g.direction !== undefined && g.direction !== null &&
      !(GRADIENT_DIRECTION_VALUES as readonly unknown[]).includes(g.direction)) {
    return `background.gradient direction must be one of: ${GRADIENT_DIRECTION_VALUES.join(", ")}.`;
  }
  const stops = g.stops;
  if (!Array.isArray(stops) || stops.length < L.gradientStopsMin || stops.length > L.gradientStopsMax) {
    return `background.gradient must have from ${L.gradientStopsMin} to ${L.gradientStopsMax} stops.`;
  }
  for (let i = 0; i < stops.length; i++) {
    const n = i + 1;
    const stop: unknown = stops[i];
    const offset = isPlainObject(stop) ? stop.offset : undefined;
    if (!(typeof offset === "number" && Number.isFinite(offset) && offset >= 0 && offset <= 1)) {
      return `background.gradient stop ${n} offset must be a number from 0 to 1.`;
    }
    const color = isPlainObject(stop) ? stop.color : undefined;
    if (typeof color !== "string" || color === "" || !isSafeVisualColor(color)) {
      return `background.gradient stop ${n} colour must be a #rgb, #rrggbb or #rrggbbaa colour.`;
    }
  }
  return null;
}

// ============================================================================
// Structure helpers
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** group -> its leaves ("title" -> {"show", "text", ...}); built from the field ids. */
const GROUP_LEAVES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const id of VISUAL_CONTAINER_FIELD_IDS) {
    const dot = id.indexOf(".");
    if (dot < 0) continue;
    const group = id.slice(0, dot);
    if (!m.has(group)) m.set(group, new Set());
    m.get(group)!.add(id.slice(dot + 1));
  }
  return m;
})();
const TOP_LEAVES: ReadonlySet<string> = new Set(VISUAL_CONTAINER_FIELD_IDS.filter((id) => !id.includes(".")));

function splitId(id: ContainerFieldId): [string, string | null] {
  const dot = id.indexOf(".");
  return dot < 0 ? [id, null] : [id.slice(0, dot), id.slice(dot + 1)];
}

/** The raw value at a field id of a container-shaped object (undefined when absent). */
function rawAt(f: Record<string, unknown> | undefined, id: ContainerFieldId): unknown {
  if (!f) return undefined;
  const [group, leaf] = splitId(id);
  if (leaf === null) return f[group];
  const g = f[group];
  return isPlainObject(g) ? g[leaf] : undefined;
}

/**
 * Shared by the container and the patch check: `null` anywhere (a group, a leaf, the gradient) means
 * absent -- Rust reads a JSON null into `None` the same way -- so the two only differ in what applying them
 * does, never in what is valid.
 */
function validateShape(f: unknown): string | null {
  if (f === undefined || f === null) return null;
  if (!isPlainObject(f)) return "The visual container must be an object.";
  for (const key of Object.keys(f)) {
    const leaves = GROUP_LEAVES.get(key);
    if (leaves) {
      const g = f[key];
      if (g === undefined || g === null) continue;
      if (!isPlainObject(g)) return `${key} must be an object.`;
      for (const leaf of Object.keys(g)) {
        if (!leaves.has(leaf) && !(key === "background" && leaf === "gradient")) {
          return `${key}.${leaf} is not a visual container field.`;
        }
      }
    } else if (!TOP_LEAVES.has(key)) {
      return `${key} is not a visual container field.`;
    }
  }
  for (const id of VISUAL_CONTAINER_FIELD_IDS) {
    const v = rawAt(f, id);
    if (v !== undefined && v !== null) {
      const refusal = checkContainerFieldValue(id, v);
      if (refusal) return refusal;
    }
    // The gradient is checked right after background.transparency, as Rust does (struct order).
    if (id === "background.transparency") {
      const bg = f.background;
      const g = isPlainObject(bg) ? bg.gradient : undefined;
      if (g !== undefined && g !== null) {
        const refusal = validateVisualGradient(g);
        if (refusal) return refusal;
      }
    }
  }
  return null;
}

/** Edit-path check: the first bad leaf as a sentence, or null. Same rules and sentences as Rust `validate`. */
export function validateVisualContainer(f: unknown): string | null {
  return validateShape(f);
}

/** The same check for a patch (a `null` leaf / group clears and is always valid). */
export function validateVisualContainerPatch(p: unknown): string | null {
  return validateShape(p);
}

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** True when the container carries nothing (every group absent or empty): such a container is written as NO key. */
export function isEmptyVisualContainer(f: VisualContainerFormat | undefined): boolean {
  if (!f) return true;
  for (const val of Object.values(f as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    if (!isPlainObject(val)) return false;
    if (Object.values(val).some((leaf) => leaf !== undefined && leaf !== null)) return false;
  }
  return true;
}

/**
 * Apply a patch (does not mutate `f`). A leaf `null` clears the leaf, a group `null` clears the group, an
 * emptied group is dropped, and the result is `undefined` when nothing is left (so the record carries no
 * key). Keys the schema does not know are ignored -- `validateVisualContainerPatch` refuses them first.
 */
export function applyVisualContainerPatch(
  f: VisualContainerFormat | undefined,
  p: VisualContainerPatch,
): VisualContainerFormat | undefined {
  const out: Record<string, unknown> = cloneJson((f ?? {}) as Record<string, unknown>);
  for (const [key, val] of Object.entries((p ?? {}) as Record<string, unknown>)) {
    if (val === undefined) continue;
    if (TOP_LEAVES.has(key)) {
      if (val === null) delete out[key];
      else out[key] = cloneJson(val);
      continue;
    }
    if (!GROUP_LEAVES.has(key)) continue;
    if (val === null || !isPlainObject(val)) {
      if (val === null) delete out[key];
      continue;
    }
    const group: Record<string, unknown> = isPlainObject(out[key]) ? { ...(out[key] as Record<string, unknown>) } : {};
    for (const [leaf, leafVal] of Object.entries(val)) {
      if (leafVal === undefined) continue;
      if (leafVal === null) delete group[leaf];
      else group[leaf] = cloneJson(leafVal);
    }
    out[key] = group;
  }
  // Drop null leaves and empty groups left by the patch or carried in from `f`.
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (val === undefined || val === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(val)) {
      for (const leaf of Object.keys(val)) {
        if (val[leaf] === undefined || val[leaf] === null) delete val[leaf];
      }
      if (Object.keys(val).length === 0) delete out[key];
    }
  }
  return Object.keys(out).length === 0 ? undefined : (out as VisualContainerFormat);
}

/** The stored value of one field (undefined when absent). */
export function readContainerField(f: VisualContainerFormat | undefined, id: ContainerFieldId): unknown {
  return rawAt(f as Record<string, unknown> | undefined, id);
}

/** The patch that sets one field (`null` / `undefined` = clear it). */
export function containerFieldPatch(id: ContainerFieldId, value: unknown | null): VisualContainerPatch {
  const v = value === undefined ? null : value;
  const [group, leaf] = splitId(id);
  const patch: Record<string, unknown> = leaf === null ? { [group]: v } : { [group]: { [leaf]: v } };
  return patch as VisualContainerPatch;
}

// ============================================================================
// A solid background commit (round 2, owner finding G1)
// ============================================================================

/** What a solid-colour commit is compared against: the stored container and the family-resolved one. */
export interface SolidBackgroundBase {
  stored: VisualContainerFormat | undefined;
  resolved: Pick<ResolvedVisualContainer, "background"> | undefined;
}

function storedBackground(base: SolidBackgroundBase): Record<string, unknown> | undefined {
  const bg = (base.stored as Record<string, unknown> | undefined)?.background;
  return isPlainObject(bg) ? bg : undefined;
}

/** A gradient is stored, or resolves (the family's default), so it would paint over a solid colour. */
function backgroundHasGradient(base: SolidBackgroundBase): boolean {
  const stored = storedBackground(base)?.gradient;
  if (stored !== undefined && stored !== null) return true;
  const resolved = base.resolved?.background.gradient;
  return resolved !== undefined && resolved !== null;
}

/** The background is switched off: stored `show:false`, or a family whose resolved show is false. */
function backgroundIsHidden(base: SolidBackgroundBase): boolean {
  return storedBackground(base)?.show === false || base.resolved?.background.show === false;
}

/**
 * The patch that sets the container background to ONE solid colour: `{ background: { color } }`, plus
 * `gradient: null` when a gradient is stored OR resolved, and `show: true` when the resolved show is false
 * (stored false, or a family whose default is false -- a floating grid). Picking a colour means "paint this
 * colour", so a gradient left over from the Fill card, or a background switched off, would make the pick a
 * write that shows nothing (owner finding G1). With `base` undefined the patch is UNCONDITIONAL:
 * `{ background: { color, show: true, gradient: null } }` (the chart style preset form).
 * `color` null = back to the family default: only `{ background: { color: null } }` -- never touches show or
 * the gradient. The Rust literal door (`object_bindings/container_literal.rs`) applies the same rule to
 * script, MCP and binding-literal writes.
 */
export function solidBackgroundPatch(color: string | null, base?: SolidBackgroundBase): VisualContainerPatch {
  if (color === null) return { background: { color: null } };
  if (base === undefined) return { background: { color, show: true, gradient: null } };
  const background: NonNullable<Exclude<VisualContainerPatch["background"], null>> = { color };
  if (backgroundIsHidden(base)) background.show = true;
  if (backgroundHasGradient(base)) background.gradient = null;
  return { background };
}

/**
 * True when committing `color` would change nothing: the colour that shows (the stored literal when there is
 * one, else the resolved colour) is the same colour, the background is not switched off, and no gradient is
 * stored or resolved. The ONE no-op test of a solid background commit.
 */
export function solidBackgroundIsNoop(color: string, base: SolidBackgroundBase): boolean {
  if (backgroundIsHidden(base) || backgroundHasGradient(base)) return false;
  const stored = storedBackground(base)?.color;
  const shown = typeof stored === "string" && stored !== "" ? stored : base.resolved?.background.color;
  return typeof shown === "string" && shown.trim().toLowerCase() === color.trim().toLowerCase();
}

/** "title.fontSize" -> "/title/fontSize": the pointer of a field INSIDE the container (WP-D catalog suffix). */
export function containerFieldPointer(id: ContainerFieldId): string {
  return "/" + id.split(".").join("/");
}

/** "/title/fontSize" -> "title.fontSize"; null when the pointer is not a container field. */
export function containerFieldIdOfPointer(pointer: string): ContainerFieldId | null {
  const id = pointer.replace(/^\//, "").split("/").join(".");
  return (VISUAL_CONTAINER_FIELD_IDS as readonly string[]).includes(id) ? (id as ContainerFieldId) : null;
}

// ============================================================================
// Resolution: bound > stored > defaults, per leaf
// ============================================================================

/**
 * PRECEDENCE: bound > stored > defaults, per leaf. A binding is an overlay over the literal kept in the record
 * (DECISIONS D-BIND), so a bound leaf wins over the stored literal; a bound value that fails its leaf check
 * (or is pending / an error, WP-D `overlayResolved` rules -- the caller leaves those out of `bound`) is
 * IGNORED -- the stored literal (else the default) shows, and the caller reports the error on the row. Never
 * painted. A stored value that fails its leaf check is ignored the same way (Rust sanitizes on load, so that
 * is belt and braces).
 *
 * A colour `""` is "the family default" wherever it comes from, so it resolves to the DEFAULT (not to the
 * next source). `title.fontSize` absent everywhere follows an explicitly chosen `title.headingLevel`
 * (`headingFontSize`). `spacing.*` apply only while `spacing.custom` resolves true; otherwise the family's
 * spacing shows. `background.gradient` is not a field: the stored one (when valid) else the default.
 */
export function resolveVisualContainer(
  stored: VisualContainerFormat | undefined,
  defaults: ResolvedVisualContainer,
  bound?: ReadonlyMap<ContainerFieldId, unknown>,
): ResolvedVisualContainer {
  const s = stored as Record<string, unknown> | undefined;
  /** The winning value for a field, or undefined = the default. */
  const pick = (id: ContainerFieldId): unknown => {
    if (bound && bound.has(id)) {
      const b = bound.get(id);
      if (b !== undefined && b !== null && leafOk(id, b)) return colourDefault(id, b);
    }
    const v = rawAt(s, id);
    if (v !== undefined && v !== null && leafOk(id, v)) return colourDefault(id, v);
    return undefined;
  };
  const num = (id: ContainerFieldId, d: number): number => {
    const v = pick(id);
    return typeof v === "number" ? v : d;
  };
  const bool = (id: ContainerFieldId, d: boolean): boolean => {
    const v = pick(id);
    return typeof v === "boolean" ? v : d;
  };
  const str = <T extends string>(id: ContainerFieldId, d: T): T => {
    const v = pick(id);
    return typeof v === "string" ? (v as T) : d;
  };
  const text = (prefix: "title" | "subtitle", d: ResolvedVisualText, fontSizeDefault: number): ResolvedVisualText => ({
    show: bool(`${prefix}.show`, d.show),
    text: str(`${prefix}.text`, d.text),
    fontFamily: str(`${prefix}.fontFamily`, d.fontFamily),
    fontSize: num(`${prefix}.fontSize`, fontSizeDefault),
    bold: bool(`${prefix}.bold`, d.bold),
    italic: bool(`${prefix}.italic`, d.italic),
    underline: bool(`${prefix}.underline`, d.underline),
    color: str(`${prefix}.color`, d.color),
    background: str(`${prefix}.background`, d.background),
    align: str(`${prefix}.align`, d.align),
    wrap: bool(`${prefix}.wrap`, d.wrap),
  });

  const pickedLevel = pick("title.headingLevel");
  const headingLevel = (typeof pickedLevel === "number" ? pickedLevel : defaults.title.headingLevel) as VisualHeadingLevel;
  const titleFontDefault = typeof pickedLevel === "number" ? headingFontSize(headingLevel) : defaults.title.fontSize;

  const custom = bool("spacing.custom", false);
  const spacing = custom
    ? {
        belowTitle: num("spacing.belowTitle", defaults.spacing.belowTitle),
        belowSubtitle: num("spacing.belowSubtitle", defaults.spacing.belowSubtitle),
        belowDivider: num("spacing.belowDivider", defaults.spacing.belowDivider),
      }
    : { ...defaults.spacing };

  const bgTransparency = pick("background.transparency");
  const shadowTransparency = pick("shadow.transparency");
  const storedGradient = isPlainObject(s?.background) ? (s!.background as Record<string, unknown>).gradient : undefined;
  const gradient =
    storedGradient !== undefined && storedGradient !== null && validateVisualGradient(storedGradient) === null
      ? cloneJson(storedGradient as VisualGradient)
      : cloneJson(defaults.background.gradient);

  return {
    padding: {
      top: num("padding.top", defaults.padding.top),
      right: num("padding.right", defaults.padding.right),
      bottom: num("padding.bottom", defaults.padding.bottom),
      left: num("padding.left", defaults.padding.left),
    },
    lockAspect: bool("lockAspect", defaults.lockAspect),
    title: { ...text("title", defaults.title, titleFontDefault), headingLevel },
    subtitle: text("subtitle", defaults.subtitle, defaults.subtitle.fontSize),
    divider: {
      show: bool("divider.show", defaults.divider.show),
      color: str("divider.color", defaults.divider.color),
      style: str("divider.style", defaults.divider.style),
      width: num("divider.width", defaults.divider.width),
      ignorePadding: bool("divider.ignorePadding", defaults.divider.ignorePadding),
    },
    spacing,
    background: {
      show: bool("background.show", defaults.background.show),
      color: str("background.color", defaults.background.color),
      alpha: typeof bgTransparency === "number" ? 1 - bgTransparency / 100 : defaults.background.alpha,
      gradient: gradient ?? null,
    },
    border: {
      show: bool("border.show", defaults.border.show),
      color: str("border.color", defaults.border.color),
      width: num("border.width", defaults.border.width),
      radius: num("border.radius", defaults.border.radius),
    },
    shadow: {
      show: bool("shadow.show", defaults.shadow.show),
      color: str("shadow.color", defaults.shadow.color),
      alpha: typeof shadowTransparency === "number" ? 1 - shadowTransparency / 100 : defaults.shadow.alpha,
      offset: str("shadow.offset", defaults.shadow.offset),
      position: str("shadow.position", defaults.shadow.position),
      blur: num("shadow.blur", defaults.shadow.blur),
      distance: num("shadow.distance", defaults.shadow.distance),
    },
    paint: { ...defaults.paint },
  };
}

/** A colour "" means "the family default": answer undefined so the default shows. */
function colourDefault(id: ContainerFieldId, v: unknown): unknown {
  return VISUAL_CONTAINER_FIELD_TYPES[id] === "color" && v === "" ? undefined : v;
}

// ============================================================================
// Layout (sheet px, logical)
// ============================================================================

export interface ContainerRect { x: number; y: number; width: number; height: number }
export interface VisualContainerLayout {
  outer: ContainerRect;
  /** Core-painted titles only (paint.title === "core"). */
  titleRect: ContainerRect | null;
  subtitleRect: ContainerRect | null;
  /** The divider's centre line. */
  divider: { y: number; x0: number; x1: number } | null;
  /** What the family lays out and hit-tests in (never a negative size). */
  content: ContainerRect;
  titleLines: number;
  subtitleLines: number;
}

/** The height of one line of container text: Math.ceil(fontSize * 1.25). */
export function lineHeightFor(fontSize: number): number {
  return Math.ceil(fontSize * 1.25);
}

/** The width a border takes inside the outer rect (0 when the border is hidden or painted by the family). */
export function containerBorderInset(c: ResolvedVisualContainer): number {
  return c.border.show && c.border.width > 0 ? c.border.width : 0;
}

function clampLines(n: number | undefined, wrap: boolean): number {
  if (!wrap) return 1;
  if (n === undefined || !Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

/**
 * Lay the container out. `lines` comes from a measured paint (`measureVisualContainerLayout`); absent = 1 line
 * each (the pre-paint answer). Pure.
 *
 * - The border band (`border.width` while shown, whoever paints it) and then the padding are inset from
 *   `outer`, giving the inner box.
 * - Only a Core-painted title (`paint.title === "core"`) takes space: the title band (`titleLines` x
 *   `lineHeightFor(title.fontSize)`) + `spacing.belowTitle`, then the subtitle band + `spacing.belowSubtitle`,
 *   then the divider (`divider.width`) + `spacing.belowDivider`, each only while shown. A family-painted
 *   title ("family") or none ("none") reserves nothing: the family lays its own out inside the content.
 * - The divider spans the inner box, or the border-inset box with `ignorePadding`.
 * - `content` is what is left below, clamped so no size is ever negative.
 */
export function layoutVisualContainer(
  outer: ContainerRect,
  c: ResolvedVisualContainer,
  lines?: { title: number; subtitle: number },
): VisualContainerLayout {
  const b = containerBorderInset(c);
  const framedX = outer.x + b;
  const framedW = Math.max(0, outer.width - 2 * b);
  const innerX = framedX + c.padding.left;
  const innerY = outer.y + b + c.padding.top;
  const innerW = Math.max(0, framedW - c.padding.left - c.padding.right);
  const innerBottom = Math.max(innerY, outer.y + outer.height - b - c.padding.bottom);

  let y = innerY;
  let titleRect: ContainerRect | null = null;
  let subtitleRect: ContainerRect | null = null;
  let divider: VisualContainerLayout["divider"] = null;
  let titleLines = 0;
  let subtitleLines = 0;

  if (c.paint.title === "core") {
    if (c.title.show) {
      titleLines = clampLines(lines?.title, c.title.wrap);
      const h = titleLines * lineHeightFor(c.title.fontSize);
      titleRect = { x: innerX, y, width: innerW, height: h };
      y += h + c.spacing.belowTitle;
    }
    if (c.subtitle.show) {
      subtitleLines = clampLines(lines?.subtitle, c.subtitle.wrap);
      const h = subtitleLines * lineHeightFor(c.subtitle.fontSize);
      subtitleRect = { x: innerX, y, width: innerW, height: h };
      y += h + c.spacing.belowSubtitle;
    }
    if (c.divider.show) {
      const x0 = c.divider.ignorePadding ? framedX : innerX;
      const x1 = c.divider.ignorePadding ? framedX + framedW : innerX + innerW;
      divider = { y: y + c.divider.width / 2, x0, x1 };
      y += c.divider.width + c.spacing.belowDivider;
    }
  }

  const contentY = Math.min(y, innerBottom);
  return {
    outer: { ...outer },
    titleRect,
    subtitleRect,
    divider,
    content: { x: innerX, y: contentY, width: innerW, height: Math.max(0, innerBottom - contentY) },
    titleLines,
    subtitleLines,
  };
}

// ============================================================================
// Interchange: the draft-07 JSON-Schema fragment (chartSpecSchema embeds it)
// ============================================================================

function fieldSchema(id: ContainerFieldId): Record<string, unknown> {
  const ty = VISUAL_CONTAINER_FIELD_TYPES[id];
  const range = containerFieldRange(id);
  if (ty === "number" || ty === "integer") {
    return { type: ty, minimum: range![0], maximum: range![1] };
  }
  if (ty === "boolean") return { type: "boolean" };
  if (ty === "color") {
    return { type: "string", pattern: "^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$" };
  }
  if (ty === "text") {
    return isFontFamilyField(id)
      ? { type: "string", pattern: `^[A-Za-z0-9 ,'-]{0,${L.fontFamilyMaxChars}}$` }
      : { type: "string", maxLength: L.textMaxChars };
  }
  return { type: "string", enum: [...ty.enum] };
}

const GRADIENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["type", "stops"],
  properties: {
    type: { type: "string", enum: [...GRADIENT_TYPE_VALUES] },
    direction: { type: "string", enum: [...GRADIENT_DIRECTION_VALUES] },
    stops: {
      type: "array",
      minItems: L.gradientStopsMin,
      maxItems: L.gradientStopsMax,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["offset", "color"],
        properties: {
          offset: { type: "number", minimum: 0, maximum: 1 },
          color: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" },
        },
      },
    },
  },
};

/** draft-07 fragment, `additionalProperties: false` at every level; built from the field table. */
export const VISUAL_CONTAINER_JSON_SCHEMA: Record<string, unknown> = deepFreeze((() => {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const id of VISUAL_CONTAINER_FIELD_IDS) {
    const [group, leaf] = splitId(id);
    if (leaf === null) {
      properties[group] = fieldSchema(id);
      continue;
    }
    if (!properties[group]) properties[group] = { type: "object", additionalProperties: false, properties: {} };
    (properties[group].properties as Record<string, unknown>)[leaf] = fieldSchema(id);
  }
  (properties.background.properties as Record<string, unknown>).gradient = GRADIENT_JSON_SCHEMA;
  return {
    type: "object",
    description:
      "The visual container: padding, title, subtitle, divider, spacing, background, border and shadow " +
      "around the object's content. Sparse: an absent leaf is the family default.",
    additionalProperties: false,
    properties,
  };
})());

// ============================================================================
// Controls: the one flat-key map (D-FORMAT "control background = fill, border = outline")
// ============================================================================

/** "title.fontSize" -> "containerTitleFontSize". */
function containerKeyOf(id: ContainerFieldId): string {
  return "container" + id.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/**
 * Every flat key a control may carry for the container that is NOT an existing control key (fill, stroke,
 * strokeWidth, borderColor are existing keys and are NOT in this list). Index for index with
 * VISUAL_CONTAINER_FIELD_IDS (Rust `CONTROL_CONTAINER_PROPERTY_KEYS`, drift-tested). Spread into
 * SCRIPT_SHAPE_PROPERTY_KEYS. Spelling rule: "container" + PascalCase of the dotted id.
 */
export const CONTROL_CONTAINER_PROPERTY_KEYS: readonly string[] = Object.freeze(
  VISUAL_CONTAINER_FIELD_IDS.map(containerKeyOf),
);

/** The field a control's flat container key stands for ("containerTitleFontSize" -> "title.fontSize"). */
export function controlContainerKeyField(key: string): ContainerFieldId | null {
  const i = CONTROL_CONTAINER_PROPERTY_KEYS.indexOf(key);
  return i < 0 ? null : VISUAL_CONTAINER_FIELD_IDS[i];
}

/** Control kinds whose background / border are their own paint keys (fill / stroke / borderColor). */
const PAINTED_CONTROL_TYPES: ReadonlySet<string> = new Set(["shape", "textBox", "button", "image"]);

/**
 * ContainerFieldId -> the control property key that stores it, per control family (the provider is the only
 * reader/writer); null for a control kind with no container.
 *
 * | field              | shape / textBox / image             | button          | pageNavigator               |
 * |--------------------|-------------------------------------|-----------------|-----------------------------|
 * | background.color   | fill                                | fill            | containerBackgroundColor    |
 * | background.show    | fill (DERIVED: "none" when false)   | fill            | containerBackgroundShow     |
 * | border.color       | stroke                              | borderColor     | containerBorderColor        |
 * | border.width       | strokeWidth                         | strokeWidth     | containerBorderWidth        |
 * | border.show        | strokeWidth (DERIVED: "0" if false) | strokeWidth     | containerBorderShow         |
 * | padding.*          | containerPadding<Side>              | same            | padding (WP-B's key, READ-ONLY here) |
 * | everything else    | container<Field>                    | same            | same                        |
 */
export function controlContainerKey(controlType: string, field: ContainerFieldId): string | null {
  const navigator = controlType === PAGE_NAVIGATOR_CONTROL_TYPE;
  if (!navigator && !PAINTED_CONTROL_TYPES.has(controlType)) return null;
  if (navigator) {
    if (field.startsWith("padding.")) return "padding";
    return containerKeyOf(field);
  }
  switch (field) {
    case "background.color":
    case "background.show":
      return "fill";
    case "border.color":
      return controlType === "button" ? "borderColor" : "stroke";
    case "border.width":
    case "border.show":
      return "strokeWidth";
    default:
      return containerKeyOf(field);
  }
}

/** `^-?\d+(\.\d+)?([eE][+-]?\d+)?$` -- a plain decimal as String(n) writes it (Rust `parse_plain_number`). */
const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * A control's flat container key -> null, or the refusal sentence naming the key, for its value STRING (the
 * Rust `check_control_container_value`, sentence for sentence). Keys outside CONTROL_CONTAINER_PROPERTY_KEYS
 * are not ours -> null. "" is fine for every key (the family default). Booleans are exactly "true" / "false";
 * numbers are plain decimals (no hex, no Infinity / NaN, no spaces).
 */
export function checkControlContainerValue(key: string, value: string): string | null {
  const id = controlContainerKeyField(key);
  if (id === null || value === "") return null;
  const ty = VISUAL_CONTAINER_FIELD_TYPES[id];
  let v: unknown;
  if (ty === "number" || ty === "integer") {
    const n = PLAIN_NUMBER_RE.test(value) ? Number(value) : NaN;
    v = Number.isFinite(n) ? n : null;
  } else if (ty === "boolean") {
    v = value === "true" ? true : value === "false" ? false : null;
  } else {
    v = value;
  }
  return checkContainerFieldValue(id, v, key);
}
