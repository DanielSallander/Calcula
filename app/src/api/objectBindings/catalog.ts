//! FILENAME: app/src/api/objectBindings/catalog.ts
// PURPOSE: The TS MIRROR of the bindable-path catalog: which property of which
//          kind of object may carry a binding, what type its value has, and
//          which of the family's literal gates a binding on it passes.
// CONTEXT: Rust is the AUTHORITY (app/src-tauri/src/object_bindings/catalog.rs).
//          This mirror exists for the UI (which rows offer an fx button) and
//          for the STATELESS script validator; neither may be laxer than Rust,
//          and Rust refuses at its own door regardless.
//          `objectBindingsCatalogDrift.test.ts` parses the Rust table line by
//          line and diffs it both ways against `BINDABLE_PATHS` below, and pins
//          the never-bindable control keys and the container roots too (the
//          direction is Rust -> TS, the interpreterReachDrift precedent).
//
//          The never-bindable control keys are BUILT from the TS constants
//          that already mirror the Rust lists (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`
//          = executable + held, `HELD_CONTROL_PROPERTIES`,
//          `BUTTON_ACTION_PROPERTY_KEYS`), read LAZILY: the script validator
//          will import this module (D §3.19), and a module-scope read of its
//          constant here would be a TDZ error the moment that cycle closes.
//
//          Seams point one way: this file imports nothing from app/extensions.

import type { ObjectBindingKind } from "../types";
import { BUTTON_ACTION_PROPERTY_KEYS } from "../buttonControlService";
import { HELD_CONTROL_PROPERTIES } from "../heldButtonCode";
import { SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS } from "../scriptHost/validators";

/** Every kind, in the Rust enum's order (`ObjectBindingKind::ALL`). */
export const OBJECT_BINDING_KINDS: readonly ObjectBindingKind[] = [
  "chart",
  "control",
  "slicer",
  "timelineSlicer",
  "pivot",
  "floatingRange",
  "canvasPage",
];

/** How a sentence names a kind (Rust `ObjectBindingKind::label`). */
export const OBJECT_BINDING_KIND_LABELS: Readonly<Record<ObjectBindingKind, string>> = {
  chart: "chart",
  control: "control",
  slicer: "slicer",
  timelineSlicer: "timeline slicer",
  pivot: "PivotTable",
  floatingRange: "floating range",
  canvasPage: "canvas page",
};

/** Is `kind` a binding kind this build knows? */
export function isObjectBindingKind(kind: unknown): kind is ObjectBindingKind {
  return typeof kind === "string" && (OBJECT_BINDING_KINDS as readonly string[]).includes(kind);
}

/** The type a bound property's resolved value is coerced to (Rust `BindableValueType`). */
export type BindableValueType =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "color"
  | "media"
  | "scalar"
  | { enum: readonly string[] };

/** One bindable path (Rust `BindablePathSpec`). */
export interface BindablePathSpec {
  kind: ObjectBindingKind;
  /** RFC 6901 pointer pattern; a `*` segment matches one segment. */
  pointer: string;
  valueType: BindableValueType;
  /** The object family's own record, or the shared visual container (WP-C). */
  origin: "family" | "container";
  /** Set/Clear pass the family's editObjects protection gate. */
  protectEditObjects: boolean;
  /** Set/Clear pass the canvas's Lock Objects gate. */
  lockObjectsPosition: boolean;
}

function row(
  kind: ObjectBindingKind,
  pointer: string,
  valueType: BindableValueType,
  origin: "family" | "container",
  protectEditObjects: boolean,
  lockObjectsPosition: boolean,
): BindablePathSpec {
  return Object.freeze({ kind, pointer, valueType, origin, protectEditObjects, lockObjectsPosition });
}

/**
 * The catalog, in the Rust table's order (the drift test compares order too).
 * ONE ROW PER LINE. Change catalog.rs first; the drift test then names what
 * this table must become. The visual container rows (WP-C S7b: `"container"`
 * rows under each kind's CONTAINER_ROOT_POINTER, and a control's exact
 * `/properties/container*` family rows) follow `visual_format::FIELD_POINTERS`;
 * catalog.rs's `container_rows_are_the_field_table` pins which fields each kind
 * leaves out.
 */
