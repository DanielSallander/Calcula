//! FILENAME: app/extensions/Controls/lib/controlContainerDefaults.ts
// PURPOSE: The PURE half of a control's visual container (WP-C D-FORMAT): which
//          container a control kind has, what it looks like by default, what
//          the Format pane may offer for it, how its STORED container is read
//          from the control's flat property keys, and which flat keys a
//          container patch writes.
// CONTEXT: ONE SPELLING PER FACT (D-FORMAT "control background = fill, border
//          = outline"). A control keeps every container fact in a FLAT
//          property key -- `@api/visualContainer`'s `controlContainerKey` is
//          the one map: a shape's, a button's and a picture's background IS its
//          `fill`, its border colour IS its `stroke` (a button's
//          `borderColor`), its border width IS its `strokeWidth`; the rest are
//          `container<Field>` keys. `background.show` / `border.show` have no
//          key of their own: a fill of "none" is a hidden background and a
//          stroke width of "0" a hidden border. A Page Navigator is different
//          (C3): `fill` / `color` / `borderColor` style its ITEMS, so its
//          container lives entirely in `container*` keys, and its padding IS
//          WP-B's `padding` key -- read here, never written (WP-B's Properties
//          row is its one editor).
//
//          WHO PAINTS WHAT. A shape and a button paint their own background
//          and border from those keys (the shape path, the button face:
//          `paint.background` / `paint.border` "family"), the background faded
//          by its `containerBackgroundTransparency` key; Core paints a
//          picture's and a navigator's (`"core"`), and every title, subtitle,
//          divider and shadow. A button has no title (`paint.title` "none").
//
//          Nothing here reads a store, a cache or the backend.

