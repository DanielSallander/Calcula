//! FILENAME: app/extensions/ConditionalFormatting/lib/presetRules.ts
// PURPOSE: The rule each gallery preset writes -- ONE builder per kind, shared
//          by the galleries (homeMenuBuilder) and New Rule's "Format all cells
//          based on their values" page.
// CONTEXT: The two doors used to build the same rules side by side, and both
//          wrote a colour scale's midpoint as 50 PERCENT of the range with
//          automatic ends. Excel writes the lowest value, the 50th PERCENTILE
//          and the highest value (ColorScaleCriteria types 1 / 5 / 2, read from
//          live Excel on 2026-10-04): on skewed data the two midpoints are far
//          apart, so the same preset coloured the same numbers differently in
//          Calcula and in Excel -- and a copy kept in two places would drift
//          again on the next correction.

import type { ConditionalFormatRule, DataBarAxisPosition, DataBarDirection, IconSetType } from "@api";
import type { PresetColorScale } from "../types";

/** A Color Scales preset as a rule: lowest value, (50th percentile,) highest value. */
export function colorScaleRule(preset: PresetColorScale): ConditionalFormatRule {
  return {
    type: "colorScale",
    minPoint: { valueType: "min", color: preset.minColor },
    ...(preset.midColor
      ? { midPoint: { valueType: "percentile", value: 50, color: preset.midColor } }
      : {}),
    maxPoint: { valueType: "max", color: preset.maxColor },
  } as ConditionalFormatRule;
}

/** Excel's negative-bar red and its axis black (the 2010+ data-bar defaults). */
export const NEGATIVE_BAR_RED = "#FF0000";
export const AXIS_BLACK = "#000000";

/**
 * Every option of New Rule's data-bar page that the painter honours (BUG-0728):
 * Excel's Bar Appearance (fill, border), Bar Direction, Show Bar Only, and its
 * "Negative Value and Axis Settings" dialog. A null colour is Excel's other
 * choice: no border, or the negative bar "same as positive".
 */
export interface DataBarOptions {
  fillColor: string;
  gradientFill: boolean;
  /** The bar's border colour; null for No Border. */
  borderColor: string | null;
  /** The negative bar's fill; null = "Apply same fill color as positive bar". */
  negativeFillColor: string | null;
  /** The negative bar's border; null = "Apply same border color as positive
   *  bar". A bar with no border has no negative border either. */
  negativeBorderColor: string | null;
  axisPosition: DataBarAxisPosition;
  axisColor: string;
  direction: DataBarDirection;
  /** False is Show Bar Only. */
  showValue: boolean;
}

/**
 * The data-bar rule for a set of options: automatic shortest / longest bar.
 * "Same as positive" is written as the positive colour itself -- Excel's
 * `NegativeBarFormat.ColorType = xlDataBarSameAsPositive` follows the positive
 * colour [LIVE, lane uiforms probe1 P3b], and the stored rule has no such
 * flag, so the dialog writes the colour the flag means at OK. The painter draws
 * a border only when the rule carries one (BUG-0511).
 */
export function dataBarRuleOf(o: DataBarOptions): ConditionalFormatRule {
  return {
    type: "dataBar",
    minValueType: "autoMin",
    maxValueType: "autoMax",
    fillColor: o.fillColor,
    ...(o.borderColor ? { borderColor: o.borderColor, negativeBorderColor: o.negativeBorderColor ?? o.borderColor } : {}),
    negativeFillColor: o.negativeFillColor ?? o.fillColor,
    axisColor: o.axisColor,
    axisPosition: o.axisPosition,
    direction: o.direction,
    showValue: o.showValue,
    gradientFill: o.gradientFill,
  } as ConditionalFormatRule;
}

/**
 * A Data Bars preset as a rule: automatic shortest / longest bar, an automatic
 * axis, Excel's red negative bars and black axis. A GRADIENT preset has a solid
 * border in its own colour (and its negative bars a red one); a SOLID preset has
 * none -- the painter draws a border only when the rule carries one (BUG-0511).
 */
export function dataBarRule(color: string, gradientFill: boolean): ConditionalFormatRule {
  return dataBarRuleOf({
    fillColor: color,
    gradientFill,
    borderColor: gradientFill ? color : null,
    negativeFillColor: NEGATIVE_BAR_RED,
    negativeBorderColor: NEGATIVE_BAR_RED,
    axisPosition: "automatic",
    axisColor: AXIS_BLACK,
    direction: "context",
    showValue: true,
  });
}

/**
 * An Icon Sets preset as a rule: one threshold fewer than the icons, evenly
 * spaced in percent of the range (Excel's 33/67, 25/50/75, 20/40/60/80).
 */
export function iconSetRule(iconSet: IconSetType, iconCount: number): ConditionalFormatRule {
  const thresholds = [];
  for (let i = 1; i < iconCount; i++) {
    thresholds.push({
      valueType: "percent" as const,
      value: Math.round((100 * i) / iconCount),
      operator: "greaterThanOrEqual" as const,
    });
  }
  return {
    type: "iconSet",
    iconSet,
    thresholds,
    reverseIcons: false,
    showIconOnly: false,
  } as ConditionalFormatRule;
}
