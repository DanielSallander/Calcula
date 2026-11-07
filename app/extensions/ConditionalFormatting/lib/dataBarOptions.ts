//! FILENAME: app/extensions/ConditionalFormatting/lib/dataBarOptions.ts
// PURPOSE: What New Rule's data-bar page holds while the user edits it -- the
//          controls of Excel's dialog -- and the rule it writes.
// CONTEXT: BUG-0728. The painter honours every data-bar option the rule stores
//          (fill and gradient, border, negative fill and border, axis position
//          and colour, direction, Show Bar Only: dataBarRenderer.ts, BUG-0511),
//          but New Rule offered a colour and nothing else. Excel's page, read
//          off the live dialog: Show Bar Only; Bar Appearance -- Fill (Solid /
//          Gradient) and Color, Border (No Border / Solid Border) and Color;
//          Bar Direction (Context / Left-to-Right / Right-to-Left); and the
//          "Negative Value and Axis..." dialog -- negative bar fill colour or
//          "Apply same fill color as positive bar", negative bar border colour
//          or "Apply same border color as positive bar", axis position
//          (Automatic / Cell midpoint / None) and axis colour. Its defaults are
//          a gradient blue bar with a blue border, red negative bars with a red
//          border and an automatic black axis -- the gradient gallery preset.

import type { DataBarAxisPosition, DataBarDirection, DataBarRule } from "@api";
import { dataBarRuleOf, NEGATIVE_BAR_RED, AXIS_BLACK, type DataBarOptions } from "./presetRules";
import { PRESET_DATA_BAR_COLORS } from "../types";

/** The data-bar page's controls. */
export interface DataBarUi {
  showBarOnly: boolean;
  fill: "solid" | "gradient";
  color: string;
  border: "none" | "solid";
  borderColor: string;
  direction: DataBarDirection;
  /** "Negative Value and Axis Settings". */
  negativeFill: "color" | "sameAsPositive";
  negativeFillColor: string;
  negativeBorder: "color" | "sameAsPositive";
  negativeBorderColor: string;
  axisPosition: DataBarAxisPosition;
  axisColor: string;
}

/** Excel's New Rule data-bar defaults (the gradient Blue Data Bar). */
export const DEFAULT_DATA_BAR_UI: DataBarUi = {
  showBarOnly: false,
  fill: "gradient",
  color: PRESET_DATA_BAR_COLORS[0],
  border: "solid",
  borderColor: PRESET_DATA_BAR_COLORS[0],
  direction: "context",
  negativeFill: "color",
  negativeFillColor: NEGATIVE_BAR_RED,
  negativeBorder: "color",
  negativeBorderColor: NEGATIVE_BAR_RED,
  axisPosition: "automatic",
  axisColor: AXIS_BLACK,
};

/** The options the controls describe. */
export function dataBarOptionsOf(ui: DataBarUi): DataBarOptions {
  const bordered = ui.border === "solid";
  return {
    fillColor: ui.color,
    gradientFill: ui.fill === "gradient",
    borderColor: bordered ? ui.borderColor : null,
    negativeFillColor: ui.negativeFill === "sameAsPositive" ? null : ui.negativeFillColor,
    negativeBorderColor: !bordered || ui.negativeBorder === "sameAsPositive" ? null : ui.negativeBorderColor,
    axisPosition: ui.axisPosition,
    axisColor: ui.axisColor,
    direction: ui.direction,
    showValue: !ui.showBarOnly,
  };
}

/** The rule the controls write. */
export function dataBarRuleFromUi(ui: DataBarUi): DataBarRule {
  return dataBarRuleOf(dataBarOptionsOf(ui)) as DataBarRule;
}

function sameColor(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/**
 * The controls a stored rule shows (an Edit Rule door) -- what the painter
 * paints for it (dataBarRenderer.ts): an absent negative fill is Excel's red,
 * an absent negative border is the negative bar's own fill colour. A negative
 * colour equal to the positive one reads as "same as positive", the form OK
 * writes for that choice.
 */
export function dataBarUiOf(rule: DataBarRule): DataBarUi {
  const negativeFillColor = rule.negativeFillColor || NEGATIVE_BAR_RED;
  const negativeBorderColor = rule.negativeBorderColor || negativeFillColor;
  return {
    showBarOnly: rule.showValue === false,
    fill: rule.gradientFill ? "gradient" : "solid",
    color: rule.fillColor,
    border: rule.borderColor ? "solid" : "none",
    borderColor: rule.borderColor || rule.fillColor,
    direction: rule.direction ?? "context",
    negativeFill: sameColor(negativeFillColor, rule.fillColor) ? "sameAsPositive" : "color",
    negativeFillColor,
    negativeBorder: rule.borderColor && sameColor(negativeBorderColor, rule.borderColor) ? "sameAsPositive" : "color",
    negativeBorderColor,
    axisPosition: rule.axisPosition ?? "automatic",
    axisColor: rule.axisColor || AXIS_BLACK,
  };
}