import {
  BASE_CONTAINER_DEFAULTS,
  VISUAL_CONTAINER_FIELD_IDS,
  VISUAL_CONTAINER_FIELD_TYPES,
  applyVisualContainerPatch,
  containerFieldPatch,
  controlContainerKey,
  isSafeVisualColor,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import type { ContainerCapabilities } from "@api/objectFormat";
import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";
import {
  DEFAULT_SHAPE_RECIPE_PAINT,
  TEXT_BOX_RECIPE_PAINT,
  TEXT_BOX_SHAPE_TYPE,
  isNoPaint,
  parseStrokeWidth,
} from "../Shape/shapeRecipe";
import { pageNavigatorContainerDefaults, readPageNavigatorProps } from "../PageNavigator/navigatorModel";
import type { ControlAppearanceWrite } from "./types";

// ============================================================================
// Kinds
// ============================================================================

/** The container families a control can be (a text box is a shape whose `shapeType` is "textBox"). */
export type ControlContainerKind = "shape" | "textBox" | "button" | "image" | "pageNavigator";

/** Every kind, in the order the binding table lists them. */
export const CONTROL_CONTAINER_KINDS: readonly ControlContainerKind[] = [
  "shape",
  "textBox",
  "button",
  "image",
  "pageNavigator",
];

/** The container kind of a control, or null for a kind with no container (a checkbox, an unknown kind). */
export function controlContainerKind(controlType: string, shapeType?: string | null): ControlContainerKind | null {
  switch (controlType) {
    case "shape":
      return shapeType === TEXT_BOX_SHAPE_TYPE ? "textBox" : "shape";
    case "textBox":
      return "textBox";
    case "button":
      return "button";
    case "image":
      return "image";
    case PAGE_NAVIGATOR_CONTROL_TYPE:
      return "pageNavigator";
    default:
      return null;
  }
}

/** The control type `controlContainerKey` is asked with for a kind. */
function keyTypeOf(kind: ControlContainerKind): string {
  return kind === "pageNavigator" ? PAGE_NAVIGATOR_CONTROL_TYPE : kind;
}

// ============================================================================
// Paint defaults (the family's own keys)
// ============================================================================

/** A painted kind's background / border keys and what a fresh control of that kind holds in them. */
interface ControlPaintDefaults {
  /** The stored `fill` a new control is written with ("none" = no background). */
  fill: string;
  /** The key that holds the border colour. */
  borderColorKey: "stroke" | "borderColor";
  /** The stored border colour a new control is written with ("none" = no border). */
  borderColor: string;
  /** The stored `strokeWidth` (0 = no border). */
  strokeWidth: number;
  /** The corner radius (a button's face; 0 elsewhere). */
  radius: number;
}

/** A button's face, as `BUTTON_PROPERTIES` and the floating renderer have always drawn it. */
export const BUTTON_PAINT_DEFAULTS: Readonly<ControlPaintDefaults> = Object.freeze({
  fill: "#e0e0e0",
  borderColorKey: "borderColor",
  borderColor: "#999999",
  strokeWidth: 1,
  radius: 3,
});

const PAINT_DEFAULTS: Readonly<Record<Exclude<ControlContainerKind, "pageNavigator">, Readonly<ControlPaintDefaults>>> =
  Object.freeze({
    shape: {
      fill: DEFAULT_SHAPE_RECIPE_PAINT.fill,
      borderColorKey: "stroke",
      borderColor: DEFAULT_SHAPE_RECIPE_PAINT.stroke,
      strokeWidth: parseStrokeWidth(DEFAULT_SHAPE_RECIPE_PAINT.strokeWidth),
      radius: 0,
    },
    textBox: {
      fill: TEXT_BOX_RECIPE_PAINT.fill,
      borderColorKey: "stroke",
      borderColor: TEXT_BOX_RECIPE_PAINT.stroke,
      strokeWidth: parseStrokeWidth(TEXT_BOX_RECIPE_PAINT.strokeWidth),
      radius: 0,
    },
    button: BUTTON_PAINT_DEFAULTS,
    // A picture has no fill and no outline until the user gives it one (Core paints both).
    image: { fill: "none", borderColorKey: "stroke", borderColor: "none", strokeWidth: 0, radius: 0 },
  });

/** The colour a background turned ON gets when the control never had one (a text box, a picture). */
const SHOWN_FILL_FALLBACK = "#ffffff";

/** A real colour (not "", not "none"): what a shown background or border can be painted with. */
function paintableColour(value: string | undefined): string | null {
  return typeof value === "string" && value !== "" && isSafeVisualColor(value) ? value : null;
}

// ============================================================================
// Defaults and capabilities
// ============================================================================

/** The family DEFAULTS of a control kind's container -- today's look on Power BI's base. */
export function controlContainerDefaults(kind: ControlContainerKind): ResolvedVisualContainer {
  if (kind === "pageNavigator") return pageNavigatorContainerDefaults();
  const b = BASE_CONTAINER_DEFAULTS;
  const p = PAINT_DEFAULTS[kind];
  const familyPaint = kind !== "image";
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: { ...b.title },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    spacing: { ...b.spacing },
    background: {
      show: !isNoPaint(p.fill),
      color: paintableColour(p.fill) ?? SHOWN_FILL_FALLBACK,
      alpha: 1,
      gradient: null,
    },
    border: {
      show: p.strokeWidth > 0 && !isNoPaint(p.borderColor),
      color: paintableColour(p.borderColor) ?? b.border.color,
      width: p.strokeWidth > 0 ? p.strokeWidth : b.border.width,
      radius: p.radius,
    },
    shadow: { ...b.shadow },
    paint: {
      background: familyPaint ? "family" : "core",
      border: familyPaint ? "family" : "core",
      title: kind === "button" ? "none" : "core",
      shadow: "core",
    },
  };
}