export const BINDABLE_PATHS: readonly BindablePathSpec[] = Object.freeze([
  row("chart", "/spec/title", "text", "family", true, false),
  row("chart", "/spec/xAxis/title", "text", "family", true, false),
  row("chart", "/spec/yAxis/title", "text", "family", true, false),
  row("chart", "/spec/xAxis/min", "number", "family", true, false),
  row("chart", "/spec/xAxis/max", "number", "family", true, false),
  row("chart", "/spec/yAxis/min", "number", "family", true, false),
  row("chart", "/spec/yAxis/max", "number", "family", true, false),
  row("chart", "/spec/series/*/name", "text", "family", true, false),
  row("chart", "/spec/seriesColors/*", "color", "family", true, false),
  row("chart", "/spec/params/*/value", "scalar", "family", true, false),
  row("chart", "/spec/markOptions/goal", "number", "family", true, false),
  row("chart", "/spec/markOptions/min", "number", "family", true, false),
  row("chart", "/spec/markOptions/max", "number", "family", true, false),
  row("chart", "/spec/markOptions/target", "number", "family", true, false),
  row("chart", "/spec/markOptions/calloutFontSize", "number", "family", true, false),
  row("chart", "/spec/markOptions/decimals", "integer", "family", true, false),
  row("chart", "/spec/markOptions/displayUnits", { enum: ["auto", "none", "thousands", "millions", "billions", "trillions"] }, "family", true, false),
  row("chart", "/spec/markOptions/goodColor", "color", "family", true, false),
  row("chart", "/spec/markOptions/badColor", "color", "family", true, false),
  row("chart", "/spec/markOptions/neutralColor", "color", "family", true, false),
  row("chart", "/spec/markOptions/trackColor", "color", "family", true, false),
  row("chart", "/spec/markOptions/targetColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/plotBackground", "color", "family", true, false),
  row("chart", "/spec/config/theme/gridLineColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/axisColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/axisLabelColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/axisTitleColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/titleColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/legendTextColor", "color", "family", true, false),
  row("chart", "/spec/config/theme/titleFontSize", "number", "family", true, false),
  row("chart", "/spec/config/theme/axisTitleFontSize", "number", "family", true, false),
  row("chart", "/spec/config/theme/labelFontSize", "number", "family", true, false),
  row("chart", "/spec/config/theme/legendFontSize", "number", "family", true, false),
  row("chart", "/spec/container/padding/top", "number", "container", true, false),
  row("chart", "/spec/container/padding/right", "number", "container", true, false),
  row("chart", "/spec/container/padding/bottom", "number", "container", true, false),
  row("chart", "/spec/container/padding/left", "number", "container", true, false),
  row("chart", "/spec/container/title/show", "boolean", "container", true, false),
  row("chart", "/spec/container/title/headingLevel", "integer", "container", true, false),
  row("chart", "/spec/container/title/fontFamily", "text", "container", true, false),
  row("chart", "/spec/container/title/bold", "boolean", "container", true, false),
  row("chart", "/spec/container/title/italic", "boolean", "container", true, false),
  row("chart", "/spec/container/title/underline", "boolean", "container", true, false),
  row("chart", "/spec/container/title/background", "color", "container", true, false),
  row("chart", "/spec/container/title/align", { enum: ["left", "center", "right"] }, "container", true, false),
  row("chart", "/spec/container/title/wrap", "boolean", "container", true, false),
  row("chart", "/spec/container/subtitle/show", "boolean", "container", true, false),
  row("chart", "/spec/container/subtitle/text", "text", "container", true, false),
  row("chart", "/spec/container/subtitle/fontFamily", "text", "container", true, false),
  row("chart", "/spec/container/subtitle/fontSize", "number", "container", true, false),
  row("chart", "/spec/container/subtitle/bold", "boolean", "container", true, false),
  row("chart", "/spec/container/subtitle/italic", "boolean", "container", true, false),
  row("chart", "/spec/container/subtitle/underline", "boolean", "container", true, false),
  row("chart", "/spec/container/subtitle/color", "color", "container", true, false),
  row("chart", "/spec/container/subtitle/background", "color", "container", true, false),
  row("chart", "/spec/container/subtitle/align", { enum: ["left", "center", "right"] }, "container", true, false),
  row("chart", "/spec/container/subtitle/wrap", "boolean", "container", true, false),
  row("chart", "/spec/container/divider/show", "boolean", "container", true, false),
  row("chart", "/spec/container/divider/color", "color", "container", true, false),
  row("chart", "/spec/container/divider/style", { enum: ["solid", "dashed", "dotted"] }, "container", true, false),
  row("chart", "/spec/container/divider/width", "number", "container", true, false),
  row("chart", "/spec/container/divider/ignorePadding", "boolean", "container", true, false),
  row("chart", "/spec/container/spacing/custom", "boolean", "container", true, false),
  row("chart", "/spec/container/spacing/belowTitle", "number", "container", true, false),
  row("chart", "/spec/container/spacing/belowSubtitle", "number", "container", true, false),
  row("chart", "/spec/container/spacing/belowDivider", "number", "container", true, false),
  row("chart", "/spec/container/background/show", "boolean", "container", true, false),
  row("chart", "/spec/container/background/color", "color", "container", true, false),
  row("chart", "/spec/container/background/transparency", "number", "container", true, false),
  row("chart", "/spec/container/border/show", "boolean", "container", true, false),
  row("chart", "/spec/container/border/color", "color", "container", true, false),
  row("chart", "/spec/container/border/width", "number", "container", true, false),
  row("chart", "/spec/container/border/radius", "number", "container", true, false),
  row("chart", "/spec/container/shadow/show", "boolean", "container", true, false),
  row("chart", "/spec/container/shadow/color", "color", "container", true, false),
  row("chart", "/spec/container/shadow/transparency", "number", "container", true, false),
  row("chart", "/spec/container/shadow/offset", { enum: ["outside", "inside"] }, "container", true, false),
  row("chart", "/spec/container/shadow/position", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "container", true, false),
  row("chart", "/spec/container/shadow/blur", "number", "container", true, false),
  row("chart", "/spec/container/shadow/distance", "number", "container", true, false),
  row("control", "/properties/text", "text", "family", false, false),
  row("control", "/properties/tooltip", "text", "family", false, false),
  row("control", "/properties/fill", "color", "family", false, false),
  row("control", "/properties/color", "color", "family", false, false),
  row("control", "/properties/borderColor", "color", "family", false, false),
  row("control", "/properties/stroke", "color", "family", false, false),
  row("control", "/properties/textColor", "color", "family", false, false),
  row("control", "/properties/selectedFill", "color", "family", false, false),
  row("control", "/properties/selectedColor", "color", "family", false, false),
  row("control", "/properties/fontSize", "number", "family", false, false),
  row("control", "/properties/strokeWidth", "number", "family", false, false),
  row("control", "/properties/opacity", "number", "family", false, false),
  row("control", "/properties/gap", "number", "family", false, false),
  row("control", "/properties/padding", "number", "family", false, false),
  row("control", "/properties/rotation", "number", "family", true, false),
  row("control", "/properties/fontBold", "boolean", "family", false, false),
  row("control", "/properties/fontItalic", "boolean", "family", false, false),
  row("control", "/properties/showHiddenPages", "boolean", "family", false, false),
  row("control", "/properties/showTooltipPages", "boolean", "family", false, false),
  row("control", "/properties/flipH", "boolean", "family", true, false),
  row("control", "/properties/flipV", "boolean", "family", true, false),
  row("control", "/properties/textAlign", { enum: ["left", "center", "right"] }, "family", false, false),
  row("control", "/properties/orientation", { enum: ["horizontal", "vertical"] }, "family", false, false),
  row("control", "/properties/src", "media", "family", false, false),
  row("control", "/properties/width", "number", "family", true, true),
  row("control", "/properties/height", "number", "family", true, true),
  row("control", "/properties/containerPaddingTop", "number", "family", false, false),
  row("control", "/properties/containerPaddingRight", "number", "family", false, false),
  row("control", "/properties/containerPaddingBottom", "number", "family", false, false),
  row("control", "/properties/containerPaddingLeft", "number", "family", false, false),
  row("control", "/properties/containerTitleShow", "boolean", "family", false, false),
  row("control", "/properties/containerTitleText", "text", "family", false, false),
  row("control", "/properties/containerTitleHeadingLevel", "integer", "family", false, false),
  row("control", "/properties/containerTitleFontFamily", "text", "family", false, false),
  row("control", "/properties/containerTitleFontSize", "number", "family", false, false),
  row("control", "/properties/containerTitleBold", "boolean", "family", false, false),
  row("control", "/properties/containerTitleItalic", "boolean", "family", false, false),
  row("control", "/properties/containerTitleUnderline", "boolean", "family", false, false),
  row("control", "/properties/containerTitleColor", "color", "family", false, false),
  row("control", "/properties/containerTitleBackground", "color", "family", false, false),
  row("control", "/properties/containerTitleAlign", { enum: ["left", "center", "right"] }, "family", false, false),
  row("control", "/properties/containerTitleWrap", "boolean", "family", false, false),
  row("control", "/properties/containerSubtitleShow", "boolean", "family", false, false),
  row("control", "/properties/containerSubtitleText", "text", "family", false, false),
  row("control", "/properties/containerSubtitleFontFamily", "text", "family", false, false),
  row("control", "/properties/containerSubtitleFontSize", "number", "family", false, false),
  row("control", "/properties/containerSubtitleBold", "boolean", "family", false, false),
  row("control", "/properties/containerSubtitleItalic", "boolean", "family", false, false),
  row("control", "/properties/containerSubtitleUnderline", "boolean", "family", false, false),
  row("control", "/properties/containerSubtitleColor", "color", "family", false, false),
  row("control", "/properties/containerSubtitleBackground", "color", "family", false, false),
  row("control", "/properties/containerSubtitleAlign", { enum: ["left", "center", "right"] }, "family", false, false),
  row("control", "/properties/containerSubtitleWrap", "boolean", "family", false, false),
  row("control", "/properties/containerDividerShow", "boolean", "family", false, false),
  row("control", "/properties/containerDividerColor", "color", "family", false, false),
  row("control", "/properties/containerDividerStyle", { enum: ["solid", "dashed", "dotted"] }, "family", false, false),
  row("control", "/properties/containerDividerWidth", "number", "family", false, false),
  row("control", "/properties/containerDividerIgnorePadding", "boolean", "family", false, false),
  row("control", "/properties/containerSpacingCustom", "boolean", "family", false, false),
  row("control", "/properties/containerSpacingBelowTitle", "number", "family", false, false),
  row("control", "/properties/containerSpacingBelowSubtitle", "number", "family", false, false),
  row("control", "/properties/containerSpacingBelowDivider", "number", "family", false, false),
  row("control", "/properties/containerBackgroundShow", "boolean", "family", false, false),
  row("control", "/properties/containerBackgroundColor", "color", "family", false, false),
  row("control", "/properties/containerBackgroundTransparency", "number", "family", false, false),
  row("control", "/properties/containerBorderShow", "boolean", "family", false, false),
  row("control", "/properties/containerBorderColor", "color", "family", false, false),
  row("control", "/properties/containerBorderWidth", "number", "family", false, false),
  row("control", "/properties/containerBorderRadius", "number", "family", false, false),
  row("control", "/properties/containerShadowShow", "boolean", "family", false, false),
  row("control", "/properties/containerShadowColor", "color", "family", false, false),
  row("control", "/properties/containerShadowTransparency", "number", "family", false, false),
  row("control", "/properties/containerShadowOffset", { enum: ["outside", "inside"] }, "family", false, false),
  row("control", "/properties/containerShadowPosition", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "family", false, false),
  row("control", "/properties/containerShadowBlur", "number", "family", false, false),
  row("control", "/properties/containerShadowDistance", "number", "family", false, false),
  row("control", "/properties/pageOverrides/*/text", "text", "family", false, false),
  row("control", "/properties/pageOverrides/*/fill", "color", "family", false, false),
  row("control", "/properties/pageOverrides/*/color", "color", "family", false, false),
  row("control", "/properties/pageOverrides/*/borderColor", "color", "family", false, false),
  row("control", "/properties/pageOverrides/*/hidden", "boolean", "family", false, false),
  row("slicer", "/headerText", "text", "family", false, false),
  row("slicer", "/showHeader", "boolean", "family", false, false),
  row("slicer", "/container/padding/top", "number", "container", false, false),
  row("slicer", "/container/padding/right", "number", "container", false, false),
  row("slicer", "/container/padding/bottom", "number", "container", false, false),
  row("slicer", "/container/padding/left", "number", "container", false, false),
  row("slicer", "/container/title/headingLevel", "integer", "container", false, false),
  row("slicer", "/container/title/fontFamily", "text", "container", false, false),
  row("slicer", "/container/title/fontSize", "number", "container", false, false),
  row("slicer", "/container/title/bold", "boolean", "container", false, false),
  row("slicer", "/container/title/italic", "boolean", "container", false, false),
  row("slicer", "/container/title/underline", "boolean", "container", false, false),
  row("slicer", "/container/title/color", "color", "container", false, false),
  row("slicer", "/container/title/background", "color", "container", false, false),
  row("slicer", "/container/title/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("slicer", "/container/title/wrap", "boolean", "container", false, false),
  row("slicer", "/container/subtitle/show", "boolean", "container", false, false),
  row("slicer", "/container/subtitle/text", "text", "container", false, false),
  row("slicer", "/container/subtitle/fontFamily", "text", "container", false, false),
  row("slicer", "/container/subtitle/fontSize", "number", "container", false, false),
  row("slicer", "/container/subtitle/bold", "boolean", "container", false, false),
  row("slicer", "/container/subtitle/italic", "boolean", "container", false, false),
  row("slicer", "/container/subtitle/underline", "boolean", "container", false, false),
  row("slicer", "/container/subtitle/color", "color", "container", false, false),
  row("slicer", "/container/subtitle/background", "color", "container", false, false),
  row("slicer", "/container/subtitle/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("slicer", "/container/subtitle/wrap", "boolean", "container", false, false),
  row("slicer", "/container/divider/show", "boolean", "container", false, false),
  row("slicer", "/container/divider/color", "color", "container", false, false),
  row("slicer", "/container/divider/style", { enum: ["solid", "dashed", "dotted"] }, "container", false, false),
  row("slicer", "/container/divider/width", "number", "container", false, false),
  row("slicer", "/container/divider/ignorePadding", "boolean", "container", false, false),
  row("slicer", "/container/spacing/custom", "boolean", "container", false, false),
  row("slicer", "/container/spacing/belowTitle", "number", "container", false, false),
  row("slicer", "/container/spacing/belowSubtitle", "number", "container", false, false),
  row("slicer", "/container/spacing/belowDivider", "number", "container", false, false),
  row("slicer", "/container/background/show", "boolean", "container", false, false),
  row("slicer", "/container/background/color", "color", "container", false, false),
  row("slicer", "/container/background/transparency", "number", "container", false, false),
  row("slicer", "/container/border/show", "boolean", "container", false, false),
  row("slicer", "/container/border/color", "color", "container", false, false),
  row("slicer", "/container/border/width", "number", "container", false, false),
  row("slicer", "/container/border/radius", "number", "container", false, false),
  row("slicer", "/container/shadow/show", "boolean", "container", false, false),
  row("slicer", "/container/shadow/color", "color", "container", false, false),
  row("slicer", "/container/shadow/transparency", "number", "container", false, false),
  row("slicer", "/container/shadow/offset", { enum: ["outside", "inside"] }, "container", false, false),
  row("slicer", "/container/shadow/position", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "container", false, false),
  row("slicer", "/container/shadow/blur", "number", "container", false, false),
  row("slicer", "/container/shadow/distance", "number", "container", false, false),
  row("timelineSlicer", "/headerText", "text", "family", false, false),
  row("timelineSlicer", "/showHeader", "boolean", "family", false, false),
  row("timelineSlicer", "/container/padding/top", "number", "container", false, false),
  row("timelineSlicer", "/container/padding/right", "number", "container", false, false),
  row("timelineSlicer", "/container/padding/bottom", "number", "container", false, false),
  row("timelineSlicer", "/container/padding/left", "number", "container", false, false),
  row("timelineSlicer", "/container/title/headingLevel", "integer", "container", false, false),
  row("timelineSlicer", "/container/title/fontFamily", "text", "container", false, false),
  row("timelineSlicer", "/container/title/fontSize", "number", "container", false, false),
  row("timelineSlicer", "/container/title/bold", "boolean", "container", false, false),
  row("timelineSlicer", "/container/title/italic", "boolean", "container", false, false),
  row("timelineSlicer", "/container/title/underline", "boolean", "container", false, false),
  row("timelineSlicer", "/container/title/color", "color", "container", false, false),
  row("timelineSlicer", "/container/title/background", "color", "container", false, false),
  row("timelineSlicer", "/container/title/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("timelineSlicer", "/container/title/wrap", "boolean", "container", false, false),
  row("timelineSlicer", "/container/subtitle/show", "boolean", "container", false, false),
  row("timelineSlicer", "/container/subtitle/text", "text", "container", false, false),
  row("timelineSlicer", "/container/subtitle/fontFamily", "text", "container", false, false),
  row("timelineSlicer", "/container/subtitle/fontSize", "number", "container", false, false),
  row("timelineSlicer", "/container/subtitle/bold", "boolean", "container", false, false),
  row("timelineSlicer", "/container/subtitle/italic", "boolean", "container", false, false),
  row("timelineSlicer", "/container/subtitle/underline", "boolean", "container", false, false),
  row("timelineSlicer", "/container/subtitle/color", "color", "container", false, false),
  row("timelineSlicer", "/container/subtitle/background", "color", "container", false, false),
  row("timelineSlicer", "/container/subtitle/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("timelineSlicer", "/container/subtitle/wrap", "boolean", "container", false, false),
  row("timelineSlicer", "/container/divider/show", "boolean", "container", false, false),
  row("timelineSlicer", "/container/divider/color", "color", "container", false, false),
  row("timelineSlicer", "/container/divider/style", { enum: ["solid", "dashed", "dotted"] }, "container", false, false),
  row("timelineSlicer", "/container/divider/width", "number", "container", false, false),
  row("timelineSlicer", "/container/divider/ignorePadding", "boolean", "container", false, false),
  row("timelineSlicer", "/container/spacing/custom", "boolean", "container", false, false),
  row("timelineSlicer", "/container/spacing/belowTitle", "number", "container", false, false),
  row("timelineSlicer", "/container/spacing/belowSubtitle", "number", "container", false, false),
  row("timelineSlicer", "/container/spacing/belowDivider", "number", "container", false, false),
  row("timelineSlicer", "/container/background/show", "boolean", "container", false, false),
  row("timelineSlicer", "/container/background/color", "color", "container", false, false),
  row("timelineSlicer", "/container/background/transparency", "number", "container", false, false),
  row("timelineSlicer", "/container/border/show", "boolean", "container", false, false),
  row("timelineSlicer", "/container/border/color", "color", "container", false, false),
  row("timelineSlicer", "/container/border/width", "number", "container", false, false),
  row("timelineSlicer", "/container/border/radius", "number", "container", false, false),
  row("timelineSlicer", "/container/shadow/show", "boolean", "container", false, false),
  row("timelineSlicer", "/container/shadow/color", "color", "container", false, false),
  row("timelineSlicer", "/container/shadow/transparency", "number", "container", false, false),
  row("timelineSlicer", "/container/shadow/offset", { enum: ["outside", "inside"] }, "container", false, false),
  row("timelineSlicer", "/container/shadow/position", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "container", false, false),
  row("timelineSlicer", "/container/shadow/blur", "number", "container", false, false),
  row("timelineSlicer", "/container/shadow/distance", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/padding/top", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/padding/right", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/padding/bottom", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/padding/left", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/title/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/title/text", "text", "container", false, false),
  row("pivot", "/canvasFrame/container/title/headingLevel", "integer", "container", false, false),
  row("pivot", "/canvasFrame/container/title/fontFamily", "text", "container", false, false),
  row("pivot", "/canvasFrame/container/title/fontSize", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/title/bold", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/title/italic", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/title/underline", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/title/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/title/background", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/title/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("pivot", "/canvasFrame/container/title/wrap", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/text", "text", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/fontFamily", "text", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/fontSize", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/bold", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/italic", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/underline", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/background", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/align", { enum: ["left", "center", "right"] }, "container", false, false),
  row("pivot", "/canvasFrame/container/subtitle/wrap", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/divider/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/divider/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/divider/style", { enum: ["solid", "dashed", "dotted"] }, "container", false, false),
  row("pivot", "/canvasFrame/container/divider/width", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/divider/ignorePadding", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/spacing/custom", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/spacing/belowTitle", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/spacing/belowSubtitle", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/spacing/belowDivider", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/background/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/background/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/background/transparency", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/border/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/border/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/border/width", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/border/radius", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/show", "boolean", "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/color", "color", "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/transparency", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/offset", { enum: ["outside", "inside"] }, "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/position", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/blur", "number", "container", false, false),
  row("pivot", "/canvasFrame/container/shadow/distance", "number", "container", false, false),
  row("floatingRange", "/container/title/headingLevel", "integer", "container", true, false),
  row("floatingRange", "/container/title/fontFamily", "text", "container", true, false),
  row("floatingRange", "/container/title/fontSize", "number", "container", true, false),
  row("floatingRange", "/container/title/bold", "boolean", "container", true, false),
  row("floatingRange", "/container/title/italic", "boolean", "container", true, false),
  row("floatingRange", "/container/title/underline", "boolean", "container", true, false),
  row("floatingRange", "/container/title/color", "color", "container", true, false),
  row("floatingRange", "/container/title/background", "color", "container", true, false),
  row("floatingRange", "/container/title/align", { enum: ["left", "center", "right"] }, "container", true, false),
  row("floatingRange", "/container/title/wrap", "boolean", "container", true, false),
  row("floatingRange", "/container/subtitle/show", "boolean", "container", true, false),
  row("floatingRange", "/container/subtitle/text", "text", "container", true, false),
  row("floatingRange", "/container/subtitle/fontFamily", "text", "container", true, false),
  row("floatingRange", "/container/subtitle/fontSize", "number", "container", true, false),
  row("floatingRange", "/container/subtitle/bold", "boolean", "container", true, false),
  row("floatingRange", "/container/subtitle/italic", "boolean", "container", true, false),
  row("floatingRange", "/container/subtitle/underline", "boolean", "container", true, false),
  row("floatingRange", "/container/subtitle/color", "color", "container", true, false),
  row("floatingRange", "/container/subtitle/background", "color", "container", true, false),
  row("floatingRange", "/container/subtitle/align", { enum: ["left", "center", "right"] }, "container", true, false),
  row("floatingRange", "/container/subtitle/wrap", "boolean", "container", true, false),
  row("floatingRange", "/container/divider/show", "boolean", "container", true, false),
  row("floatingRange", "/container/divider/color", "color", "container", true, false),
  row("floatingRange", "/container/divider/style", { enum: ["solid", "dashed", "dotted"] }, "container", true, false),
  row("floatingRange", "/container/divider/width", "number", "container", true, false),
  row("floatingRange", "/container/divider/ignorePadding", "boolean", "container", true, false),
  row("floatingRange", "/container/spacing/custom", "boolean", "container", true, false),
  row("floatingRange", "/container/spacing/belowTitle", "number", "container", true, false),
  row("floatingRange", "/container/spacing/belowSubtitle", "number", "container", true, false),
  row("floatingRange", "/container/spacing/belowDivider", "number", "container", true, false),
  row("floatingRange", "/container/background/show", "boolean", "container", true, false),
  row("floatingRange", "/container/background/color", "color", "container", true, false),
  row("floatingRange", "/container/background/transparency", "number", "container", true, false),
  row("floatingRange", "/container/border/show", "boolean", "container", true, false),
  row("floatingRange", "/container/border/color", "color", "container", true, false),
  row("floatingRange", "/container/border/width", "number", "container", true, false),
  row("floatingRange", "/container/border/radius", "number", "container", true, false),
  row("floatingRange", "/container/shadow/show", "boolean", "container", true, false),
  row("floatingRange", "/container/shadow/color", "color", "container", true, false),
  row("floatingRange", "/container/shadow/transparency", "number", "container", true, false),
  row("floatingRange", "/container/shadow/offset", { enum: ["outside", "inside"] }, "container", true, false),
  row("floatingRange", "/container/shadow/position", { enum: ["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"] }, "container", true, false),
  row("floatingRange", "/container/shadow/blur", "number", "container", true, false),
  row("floatingRange", "/container/shadow/distance", "number", "container", true, false),
  row("canvasPage", "/background", "color", "family", true, false),
  row("canvasPage", "/wallpaper", "color", "family", true, false),
]);

/**
 * Where an object's format container lives in its JSON, or null (Rust
 * `container_root`). A control's container facts are FLAT keys under
 * `/properties/`, and a canvas page has no container.
 */
export const CONTAINER_ROOT_POINTER: Readonly<Record<ObjectBindingKind, string | null>> = Object.freeze({
  chart: "/spec/container",
  pivot: "/canvasFrame/container",
  slicer: "/container",
  timelineSlicer: "/container",
  floatingRange: "/container",
  control: null,
  canvasPage: null,
});

/** Longest pointer accepted (Rust `MAX_BINDING_PATH_CHARS`). */
export const MAX_BINDING_PATH_CHARS = 256;
/** Most segments a pointer may have (Rust `MAX_BINDING_PATH_SEGMENTS`). */
export const MAX_BINDING_PATH_SEGMENTS = 8;
/** Longest single segment, escaped form (Rust `MAX_BINDING_PATH_SEGMENT_CHARS`). */
export const MAX_BINDING_PATH_SEGMENT_CHARS = 64;

/** Placement keys a control binding never targets: Rust `POSITION_SIZE_PROPERTIES`
 *  minus width/height (which ARE bindable). Pinned by the drift test. */
export const CONTROL_POSITION_KEYS: readonly string[] = ["x", "y", "offsetX", "offsetY"];
/** Rust `controls::PIN_TO_GRID_PROPERTY`. Pinned by the drift test. */
export const CONTROL_PIN_TO_GRID_KEY = "pinToGrid";
/** Rust `CONTROL_IDENTITY_KEYS` (catalog.rs). Pinned by the drift test. */
export const CONTROL_IDENTITY_KEYS: readonly string[] = ["uid", "embedded", "shapeType", "name", "controlType"];

/** Characters, counted as Rust `chars().count()` does (code points). */
function charCount(s: string): number {
  return Array.from(s).length;
}

/** RFC 6901 unescape of one segment (`~1` -> `/`, `~0` -> `~`); null for a bad `~`. */
export function unescapePointerSegment(segment: string): string | null {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === "~") {
      const next = segment[i + 1];
      if (next === "0") out += "~";
      else if (next === "1") out += "/";
      else return null;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** RFC 6901 escape of one segment (`~` -> `~0`, `/` -> `~1`). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The pointer's segments, still ESCAPED, after the syntactic check (Rust
 * `pointer_segments`: `^(/[^/]{1,64}){1,8}$`, at most 256 characters, `~` only
 * as `~0`/`~1`). Returns the refusal sentence when the path is malformed.
 */
export function pointerSegments(path: string): { ok: true; segments: string[] } | { ok: false; error: string } {
  if (charCount(path) > MAX_BINDING_PATH_CHARS) {
    return { ok: false, error: `A property path is at most ${MAX_BINDING_PATH_CHARS} characters long.` };
  }
  if (!path.startsWith("/")) {
    return {
      ok: false,
      error: `'${path}' is not a property path: a path is a JSON Pointer such as /spec/title.`,
    };
  }
  const segments = path.slice(1).split("/");
  if (segments.length > MAX_BINDING_PATH_SEGMENTS) {
    return {
      ok: false,
      error: `'${path}' is too deep: a property path has at most ${MAX_BINDING_PATH_SEGMENTS} segments.`,
    };
  }
  for (const seg of segments) {
    const n = charCount(seg);
    if (n === 0 || n > MAX_BINDING_PATH_SEGMENT_CHARS) {
      return {
        ok: false,
        error: `'${path}' is not a property path: every segment has 1 to ${MAX_BINDING_PATH_SEGMENT_CHARS} characters.`,
      };
    }
    if (unescapePointerSegment(seg) === null) {
      return {
        ok: false,
        error: `'${path}' is not a property path: '~' must be written ~0 and '/' inside a name ~1.`,
      };
    }
  }
  return { ok: true, segments };
}

/** The UNESCAPED segments of a well-formed pointer, or null. */
export function parsePointer(path: string): string[] | null {
  const r = pointerSegments(path);
  if (!r.ok) return null;
  return r.segments.map((s) => unescapePointerSegment(s) ?? "");
}

let neverBindableSets: { executable: Set<string>; held: Set<string>; action: Set<string> } | null = null;

/** Built on first use (see the header: the validator import cycle). */
function controlKeySets(): { executable: Set<string>; held: Set<string>; action: Set<string> } {
  if (neverBindableSets === null) {
    const held = new Set(HELD_CONTROL_PROPERTIES);
    neverBindableSets = {
      // SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS is pinned by controls.rs to Rust's
      // EXECUTABLE + HELD lists exactly; the executable half is what is not held.
      executable: new Set(SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS.filter((k) => !held.has(k))),
      held,
      action: new Set(BUTTON_ACTION_PROPERTY_KEYS),
    };
  }
  return neverBindableSets;
}

/**
 * Why a control key can never carry a binding, or null when it may (if the
 * catalog has a row for it). The same sentences as Rust
 * `never_bindable_control_reason`.
 */
export function neverBindableControlReason(key: string): string | null {
  const sets = controlKeySets();
  if (sets.executable.has(key)) return `'${key}' is code; code is never bound.`;
  if (sets.held.has(key)) return `'${key}' holds an application's code compartment; it is never bound.`;
  if (sets.action.has(key)) return `'${key}' is a button's action wiring; an action is never bound.`;
  if (key === CONTROL_PIN_TO_GRID_KEY) {
    return `'${key}' decides how the control follows its cells; it is not bindable.`;
  }
  if (CONTROL_POSITION_KEYS.includes(key)) {
    return `'${key}' places the control; its position is not bindable (only width and height are).`;
  }
  if (CONTROL_IDENTITY_KEYS.includes(key)) return `'${key}' is the control's identity; it is never bound.`;
  return null;
}

/** A Page Navigator's per-button settings property (Rust `PAGE_NAVIGATOR_OVERRIDES_PROPERTY`). */
const PAGE_OVERRIDES_KEY = "pageOverrides";
/** The fields that NAME the page an entry is about (Rust `PAGE_OVERRIDE_IDENTITY_FIELDS`). */
export const PAGE_OVERRIDE_IDENTITY_FIELDS: readonly string[] = ["sheetId", "sheetName"];

/**
 * Why a path into a Page Navigator's `pageOverrides` can never be bound, or
 * null (Rust `page_overrides_refusal`, D §3.18a): the whole list, and a page's
 * identity fields. `segments` are UNESCAPED, starting at "properties".
 */
export function pageOverridesRefusal(segments: readonly string[]): string | null {
  if (segments[1] !== PAGE_OVERRIDES_KEY) return null;
  if (segments.length === 2) {
    return (
      "'/properties/pageOverrides' is a navigator's whole list of page button settings; it is never bound. " +
      "Bind one button's setting instead: /properties/pageOverrides/<page>/text, /fill, /color, /borderColor or /hidden."
    );
  }
  const field = segments[3];
  if (segments.length === 4 && field !== undefined && PAGE_OVERRIDE_IDENTITY_FIELDS.includes(field)) {
    return `'${field}' names the page a button setting is about; it is never bound.`;
  }
  return null;
}

/** The pointer of one page button's setting (the page key RFC 6901-escaped; Rust `per_button_pointer`). */
export function pageButtonPointer(pageKey: string, field: string): string {
  return `/properties/${PAGE_OVERRIDES_KEY}/${escapePointerSegment(pageKey)}/${escapePointerSegment(field)}`;
}

/** Control keys only (the Rust `is_never_bindable_control_key` mirror). */
export function isNeverBindableControlKey(key: string): boolean {
  return neverBindableControlReason(key) !== null;
}

/** A SheetId's canonical uuid spelling (Rust `SheetId::parse`). */
const SHEET_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** What a `*` segment accepts, decided by the segment before it (Rust `wildcard_class`). */
function wildcardAccepts(parent: string, segment: string): boolean {
  if (parent === "seriesColors") return /^[A-Za-z0-9_ .-]{1,64}$/.test(segment);
  if (parent === "pageOverrides") {
    if (SHEET_ID_RE.test(segment)) return true;
    if (!segment.startsWith("name:")) return false;
    const n = charCount(segment.slice("name:".length));
    return n >= 1 && n <= 31;
  }
  return /^[0-9]{1,4}$/.test(segment);
}

/** Does `pattern` match the UNESCAPED `segments`? */
function patternMatches(pattern: string, segments: readonly string[]): boolean {
  const pat = pattern.replace(/^\/+/, "").split("/");
  if (pat.length !== segments.length) return false;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    const s = segments[i];
    if (p === "*") {
      if (!wildcardAccepts(i === 0 ? "" : pat[i - 1], s)) return false;
    } else if (p !== s) {
      return false;
    }
  }
  return true;
}

/** Every catalog row of `kind`, in table order. */
export function rowsOf(kind: ObjectBindingKind): BindablePathSpec[] {
  return BINDABLE_PATHS.filter((r) => r.kind === kind);
}

/**
 * The catalog row a binding at `path` on an object of `kind` would use, or the
 * sentence saying why there is none -- Rust `match_path`, step for step:
 * (1) the syntactic pointer check; (2) for a CONTROL only, the key after
 * `/properties/` must not be never-bindable; (3) the first row of `kind` whose
 * pattern matches, exact rows before `*` rows.
 */
export function matchBindablePath(
  kind: ObjectBindingKind,
  path: string,
): { ok: true; spec: BindablePathSpec } | { ok: false; error: string } {
  const parsed = pointerSegments(path);
  if (!parsed.ok) return parsed;
  const segments = parsed.segments.map((s) => unescapePointerSegment(s) ?? "");

  if (kind === "control" && segments.length >= 2 && segments[0] === "properties") {
    const reason = neverBindableControlReason(segments[1]);
    if (reason !== null) return { ok: false, error: reason };
    const navigatorReason = pageOverridesRefusal(segments);
    if (navigatorReason !== null) return { ok: false, error: navigatorReason };
  }

  const rows = rowsOf(kind);
  const ordered = [...rows.filter((r) => !r.pointer.includes("*")), ...rows.filter((r) => r.pointer.includes("*"))];
  const found = ordered.find((r) => patternMatches(r.pointer, segments));
  if (found) return { ok: true, spec: found };

  const label = OBJECT_BINDING_KIND_LABELS[kind] ?? String(kind);
  if (rows.length === 0) {
    return { ok: false, error: `A ${label} has no bindable properties yet, so '${path}' cannot be bound.` };
  }
  return {
    ok: false,
    error: `'${path}' is not a bindable property of a ${label}. Its bindable properties are: ${rows
      .map((r) => r.pointer)
      .join(", ")}.`,
  };
}

/** The catalog row for `path` on `kind`, or null when it is not bindable. */
export function isBindablePath(kind: ObjectBindingKind, path: string): BindablePathSpec | null {
  const r = matchBindablePath(kind, path);
  return r.ok ? r.spec : null;
}

/** Is `valueType` a text slot (the overlay shows `display`, errors included)? */
export function isTextValueType(valueType: BindableValueType): boolean {
  return valueType === "text";
}