/**
 * What the Format pane offers for a control kind (WP-C S13):
 *   shape / text box: padding, title, subtitle, divider, background, border, shadow (no corner radius:
 *                     the shape path IS the shape);
 *   button:           background, border, corner radius, shadow (no padding, no title -- its caption is
 *                     its own `text`);
 *   picture:          padding, title, background, border, shadow;
 *   page navigator:   title, background, border, shadow -- and NO padding rows: its `padding` key is WP-B's,
 *                     edited in its Properties tab (one editor per fact, C3).
 * Background transparency on EVERY kind (owner F5: "Background colour + transparency" on every visual): Core
 * fades the background it paints (a picture, a navigator), and a shape's path and a button's face read the
 * same `containerBackgroundTransparency` key (`Shape/shapeRecipe.backgroundAlphaOf`). The corner radius where
 * Core paints the background, and the button's own; never a gradient (it is not a flat key).
 */
export function controlContainerCapabilities(kind: ControlContainerKind): ContainerCapabilities {
  const none: ContainerCapabilities = {
    padding: false,
    lockAspect: true,
    title: false,
    titleText: "none",
    subtitle: false,
    divider: false,
    background: true,
    backgroundTransparency: true,
    gradient: false,
    border: true,
    borderRadius: false,
    shadow: true,
    dataFormat: false,
  };
  switch (kind) {
    case "shape":
    case "textBox":
      return { ...none, padding: true, title: true, titleText: "free", subtitle: true, divider: true };
    case "button":
      return { ...none, borderRadius: true };
    case "image":
      return { ...none, padding: true, title: true, titleText: "free", borderRadius: true };
    case "pageNavigator":
      return { ...none, title: true, titleText: "free", borderRadius: true };
  }
}

/** Whether `capabilities` offers a field (the Format pane's own rule, ObjectPane formatValues.fieldOffered). */
export function controlFieldOffered(c: ContainerCapabilities, id: ContainerFieldId): boolean {
  if (id === "lockAspect") return c.lockAspect;
  const group = id.slice(0, id.indexOf("."));
  switch (group) {
    case "padding":
      return c.padding;
    case "title":
      return c.title && (id !== "title.text" || c.titleText !== "none");
    case "subtitle":
      return c.subtitle;
    case "divider":
      return c.divider;
    case "spacing":
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

/** The sentence a commit of a field the kind does not offer is refused with. */
export function controlFieldRefusal(kind: ControlContainerKind, id: ContainerFieldId): string {
  if (kind === "pageNavigator" && id.startsWith("padding.")) {
    return "A page navigator's padding is its own Padding property: set it in the Properties tab.";
  }
  const what =
    kind === "pageNavigator" ? "A page navigator" : kind === "textBox" ? "A text box" : kind === "image" ? "A picture" : `A ${kind}`;
  return `${what} has no '${id}' format setting.`;
}

// ============================================================================
// Flat keys <-> the stored container
// ============================================================================

/** `^-?\d+(\.\d+)?([eE][+-]?\d+)?$` -- the plain decimal the Rust check accepts. */
const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** A `container*` key's stored string as the field's value, or undefined (absent, "" = default, unreadable). */
function parseFlatValue(id: ContainerFieldId, raw: string | undefined): unknown {
  if (typeof raw !== "string" || raw === "") return undefined;
  const ty = VISUAL_CONTAINER_FIELD_TYPES[id];
  if (ty === "number" || ty === "integer") {
    if (!PLAIN_NUMBER_RE.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (ty === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw;
}

/** A field value as the stored STRING a flat key holds ("" = the family default). */
export function flatValueOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value);
}

/** The fields whose key is the family's own paint key (handled by hand, never as `container*`). */
function isPaintField(kind: ControlContainerKind, id: ContainerFieldId): boolean {
  if (kind === "pageNavigator") return id.startsWith("padding.");
  return id === "background.show" || id === "background.color" || id === "border.show" || id === "border.color" || id === "border.width";
}

/**
 * The STORED container of a control (its literal, sparse), read from its flat
 * property keys. A painted kind's background / border come from its own paint
 * keys (an absent key = what the recipe writes); a navigator's padding is its
 * `padding` key through WP-B's clamp, uniform on all four sides. Pure.
 */
export function readControlContainer(
  kind: ControlContainerKind,
  props: Readonly<Record<string, string | undefined>>,
): VisualContainerFormat {
  let out: VisualContainerFormat | undefined = {};
  const set = (id: ContainerFieldId, value: unknown): void => {
    if (value === undefined) return;
    out = applyVisualContainerPatch(out, containerFieldPatch(id, value)) ?? {};
  };

  const keyType = keyTypeOf(kind);
  for (const id of VISUAL_CONTAINER_FIELD_IDS) {
    if (isPaintField(kind, id)) continue;
    const key = controlContainerKey(keyType, id);
    if (!key) continue;
    set(id, parseFlatValue(id, props[key]));
  }

  if (kind === "pageNavigator") {
    const p = readPageNavigatorProps(props as Record<string, string>).padding;
    for (const side of ["top", "right", "bottom", "left"] as const) set(`padding.${side}`, p);
    return out ?? {};
  }

  const d = PAINT_DEFAULTS[kind];
  const fill = props.fill ?? d.fill;
  set("background.show", !isNoPaint(fill));
  set("background.color", paintableColour(fill) ?? undefined);
  const borderColour = props[d.borderColorKey] ?? d.borderColor;
  const width = parseStrokeWidth(props.strokeWidth, d.strokeWidth);
  set("border.show", width > 0 && !isNoPaint(borderColour));
  set("border.color", paintableColour(borderColour) ?? undefined);
  if (width > 0) set("border.width", width);
  return out ?? {};
}

/** The value a patch gives a field: `{ touched: false }`, or the value (null = cleared to the default). */
function patchValue(patch: VisualContainerPatch, id: ContainerFieldId): { touched: boolean; value: unknown } {
  const p = (patch ?? {}) as Record<string, unknown>;
  const dot = id.indexOf(".");
  if (dot < 0) {
    const v = p[id];
    return v === undefined ? { touched: false, value: undefined } : { touched: true, value: v };
  }
  const group = p[id.slice(0, dot)];
  if (group === undefined) return { touched: false, value: undefined };
  if (group === null) return { touched: true, value: null };
  if (typeof group !== "object") return { touched: false, value: undefined };
  const v = (group as Record<string, unknown>)[id.slice(dot + 1)];
  return v === undefined ? { touched: false, value: undefined } : { touched: true, value: v };
}

/** The fields a patch touches (a `null` group touches every leaf of it), in field order. */
export function touchedContainerFields(patch: VisualContainerPatch): ContainerFieldId[] {
  return VISUAL_CONTAINER_FIELD_IDS.filter((id) => patchValue(patch, id).touched);
}

/** Whether a patch carries a background gradient (a structured value no flat key can hold). */
export function patchHasGradient(patch: VisualContainerPatch): boolean {
  const bg = (patch as { background?: unknown } | undefined)?.background;
  return !!bg && typeof bg === "object" && (bg as { gradient?: unknown }).gradient !== undefined;
}

/**
 * The flat-key writes a container patch makes on a control of `kind` whose
 * CURRENT keys are `props` -- only the keys whose value actually changes, in
 * field order. Pure; the caller has already refused fields the kind does not
 * offer (`controlFieldOffered`).
 *
 *   - `container<Field>` keys: the value as its string (`null` = "" = the family default).
 *   - background (painted kinds): `fill` = "none" when hidden; the colour when one is given; the
 *     recipe's fill when the colour is cleared; a shown background without a colour keeps the current
 *     colour, else the recipe's, else white.
 *   - border (painted kinds): `strokeWidth` = "0" when hidden; a width greater than 0 shows it; a shown
 *     border keeps its width, else the recipe's, else 1; its colour key (`stroke`, a button's
 *     `borderColor`) gets the given colour, the recipe's on a clear, and a real colour when a border is
 *     turned on that never had one.
 *   - a navigator's padding is never written (WP-B's `padding` key is its own editor's).
 */
export function controlContainerWrites(
  kind: ControlContainerKind,
  props: Readonly<Record<string, string | undefined>>,
  patch: VisualContainerPatch,
): ControlAppearanceWrite[] {
  const writes = new Map<string, string>();
  const keyType = keyTypeOf(kind);

  for (const id of VISUAL_CONTAINER_FIELD_IDS) {
    const { touched, value } = patchValue(patch, id);
    if (!touched || isPaintField(kind, id)) continue;
    const key = controlContainerKey(keyType, id);
    if (!key) continue;
    writes.set(key, flatValueOf(value));
  }

  if (kind !== "pageNavigator") {
    const d = PAINT_DEFAULTS[kind];

    // ---- background = fill ----
    const bgShow = patchValue(patch, "background.show");
    const bgColour = patchValue(patch, "background.color");
    if (bgShow.touched || bgColour.touched) {
      const currentFill = props.fill ?? d.fill;
      const shownFill = paintableColour(currentFill) ?? paintableColour(d.fill) ?? SHOWN_FILL_FALLBACK;
      const given = typeof bgColour.value === "string" && bgColour.value !== "" ? bgColour.value : null;
      let fill: string;
      if (bgShow.touched && bgShow.value === false) fill = "none";
      else if (given !== null) fill = given;
      else if (bgShow.touched && bgShow.value === true) fill = shownFill;
      // The colour (or the show) cleared to the default: what the recipe wrote.
      else fill = d.fill;
      writes.set("fill", fill);
    }

    // ---- border = stroke / borderColor + strokeWidth ----
    const bShow = patchValue(patch, "border.show");
    const bColour = patchValue(patch, "border.color");
    const bWidth = patchValue(patch, "border.width");
    if (bShow.touched || bColour.touched || bWidth.touched) {
      const currentColour = props[d.borderColorKey] ?? d.borderColor;
      const currentWidth = parseStrokeWidth(props.strokeWidth, d.strokeWidth);
      const currentShow = currentWidth > 0 && !isNoPaint(currentColour);
      const defaultWidth = d.strokeWidth > 0 ? d.strokeWidth : 1;
      const givenWidth = typeof bWidth.value === "number" && Number.isFinite(bWidth.value) ? bWidth.value : null;

      let show: boolean;
      if (bShow.touched) {
        show = bShow.value === null ? d.strokeWidth > 0 && !isNoPaint(d.borderColor) : bShow.value === true;
      } else if (bWidth.touched && givenWidth !== null) {
        show = givenWidth > 0;
      } else {
        show = currentShow;
      }

      // The width is written only when the show or the width was asked for: a
      // colour alone changes the colour.
      if (bShow.touched || bWidth.touched) {
        if (show) {
          let width: number;
          if (bWidth.touched) width = givenWidth !== null && givenWidth > 0 ? givenWidth : defaultWidth;
          else width = currentWidth > 0 ? currentWidth : defaultWidth;
          writes.set("strokeWidth", flatValueOf(width));
        } else {
          writes.set("strokeWidth", "0");
        }
      }

      if (bColour.touched) {
        const given = typeof bColour.value === "string" && bColour.value !== "" ? bColour.value : null;
        writes.set(d.borderColorKey, given ?? (show ? paintableColour(d.borderColor) ?? BASE_CONTAINER_DEFAULTS.border.color : d.borderColor));
      } else if (show && !paintableColour(currentColour)) {
        writes.set(d.borderColorKey, paintableColour(d.borderColor) ?? BASE_CONTAINER_DEFAULTS.border.color);
      }
    }
  }

  const out: ControlAppearanceWrite[] = [];
  for (const [key, value] of writes) {
    if ((props[key] ?? "") === value) continue;
    out.push({ key, value });
  }
  return out;
}
